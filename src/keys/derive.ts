/**
 * Deterministic EOA private key derivation using HKDF-SHA256.
 *
 * Derivation path:
 *   HKDF-SHA256(
 *     IKM = operatorSecret,
 *     salt = "vela-bundler-dedicated-eoa-v1",
 *     info = canonicalize(chainId, entryPoint, safeAddress, keyVersion) + counterSuffix,
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
 * Derive a valid secp256k1 private key deterministically.
 *
 * @param operatorSecret - High-entropy master secret (hex string or raw bytes).
 * @param chainId - Chain ID (number).
 * @param entryPoint - EntryPoint address (0x-prefixed, will be lowercased).
 * @param safeAddress - Safe/account address (0x-prefixed, will be lowercased).
 * @param keyVersion - Key version string (e.g. "1").
 * @returns 0x-prefixed 32-byte hex private key.
 */
export async function deriveEOAPrivateKey(
  operatorSecret: string,
  chainId: number,
  entryPoint: `0x${string}`,
  safeAddress: `0x${string}`,
  keyVersion: string,
): Promise<`0x${string}`> {
  // Normalize inputs
  const normalizedEntryPoint = entryPoint.toLowerCase();
  const normalizedSafeAddress = safeAddress.toLowerCase();
  const chainIdStr = chainId.toString(10);

  // IKM: operator secret as bytes
  const ikm = hexToBytes(operatorSecret);

  // Salt: domain separator
  const salt = new TextEncoder().encode(DOMAIN_SEPARATOR);

  // Info: canonical concatenation with explicit field separators
  const baseInfo = `chainId=${chainIdStr}|entryPoint=${normalizedEntryPoint}|safeAddress=${normalizedSafeAddress}|keyVersion=${keyVersion}`;

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

/**
 * Derive the address for a dedicated EOA.
 */
export async function deriveEOAAddress(
  operatorSecret: string,
  chainId: number,
  entryPoint: `0x${string}`,
  safeAddress: `0x${string}`,
  keyVersion: string,
): Promise<`0x${string}`> {
  const privateKey = await deriveEOAPrivateKey(
    operatorSecret,
    chainId,
    entryPoint,
    safeAddress,
    keyVersion,
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
  // Import IKM as raw key material
  const ikmKey = await crypto.subtle.importKey(
    "raw",
    ikm.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );

  // Derive bits using HKDF
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.buffer as ArrayBuffer,
      info: info.buffer as ArrayBuffer,
    },
    ikmKey,
    length * 8, // bits
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
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
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
