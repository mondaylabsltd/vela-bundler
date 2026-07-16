/**
 * Unit tests for UserOperation packing, hashing, validation, and normalization.
 */

import { it, expect } from "vitest";
import { packUserOp, unpackUserOp } from "../shared/userop/pack.ts";
import { getUserOpHash } from "../shared/userop/hash.ts";
import {
  validateUserOpFields,
  parseValidationData,
  isValidTimeRange,
  UserOpValidationError,
} from "../shared/userop/validate.ts";
import { normalizeUserOp } from "../shared/userop/normalize.ts";
import type { UserOperation } from "../shared/userop/types.ts";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

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
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature:
      "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c",
    ...overrides,
  };
}

// --- Pack / Unpack ---

it("packUserOp and unpackUserOp are inverse operations", () => {
  const userOp = makeUserOp();
  const packed = packUserOp(userOp);
  const unpacked = unpackUserOp(packed);

  expect(unpacked.sender).toEqual(userOp.sender);
  expect(unpacked.nonce).toEqual(userOp.nonce);
  expect(unpacked.callGasLimit).toEqual(userOp.callGasLimit);
  expect(unpacked.verificationGasLimit).toEqual(userOp.verificationGasLimit);
  expect(unpacked.maxFeePerGas).toEqual(userOp.maxFeePerGas);
  expect(unpacked.maxPriorityFeePerGas).toEqual(userOp.maxPriorityFeePerGas);
  expect(unpacked.factory).toEqual(userOp.factory);
  expect(unpacked.paymaster).toEqual(userOp.paymaster);
});

