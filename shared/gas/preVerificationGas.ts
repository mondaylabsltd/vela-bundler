/**
 * Dynamic preVerificationGas calculation.
 *
 * preVerificationGas covers costs the bundler pays that are NOT accounted for
 * by the EntryPoint's on-chain gas metering: calldata cost, tx base cost share,
 * and overhead.
 */

import type { UserOperation } from "../userop/types.ts";
import { packUserOp } from "../userop/pack.ts";
import { encodeHandleOps } from "../userop/encode.ts";
import { calldataGasCost } from "../utils/hex.ts";
import { PRE_VERIFICATION_OVERHEAD_GAS, TRANSACTION_BASE_COST } from "../contracts/entrypoint.ts";

export interface PreVerificationGasContext {
  /** Expected number of UserOps per bundle (for splitting tx base cost). */
  expectedBundleSize: number;
  /** Chain-specific L2 data fee in gas units, if applicable (e.g. Optimism, Arbitrum). */
  l2DataFeeGas?: bigint;
  /** Whether to add EIP-7623 calldata floor adjustment. */
  eip7623Enabled?: boolean;
  /** Number of EIP-7702 authorization tuples in this UserOp. */
  eip7702AuthCount?: number;
  /** Slack percentage (default 10 = 10%). */
  slackPercent?: number;
  /** Minimum slack in gas units (default 5000). */
  minSlack?: bigint;
}

/** Gas cost per EIP-7702 authorization tuple. */
const EIP7702_AUTH_GAS = 25_000n;

/** Static EntryPoint accounting overhead (warm/cold storage, event emission, etc). */
const ENTRYPOINT_OVERHEAD_GAS = 10_000n;

/** Memory expansion slack. */
const MEMORY_EXPANSION_GAS = 3_000n;

/**
 * Calculate preVerificationGas dynamically based on the UserOperation contents.
 *
 * This is NOT a fixed constant. It accounts for:
 * 1. Calldata gas (4 per zero byte, 16 per non-zero byte)
 * 2. Share of tx base cost (21000 / bundleSize)
 * 3. PRE_VERIFICATION_OVERHEAD_GAS (50000 lower-bound policy)
 * 4. Static EntryPoint accounting overhead
 * 5. Memory expansion slack
 * 6. EIP-7702 authorization cost (25000 per auth tuple)
 * 7. EIP-7623 calldata floor adjustment if enabled
 * 8. L2 data fee equivalent if provided
 * 9. Configurable slack (default 10%, minimum 5000 gas)
 */
export function calcPreVerificationGas(
  userOp: UserOperation,
  context: PreVerificationGasContext,
): bigint {
  const {
    expectedBundleSize,
    l2DataFeeGas,
    eip7623Enabled,
    eip7702AuthCount,
    slackPercent = 10,
    minSlack = 5000n,
  } = context;

  // 1. Encode the UserOp as it would appear in handleOps calldata
  const packed = packUserOp(userOp);
  const handleOpsCalldata = encodeHandleOps([packed], "0x0000000000000000000000000000000000000001");
  const calldataGas = calldataGasCost(handleOpsCalldata);

  // 2. Base transaction cost share
  const bundleSize = BigInt(Math.max(expectedBundleSize, 1));
  const txBaseCostShare = (TRANSACTION_BASE_COST + bundleSize - 1n) / bundleSize;

  // 3. PRE_VERIFICATION_OVERHEAD_GAS (required lower-bound policy = 50000)
  const overheadGas = PRE_VERIFICATION_OVERHEAD_GAS;

  // 4. Static EntryPoint overhead
  const epOverhead = ENTRYPOINT_OVERHEAD_GAS;

  // 5. Memory expansion
  const memExpansion = MEMORY_EXPANSION_GAS;

  // 6. EIP-7702 authorization cost
  const authCount = BigInt(eip7702AuthCount ?? userOp.eip7702Auth?.length ?? 0);
  const authGas = authCount * EIP7702_AUTH_GAS;

  // Sum up base gas
  let total = calldataGas + txBaseCostShare + overheadGas + epOverhead + memExpansion + authGas;

  // 7. EIP-7623 calldata floor adjustment
  if (eip7623Enabled) {
    // Under EIP-7623, calldata-heavy transactions have a floor cost.
    // calldataFloor = 21000 + zeroBytes * 12 + nonZeroBytes * 48
    // If the floor exceeds normal execution cost, the difference is additional cost.
    // For bundler purposes, we add a conservative 20% buffer on calldata gas.
    total += calldataGas / 5n;
  }

  // 8. L2 data fee
  if (l2DataFeeGas && l2DataFeeGas > 0n) {
    total += l2DataFeeGas;
  }

  // 9. Configurable slack
  const slackFromPercent = (total * BigInt(slackPercent)) / 100n;
  const slack = slackFromPercent > minSlack ? slackFromPercent : minSlack;
  total += slack;

  return total;
}
