/**
 * In-memory mempool for pending UserOperations.
 *
 * Rules:
 * - One pending UserOp per sender (unless sender is staked, in which case
 *   multiple are allowed up to a limit).
 * - Replacement: same sender+nonce only if maxPriorityFeePerGas increases
 *   AND maxFeePerGas increases by at least the same delta.
 * - Track sender, factory, paymaster reputation.
 * - Reject banned/throttled entities.
 * - Check paymaster deposit reservation across pending UserOps.
 */

import type { MempoolEntry, UserOperation } from "../userop/types.ts";
import { packUserOp } from "../userop/pack.ts";
import { getUserOpHash } from "../userop/hash.ts";
import { normalizeUserOp, userOpToRpc } from "../userop/normalize.ts";
import { ReputationManager } from "./reputation.ts";
import { RPC_ERROR_CODES } from "../contracts/entrypoint.ts";
import { UserOpValidationError } from "../userop/validate.ts";
import { isEmptyHex } from "../utils/hex.ts";

/** Message of the TRANSIENT capacity rejection thrown by add() when the mempool is at
 *  maxMempoolSize. Unlike a one-op-per-sender / reputation rejection, this CLEARS as bundles
 *  land — callers (the queue relayerSubmit) must retry it, NOT store a terminal failed receipt. */
export const MEMPOOL_FULL_MESSAGE = "Mempool is full";

/** True when `err` is the transient mempool-full rejection (safe to retry). */
export function isMempoolFullError(err: unknown): boolean {
  return err instanceof Error && err.message === MEMPOOL_FULL_MESSAGE;
}
import { calcUserOpMaxGas } from "../gas/profitability.ts";

export { ReputationManager, type EntityStatus, type ReputationEntry } from "./reputation.ts";

export interface MempoolConfig {
  entryPointAddress: `0x${string}`;
  chainId: number;
  maxMempoolSize: number;
  /** Allow multiple pending ops from staked senders. */
  stakedSenderMaxOps: number;
}

const MIN_REPLACEMENT_FEE_INCREASE_PERCENT = 10n; // 10% minimum increase

/** JSON-safe form of a MempoolEntry for DO storage. The op round-trips through its RPC hex
 *  form (userOpToRpc → normalizeUserOp); `packed` and the hash are re-derived on restore. */
export interface SerializedMempoolEntry {
  rpcUserOp: Record<string, unknown>;
  prefund: string;
  addedAt: number;
  firstSeenAt: number;
  rpcUrlOverride?: string;
}

export function serializeMempoolEntry(e: MempoolEntry): SerializedMempoolEntry {
  return {
    rpcUserOp: userOpToRpc(e.userOp),
    prefund: e.prefund.toString(),
    addedAt: e.addedAt,
    firstSeenAt: e.firstSeenAt ?? e.addedAt,
    rpcUrlOverride: e.rpcUrlOverride,
  };
}

export function deserializeMempoolEntry(
  s: SerializedMempoolEntry,
  entryPointAddress: `0x${string}`,
  chainId: number,
): MempoolEntry {
  const userOp = normalizeUserOp(s.rpcUserOp);
  const packed = packUserOp(userOp);
  return {
    userOp,
    packed,
    userOpHash: getUserOpHash(packed, entryPointAddress, chainId),
    prefund: BigInt(s.prefund),
    addedAt: s.addedAt,
    firstSeenAt: s.firstSeenAt,
    rpcUrlOverride: s.rpcUrlOverride,
  };
}

/** Mempool entry TTL — 5 minutes. Stale ops are evicted to prevent unbounded buildup. */
const MEMPOOL_ENTRY_TTL_MS = 5 * 60 * 1000;

export class Mempool {
  /** Map from userOpHash to MempoolEntry. */
  private entries: Map<string, MempoolEntry> = new Map();
  /** Map from sender to set of userOpHashes. */
  private bySender: Map<string, Set<string>> = new Map();
  /** Map from sender+nonce to userOpHash for replacement tracking. */
  private bySenderNonce: Map<string, `0x${string}`> = new Map();
  /** Paymaster deposit reservations: paymaster -> total reserved gas cost. */
  private paymasterReservations: Map<string, bigint> = new Map();

  readonly reputation: ReputationManager;
  private readonly config: MempoolConfig;

  constructor(config: MempoolConfig) {
    this.config = config;
    this.reputation = new ReputationManager();
  }

