/**
 * Chain registry client.
 *
 * Fetches chain metadata (RPC endpoints, features, native currency, etc.)
 * from https://ethereum-data.awesometools.dev/
 *
 * Only networks listed in this registry are supported.
 */

import { buildAlchemyRpcUrl } from "./alchemy.ts";
import { reliableTextFetch, rpcCall } from "../reliability/rpc-fetch.ts";
import { getClassification } from "../reliability/errors.ts";

const REGISTRY_BASE_URL = "https://ethereum-data.awesometools.dev";

/** Per-attempt timeout for the chain-registry HTTP API. */
const REGISTRY_TIMEOUT_MS = 5_000;
/** Total budget (across retries) for resolving chain metadata — bounds DO/chain init. */
const REGISTRY_DEADLINE_MS = 12_000;

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
  // --- In-band stablecoin gas settlement (see docs/inband-gas-settlement.md). Present in the
  //     awesometools registry JSON; fetchChainInfo passes them through. All optional — a chain
  //     without a `dex`/`stables` simply can't offer stablecoin gas (native in-band still works). ---
  /** Whitelisted stablecoins a user may pay gas in (the anti-drain allowlist). */
  stables?: { symbol: string; type?: string; contract: `0x${string}` }[];
  /** Wrapped native token (e.g. WETH) — the DEX quote leg for the native↔stable rate. */
  wrappedNativeToken?: `0x${string}`;
  /** On-chain DEX used to price native↔stable (Uniswap-v3 QuoterV2). */
  dex?: {
    dex?: string;
    protocol?: string;
    contracts?: { factory?: `0x${string}`; quoterV2?: `0x${string}` };
    url?: string;
  };
}

/**
 * Fetch chain info from the registry by chainId.
 * Throws if the chain is not found (not supported).
 */
export async function fetchChainInfo(chainId: number): Promise<ChainInfo> {
  const url = `${REGISTRY_BASE_URL}/chains/eip155-${chainId}.json`;

  // Bounded fetch: per-attempt timeout + a total deadline + bounded retry of
  // TRANSIENT failures only. Without this a hung registry blocked chain/DO init
  // (and therefore every request for that chain) indefinitely.
  let res;
  try {
    res = await reliableTextFetch(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      {
        dependency: "chain-registry",
        operation: "fetchChainInfo",
        chainId,
        timeoutMs: REGISTRY_TIMEOUT_MS,
        deadlineMs: REGISTRY_DEADLINE_MS,
        maxAttempts: 3,
      },
    );
  } catch (err) {
    // Transient exhaustion / circuit open / timeout — distinguish "registry is
    // unreachable right now" from "chain is genuinely unsupported".
    const cls = getClassification(err);
    throw new Error(
      `Chain registry temporarily unreachable for chain ${chainId} (${cls.reason}). Retry shortly.`,
    );
  }

  // 404 / other permanent non-2xx → genuinely unsupported chain.
  if (res.status >= 400) {
    throw new Error(
      `Chain ${chainId} is not supported. ` +
      `Only networks listed at ${REGISTRY_BASE_URL} are supported.`,
    );
  }

  // The registry may return HTML for unknown chains instead of 404.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(
      `Chain ${chainId} is not supported. ` +
      `Only networks listed at ${REGISTRY_BASE_URL} are supported.`,
    );
  }

  try {
    return JSON.parse(res.text) as ChainInfo;
  } catch {
    throw new Error(`Chain registry returned malformed data for chain ${chainId}`);
  }
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

  // Try up to 5 RPCs sequentially with short timeout. The sequential loop over
  // candidates IS the fallback strategy, so each probe is a single bounded attempt
  // (no inner retry → no request amplification). The breaker lets a repeatedly-dead
  // public RPC be skipped fast on later calls.
  const candidates = publicRpcs.slice(0, 5);

  for (const url of candidates) {
    try {
      const json = await rpcCall(
        url,
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { dependency: "rpc", operation: "eth_chainId", chainId: expectedChainId, timeoutMs: 5000, maxAttempts: 1 },
      );
      if (json.error || typeof json.result !== "string") continue;
      const returnedChainId = parseInt(json.result, 16);
      if (returnedChainId !== expectedChainId) {
        continue;
      }
      return url;
    } catch {
      // This RPC failed (timeout / transient / circuit open) — try next.
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
 *
 * Priority: Alchemy (if API key set + chain supported) > public RPC health check.
 */
export async function resolveChain(chainId: number, alchemyApiKey?: string | null): Promise<{
  chain: ChainInfo;
  rpcUrl: string;
  publicRpcs: string[];
  supportsEip1559: boolean;
}> {
  console.log(`[ChainRegistry] Fetching chain info for chainId ${chainId}...`);
  const chain = await fetchChainInfo(chainId);

  const publicRpcs = filterPublicRpcUrls(chain.rpc);
  const supportsEip1559 = chainSupportsEip1559(chain);

  // Prefer Alchemy if API key is configured and chain is supported
  if (alchemyApiKey) {
    const alchemyUrl = buildAlchemyRpcUrl(chainId, alchemyApiKey);
    if (alchemyUrl) {
      console.log(`[ChainRegistry] ${chain.name} — using Alchemy RPC`);
      console.log(`[ChainRegistry] EIP-1559: ${supportsEip1559}`);
      return { chain, rpcUrl: alchemyUrl, publicRpcs, supportsEip1559 };
    }
  }

  // Fallback: pick best public RPC
  if (publicRpcs.length === 0) {
    throw new Error(
      `Chain "${chain.name}" (${chainId}) has no usable public HTTPS RPC endpoints`,
    );
  }

  console.log(
    `[ChainRegistry] ${chain.name} — ${publicRpcs.length} public RPCs available`,
  );

  const rpcUrl = await pickBestRpc(publicRpcs, chainId);

  console.log(`[ChainRegistry] Selected RPC: ${rpcUrl}`);
  console.log(`[ChainRegistry] EIP-1559: ${supportsEip1559}`);

  return { chain, rpcUrl, publicRpcs, supportsEip1559 };
}
