/**
 * Pack and unpack v0.7 UserOperation to/from PackedUserOperation format.
 */

import type { PackedUserOperation, UserOperation } from "./types.ts";
import {
  concat,
  EMPTY_BYTES,
  isEmptyHex,
  packUint128,
  padHex,
  numberToHex,
} from "../utils/hex.ts";

/**
 * Pack a UserOperation into the PackedUserOperation format consumed by EntryPoint v0.7.
 */
export function packUserOp(userOp: UserOperation): PackedUserOperation {
  // initCode = factory + factoryData (or empty)
  let initCode: `0x${string}` = EMPTY_BYTES;
  if (userOp.factory && !isEmptyHex(userOp.factory)) {
    const factoryData = userOp.factoryData ?? EMPTY_BYTES;
    initCode = concat([userOp.factory, factoryData]);
  }

  // accountGasLimits = verificationGasLimit (16 bytes) | callGasLimit (16 bytes)
  const accountGasLimits = packUint128(
    userOp.verificationGasLimit,
    userOp.callGasLimit,
  );

  // gasFees = maxPriorityFeePerGas (16 bytes) | maxFeePerGas (16 bytes)
  const gasFees = packUint128(
    userOp.maxPriorityFeePerGas,
    userOp.maxFeePerGas,
  );

  // paymasterAndData = paymaster (20) + paymasterVerificationGasLimit (16) + paymasterPostOpGasLimit (16) + paymasterData
  let paymasterAndData: `0x${string}` = EMPTY_BYTES;
  if (userOp.paymaster && !isEmptyHex(userOp.paymaster)) {
    const pvgl = padHex(
      numberToHex(userOp.paymasterVerificationGasLimit ?? 0n),
      { size: 16, dir: "left" },
    );
    const ppogl = padHex(
      numberToHex(userOp.paymasterPostOpGasLimit ?? 0n),
      { size: 16, dir: "left" },
    );
    const pmData = userOp.paymasterData ?? EMPTY_BYTES;
    paymasterAndData = concat([userOp.paymaster, pvgl, ppogl, pmData]);
  }

  return {
    sender: userOp.sender,
    nonce: userOp.nonce,
    initCode,
    callData: userOp.callData,
    accountGasLimits,
    preVerificationGas: userOp.preVerificationGas,
    gasFees,
    paymasterAndData,
    signature: userOp.signature,
  };
}

/**
 * Unpack a PackedUserOperation back into a UserOperation.
 */
export function unpackUserOp(packed: PackedUserOperation): UserOperation {
  // initCode
  let factory: `0x${string}` | null = null;
  let factoryData: `0x${string}` | null = null;
  if (!isEmptyHex(packed.initCode) && packed.initCode.length > 2) {
    factory = ("0x" + packed.initCode.slice(2, 42)) as `0x${string}`;
    factoryData = ("0x" + packed.initCode.slice(42)) as `0x${string}`;
    if (factoryData === "0x") factoryData = null;
  }

  // accountGasLimits
  const agl = packed.accountGasLimits.slice(2).padStart(64, "0");
  const verificationGasLimit = BigInt("0x" + agl.slice(0, 32));
  const callGasLimit = BigInt("0x" + agl.slice(32, 64));

  // gasFees
  const gf = packed.gasFees.slice(2).padStart(64, "0");
  const maxPriorityFeePerGas = BigInt("0x" + gf.slice(0, 32));
  const maxFeePerGas = BigInt("0x" + gf.slice(32, 64));

  // paymasterAndData
  let paymaster: `0x${string}` | null = null;
  let paymasterVerificationGasLimit: bigint | null = null;
  let paymasterPostOpGasLimit: bigint | null = null;
  let paymasterData: `0x${string}` | null = null;

  if (!isEmptyHex(packed.paymasterAndData) && packed.paymasterAndData.length > 2) {
    const raw = packed.paymasterAndData.slice(2);
    paymaster = ("0x" + raw.slice(0, 40)) as `0x${string}`;
    paymasterVerificationGasLimit = BigInt("0x" + raw.slice(40, 72));
    paymasterPostOpGasLimit = BigInt("0x" + raw.slice(72, 104));
    const rest = raw.slice(104);
    paymasterData = rest.length > 0 ? ("0x" + rest) as `0x${string}` : null;
  }

  return {
    sender: packed.sender,
    nonce: packed.nonce,
    factory,
    factoryData,
    callData: packed.callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas: packed.preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
    paymasterData,
    signature: packed.signature,
  };
}
