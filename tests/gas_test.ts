/**
 * Unit tests for gas calculation and profitability.
 */

import { it, expect } from "vitest";
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

it("calldataGasCost - zero bytes cost 4 gas each", () => {
  const cost = calldataGasCost("0x0000");
  expect(cost).toEqual(8n); // 2 zero bytes * 4
});

it("calldataGasCost - non-zero bytes cost 16 gas each", () => {
  const cost = calldataGasCost("0xffff");
  expect(cost).toEqual(32n); // 2 non-zero bytes * 16
});

it("calldataGasCost - mixed bytes", () => {
  const cost = calldataGasCost("0x00ff00ff");
  expect(cost).toEqual(40n); // 2*4 + 2*16 = 8 + 32
});

it("countCalldataBytes - counts correctly", () => {
  const { zeroBytes, nonZeroBytes } = countCalldataBytes("0x00ff0011");
  expect(zeroBytes).toEqual(2); // 0x00 and the first byte of 0x00
  expect(nonZeroBytes).toEqual(2); // 0xff and 0x11
});

// --- preVerificationGas ---

it("calcPreVerificationGas - returns a positive bigint", () => {
  const userOp = makeUserOp();
  const pvg = calcPreVerificationGas(userOp, { expectedBundleSize: 1 });
  expect(pvg > 0n).toBeTruthy();
});

it("calcPreVerificationGas - larger calldata costs more", () => {
  const smallOp = makeUserOp({ callData: "0xdeadbeef" });
  const largeOp = makeUserOp({
    callData: ("0x" + "ff".repeat(1000)) as `0x${string}`,
  });

  const smallPvg = calcPreVerificationGas(smallOp, { expectedBundleSize: 1 });
  const largePvg = calcPreVerificationGas(largeOp, { expectedBundleSize: 1 });

  expect(largePvg > smallPvg, "Larger calldata should have higher preVerificationGas").toBeTruthy();
});

it("calcPreVerificationGas - larger bundle size reduces base cost share", () => {
  const userOp = makeUserOp();
  const pvg1 = calcPreVerificationGas(userOp, { expectedBundleSize: 1 });
  const pvg10 = calcPreVerificationGas(userOp, { expectedBundleSize: 10 });

  expect(pvg1 > pvg10, "Single-op bundle should have higher preVerificationGas than 10-op bundle").toBeTruthy();
});

it("calcPreVerificationGas - EIP-7702 auth adds gas", () => {
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

  expect(pvgWithAuth - pvgNoAuth).toEqual(50_000n); // 2 * 25000
});

it("calcPreVerificationGas - l2DataFeeGas is added to total", () => {
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
  expect(pvgWith - pvgWithout).toEqual(l2Fee);
});

it("calcPreVerificationGas - l2DataFeeGas zero/undefined has no effect", () => {
  const userOp = makeUserOp();
  const ctx = { expectedBundleSize: 1, slackPercent: 0, minSlack: 0n };
  const pvgNone = calcPreVerificationGas(userOp, ctx);
  const pvgZero = calcPreVerificationGas(userOp, { ...ctx, l2DataFeeGas: 0n });
  const pvgUndef = calcPreVerificationGas(userOp, { ...ctx, l2DataFeeGas: undefined });
  expect(pvgNone).toEqual(pvgZero);
  expect(pvgNone).toEqual(pvgUndef);
});

it("calcPreVerificationGas - minimum slack applied", () => {
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
  expect(pvg >= pvgNoSlack + 5000n).toBeTruthy();
});

// --- UserOp gas price ---

