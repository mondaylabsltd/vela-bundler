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

/** Largest value that fits in a packed uint128 slot (accountGasLimits / gasFees / paymaster
 *  limits are each packed into 16 bytes via packUint128). A field at/above this would throw
 *  deep inside packing; we reject it cleanly at validation instead. */
export const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * Validate field-level constraints on a UserOperation before simulation.
 *
 * @param allowZeroFee  In-band settlement chains allow (and expect) maxFeePerGas = 0 — the
 *   EntryPoint's native prefund is a no-op and the bundler is repaid in-band. True on Tempo and on
 *   any chain with inBandEnabled (chainSupportsInBand). See docs/inband-gas-settlement.md.
 * @param raiseVerifCeiling  Raise the verification-gas ceiling for the expensive Safe deploy —
 *   the Tempo ENVELOPE only (isTempoChain), orthogonal to the settlement model.
 */
export function validateUserOpFields(
  userOp: UserOperation,
  allowZeroFee = false,
  raiseVerifCeiling = false,
): void {
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
  const maxVerificationGas = raiseVerifCeiling ? TEMPO_MAX_VERIFICATION_GAS : MAX_VERIFICATION_GAS;
  if (userOp.verificationGasLimit > maxVerificationGas) {
    throw new UserOpValidationError(
      `verificationGasLimit exceeds max (${maxVerificationGas})`,
    );
  }

  // Fee fields
  if (!allowZeroFee && userOp.maxFeePerGas <= 0n) {
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

  // uint128 packing bounds — callGasLimit and the fee fields are each packed into a 16-byte
  // slot; a value ≥ 2^128 would throw inside packUint128 and surface as a generic internal
  // error. Reject cleanly here. (verificationGasLimit is already bounded well under this.)
  if (userOp.callGasLimit > MAX_UINT128) {
    throw new UserOpValidationError("callGasLimit exceeds uint128 range");
  }
  if (userOp.maxFeePerGas > MAX_UINT128) {
    throw new UserOpValidationError("maxFeePerGas exceeds uint128 range");
  }
  if (userOp.maxPriorityFeePerGas > MAX_UINT128) {
    throw new UserOpValidationError("maxPriorityFeePerGas exceeds uint128 range");
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
    if (
      userOp.paymasterPostOpGasLimit !== null &&
      userOp.paymasterPostOpGasLimit !== undefined &&
      userOp.paymasterPostOpGasLimit > MAX_UINT128
    ) {
      throw new UserOpValidationError("paymasterPostOpGasLimit exceeds uint128 range");
    }
  }
}

/**
 * Parse validationData into aggregator, validAfter, validUntil.
 *
 * Canonical ERC-4337 v0.7 packing (EntryPoint `_packValidationData`), LSB-first:
 *   validationData = uint160(aggregator)
 *                  | (uint48(validUntil) << 160)
 *                  | (uint48(validAfter) << 208)
 * where aggregator == address(0) means SUCCESS and aggregator == address(1) means
 * SIG_VALIDATION_FAILED. The aggregator therefore occupies the LOW 160 bits — an earlier
 * revision read it from the high bits, which silently mis-parsed every signature-failure
 * (0x01 → 0x00, read as success) and every time-bounded op (validUntil in the wrong bits).
 */
export function parseValidationData(validationData: bigint): {
  aggregator: `0x${string}`;
  validAfter: number;
  validUntil: number;
} {
  const aggregator = ("0x" +
    (validationData & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")) as `0x${string}`;
  const validUntil = Number((validationData >> 160n) & 0xFFFFFFFFFFFFn);
  const validAfter = Number((validationData >> 208n) & 0xFFFFFFFFFFFFn);

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
