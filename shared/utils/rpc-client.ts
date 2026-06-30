/**
 * RPC client factory with fallback and per-request override support.
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { RPC_TIMEOUT_MS } from "./timeout.ts";

/**
 * Transport tuning for read-only viem clients.
 * - timeout: hard per-request bound so a hung node can't block us indefinitely
 *   (viem aborts the underlying fetch on timeout — real cancellation, unlike a
 *   bare Promise race).
 * - retryCount: bounded internal retry for idempotent reads (viem backs off with
 *   jitter). Kept small (2) so it doesn't stack with the reliability layer's own
 *   retry into a request-amplification storm.
 */
/**
 * Redirect mode for outbound RPC fetches. MUST be "manual" (NOT "error"): Cloudflare
 * Workers' fetch only supports "follow" | "manual" and rejects "error" at the edge
 * ("Invalid redirect value"), which would break every viem RPC call in production.
 * "manual" still does NOT follow the redirect — a 3xx is returned as an opaqueredirect
 * that viem fails to parse and surfaces as an error — so the anti-SSRF protection
 * (a user-allowed host must not 302 us to an internal/metadata IP) is preserved.
 */
export const RPC_REDIRECT_MODE: RequestRedirect = "manual";

const READ_TRANSPORT_OPTS = {
  timeout: RPC_TIMEOUT_MS,
  retryCount: 2,
  retryDelay: 150,
  fetchOptions: { redirect: RPC_REDIRECT_MODE },
} as const;

/**
 * Validate a user-provided RPC URL.
 * Blocks non-HTTPS URLs and obvious dangerous targets (link-local, metadata endpoints).
 * Returns null if valid, or an error message if rejected.
 */
export function validateRpcUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  if (parsed.protocol !== "https:") {
    return "Only HTTPS RPC URLs are accepted";
  }

  // Canonicalize the host: lowercase, strip a single trailing dot (a trailing-dot FQDN
  // like "metadata.google.internal." otherwise defeats === and .endsWith checks), and
  // strip IPv6 brackets so we can inspect the address.
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const isIpv6Literal = hostname.startsWith("[") || hostname.includes(":");
  const ipv6 = isIpv6Literal ? hostname.replace(/^\[/, "").replace(/\]$/, "") : "";

  // Block URLs with credentials (user:pass@host)
  if (parsed.username || parsed.password) {
    return "URLs with credentials are not allowed";
  }

  // --- IPv6 literals: block loopback, unspecified, link-local, ULA, and any
  //     IPv4-mapped form (e.g. [::ffff:169.254.169.254]) that embeds a blocked v4. ---
  if (isIpv6Literal) {
    const blocked = blockedIpv6(ipv6);
    if (blocked) return blocked;
    // Non-blocked global-unicast IPv6 is permitted (rare for public RPCs, but allowed).
  }

  // Block loopback addresses (IPv4 variants; IPv6 ::1 handled above)
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.")
  ) {
    return "Loopback addresses are not allowed";
  }

  // Block cloud metadata endpoints
  if (
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname === "168.63.129.16" ||          // Azure IMDS
    hostname.endsWith(".internal")
  ) {
    return "Blocked metadata endpoint";
  }

  // Block private/reserved IPv4 ranges (RFC1918, RFC3927 link-local)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && isBlockedIpv4(hostname)) {
    return "Private network addresses are not allowed";
  }

  return null;
}

/** True if a dotted-decimal IPv4 is loopback/private/link-local/reserved. */
function isBlockedIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → block
  return (
    p[0] === 0 ||                                   // 0.0.0.0/8
    p[0] === 10 ||                                  // 10.0.0.0/8
    p[0] === 127 ||                                 // loopback
    (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || // 172.16.0.0/12
    (p[0] === 192 && p[1] === 168) ||               // 192.168.0.0/16
    (p[0] === 169 && p[1] === 254)                  // 169.254.0.0/16 link-local (cloud IMDS)
  );
}