it("calcUserOpGasPrice - takes min of maxFee and baseFee+tip", () => {
  // Case 1: baseFee + tip < maxFeePerGas → use baseFee + tip
  const price1 = calcUserOpGasPrice(
    { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
    10_000_000_000n, // 10 gwei base
  );
  expect(price1).toEqual(12_000_000_000n); // 10 + 2

  // Case 2: baseFee + tip > maxFeePerGas → use maxFeePerGas
  const price2 = calcUserOpGasPrice(
    { maxFeePerGas: 15_000_000_000n, maxPriorityFeePerGas: 10_000_000_000n },
    20_000_000_000n, // 20 gwei base
  );
  expect(price2).toEqual(15_000_000_000n); // capped at maxFee
});

// --- Profitability ---

it("checkBundleProfitability - profitable bundle passes", () => {
  const result = checkBundleProfitability({
    actualGasCosts: [1_000_000_000_000_000n], // 0.001 ETH revenue
    estimatedHandleOpsGas: 200_000n,
    outerTxEffectiveGasPrice: 2_000_000_000n, // 2 gwei
    minProfitMarginBps: 2000, // 20%
  });

  // expectedCost = 200000 * 2gwei = 400_000_000_000_000 (0.0004 ETH)
  // requiredRevenue = 0.0004 * 1.2 = 0.00048 ETH
  // revenue = 0.001 ETH > 0.00048 → profitable
  expect(result.profitable).toBeTruthy();
  expect(result.marginBps > 2000).toBeTruthy();
});

it("checkBundleProfitability - unprofitable bundle fails", () => {
  const result = checkBundleProfitability({
    actualGasCosts: [100_000_000_000_000n], // 0.0001 ETH
    estimatedHandleOpsGas: 200_000n,
    outerTxEffectiveGasPrice: 2_000_000_000n,
    minProfitMarginBps: 2000,
  });

  // expectedCost = 0.0004 ETH, revenue = 0.0001 → not profitable
  expect(!result.profitable).toBeTruthy();
});

it("checkUserOpProfitability - checks per-op gas price margin", () => {
  // Op gas price is 12 gwei, outer is 10 gwei, margin 20% → need 12 gwei → passes
  expect(
    checkUserOpProfitability({
      userOpGasPrice: 12_000_000_000n,
      outerTxEffectiveGasPrice: 10_000_000_000n,
      marginBps: 2000,
    }),
  ).toBeTruthy();

  // Op gas price is 11 gwei, need 12 → fails
  expect(
    !checkUserOpProfitability({
      userOpGasPrice: 11_000_000_000n,
      outerTxEffectiveGasPrice: 10_000_000_000n,
      marginBps: 2000,
    }),
  ).toBeTruthy();
});

it("calcOuterTxGasPrice - computes EIP-1559 gas prices", () => {
  const result = calcOuterTxGasPrice({
    currentBaseFee: 10_000_000_000n,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 1.5,
  });

  expect(result.maxPriorityFeePerGas).toEqual(1_500_000_000n);
  // scaledBaseFee = 10gwei * 125 / 100 = 12.5 gwei
  expect(result.maxFeePerGas).toEqual(12_500_000_000n + 1_500_000_000n);
  expect(result.effectiveGasPrice).toEqual(10_000_000_000n + 1_500_000_000n);
});

it("calcOuterTxGasPrice - uses chain tip of 0 on L2s like Arbitrum", () => {
  // Arbitrum: baseFee=0.02 gwei, eth_maxPriorityFeePerGas=0
  // Should NOT fall back to configTip (0.5 gwei) — that would inflate cost 25×
  const result = calcOuterTxGasPrice({
    currentBaseFee: 20_000_000n, // 0.02 gwei
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 0.5,
    chainSuggestedTip: 0n, // Chain explicitly returned 0
  });

  // Should use 0 tip, not 500_000_000 (configTip)
  expect(result.maxPriorityFeePerGas).toEqual(0n);
  expect(result.effectiveGasPrice).toEqual(20_000_000n); // baseFee only
});

it("calcOuterTxGasPrice - uses chain tip when non-zero", () => {
  const result = calcOuterTxGasPrice({
    currentBaseFee: 30_000_000_000n,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 0.5,
    chainSuggestedTip: 2_000_000_000n, // Chain says 2 gwei
  });

  expect(result.maxPriorityFeePerGas).toEqual(2_000_000_000n);
  expect(result.effectiveGasPrice).toEqual(30_000_000_000n + 2_000_000_000n);
});

it("calcUserOpMaxGas - sums all gas fields", () => {
  const userOp = makeUserOp({
    preVerificationGas: 50_000n,
    verificationGasLimit: 100_000n,
    callGasLimit: 200_000n,
    paymaster: "0x1111111111111111111111111111111111111111",
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 30_000n,
  });

  const maxGas = calcUserOpMaxGas(userOp);
  expect(maxGas).toEqual(50_000n + 100_000n + 200_000n + 50_000n + 30_000n);
});

// --- Margin formula: margin = userOpGasPrice / outerGasPrice - 1 ---
// After the fix, revenue and cost both use estimatedGas, so gas quantity
// cancels out. Margin is purely the gas PRICE ratio.

it("margin formula: 0% margin when userOp price == chain price", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n; // 10 gwei
  const userOpGasPrice = 10_000_000_000n; // 10 gwei (no markup)

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 0,
  });

  expect(result.profitable).toBeTruthy();
  expect(result.marginBps).toEqual(0);
});

it("margin formula: 10% margin with 1.1x wallet markup", () => {
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

  expect(result.profitable).toBeTruthy();
  expect(result.marginBps).toEqual(1000); // 10% = 1000 bps
});

it("margin formula: 60% margin with 1.6x wallet markup", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 16_000_000_000n; // 1.6x

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000,
  });

  expect(result.profitable).toBeTruthy();
  expect(result.marginBps).toEqual(6000); // 60%
});

it("margin formula: 150% margin with 2.5x wallet markup", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 25_000_000_000n; // 2.5x

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000,
  });

  expect(result.profitable).toBeTruthy();
  expect(result.marginBps).toEqual(15000); // 150%
});

it("margin formula: margin is independent of gas quantity", () => {
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

  expect(r1.marginBps).toEqual(6000);
  expect(r2.marginBps).toEqual(6000);
  expect(r1.marginBps).toEqual(r2.marginBps);
});

