/**
 * Key manager interface and types.
 */

export interface KeyDerivationParams {
  chainId: number;
  entryPoint: `0x${string}`;
  safeAddress: `0x${string}`;
}

export interface DerivedEOA {
  address: `0x${string}`;
  /** Only available in local mode — KMS/HSM won't expose this. */
  privateKey?: `0x${string}`;
}

/**
 * Abstract key manager interface.
 * Implementations: LocalKeyManager (env secret), future KMS/HSM/MPC.
 */
export interface KeyManager {
  /**
   * Derive the dedicated bundler EOA for the given parameters.
   * Must be deterministic: same inputs always produce the same address.
   */
  deriveEOA(params: KeyDerivationParams): Promise<DerivedEOA>;

  /**
   * Get all old operator secrets (for sweeping draining EOAs).
   * Returns secret strings — never log or expose.
   */
  getOldSecrets(): string[];
}
