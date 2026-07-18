/**
 * Tests for deterministic key derivation.
 */

import { it, expect } from "vitest";
import { deriveEOAPrivateKey, deriveEOAAddress, deriveTreasuryPrivateKey, deriveTreasuryAddress, derivePoolRelayerPrivateKey, derivePoolRelayerAddress, RELAYER_POOL_SIZE, validateOperatorSecret } from "../shared/keys/derive.ts";
import { LocalKeyManager } from "../shared/keys/local.ts";

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

it("deriveEOAPrivateKey - same inputs produce same key", async () => {
  const key1 = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const key2 = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  expect(key1).toEqual(key2);
});

it("deriveEOAAddress - same inputs produce same address", async () => {
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr2 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  expect(addr1).toEqual(addr2);
});

// --- Uniqueness per parameter ---

it("different chainId produces different address", async () => {
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr137 = await deriveEOAAddress(TEST_SECRET, 137, ENTRY_POINT, SAFE_A);
  expect(addr1).not.toEqual(addr137);
});

it("different entryPoint produces different address", async () => {
  const ep2 = "0x1111111111111111111111111111111111111111" as const;
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr2 = await deriveEOAAddress(TEST_SECRET, 1, ep2, SAFE_A);
  expect(addr1).not.toEqual(addr2);
});

it("different safeAddress produces different address", async () => {
  const addrA = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addrB = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_B);
  expect(addrA).not.toEqual(addrB);
});

it("different operatorSecret produces different address", async () => {
  const addr1 = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const addr2 = await deriveEOAAddress(TEST_SECRET_2, 1, ENTRY_POINT, SAFE_A);
  expect(addr1).not.toEqual(addr2);
});

// --- Valid secp256k1 key ---

it("derived private key is a valid secp256k1 key", async () => {
  const key = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  expect(key.startsWith("0x")).toBeTruthy();
  expect(key.length).toEqual(66); // 0x + 64 hex chars

  const keyBigInt = BigInt(key);
  expect(keyBigInt > 0n, "Key must be > 0").toBeTruthy();
  expect(keyBigInt < SECP256K1_N, "Key must be < secp256k1 curve order").toBeTruthy();
});

it("derived address is a valid Ethereum address", async () => {
  const addr = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  expect(/^0x[0-9a-f]{40}$/.test(addr)).toBeTruthy();
});

it("100 different safeAddresses all produce valid keys", async () => {
  for (let i = 0; i < 100; i++) {
    const safe = ("0x" + i.toString(16).padStart(40, "0")) as `0x${string}`;
    const key = await deriveEOAPrivateKey(TEST_SECRET, 1, ENTRY_POINT, safe);
    const keyBigInt = BigInt(key);
    expect(keyBigInt > 0n).toBeTruthy();
    expect(keyBigInt < SECP256K1_N).toBeTruthy();
  }
});

// --- Case insensitivity ---