/**
 * Return a rejection reason for a dangerous IPv6 address (brackets already stripped),
 * or null to allow. Blocks loopback (::1), unspecified (::), link-local (fe80::/10),
 * unique-local (fc00::/7), and IPv4-mapped (::ffff:a.b.c.d / ::ffff:hhhh:hhhh) whose
 * embedded IPv4 is itself blocked — closing the [::ffff:169.254.169.254] metadata SSRF.
 */
function blockedIpv6(addr: string): string | null {
  const x = addr.toLowerCase();
  // Loopback (::1) / unspecified (::), compact or fully-expanded (0:0:0:0:0:0:0:1).
  if (x === "::1" || x === "::") return "Loopback addresses are not allowed";
  if (!x.includes("::") && x.split(":").length === 8) {
    const g = x.split(":");
    const allZero = g.every((p) => /^0+$/.test(p));
    const loopback = g.slice(0, 7).every((p) => /^0+$/.test(p)) && /^0*1$/.test(g[7]!);
    if (allZero || loopback) return "Loopback addresses are not allowed";
  }
  // Link-local fe80::/10  and unique-local fc00::/7 (fc/fd).
  if (/^fe[89ab]/.test(x) || /^f[cd]/.test(x)) {
    return "Private network addresses are not allowed";
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh, compact or expanded).
  if (x.includes("ffff:") || /:ffff:/.test(x)) {
    const dotted = x.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) {
      return isBlockedIpv4(dotted[1]!) ? "Blocked metadata endpoint" : null;
    }
    // Hex-form mapped (…:ffff:a9fe:a9fe). Convert the trailing two 16-bit groups to v4.
    const hex = x.match(/ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
      const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isBlockedIpv4(v4) ? "Blocked metadata endpoint" : null;
    }
    // Unrecognised mapped form — fail closed.
    return "Blocked metadata endpoint";
  }
  return null;
}

/**
 * Resolve the effective RPC URL for a request.
 * Per-request X-Rpc-Url override > chain config rpcUrl.
 */
export function resolveRpcUrl(
  config: { rpcUrl: string },
  requestRpcUrl?: string | null,
): string {
  if (requestRpcUrl && requestRpcUrl.length > 0) {
    return requestRpcUrl;
  }
  return config.rpcUrl;
}

/** Cache of public clients by RPC URL to avoid re-creation. Max 50 entries. */
const CLIENT_CACHE_MAX = 50;
const clientCache = new Map<string, PublicClient<Transport, Chain>>();

/**
 * Get or create a PublicClient for the given RPC URL.
 * Evicts oldest entry when cache exceeds max size.
 */
export function getPublicClient(rpcUrl: string): PublicClient<Transport, Chain> {
  let client = clientCache.get(rpcUrl);
  if (!client) {
    // Evict oldest entry if at capacity (Map iterates in insertion order)
    if (clientCache.size >= CLIENT_CACHE_MAX) {
      const oldest = clientCache.keys().next().value;
      if (oldest !== undefined) clientCache.delete(oldest);
    }
    client = createPublicClient({
      transport: http(rpcUrl, READ_TRANSPORT_OPTS),
    }) as PublicClient<Transport, Chain>;
    clientCache.set(rpcUrl, client);
  }
  return client;
}

/**
 * Try an RPC call with automatic fallback to alternative URLs.
 * Returns the result from the first RPC that succeeds.
 */
export async function withRpcFallback<T>(
  primaryRpcUrl: string,
  fallbackRpcUrls: string[],
  fn: (client: PublicClient<Transport, Chain>) => Promise<T>,
): Promise<T> {
  // Try primary first
  try {
    return await fn(getPublicClient(primaryRpcUrl));
  } catch (primaryErr) {
    // Try fallbacks
    for (const fallbackUrl of fallbackRpcUrls) {
      if (fallbackUrl === primaryRpcUrl) continue;
      try {
        const result = await fn(getPublicClient(fallbackUrl));
        console.warn(
          `[RPC] Primary ${primaryRpcUrl} failed, used fallback ${fallbackUrl}`,
        );
        return result;
      } catch {
        // This fallback also failed, try next
      }
    }
    // All failed — throw original error
    throw primaryErr;
  }
}
