/**
 * Chain registry client.
 *
 * Fetches chain metadata (RPC endpoints, features, native currency, etc.)
 * from https://ethereum-data.awesometools.dev/
 *
 * Only networks listed in this registry are supported.
 */

const REGISTRY_BASE_URL = "https://ethereum-data.awesometools.dev";

/**
 * Chain metadata as returned by the registry.
 */
export interface ChainInfo {
  name: string;
  chain: string;
  chainId: number;
  networkId: number;
  shortName: string;
  rpc: string[];
  features?: { name: string }[];
  faucets: string[];
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  infoURL: string;
  explorers?: {
    name: string;
    url: string;
    standard?: string;
  }[];
}

/**
 * Fetch chain info from the registry by chainId.
 * Throws if the chain is not found (not supported).
 */
export async function fetchChainInfo(chainId: number): Promise<ChainInfo> {
  const url = `${REGISTRY_BASE_URL}/chains/eip155-${chainId}.json`;

  const res = await fetch(url);
  if (!res.ok) {
    // Consume body to avoid leaks
    await res.body?.cancel();
    throw new Error(
      `Chain ${chainId} is not supported. ` +
      `Only networks listed at ${REGISTRY_BASE_URL} are supported.`,
    );
  }

  // The registry may return HTML for unknown chains instead of 404
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    await res.body?.cancel();
    throw new Error(
      `Chain ${chainId} is not supported. ` +
      `Only networks listed at ${REGISTRY_BASE_URL} are supported.`,
    );
  }

  const data = await res.json() as ChainInfo;
  return data;
}

/**
 * Filter RPC URLs from the registry:
 * - Only HTTPS (no WSS, no HTTP)
 * - Exclude URLs containing template variables like ${API_KEY}
 * - Return in original order (registry-preferred order)
 */
export function filterPublicRpcUrls(rpcUrls: string[]): string[] {
  return rpcUrls.filter((url) => {
    if (!url.startsWith("https://")) return false;
    if (url.includes("${")) return false;
    return true;
  });
}

/**
 * Pick the best RPC URL for bundler use.
 * Strategy: try each public RPC with eth_chainId sequentially (fast timeout),
 * return the first that responds correctly.
 * Falls back to the first public URL if all health checks fail.
 */
export async function pickBestRpc(
  publicRpcs: string[],
  expectedChainId: number,
): Promise<string> {
  if (publicRpcs.length === 0) {
    throw new Error("No usable public RPC endpoints found for this chain");
  }

  // Try up to 5 RPCs sequentially with short timeout
  const candidates = publicRpcs.slice(0, 5);

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      const json = await res.json();
      const returnedChainId = parseInt(json.result, 16);
      if (returnedChainId !== expectedChainId) {
        continue;
      }
      return url;
    } catch {
      // This RPC failed, try next
      continue;
    }
  }

  // All health checks failed — return first URL as fallback
  console.warn(
    `[ChainRegistry] All RPC health checks failed for chainId ${expectedChainId}, ` +
    `using first available: ${publicRpcs[0]}`,
  );
  return publicRpcs[0]!;
}

/**
 * Check if a chain supports EIP-1559 based on its features list.
 */
export function chainSupportsEip1559(chain: ChainInfo): boolean {
  return chain.features?.some((f) => f.name === "EIP1559") ?? false;
}

/**
 * Resolve chain info + best RPC for a given chainId.
 * This is the main entry point for chain resolution.
 */
export async function resolveChain(chainId: number): Promise<{
  chain: ChainInfo;
  rpcUrl: string;
  publicRpcs: string[];
  supportsEip1559: boolean;
}> {
  console.log(`[ChainRegistry] Fetching chain info for chainId ${chainId}...`);
  const chain = await fetchChainInfo(chainId);

  const publicRpcs = filterPublicRpcUrls(chain.rpc);
  if (publicRpcs.length === 0) {
    throw new Error(
      `Chain "${chain.name}" (${chainId}) has no usable public HTTPS RPC endpoints`,
    );
  }

  console.log(
    `[ChainRegistry] ${chain.name} — ${publicRpcs.length} public RPCs available`,
  );

  const rpcUrl = await pickBestRpc(publicRpcs, chainId);
  const supportsEip1559 = chainSupportsEip1559(chain);

  console.log(`[ChainRegistry] Selected RPC: ${rpcUrl}`);
  console.log(`[ChainRegistry] EIP-1559: ${supportsEip1559}`);

  return { chain, rpcUrl, publicRpcs, supportsEip1559 };
}