it("packUserOp - packs factory into initCode", () => {
  const userOp = makeUserOp({
    factory: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    factoryData: "0x1234",
  });
  const packed = packUserOp(userOp);

  // initCode = factory (20 bytes) + factoryData
  expect(packed.initCode.startsWith("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeTruthy();
  expect(packed.initCode.endsWith("1234")).toBeTruthy();
});

it("packUserOp - packs paymaster into paymasterAndData", () => {
  const userOp = makeUserOp({
    paymaster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 30_000n,
    paymasterData: "0xabcd",
  });
  const packed = packUserOp(userOp);

  expect(packed.paymasterAndData.length > 2).toBeTruthy();
  expect(
    packed.paymasterAndData.startsWith(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
  ).toBeTruthy();
});

it("packUserOp / unpackUserOp roundtrip with paymaster", () => {
  const userOp = makeUserOp({
    paymaster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 30_000n,
    paymasterData: "0xabcdef",
  });
  const packed = packUserOp(userOp);
  const unpacked = unpackUserOp(packed);

  expect(unpacked.paymaster).toEqual(userOp.paymaster);
  expect(unpacked.paymasterVerificationGasLimit).toEqual(userOp.paymasterVerificationGasLimit);
  expect(unpacked.paymasterPostOpGasLimit).toEqual(userOp.paymasterPostOpGasLimit);
  expect(unpacked.paymasterData).toEqual(userOp.paymasterData);
});

// --- Hash ---

it("getUserOpHash - returns a 32-byte hex string", () => {
  const userOp = makeUserOp();
  const packed = packUserOp(userOp);
  const hash = getUserOpHash(packed, ENTRY_POINT, 1);

  expect(hash.startsWith("0x")).toBeTruthy();
  expect(hash.length).toEqual(66); // 0x + 64 hex chars
});

it("getUserOpHash - different nonces produce different hashes", () => {
  const op1 = makeUserOp({ nonce: 0n });
  const op2 = makeUserOp({ nonce: 1n });

  const hash1 = getUserOpHash(packUserOp(op1), ENTRY_POINT, 1);
  const hash2 = getUserOpHash(packUserOp(op2), ENTRY_POINT, 1);

  expect(hash1 !== hash2).toBeTruthy();
});

it("getUserOpHash - different chains produce different hashes", () => {
  const userOp = makeUserOp();
  const packed = packUserOp(userOp);

  const hash1 = getUserOpHash(packed, ENTRY_POINT, 1);
  const hash137 = getUserOpHash(packed, ENTRY_POINT, 137);

  expect(hash1 !== hash137).toBeTruthy();
});

// --- Validation ---

it("validateUserOpFields - accepts valid UserOp", () => {
  const userOp = makeUserOp();
  validateUserOpFields(userOp); // should not throw
});

it("validateUserOpFields - rejects invalid sender", () => {
  expect(
    () => validateUserOpFields(makeUserOp({ sender: "0xinvalid" as `0x${string}` })),
  ).toThrow("invalid sender");
  expect(
    () => validateUserOpFields(makeUserOp({ sender: "0xinvalid" as `0x${string}` })),
  ).toThrow(UserOpValidationError);
});

it("validateUserOpFields - rejects zero callGasLimit", () => {
  expect(
    () => validateUserOpFields(makeUserOp({ callGasLimit: 0n })),
  ).toThrow("callGasLimit must be > 0");
  expect(
    () => validateUserOpFields(makeUserOp({ callGasLimit: 0n })),
  ).toThrow(UserOpValidationError);
});

it("validateUserOpFields - rejects verificationGasLimit over MAX", () => {
  // MAX_VERIFICATION_GAS is 5_000_000n (non-Tempo). Use a value strictly above it so the
  // test tracks the constant instead of a hardcoded number that silently goes stale when
  // the cap is raised.
  expect(
    () => validateUserOpFields(makeUserOp({ verificationGasLimit: 5_000_001n })),
  ).toThrow("verificationGasLimit exceeds max");
  expect(
    () => validateUserOpFields(makeUserOp({ verificationGasLimit: 5_000_001n })),
  ).toThrow(UserOpValidationError);
});

it("validateUserOpFields - accepts verificationGasLimit at MAX", () => {
  // The boundary value must be accepted (regression guard against an off-by-one in the cap).
  validateUserOpFields(makeUserOp({ verificationGasLimit: 5_000_000n }));
});

// uint128 packing bounds — a field ≥ 2^128 would throw inside packUint128; validation must
// reject it cleanly (regression for O-20).
const OVER_UINT128 = 1n << 128n;
it("validateUserOpFields - rejects callGasLimit ≥ 2^128", () => {
  expect(() => validateUserOpFields(makeUserOp({ callGasLimit: OVER_UINT128 }))).toThrow("callGasLimit exceeds uint128");
  expect(() => validateUserOpFields(makeUserOp({ callGasLimit: OVER_UINT128 }))).toThrow(UserOpValidationError);
});
it("validateUserOpFields - rejects maxFeePerGas ≥ 2^128", () => {
  expect(
    () => validateUserOpFields(makeUserOp({ maxFeePerGas: OVER_UINT128, maxPriorityFeePerGas: 0n })),
  ).toThrow("maxFeePerGas exceeds uint128");
  expect(
    () => validateUserOpFields(makeUserOp({ maxFeePerGas: OVER_UINT128, maxPriorityFeePerGas: 0n })),
  ).toThrow(UserOpValidationError);
});
it("validateUserOpFields - rejects maxPriorityFeePerGas ≥ 2^128", () => {
  // Keep priority ≤ maxFee so we reach the uint128 check rather than the ordering check;
  // set both above the cap.
  expect(
    () => validateUserOpFields(makeUserOp({ maxFeePerGas: OVER_UINT128 + 1n, maxPriorityFeePerGas: OVER_UINT128 })),
  ).toThrow("exceeds uint128");
  expect(
    () => validateUserOpFields(makeUserOp({ maxFeePerGas: OVER_UINT128 + 1n, maxPriorityFeePerGas: OVER_UINT128 })),
  ).toThrow(UserOpValidationError);
});
it("validateUserOpFields - accepts fields at uint128 max boundary", () => {
  const MAX = (1n << 128n) - 1n;
  validateUserOpFields(makeUserOp({ callGasLimit: MAX, maxFeePerGas: MAX, maxPriorityFeePerGas: MAX }));
});

it("validateUserOpFields - rejects priority > maxFee", () => {
  expect(
    () =>
      validateUserOpFields(
        makeUserOp({
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 20n,
        }),
      ),
  ).toThrow("must not exceed");
  expect(
    () =>
      validateUserOpFields(
        makeUserOp({
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 20n,
        }),
      ),
  ).toThrow(UserOpValidationError);
});

it("validateUserOpFields - rejects empty signature", () => {
  expect(
    () => validateUserOpFields(makeUserOp({ signature: "0x" })),
  ).toThrow("signature is required");
  expect(
    () => validateUserOpFields(makeUserOp({ signature: "0x" })),
  ).toThrow(UserOpValidationError);
});

it("validateUserOpFields - rejects factoryData without factory", () => {
  expect(
    () =>
      validateUserOpFields(makeUserOp({ factory: null, factoryData: "0x1234" })),
  ).toThrow("factoryData without factory");
  expect(
    () =>
      validateUserOpFields(makeUserOp({ factory: null, factoryData: "0x1234" })),
  ).toThrow(UserOpValidationError);
});

// --- parseValidationData ---

it("parseValidationData - zero means valid forever from zero aggregator", () => {
  const result = parseValidationData(0n);
  expect(result.aggregator).toEqual("0x0000000000000000000000000000000000000000");
  expect(result.validAfter).toEqual(0);
  expect(result.validUntil).toEqual(0xffffffffffff); // 0 means no expiry
});

it("parseValidationData - sig failure aggregator == 1", () => {
  // Canonical ERC-4337 v0.7: aggregator is the LOW 160 bits; SIG_VALIDATION_FAILED == 1.
  const data = 1n;
  const result = parseValidationData(data);
  expect(result.aggregator).toEqual("0x0000000000000000000000000000000000000001");
});

it("parseValidationData - time-bounded op has zero aggregator (accepted, not mis-read)", () => {
  // Regression guard for the inverted-layout bug: a valid op with only validUntil set must
  // parse aggregator == 0 (success), NOT a bogus nonzero value that would be rejected as
  // "Aggregated signatures not supported".
  const validUntil = 1893456000n; // 2030-01-01
  const data = validUntil << 160n;
  const result = parseValidationData(data);
  expect(result.aggregator).toEqual("0x0000000000000000000000000000000000000000");
  expect(result.validUntil).toEqual(1893456000);
  expect(result.validAfter).toEqual(0);
});

it("isValidTimeRange - current time within range", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(isValidTimeRange(now - 100, now + 100, 0)).toBeTruthy();
});

it("isValidTimeRange - expired returns false", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(!isValidTimeRange(0, now - 10, 0)).toBeTruthy();
});

it("isValidTimeRange - not yet valid returns false", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(!isValidTimeRange(now + 1000, now + 2000, 0)).toBeTruthy();
});

// --- Normalization ---

it("normalizeUserOp - converts hex strings to bigints", () => {
  const raw = {
    sender: "0x1234567890abcdef1234567890abcdef12345678",
    nonce: "0x1",
    callData: "0xdeadbeef",
    callGasLimit: "0x186a0",
    verificationGasLimit: "0x30d40",
    preVerificationGas: "0xea60",
    maxFeePerGas: "0x6fc23ac00",
    maxPriorityFeePerGas: "0x77359400",
    signature: "0xaabbcc",
  };

  const userOp = normalizeUserOp(raw);
  expect(userOp.nonce).toEqual(1n);
  expect(userOp.callGasLimit).toEqual(100_000n);
  expect(userOp.verificationGasLimit).toEqual(200_000n);
});

it("normalizeUserOp - rejects missing sender", () => {
  expect(
    () => normalizeUserOp({ nonce: "0x0" }),
  ).toThrow(UserOpValidationError);
});
