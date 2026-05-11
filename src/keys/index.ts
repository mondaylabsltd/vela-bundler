/**
 * Deterministic key derivation for dedicated bundler EOAs.
 *
 * Derives a unique secp256k1 private key per (chainId, entryPoint, safeAddress, keyVersion)
 * using HKDF-SHA256 with domain separation.
 *
 * The KeyManager interface allows future replacement with KMS/HSM/MPC backends.
 */

export { type KeyManager, type DerivedEOA, type KeyDerivationParams } from "./types.ts";
export { LocalKeyManager } from "./local.ts";
export { deriveEOAPrivateKey, deriveEOAAddress } from "./derive.ts";
