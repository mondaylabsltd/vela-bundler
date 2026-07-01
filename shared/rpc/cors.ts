/**
 * Site-wide CORS policy — single source of truth.
 *
 * The bundler API is PUBLIC and CREDENTIAL-LESS: no cookies, no Authorization, no session.
 * CORS only protects *credentialed* cross-origin access, so a fully-permissive policy here
 * exposes nothing extra — the real controls are the rate limiter, X-Rpc-Url validation and
 * request-size caps, none of which CORS affects.
 *
 * `Access-Control-Allow-Headers: *` allows ANY request header. This deliberately avoids the
 * recurring breakage where a new client header (e.g. Idempotency-Key) is blocked by the
 * preflight until someone remembers to add it to a hand-maintained list. The `*` wildcard is
 * honoured because responses are non-credentialed (`Allow-Origin: *`, no Allow-Credentials).
 *
 * `Access-Control-Max-Age` caches the preflight for a day, cutting preflight round-trips.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

/** Standard 204 preflight response with the permissive CORS headers. */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