it("margin formula: old bug — maxGas inflates margin", () => {
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
  expect(oldResult.marginBps > 18000, `old margin should be ~188%, got ${oldResult.marginBps}`).toBeTruthy();

  // New formula: 1.6 - 1 = 60%
  expect(newResult.marginBps).toEqual(6000);
});

it("checkUserOpProfitability — controls acceptance at submit time", () => {
  const chainGasPrice = 10_000_000_000n;

  // Wallet markup 1.6x, min margin 10% → accept
  expect(checkUserOpProfitability({
    userOpGasPrice: 16_000_000_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    marginBps: 1000,
  })).toBeTruthy();

  // Wallet markup 1.0x (no markup), min margin 10% → reject
  expect(!checkUserOpProfitability({
    userOpGasPrice: 10_000_000_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    marginBps: 1000,
  })).toBeTruthy();

  // Wallet markup 1.0x, min margin 0% → accept (just covers gas)
  expect(checkUserOpProfitability({
    userOpGasPrice: 10_000_000_000n,
    outerTxEffectiveGasPrice: chainGasPrice,
    marginBps: 0,
  })).toBeTruthy();
});

// --- Margin bounds: [MIN_PROFIT_MARGIN_BPS, MAX_PROFIT_MARGIN_BPS] ---
// Bundler controls actual margin via MIN. MAX protects users from overpaying.
// Wallet sets gas price within this band.

it("margin bounds: reject below MIN_PROFIT_MARGIN_BPS", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 10_500_000_000n; // 1.05x → 5% margin

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000, // require 10%
  });

  expect(!result.profitable, "5% margin should fail 10% minimum").toBeTruthy();
  expect(result.marginBps).toEqual(500);
});

it("margin bounds: accept at exactly MIN_PROFIT_MARGIN_BPS", () => {
  const estimatedGas = 200_000n;
  const chainGasPrice = 10_000_000_000n;
  const userOpGasPrice = 11_000_000_000n; // 1.1x → 10% margin

  const result = checkBundleProfitability({
    actualGasCosts: [estimatedGas * userOpGasPrice],
    estimatedHandleOpsGas: estimatedGas,
    outerTxEffectiveGasPrice: chainGasPrice,
    minProfitMarginBps: 1000, // require 10%
  });

  expect(result.profitable, "10% margin should pass 10% minimum").toBeTruthy();
  expect(result.marginBps).toEqual(1000);
});

it("margin bounds: detect margin exceeding MAX for rejection", () => {
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
  expect(result.profitable).toBeTruthy();
  expect(result.marginBps > maxProfitMarginBps,
    `${result.marginBps}bps should exceed max ${maxProfitMarginBps}bps`).toBeTruthy();
});

it("margin bounds: accept at exactly MAX_PROFIT_MARGIN_BPS", () => {
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

  expect(result.profitable).toBeTruthy();
  expect(result.marginBps).toEqual(maxProfitMarginBps);
});

it("margin bounds: upper bound check via checkUserOpProfitability", () => {
  const chainGasPrice = 10_000_000_000n;
  const maxMarginBps = 15000; // 150%

  // 3.0x markup → 200% margin, exceeds 150% max
  const maxAllowed = (chainGasPrice * BigInt(10000 + maxMarginBps)) / 10000n;
  const overpaying = 30_000_000_000n;
  expect(overpaying > maxAllowed, "3.0x should exceed max allowed price").toBeTruthy();

  // 2.2x markup → 120% margin, within 150% max
  const reasonable = 22_000_000_000n;
  expect(reasonable <= maxAllowed, "2.2x should be within max allowed price").toBeTruthy();

  // 2.5x markup → exactly 150% margin, at boundary
  const atBoundary = 25_000_000_000n;
  expect(atBoundary).toEqual(maxAllowed);
});

// --- L2 chain detection ---

it("isArbitrumChain - detects Arbitrum One and Sepolia", () => {
  expect(isArbitrumChain(42161)).toBeTruthy();
  expect(isArbitrumChain(421614)).toBeTruthy();
  expect(!isArbitrumChain(1)).toBeTruthy();
  expect(!isArbitrumChain(10)).toBeTruthy();
});

it("isOpStackChain - detects Optimism and Base", () => {
  expect(isOpStackChain(10)).toBeTruthy();
  expect(isOpStackChain(8453)).toBeTruthy();
  expect(isOpStackChain(11155420)).toBeTruthy();
  expect(isOpStackChain(84532)).toBeTruthy();
  expect(!isOpStackChain(42161)).toBeTruthy();
  expect(!isOpStackChain(1)).toBeTruthy();
});

it("isL2WithDataFee - covers both Arbitrum and OP Stack", () => {
  expect(isL2WithDataFee(42161)).toBeTruthy();
  expect(isL2WithDataFee(10)).toBeTruthy();
  expect(isL2WithDataFee(8453)).toBeTruthy();
  expect(!isL2WithDataFee(1)).toBeTruthy();
  expect(!isL2WithDataFee(56)).toBeTruthy();
  expect(!isL2WithDataFee(137)).toBeTruthy();
});
