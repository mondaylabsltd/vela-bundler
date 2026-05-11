/**
 * Compute userOpHash for v0.7 PackedUserOperation.
 */

import { encodeAbiParameters, keccak256 } from "viem";
import type { PackedUserOperation } from "./types.ts";

/**
 * Compute the userOpHash as defined by EntryPoint v0.7:
 *   keccak256(abi.encode(
 *     keccak256(packUserOpData(op)),
 *     entryPointAddress,
 *     chainId
 *   ))
 */
export function getUserOpHash(
  packedOp: PackedUserOperation,
  entryPointAddress: `0x${string}`,
  chainId: number,
): `0x${string}` {
  const innerHash = keccak256(encodePackedUserOpForHash(packedOp));

  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
      ],
      [innerHash, entryPointAddress, BigInt(chainId)],
    ),
  );
}

/**
 * Encode the PackedUserOperation for hashing (excludes signature).
 */
function encodePackedUserOpForHash(op: PackedUserOperation): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" }, // keccak256(initCode)
      { type: "bytes32" }, // keccak256(callData)
      { type: "bytes32" }, // accountGasLimits
      { type: "uint256" }, // preVerificationGas
      { type: "bytes32" }, // gasFees
      { type: "bytes32" }, // keccak256(paymasterAndData)
    ],
    [
      op.sender,
      op.nonce,
      keccak256(op.initCode),
      keccak256(op.callData),
      op.accountGasLimits,
      op.preVerificationGas,
      op.gasFees,
      keccak256(op.paymasterAndData),
    ],
  );
}
