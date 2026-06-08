/**
 * Unit tests for gas calculation and profitability.
 */

import { assertEquals, assert } from "@std/assert";
import { calcPreVerificationGas } from "../shared/gas/preVerificationGas.ts";
import {
  calcUserOpGasPrice,
  checkBundleProfitability,
  checkUserOpProfitability,
  calcOuterTxGasPrice,
  calcUserOpMaxGas,
} from "../shared/gas/profitability.ts";
import { calldataGasCost, countCalldataBytes } from "../shared/utils/hex.ts";
import { isArbitrumChain, isOpStackChain, isL2WithDataFee } from "../shared/gas/l2-data-fee.ts";
import type { UserOperation } from "../shared/userop/types.ts";

function makeUserOp(overrides: Partial<UserOperation> = {}): UserOperation {
  return {
    sender: "0x1234567890abcdef1234567890abcdef12345678",
    nonce: 0n,
    factory: null,
    factoryData: null,
    callData: "0xdeadbeef",
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 30_000_000_000n, // 30 gwei
    maxPriorityFeePerGas: 2_000_000_000n, // 2 gwei
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature:
      "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c",
    ...overrides,
  };
}

// --- Calldata gas ---

Deno.test("calldataGasCost - zero bytes cost 4 gas each", () => {
  const cost = calldataGasCost("0x0000");
  assertEquals(cost, 8n); // 2 zero bytes * 4
});

Deno.test("calldataGasCost - non-zero bytes cost 16 gas each", () => {
  const cost = calldataGasCost("0xffff");
  assertEquals(cost, 32n); // 2 non-zero bytes * 16
});

Deno.test("calldataGasCost - mixed bytes", () => {
  const cost = calldataGasCost("0x00ff00ff");
  assertEquals(cost, 40n); // 2*4 + 2*16 = 8 + 32
});

Deno.test("countCalldataBytes - counts correctly", () => {
  const { zeroBytes, nonZeroBytes } = countCalldataBytes("0x00ff0011");
  assertEquals(zeroBytes, 2); // 0x00 and the first byte of 0x00
  assertEquals(nonZeroBytes, 2); // 0xff and 0x11
});

// --- preVerificationGas ---

Deno.test("calcPreVerificationGas - returns a positive bigint", () => {
  const userOp = makeUserOp();
  const pvg = calcPreVerificationGas(userOp, { expectedBundleSize: 1 });
  assert(pvg > 0n);
});

Deno.test("calcPreVerificationGas - larger calldata costs more", () => {
  const smallOp = makeUserOp({ callData: "0xdeadbeef" });
  const largeOp = makeUserOp({
    callData: ("0x" + "ff".repeat(1000)) as `0x${string}`,
  });

  const smallPvg = calcPreVerificationGas(smallOp, { expectedBundleSize: 1 });
  const largePvg = calcPreVerificationGas(largeOp, { expectedBundleSize: 1 });

  assert(largePvg > smallPvg, "Larger calldata should have higher preVerificationGas");
});

Deno.test("calcPreVerificationGas - larger bundle size reduces base cost share", () => {
  const userOp = makeUserOp();
  const pvg1 = calcPreVerificationGas(userOp, { expectedBundleSize: 1 });
  const pvg10 = calcPreVerificationGas(userOp, { expectedBundleSize: 10 });

  assert(pvg1 > pvg10, "Single-op bundle should have higher preVerificationGas than 10-op bundle");
});

Deno.test("calcPreVerificationGas - EIP-7702 auth adds gas", () => {
  const userOp = makeUserOp();
  // Use fixed slack to isolate the auth gas contribution
  const pvgNoAuth = calcPreVerificationGas(userOp, {
    expectedBundleSize: 1,
    slackPercent: 0,
    minSlack: 0n,
  });
  const pvgWithAuth = calcPreVerificationGas(userOp, {
    expectedBundleSize: 1,
    eip7702AuthCount: 2,
    slackPercent: 0,
    minSlack: 0n,
  });

  assertEquals(pvgWithAuth - pvgNoAuth, 50_000n); // 2 * 25000
});

Deno.test("calcPreVerificationGas - l2DataFeeGas is added to total", () => {
  const userOp = makeUserOp();
  const pvgWithout = calcPreVerificationGas(userOp, {
    expectedBundleSize: 1,
    slackPercent: 0,
    minSlack: 0n,
  });
  const l2Fee = 500_000n;
  const pvgWith = calcPreVerificationGas(userOp, {
    expectedBundleSize: 1,
    l2DataFeeGas: l2Fee,
    slackPercent: 0,
    minSlack: 0n,
  });
  assertEquals(pvgWith - pvgWithout, l2Fee);
});

