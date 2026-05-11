/**
 * Key manager interface and types.
 */

export interface KeyDerivationParams {
  chainId: number;
  entryPoint: `0x${string}`;
  safeAddress: `0x${string}`;
  keyVersion: string;
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
   * Sign a transaction hash with the derived EOA's key.
   * For KMS/HSM backends, this calls the remote signer.
   */
  signTransaction(
    params: KeyDerivationParams,
    serializedTx: Uint8Array,
  ): Promise<`0x${string}`>;

  /**
   * Get the current active key version.
   */
  getActiveKeyVersion(): string;

  /**
   * Get old key versions that are draining (no new ops, but still queryable).
   */
  getDrainingKeyVersions(): string[];
}
