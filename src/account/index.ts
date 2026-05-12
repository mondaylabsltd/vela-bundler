/**
 * Account service — manages dedicated bundler EOAs, balances, and status.
 *
 * No database. All state is derived on-the-fly from:
 * - Deterministic key derivation (chainId + entryPoint + safeAddress + operatorSecret)
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
import type { KeyManager, DerivedEOA } from "../keys/types.ts";
import { deriveEOAAddress } from "../keys/derive.ts";
import { EOALockManager, type EOAStatus } from "./eoa-lock.ts";
import type { BundlerConfig } from "../config/index.ts";
import { getPublicClient } from "../utils/rpc-client.ts";
import { withTimeout, RPC_TIMEOUT_MS } from "../utils/timeout.ts";

export { EOALockManager, type EOAStatus, type EOAState } from "./eoa-lock.ts";

export interface AccountInfo {
  chainId: number;
  entryPoint: `0x${string}`;
  safeAddress: `0x${string}`;
  activeDepositAddress: `0x${string}`;
  /** Addresses derived from old operator secrets (draining, sweep only). */
  oldDepositAddresses: `0x${string}`[];
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
   * Derive the dedicated bundler EOA for a given safeAddress (current secret).
   */
  async deriveEOA(safeAddress: `0x${string}`): Promise<DerivedEOA> {
    return await this.keyManager.deriveEOA({
      chainId: this.config.chainId,
      entryPoint: this.config.entryPointAddress,
      safeAddress,
    });
  }

  /**
   * Get full account info for a safeAddress.
   * @param safeAddress - The ERC-4337 smart account address.
   * @param rpcUrlOverride - Optional per-request RPC URL override.
   */
  async getAccountInfo(
    safeAddress: `0x${string}`,
    rpcUrlOverride?: string,
  ): Promise<AccountInfo> {
    const normalizedSafe = safeAddress.toLowerCase() as `0x${string}`;
    const queryClient = rpcUrlOverride
      ? getPublicClient(rpcUrlOverride)
      : this.client;

    // Derive active EOA (current secret)
    const activeEOA = await this.deriveEOA(normalizedSafe);

    // Derive old EOAs (from old secrets, for display/sweep)
    const oldAddresses: `0x${string}`[] = [];
    for (const oldSecret of this.keyManager.getOldSecrets()) {
      const oldAddr = await deriveEOAAddress(
        oldSecret,
        this.config.chainId,
        this.config.entryPointAddress,
        normalizedSafe,
      );
      oldAddresses.push(oldAddr);
    }

    // Query on-chain balance (with timeout) — throws on RPC failure
    const onchainBalance = await withTimeout(
      queryClient.getBalance({ address: activeEOA.address }),
      RPC_TIMEOUT_MS,
      "getBalance",
    );

    // Get in-memory reservation
    const reservedBalance = this.lockManager.getReservedBalance(activeEOA.address);

    // Spendable = onchain - reserved
    const spendableBalance = onchainBalance > reservedBalance
      ? onchainBalance - reservedBalance
      : 0n;

    // Init/refresh EOA state (nonce check)
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
      oldDepositAddresses: oldAddresses,
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
   * Throws on RPC failure — caller should handle the error.
   */
  async checkBalance(
    safeAddress: `0x${string}`,
    expectedCost: bigint,
    rpcUrlOverride?: string,
  ): Promise<{ sufficient: boolean; spendableBalance: bigint; requiredBalance: bigint }> {
    const eoa = await this.deriveEOA(safeAddress);
    const onchainBalance = await this.getOnchainBalance(eoa.address, rpcUrlOverride);
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

  reserveBalance(eoaAddress: `0x${string}`, amount: bigint): void {
    this.lockManager.addReservation(eoaAddress, amount);
  }

  releaseBalance(eoaAddress: `0x${string}`, amount: bigint): void {
    this.lockManager.releaseReservation(eoaAddress, amount);
  }

  getKeyManager(): KeyManager {
    return this.keyManager;
  }

  async getOnchainBalance(
    address: `0x${string}`,
    rpcUrlOverride?: string,
  ): Promise<bigint> {
    const client = rpcUrlOverride
      ? getPublicClient(rpcUrlOverride)
      : this.client;
    return await withTimeout(
      client.getBalance({ address }),
      RPC_TIMEOUT_MS,
      "getBalance",
    );
  }

  getClient(): PublicClient<Transport, Chain> {
    return this.client;
  }
}
