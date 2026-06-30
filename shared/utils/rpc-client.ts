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
const READ_TRANSPORT_OPTS = { timeout: RPC_TIMEOUT_MS, retryCount: 2, retryDelay: 150 } as const;

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

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback addresses (IPv4/IPv6 variants)
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
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
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const parts = hostname.split(".").map(Number);
    if (
      parts[0] === 10 ||                                          // 10.0.0.0/8
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || // 172.16.0.0/12
      (parts[0] === 192 && parts[1] === 168) ||                   // 192.168.0.0/16
      (parts[0] === 169 && parts[1] === 254)                      // 169.254.0.0/16 link-local
    ) {
      return "Private network addresses are not allowed";
    }
  }

  // Block URLs with credentials (user:pass@host)
  if (parsed.username || parsed.password) {
    return "URLs with credentials are not allowed";
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
