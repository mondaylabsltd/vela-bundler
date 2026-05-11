/**
 * Encode handleOps calldata for EntryPoint v0.7.
 */

import { encodeFunctionData } from "viem";
import { ENTRYPOINT_V07_ABI } from "../contracts/entrypoint.ts";
import type { PackedUserOperation } from "./types.ts";

/**
 * Encode handleOps(ops, beneficiary) calldata.
 */
export function encodeHandleOps(
  ops: PackedUserOperation[],
  beneficiary: `0x${string}`,
): `0x${string}` {
  return encodeFunctionData({
    abi: ENTRYPOINT_V07_ABI,
    functionName: "handleOps",
    args: [
      ops.map((op) => ({
        sender: op.sender,
        nonce: op.nonce,
        initCode: op.initCode,
        callData: op.callData,
        accountGasLimits: op.accountGasLimits,
        preVerificationGas: op.preVerificationGas,
        gasFees: op.gasFees,
        paymasterAndData: op.paymasterAndData,
        signature: op.signature,
      })),
      beneficiary,
    ],
  });
}
