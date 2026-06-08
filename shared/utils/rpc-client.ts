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

  // Block cloud metadata endpoints
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
    return "Blocked hostname";
  }

  // Block loopback
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return "Loopback addresses are not allowed";
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
      transport: http(rpcUrl),
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
