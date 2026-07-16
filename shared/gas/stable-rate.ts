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
const rateCache = new Map<string, { at: number; nativeIn: bigint; stableOut: bigint }>();
const decimalsCache = new Map<string, number>();

export interface StableQuoteConfig {
  quoterV2: `0x${string}`;
  wrappedNative: `0x${string}`;
  stable: `0x${string}`;
  feeTier?: number;
}

/**
 * Quote how many `stable` units equal `nativeAmount` wei (WETH → stable). Returns null if the quote
 * can't be obtained (no pool / RPC error) so the caller can fail closed (reject the stablecoin op).
 * Cached per (chainId, stable, feeTier) — the rate moves slowly relative to a 30s TTL, and the
 * result scales linearly, so a cached quote for a different amount is rescaled proportionally.
 */
export async function quoteNativeToStable(
  client: PublicClient<Transport, Chain>,
  cfg: StableQuoteConfig,
  nativeAmount: bigint,
  chainId: number,
): Promise<bigint | null> {
  if (nativeAmount <= 0n) return 0n;
  const fee = cfg.feeTier ?? DEFAULT_FEE_TIER;
  const key = `${chainId}:${cfg.stable.toLowerCase()}:${fee}`;
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.at < RATE_CACHE_MS && cached.nativeIn > 0n) {
    // Linear rescale: stableOut/nativeIn is the price; apply to the requested amount.
    return (nativeAmount * cached.stableOut) / cached.nativeIn;
  }
  const data = encodeFunctionData({
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{
      tokenIn: cfg.wrappedNative,
      tokenOut: cfg.stable,
      amountIn: nativeAmount,
      fee,
      sqrtPriceLimitX96: 0n,
    }],
  });
  try {
    const res = await client.call({ to: cfg.quoterV2, data });
    if (!res.data) return null;
    const decoded = decodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", data: res.data });
    const amountOut = (decoded as readonly bigint[])[0] as bigint;
    if (amountOut <= 0n) return null;
    rateCache.set(key, { at: Date.now(), nativeIn: nativeAmount, stableOut: amountOut });
    return amountOut;
  } catch {
    return null;
  }
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
