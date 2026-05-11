/**
 * Normalize incoming RPC UserOperation parameters into typed UserOperation.
 */

import type { UserOperation } from "./types.ts";
import { UserOpValidationError } from "./validate.ts";

/**
 * Normalize a JSON-RPC UserOperation object into our internal UserOperation type.
 * Accepts hex string fields as per ERC-7769.
 */
// deno-lint-ignore no-explicit-any
export function normalizeUserOp(raw: any): UserOperation {
  if (!raw || typeof raw !== "object") {
    throw new UserOpValidationError("UserOperation must be an object");
  }

  return {
    sender: requireAddress(raw.sender, "sender"),
    nonce: requireBigInt(raw.nonce, "nonce"),
    factory: optionalAddress(raw.factory),
    factoryData: optionalHex(raw.factoryData),
    callData: requireHex(raw.callData, "callData"),
    callGasLimit: requireBigInt(raw.callGasLimit, "callGasLimit"),
    verificationGasLimit: requireBigInt(raw.verificationGasLimit, "verificationGasLimit"),
    preVerificationGas: requireBigInt(raw.preVerificationGas, "preVerificationGas"),
    maxFeePerGas: requireBigInt(raw.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: requireBigInt(raw.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    paymaster: optionalAddress(raw.paymaster),
    paymasterVerificationGasLimit: optionalBigInt(raw.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: optionalBigInt(raw.paymasterPostOpGasLimit),
    paymasterData: optionalHex(raw.paymasterData),
    signature: requireHex(raw.signature, "signature"),
    eip7702Auth: raw.eip7702Auth ?? undefined,
  };
}

function requireAddress(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/i.test(value)) {
    throw new UserOpValidationError(`${field} must be a valid address`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function optionalAddress(value: unknown): `0x${string}` | null {
  if (value === null || value === undefined || value === "" || value === "0x") return null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/i.test(value)) return null;
  const lower = value.toLowerCase();
  if (lower === "0x0000000000000000000000000000000000000000") return null;
  return lower as `0x${string}`;
}

function requireHex(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new UserOpValidationError(`${field} must be a hex string`);
  }
  return value as `0x${string}`;
}

function optionalHex(value: unknown): `0x${string}` | null {
  if (value === null || value === undefined || value === "" || value === "0x") return null;
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  return value as `0x${string}`;
}

function requireBigInt(value: unknown, field: string): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value);
    throw new Error("not a number");
  } catch {
    throw new UserOpValidationError(`${field} must be a valid integer (hex or decimal)`);
  }
}

function optionalBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value);
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize a UserOperation back to JSON-RPC hex format.
 */
export function userOpToRpc(userOp: UserOperation): Record<string, unknown> {
  return {
    sender: userOp.sender,
    nonce: "0x" + userOp.nonce.toString(16),
    factory: userOp.factory,
    factoryData: userOp.factoryData,
    callData: userOp.callData,
    callGasLimit: "0x" + userOp.callGasLimit.toString(16),
    verificationGasLimit: "0x" + userOp.verificationGasLimit.toString(16),
    preVerificationGas: "0x" + userOp.preVerificationGas.toString(16),
    maxFeePerGas: "0x" + userOp.maxFeePerGas.toString(16),
    maxPriorityFeePerGas: "0x" + userOp.maxPriorityFeePerGas.toString(16),
    paymaster: userOp.paymaster,
    paymasterVerificationGasLimit: userOp.paymasterVerificationGasLimit !== null
      ? "0x" + userOp.paymasterVerificationGasLimit.toString(16)
      : null,
    paymasterPostOpGasLimit: userOp.paymasterPostOpGasLimit !== null
      ? "0x" + userOp.paymasterPostOpGasLimit.toString(16)
      : null,
    paymasterData: userOp.paymasterData,
    signature: userOp.signature,
  };
}
