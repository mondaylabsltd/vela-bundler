/**
 * Native ↔ stablecoin rate via the chain's on-chain DEX (Uniswap-v3 QuoterV2), for the in-band
 * stablecoin gas path (see docs/inband-gas-settlement.md). No external price API: the quoter
 * address + wrappedNative + stablecoin list all come from the registry ChainInfo. A quote is an
 * eth_call of `quoteExactInputSingle` (a nonpayable fn, but read-only via eth_call), cached briefly.
 */

import {
  type PublicClient,
  type Transport,
  type Chain,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
} from "viem";

const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

/** Common Uniswap-v3 fee tier for a stable/WETH pair (0.05%). Overridable per call. */
export const DEFAULT_FEE_TIER = 500;

/** Fee tiers probed (liquidity-priority order) for a stable/wrappedNative pair when no explicit
 *  tier is configured. The old 0.05%-only probe fail-CLOSED on any chain whose curated stable's
 *  deepest pool is the 0.3%/1% tier — quoteExactInputSingle reverts → costStable null → every
 *  stablecoin gas op rejected and the quote endpoint 503s. We probe these in order and remember
 *  the one that works, so availability no longer hinges on a single hardcoded tier. */
export const FEE_TIER_PREFERENCE = [500, 3000, 10000, 100] as const;

/** $0.01 minimum charge, in a stablecoin's own base units, given its decimals. */
export function stableFloorUnits(decimals: number): bigint {
  // 0.01 * 10^decimals = 10^decimals / 100
  return 10n ** BigInt(decimals) / 100n;
}

/**
 * Required stablecoin charge = max($0.01 floor, markupX × the stable value of the bundler's native
 * cost). All in the stablecoin's base units. `costStable` is the DEX quote of the native cost.
 */
export function requiredStableCharge(costStable: bigint, decimals: number, markupX: bigint): bigint {
  const marked = costStable * markupX;
  const floor = stableFloorUnits(decimals);
  return marked > floor ? marked : floor;
}

const RATE_CACHE_MS = 30_000;
/** A cached quote may be linearly rescaled only within this amount band — v3 price impact is
 *  negligible at gas-sized amounts but nonlinear across large deltas, so a materially different
 *  amount is re-quoted rather than rescaled from a stale sample. */
const CACHE_RESCALE_MAX_RATIO = 4n; // reuse only if requested ∈ [1/4, 4]× the cached amount
const rateCache = new Map<string, { at: number; nativeIn: bigint; stableOut: bigint; fee: number }>();
/** Remembered working fee tier per (chain, stable), with a TTL. Probing every quote from the top
 *  of FEE_TIER_PREFERENCE is wasteful, but a PERMANENT memo would pin a WORSE tier forever if the
 *  preferred (deepest) tier merely TRANSIENTLY blipped on the first probe (a null is
 *  indistinguishable from a genuine pool-absent revert). The TTL forces a periodic re-probe from
 *  the top, so a mispin self-heals within WORKING_TIER_TTL_MS. */
const workingTierCache = new Map<string, { fee: number; at: number }>();
const WORKING_TIER_TTL_MS = 5 * 60_000;
const decimalsCache = new Map<string, number>();

export interface StableQuoteConfig {
  quoterV2: `0x${string}`;
  wrappedNative: `0x${string}`;
  stable: `0x${string}`;
  /** Force a specific fee tier (skips the multi-tier probe). Callers normally omit this. */
  feeTier?: number;
}

/** True when `a` and `b` are within CACHE_RESCALE_MAX_RATIO× of each other. */
function withinRescaleBand(a: bigint, b: bigint): boolean {
  return a <= b * CACHE_RESCALE_MAX_RATIO && b <= a * CACHE_RESCALE_MAX_RATIO;
}

/** One quoteExactInputSingle eth_call at a specific fee tier. null on revert (no such pool) /
 *  RPC error / non-positive output. */
async function quoteOneTier(
  client: PublicClient<Transport, Chain>,
  cfg: StableQuoteConfig,
  nativeAmount: bigint,
  fee: number,
): Promise<bigint | null> {
  const data = encodeFunctionData({
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: cfg.wrappedNative, tokenOut: cfg.stable, amountIn: nativeAmount, fee, sqrtPriceLimitX96: 0n }],
  });
  try {
    const res = await client.call({ to: cfg.quoterV2, data });
    if (!res.data) return null;
    const decoded = decodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", data: res.data });
    const amountOut = (decoded as readonly bigint[])[0] as bigint;
    return amountOut > 0n ? amountOut : null;
  } catch {
    return null;
  }
}

/**
 * Quote how many `stable` units equal `nativeAmount` wei (wrappedNative → stable). Returns null if
 * NO fee tier yields a quote (no pool / RPC error) so the caller can fail closed. Cached per
 * (chainId, stable): the rate moves slowly relative to the 30s TTL and is rescaled linearly for a
 * nearby amount (re-quoted outside a bounded band). When no explicit tier is configured, probes
 * FEE_TIER_PREFERENCE in liquidity-priority order and remembers the first that works, so a chain
 * whose stable's deepest pool isn't the 0.05% tier is no longer fail-closed.
 */
export async function quoteNativeToStable(
  client: PublicClient<Transport, Chain>,
  cfg: StableQuoteConfig,
  nativeAmount: bigint,
  chainId: number,
): Promise<bigint | null> {
  if (nativeAmount <= 0n) return 0n;
  const key = `${chainId}:${cfg.stable.toLowerCase()}`;

  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.at < RATE_CACHE_MS && cached.nativeIn > 0n && withinRescaleBand(nativeAmount, cached.nativeIn)) {
    // Linear rescale: stableOut/nativeIn is the price; apply to the requested (nearby) amount.
    return (nativeAmount * cached.stableOut) / cached.nativeIn;
  }

  // Tier order: an explicit tier; else the remembered working tier first (only if still fresh —
  // a stale memo is ignored so the probe restarts from the deepest tier), then the preference list.
  const remembered = workingTierCache.get(key);
  const freshTier = remembered && Date.now() - remembered.at < WORKING_TIER_TTL_MS ? remembered.fee : undefined;
  const tiers = cfg.feeTier !== undefined
    ? [cfg.feeTier]
    : [...new Set([freshTier, ...FEE_TIER_PREFERENCE].filter((t): t is number => t !== undefined))];

  for (const fee of tiers) {
    const amountOut = await quoteOneTier(client, cfg, nativeAmount, fee);
    if (amountOut !== null) {
      rateCache.set(key, { at: Date.now(), nativeIn: nativeAmount, stableOut: amountOut, fee });
      if (cfg.feeTier === undefined) workingTierCache.set(key, { fee, at: Date.now() });
      return amountOut;
    }
  }
  return null;
}

/** Read (and cache forever) a token's decimals. Falls back to 6 (the common stablecoin default). */
export async function stableDecimals(
  client: PublicClient<Transport, Chain>,
  stable: `0x${string}`,
): Promise<number> {
  const key = stable.toLowerCase();
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const data = encodeFunctionData({ abi: DECIMALS_ABI, functionName: "decimals" });
    const res = await client.call({ to: stable, data });
    if (res.data) {
      const dec = Number(decodeFunctionResult({ abi: DECIMALS_ABI, functionName: "decimals", data: res.data }));
      if (Number.isFinite(dec) && dec >= 0 && dec <= 36) {
        decimalsCache.set(key, dec);
        return dec;
      }
    }
  } catch {
    // fall through to default
  }
  return 6;
}
