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
 * Check rate limit for a request.
 * Returns null if within limit, or a 429 Response if rate limited.
 */
export function rateLimitGuard(
  req: Request,
  config: RateLimitConfig,
): Response | null {
  const ip = req.headers.get("x-forwarded-for")
    ?? req.headers.get("x-real-ip")
    ?? "unknown";

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