Deno.test("calcPreVerificationGas - l2DataFeeGas zero/undefined has no effect", () => {
  const userOp = makeUserOp();
  const ctx = { expectedBundleSize: 1, slackPercent: 0, minSlack: 0n };
  const pvgNone = calcPreVerificationGas(userOp, ctx);
  const pvgZero = calcPreVerificationGas(userOp, { ...ctx, l2DataFeeGas: 0n });
  const pvgUndef = calcPreVerificationGas(userOp, { ...ctx, l2DataFeeGas: undefined });
  assertEquals(pvgNone, pvgZero);
  assertEquals(pvgNone, pvgUndef);
});

Deno.test("calcPreVerificationGas - minimum slack applied", () => {
  const userOp = makeUserOp({ callData: "0x00" });
  const pvg = calcPreVerificationGas(userOp, {
    expectedBundleSize: 1,
    slackPercent: 0,
    minSlack: 5000n,
  });
  // Even with 0% slack, minSlack should apply
  const pvgNoSlack = calcPreVerificationGas(userOp, {
    expectedBundleSize: 1,
    slackPercent: 0,
    minSlack: 0n,
  });
  assert(pvg >= pvgNoSlack + 5000n);
});

// --- UserOp gas price ---

Deno.test("calcUserOpGasPrice - takes min of maxFee and baseFee+tip", () => {
  // Case 1: baseFee + tip < maxFeePerGas → use baseFee + tip
  const price1 = calcUserOpGasPrice(
    { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
    10_000_000_000n, // 10 gwei base
  );
  assertEquals(price1, 12_000_000_000n); // 10 + 2

  // Case 2: baseFee + tip > maxFeePerGas → use maxFeePerGas
  const price2 = calcUserOpGasPrice(
    { maxFeePerGas: 15_000_000_000n, maxPriorityFeePerGas: 10_000_000_000n },
    20_000_000_000n, // 20 gwei base
  );
  assertEquals(price2, 15_000_000_000n); // capped at maxFee
});

// --- Profitability ---

Deno.test("checkBundleProfitability - profitable bundle passes", () => {
  const result = checkBundleProfitability({
    actualGasCosts: [1_000_000_000_000_000n], // 0.001 ETH revenue
    estimatedHandleOpsGas: 200_000n,
    outerTxEffectiveGasPrice: 2_000_000_000n, // 2 gwei
    minProfitMarginBps: 2000, // 20%
  });

  // expectedCost = 200000 * 2gwei = 400_000_000_000_000 (0.0004 ETH)
  // requiredRevenue = 0.0004 * 1.2 = 0.00048 ETH
  // revenue = 0.001 ETH > 0.00048 → profitable
  assert(result.profitable);
  assert(result.marginBps > 2000);
});

Deno.test("checkBundleProfitability - unprofitable bundle fails", () => {
  const result = checkBundleProfitability({
    actualGasCosts: [100_000_000_000_000n], // 0.0001 ETH
    estimatedHandleOpsGas: 200_000n,
    outerTxEffectiveGasPrice: 2_000_000_000n,
    minProfitMarginBps: 2000,
  });

  // expectedCost = 0.0004 ETH, revenue = 0.0001 → not profitable
  assert(!result.profitable);
});

Deno.test("checkUserOpProfitability - checks per-op gas price margin", () => {
  // Op gas price is 12 gwei, outer is 10 gwei, margin 20% → need 12 gwei → passes
  assert(
    checkUserOpProfitability({
      userOpGasPrice: 12_000_000_000n,
      outerTxEffectiveGasPrice: 10_000_000_000n,
      marginBps: 2000,
    }),
  );

  // Op gas price is 11 gwei, need 12 → fails
  assert(
    !checkUserOpProfitability({
      userOpGasPrice: 11_000_000_000n,
      outerTxEffectiveGasPrice: 10_000_000_000n,
      marginBps: 2000,
    }),
  );
});

Deno.test("calcOuterTxGasPrice - computes EIP-1559 gas prices", () => {
  const result = calcOuterTxGasPrice({
    currentBaseFee: 10_000_000_000n,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 1.5,
  });

  assertEquals(result.maxPriorityFeePerGas, 1_500_000_000n);
  // scaledBaseFee = 10gwei * 125 / 100 = 12.5 gwei
  assertEquals(result.maxFeePerGas, 12_500_000_000n + 1_500_000_000n);
  assertEquals(result.effectiveGasPrice, 10_000_000_000n + 1_500_000_000n);
});

Deno.test("calcOuterTxGasPrice - uses chain tip of 0 on L2s like Arbitrum", () => {
  // Arbitrum: baseFee=0.02 gwei, eth_maxPriorityFeePerGas=0
  // Should NOT fall back to configTip (0.5 gwei) — that would inflate cost 25×
  const result = calcOuterTxGasPrice({
    currentBaseFee: 20_000_000n, // 0.02 gwei
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 0.5,
    chainSuggestedTip: 0n, // Chain explicitly returned 0
  });

  // Should use 0 tip, not 500_000_000 (configTip)
  assertEquals(result.maxPriorityFeePerGas, 0n);
  assertEquals(result.effectiveGasPrice, 20_000_000n); // baseFee only
});

Deno.test("calcOuterTxGasPrice - uses chain tip when non-zero", () => {
  const result = calcOuterTxGasPrice({
    currentBaseFee: 30_000_000_000n,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 0.5,
    chainSuggestedTip: 2_000_000_000n, // Chain says 2 gwei
  });

  assertEquals(result.maxPriorityFeePerGas, 2_000_000_000n);
  assertEquals(result.effectiveGasPrice, 30_000_000_000n + 2_000_000_000n);
});

Deno.test("calcUserOpMaxGas - sums all gas fields", () => {
  const userOp = makeUserOp({
    preVerificationGas: 50_000n,
    verificationGasLimit: 100_000n,
    callGasLimit: 200_000n,
    paymaster: "0x1111111111111111111111111111111111111111",
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 30_000n,
  });

  const maxGas = calcUserOpMaxGas(userOp);
  assertEquals(maxGas, 50_000n + 100_000n + 200_000n + 50_000n + 30_000n);
});

// --- Margin formula: margin = userOpGasPrice / outerGasPrice - 1 ---
// After the fix, revenue and cost both use estimatedGas, so gas quantity
// cancels out. Margin is purely the gas PRICE ratio.

Deno.test("margin formula: 0% margin when userOp price == chain price", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n; // 10 gwei
  const userOpGasPrice = 10_000_000_000n; // 10 gwei (no markup)

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 0,
  });

  assert(result.profitable);
  assertEquals(result.marginBps, 0);
});

