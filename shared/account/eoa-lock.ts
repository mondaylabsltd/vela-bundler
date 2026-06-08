/**
 * Per-EOA concurrency control.
 *
 * - Per-EOA mutex: only one handleOps tx in flight at a time.
 * - Nonce tracking: detect unknown pending txs on restart.
 * - Pending reservation tracking: atomic balance reservation.
 */

import { type PublicClient, type Transport, type Chain } from "viem";
import { withTimeout, RPC_TIMEOUT_MS } from "../utils/timeout.ts";

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

  private key(address: `0x${string}`): string {
    return address.toLowerCase();
  }

  /**
   * Initialize or refresh EOA state from on-chain nonce data.
   *
   * Nonce logic:
   * - If both latest and pending nonces match → ACTIVE
   * - If pending > latest → there's an in-flight tx we don't know about → LOCKED
   * - If pending nonce query fails → assume same as latest (many RPCs don't support "pending")
   * - All RPC calls have 5s timeout to avoid blocking
   */
  async initEOA(
    address: `0x${string}`,
    client: PublicClient<Transport, Chain>,
  ): Promise<EOAState> {
    const k = this.key(address);

    let latestNonce: number;
    let pendingNonce: number;

    try {
      latestNonce = await withTimeout(
        client.getTransactionCount({ address, blockTag: "latest" }),
        RPC_TIMEOUT_MS,
        "getTransactionCount(latest)",
      );
    } catch (err) {
      // Use existing state nonce if RPC fails, fall back to 0 only for new EOAs
      const existing = this.states.get(k);
      latestNonce = existing?.latestNonce ?? 0;
      console.warn(`[EOALock] getTransactionCount(latest) failed for ${address}, using cached nonce=${latestNonce}: ${err instanceof Error ? err.message : err}`);
    }

    try {
      pendingNonce = await withTimeout(
        client.getTransactionCount({ address, blockTag: "pending" }),
        RPC_TIMEOUT_MS,
        "getTransactionCount(pending)",
      );
    } catch {
      // Many RPCs don't support "pending" reliably.
      // Default to same as latest — treat as no pending txs.
      // The bundler itself tracks its own in-flight txs via bundleLock.
      pendingNonce = latestNonce;
    }

    let status: EOAStatus = "ACTIVE";
    if (pendingNonce > latestNonce) {
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

  getState(address: `0x${string}`): EOAState | undefined {
    return this.states.get(this.key(address));
  }

  isAvailable(address: `0x${string}`): boolean {
    const state = this.states.get(this.key(address));
    if (!state) return false;
    return state.status === "ACTIVE" && !state.bundleLock;
  }

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

  releaseBundleLock(address: `0x${string}`): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (!state) return;

    state.bundleLock = false;
    if (state.status === "LOCKED_IN_MEMORY_PENDING") {
      state.status = "ACTIVE";
    }
  }

  addReservation(address: `0x${string}`, amount: bigint): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (!state) return;
    state.reservedBalance += amount;
  }

  releaseReservation(address: `0x${string}`, amount: bigint): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (!state) return;
    state.reservedBalance = state.reservedBalance > amount
      ? state.reservedBalance - amount
      : 0n;
  }

  getReservedBalance(address: `0x${string}`): bigint {
    return this.states.get(this.key(address))?.reservedBalance ?? 0n;
  }

  lockEOA(address: `0x${string}`, reason: "LOCKED_PENDING_UNKNOWN"): void {
    const k = this.key(address);
    const state = this.states.get(k);
    if (state) {
      state.status = reason;
    }
  }

  getLockedEOAs(): EOAState[] {
    return Array.from(this.states.values()).filter(
      (s) => s.status === "LOCKED_PENDING_UNKNOWN",
    );
  }

  async tryRecoverEOA(
    address: `0x${string}`,
    client: PublicClient<Transport, Chain>,
  ): Promise<boolean> {
    const refreshed = await this.initEOA(address, client);
    return refreshed.status === "ACTIVE";
  }

  clear(): void {
    this.states.clear();
  }
}
