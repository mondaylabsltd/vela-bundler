/**
 * RPC client factory with per-request override support.
 *
 * Priority: X-Rpc-Url header > chain config rpcUrl > registry-resolved
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import type { BundlerConfig } from "../config/index.ts";

/**
 * Resolve the effective RPC URL for a request.
 * @param config - Chain-specific config (contains rpcUrl from registry)
 * @param requestRpcUrl - Per-request override from X-Rpc-Url header
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

/** Cache of public clients by RPC URL to avoid re-creation. */
const clientCache = new Map<string, PublicClient<Transport, Chain>>();

/**
 * Get or create a PublicClient for the given RPC URL.
 */
export function getPublicClient(rpcUrl: string): PublicClient<Transport, Chain> {
  let client = clientCache.get(rpcUrl);
  if (!client) {
    client = createPublicClient({
      transport: http(rpcUrl),
    }) as PublicClient<Transport, Chain>;
    clientCache.set(rpcUrl, client);
  }
  return client;
}