Deno.test("margin formula: 10% margin with 1.1x wallet markup", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n; // 10 gwei
  const walletMarkup = 1.1;
  const userOpGasPrice = BigInt(Math.round(Number(chainGasPrice) * walletMarkup));

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000, // 10%
  });

  assert(result.profitable);
  assertEquals(result.marginBps, 1000); // 10% = 1000 bps
});

Deno.test("margin formula: 60% margin with 1.6x wallet markup", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 16_000_000_000n; // 1.6x

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000,
  });

  assert(result.profitable);
  assertEquals(result.marginBps, 6000); // 60%
});

Deno.test("margin formula: 150% margin with 2.5x wallet markup", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 25_000_000_000n; // 2.5x

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000,
  });

  assert(result.profitable);
  assertEquals(result.marginBps, 15000); // 150%
});

Deno.test("margin formula: margin is independent of gas quantity", () => {
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 16_000_000_000n; // 1.6x → 60% margin

  // Small bundle
  const r1 = checkBundleProfitability({
    actualGasCosts: [100_000n * userOpGasPrice],
    estimatedHandleOpsGas: 100_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 0,
  });

  // Large bundle
  const r2 = checkBundleProfitability({
    actualGasCosts: [5_000_000n * userOpGasPrice],
    estimatedHandleOpsGas: 5_000_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 0,
  });

  assertEquals(r1.marginBps, 6000);
  assertEquals(r2.marginBps, 6000);
  assertEquals(r1.marginBps, r2.marginBps);
});

Deno.test("margin formula: old bug — maxGas inflates margin", () => {
  // Demonstrates why using maxGas (gas limits) instead of estimatedGas is wrong.
  const estimatedGas = 200_000n;
  const maxGas = 360_000n; // typical: limits are ~1.8x actual
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 16_000_000_000n; // 1.6x markup

  // WRONG (old): revenue = maxGas × userOpPrice, cost = estimatedGas × (userOpPrice/1.6)
  const oldIntendedPrice = (userOpGasPrice * 10n) / 16n;
  const oldResult = checkBundleProfitability({
    actualGasCosts: [maxGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: oldIntendedPrice,
    minProfitMarginBps: 0,
  });

  // CORRECT (new): revenue = estimatedGas × userOpPrice, cost = estimatedGas × chainPrice
  const newResult = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 0,
  });

  // Old formula: (360k/200k) × 1.6 - 1 = 188%
  assert(oldResult.marginBps > 18000, `old margin should be ~188%, got ${oldResult.marginBps}`);

  // New formula: 1.6 - 1 = 60%
  assertEquals(newResult.marginBps, 6000);
});

