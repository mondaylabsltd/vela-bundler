/**
 * RPC client factory with per-request override support.
 *
 * Priority for RPC URL resolution:
 *   1. Per-request override (X-Rpc-Url header)
 *   2. User-provided RPCs (USER_RPC_URLS env, highest config priority)
 *   3. Operator RPC_URL env
 *   4. Registry-resolved RPC
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
 * @param config - Bundler config (contains default rpcUrl, userRpcUrls, publicRpcs)
 * @param requestRpcUrl - Per-request override from X-Rpc-Url header (highest priority)
 */
export function resolveRpcUrl(
  config: BundlerConfig,
  requestRpcUrl?: string | null,
): string {
  if (requestRpcUrl && requestRpcUrl.length > 0) {
    return requestRpcUrl;
  }
  // config.rpcUrl already has the right priority baked in from loadConfig()
  return config.rpcUrl;
}

/**
 * Get all fallback RPC URLs in priority order.
 */
export function getAllRpcUrls(
  config: BundlerConfig,
  requestRpcUrl?: string | null,
): string[] {
  const urls: string[] = [];

  // 1. Per-request override
  if (requestRpcUrl) urls.push(requestRpcUrl);

  // 2. User-provided RPCs
  for (const u of config.userRpcUrls) {
    if (!urls.includes(u)) urls.push(u);
  }

  // 3. Config default (could be RPC_URL or registry)
  if (!urls.includes(config.rpcUrl)) urls.push(config.rpcUrl);

  // 4. Registry public RPCs
  for (const u of config.publicRpcs) {
    if (!urls.includes(u)) urls.push(u);
  }

  return urls;
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

/**
 * Get a PublicClient for the effective RPC of a request.
 */
export function getClientForRequest(
  config: BundlerConfig,
  requestRpcUrl?: string | null,
): PublicClient<Transport, Chain> {
  const url = resolveRpcUrl(config, requestRpcUrl);
  return getPublicClient(url);
}
