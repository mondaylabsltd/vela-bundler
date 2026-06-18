/**
 * UserOperation field validation.
 */

import type { UserOperation } from "./types.ts";
import { MAX_VERIFICATION_GAS, RPC_ERROR_CODES } from "../contracts/entrypoint.ts";
import { isEmptyHex } from "../utils/hex.ts";

export class UserOpValidationError extends Error {
  constructor(
    message: string,
    public readonly code: number = RPC_ERROR_CODES.INVALID_USEROPERATION,
  ) {
    super(message);
    this.name = "UserOpValidationError";
  }
}

/** Tempo's Safe deploy (initCode) is far more expensive to meter than EVM chains —
 *  ~3.9M gas — so it needs a higher verification-gas ceiling than the default 2M. */
export const TEMPO_MAX_VERIFICATION_GAS = 8_000_000n;

/**
 * Validate field-level constraints on a UserOperation before simulation.
 *
 * @param tempo  Tempo chain: maxFeePerGas = 0 is REQUIRED (no native coin — EntryPoint's
 *   native accounting must be a no-op; the bundler's outer 0x76 pays gas in a stablecoin),
 *   and the verification-gas ceiling is raised for the expensive Safe deploy. See
 *   shared/tempo.ts.
 */
export function validateUserOpFields(userOp: UserOperation, tempo = false): void {
  // sender must be a valid address
  if (!userOp.sender || !/^0x[0-9a-fA-F]{40}$/.test(userOp.sender)) {
    throw new UserOpValidationError("invalid sender address");
  }

  // nonce must be non-negative
  if (userOp.nonce < 0n) {
    throw new UserOpValidationError("nonce must be non-negative");
  }

  // callData must be present
  if (!userOp.callData || userOp.callData.length < 2) {
    throw new UserOpValidationError("callData is required");
  }

  // Gas limits must be positive
  if (userOp.callGasLimit <= 0n) {
    throw new UserOpValidationError("callGasLimit must be > 0");
  }
  if (userOp.verificationGasLimit <= 0n) {
    throw new UserOpValidationError("verificationGasLimit must be > 0");
  }
  if (userOp.preVerificationGas <= 0n) {
    throw new UserOpValidationError("preVerificationGas must be > 0");
  }

  // MAX_VERIFICATION_GAS enforcement (raised on Tempo for the costly Safe deploy)
  const maxVerificationGas = tempo ? TEMPO_MAX_VERIFICATION_GAS : MAX_VERIFICATION_GAS;
  if (userOp.verificationGasLimit > maxVerificationGas) {
    throw new UserOpValidationError(
      `verificationGasLimit exceeds max (${maxVerificationGas})`,
    );
  }

  // Fee fields
  if (!tempo && userOp.maxFeePerGas <= 0n) {
    throw new UserOpValidationError("maxFeePerGas must be > 0");
  }
  if (userOp.maxPriorityFeePerGas < 0n) {
    throw new UserOpValidationError("maxPriorityFeePerGas must be >= 0");
  }
  if (userOp.maxPriorityFeePerGas > userOp.maxFeePerGas) {
    throw new UserOpValidationError(
      "maxPriorityFeePerGas must not exceed maxFeePerGas",
    );
  }

  // Signature
  if (!userOp.signature || userOp.signature === "0x") {
    throw new UserOpValidationError("signature is required");
  }

  // Factory consistency
  if (userOp.factory && isEmptyHex(userOp.factory)) {
    throw new UserOpValidationError("factory address is empty");
  }
  if (!userOp.factory && userOp.factoryData && !isEmptyHex(userOp.factoryData)) {
    throw new UserOpValidationError("factoryData without factory");
  }

  // Paymaster consistency
  if (userOp.paymaster && !isEmptyHex(userOp.paymaster)) {
    if (
      userOp.paymasterVerificationGasLimit === null ||
      userOp.paymasterVerificationGasLimit === undefined
    ) {
      throw new UserOpValidationError(
        "paymasterVerificationGasLimit required when paymaster is set",
      );
    }
    if (userOp.paymasterVerificationGasLimit > MAX_VERIFICATION_GAS) {
      throw new UserOpValidationError(
        `paymasterVerificationGasLimit exceeds MAX_VERIFICATION_GAS (${MAX_VERIFICATION_GAS})`,
      );
    }
  }
}

/**
 * Parse validationData into aggregator, validAfter, validUntil.
 * validationData format: 20-byte aggregator | 6-byte validUntil | 6-byte validAfter
 */
export function parseValidationData(validationData: bigint): {
  aggregator: `0x${string}`;
  validAfter: number;
  validUntil: number;
} {
  const aggregator = ("0x" +
    (validationData >> 96n).toString(16).padStart(40, "0")) as `0x${string}`;
  const validUntil = Number((validationData >> 48n) & 0xFFFFFFFFFFFFn);
  const validAfter = Number(validationData & 0xFFFFFFFFFFFFn);

  return {
    aggregator,
    validAfter,
    // 0 means no expiry
    validUntil: validUntil === 0 ? 0xffffffffffff : validUntil,
  };
}

/**
 * Check if validation data times are currently valid with safety margin.
 */
export function isValidTimeRange(
  validAfter: number,
  validUntil: number,
  safetyMarginSec: number = 30,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (validAfter > now + safetyMarginSec) return false;
  if (validUntil !== 0 && validUntil < now + safetyMarginSec) return false;
  return true;
}