  /**
   * Add a UserOperation to the mempool.
   * Returns the userOpHash on success.
   */
  add(userOp: UserOperation, prefund: bigint = 0n, rpcUrlOverride?: string): `0x${string}` {
    const packed = packUserOp(userOp);
    const hash = getUserOpHash(
      packed,
      this.config.entryPointAddress,
      this.config.chainId,
    );

    // Check reputation of involved entities
    this.checkEntityReputation(userOp);

    // Check sender limit / replacement
    const senderKey = userOp.sender.toLowerCase();
    const senderNonceKey = `${senderKey}:${userOp.nonce.toString()}`;
    const existingHash = this.bySenderNonce.get(senderNonceKey);

    // Preserved across replacements: the stuck-mempool age and the TTL are measured from the
    // FIRST sighting of this (sender,nonce), so a perpetually fee-bumping wallet can neither
    // mask the stuck alert nor keep an unbundleable op alive past the TTL.
    let firstSeenAt = Date.now();

    if (existingHash) {
      // Replacement: validate fee increase
      const existing = this.entries.get(existingHash);
      if (existing) {
        this.validateReplacement(existing.userOp, userOp, existingHash);
        firstSeenAt = existing.firstSeenAt ?? existing.addedAt;
        // Remove old entry
        this.removeEntry(existingHash);
      }
    } else {
      // New op from this sender — check limits
      const senderOps = this.bySender.get(senderKey);
      if (senderOps && senderOps.size >= 1) {
        // Include existing hash so the wallet can poll for its receipt
        const pendingHash = senderOps.values().next().value;
        throw new UserOpValidationError(
          `Already have a pending UserOperation from this sender [existingHash:${pendingHash}]`,
          RPC_ERROR_CODES.INVALID_USEROPERATION,
        );
      }
    }

    // Check mempool size
    if (this.entries.size >= this.config.maxMempoolSize) {
      throw new UserOpValidationError(
        MEMPOOL_FULL_MESSAGE,
        RPC_ERROR_CODES.INVALID_USEROPERATION,
      );
    }

    // Store entry
    const entry: MempoolEntry = {
      userOp,
      packed,
      userOpHash: hash,
      prefund,
      addedAt: Date.now(),
      firstSeenAt,
      rpcUrlOverride,
    };
    this.entries.set(hash, entry);

    // Update indexes
    if (!this.bySender.has(senderKey)) {
      this.bySender.set(senderKey, new Set());
    }
    this.bySender.get(senderKey)!.add(hash);
    this.bySenderNonce.set(senderNonceKey, hash);

    // Update reputation
    this.reputation.updateSeen(userOp.sender, "sender");
    if (userOp.factory && !isEmptyHex(userOp.factory)) {
      this.reputation.updateSeen(userOp.factory, "factory");
    }
    if (userOp.paymaster && !isEmptyHex(userOp.paymaster)) {
      this.reputation.updateSeen(userOp.paymaster, "paymaster");
      // Reserve paymaster deposit
      this.reservePaymasterDeposit(userOp);
    }

    try {
      this.persistHooks?.put(entry);
    } catch { /* persistence must never break acceptance */ }

    return hash;
  }

  /**
   * Remove a UserOperation from the mempool.
   */
  remove(userOpHash: string): boolean {
    return this.removeEntry(userOpHash);
  }

  private removeEntry(userOpHash: string): boolean {
    const entry = this.entries.get(userOpHash);
    if (!entry) return false;

    const senderKey = entry.userOp.sender.toLowerCase();
    const senderNonceKey = `${senderKey}:${entry.userOp.nonce.toString()}`;

    this.entries.delete(userOpHash);
    this.bySender.get(senderKey)?.delete(userOpHash);
    if (this.bySender.get(senderKey)?.size === 0) {
      this.bySender.delete(senderKey);
    }
    this.bySenderNonce.delete(senderNonceKey);

    // Release paymaster reservation
    if (entry.userOp.paymaster && !isEmptyHex(entry.userOp.paymaster)) {
      this.releasePaymasterDeposit(entry.userOp);
    }

    try {
      this.persistHooks?.delete(userOpHash);
    } catch { /* persistence must never break removal */ }

    return true;
  }

  /**
   * Get a mempool entry by hash.
   */
  get(userOpHash: string): MempoolEntry | undefined {
    return this.entries.get(userOpHash);
  }

