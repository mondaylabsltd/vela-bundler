/**
 * Rate limiting middleware for bundler APIs.
 */

export interface RateLimitConfig {
  /** Max requests per minute per IP. */
  rateLimitPerMinute: number;
}

/** In-memory rate limiter. */
const requestCounts: Map<string, { count: number; resetAt: number }> = new Map();
let lastPruneAt = 0;

/**
 * Extract a TRUSTWORTHY client identifier for rate limiting.
 *
 * Only two sources are trusted, both unspoofable by the client:
 *   1. CF-Connecting-IP — set by Cloudflare's edge (CF Worker deployments).
 *   2. peerAddr — the real TCP peer address, passed in by the Deno server from
 *      Deno.serve's connection info.
 *
 * Client-supplied `X-Forwarded-For` / `X-Real-IP` are NOT trusted: an attacker can rotate
 * them to mint a fresh rate-limit bucket per request (limit bypass), or set them all the
 * same to share/poison one bucket. Without a trusted source we fall back to a single
 * shared bucket ("unknown") which fails safe (still rate-limited, just coarsely).
 */
function extractClientIp(req: Request, peerAddr?: string): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  if (peerAddr) return peerAddr;
  return "unknown";
}

/**
 * Check rate limit for a request.
 * Returns null if within limit, or a 429 Response if rate limited.
 * `peerAddr` is the real TCP peer (Deno) — pass it so each client gets its own bucket.
 */
export function rateLimitGuard(
  req: Request,
  config: RateLimitConfig,
  peerAddr?: string,
): Response | null {
  const ip = extractClientIp(req, peerAddr);

  const now = Date.now();
  const windowMs = 60_000;

  // Prune expired entries every 5 minutes to prevent unbounded growth
  if (now - lastPruneAt > 300_000) {
    for (const [key, val] of requestCounts) {
      if (now > val.resetAt) requestCounts.delete(key);
    }
    lastPruneAt = now;
  }

  let entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    requestCounts.set(ip, entry);
  }

  entry.count++;

  if (entry.count > config.rateLimitPerMinute) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded" }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}
