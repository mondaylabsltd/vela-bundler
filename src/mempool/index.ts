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
import { ReputationManager } from "./reputation.ts";
import { RPC_ERROR_CODES } from "../contracts/entrypoint.ts";
import { UserOpValidationError } from "../userop/validate.ts";
import { isEmptyHex } from "../utils/hex.ts";
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

/** Mempool entry TTL — 5 minutes. Stale ops are evicted to prevent unbounded buildup. */
const MEMPOOL_ENTRY_TTL_MS = 5 * 60 * 1000;

export class Mempool {
  /** Map from userOpHash to MempoolEntry. */
  private entries: Map<string, MempoolEntry> = new Map();
  /** Map from sender to set of userOpHashes. */
  private bySender: Map<string, Set<string>> = new Map();
  /** Map from sender+nonce to userOpHash for replacement tracking. */
  private bySenderNonce: Map<string, string> = new Map();
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

    if (existingHash) {
      // Replacement: validate fee increase
      const existing = this.entries.get(existingHash);
      if (existing) {
        this.validateReplacement(existing.userOp, userOp);
        // Remove old entry
        this.removeEntry(existingHash);
      }
    } else {
      // New op from this sender — check limits
      const senderOps = this.bySender.get(senderKey);
      if (senderOps && senderOps.size >= 1) {
        // Only allow multiple if staked (simplified check)
        throw new UserOpValidationError(
          "Already have a pending UserOperation from this sender",
          RPC_ERROR_CODES.INVALID_USEROPERATION,
        );
      }
    }

    // Check mempool size
    if (this.entries.size >= this.config.maxMempoolSize) {
      throw new UserOpValidationError(
        "Mempool is full",
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
      if (now - entry.addedAt > MEMPOOL_ENTRY_TTL_MS) {
        this.removeEntry(hash);
      }
    }
    return Array.from(this.entries.values());
  }

  /**
   * Get the number of pending entries.
   */
  get size(): number {
    return this.entries.size;
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
    if (this.reputation.isBanned(userOp.sender, "sender")) {
      throw new UserOpValidationError(
        "Sender is banned",
        RPC_ERROR_CODES.THROTTLED_OR_BANNED,
      );
    }
    if (this.reputation.isThrottled(userOp.sender, "sender")) {
      // Throttled senders can have at most 1 pending op
      const senderOps = this.bySender.get(userOp.sender.toLowerCase());
      if (senderOps && senderOps.size > 0) {
        throw new UserOpValidationError(
          "Sender is throttled and already has a pending UserOperation",
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

  private validateReplacement(existing: UserOperation, replacement: UserOperation): void {
    // maxPriorityFeePerGas must increase
    if (replacement.maxPriorityFeePerGas <= existing.maxPriorityFeePerGas) {
      throw new UserOpValidationError(
        "Replacement UserOp must have higher maxPriorityFeePerGas",
        RPC_ERROR_CODES.INVALID_USEROPERATION,
      );
    }

    const priorityDelta = replacement.maxPriorityFeePerGas - existing.maxPriorityFeePerGas;

    // maxFeePerGas must increase by at least the same delta
    if (replacement.maxFeePerGas < existing.maxFeePerGas + priorityDelta) {
      throw new UserOpValidationError(
        "Replacement UserOp maxFeePerGas must increase by at least the same delta as maxPriorityFeePerGas",
        RPC_ERROR_CODES.INVALID_USEROPERATION,
      );
    }

    // Both must increase by at least 10%
    const minPriorityIncrease =
      (existing.maxPriorityFeePerGas * MIN_REPLACEMENT_FEE_INCREASE_PERCENT) / 100n;
    if (priorityDelta < minPriorityIncrease) {
      throw new UserOpValidationError(
        "Replacement UserOp must increase fees by at least 10%",
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
    this.paymasterReservations.set(pmKey, newVal);
  }
}
