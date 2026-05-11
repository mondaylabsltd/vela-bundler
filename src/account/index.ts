/**
 * Account service — manages dedicated bundler EOAs, balances, and status.
 *
 * No database. All state is derived on-the-fly from:
 * - Deterministic key derivation (chainId + entryPoint + safeAddress + keyVersion)
 * - On-chain balance queries (eth_getBalance)
 * - In-memory reservations (lost on restart)
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import type { KeyManager, KeyDerivationParams, DerivedEOA } from "../keys/types.ts";
import { EOALockManager, type EOAStatus, type EOAState } from "./eoa-lock.ts";
import type { BundlerConfig } from "../config/index.ts";
import { getPublicClient } from "../utils/rpc-client.ts";

export { EOALockManager, type EOAStatus, type EOAState } from "./eoa-lock.ts";

export interface AccountInfo {
  chainId: number;
  entryPoint: `0x${string}`;
  safeAddress: `0x${string}`;
  activeDepositAddress: `0x${string}`;
  oldDrainingAddresses: `0x${string}`[];
  keyVersion: string;
  onchainBalance: bigint;
  reservedBalance: bigint;
  spendableBalance: bigint;
  latestNonce: number;
  pendingNonce: number;
  status: EOAStatus;
}

export class AccountService {
  readonly lockManager: EOALockManager;
  private readonly keyManager: KeyManager;
  private readonly config: BundlerConfig;
  private readonly client: PublicClient<Transport, Chain>;

  /** Balance reserve multiplier — require N× expected cost in balance. */
  readonly balanceReserveMultiplier: number;

  constructor(params: {
    keyManager: KeyManager;
    config: BundlerConfig;
    balanceReserveMultiplier?: number;
  }) {
    this.keyManager = params.keyManager;
    this.config = params.config;
    this.lockManager = new EOALockManager();
    this.balanceReserveMultiplier = params.balanceReserveMultiplier ?? 2;
    this.client = createPublicClient({
      transport: http(params.config.rpcUrl),
    }) as PublicClient<Transport, Chain>;
  }

  /**
   * Derive the dedicated bundler EOA for a given safeAddress.
   */
  async deriveEOA(
    safeAddress: `0x${string}`,
    keyVersion?: string,
  ): Promise<DerivedEOA> {
    const version = keyVersion ?? this.keyManager.getActiveKeyVersion();
    return await this.keyManager.deriveEOA({
      chainId: this.config.chainId,
      entryPoint: this.config.entryPointAddress,
      safeAddress,
      keyVersion: version,
    });
  }

  /**
   * Get full account info for a safeAddress.
   * @param safeAddress - The ERC-4337 smart account address.
   * @param rpcUrlOverride - Optional per-request RPC URL (highest priority for balance queries).
   */
  async getAccountInfo(
    safeAddress: `0x${string}`,
    rpcUrlOverride?: string,
  ): Promise<AccountInfo> {
    const normalizedSafe = safeAddress.toLowerCase() as `0x${string}`;
    const activeVersion = this.keyManager.getActiveKeyVersion();
    const drainingVersions = this.keyManager.getDrainingKeyVersions();

    // Use override client if provided, otherwise default
    const queryClient = rpcUrlOverride
      ? getPublicClient(rpcUrlOverride)
      : this.client;

    // Derive active EOA
    const activeEOA = await this.deriveEOA(normalizedSafe, activeVersion);

    // Derive old draining EOAs
    const oldAddresses: `0x${string}`[] = [];
    for (const oldVersion of drainingVersions) {
      const oldEOA = await this.deriveEOA(normalizedSafe, oldVersion);
      oldAddresses.push(oldEOA.address);
    }

    // Query on-chain balance (uses override client if provided)
    let onchainBalance: bigint;
    try {
      onchainBalance = await queryClient.getBalance({ address: activeEOA.address });
    } catch {
      onchainBalance = 0n;
    }

    // Get in-memory reservation
    const reservedBalance = this.lockManager.getReservedBalance(activeEOA.address);

    // Spendable = onchain - reserved
    const spendableBalance = onchainBalance > reservedBalance
      ? onchainBalance - reservedBalance
      : 0n;

    // Init/refresh EOA state (nonce check — uses override client)
    const eoaState = await this.lockManager.initEOA(activeEOA.address, queryClient);

    // Determine status
    let status: EOAStatus = eoaState.status;
    if (status === "ACTIVE" && spendableBalance === 0n) {
      status = "INSUFFICIENT_BALANCE";
    }

    return {
      chainId: this.config.chainId,
      entryPoint: this.config.entryPointAddress,
      safeAddress: normalizedSafe,
      activeDepositAddress: activeEOA.address,
      oldDrainingAddresses: oldAddresses,
      keyVersion: activeVersion,
      onchainBalance,
      reservedBalance,
      spendableBalance,
      latestNonce: eoaState.latestNonce,
      pendingNonce: eoaState.pendingNonce,
      status,
    };
  }

  /**
   * Check if a safeAddress has sufficient balance for a bundle.
   */
  async checkBalance(
    safeAddress: `0x${string}`,
    expectedCost: bigint,
  ): Promise<{ sufficient: boolean; spendableBalance: bigint; requiredBalance: bigint }> {
    const eoa = await this.deriveEOA(safeAddress);
    const onchainBalance = await this.getOnchainBalance(eoa.address);
    const reservedBalance = this.lockManager.getReservedBalance(eoa.address);
    const spendableBalance = onchainBalance > reservedBalance
      ? onchainBalance - reservedBalance
      : 0n;

    const requiredBalance = expectedCost * BigInt(this.balanceReserveMultiplier);
    return {
      sufficient: spendableBalance >= requiredBalance,
      spendableBalance,
      requiredBalance,
    };
  }

  /**
   * Reserve balance for a pending bundle.
   */
  reserveBalance(eoaAddress: `0x${string}`, amount: bigint): void {
    this.lockManager.addReservation(eoaAddress, amount);
  }

  /**
   * Release balance reservation after bundle completion.
   */
  releaseBalance(eoaAddress: `0x${string}`, amount: bigint): void {
    this.lockManager.releaseReservation(eoaAddress, amount);
  }

  /**
   * Check if the key version is the active version (not draining).
   */
  isActiveVersion(keyVersion: string): boolean {
    return keyVersion === this.keyManager.getActiveKeyVersion();
  }

  /**
   * Get the key manager (for signing).
   */
  getKeyManager(): KeyManager {
    return this.keyManager;
  }

  /**
   * Get on-chain native balance for an address.
   */
  async getOnchainBalance(address: `0x${string}`): Promise<bigint> {
    try {
      return await this.client.getBalance({ address });
    } catch {
      return 0n;
    }
  }

  /**
   * Get the public client (for external use).
   */
  getClient(): PublicClient<Transport, Chain> {
    return this.client;
  }
}
