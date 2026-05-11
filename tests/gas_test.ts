/**
 * Unit tests for gas calculation and profitability.
 */

import { assertEquals, assert } from "@std/assert";
import { calcPreVerificationGas } from "../src/gas/preVerificationGas.ts";
import {
  calcUserOpGasPrice,
  checkBundleProfitability,
  checkUserOpProfitability,
  calcOuterTxGasPrice,
  calcUserOpMaxGas,
} from "../src/gas/profitability.ts";
import { calldataGasCost, countCalldataBytes } from "../src/utils/hex.ts";
import type { UserOperation } from "../src/userop/types.ts";

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
