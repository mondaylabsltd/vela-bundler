import { it, expect } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem";
import {
  stableFloorUnits,
  requiredStableCharge,
  nativeFloorWei,
  requiredNativeCharge,
  DEFAULT_FEE_TIER,
  FEE_TIER_PREFERENCE,
  quoteNativeToStable,
  type StableQuoteConfig,
} from "../shared/gas/stable-rate.ts";

const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const CFG: StableQuoteConfig = {
  quoterV2: ("0x" + "a1".repeat(20)) as `0x${string}`,
  wrappedNative: ("0x" + "b2".repeat(20)) as `0x${string}`,
  stable: ("0x" + "c3".repeat(20)) as `0x${string}`,
};
const encQuote = (amountOut: bigint) =>
  encodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", result: [amountOut, 0n, 0, 0n] });

/** Mock viem PublicClient.call driven by a per-call plan; returns a call counter. */
function mockClient(plan: (i: number) => "throw" | { data: `0x${string}` }) {
  let calls = 0;
  const client = { call: async () => { const p = plan(calls++); if (p === "throw") throw new Error("execution reverted"); return p; } } as any;
  return { client, calls: () => calls };
}

it("stableFloorUnits: $0.01 in a token's base units", () => {
  expect(stableFloorUnits(6)).toEqual(10_000n); // USDC/USDT (6-dec): 0.01 * 1e6
  expect(stableFloorUnits(18)).toEqual(10_000_000_000_000_000n); // DAI (18-dec): 0.01 * 1e18
  expect(stableFloorUnits(2)).toEqual(1n); // 0.01 * 1e2
  expect(stableFloorUnits(0)).toEqual(0n); // no sub-unit precision
});

it("requiredStableCharge: max($0.01 floor, markup × cost)", () => {
  // Tiny op: 3× cost is below $0.01 → the floor binds.
  expect(requiredStableCharge(1_000n, 6, 3n)).toEqual(10_000n); // 3*1000=3000 < 10000 floor
  // Normal op: 3× cost exceeds the floor → the markup binds.
  expect(requiredStableCharge(100_000n, 6, 3n)).toEqual(300_000n); // 3*100000 > floor
  // Exactly at the floor boundary.
  expect(requiredStableCharge(10_000n / 3n, 6, 3n)).toEqual(10_000n); // 3*3333=9999 < floor → floor
  // 18-dec token.
  expect(requiredStableCharge(5n * 10n ** 16n, 18, 3n)).toEqual(15n * 10n ** 16n); // markup binds
});

it("nativeFloorWei: 1e-5 of a native coin in its base units", () => {
  expect(nativeFloorWei(18)).toEqual(10_000_000_000_000n); // 1e-5 ETH = 1e13 wei
  expect(nativeFloorWei()).toEqual(10_000_000_000_000n); // default decimals = 18
  expect(nativeFloorWei(6)).toEqual(10n); // 1e-5 * 1e6
  expect(nativeFloorWei(5)).toEqual(1n); // 1e-5 * 1e5
  expect(nativeFloorWei(4)).toEqual(0n); // sub-1e-5 precision → no floor (pre-change behaviour)
  expect(nativeFloorWei(0)).toEqual(0n);
});

it("requiredNativeCharge: max(1e-5-native floor, markup × cost)", () => {
  const floor18 = 10_000_000_000_000n; // 1e13 wei
  // Tiny op: 3× cost below the floor → the floor binds.
  expect(requiredNativeCharge(1_000_000n, 3n, 18)).toEqual(floor18); // 3e6 ≪ 1e13
  // Normal op: 3× cost exceeds the floor → the markup binds.
  expect(requiredNativeCharge(10n ** 13n, 3n, 18)).toEqual(3n * 10n ** 13n);
  // Just below the boundary: 3× cost < floor → floor.
  expect(requiredNativeCharge(floor18 / 3n, 3n, 18)).toEqual(floor18); // 3*3.33e12 = 9.99e12 < floor
  // Default decimals = 18.
  expect(requiredNativeCharge(1n, 3n)).toEqual(floor18);
  // Gate markup (2×) binds once above the floor — quote (3×) and gate (2×) share the same floor.
  expect(requiredNativeCharge(10n ** 13n, 2n, 18)).toEqual(2n * 10n ** 13n);
});

it("DEFAULT_FEE_TIER is the 0.05% Uniswap-v3 tier", () => {
  expect(DEFAULT_FEE_TIER).toEqual(500);
});

it("FEE_TIER_PREFERENCE probes 0.05% first then the deeper tiers", () => {
  expect([...FEE_TIER_PREFERENCE]).toEqual([500, 3000, 10000, 100]);
});

it("quoteNativeToStable: falls back to the next fee tier when the 0.05% pool reverts (availability fix)", async () => {
  // call 0 = tier 500 → revert (no 0.05% pool); call 1 = tier 3000 → a quote.
  const { client, calls } = mockClient((i) => (i === 0 ? "throw" : { data: encQuote(2_000_000n) }));
  const out = await quoteNativeToStable(client, CFG, 10n ** 15n, 990101);
  expect(out).toEqual(2_000_000n);
  expect(calls()).toEqual(2); // probed 500 (revert) then 3000 (hit)
});

it("quoteNativeToStable: returns null (fail closed) when NO fee tier has a pool", async () => {
  const { client } = mockClient(() => "throw");
  const out = await quoteNativeToStable(client, CFG, 10n ** 15n, 990102);
  expect(out).toBeNull();
});

it("quoteNativeToStable: reuses the cache for a NEARBY amount but re-quotes for a FAR one", async () => {
  const chainId = 990103;
  const { client, calls } = mockClient(() => ({ data: encQuote(1_000_000n) }));
  await quoteNativeToStable(client, CFG, 10n ** 15n, chainId);        // cold: 1 eth_call, caches tier 500
  expect(calls()).toEqual(1);
  const near = await quoteNativeToStable(client, CFG, 2n * 10n ** 15n, chainId); // 2× → within band → rescale, no call
  expect(calls()).toEqual(1);
  expect(near).toEqual(2_000_000n); // linear rescale of the cached price
  await quoteNativeToStable(client, CFG, 100n * 10n ** 15n, chainId); // 100× → outside band → re-quote
  expect(calls()).toEqual(2);
});
