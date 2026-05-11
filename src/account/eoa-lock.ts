/**
 * Per-EOA concurrency control.
 *
 * - Per-EOA mutex: only one handleOps tx in flight at a time.
 * - Nonce tracking: detect unknown pending txs on restart.
 * - Pending reservation tracking: atomic balance reservation.
 */

import { createPublicClient, http, type PublicClient, type Transport, type Chain } from "viem";

export type EOAStatus =
  | "ACTIVE"
  | "INSUFFICIENT_BALANCE"
  | "LOCKED_PENDING_UNKNOWN"
  | "LOCKED_IN_MEMORY_PENDING";

export interface EOAState {
  address: `0x${string}`;
  status: EOAStatus;
  latestNonce: number;
  pendingNonce: number;
  /** In-memory reservation for pending bundles (wei). */
  reservedBalance: bigint;
  /** Whether this EOA has a bundle currently being prepared/submitted. */
  bundleLock: boolean;
}

/**
 * Manages per-EOA locks, nonce tracking, and balance reservations.
 * All state is in-memory — lost on restart.
 */
export class EOALockManager {
  private states: Map<string, EOAState> = new Map();
  private mutexes: Map<string, Promise<void>> = new Map();
  private mutexResolvers: Map<string, () => void> = new Map();

  private key(address: `0x${string}`): string {
    return address.toLowerCase();
  }

  /**
   * Initialize or refresh EOA state from on-chain nonce data.
   * Call this on startup and periodically.
   */
  async initEOA(
    address: `0x${string}`,
    client: PublicClient<Transport, Chain>,
  ): Promise<EOAState> {
    const k = this.key(address);

    let latestNonce: number;
    let pendingNonce: number;

    try {
      // latest = confirmed nonce
      latestNonce = await client.getTransactionCount({
        address,
        blockTag: "latest",
      });
    } catch {
      latestNonce = 0;
    }

    try {
      // pending = includes pending pool txs
      pendingNonce = await client.getTransactionCount({
        address,
        blockTag: "pending",
      });
    } catch {
      // If RPC doesn't support reliable pending nonce, fail closed
      pendingNonce = latestNonce + 1; // Force lock
    }

    let status: EOAStatus = "ACTIVE";
    if (pendingNonce > latestNonce) {
      // Unknown pending transactions — lock this EOA
      status = "LOCKED_PENDING_UNKNOWN";
    }

    const existing = this.states.get(k);
    const state: EOAState = {
      address: address.toLowerCase() as `0x${string}`,
      status,
      latestNonce,
      pendingNonce,
      reservedBalance: existing?.reservedBalance ?? 0n,
      bundleLock: existing?.bundleLock ?? false,
    };

    this.states.set(k, state);
    return state;
  }

  /**
   * Get current state for an EOA (without refreshing from chain).
   */
  getState(address: `0x${string}`): EOAState | undefined {
    return this.states.get(this.key(address));
  }

  /**
   * Check if an EOA is available for a new bundle.
   */
  isAvailable(address: `0x${string}`): boolean {
    const state = this.states.get(this.key(address));
    if (!state) return false;
    return state.status === "ACTIVE" && !state.bundleLock;
  }

  /**
   * Acquire the bundle lock for an EOA.
   * Returns false if the EOA is not available.
   */
  acquireBundleLock(address: `0x${string}`): boolean {
    const k = this.key(address);
    const state = this.states.get(k);
    if (!state) return false;
    if (state.status !== "ACTIVE") return false;
    if (state.bundleLock) return false;

    state.bundleLock = true;
    state.status = "LOCKED_IN_MEMORY_PENDING";
    return true;
  }

  /**
   * Release the bundle lock after a bundle completes (success or failure).
   */
  releaseBundleLock(address: `0x${string}`): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (!state) return;

    state.bundleLock = false;
    if (state.status === "LOCKED_IN_MEMORY_PENDING") {
      state.status = "ACTIVE";
    }
  }

  /**
   * Add a balance reservation (before submitting a bundle).
   */
  addReservation(address: `0x${string}`, amount: bigint): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (!state) return;
    state.reservedBalance += amount;
  }

  /**
   * Release a balance reservation (after bundle confirmed or failed).
   */
  releaseReservation(address: `0x${string}`, amount: bigint): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (!state) return;
    state.reservedBalance = state.reservedBalance > amount
      ? state.reservedBalance - amount
      : 0n;
  }

  /**
   * Get reserved balance for an EOA.
   */
  getReservedBalance(address: `0x${string}`): bigint {
    return this.states.get(this.key(address))?.reservedBalance ?? 0n;
  }

  /**
   * Mark an EOA as locked due to uncertain state.
   */
  lockEOA(address: `0x${string}`, reason: "LOCKED_PENDING_UNKNOWN"): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (state) {
      state.status = reason;
      state.bundleLock = true;
    }
  }

  /**
   * Attempt to recover a locked EOA by re-checking nonce state.
   */
  async tryRecoverEOA(
    address: `0x${string}`,
    client: PublicClient<Transport, Chain>,
  ): Promise<boolean> {
    const refreshed = await this.initEOA(address, client);
    return refreshed.status === "ACTIVE";
  }

  /**
   * Clear all state (for testing).
   */
  clear(): void {
    this.states.clear();
    this.mutexes.clear();
    this.mutexResolvers.clear();
  }
}
