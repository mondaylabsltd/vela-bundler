/**
 * Authentication middleware for private bundler APIs.
 *
 * Uses a simple Bearer token for now.
 * Future: JWT, HMAC signatures, mTLS, etc.
 */

export interface AuthConfig {
  /** Bearer token for API authentication. */
  apiToken: string;
  /** Rate limit: max requests per minute per IP. */
  rateLimitPerMinute: number;
}

/** In-memory rate limiter. */
const requestCounts: Map<string, { count: number; resetAt: number }> = new Map();

/**
 * Validate a request's Authorization header.
 * Returns null on success, or an error message string on failure.
 */
export function validateAuth(
  req: Request,
  config: AuthConfig,
): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return "Missing Authorization header";
  }

  if (!authHeader.startsWith("Bearer ")) {
    return "Authorization must use Bearer scheme";
  }

  const token = authHeader.slice(7);
  if (token !== config.apiToken) {
    return "Invalid API token";
  }

  return null;
}

/**
 * Check rate limit for a request.
 * Returns null if within limit, or error message if rate limited.
 */
export function checkRateLimit(
  req: Request,
  config: AuthConfig,
): string | null {
  // Extract client IP (simplified — production should use X-Forwarded-For etc.)
  const ip = req.headers.get("x-forwarded-for")
    ?? req.headers.get("x-real-ip")
    ?? "unknown";

  const now = Date.now();
  const windowMs = 60_000;
  let entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    requestCounts.set(ip, entry);
  }

  entry.count++;

  if (entry.count > config.rateLimitPerMinute) {
    return "Rate limit exceeded";
  }

  return null;
}

/**
 * Combined auth + rate limit check.
 * Returns null on success, or Response to send back on failure.
 */
export function authGuard(
  req: Request,
  config: AuthConfig,
): Response | null {
  const rateLimitError = checkRateLimit(req, config);
  if (rateLimitError) {
    return new Response(
      JSON.stringify({ error: rateLimitError }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  const authError = validateAuth(req, config);
  if (authError) {
    return new Response(
      JSON.stringify({ error: authError }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}
