/**
 * Deterministic EOA private key derivation using HKDF-SHA256.
 *
 * Derivation path:
 *   HKDF-SHA256(
 *     IKM = operatorSecret,
 *     salt = "vela-bundler-dedicated-eoa-v1",
 *     info = canonicalize(chainId, entryPoint, safeAddress) + counterSuffix,
 *     L = 32
 *   )
 *
 * If the output is 0 or >= secp256k1 curve order N, append an incrementing
 * counter and re-derive until a valid private key is produced.
 */

import { privateKeyToAccount } from "viem/accounts";

// secp256k1 curve order
const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

const DOMAIN_SEPARATOR = "vela-bundler-dedicated-eoa-v1";

/**
 * Validate an operator secret before it is used to derive any key. Fails closed on a
 * malformed or too-short secret. This is the single guard every derivation path passes
 * through, so the public treasury/EOA derivations (which run BEFORE any KeyManager is
 * constructed — e.g. the /v1/treasury endpoint) can never silently derive from garbage.
 */
export function validateOperatorSecret(secret: string, label = "operatorSecret"): void {
  if (!secret) throw new Error(`${label} is required`);
  const clean = secret.startsWith("0x") ? secret.slice(2) : secret;
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`${label} must be a hex string (with or without 0x prefix)`);
  }
  if (clean.length < 64) {
    throw new Error(
      `${label} must be at least 32 bytes (64 hex chars), got ${Math.floor(clean.length / 2)} bytes`,
    );
  }
}

/**
 * Derive a valid secp256k1 private key deterministically.
 *
 * @param operatorSecret - High-entropy master secret (hex string).
 * @param chainId - Chain ID (number).
 * @param entryPoint - EntryPoint address (0x-prefixed, will be lowercased).
 * @param safeAddress - Safe/account address (0x-prefixed, will be lowercased).
 * @returns 0x-prefixed 32-byte hex private key.
 */
export async function deriveEOAPrivateKey(
  operatorSecret: string,
  chainId: number,
  entryPoint: `0x${string}`,
  safeAddress: `0x${string}`,
): Promise<`0x${string}`> {
  validateOperatorSecret(operatorSecret);

  // Normalize inputs
  const normalizedEntryPoint = entryPoint.toLowerCase();
  const normalizedSafeAddress = safeAddress.toLowerCase();
  const chainIdStr = chainId.toString(10);

  // IKM: operator secret as bytes
  const ikm = hexToBytes(operatorSecret);

  // Salt: domain separator
  const salt = new TextEncoder().encode(DOMAIN_SEPARATOR);

  // Info: canonical concatenation with explicit field separators
  const baseInfo = `chainId=${chainIdStr}|entryPoint=${normalizedEntryPoint}|safeAddress=${normalizedSafeAddress}`;

  // Try with incrementing counter until we get a valid key
  for (let counter = 0; counter < 256; counter++) {
    const info = counter === 0
      ? baseInfo
      : `${baseInfo}|counter=${counter}`;

    const infoBytes = new TextEncoder().encode(info);
    const derived = await hkdfSha256(ikm, salt, infoBytes, 32);
    const keyBigInt = bytesToBigInt(derived);

    // Validate: must be in range [1, N-1]
    if (keyBigInt > 0n && keyBigInt < SECP256K1_N) {
      return ("0x" + bytesToHex(derived)) as `0x${string}`;
    }
  }

  // Should never happen with a proper secret
  throw new Error("Failed to derive valid secp256k1 key after 256 attempts");
}

// ---------------------------------------------------------------------------
// Treasury key derivation — same address on every chain
// ---------------------------------------------------------------------------

const TREASURY_INFO = "treasury";

/**
 * Derive the treasury private key from the operator secret.
 * Uses a fixed info string (no chainId/safeAddress) so the treasury
 * address is identical across all chains.
 */
export async function deriveTreasuryPrivateKey(
  operatorSecret: string,
): Promise<`0x${string}`> {
  validateOperatorSecret(operatorSecret);
  const ikm = hexToBytes(operatorSecret);
  const salt = new TextEncoder().encode(DOMAIN_SEPARATOR);
  const infoBytes = new TextEncoder().encode(TREASURY_INFO);

  for (let counter = 0; counter < 256; counter++) {
    const info = counter === 0
      ? infoBytes
      : new TextEncoder().encode(`${TREASURY_INFO}|counter=${counter}`);
    const derived = await hkdfSha256(ikm, salt, info, 32);
    const keyBigInt = bytesToBigInt(derived);
    if (keyBigInt > 0n && keyBigInt < SECP256K1_N) {
      return ("0x" + bytesToHex(derived)) as `0x${string}`;
    }
  }
  throw new Error("Failed to derive valid treasury key after 256 attempts");
}

/**
 * Derive the treasury address from the operator secret.
 */
export async function deriveTreasuryAddress(
  operatorSecret: string,
): Promise<`0x${string}`> {
  const privateKey = await deriveTreasuryPrivateKey(operatorSecret);
  const account = privateKeyToAccount(privateKey);
  return account.address.toLowerCase() as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Per-user EOA address derivation
// ---------------------------------------------------------------------------

/**
 * Derive the address for a dedicated EOA.
 */
export async function deriveEOAAddress(
  operatorSecret: string,
  chainId: number,
  entryPoint: `0x${string}`,
  safeAddress: `0x${string}`,
): Promise<`0x${string}`> {
  const privateKey = await deriveEOAPrivateKey(
    operatorSecret,
    chainId,
    entryPoint,
    safeAddress,
  );
  const account = privateKeyToAccount(privateKey);
  return account.address.toLowerCase() as `0x${string}`;
}

// --- HKDF-SHA256 implementation using Web Crypto API ---

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const ikmKey = await crypto.subtle.importKey(
    "raw",
    ikm.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.buffer as ArrayBuffer,
      info: info.buffer as ArrayBuffer,
    },
    ikmKey,
    length * 8,
  );

  return new Uint8Array(derivedBits);
}

// --- Utility functions ---

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    // Never silently coerce a non-hex pair to 0 — that would derive keys from a corrupted
    // secret without any error. Fail closed instead.
    if (Number.isNaN(byte)) {
      throw new Error("Invalid hex string: contains non-hex characters");
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