  /**
   * Get all pending entries, evicting stale ones first.
   */
  getAll(): MempoolEntry[] {
    const now = Date.now();
    for (const [hash, entry] of this.entries) {
      // TTL from the FIRST sighting of this (sender,nonce): a replacement must not be able
      // to keep an unbundleable op alive forever (each bump would otherwise reset the clock).
      if (now - (entry.firstSeenAt ?? entry.addedAt) > MEMPOOL_ENTRY_TTL_MS) {
        this.removeEntry(hash);
        // Notify (bundler stores a terminal success=false receipt) so a TTL-dropped op is NOT
        // silently lost — the wallet gets a definitive "failed, resubmit" instead of polling null
        // forever and mistaking a drop for a pending/successful inclusion. Non-fatal on error.
        try {
          this.onTtlEvict?.(entry);
        } catch { /* hook must never break bundling */ }
      }
    }
    return Array.from(this.entries.values());
  }

  /** Set a hook invoked with each entry evicted for exceeding its TTL (see getAll). */
  setTtlEvictionHook(fn: (entry: MempoolEntry) => void): void {
    this.onTtlEvict = fn;
  }
  private onTtlEvict?: (entry: MempoolEntry) => void;

  /**
   * Durable-storage hooks (CF Worker mode): every accepted op is persisted and every
   * removal deletes it, so a DO eviction / deploy cannot silently vanish an accepted,
   * not-yet-bundled op (the wallet would poll null forever — worse than any failure).
   * Hooks are fire-and-forget and must never break mempool operations.
   */
  setPersistenceHooks(hooks: {
    put: (entry: MempoolEntry) => void;
    delete: (userOpHash: string) => void;
  }): void {
    this.persistHooks = hooks;
  }
  private persistHooks?: { put: (entry: MempoolEntry) => void; delete: (userOpHash: string) => void };

  /**
   * Re-insert a previously-accepted entry after a DO cold start — bypasses reputation and
   * sender-limit checks (the op already passed them when first accepted) but re-runs the
   * structural indexing. Returns false when a fresher entry for the same (sender,nonce)
   * already exists (e.g. the wallet re-submitted while the DO was cold).
   */
  restoreEntry(entry: MempoolEntry): boolean {
    const senderKey = entry.userOp.sender.toLowerCase();
    const senderNonceKey = `${senderKey}:${entry.userOp.nonce.toString()}`;
    if (this.bySenderNonce.has(senderNonceKey) || this.entries.has(entry.userOpHash)) return false;
    if (this.entries.size >= this.config.maxMempoolSize) return false;
    this.entries.set(entry.userOpHash, entry);
    if (!this.bySender.has(senderKey)) this.bySender.set(senderKey, new Set());
    this.bySender.get(senderKey)!.add(entry.userOpHash);
    this.bySenderNonce.set(senderNonceKey, entry.userOpHash);
    if (entry.userOp.paymaster && !isEmptyHex(entry.userOp.paymaster)) {
      this.reservePaymasterDeposit(entry.userOp);
    }
    return true;
  }

  /**
   * Get the number of pending entries.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Age (ms) of the oldest pending entry, or 0 if the mempool is empty. Surfaced in
   * /health so a stuck backlog (ops not being bundled) is observable before it grows.
   */
  oldestEntryAgeMs(now: number = Date.now()): number {
    let oldest = 0;
    for (const entry of this.entries.values()) {
      // Age from the FIRST sighting (survives replacements) — a fee-bumping wallet must not
      // be able to mask the stuck-mempool alert by resetting the clock every bump.
      const age = now - (entry.firstSeenAt ?? entry.addedAt);
      if (age > oldest) oldest = age;
    }
    return oldest;
  }

  /**
   * Clear all entries (debug RPC).
   */
  clear(): void {
    this.entries.clear();
    this.bySender.clear();
    this.bySenderNonce.clear();
    this.paymasterReservations.clear();
    this.reputation.clear();
  }

  /**
   * Dump all entries (debug RPC).
   */
  dump(): MempoolEntry[] {
    return this.getAll();
  }

  /**
   * Check whether the paymaster has enough unreserved deposit for this UserOp.
   */
  getPaymasterReserved(paymaster: `0x${string}`): bigint {
    return this.paymasterReservations.get(paymaster.toLowerCase()) ?? 0n;
  }

