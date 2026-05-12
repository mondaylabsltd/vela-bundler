/**
 * Unit tests for UserOperation packing, hashing, validation, and normalization.
 */

import { assertEquals, assert, assertThrows } from "@std/assert";
import { packUserOp, unpackUserOp } from "../src/userop/pack.ts";
import { getUserOpHash } from "../src/userop/hash.ts";
import {
  validateUserOpFields,
  parseValidationData,
  isValidTimeRange,
  UserOpValidationError,
} from "../src/userop/validate.ts";
import { normalizeUserOp } from "../src/userop/normalize.ts";
import type { UserOperation } from "../src/userop/types.ts";

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

Deno.test("packUserOp and unpackUserOp are inverse operations", () => {
  const userOp = makeUserOp();
  const packed = packUserOp(userOp);
  const unpacked = unpackUserOp(packed);

  assertEquals(unpacked.sender, userOp.sender);
  assertEquals(unpacked.nonce, userOp.nonce);
  assertEquals(unpacked.callGasLimit, userOp.callGasLimit);
  assertEquals(unpacked.verificationGasLimit, userOp.verificationGasLimit);
  assertEquals(unpacked.maxFeePerGas, userOp.maxFeePerGas);
  assertEquals(unpacked.maxPriorityFeePerGas, userOp.maxPriorityFeePerGas);
  assertEquals(unpacked.factory, userOp.factory);
  assertEquals(unpacked.paymaster, userOp.paymaster);
});

Deno.test("packUserOp - packs factory into initCode", () => {
  const userOp = makeUserOp({
    factory: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    factoryData: "0x1234",
  });
  const packed = packUserOp(userOp);

  // initCode = factory (20 bytes) + factoryData
  assert(packed.initCode.startsWith("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert(packed.initCode.endsWith("1234"));
});

Deno.test("packUserOp - packs paymaster into paymasterAndData", () => {
  const userOp = makeUserOp({
    paymaster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 30_000n,
    paymasterData: "0xabcd",
  });
  const packed = packUserOp(userOp);

  assert(packed.paymasterAndData.length > 2);
  assert(
    packed.paymasterAndData.startsWith(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
  );
});

Deno.test("packUserOp / unpackUserOp roundtrip with paymaster", () => {
  const userOp = makeUserOp({
    paymaster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    paymasterVerificationGasLimit: 50_000n,
    paymasterPostOpGasLimit: 30_000n,
    paymasterData: "0xabcdef",
  });
  const packed = packUserOp(userOp);
  const unpacked = unpackUserOp(packed);

  assertEquals(unpacked.paymaster, userOp.paymaster);
  assertEquals(unpacked.paymasterVerificationGasLimit, userOp.paymasterVerificationGasLimit);
  assertEquals(unpacked.paymasterPostOpGasLimit, userOp.paymasterPostOpGasLimit);
  assertEquals(unpacked.paymasterData, userOp.paymasterData);
});

// --- Hash ---

Deno.test("getUserOpHash - returns a 32-byte hex string", () => {
  const userOp = makeUserOp();
  const packed = packUserOp(userOp);
  const hash = getUserOpHash(packed, ENTRY_POINT, 1);

  assert(hash.startsWith("0x"));
  assertEquals(hash.length, 66); // 0x + 64 hex chars
});

Deno.test("getUserOpHash - different nonces produce different hashes", () => {
  const op1 = makeUserOp({ nonce: 0n });
  const op2 = makeUserOp({ nonce: 1n });

  const hash1 = getUserOpHash(packUserOp(op1), ENTRY_POINT, 1);
  const hash2 = getUserOpHash(packUserOp(op2), ENTRY_POINT, 1);

  assert(hash1 !== hash2);
});

Deno.test("getUserOpHash - different chains produce different hashes", () => {
  const userOp = makeUserOp();
  const packed = packUserOp(userOp);

  const hash1 = getUserOpHash(packed, ENTRY_POINT, 1);
  const hash137 = getUserOpHash(packed, ENTRY_POINT, 137);

  assert(hash1 !== hash137);
});

// --- Validation ---

Deno.test("validateUserOpFields - accepts valid UserOp", () => {
  const userOp = makeUserOp();
  validateUserOpFields(userOp); // should not throw
});

Deno.test("validateUserOpFields - rejects invalid sender", () => {
  assertThrows(
    () => validateUserOpFields(makeUserOp({ sender: "0xinvalid" as `0x${string}` })),
    UserOpValidationError,
    "invalid sender",
  );
});

Deno.test("validateUserOpFields - rejects zero callGasLimit", () => {
  assertThrows(
    () => validateUserOpFields(makeUserOp({ callGasLimit: 0n })),
    UserOpValidationError,
    "callGasLimit must be > 0",
  );
});

Deno.test("validateUserOpFields - rejects verificationGasLimit over MAX", () => {
  assertThrows(
    () => validateUserOpFields(makeUserOp({ verificationGasLimit: 3_000_000n })),
    UserOpValidationError,
    "MAX_VERIFICATION_GAS",
  );
});

Deno.test("validateUserOpFields - rejects priority > maxFee", () => {
  assertThrows(
    () =>
      validateUserOpFields(
        makeUserOp({
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 20n,
        }),
      ),
    UserOpValidationError,
    "must not exceed",
  );
});

Deno.test("validateUserOpFields - rejects empty signature", () => {
  assertThrows(
    () => validateUserOpFields(makeUserOp({ signature: "0x" })),
    UserOpValidationError,
    "signature is required",
  );
});

Deno.test("validateUserOpFields - rejects factoryData without factory", () => {
  assertThrows(
    () =>
      validateUserOpFields(makeUserOp({ factory: null, factoryData: "0x1234" })),
    UserOpValidationError,
    "factoryData without factory",
  );
});

// --- parseValidationData ---

Deno.test("parseValidationData - zero means valid forever from zero aggregator", () => {
  const result = parseValidationData(0n);
  assertEquals(result.aggregator, "0x0000000000000000000000000000000000000000");
  assertEquals(result.validAfter, 0);
  assertEquals(result.validUntil, 0xffffffffffff); // 0 means no expiry
});

Deno.test("parseValidationData - sig failure aggregator == 1", () => {
  // aggregator = 1, validUntil = 0, validAfter = 0
  const data = 1n << 96n;
  const result = parseValidationData(data);
  assertEquals(result.aggregator, "0x0000000000000000000000000000000000000001");
});

Deno.test("isValidTimeRange - current time within range", () => {
  const now = Math.floor(Date.now() / 1000);
  assert(isValidTimeRange(now - 100, now + 100, 0));
});

Deno.test("isValidTimeRange - expired returns false", () => {
  const now = Math.floor(Date.now() / 1000);
  assert(!isValidTimeRange(0, now - 10, 0));
});

Deno.test("isValidTimeRange - not yet valid returns false", () => {
  const now = Math.floor(Date.now() / 1000);
  assert(!isValidTimeRange(now + 1000, now + 2000, 0));
});

// --- Normalization ---

Deno.test("normalizeUserOp - converts hex strings to bigints", () => {
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
  assertEquals(userOp.nonce, 1n);
  assertEquals(userOp.callGasLimit, 100_000n);
  assertEquals(userOp.verificationGasLimit, 200_000n);
});

Deno.test("normalizeUserOp - rejects missing sender", () => {
  assertThrows(
    () => normalizeUserOp({ nonce: "0x0" }),
    UserOpValidationError,
  );
});
