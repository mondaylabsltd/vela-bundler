/**
 * Tests for deterministic key derivation.
 */

import { assertEquals, assert, assertNotEquals } from "@std/assert";
import { deriveEOAPrivateKey, deriveEOAAddress } from "../src/keys/derive.ts";
import { LocalKeyManager } from "../src/keys/local.ts";

const TEST_SECRET =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_SECRET_2 =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const SAFE_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const SAFE_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

// secp256k1 curve order
const SECP256K1_N =
  0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

// --- Determinism ---

Deno.test("deriveEOAPrivateKey - same inputs produce same key", async () => {
  const key1 = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const key2 = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  assertEquals(key1, key2);
});

Deno.test("deriveEOAAddress - same inputs produce same address", async () => {
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr2 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  assertEquals(addr1, addr2);
});

// --- Uniqueness per parameter ---

Deno.test("different chainId produces different address", async () => {
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr137 = await deriveEOAAddress(TEST_SECRET, 137, ENTRY_POINT, SAFE_A);
  assertNotEquals(addr1, addr137);
});

Deno.test("different entryPoint produces different address", async () => {
  const ep2 = "0x1111111111111111111111111111111111111111" as const;
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr2 = await deriveEOAAddress(TEST_SECRET, 1, ep2, SAFE_A);
  assertNotEquals(addr1, addr2);
});

Deno.test("different safeAddress produces different address", async () => {
  const addrA = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addrB = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_B);
  assertNotEquals(addrA, addrB);
});

Deno.test("different operatorSecret produces different address", async () => {
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr2 = await deriveEOAAddress(TEST_SECRET_2, 1, ENTRY_POINT, SAFE_A);
  assertNotEquals(addr1, addr2);
});

// --- Valid secp256k1 key ---

Deno.test("derived private key is a valid secp256k1 key", async () => {
  const key = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  assert(key.startsWith("0x"));
  assertEquals(key.length, 66); // 0x + 64 hex chars

  const keyBigInt = BigInt(key);
  assert(keyBigInt > 0n, "Key must be > 0");
  assert(keyBigInt < SECP256K1_N, "Key must be < secp256k1 curve order");
});

Deno.test("derived address is a valid Ethereum address", async () => {
  const addr = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  assert(/^0x[0-9a-f]{40}$/.test(addr));
});

Deno.test("100 different safeAddresses all produce valid keys", async () => {
  for (let i = 0; i < 100; i++) {
    const safe = ("0x" + i.toString(16).padStart(40, "0")) as `0x${string}`;
    const key = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, safe);
    const keyBigInt = BigInt(key);
    assert(keyBigInt > 0n);
    assert(keyBigInt < SECP256K1_N);
  }
});

// --- Case insensitivity ---

Deno.test("address case doesn't affect derivation", async () => {
  const addrLower = await deriveEOAAddress(
    TEST_SECRET, 1, ENTRY_POINT,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const addrUpper = await deriveEOAAddress(
    TEST_SECRET, 1, ENTRY_POINT,
    "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as `0x${string}`,
  );
  assertEquals(addrLower, addrUpper);
});

// --- LocalKeyManager ---

Deno.test("LocalKeyManager - derives consistent EOA", async () => {
  const km = new LocalKeyManager({
    operatorSecret: TEST_SECRET,
  });

  const eoa1 = await km.deriveEOA({
    chainId: 1,
    entryPoint: ENTRY_POINT,
    safeAddress: SAFE_A,
  });
  const eoa2 = await km.deriveEOA({
    chainId: 1,
    entryPoint: ENTRY_POINT,
    safeAddress: SAFE_A,
  });

  assertEquals(eoa1.address, eoa2.address);
  assert(eoa1.privateKey !== undefined);
});

Deno.test("LocalKeyManager - old secrets accessible", () => {
  const km = new LocalKeyManager({
    operatorSecret: TEST_SECRET,
    oldOperatorSecrets: [TEST_SECRET_2],
  });

  assertEquals(km.getOldSecrets().length, 1);
});

Deno.test("LocalKeyManager - rejects short operator secret (< 32 bytes)", () => {
  let threw = false;
  try {
    new LocalKeyManager({
      operatorSecret: "0xdeadbeefdeadbeefdeadbeefdeadbeef",
    });
  } catch {
    threw = true;
  }
  assert(threw, "Should reject secret shorter than 32 bytes");
});

Deno.test("LocalKeyManager - rejects non-hex operator secret", () => {
  let threw = false;
  try {
    new LocalKeyManager({
      operatorSecret: "this-is-not-hex-but-its-long-enough-to-pass-length-check!!",
    });
  } catch {
    threw = true;
  }
  assert(threw, "Should reject non-hex secret");
});

Deno.test("LocalKeyManager - accepts exactly 32-byte hex secret", () => {
  const km = new LocalKeyManager({
    operatorSecret: "0x" + "ab".repeat(32),
  });
  assertEquals(km.getOldSecrets().length, 0);
});

Deno.test("LocalKeyManager - validates old secrets too", () => {
  let threw = false;
  try {
    new LocalKeyManager({
      operatorSecret: TEST_SECRET,
      oldOperatorSecrets: ["tooshort"],
    });
  } catch {
    threw = true;
  }
  assert(threw, "Should reject invalid old secret");
});