  private checkEntityReputation(userOp: UserOperation): void {
    // NOTE: senders are NOT hard-banned in this custodial model. Reputation bans exist to protect
    // a SHARED public mempool from a griefing sender; here every sender is a user's own Safe bound
    // to its own dedicated EOA, spending only its own funds — a "bad" sender can at most waste one
    // simulation per cycle (bounded by the 1-pending-op throttle below). Banning it would instead
    // fully block a real user from moving their money (the exact failure we must never cause), and
    // that block would be invisible. So we keep only the (non-blocking) throttle for senders and
    // surface a reputation-blocked alert from the operational monitor. Factory/paymaster — shared
    // entities that CAN grief the mempool — remain bannable below.
    if (
      this.reputation.isBanned(userOp.sender, "sender") ||
      this.reputation.isThrottled(userOp.sender, "sender")
    ) {
      // Throttled/penalized senders can have at most 1 pending op (rate limit, not a block).
      const senderOps = this.bySender.get(userOp.sender.toLowerCase());
      if (senderOps && senderOps.size > 0) {
        throw new UserOpValidationError(
          "Sender already has a pending UserOperation (rate-limited)",
          RPC_ERROR_CODES.THROTTLED_OR_BANNED,
        );
      }
    }

    if (userOp.factory && !isEmptyHex(userOp.factory)) {
      if (this.reputation.isBanned(userOp.factory, "factory")) {
        throw new UserOpValidationError(
          "Factory is banned",
          RPC_ERROR_CODES.THROTTLED_OR_BANNED,
        );
      }
    }

    if (userOp.paymaster && !isEmptyHex(userOp.paymaster)) {
      if (this.reputation.isBanned(userOp.paymaster, "paymaster")) {
        throw new UserOpValidationError(
          "Paymaster is banned",
          RPC_ERROR_CODES.THROTTLED_OR_BANNED,
        );
      }
    }
  }

  private validateReplacement(existing: UserOperation, replacement: UserOperation, existingHash: `0x${string}`): void {
    const hashTag = ` [existingHash:${existingHash}]`;

    // maxPriorityFeePerGas must increase
    if (replacement.maxPriorityFeePerGas <= existing.maxPriorityFeePerGas) {
      throw new UserOpValidationError(
        `Replacement UserOp must have higher maxPriorityFeePerGas${hashTag}`,
        RPC_ERROR_CODES.INVALID_USEROPERATION,
      );
    }

    const priorityDelta = replacement.maxPriorityFeePerGas - existing.maxPriorityFeePerGas;

    // maxFeePerGas must increase by at least the same delta
    if (replacement.maxFeePerGas < existing.maxFeePerGas + priorityDelta) {
      throw new UserOpValidationError(
        `Replacement UserOp maxFeePerGas must increase by at least the same delta as maxPriorityFeePerGas${hashTag}`,
        RPC_ERROR_CODES.INVALID_USEROPERATION,
      );
    }

    // Both must increase by at least 10%
    const minPriorityIncrease =
      (existing.maxPriorityFeePerGas * MIN_REPLACEMENT_FEE_INCREASE_PERCENT) / 100n;
    if (priorityDelta < minPriorityIncrease) {
      throw new UserOpValidationError(
        `Replacement UserOp must increase fees by at least 10%${hashTag}`,
        RPC_ERROR_CODES.INVALID_USEROPERATION,
      );
    }
  }

  private reservePaymasterDeposit(userOp: UserOperation): void {
    if (!userOp.paymaster) return;
    const pmKey = userOp.paymaster.toLowerCase();
    const maxCost = calcUserOpMaxGas(userOp) * userOp.maxFeePerGas;
    const current = this.paymasterReservations.get(pmKey) ?? 0n;
    this.paymasterReservations.set(pmKey, current + maxCost);
  }

  private releasePaymasterDeposit(userOp: UserOperation): void {
    if (!userOp.paymaster) return;
    const pmKey = userOp.paymaster.toLowerCase();
    const maxCost = calcUserOpMaxGas(userOp) * userOp.maxFeePerGas;
    const current = this.paymasterReservations.get(pmKey) ?? 0n;
    const newVal = current > maxCost ? current - maxCost : 0n;
    // Delete on zero — a long-lived process would otherwise accumulate one dead key per
    // paymaster ever seen.
    if (newVal === 0n) this.paymasterReservations.delete(pmKey);
    else this.paymasterReservations.set(pmKey, newVal);
  }
}