it("address case doesn't affect derivation", async () => {
  const addrLower = await deriveEOAAddress(
    TEST_SECRET, 1, ENTRY_POINT,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const addrUpper = await deriveEOAAddress(
    TEST_SECRET, 1, ENTRY_POINT,
    "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as `0x${string}`,
  );
  expect(addrLower).toEqual(addrUpper);
});

// --- LocalKeyManager ---

it("LocalKeyManager - derives consistent EOA", async () => {
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

  expect(eoa1.address).toEqual(eoa2.address);
  expect(eoa1.privateKey !== undefined).toBeTruthy();
});

it("LocalKeyManager - old secrets accessible", () => {
  const km = new LocalKeyManager({
    operatorSecret: TEST_SECRET,
    oldOperatorSecrets: [TEST_SECRET_2],
  });

  expect(km.getOldSecrets().length).toEqual(1);
});

it("LocalKeyManager - rejects short operator secret (< 32 bytes)", () => {
  let threw = false;
  try {
    new LocalKeyManager({
      operatorSecret: "0xdeadbeefdeadbeefdeadbeefdeadbeef",
    });
  } catch {
    threw = true;
  }
  expect(threw, "Should reject secret shorter than 32 bytes").toBeTruthy();
});

it("LocalKeyManager - rejects non-hex operator secret", () => {
  let threw = false;
  try {
    new LocalKeyManager({
      operatorSecret: "this-is-not-hex-but-its-long-enough-to-pass-length-check!!",
    });
  } catch {
    threw = true;
  }
  expect(threw, "Should reject non-hex secret").toBeTruthy();
});

it("LocalKeyManager - accepts exactly 32-byte hex secret", () => {
  const km = new LocalKeyManager({
    operatorSecret: "0x" + "ab".repeat(32),
  });
  expect(km.getOldSecrets().length).toEqual(0);
});

it("LocalKeyManager - validates old secrets too", () => {
  let threw = false;
  try {
    new LocalKeyManager({
      operatorSecret: TEST_SECRET,
      oldOperatorSecrets: ["tooshort"],
    });
  } catch {
    threw = true;
  }
  expect(threw, "Should reject invalid old secret").toBeTruthy();
});

// --- Treasury derivation ---

it("deriveTreasuryPrivateKey - deterministic", async () => {
  const key1 = await deriveTreasuryPrivateKey(TEST_SECRET);
  const key2 = await deriveTreasuryPrivateKey(TEST_SECRET);
  expect(key1).toEqual(key2);
});

it("deriveTreasuryAddress - same secret produces same address", async () => {
  const addr1 = await deriveTreasuryAddress(TEST_SECRET);
  const addr2 = await deriveTreasuryAddress(TEST_SECRET);
  expect(addr1).toEqual(addr2);
  expect(addr1.startsWith("0x")).toBeTruthy();
  expect(addr1.length).toEqual(42);
});

it("deriveTreasuryAddress - different secret produces different address", async () => {
  const addr1 = await deriveTreasuryAddress(TEST_SECRET);
  const addr2 = await deriveTreasuryAddress(TEST_SECRET_2);
  expect(addr1).not.toEqual(addr2);
});

it("deriveTreasuryAddress - different from per-user EOA", async () => {
  const treasury = await deriveTreasuryAddress(TEST_SECRET);
  const userEOA = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  expect(treasury).not.toEqual(userEOA);
});

// --- Pool relayer derivation (Stage 0 of docs/pool-queue-architecture.md) ---

// Golden vectors computed with an INDEPENDENT HKDF implementation (node:crypto
// hkdfSync, not the WebCrypto path under test): HKDF-SHA256(IKM=secret,
// salt="vela-bundler-dedicated-eoa-v1", info=`relayer-#${i}`, L=32). Any change
// to the salt, info format, or counter scheme breaks these — that is the point:
// the derivation is an on-chain-funds commitment and must never silently move.
const POOL_GOLDEN_PK_0 =
  "0xeca260badba16aa99814aafa0d11978ec3772bd088b294c9032ce278a5b8e2d3";
const POOL_GOLDEN_ADDRS: Record<number, `0x${string}`> = {
  0: "0x6d05a1d693ad0fc5189560d5456acde3afe31342",
  1: "0x783346e3c11d430c523b41462f81aae91e57fd84",
  2: "0xa97ac271de683cb40069aa1f457b7876d3f96995",
  50: "0x23c64c8351d3307757bb664af9ca6fde89c40494",
  99: "0xea1daafbdae5dea227cf045d99cd7e7f96f51865",
};
const POOL_GOLDEN_ADDR_0_SECRET_2 = "0xa5640ac2724e1d066d71e5b1d9c556184b5e68e5";

it("derivePoolRelayerPrivateKey - matches golden vector for index 0", async () => {
  const pk = await derivePoolRelayerPrivateKey(TEST_SECRET, 0);
  expect(pk).toEqual(POOL_GOLDEN_PK_0);
});

it("derivePoolRelayerAddress - matches golden vectors", async () => {
  for (const [index, expected] of Object.entries(POOL_GOLDEN_ADDRS)) {
    const addr = await derivePoolRelayerAddress(TEST_SECRET, Number(index));
    expect(addr, `pool relayer #${index}`).toEqual(expected);
  }
});

it("derivePoolRelayerAddress - different secret produces different golden address", async () => {
  const addr = await derivePoolRelayerAddress(TEST_SECRET_2, 0);
  expect(addr).toEqual(POOL_GOLDEN_ADDR_0_SECRET_2);
  expect(addr).not.toEqual(POOL_GOLDEN_ADDRS[0]);
});

it("pool relayer pool size is 100", () => {
  expect(RELAYER_POOL_SIZE).toEqual(100);
});

it("all 100 pool relayer keys are valid and all addresses distinct", async () => {
  const addrs = new Set<string>();
  for (let i = 0; i < RELAYER_POOL_SIZE; i++) {
    const pk = await derivePoolRelayerPrivateKey(TEST_SECRET, i);
    const keyBigInt = BigInt(pk);
    expect(keyBigInt > 0n).toBeTruthy();
    expect(keyBigInt < SECP256K1_N).toBeTruthy();
    addrs.add(await derivePoolRelayerAddress(TEST_SECRET, i));
  }
  expect(addrs.size).toEqual(RELAYER_POOL_SIZE);
});

it("pool relayer addresses are distinct from treasury and per-safe EOAs", async () => {
  const treasury = await deriveTreasuryAddress(TEST_SECRET);
  const perSafe = await deriveEOAAddress(TEST_SECRET, 1, ENTRY_POINT, SAFE_A);
  const pool0 = await derivePoolRelayerAddress(TEST_SECRET, 0);
  expect(pool0).not.toEqual(treasury);
  expect(pool0).not.toEqual(perSafe);
});

it("derivePoolRelayerPrivateKey - rejects out-of-range or non-integer index", async () => {
  await expect(derivePoolRelayerPrivateKey(TEST_SECRET, -1)).rejects.toThrow("index");
  await expect(derivePoolRelayerPrivateKey(TEST_SECRET, RELAYER_POOL_SIZE)).rejects.toThrow("index");
  await expect(derivePoolRelayerPrivateKey(TEST_SECRET, 1.5)).rejects.toThrow("index");
  await expect(derivePoolRelayerPrivateKey(TEST_SECRET, NaN)).rejects.toThrow("index");
});

it("derivePoolRelayerPrivateKey - rejects a malformed secret", async () => {
  await expect(derivePoolRelayerPrivateKey("0x1234", 0)).rejects.toThrow("at least 32 bytes");
});

it("LocalKeyManager - derivePoolEOA matches direct derivation and is deterministic", async () => {
  const km = new LocalKeyManager({ operatorSecret: TEST_SECRET });
  const eoa1 = await km.derivePoolEOA(0);
  const eoa2 = await km.derivePoolEOA(0);
  expect(eoa1.address).toEqual(POOL_GOLDEN_ADDRS[0]);
  expect(eoa1.address).toEqual(eoa2.address);
  expect(eoa1.privateKey).toEqual(POOL_GOLDEN_PK_0);
});

// --- Secret validation (fail-closed on a malformed/weak OPERATOR_SECRET) ---

it("validateOperatorSecret - rejects empty, non-hex, and too-short secrets", () => {
  expect(() => validateOperatorSecret("")).toThrow("required");
  expect(() => validateOperatorSecret("0xnothex_nothex_nothex_nothex_nothex_nothex_nothex_nothex_nothex__")).toThrow("hex");
  expect(() => validateOperatorSecret("0x00")).toThrow("at least 32 bytes");
  // 31 bytes (62 hex chars) is below the floor.
  expect(() => validateOperatorSecret("0x" + "ab".repeat(31))).toThrow("at least 32 bytes");
  // Exactly 32 bytes is accepted (with and without 0x prefix).
  validateOperatorSecret("0x" + "ab".repeat(32));
  validateOperatorSecret("ab".repeat(32));
});

it("deriveTreasuryPrivateKey - rejects a malformed secret instead of deriving from zero bytes", async () => {
  // Before the fix, non-hex chars were coerced to 0 bytes, silently deriving a WRONG-but-
  // non-erroring treasury key on the public /v1/treasury path. Must now fail closed.
  await expect(deriveTreasuryPrivateKey("0xzz" + "ab".repeat(31))).rejects.toThrow();
  await expect(deriveTreasuryPrivateKey("0x1234")).rejects.toThrow("at least 32 bytes");
});

it("deriveEOAPrivateKey - rejects a malformed secret", async () => {
  await expect(deriveEOAPrivateKey("0x1234", 1, ENTRY_POINT, SAFE_A)).rejects.toThrow("at least 32 bytes");
});