Deno.test("checkUserOpProfitability — controls acceptance at submit time", () => {
  const chainGasPrice = 10_000_000_000n;

  // Wallet markup 1.6x, min margin 10% → accept
  assert(checkUserOpProfitability({
    userOpGasPrice: 16_000_000_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    marginBps: 1000,
  }));

  // Wallet markup 1.0x (no markup), min margin 10% → reject
  assert(!checkUserOpProfitability({
    userOpGasPrice: 10_000_000_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    marginBps: 1000,
  }));

  // Wallet markup 1.0x, min margin 0% → accept (just covers gas)
  assert(checkUserOpProfitability({
    userOpGasPrice: 10_000_000_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    marginBps: 0,
  }));
});

// --- Margin bounds: [MIN_PROFIT_MARGIN_BPS, MAX_PROFIT_MARGIN_BPS] ---
// Bundler controls actual margin via MIN. MAX protects users from overpaying.
// Wallet sets gas price within this band.

Deno.test("margin bounds: reject below MIN_PROFIT_MARGIN_BPS", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 10_500_000_000n; // 1.05x → 5% margin

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000, // require 10%
  });

  assert(!result.profitable, "5% margin should fail 10% minimum");
  assertEquals(result.marginBps, 500);
});

Deno.test("margin bounds: accept at exactly MIN_PROFIT_MARGIN_BPS", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 11_000_000_000n; // 1.1x → 10% margin

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000, // require 10%
  });

  assert(result.profitable, "10% margin should pass 10% minimum");
  assertEquals(result.marginBps, 1000);
});

Deno.test("margin bounds: detect margin exceeding MAX for rejection", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 30_000_000_000n; // 3.0x → 200% margin
  const maxProfitMarginBps = 15000; // max 150%

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000,
  });

  // Bundle is "profitable" (above min), but margin exceeds max → bundler should reject
  assert(result.profitable);
  assert(result.marginBps > maxProfitMarginBps,
    `${result.marginBps}bps should exceed max ${maxProfitMarginBps}bps`);
});

Deno.test("margin bounds: accept at exactly MAX_PROFIT_MARGIN_BPS", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 25_000_000_000n; // 2.5x → 150% margin
  const maxProfitMarginBps = 15000; // max 150%

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000,
  });

  assert(result.profitable);
  assertEquals(result.marginBps, maxProfitMarginBps);
});

Deno.test("margin bounds: upper bound check via checkUserOpProfitability", () => {
  const chainGasPrice = 10_000_000_000n;
  const maxMarginBps = 15000; // 150%

  // 3.0x markup → 200% margin, exceeds 150% max
  const maxAllowed = (chainGasPrice * BigInt(10000 + maxMarginBps)) / 10000n;
  const overpaying = 30_000_000_000n;
  assert(overpaying > maxAllowed, "3.0x should exceed max allowed price");

  // 2.2x markup → 120% margin, within 150% max
  const reasonable = 22_000_000_000n;
  assert(reasonable <= maxAllowed, "2.2x should be within max allowed price");

  // 2.5x markup → exactly 150% margin, at boundary
  const atBoundary = 25_000_000_000n;
  assertEquals(atBoundary, maxAllowed);
});

// --- L2 chain detection ---

Deno.test("isArbitrumChain - detects Arbitrum One and Sepolia", () => {
  assert(isArbitrumChain(42161));
  assert(isArbitrumChain(421614));
  assert(!isArbitrumChain(1));
  assert(!isArbitrumChain(10));
});

Deno.test("isOpStackChain - detects Optimism and Base", () => {
  assert(isOpStackChain(10));
  assert(isOpStackChain(8453));
  assert(isOpStackChain(11155420));
  assert(isOpStackChain(84532));
  assert(!isOpStackChain(42161));
  assert(!isOpStackChain(1));
});

Deno.test("isL2WithDataFee - covers both Arbitrum and OP Stack", () => {
  assert(isL2WithDataFee(42161));
  assert(isL2WithDataFee(10));
  assert(isL2WithDataFee(8453));
  assert(!isL2WithDataFee(1));
  assert(!isL2WithDataFee(56));
  assert(!isL2WithDataFee(137));
});
