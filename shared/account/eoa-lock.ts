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
  /** Epoch ms when this EOA entered LOCKED_PENDING_UNKNOWN — used to detect a *stuck* EOA
   *  (locked too long → a user's funds can't move → operator alert). undefined when ACTIVE. */
  lockedSince?: number;
}

/**
 * Manages per-EOA locks, nonce tracking, and balance reservations.
 * All state is in-memory — lost on restart.
 */
/** Max distinct EOA states retained. A flood of distinct UserOp.sender values would
 *  otherwise grow `states` without bound (memory exhaustion). Bounded by evicting the
 *  oldest SAFE-to-drop entry (ACTIVE, no reservation, not bundling) — its state is
 *  re-derived from chain on next use, so eviction is lossless for idle EOAs. */
const MAX_EOA_STATES = 20_000;

export class EOALockManager {
  private states: Map<string, EOAState> = new Map();

  private key(address: `0x${string}`): string {
    return address.toLowerCase();
  }

  /** Evict the oldest entry that carries no in-flight state (never drops a locked/reserved
   *  EOA — that would risk a double-submit). No-op if every entry is in-flight. */
  private evictIfNeeded(incomingKey: string): void {
    if (this.states.size < MAX_EOA_STATES || this.states.has(incomingKey)) return;
    for (const [k, s] of this.states) {
      if (s.status === "ACTIVE" && !s.bundleLock && s.reservedBalance === 0n) {
        this.states.delete(k);
        return;
      }
    }
    // All entries are in-flight (locked/reserved) — keep them; this is bounded in practice
    // because an in-flight state requires an actual on-chain submission (gas + balance).
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
      // Preserve the original lock timestamp if still locked; clear it once recovered to ACTIVE.
      lockedSince: status === "LOCKED_PENDING_UNKNOWN"
        ? (existing?.lockedSince ?? Date.now())
        : undefined,
    };

    this.evictIfNeeded(k);
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
      if (state.status !== "LOCKED_PENDING_UNKNOWN") state.lockedSince = Date.now();
      state.status = reason;
    }
  }

  /**
   * Restore an EOA's in-flight state after a durable-storage reload (CF Worker DO eviction):
   * mark it LOCKED_PENDING_UNKNOWN and carry the persisted reservation, CREATING the state if
   * none exists. Unlike addReservation/lockEOA (which no-op on an absent state), this must
   * work against the freshly-constructed, empty lock manager a cold-started DO builds — that
   * is precisely when the anti-double-spend lock + reservation would otherwise be silently
   * lost. The placeholder nonces are overwritten by the next initEOA (health loop / recovery).
   */
  restorePending(address: `0x${string}`, reservedBalance: bigint): void {
    const k = this.key(address);
    const existing = this.states.get(k);
    if (existing) {
      if (existing.status !== "LOCKED_PENDING_UNKNOWN") existing.lockedSince = Date.now();
      existing.status = "LOCKED_PENDING_UNKNOWN";
      if (reservedBalance > existing.reservedBalance) existing.reservedBalance = reservedBalance;
      return;
    }
    this.evictIfNeeded(k);
    this.states.set(k, {
      address: address.toLowerCase() as `0x${string}`,
      status: "LOCKED_PENDING_UNKNOWN",
      latestNonce: 0,
      pendingNonce: 0,
      reservedBalance,
      bundleLock: false,
      lockedSince: Date.now(),
    });
  }

  getLockedEOAs(): EOAState[] {
    return Array.from(this.states.values()).filter(
      (s) => s.status === "LOCKED_PENDING_UNKNOWN",
    );
  }

  /** Age (ms) of the EOA that has been LOCKED_PENDING_UNKNOWN the longest, or 0 if none.
   *  A large value means a user's funds have been unmovable for that long → operator alert. */
  oldestLockedAgeMs(now: number = Date.now()): number {
    let oldest = 0;
    for (const s of this.states.values()) {
      if (s.status !== "LOCKED_PENDING_UNKNOWN") continue;
      const age = now - (s.lockedSince ?? now);
      if (age > oldest) oldest = age;
    }
    return oldest;
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
