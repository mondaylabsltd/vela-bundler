/**
 * Profitability checks for bundles and individual UserOperations.
 */

import type { UserOperation } from "../userop/types.ts";

/**
 * Calculate the effective gas price a UserOp will pay.
 * userOpGasPrice = min(maxFeePerGas, currentBaseFee + maxPriorityFeePerGas)
 */
export function calcUserOpGasPrice(
  userOp: Pick<UserOperation, "maxFeePerGas" | "maxPriorityFeePerGas">,
  currentBaseFee: bigint,
): bigint {
  const feeWithTip = currentBaseFee + userOp.maxPriorityFeePerGas;
  return userOp.maxFeePerGas < feeWithTip ? userOp.maxFeePerGas : feeWithTip;
}

/**
 * Calculate expected revenue from a set of UserOperationEvent actualGasCost values.
 * Revenue = sum of all actualGasCost from simulated UserOperationEvent logs.
 */
export function calcExpectedRevenue(actualGasCosts: readonly bigint[]): bigint {
  let total = 0n;
  for (const cost of actualGasCosts) {
    total += cost;
  }
  return total;
}

/**
 * Calculate expected cost for the bundler to submit the bundle.
 * expectedCost = estimatedHandleOpsGas * outerTxEffectiveGasPrice
 */
export function calcExpectedCost(
  estimatedHandleOpsGas: bigint,
  outerTxEffectiveGasPrice: bigint,
): bigint {
  return estimatedHandleOpsGas * outerTxEffectiveGasPrice;
}

export interface ProfitabilityResult {
  profitable: boolean;
  expectedRevenue: bigint;
  expectedCost: bigint;
  requiredRevenue: bigint;
  marginBps: number;
}

/**
 * Check whether a bundle meets the minimum profitability margin.
 *
 * requiredRevenue = expectedCost * (10000 + minProfitMarginBps) / 10000
 * Only submit if: expectedRevenue >= requiredRevenue
 */
export function checkBundleProfitability(params: {
  actualGasCosts: readonly bigint[];
  estimatedHandleOpsGas: bigint;
  outerTxEffectiveGasPrice: bigint;
  minProfitMarginBps: number;
}): ProfitabilityResult {
  const {
    actualGasCosts,
    estimatedHandleOpsGas,
    outerTxEffectiveGasPrice,
    minProfitMarginBps,
  } = params;

  const expectedRevenue = calcExpectedRevenue(actualGasCosts);
  const expectedCost = calcExpectedCost(estimatedHandleOpsGas, outerTxEffectiveGasPrice);
  const requiredRevenue =
    (expectedCost * BigInt(10000 + minProfitMarginBps)) / 10000n;

  const profitable = expectedRevenue >= requiredRevenue;

  // Calculate actual margin in BPS
  let marginBps = 0;
  if (expectedCost > 0n) {
    marginBps = Number(
      ((expectedRevenue - expectedCost) * 10000n) / expectedCost,
    );
  }

  return {
    profitable,
    expectedRevenue,
    expectedCost,
    requiredRevenue,
    marginBps,
  };
}

/**
 * Per-UserOp profitability check.
 * Checks: userOpGasPrice >= outerTxEffectiveGasPrice * (10000 + marginBps) / 10000
 */
export function checkUserOpProfitability(params: {
  userOpGasPrice: bigint;
  outerTxEffectiveGasPrice: bigint;
  marginBps: number;
}): boolean {
  const { userOpGasPrice, outerTxEffectiveGasPrice, marginBps } = params;
  const requiredPrice =
    (outerTxEffectiveGasPrice * BigInt(10000 + marginBps)) / 10000n;
  return userOpGasPrice >= requiredPrice;
}

/**
 * Calculate outer transaction gas pricing (EIP-1559).
 */
export function calcOuterTxGasPrice(params: {
  currentBaseFee: bigint;
  baseFeeMultiplier: number;
  bundlerTipGwei: number;
}): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; effectiveGasPrice: bigint } {
  const { currentBaseFee, baseFeeMultiplier, bundlerTipGwei } = params;

  const maxPriorityFeePerGas = BigInt(Math.ceil(bundlerTipGwei * 1e9));
  const scaledBaseFee = (currentBaseFee * BigInt(Math.ceil(baseFeeMultiplier * 100))) / 100n;
  const maxFeePerGas = scaledBaseFee + maxPriorityFeePerGas;

  // Effective gas price for cost estimation = baseFee + tip
  const effectiveGasPrice = currentBaseFee + maxPriorityFeePerGas;

  return { maxFeePerGas, maxPriorityFeePerGas, effectiveGasPrice };
}

/**
 * Calculate total gas a UserOp may use (for bundle gas budget).
 */
export function calcUserOpMaxGas(userOp: UserOperation): bigint {
  let total = userOp.preVerificationGas +
    userOp.verificationGasLimit +
    userOp.callGasLimit;

  if (userOp.paymasterVerificationGasLimit) {
    total += userOp.paymasterVerificationGasLimit;
  }
  if (userOp.paymasterPostOpGasLimit) {
    total += userOp.paymasterPostOpGasLimit;
  }

  return total;
}
