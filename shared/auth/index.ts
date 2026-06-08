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
 * Extract client IP from request headers.
 *
 * When behind a reverse proxy, X-Forwarded-For contains a comma-separated
 * list of IPs. The rightmost entry is the one appended by the trusted proxy
 * and is the most reliable. If no proxy headers are present, falls back
 * to "unknown" (Deno.serve does not expose remote address via Request).
 */
function extractClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Rightmost IP = appended by the closest trusted proxy
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? "unknown";
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Check rate limit for a request.
 * Returns null if within limit, or a 429 Response if rate limited.
 */
export function rateLimitGuard(
  req: Request,
  config: RateLimitConfig,
): Response | null {
  const ip = extractClientIp(req);

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
