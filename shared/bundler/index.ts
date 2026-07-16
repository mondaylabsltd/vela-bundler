/**
 * Bundle builder and submitter — private prepaid bundler mode.
 *
 * In private mode, each bundle contains ops from ONE safeAddress only,
 * signed by the dedicated bundler EOA derived for that safeAddress.
 * On native chains the handleOps beneficiary is the VelaGasSettlementSplitter
 * (splits the gas settlement 50/50 between the EOA and the treasury); on Tempo
 * it stays the EOA (repaid in-band by a feeToken transfer).
 */

import {
  createWalletClient,
  http,
  keccak256,
  type PublicClient,
  type Transport,
  type Chain,
  type Log,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRYPOINT_V07_ABI } from "../contracts/entrypoint.ts";
import { getPublicClient, RPC_REDIRECT_MODE } from "../utils/rpc-client.ts";
import { RPC_TIMEOUT_MS } from "../utils/timeout.ts";
import { metrics, redactError } from "../reliability/log.ts";
import { getClassification } from "../reliability/errors.ts";
import { createDeadline } from "../reliability/retry.ts";
import type { BundlerConfig } from "../config/types.ts";
import type { Simulator } from "../simulation/index.ts";
import { Mempool } from "../mempool/index.ts";
import type { AccountService } from "../account/index.ts";
import type {
  MempoolEntry,
  UserOperationReceipt,
} from "../userop/types.ts";
import { encodeHandleOps } from "../userop/encode.ts";
import {
  calcUserOpGasPrice,
  calcOuterTxGasPrice,
  checkBundleProfitability,
} from "../gas/profitability.ts";
import { quoteNativeToStable, stableDecimals, stableFloorUnits } from "../gas/stable-rate.ts";
import { computeOuterGas, reverseMarkup, markupToBps } from "../gas/fee-model.ts";
import { parseValidationData, isValidTimeRange } from "../userop/validate.ts";
import {
  isTempoChain,
  chainSupportsInBand,
  resolveFeeToken,
  tempoCostInFeeToken,
  parseTempoReimbursement,
  parseInBandReimbursement,
  submitTempoBundle,
  TEMPO_COST_BUFFER_GAS,
  EIP1559_COST_BUFFER_GAS,
  IN_BAND_MARKUP_X,
} from "../tempo.ts";

export interface BundleResult {
  submitted: boolean;
  transactionHash?: `0x${string}`;
  userOpHashes: `0x${string}`[];
  error?: string;
}

/**
 * Classify a BROADCAST (sendRawTransaction) failure.
 *
 * - "definitive": the node provably did NOT accept the tx (insufficient funds, malformed,
 *   initial-send underpriced) — safe to tell the wallet "failed, resubmit".
 * - "ambiguous": the tx MAY be in the txpool or already mined (timeout / network error /
 *   "already known" from a retry / nonce-too-low after a retried send / replacement
 *   underpriced). Storing a failed receipt here is a LIE that makes the wallet re-place the
 *   trade while the "failed" tx lands (double position). The caller must instead track the
 *   precomputed txHash as a normal pending receipt and let reconciliation resolve it.
 */
export function classifyBroadcastError(err: unknown): "definitive" | "ambiguous" {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Idempotent-rebroadcast / raced-retry signatures → the tx is (probably) known to the pool.
  if (msg.includes("already known") || msg.includes("alreadyknown") ||
      msg.includes("known transaction") || msg.includes("already_exists") ||
      msg.includes("transaction already imported")) return "ambiguous";
  // With a pinned nonce, "nonce too low" after viem's internal retry usually means attempt #1
  // was accepted. Reconciliation proves the truth either way (latestNonce vs txNonce).
  if (msg.includes("nonce too low")) return "ambiguous";
  // A same-nonce tx exists in the pool — very likely our own earlier attempt.
  if (msg.includes("replacement transaction underpriced") || msg.includes("replacement fee too low")) return "ambiguous";
  // Transport-level uncertainty: the request may have reached the node.
  if (msg.includes("timed out") || msg.includes("timeout") ||
      msg.includes("network") || msg.includes("fetch failed") || msg.includes("socket") ||
      msg.includes("econnreset") || msg.includes("http request failed") ||
      msg.includes("internal server error") || msg.includes("bad gateway") ||
      msg.includes("service unavailable") || msg.includes("gateway timeout")) return "ambiguous";
  // Catch-all via the reliability classifier (walks nested causes, HTTP statuses, OS error
  // codes, abort/timeout names): anything it deems retryable is transport-level uncertainty.
  // Substring misses on a node client with unusual phrasing must default to AMBIGUOUS-when-
  // transient — "definitive" is the unsafe direction (it fabricates failed receipts).
  if (getClassification(err).retryable) return "ambiguous";
  return "definitive";
}

/** True when a broadcast error is the node's prefund check failing — a "needs top-up" state
 *  the operator (or user) must act on, surfaced via the eoa-underfunded alert. */
export function isInsufficientFundsError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("insufficient funds") || msg.includes("insufficient balance") ||
    msg.includes("total cost exceeds balance");
}

/** Receipt TTL — 24 hours. */
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** Max receipt store entries — prevents unbounded memory growth. */
const RECEIPT_STORE_MAX = 10_000;

/** Max polling attempts for a single pending receipt. Now that pending receipts are
 *  persisted across DO evictions, we can poll far longer before giving up — a stuck
 *  (underpriced) tx may take many minutes to clear. 360 × ~10s alarm ≈ 1 hour. */
const PENDING_RECEIPT_MAX_CHECKS = 360;

/** All-zero 32-byte hash — used as the placeholder txHash on a terminal receipt for an op that
 *  was never broadcast (e.g. TTL-evicted from the mempool before it could be bundled). */
const ZERO_HASH = ("0x" + "00".repeat(32)) as `0x${string}`;

/** Per-sender bundle-prep budget: bounds one sender's RPC reads + simulations so a slow
 *  sender can't starve the others (or the alarm) within a cycle. */
const PER_SENDER_BUNDLE_DEADLINE_MS = 20_000;

/** Broadcast transport tuning: a hung trusted RPC must fail the submit in bounded time
 *  (the ambiguous-error path then tracks the possibly-in-flight tx honestly) instead of
 *  wedging the whole bundle cycle on one socket. Rebroadcasting the SAME signed bytes is
 *  idempotent ("already known" is classified ambiguous), so one retry is safe. */
const BROADCAST_TRANSPORT_OPTS = {
  timeout: RPC_TIMEOUT_MS * 2,
  retryCount: 1,
  retryDelay: 150,
  fetchOptions: { redirect: RPC_REDIRECT_MODE },
} as const;

/** How long a broadcast tx may sit unconfirmed before the SAME-nonce fee-bump replacement
 *  kicks in (native chains only). 45s ≈ several blocks on mainnet, many on L2s — beyond it
 *  the tx is almost certainly underpriced for the current base fee. */
const FEE_BUMP_AFTER_MS = 45_000;

/** Max automatic same-nonce fee bumps per bundle. Each bump raises fees ≥12.5%; two bumps
 *  bound the automation — beyond them the stuck-pending alert asks a human to look. */
const MAX_FEE_BUMPS = 2;

/** Absolute ceiling for a bumped maxFeePerGas, as a multiple of the bundle's revenue cap
 *  (the price the user's signed op refunds). Bumping past revenue is a deliberate,
 *  BOUNDED loss taken from the user's prepaid EOA float to win inclusion (the product's
 *  documented inclusion-first stance, see O-1) — 2× caps that loss at ≤1× revenue. */
const FEE_BUMP_REVENUE_CAP_MULTIPLE = 2n;

/** Consecutive "nonce consumed but no receipt" observations required before a tx is
 *  declared replaced/dropped. Closes the race where the receipt read transiently errors
 *  in the same cycle the nonce read sees `latest` advance. */
const NONCE_CONSUMED_CONFIRMATIONS = 3;

/**
 * Lean projection of a submitted op, kept for receipt reconciliation. Only the fields
 * reconciliation actually needs (hash for the receipt store, sender to derive the EOA /
 * label the receipt, nonce for the receipt body) — small enough to persist to DO storage
 * so an eviction between submit and confirmation does not abandon the in-flight bundle.
 */
interface PendingEntry {
  userOpHash: `0x${string}`;
  userOp: { sender: `0x${string}`; nonce: bigint };
}

/** Metadata for a pending transaction that needs receipt confirmation. */
interface PendingReceipt {
  txHash: `0x${string}`;
  /** Earlier broadcasts of the SAME nonce (fee-bump replacements) — any of them may still
   *  land, so receipt polling checks the whole set, newest first. */
  priorTxHashes?: `0x${string}`[];
  entries: PendingEntry[];
  eoaAddress: `0x${string}`;
  reservedAmount: bigint;
  rpcOverride?: string;
  submittedAt: number;
  checkCount: number;
  /** The PINNED outer-tx nonce (native path). The dropped verdict requires PROOF the chain
   *  consumed it (latestNonce > txNonce) — the "pending" tag alone is unreliable and used to
   *  fabricate false "dropped" receipts for txs still in flight (open issue #9). */
  txNonce?: number;
  /** Consecutive checks that saw latestNonce > txNonce with NO receipt — see
   *  NONCE_CONSUMED_CONFIRMATIONS. */
  nonceConsumedChecks?: number;
  // --- Fee-bump replacement fields (native EIP-1559 path only; absent for Tempo/legacy) ---
  /** handleOps calldata, target and gas limit of the broadcast tx — everything a same-nonce
   *  replacement needs to re-sign at higher fees. */
  txTo?: `0x${string}`;
  txData?: `0x${string}`;
  txGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** Revenue cap per gas (what the user's signed price refunds) — bounds the bump ceiling. */
  revenueCapPerGas?: bigint;
  bumpCount?: number;
}

/** JSON-safe form of a UserOperationReceipt (bigints → decimal strings) for DO storage. */
export interface SerializedReceipt {
  userOpHash: `0x${string}`;
  entryPoint: `0x${string}`;
  sender: `0x${string}`;
  nonce: string;
  paymaster: `0x${string}` | null;
  actualGasCost: string;
  actualGasUsed: string;
  success: boolean;
  logs: Array<{
    logIndex: number;
    address: `0x${string}`;
    topics: readonly `0x${string}`[];
    data: `0x${string}`;
    blockNumber: string;
    blockHash: `0x${string}`;
    transactionHash: `0x${string}`;
  }>;
  receipt: {
    transactionHash: `0x${string}`;
    transactionIndex: number;
    blockHash: `0x${string}`;
    blockNumber: string;
    from: `0x${string}`;
    to: `0x${string}`;
    cumulativeGasUsed: string;
    gasUsed: string;
    effectiveGasPrice: string;
  };
}

export function serializeReceipt(r: UserOperationReceipt): SerializedReceipt {
  return {
    userOpHash: r.userOpHash,
    entryPoint: r.entryPoint,
    sender: r.sender,
    nonce: r.nonce.toString(),
    paymaster: r.paymaster,
    actualGasCost: r.actualGasCost.toString(),
    actualGasUsed: r.actualGasUsed.toString(),
    success: r.success,
    logs: r.logs.map((l) => ({ ...l, blockNumber: l.blockNumber.toString() })),
    receipt: {
      ...r.receipt,
      blockNumber: r.receipt.blockNumber.toString(),
      cumulativeGasUsed: r.receipt.cumulativeGasUsed.toString(),
      gasUsed: r.receipt.gasUsed.toString(),
      effectiveGasPrice: r.receipt.effectiveGasPrice.toString(),
    },
  };
}

export function deserializeReceipt(s: SerializedReceipt): UserOperationReceipt {
  return {
    userOpHash: s.userOpHash,
    entryPoint: s.entryPoint,
    sender: s.sender,
    nonce: BigInt(s.nonce),
    paymaster: s.paymaster,
    actualGasCost: BigInt(s.actualGasCost),
    actualGasUsed: BigInt(s.actualGasUsed),
    success: s.success,
    logs: s.logs.map((l) => ({ ...l, topics: [...l.topics], blockNumber: BigInt(l.blockNumber) })),
    receipt: {
      ...s.receipt,
      blockNumber: BigInt(s.receipt.blockNumber),
      cumulativeGasUsed: BigInt(s.receipt.cumulativeGasUsed),
      gasUsed: BigInt(s.receipt.gasUsed),
      effectiveGasPrice: BigInt(s.receipt.effectiveGasPrice),
    },
  };
}

/** Serialized form persisted to DO storage (bigints → decimal strings). */
interface SerializedPendingReceipt {
  txHash: `0x${string}`;
  priorTxHashes?: `0x${string}`[];
  entries: Array<{ userOpHash: `0x${string}`; sender: `0x${string}`; nonce: string }>;
  eoaAddress: `0x${string}`;
  reservedAmount: string;
  rpcOverride?: string;
  submittedAt: number;
  checkCount: number;
  txNonce?: number;
  nonceConsumedChecks?: number;
  txTo?: `0x${string}`;
  txData?: `0x${string}`;
  txGas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  revenueCapPerGas?: string;
  bumpCount?: number;
  /** Original lock time of the EOA — keeps the stuck-eoa age clock honest across evictions. */
  lockedSince?: number;
}

export class BundlerService {
  private receiptStore: Map<string, { receipt: UserOperationReceipt; expiresAt: number }> = new Map();
  private readonly publicClient: PublicClient<Transport, Chain>;
  private autoBundleTimer?: ReturnType<typeof setInterval>;
  private receiptCleanupTimer?: ReturnType<typeof setInterval>;
  private currentBundlingMode: "auto" | "manual";
  private readonly disableTimers: boolean;
  /** Pending receipts tracked for health-loop/alarm-driven reconciliation (both runtimes). */
  private pendingReceipts: PendingReceipt[] = [];
  /** Reentrancy guard for checkPendingReceipts (health-loop cycles can overlap in Deno). */
  private _reconciling = false;
  /** Reentrancy guard + collapse-pending flag for kickBundle (ingress kicks + timer). */
  private _bundling = false;
  private _kickPending = false;
  /** Worker-mode ingress kick: the DO wires this to `storage.setAlarm(now)` so an accepted
   *  op is bundled immediately instead of waiting out the alarm interval. */
  private kickHook?: () => Promise<void>;
  /**
   * Consecutive BROADCAST failures + the last redacted error. Submit failures delete their
   * ops from the mempool, so no age-based alert can observe them — the operational monitor
   * reads these via the health snapshot instead (submit-failing / eoa-underfunded alerts).
   * Reset on any successful submit.
   */
  submitFailureStreak = 0;
  lastSubmitError: string | null = null;
  /** EOA whose last broadcast failed the node's prefund check ("needs top-up"). */
  insufficientFundsEoa: `0x${string}` | null = null;
  /**
   * Durable-storage hook. In CF Worker mode the DO wires this to persist the in-flight
   * pending-receipt list to DO storage, so reconciliation survives eviction/crash. No-op
   * in Deno mode (which keeps state in-memory by design).
   */
  private persistPendingHook?: (state: SerializedPendingReceipt[]) => Promise<void>;

  constructor(
    private readonly config: BundlerConfig,
    private readonly mempool: Mempool,
    private readonly simulator: Simulator,
    private readonly accountService: AccountService,
    options?: { disableTimers?: boolean },
  ) {
    this.currentBundlingMode = config.bundlingMode;
    this.disableTimers = options?.disableTimers ?? false;
    // Tuned, cached read client (explicit timeout + bounded retry — see rpc-client.ts).
    this.publicClient = getPublicClient(config.rpcUrl);
    // A TTL-evicted op must not vanish silently: store a terminal success=false receipt so the
    // wallet gets a definitive "dropped, resubmit" instead of polling eth_getUserOperationReceipt
    // → null forever (which is indistinguishable from "never seen").
    this.mempool.setTtlEvictionHook((entry) => {
      metrics.inc("mempool_ttl_evicted_total", 1, { chain: this.config.chainId });
      console.warn(`[Bundler] UserOp ${entry.userOpHash} TTL-evicted from mempool (never bundled) — storing failed receipt.`);
      this.storeFailedReceipts(
        [{ userOpHash: entry.userOpHash, userOp: { sender: entry.userOp.sender, nonce: entry.userOp.nonce ?? 0n } }],
        ZERO_HASH,
        entry.userOp.sender,
      );
    });
    // Receipt cleanup runs regardless of bundling mode (every 10 min).
    // Disabled in CF Worker where DO alarm handles cleanup.
    if (!this.disableTimers) {
      this.receiptCleanupTimer = setInterval(() => this.cleanExpiredReceipts(), 600_000);
    }
  }

  /**
   * Start auto-bundling if configured.
   */
  startAutoBundling(): void {
    if (this.currentBundlingMode !== "auto") return;
    if (this.autoBundleTimer) return;

    console.log(
      `[Bundler] Auto-bundling every ${this.config.autoBundleIntervalMs}ms`,
    );
    this.autoBundleTimer = setInterval(async () => {
      try {
        await this.kickBundle();
      } catch (err) {
        console.error("[Bundler] Auto-bundle error:", err);
      }
      // Own try: the cleanup must run EVERY tick, even when the bundle pass throws —
      // and neither may become an unhandled rejection that kills the Deno process.
      try {
        this.cleanExpiredReceipts();
      } catch (err) {
        console.error("[Bundler] Receipt cleanup error:", err);
      }
    }, this.config.autoBundleIntervalMs);
  }

  /**
   * Run one bundle pass, collapsing concurrent requests: the ingress kick and the periodic
   * timer share this single entry point, so at most ONE tryBundle runs at a time and a kick
   * arriving mid-run schedules exactly one follow-up pass (no lost wakeups, no stacking).
   */
  async kickBundle(): Promise<void> {
    if (this._bundling) {
      this._kickPending = true;
      return;
    }
    this._bundling = true;
    try {
      do {
        this._kickPending = false;
        if (this.mempool.size > 0) await this.tryBundle();
        else this.insufficientFundsEoa = null; // nothing pending → nothing underfunded
      } while (this._kickPending);
    } finally {
      this._bundling = false;
    }
  }

  /**
   * Fire-and-forget bundle trigger for the ingress path (eth_sendUserOperation): the accepted
   * op is bundled NOW instead of waiting out the 10s alarm/interval tick — for a 5-minute
   * trading window those seconds are money. Never blocks or throws into the caller.
   * Worker mode: delegates to the DO's `setAlarm(now)` hook (the alarm serializes the work);
   * Deno mode: runs kickBundle inline (per-EOA locks make a concurrent pass safe).
   */
  requestBundleKick(): void {
    if (this.currentBundlingMode !== "auto") return;
    if (this.kickHook) {
      void this.kickHook().catch((err) =>
        console.warn(`[Bundler] bundle-kick hook failed (next alarm covers it): ${redactError(err)}`),
      );
      return;
    }
    void this.kickBundle().catch((err) =>
      console.error(`[Bundler] ingress bundle kick failed: ${redactError(err)}`),
    );
  }

  /** Wire the Worker-mode ingress kick (BundlerDO → storage.setAlarm(now)). */
  setKickHook(hook: () => Promise<void>): void {
    this.kickHook = hook;
  }

  cleanExpiredReceipts(): void {
    const now = Date.now();
    for (const [hash, entry] of this.receiptStore) {
      if (now > entry.expiresAt) this.deleteReceipt(hash);
    }
  }

  /**
   * Definitively drop an op from the mempool WITH a terminal success:false receipt.
   * Every definitive-rejection site must use this instead of a bare mempool.remove — a
   * removed op with no receipt leaves the wallet polling null forever, indistinguishable
   * from "never seen" (the same silent loss the TTL hook already closes).
   */
  private dropWithReceipt(entry: { userOpHash: `0x${string}`; userOp: { sender: `0x${string}`; nonce?: bigint } }, reason: string): void {
    console.warn(`[Bundler] UserOp ${entry.userOpHash} dropped: ${reason}`);
    this.mempool.remove(entry.userOpHash);
    this.storeFailedReceipts(
      [{ userOpHash: entry.userOpHash, userOp: { sender: entry.userOp.sender, nonce: entry.userOp.nonce ?? 0n } }],
      ZERO_HASH,
      entry.userOp.sender,
    );
  }

  stopAutoBundling(): void {
    if (this.autoBundleTimer) {
      clearInterval(this.autoBundleTimer);
      this.autoBundleTimer = undefined;
    }
  }

  /**
   * Release all timers held by this bundler (auto-bundle + receipt cleanup). Called when a
   * chain is evicted from the registry so a flood of distinct chainIds cannot leak an
   * unbounded number of live setInterval handles. Safe to call multiple times.
   */
  dispose(): void {
    this.stopAutoBundling();
    if (this.receiptCleanupTimer) {
      clearInterval(this.receiptCleanupTimer);
      this.receiptCleanupTimer = undefined;
    }
  }

  setBundlingMode(mode: "auto" | "manual"): void {
    this.currentBundlingMode = mode;
    if (mode === "auto") {
      this.startAutoBundling();
    } else {
      this.stopAutoBundling();
    }
  }

  /**
   * Try to build and send bundles.
   * In private mode, we group by safeAddress and send one bundle per sender.
   */
  async tryBundle(): Promise<BundleResult> {
    const entries = this.mempool.getAll();
    if (entries.length === 0) {
      return { submitted: false, userOpHashes: [], error: "Empty mempool" };
    }

    // Group by sender (safeAddress)
    const bySender = new Map<string, MempoolEntry[]>();
    for (const entry of entries) {
      const sender = entry.userOp.sender.toLowerCase();
      if (!bySender.has(sender)) bySender.set(sender, []);
      bySender.get(sender)!.push(entry);
    }

    // Process one sender at a time. Each sender is ISOLATED: a throw from one sender's
    // pipeline (e.g. its user-supplied RPC dying mid-cycle) must never abort the loop and
    // starve every other sender's ops — that would be a cross-sender denial of service.
    let lastResult: BundleResult = {
      submitted: false,
      userOpHashes: [],
      error: "No bundles processed",
    };
    this._cycleSawInsufficientFunds = false;

    for (const [sender, senderEntries] of bySender) {
      try {
        const result = await this.trySenderBundle(
          sender as `0x${string}`,
          senderEntries,
        );
        if (result.submitted) {
          lastResult = result;
        }
      } catch (err) {
        console.error(`[Bundler] sender ${sender} bundle threw (isolated, other senders continue): ${redactError(err)}`);
      }
    }

    // The needs-top-up flag reflects the CURRENT cycle: if no sender hit an
    // insufficient-funds condition this pass, the earlier condition resolved (top-up,
    // TTL-expiry, gas fell) and the eoa-underfunded alert must stop re-firing.
    if (!this._cycleSawInsufficientFunds) this.insufficientFundsEoa = null;

    return lastResult;
  }
  private _cycleSawInsufficientFunds = false;

  /**
   * Build and submit a bundle for a single safeAddress.
   */
  private async trySenderBundle(
    safeAddress: `0x${string}`,
    entries: MempoolEntry[],
  ): Promise<BundleResult> {
    // Derive dedicated EOA
    const eoa = await this.accountService.deriveEOA(safeAddress);
    if (!eoa.privateKey) {
      return {
        submitted: false,
        userOpHashes: entries.map((e) => e.userOpHash),
        error: "Cannot access private key for dedicated EOA",
      };
    }

    // Check EOA availability (lock state)
    if (!this.accountService.lockManager.isAvailable(eoa.address)) {
      // Try to init/recover
      const state = await this.accountService.lockManager.initEOA(
        eoa.address,
        this.publicClient as PublicClient<Transport, Chain>,
      );
      if (state.status !== "ACTIVE") {
        return {
          submitted: false,
          userOpHashes: entries.map((e) => e.userOpHash),
          error: `EOA ${eoa.address} status: ${state.status}`,
        };
      }
    }

    // Acquire bundle lock
    if (!this.accountService.lockManager.acquireBundleLock(eoa.address)) {
      return {
        submitted: false,
        userOpHashes: entries.map((e) => e.userOpHash),
        error: `EOA ${eoa.address} is locked for bundling`,
      };
    }

    try {
      return await this.executeSenderBundle(safeAddress, eoa, entries);
    } finally {
      this.accountService.lockManager.releaseBundleLock(eoa.address);
    }
  }

  private async executeSenderBundle(
    safeAddress: `0x${string}`,
    eoa: { address: `0x${string}`; privateKey?: `0x${string}` },
    entries: MempoolEntry[],
  ): Promise<BundleResult> {
    // Use user-provided RPC if any entry has one (all ops for same sender share the same RPC).
    // Tempo's public RPCs (rpc.tempo.xyz) are flaky and time out on getTransactionCount,
    // breaking nonce/state management and blocking submission — use the bundler's own
    // configured (Alchemy) RPC there instead of the wallet-supplied one.
    const rpcOverride = isTempoChain(this.config.chainId)
      ? undefined
      : entries.find((e) => e.rpcUrlOverride)?.rpcUrlOverride;

    // Bound this single sender's bundle prep by a deadline shared across all its RPC
    // reads/simulations, so one slow sender can't starve the rest of the senders (or the
    // alarm itself) within a cycle. Real cancellation flows through rpcCall's AbortSignal.
    const dl = createDeadline(PER_SENDER_BUNDLE_DEADLINE_MS);

    // getGasPrices THROWS when every price read fails (so ingress never quotes 0x0) — for
    // the bundle cycle that is a DEFER for this sender, never a cycle abort.
    let gasPrices;
    try {
      gasPrices = await this.simulator.getGasPrices(rpcOverride, dl);
    } catch (err) {
      console.warn(`[Bundler] gas price reads failed for ${safeAddress} — deferring: ${redactError(err)}`);
      return { submitted: false, userOpHashes: entries.map((e) => e.userOpHash), error: "gas price unavailable (transient) — deferred" };
    }
    const baseFee = gasPrices.baseFee;

    // Derive outer tx gas pricing from the user's SIGNED price via the fee model.
    //   revenueCap = min over this sender's ops of the EntryPoint refund price (userPrice).
    //                Using the MIN is conservative: the single outer price must not exceed
    //                ANY op's revenue, else that op would be a loss.
    //   intendedGasPrice = reverseMarkup(revenueCap) = the quote-time network price (the
    //                outer price target in the calm case; tier/speed is preserved since a
    //                higher-tier op signs a higher userPrice → higher intendedGasPrice).
    // computeOuterGas then clamps the outer maxFeePerGas to [baseFee+priority, revenueCap]
    // with base-fee head-room, guaranteeing: never a loss (maxFee ≤ revenue) AND reliable
    // inclusion when base fee rises post-submit (the previous code had ~tip head-room and
    // could strand the tx after one rising block). See shared/gas/fee-model.ts.
    const markupBps = markupToBps(this.config.walletGasMarkup);
    let revenueCap = calcUserOpGasPrice(entries[0]!.userOp, baseFee);
    for (const e of entries) {
      const p = calcUserOpGasPrice(e.userOp, baseFee);
      if (p < revenueCap) revenueCap = p;
    }
    const userOpEffective = revenueCap; // revenue basis used by the profitability gate below
    const intendedGasPrice = reverseMarkup(revenueCap, markupBps);
    const chainTip = gasPrices.suggestedMaxPriorityFeePerGas ?? 0n;
    let outerGas = computeOuterGas({
      revenueCapPerGas: revenueCap,
      baseFee,
      intendedGasPrice,
      chainTip,
      minPriorityFee: this.config.minPriorityFeePerGas,
    });

    // Enforce binding: every UserOp.sender must be the bound safeAddress
    const validEntries: MempoolEntry[] = [];
    for (const entry of entries) {
      if (entry.userOp.sender.toLowerCase() !== safeAddress.toLowerCase()) {
        console.warn(
          `[Bundler] UserOp ${entry.userOpHash} sender mismatch: ` +
          `${entry.userOp.sender} != ${safeAddress}. Removing.`,
        );
        this.mempool.remove(entry.userOpHash);
        continue;
      }
      validEntries.push(entry);
    }

    if (validEntries.length === 0) {
      return { submitted: false, userOpHashes: [], error: "No valid ops after binding check" };
    }

    // Re-validate all ops in parallel: validation + execution simulation.
    // A `transient` result means the RPC could not complete the simulation (degraded /
    // unreachable node — e.g. an Alchemy blip with no public fallback), NOT that the op is
    // invalid. Distinguish it from a definitive rejection so we DEFER (keep in mempool,
    // retry next cycle) instead of dropping + penalizing a valid op the client already holds
    // a hash for. Mirrors the ingress path in handlers.ts, which surfaces transient as a
    // retryable degraded error rather than a rejection.
    type CheckedEntry = { entry: MempoolEntry; accountValidationData: bigint; paymasterValidationData: bigint };
    type Revalidated =
      | { kind: "ok"; checked: CheckedEntry }
      | { kind: "drop"; reason: string }
      | { kind: "defer"; reason: string };
    const simResults = await Promise.allSettled(
      validEntries.map(async (entry): Promise<Revalidated> => {
        const simResult = await this.simulator.simulateValidation(entry.userOp, rpcOverride, dl);
        if (!simResult.valid) {
          const reason = simResult.errorMessage ?? "re-validation failed";
          return simResult.transient ? { kind: "defer", reason } : { kind: "drop", reason };
        }
        const execResult = await this.simulator.simulateExecution(entry.userOp, rpcOverride, dl);
        if (!execResult.success) {
          const reason = execResult.errorMessage ?? "execution simulation failed";
          return execResult.transient ? { kind: "defer", reason } : { kind: "drop", reason };
        }
        return {
          kind: "ok",
          checked: {
            entry,
            accountValidationData: simResult.validationResult?.accountValidationData ?? 0n,
            paymasterValidationData: simResult.validationResult?.paymasterValidationData ?? 0n,
          },
        };
      }),
    );

    const checkedEntries: CheckedEntry[] = [];
    for (let i = 0; i < simResults.length; i++) {
      const result = simResults[i]!;
      const failed = validEntries[i]!;
      if (result.status === "rejected") {
        // simulate* catch internally, so a throw here is unexpected — defer (keep the op)
        // rather than penalize on an error we don't understand.
        console.warn(`[Bundler] UserOp ${failed.userOpHash} re-validation threw, deferring: ${result.reason}`);
        continue;
      }
      const outcome = result.value;
      if (outcome.kind === "ok") {
        checkedEntries.push(outcome.checked);
      } else if (outcome.kind === "drop") {
        // Definitive rejection — drop with a terminal receipt + penalize sender.
        this.dropWithReceipt(failed, `re-validation failed: ${outcome.reason}`);
        this.mempool.reputation.penalize(failed.userOp.sender, "sender");
      } else {
        // Transient RPC failure — keep in mempool for the next cycle, no penalty.
        console.warn(`[Bundler] UserOp ${failed.userOpHash} deferred (transient RPC): ${outcome.reason}`);
      }
    }

    if (checkedEntries.length === 0) {
      return { submitted: false, userOpHashes: [], error: "All ops failed re-validation" };
    }

    // Two orthogonal axes (see docs/inband-gas-settlement.md):
    //  - inBand = SETTLEMENT model: beneficiary=EOA, in-band reimbursement gate, no reservation.
    //    On native (route-A) chains the EntryPoint instead pays the VelaGasSettlementSplitter,
    //    which splits 50/50 EOA/treasury. inBand is always on for Tempo, opt-in elsewhere.
    //  - tempoEnvelope = tx ENVELOPE only (0x76 fee-token tx vs native EIP-1559) + trusted RPC.
    //  Until a chain sets inBandEnabled, inBand === tempoEnvelope === isTempoChain (no change).
    const tempoEnvelope = isTempoChain(this.config.chainId);
    const inBand = chainSupportsInBand(this.config.chainId, this.config.inBandEnabled ?? false);
    const beneficiary = inBand ? eoa.address : this.config.splitterAddress;

    // Generic in-band ops sign maxFeePerGas=0, so the revenueCap-based outerGas above is 0 and would
    // make the outer tx unminable. The bundler is repaid in-band (not via EntryPoint), so there is
    // no revenue cap — reprice the outer tx straight from the network. (Route-A keeps the clamp;
    // Tempo prices its own 0x76 fee in submitTempoBundle and does not use outerGas.)
    if (inBand && !tempoEnvelope) {
      outerGas = calcOuterTxGasPrice({
        currentBaseFee: baseFee,
        baseFeeMultiplier: this.config.baseFeeMultiplier,
        bundlerTipGwei: this.config.bundlerTipGwei,
        chainSuggestedTip: gasPrices.suggestedMaxPriorityFeePerGas,
      });
    }

    // Full bundle simulation. The outer handleOps tx is sent BY the EOA (eoa.address is
    // tx.origin), so simulation's `from` stays the EOA even when the encoded beneficiary is
    // the splitter — otherwise tx.origin would resolve to the splitter and mis-simulate.
    const packedOps = checkedEntries.map((e) => e.entry.packed);
    const bundleSim = await this.simulator.simulateBundle(packedOps, beneficiary, eoa.address, rpcOverride, dl);

    if (!bundleSim.success) {
      // Drop the failed op (with a terminal receipt) if identified
      if (bundleSim.failedOpIndex !== undefined) {
        const failed = checkedEntries[bundleSim.failedOpIndex];
        if (failed) {
          this.dropWithReceipt(failed.entry, `bundle simulation failed: ${bundleSim.errorMessage}`);
          this.mempool.reputation.penalize(failed.entry.userOp.sender, "sender");
        }
      }
      return {
        submitted: false,
        userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
        error: `Bundle simulation failed: ${bundleSim.errorMessage}`,
      };
    }

    // expectedCost is the native outer-tx PREFUND (used for the balance gate + reservation).
    // Basis is maxFeePerGas, NOT effectiveGasPrice: the node's prefund rule is
    // gasLimit × maxFeePerGas, and maxFee carries base-fee head-room above the effective
    // price — an EOA in the gap used to pass this gate and then bounce at broadcast with
    // "insufficient funds" on every cycle, silently (the ops were deleted each attempt).
    // Gating on the node's own rule keeps the op IN the mempool instead, where the
    // stuck-mempool alert observes it. On Tempo it's meaningless (no native coin) and unused.
    const expectedCost = bundleSim.estimatedGas! * outerGas.maxFeePerGas;
    // In-band ops reserve nothing (the EOA is an operator float, repaid in-band, not a user
    // custody balance). Persist 0 as the reserved amount so the receipt's later release / fee-bump
    // re-reserve are no-ops. releaseReservation clamps at 0, so the immediate release paths that
    // still pass expectedCost are harmless for in-band.
    const reservedAmount = inBand ? 0n : expectedCost;
    // Fee-bump ceiling basis. Route-A uses the signed revenueCap. Generic in-band signs maxFee=0 so
    // revenueCap is 0, which would collapse the fee-bump ceiling and strand a stuck tx forever;
    // use the network outer price instead — the reimbursement is IN_BAND_MARKUP_X× that, so bumping
    // up to the ceiling (a small multiple of this) stays comfortably profitable.
    const revenueCapForReceipt = inBand && !tempoEnvelope ? outerGas.maxFeePerGas : revenueCap;

    if (inBand && tempoEnvelope) {
      // Tempo: the bundler is repaid by a stablecoin transfer batched into the UserOp,
      // not by EntryPoint (maxFee=0 → refund 0). Native profitability/balance checks
      // don't apply — instead we (1) verify execution succeeds (else the in-band transfer
      // is rolled back), (2) price our real cost from the simulated gas, (3) require the
      // in-band reimbursement (paid in the trusted feeToken) to cover it.
      const feeToken = resolveFeeToken(checkedEntries[0]!.entry.userOp.feeToken);
      let reimbursed = 0n;
      for (const e of checkedEntries) {
        // Count ONLY transfers to the EOA paid in the trusted feeToken — counting any
        // token would let an attacker repay in a worthless token and drain the bundler.
        reimbursed += parseTempoReimbursement(e.entry.userOp.callData, beneficiary, feeToken);
      }

      // Verify execution actually succeeds AND read the REAL gas it burns. handleOps
      // swallows inner reverts, so this also protects against an OOG/insufficient-balance
      // op that would leave us unpaid. Fails closed — no proof of success ⇒ no submit.
      const execCheck = await this.simulator.simulateExecutionSuccess(packedOps, beneficiary, eoa.address, rpcOverride, dl);
      if (!execCheck.success) {
        if (execCheck.failedOpIndex !== undefined) {
          const failed = checkedEntries[execCheck.failedOpIndex];
          if (failed) {
            this.dropWithReceipt(failed.entry, `Tempo execution would revert: ${execCheck.errorMessage}`);
            this.mempool.reputation.penalize(failed.entry.userOp.sender, "sender");
          }
        }
        console.warn(`[Bundler][Tempo] REJECT — execution would revert: ${execCheck.errorMessage}`);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `Tempo execution would revert (bundler not reimbursed): ${execCheck.errorMessage}`,
        };
      }

      // Cost basis = the REAL simulated gas (+ overhead buffer), NOT eth_estimateGas which
      // reserves the padded callGasLimit and over-prices the bundler's cost ~2.5×. This is
      // what lets the wallet charge the user a tight margin instead of the inflated limits.
      const realGas = (execCheck.gasUsed ?? bundleSim.estimatedGas!) + TEMPO_COST_BUFFER_GAS;
      const costInFeeToken = tempoCostInFeeToken(realGas, baseFee);
      console.log(
        `[Bundler][Tempo] reimbursed=${reimbursed} cost=${costInFeeToken} feeToken=${feeToken} realGas=${realGas} simGas=${execCheck.gasUsed ?? "n/a"} (${checkedEntries.length} ops)`,
      );
      if (reimbursed < costInFeeToken) {
        console.warn(`[Bundler][Tempo] REJECT — reimbursement ${reimbursed} < cost ${costInFeeToken}`);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `Tempo reimbursement too low: ${reimbursed} < cost ${costInFeeToken} in ${feeToken}`,
        };
      }
    } else if (inBand) {
      // Generic in-band (native EIP-1559 envelope): the bundler EOA fronts native L1 gas and is
      // repaid by a native transfer to it batched into the UserOp. Same fail-closed shape as Tempo
      // but priced in native wei: (1) prove execution succeeds (else the in-band transfer rolls
      // back leaving us unpaid), (2) cost = realGas × network outer price, (3) require the in-band
      // native reimbursement to cover IN_BAND_MARKUP_X × cost. Stablecoin reimbursement + the $0.01
      // floor land in step 8 (empty token allowlist here → native-only). See docs/.
      const execCheck = await this.simulator.simulateExecutionSuccess(packedOps, beneficiary, eoa.address, rpcOverride, dl);
      if (!execCheck.success) {
        if (execCheck.failedOpIndex !== undefined) {
          const failed = checkedEntries[execCheck.failedOpIndex];
          if (failed) {
            this.dropWithReceipt(failed.entry, `in-band execution would revert: ${execCheck.errorMessage}`);
            this.mempool.reputation.penalize(failed.entry.userOp.sender, "sender");
          }
        }
        console.warn(`[Bundler][InBand] REJECT — execution would revert: ${execCheck.errorMessage}`);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `In-band execution would revert (bundler not reimbursed): ${execCheck.errorMessage}`,
        };
      }
      // outerGas was repriced from the network for generic in-band above (a maxFee=0 op makes
      // revenueCap 0), so it is the price the submit path will actually pay — cost basis uses it.
      const realGas = (execCheck.gasUsed ?? bundleSim.estimatedGas!) + EIP1559_COST_BUFFER_GAS;
      const costNative = realGas * outerGas.maxFeePerGas;
      let requiredNative = costNative * IN_BAND_MARKUP_X; // 3× the real on-chain gas

      // Accumulate the in-band reimbursement across ops: native value + allowlisted-stablecoin
      // transfers to the EOA. Allowlist = the chain's registry `stables` (anti fake-token drain).
      const stableAllow = (this.config.chainInfo?.stables ?? []).map((s) => s.contract);
      let native = 0n;
      const byToken: Record<string, bigint> = {};
      for (const e of checkedEntries) {
        const r = parseInBandReimbursement(e.entry.userOp.callData, beneficiary, stableAllow);
        native += r.native;
        for (const [k, v] of Object.entries(r.byToken)) byToken[k] = (byToken[k] ?? 0n) + v;
      }

      // Value everything in native-equiv. Stablecoin legs are priced by the chain's DEX quote
      // (WETH→stable of the native cost, rescaled), and each stablecoin used raises the required
      // charge to the $0.01 floor. Fail closed if a stablecoin can't be priced.
      let reimbursedNativeEquiv = native;
      const quoter = this.config.chainInfo?.dex?.contracts?.quoterV2;
      const wnative = this.config.chainInfo?.wrappedNativeToken;
      for (const [stableLower, amount] of Object.entries(byToken)) {
        if (amount <= 0n) continue;
        if (!quoter || !wnative) {
          return { submitted: false, userOpHashes: checkedEntries.map((e) => e.entry.userOpHash), error: "stablecoin gas unsupported on this chain (no DEX quoter / wrappedNative)" };
        }
        const stable = stableLower as `0x${string}`;
        const client = this.publicClient as PublicClient<Transport, Chain>;
        const costStable = await quoteNativeToStable(client, { quoterV2: quoter, wrappedNative: wnative, stable }, costNative, this.config.chainId);
        if (costStable === null || costStable <= 0n) {
          return { submitted: false, userOpHashes: checkedEntries.map((e) => e.entry.userOpHash), error: `cannot price stablecoin ${stable} for in-band gas (no DEX quote)` };
        }
        // native-equiv of this stable leg = amount × costNative / costStable (reuses the quote ratio).
        reimbursedNativeEquiv += (amount * costNative) / costStable;
        // $0.01-per-stablecoin floor, expressed in native-equiv; raise the requirement if higher.
        const dec = await stableDecimals(client, stable);
        const floorNative = (stableFloorUnits(dec) * costNative) / costStable;
        if (floorNative > requiredNative) requiredNative = floorNative;
      }

      console.log(
        `[Bundler][InBand] reimbursedNativeEquiv=${reimbursedNativeEquiv} required=${requiredNative} (${IN_BAND_MARKUP_X}× of ${costNative}; native=${native}, stables=${Object.keys(byToken).length}) simGas=${execCheck.gasUsed ?? "n/a"} (${checkedEntries.length} ops)`,
      );
      if (reimbursedNativeEquiv < requiredNative) {
        console.warn(`[Bundler][InBand] REJECT — reimbursement ${reimbursedNativeEquiv} < required ${requiredNative}`);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `In-band reimbursement too low: ${reimbursedNativeEquiv} < required ${requiredNative}`,
        };
      }
    } else {
      // Profitability check.
      // Revenue = estimatedGas × userOpGasPrice (what EntryPoint charges).
      // Cost    = estimatedGas × outerGasPrice   (what bundler pays on-chain).
      // Margin  = WALLET_GAS_MARKUP - 1 (constant).
      const actualGasCosts = [bundleSim.estimatedGas! * userOpEffective];

      const profitResult = checkBundleProfitability({
        actualGasCosts,
        estimatedHandleOpsGas: bundleSim.estimatedGas!,
        outerTxEffectiveGasPrice: outerGas.effectiveGasPrice,
        minProfitMarginBps: this.config.minProfitMarginBps,
      });

      if (!profitResult.profitable) {
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `Unprofitable: ${profitResult.marginBps}bps < ${this.config.minProfitMarginBps}bps`,
        };
      }

      if (profitResult.marginBps > this.config.maxProfitMarginBps) {
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `Margin too high: ${profitResult.marginBps}bps > ${this.config.maxProfitMarginBps}bps (user overpaying)`,
        };
      }

      // Balance check before submission
      let balanceCheck;
      try {
        // TRUSTED RPC only: this read gates money movement and feeds the eoa-underfunded
        // alert — a user-supplied X-Rpc-Url could lie it low (skipping valid bundles and
        // spamming the operator) or lie it high (pointless broadcast bounce).
        balanceCheck = await this.accountService.checkBalance(safeAddress, expectedCost, undefined);
      } catch (err) {
        console.error(`[Bundler] Balance check failed for ${safeAddress}:`, err);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: "Balance check RPC failed",
        };
      }
      if (!balanceCheck.sufficient) {
        // Deliberately KEEP the ops in the mempool (the shortfall can be transient: a prior
        // reservation releases, a splitter refund lands, the user deposits) — but never
        // silently: log, count, and surface the EOA in the health snapshot so the
        // eoa-underfunded alert tells the operator/user exactly what to top up.
        console.warn(
          `[Bundler] Bundle skipped for ${safeAddress}: EOA ${eoa.address} balance insufficient ` +
            `(spendable=${balanceCheck.spendableBalance} < required=${balanceCheck.requiredBalance})`,
        );
        metrics.inc("bundle_skipped_total", 1, { chain: this.config.chainId, reason: "insufficient_balance" });
        this.insufficientFundsEoa = eoa.address;
        this._cycleSawInsufficientFunds = true;
        this.lastSubmitError = `EOA balance insufficient: spendable ${balanceCheck.spendableBalance} < required ${balanceCheck.requiredBalance}`;
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `Insufficient balance: ${balanceCheck.spendableBalance} < ${balanceCheck.requiredBalance}`,
        };
      }
    }

    // Final time-range re-check right before submission to guard against expiry
    for (const checked of checkedEntries) {
      const acctVD = parseValidationData(checked.accountValidationData);
      if (!isValidTimeRange(acctVD.validAfter, acctVD.validUntil, 10)) {
        this.dropWithReceipt(checked.entry, `expired before submission (validUntil=${acctVD.validUntil})`);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `UserOp ${checked.entry.userOpHash} expired before submission (validUntil=${acctVD.validUntil})`,
        };
      }
      if (checked.paymasterValidationData !== 0n) {
        const pmVD = parseValidationData(checked.paymasterValidationData);
        if (!isValidTimeRange(pmVD.validAfter, pmVD.validUntil, 10)) {
          this.dropWithReceipt(checked.entry, "paymaster expired before submission");
          return {
            submitted: false,
            userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
            error: `UserOp ${checked.entry.userOpHash} paymaster expired before submission`,
          };
        }
      }
    }

    // Reserve balance atomically (route-A native only — in-band settles by reimbursement).
    if (!inBand) this.accountService.reserveBalance(eoa.address, expectedCost);

    // SECURITY: sign & broadcast ONLY via the bundler's own trusted RPC, never the
    // user-supplied X-Rpc-Url. Submitting a signed tx to an attacker RPC leaks it and lets
    // the attacker drop/withhold it or feed lies into the (subsequent) reconciliation.
    // The user RPC (rpcOverride) is still used for the read-only sim/gas/balance above,
    // where the worst case is the user grieving their OWN op. (On mainnet config.rpcUrl is
    // Alchemy/public; on a dev chain it is whatever the registry resolved.)
    const account = privateKeyToAccount(eoa.privateKey!);
    const submitRpcUrl = this.config.rpcUrl;
    const walletClient = createWalletClient({
      account,
      transport: http(submitRpcUrl, BROADCAST_TRANSPORT_OPTS),
    });

    const calldata = encodeHandleOps(packedOps, beneficiary);
    const userOpHashes = checkedEntries.map((e) => e.entry.userOpHash);

    console.log(
      `[Bundler] Submitting bundle for ${safeAddress} via ${tempoEnvelope ? "Tempo 0x76" : "EIP-1559"} (eoa=${eoa.address}, rpc=${submitRpcUrl})`,
    );

    // ------------------------------------------------------------------
    // Tempo: submit handleOps inside a native 0x76 tx paying gas in the stablecoin.
    // sendTransactionSync waits for the receipt, so success here means MINED.
    // ------------------------------------------------------------------
    if (tempoEnvelope) {
      // Pin the outer nonce for Tempo too (best-effort): the sync submit signs its own tx,
      // but the value read here right before it feeds (a) proof-based EOA recovery on the
      // ambiguous path and (b) the proof-based dropped verdict for the pending receipt —
      // without it both fall back to the unreliable pending-tag heuristic, which misreads
      // a MINED sync-submitted tx (pending == latest is its normal state) as dropped.
      let tempoNonce: number | undefined;
      try {
        tempoNonce = await this.publicClient.getTransactionCount({ address: eoa.address, blockTag: "pending" });
      } catch {
        try {
          tempoNonce = await this.publicClient.getTransactionCount({ address: eoa.address, blockTag: "latest" });
        } catch { /* proceed unpinned — legacy reconciliation still applies */ }
      }
      try {
        const txHash = await submitTempoBundle({
          chainId: this.config.chainId,
          privateKey: eoa.privateKey!,
          rpcUrl: submitRpcUrl,
          entryPoint: this.config.entryPointAddress,
          packedOps,
          beneficiary,
          feeToken: resolveFeeToken(checkedEntries[0]!.entry.userOp.feeToken),
          baseFee, // pin the outer 0x76 price to ~base fee (not viem's 2.4× default)
        });
        return await this.finalizeSubmitted({
          txHash,
          checkedEntries,
          eoaAddress: eoa.address,
          safeAddress,
          reservedAmount: 0n, // Tempo reserves nothing (stablecoin in-band settlement)
          txNonce: tempoNonce,
        });
      } catch (err) {
        if (classifyBroadcastError(err) === "ambiguous") {
          // The sync submit timed out / network-failed AFTER possibly reaching the node: the
          // 0x76 may still land. We cannot precompute its hash (viem's Tempo extension owns
          // the 0x76 serialization), so there is no receipt to poll — but we must NOT lie
          // with a success:false receipt (the wallet would re-place a trade that executed).
          // Remove the ops (no terminal receipt — honest "unknown"), lock the EOA (the
          // health loop's nonce heuristic recovers it), and record the failure for the
          // submit-failing alert.
          this.recordSubmitFailure(eoa.address, err);
          console.error(`[Bundler][Tempo] AMBIGUOUS submit outcome — tx may still land; EOA locked pending nonce recovery: ${redactError(err)}`);
          for (const checked of checkedEntries) this.mempool.remove(checked.entry.userOpHash);
          // Pinned nonce → proof-based recovery instead of the pending-tag heuristic.
          this.accountService.lockManager.lockEOA(eoa.address, "LOCKED_PENDING_UNKNOWN", tempoNonce);
          return { submitted: false, userOpHashes, error: `ambiguous Tempo submit: ${redactError(err)}` };
        }
        return await this.handleDefinitiveSubmitFailure(eoa.address, checkedEntries, userOpHashes, err, 0n);
      }
    }

    // ------------------------------------------------------------------
    // Native EIP-1559 path: pin the nonce, sign locally, precompute the tx hash, then
    // broadcast the RAW tx — so an ambiguous transport outcome can be tracked honestly
    // as a pending receipt instead of being declared failed while possibly in flight.
    // ------------------------------------------------------------------

    // 1. Pin the outer nonce from the trusted RPC. The pinned value (a) makes the dropped
    //    verdict provable (latestNonce > txNonce), (b) makes rebroadcast/fee-bump exact,
    //    and (c) keeps a viem-internal retry idempotent. Read failure = nothing broadcast:
    //    DEFER (ops stay in the mempool for the next cycle) rather than burn the ops.
    let txNonce: number;
    try {
      txNonce = await this.publicClient.getTransactionCount({ address: eoa.address, blockTag: "pending" });
    } catch {
      try {
        txNonce = await this.publicClient.getTransactionCount({ address: eoa.address, blockTag: "latest" });
      } catch (err) {
        this.accountService.releaseBalance(eoa.address, expectedCost);
        console.warn(`[Bundler] nonce read failed for ${eoa.address} — deferring bundle to next cycle: ${redactError(err)}`);
        return { submitted: false, userOpHashes, error: "nonce read failed (transient) — deferred" };
      }
    }

    // 2. Prepare (fills `gas` via the trusted-RPC eth_estimateGas — the deliberate O-18
    //    safety net that reverts a bad bundle BEFORE it is signed) and sign locally.
    let serialized: `0x${string}`;
    let txHash: `0x${string}`;
    let txGas: bigint;
    try {
      const request = await walletClient.prepareTransactionRequest({
        account,
        to: this.config.entryPointAddress,
        data: calldata,
        maxFeePerGas: outerGas.maxFeePerGas,
        maxPriorityFeePerGas: outerGas.maxPriorityFeePerGas,
        nonce: txNonce,
        chain: null,
      });
      txGas = request.gas as bigint;
      serialized = await walletClient.signTransaction(request as Parameters<typeof walletClient.signTransaction>[0]);
      txHash = keccak256(serialized);
    } catch (err) {
      // NOTHING was broadcast. Insufficient funds here (the node's own prefund math on
      // fresher state than our gate saw) is a NEEDS-TOP-UP state, not an invalid bundle:
      // keep the ops in the mempool (retry once funded / gas falls) and surface the EOA
      // via the eoa-underfunded alert — dropping with failed receipts would recreate the
      // drop→resubmit churn the maxFee-basis balance gate exists to prevent.
      if (isInsufficientFundsError(err)) {
        this.accountService.releaseBalance(eoa.address, expectedCost);
        this.insufficientFundsEoa = eoa.address;
        this._cycleSawInsufficientFunds = true;
        this.lastSubmitError = redactError(err);
        metrics.inc("bundle_skipped_total", 1, { chain: this.config.chainId, reason: "insufficient_balance" });
        console.warn(`[Bundler] prepare hit insufficient funds for ${eoa.address} — keeping ops, needs top-up: ${redactError(err)}`);
        return { submitted: false, userOpHashes, error: "EOA cannot afford prefund — deferred (needs top-up)" };
      }
      // A transient infra error defers (op retries next cycle); a definitive one
      // (estimateGas revert = the bundle would fail on-chain) drops with failed receipts
      // via the standard failure path.
      if (classifyBroadcastError(err) === "ambiguous") {
        this.accountService.releaseBalance(eoa.address, expectedCost);
        console.warn(`[Bundler] prepare/sign failed transiently for ${eoa.address} — deferring: ${redactError(err)}`);
        return { submitted: false, userOpHashes, error: "prepare failed (transient) — deferred" };
      }
      return await this.handleDefinitiveSubmitFailure(eoa.address, checkedEntries, userOpHashes, err, expectedCost);
    }

    // 3. Broadcast the raw tx. From here the tx hash is KNOWN regardless of outcome.
    try {
      await walletClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (err) {
      if (classifyBroadcastError(err) === "ambiguous") {
        // The node may have the tx (timeout / "already known" / raced retry). Track the
        // precomputed hash as a pending receipt and let reconciliation prove landed vs
        // dropped — its proof-based dropped verdict stores the honest failed receipt if
        // the tx truly never made it. UNLIKE a clean submit this still COUNTS toward the
        // failure streak (a chronic timeout must reach the submit-failing alert, not be
        // laundered into "ok" every cycle); the streak resets only on a clean broadcast
        // or a CONFIRMED receipt.
        console.warn(`[Bundler] AMBIGUOUS broadcast for ${txHash} — tracking as in-flight: ${redactError(err)}`);
        metrics.inc("bundle_submit_ambiguous_total", 1, { chain: this.config.chainId });
        this.submitFailureStreak++;
        this.lastSubmitError = redactError(err);
        return await this.finalizeSubmitted({
          txHash,
          checkedEntries,
          eoaAddress: eoa.address,
          safeAddress,
          reservedAmount,
          txNonce,
          txTo: this.config.entryPointAddress,
          txData: calldata,
          txGas,
          maxFeePerGas: outerGas.maxFeePerGas,
          maxPriorityFeePerGas: outerGas.maxPriorityFeePerGas,
          revenueCapPerGas: revenueCapForReceipt,
          ambiguous: true,
        });
      }
      // Insufficient funds at broadcast = needs-top-up, not an invalid bundle: keep the ops
      // (see the identical prepare-stage branch above for the rationale).
      if (isInsufficientFundsError(err)) {
        this.accountService.releaseBalance(eoa.address, expectedCost);
        this.insufficientFundsEoa = eoa.address;
        this._cycleSawInsufficientFunds = true;
        this.lastSubmitError = redactError(err);
        metrics.inc("bundle_skipped_total", 1, { chain: this.config.chainId, reason: "insufficient_balance" });
        console.warn(`[Bundler] broadcast hit insufficient funds for ${eoa.address} — keeping ops, needs top-up: ${redactError(err)}`);
        return { submitted: false, userOpHashes, error: "EOA cannot afford prefund — deferred (needs top-up)" };
      }
      return await this.handleDefinitiveSubmitFailure(eoa.address, checkedEntries, userOpHashes, err, expectedCost);
    }

    return await this.finalizeSubmitted({
      txHash,
      checkedEntries,
      eoaAddress: eoa.address,
      safeAddress,
      reservedAmount,
      txNonce,
      txTo: this.config.entryPointAddress,
      txData: calldata,
      txGas,
      maxFeePerGas: outerGas.maxFeePerGas,
      maxPriorityFeePerGas: outerGas.maxPriorityFeePerGas,
      revenueCapPerGas: revenueCapForReceipt,
    });
  }

  /**
   * Success bookkeeping shared by the confirmed-broadcast, ambiguous-broadcast and Tempo
   * paths: remove ops from the mempool, lock the EOA on its pinned nonce, push the durable
   * pending receipt (with every field a same-nonce fee-bump replacement needs), and reset
   * the submit-failure signals.
   */
  private async finalizeSubmitted(params: {
    txHash: `0x${string}`;
    checkedEntries: Array<{ entry: MempoolEntry }>;
    eoaAddress: `0x${string}`;
    safeAddress: `0x${string}`;
    reservedAmount: bigint;
    txNonce?: number;
    txTo?: `0x${string}`;
    txData?: `0x${string}`;
    txGas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    revenueCapPerGas?: bigint;
    /** True when the broadcast outcome is UNPROVEN (transport error after possibly reaching
     *  the node): tracked for reconciliation but NOT counted as a success — no streak reset,
     *  no ok metric, no reputation credit. Proof arrives via the confirmed receipt. */
    ambiguous?: boolean;
  }): Promise<BundleResult> {
    const { txHash, checkedEntries, eoaAddress, safeAddress } = params;
    if (!params.ambiguous) {
      metrics.inc("bundle_submit_total", 1, { chain: this.config.chainId, outcome: "ok" });
      this.submitFailureStreak = 0;
      this.lastSubmitError = null;
      this.insufficientFundsEoa = null;
    }
    console.log(
      `[Bundler] Bundle ${params.ambiguous ? "tracked (ambiguous broadcast)" : "submitted"} for ${safeAddress}: ${txHash} ` +
      `(${checkedEntries.length} ops, EOA: ${eoaAddress}, nonce: ${params.txNonce ?? "n/a"})`,
    );

    // Remove from mempool
    const submittedEntries = checkedEntries.map((e) => e.entry);
    for (const entry of submittedEntries) {
      this.mempool.remove(entry.userOpHash);
      if (!params.ambiguous) this.mempool.reputation.updateIncluded(entry.userOp.sender, "sender");
    }

    // Lock EOA until receipt is confirmed to prevent double-spend. The pinned nonce makes
    // recovery PROOF-based (latestNonce must advance past it) instead of pending-tag-based.
    this.accountService.lockManager.lockEOA(eoaAddress, "LOCKED_PENDING_UNKNOWN", params.txNonce);

    // Track the in-flight bundle for DURABLE, health-loop-driven reconciliation in BOTH runtimes
    // (unified). checkPendingReceipts() is called each health cycle (Worker DO alarm ~10s / Deno
    // ChainRegistry health loop ~30s) and polls up to PENDING_RECEIPT_MAX_CHECKS before giving up
    // — so a slow-confirming tx (congestion) is still reconciled and its receipt captured, rather
    // than a fire-and-forget promise that gives up early and loses the receipt. Reconcile via the
    // trusted submit RPC, never the user RPC.
    this.pendingReceipts.push({
      txHash,
      entries: submittedEntries.map((e) => ({
        userOpHash: e.userOpHash,
        userOp: { sender: e.userOp.sender, nonce: e.userOp.nonce ?? 0n },
      })),
      eoaAddress,
      reservedAmount: params.reservedAmount,
      rpcOverride: undefined,
      submittedAt: Date.now(),
      checkCount: 0,
      txNonce: params.txNonce,
      txTo: params.txTo,
      txData: params.txData,
      txGas: params.txGas,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      revenueCapPerGas: params.revenueCapPerGas,
      bumpCount: 0,
    });
    // Persist immediately (Worker: DO storage; Deno: no-op) so an eviction before the next tick
    // cannot abandon this bundle's reconciliation. Non-fatal on error.
    await this.flushPendingReceipts();

    return { submitted: true, transactionHash: txHash, userOpHashes: submittedEntries.map((e) => e.userOpHash) };
  }

  /** Record a broadcast failure for the operational monitor (submit-failing /
   *  eoa-underfunded alerts) — the ONLY signal for failures that delete their ops. */
  private recordSubmitFailure(eoaAddress: `0x${string}`, err: unknown): void {
    this.submitFailureStreak++;
    this.lastSubmitError = redactError(err);
    if (isInsufficientFundsError(err)) this.insufficientFundsEoa = eoaAddress;
    metrics.inc("bundle_submit_total", 1, { chain: this.config.chainId, outcome: "error" });
  }

  /**
   * DEFINITIVE submit failure: the node provably rejected the tx. Release the reservation,
   * drop the ops with terminal failed receipts (safe — nothing is in flight, the wallet
   * should resubmit), and re-derive the EOA state from chain.
   */
  private async handleDefinitiveSubmitFailure(
    eoaAddress: `0x${string}`,
    checkedEntries: Array<{ entry: MempoolEntry }>,
    userOpHashes: `0x${string}`[],
    err: unknown,
    reservedAmount: bigint,
  ): Promise<BundleResult> {
    // Release the reservation made for this attempt (0 on Tempo — nothing reserved).
    this.accountService.releaseBalance(eoaAddress, reservedAmount);
    this.recordSubmitFailure(eoaAddress, err);
    // Redact any RPC URL (Alchemy key) embedded in the viem error — errorMsg is both logged
    // AND returned to the client below.
    const errorMsg = redactError(err);
    console.error("[Bundler] Failed to submit bundle:", errorMsg);

    // Remove failed UserOps from mempool so the user can retry without hitting the
    // "Replacement UserOp must have higher gas" error, and store failed receipts so the
    // wallet gets immediate feedback via eth_getUserOperationReceipt.
    for (const checked of checkedEntries) {
      this.mempool.remove(checked.entry.userOpHash);
    }
    this.storeFailedReceipts(
      checkedEntries.map((c) => ({
        userOpHash: c.entry.userOpHash,
        userOp: { sender: c.entry.userOp.sender, nonce: c.entry.userOp.nonce ?? 0n },
      })),
      ZERO_HASH,
      eoaAddress,
    );

    // Re-check nonce to determine if we should lock or recover
    try {
      await this.accountService.lockManager.initEOA(
        eoaAddress,
        this.publicClient as PublicClient<Transport, Chain>,
      );
    } catch {
      this.accountService.lockManager.lockEOA(eoaAddress, "LOCKED_PENDING_UNKNOWN");
    }

    return {
      submitted: false,
      userOpHashes,
      error: errorMsg,
    };
  }


  /**
   * Check all pending receipts (alarm-driven mode for CF Workers).
   * Called each alarm cycle (~10s). Each pending receipt gets one check attempt per cycle.
   * After PENDING_RECEIPT_MAX_CHECKS failures, the receipt is abandoned and the EOA
   * is left locked for the health loop to recover.
   */
  async checkPendingReceipts(): Promise<void> {
    // Reentrancy guard: this is now called from BOTH the Worker DO alarm (serialized) AND the Deno
    // ChainRegistry health-loop setInterval (NOT serialized — a slow cycle under RPC degradation can
    // overlap the next). Two concurrent runs would each rebuild the pending list and the second's
    // write could clobber the first's (and any auto-bundle push in between) → a lost receipt + a
    // leaked reservation. Skip if a run is already in flight; the next cycle picks up the rest.
    if (this._reconciling) return;
    if (this.pendingReceipts.length === 0) return;
    this._reconciling = true;
    try {
      // Terminal entries are collected by IDENTITY, then removed from the LIVE array at the end via
      // a single synchronous filter — so a UserOp submitted (this.pendingReceipts.push) during one of
      // this method's awaits is preserved, never overwritten by a stale whole-array reassignment.
      const done = new Set<PendingReceipt>();
      let bumpedThisPass = false;
      // Iterate a snapshot so a concurrent push doesn't disturb this loop.
      for (const pending of [...this.pendingReceipts]) {
        pending.checkCount++;

        const receiptClient = pending.rpcOverride
          ? getPublicClient(pending.rpcOverride)
          : this.publicClient;

        // Poll ALL broadcast hashes of this bundle, newest first — after a fee-bump either
        // the replacement or an earlier attempt may be the one that lands.
        const allHashes = [pending.txHash, ...(pending.priorTxHashes ?? [])];
        let found = false;
        for (const hash of allHashes) {
          try {
            const receipt = await receiptClient.getTransactionReceipt({ hash });
            if (receipt) {
              // Receipt found — process it synchronously
              this.storeReceiptLogs(receipt, pending.entries);

              // A CONFIRMED receipt is the proof an ambiguous broadcast lacked — the
              // submit pipe demonstrably works, so the failure streak resets here.
              this.submitFailureStreak = 0;
              this.lastSubmitError = null;
              this.insufficientFundsEoa = null;

              // Release reservation and recover EOA
              this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
              try {
                await this.accountService.lockManager.initEOA(pending.eoaAddress, receiptClient);
              } catch {
                // Health loop will recover
              }
              done.add(pending);
              found = true;
              break;
            }
          } catch {
            // No receipt for this hash yet — try the next / fall through to the drop check
          }
        }
        if (found) continue;

        // Dropped check (every 3 checks).
        //
        // PROOF-BASED when the outer nonce was pinned at broadcast: "dropped/replaced" is
        // only declared once latestNonce has advanced PAST txNonce (the chain consumed the
        // nonce) for NONCE_CONSUMED_CONFIRMATIONS consecutive probes — the receipt read can
        // transiently fail in the very cycle the nonce probe sees the advance, and a single
        // observation must not fabricate a failed receipt for a tx that actually confirmed.
        // While latestNonce <= txNonce the tx is by definition still in flight. (The old
        // `pending <= latest` heuristic misread exactly that state on RPCs without reliable
        // "pending" support and told wallets their in-flight tx failed → the wallet re-signs
        // and BOTH land — double position for the trading bot. Open issue #9.)
        if (pending.checkCount % 3 === 0) {
          if (pending.txNonce !== undefined) {
            try {
              const latestNonce = await receiptClient.getTransactionCount({
                address: pending.eoaAddress,
                blockTag: "latest",
              });
              if (latestNonce > pending.txNonce) {
                pending.nonceConsumedChecks = (pending.nonceConsumedChecks ?? 0) + 1;
                if (pending.nonceConsumedChecks >= NONCE_CONSUMED_CONFIRMATIONS) {
                  console.warn(
                    `[Bundler] Tx ${pending.txHash} replaced/dropped (latest=${latestNonce} > txNonce=${pending.txNonce}, ` +
                      `${pending.nonceConsumedChecks} consecutive probes, no receipt on ${allHashes.length} hash(es))`,
                  );
                  this.storeFailedReceipts(pending.entries, pending.txHash, pending.eoaAddress);
                  this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
                  try {
                    await this.accountService.lockManager.initEOA(pending.eoaAddress, receiptClient);
                  } catch {
                    // Health loop will recover
                  }
                  done.add(pending);
                  continue;
                }
              } else {
                pending.nonceConsumedChecks = 0; // still in flight — never a dropped verdict
              }
            } catch {
              // Nonce probe failed — keep polling
            }
          } else {
            // Legacy heuristic for receipts without a pinned nonce (Tempo / restored
            // pre-upgrade state): unchanged behavior.
            try {
              const [latestNonce, pendingNonce] = await Promise.all([
                receiptClient.getTransactionCount({ address: pending.eoaAddress, blockTag: "latest" }),
                receiptClient.getTransactionCount({ address: pending.eoaAddress, blockTag: "pending" }),
              ]);
              if (pendingNonce <= latestNonce) {
                // Same consecutive-confirmation debounce as the proof-based branch: for a
                // MINED sync-submitted (Tempo) tx `pending == latest` is the NORMAL state,
                // and a transiently failing receipt read must not fabricate a failed
                // receipt for a landed trade on a single observation.
                pending.nonceConsumedChecks = (pending.nonceConsumedChecks ?? 0) + 1;
                if (pending.nonceConsumedChecks >= NONCE_CONSUMED_CONFIRMATIONS) {
                  console.warn(`[Bundler] Tx ${pending.txHash} dropped (pending=${pendingNonce}, latest=${latestNonce}, ${pending.nonceConsumedChecks} consecutive probes)`);
                  this.storeFailedReceipts(pending.entries, pending.txHash, pending.eoaAddress);
                  this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
                  try {
                    await this.accountService.lockManager.initEOA(pending.eoaAddress, receiptClient);
                  } catch {
                    // Health loop will recover
                  }
                  done.add(pending);
                  continue;
                }
              } else {
                pending.nonceConsumedChecks = 0;
              }
            } catch {
              // Nonce check failed — keep polling
            }
          }
        }

        // Automatic same-nonce fee-bump: an underpriced tx used to sit until a human
        // intervened (the stuck-pending alert merely pointed at it) — for a 5-minute
        // trading window that is a guaranteed miss. Bounded automation replaces the wait:
        // raise fees ≥12.5% toward the current base fee, at most MAX_FEE_BUMPS times,
        // ceilinged at FEE_BUMP_REVENUE_CAP_MULTIPLE × the bundle's revenue cap (the
        // documented inclusion-first stance: the user's prepaid float absorbs a bounded
        // premium to land in-window). Native path only — Tempo's base fee is a protocol
        // constant, so "underpriced" cannot happen there.
        const pendingAge = Date.now() - pending.submittedAt;
        if (
          pending.txNonce !== undefined &&
          pending.txTo !== undefined &&
          pending.txData !== undefined &&
          pending.txGas !== undefined &&
          (pending.bumpCount ?? 0) < MAX_FEE_BUMPS &&
          pendingAge > FEE_BUMP_AFTER_MS * ((pending.bumpCount ?? 0) + 1)
        ) {
          try {
            const bumpsBefore = pending.bumpCount ?? 0;
            await this.tryFeeBump(pending);
            if ((pending.bumpCount ?? 0) !== bumpsBefore) bumpedThisPass = true;
          } catch (err) {
            console.warn(`[Bundler] fee-bump failed for ${pending.txHash} (original tx still stands): ${redactError(err)}`);
          }
        }

        // Give up after max checks. Do NOT fabricate a success=false receipt here: the
        // dropped-tx path above already stores a failed receipt when the nonce proves the
        // tx is gone. Reaching here means the tx is still pending (e.g. underpriced/stuck)
        // after ~1h of polling — telling the wallet "failed" would be a lie if it later
        // lands. Release the reservation and recover the EOA, but leave the receipt absent
        // (honest "still pending"); emit a HIGH-PRIORITY signal for an operator to inspect.
        if (pending.checkCount >= PENDING_RECEIPT_MAX_CHECKS) {
          metrics.inc("pending_receipt_abandoned_total", 1, { chain: this.config.chainId });
          console.error(
            `[Bundler] ALERT pending-receipt-abandoned tx=${pending.txHash} eoa=${pending.eoaAddress} ` +
            `checks=${pending.checkCount} ageMs=${Date.now() - pending.submittedAt} — tx still pending after max polls; needs operator review`,
          );
          this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
          // Leave the EOA locked (LOCKED_PENDING_UNKNOWN) for the health loop — the tx may
          // still confirm and we must not build a new bundle on its nonce. Keep the pinned
          // nonce so recovery stays proof-based even after abandonment.
          this.accountService.lockManager.lockEOA(pending.eoaAddress, "LOCKED_PENDING_UNKNOWN", pending.txNonce);
          done.add(pending);
          continue;
        }
        // else: still pending — leave it in the live array for the next cycle.
      }

      // Remove ONLY terminal entries from the LIVE array (synchronous read-filter-write — no await
      // in between — so a concurrent push cannot be lost).
      if (done.size > 0) {
        this.pendingReceipts = this.pendingReceipts.filter((p) => !done.has(p));
      }
      // Persist ONLY on structural change (entries settled / fees bumped). Counter-only
      // ticks (checkCount / nonceConsumedChecks) would otherwise rewrite the whole list —
      // including full handleOps calldata — to DO storage every 10s; losing counters to an
      // eviction merely restarts counting, which is the safe direction.
      if (done.size > 0 || bumpedThisPass) {
        await this.flushPendingReceipts();
      }
    } finally {
      this._reconciling = false;
    }
  }

  /**
   * Same-nonce fee-bump replacement of a stuck (underpriced) broadcast.
   *
   * Invariants:
   *   - Replacement minimums honoured: both fees rise ≥12.5% over the stuck tx.
   *   - Target: current baseFee × 1.25 + tip — enough to clear a post-quote base-fee rise.
   *   - Hard ceiling: FEE_BUMP_REVENUE_CAP_MULTIPLE × revenueCapPerGas — the loss taken from
   *     the user's prepaid float is bounded (skip the bump entirely beyond it; the
   *     stuck-pending alert then asks a human).
   *   - Gas limit is PINNED to the original tx's — the bundle content is identical and was
   *     already vetted by the pre-broadcast estimate; re-estimating against moved state could
   *     spuriously revert a replacement whose original is still perfectly minable.
   *   - The EOA must afford the new prefund (txGas × newMaxFee) — skip otherwise.
   * On success the old hash joins priorTxHashes (either broadcast may land) and the
   * reservation is re-based on the new prefund. On ambiguous broadcast errors the new hash
   * is tracked anyway (it may be in the pool); on definitive errors nothing changes — the
   * original tx still stands.
   */
  private async tryFeeBump(pending: PendingReceipt): Promise<void> {
    const gasPrices = await this.simulator.getGasPrices(undefined);
    const baseFee = gasPrices.baseFee;
    const chainTip = gasPrices.suggestedMaxPriorityFeePerGas ?? 0n;
    const oldMax = pending.maxFeePerGas ?? 0n;
    const oldTip = pending.maxPriorityFeePerGas ?? 0n;

    // Replacement minimums (geth requires ≥10%; use 12.5% + 1 wei for safety).
    let newTip = (oldTip * 1125n) / 1000n + 1n;
    if (chainTip > newTip) newTip = chainTip;
    let newMax = (oldMax * 1125n) / 1000n + 1n;
    const target = (baseFee * 125n) / 100n + newTip;
    if (target > newMax) newMax = target;

    const ceiling = (pending.revenueCapPerGas ?? oldMax) * FEE_BUMP_REVENUE_CAP_MULTIPLE;
    if (newMax > ceiling) {
      console.warn(
        `[Bundler] fee-bump for ${pending.txHash} would exceed the loss ceiling ` +
          `(${newMax} > ${ceiling}) — leaving the tx to the stuck-pending alert.`,
      );
      return;
    }
    if (newTip > newMax) newTip = newMax;

    // The EOA must afford the new worst-case prefund.
    const newPrefund = pending.txGas! * newMax;
    const balance = await this.publicClient.getBalance({ address: pending.eoaAddress });
    if (balance < newPrefund) {
      console.warn(
        `[Bundler] fee-bump for ${pending.txHash} skipped: EOA ${pending.eoaAddress} balance ` +
          `${balance} < required prefund ${newPrefund}`,
      );
      return;
    }

    // Re-derive the signing key from the bound safe (entries all share one sender).
    const sender = pending.entries[0]?.userOp.sender;
    if (!sender) return;
    const eoa = await this.accountService.deriveEOA(sender);
    if (!eoa.privateKey || eoa.address.toLowerCase() !== pending.eoaAddress.toLowerCase()) return;

    const account = privateKeyToAccount(eoa.privateKey);
    const walletClient = createWalletClient({
      account,
      transport: http(this.config.rpcUrl, BROADCAST_TRANSPORT_OPTS),
    });
    // Explicit gas skips the re-estimate (see invariants above).
    const request = await walletClient.prepareTransactionRequest({
      account,
      to: pending.txTo!,
      data: pending.txData!,
      gas: pending.txGas!,
      maxFeePerGas: newMax,
      maxPriorityFeePerGas: newTip,
      nonce: pending.txNonce!,
      chain: null,
    });
    const serialized = await walletClient.signTransaction(request as Parameters<typeof walletClient.signTransaction>[0]);
    const newHash = keccak256(serialized);

    try {
      await walletClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (err) {
      if (classifyBroadcastError(err) === "definitive") {
        console.warn(`[Bundler] fee-bump broadcast rejected for ${pending.txHash} (original stands): ${redactError(err)}`);
        return;
      }
      // Ambiguous — the replacement may be in the pool; track it alongside the original.
      console.warn(`[Bundler] fee-bump broadcast ambiguous for ${pending.txHash} — tracking ${newHash} too: ${redactError(err)}`);
    }

    pending.priorTxHashes = [...(pending.priorTxHashes ?? []), pending.txHash];
    pending.txHash = newHash;
    pending.maxFeePerGas = newMax;
    pending.maxPriorityFeePerGas = newTip;
    pending.bumpCount = (pending.bumpCount ?? 0) + 1;
    // Re-base the reservation on the new worst-case prefund.
    this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
    this.accountService.reserveBalance(pending.eoaAddress, newPrefund);
    pending.reservedAmount = newPrefund;
    metrics.inc("fee_bump_total", 1, { chain: this.config.chainId });
    console.log(
      `[Bundler] fee-bumped stuck tx (bump #${pending.bumpCount}): ${pending.priorTxHashes.at(-1)} → ${newHash} ` +
        `(maxFee ${oldMax} → ${newMax}, nonce ${pending.txNonce})`,
    );
  }

  // ---------------------------------------------------------------------------
  // Durable pending-receipt state (CF Worker mode)
  // ---------------------------------------------------------------------------

  /** Wire the durable-storage persistence hook (called by BundlerDO). */
  setPersistPendingHook(hook: (state: SerializedPendingReceipt[]) => Promise<void>): void {
    this.persistPendingHook = hook;
  }

  /**
   * Durable receipt persistence (CF Worker mode): every stored terminal receipt is written
   * through and every expiry deletes it, so a DO eviction cannot make an already-answered
   * receipt unreadable (the wallet's poll would regress from "failed/confirmed" to null).
   * Fire-and-forget — persistence must never break receipt handling.
   */
  setReceiptPersistHooks(hooks: {
    put: (userOpHash: string, receipt: SerializedReceipt, expiresAt: number) => void;
    delete: (userOpHash: string) => void;
  }): void {
    this.receiptPersistHooks = hooks;
  }
  private receiptPersistHooks?: {
    put: (userOpHash: string, receipt: SerializedReceipt, expiresAt: number) => void;
    delete: (userOpHash: string) => void;
  };

  /** Store into the in-memory receipt map AND write through to durable storage. The single
   *  choke point for every receipt write (confirmed, failed, TTL-evicted). */
  private putReceipt(userOpHash: string, receipt: UserOperationReceipt, expiresAt: number): void {
    if (this.receiptStore.size >= RECEIPT_STORE_MAX) {
      const oldest = this.receiptStore.keys().next().value;
      if (oldest !== undefined) this.deleteReceipt(oldest);
    }
    this.receiptStore.set(userOpHash, { receipt, expiresAt });
    try {
      this.receiptPersistHooks?.put(userOpHash, serializeReceipt(receipt), expiresAt);
    } catch { /* never break the money path over persistence */ }
  }

  private deleteReceipt(userOpHash: string): void {
    this.receiptStore.delete(userOpHash);
    try {
      this.receiptPersistHooks?.delete(userOpHash);
    } catch { /* ditto */ }
  }

  /** Restore persisted receipts after a DO cold start (expired ones are skipped). */
  importReceipts(saved: Array<{ userOpHash: string; receipt: SerializedReceipt; expiresAt: number }>): void {
    const now = Date.now();
    for (const s of saved) {
      if (s.expiresAt <= now) continue;
      if (this.receiptStore.has(s.userOpHash)) continue;
      try {
        this.receiptStore.set(s.userOpHash, { receipt: deserializeReceipt(s.receipt), expiresAt: s.expiresAt });
      } catch (err) {
        console.warn(`[Bundler] Skipped unrestorable receipt ${s.userOpHash}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** True when at least one bundle is awaiting confirmation. */
  get pendingReceiptCount(): number {
    return this.pendingReceipts.length;
  }

  /** Age (ms) of the oldest in-flight pending receipt, or 0 if none. */
  oldestPendingReceiptAgeMs(now: number = Date.now()): number {
    let oldest = 0;
    for (const p of this.pendingReceipts) {
      const age = now - p.submittedAt;
      if (age > oldest) oldest = age;
    }
    return oldest;
  }

  /** Serialize the in-flight pending receipts for durable storage. */
  exportPendingState(): SerializedPendingReceipt[] {
    return this.pendingReceipts.map((p) => ({
      txHash: p.txHash,
      priorTxHashes: p.priorTxHashes,
      entries: p.entries.map((e) => ({ userOpHash: e.userOpHash, sender: e.userOp.sender, nonce: e.userOp.nonce.toString() })),
      eoaAddress: p.eoaAddress,
      reservedAmount: p.reservedAmount.toString(),
      rpcOverride: p.rpcOverride,
      submittedAt: p.submittedAt,
      checkCount: p.checkCount,
      txNonce: p.txNonce,
      nonceConsumedChecks: p.nonceConsumedChecks,
      txTo: p.txTo,
      txData: p.txData,
      txGas: p.txGas?.toString(),
      maxFeePerGas: p.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: p.maxPriorityFeePerGas?.toString(),
      revenueCapPerGas: p.revenueCapPerGas?.toString(),
      bumpCount: p.bumpCount,
      // Persist the lock clock so a DO eviction can't reset the stuck-eoa age to "just now"
      // (repeated evictions used to defer that alert indefinitely).
      lockedSince: this.accountService.lockManager.getState(p.eoaAddress)?.lockedSince ?? p.submittedAt,
    }));
  }

  /**
   * Restore pending receipts from durable storage after a DO eviction/restart, so the
   * alarm resumes reconciling bundles submitted before the eviction. Also re-locks the
   * EOAs so no new bundle is built on top of an unconfirmed nonce. Merges with (does not
   * clobber) any in-memory entries.
   */
  importPendingState(saved: SerializedPendingReceipt[] | undefined | null): void {
    if (!saved || !Array.isArray(saved) || saved.length === 0) return;
    const known = new Set(this.pendingReceipts.map((p) => p.txHash));
    for (const s of saved) {
      if (known.has(s.txHash)) continue;
      try {
        this.pendingReceipts.push({
          txHash: s.txHash,
          priorTxHashes: s.priorTxHashes,
          entries: (s.entries ?? []).map((e) => ({ userOpHash: e.userOpHash, userOp: { sender: e.sender, nonce: BigInt(e.nonce) } })),
          eoaAddress: s.eoaAddress,
          reservedAmount: BigInt(s.reservedAmount),
          rpcOverride: s.rpcOverride,
          submittedAt: s.submittedAt,
          checkCount: s.checkCount,
          txNonce: s.txNonce,
          nonceConsumedChecks: s.nonceConsumedChecks,
          txTo: s.txTo,
          txData: s.txData,
          txGas: s.txGas !== undefined ? BigInt(s.txGas) : undefined,
          maxFeePerGas: s.maxFeePerGas !== undefined ? BigInt(s.maxFeePerGas) : undefined,
          maxPriorityFeePerGas: s.maxPriorityFeePerGas !== undefined ? BigInt(s.maxPriorityFeePerGas) : undefined,
          revenueCapPerGas: s.revenueCapPerGas !== undefined ? BigInt(s.revenueCapPerGas) : undefined,
          bumpCount: s.bumpCount,
        });
        // Re-establish the reservation + lock so a recovered DO doesn't double-spend the
        // EOA while the prior tx is still in flight. restorePending CREATES the EOA state
        // (the cold-started DO's lock manager is empty) — reserveBalance/lockEOA would
        // otherwise silently no-op on the absent state and leave the guard non-functional.
        // The persisted nonce keeps recovery proof-based; the persisted lock clock keeps
        // the stuck-eoa alert's age honest across evictions.
        this.accountService.lockManager.restorePending(s.eoaAddress, BigInt(s.reservedAmount), {
          inFlightNonce: s.txNonce,
          lockedSince: s.lockedSince,
        });
      } catch (err) {
        console.warn(`[Bundler] Skipped unrestorable pending receipt ${s.txHash}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Persist the current pending-receipt list via the durable hook (non-fatal). */
  private async flushPendingReceipts(): Promise<void> {
    if (!this.persistPendingHook) return;
    try {
      await this.persistPendingHook(this.exportPendingState());
    } catch (err) {
      console.warn(`[Bundler] Failed to persist pending receipts: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Store event logs from a confirmed receipt into the receipt store.
   *
   * A REVERTED outer tx (e.g. a fee-bump replacement that ran out of its pinned gas after
   * chain state moved) carries NO UserOperationEvent logs — every entry it covered would
   * otherwise end with no terminal receipt at all (wallet polls null forever). Any entry
   * not matched by an event log therefore gets an explicit success:false receipt tied to
   * the landed tx hash: the outer tx consumed the nonce, so the ops definitively did not
   * (and can never) execute under it.
   */
  private storeReceiptLogs(receipt: { status: string; logs: readonly Log[]; blockNumber: bigint; blockHash: `0x${string}`; transactionHash: `0x${string}`; transactionIndex: number; from: `0x${string}`; to: `0x${string}` | null; cumulativeGasUsed: bigint; gasUsed: bigint; effectiveGasPrice: bigint }, entries: PendingEntry[]): void {
    const logs = parseEventLogs({
      abi: ENTRYPOINT_V07_ABI,
      logs: receipt.logs as Log[],
      eventName: "UserOperationEvent",
    });

    const covered = new Set<string>();
    for (const log of logs) covered.add((log.args.userOpHash as string));
    const unmatched = entries.filter((e) => !covered.has(e.userOpHash));
    if (unmatched.length > 0) {
      console.warn(
        `[Bundler] tx ${receipt.transactionHash} (status=${receipt.status}) carried no UserOperationEvent ` +
          `for ${unmatched.length} op(s) — storing terminal failed receipts.`,
      );
      this.storeFailedReceipts(unmatched, receipt.transactionHash, receipt.from);
    }

    for (const log of logs) {
      const userOpHash = log.args.userOpHash as `0x${string}`;
      const entry = entries.find((e) => e.userOpHash === userOpHash);

      const opReceipt: UserOperationReceipt = {
        userOpHash,
        entryPoint: this.config.entryPointAddress,
        sender: log.args.sender as `0x${string}`,
        nonce: entry?.userOp.nonce ?? 0n,
        paymaster: (log.args.paymaster as `0x${string}`) || null,
        actualGasCost: log.args.actualGasCost as bigint,
        actualGasUsed: log.args.actualGasUsed as bigint,
        success: log.args.success as boolean,
        logs: receipt.logs.map((l, i) => ({
          logIndex: l.logIndex ?? i,
          address: l.address as `0x${string}`,
          topics: l.topics as `0x${string}`[],
          data: l.data as `0x${string}`,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionHash: receipt.transactionHash,
        })),
        receipt: {
          transactionHash: receipt.transactionHash,
          transactionIndex: receipt.transactionIndex,
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber,
          from: receipt.from,
          to: (receipt.to ?? this.config.entryPointAddress) as `0x${string}`,
          cumulativeGasUsed: receipt.cumulativeGasUsed,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
        },
      };

      this.putReceipt(userOpHash, opReceipt, Date.now() + RECEIPT_TTL_MS);
    }
  }

  /** Store failed receipt entries for user-facing feedback. */
  private storeFailedReceipts(entries: PendingEntry[], txHash: `0x${string}`, eoaAddress: `0x${string}`): void {
    for (const entry of entries) {
      this.putReceipt(entry.userOpHash, {
        userOpHash: entry.userOpHash as `0x${string}`,
        entryPoint: this.config.entryPointAddress,
        sender: entry.userOp.sender,
        nonce: entry.userOp.nonce ?? 0n,
        paymaster: null,
        actualGasCost: 0n,
        actualGasUsed: 0n,
        success: false,
        logs: [],
        receipt: {
          transactionHash: txHash,
          transactionIndex: 0,
          blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
          blockNumber: 0n,
          from: eoaAddress,
          to: this.config.entryPointAddress,
          cumulativeGasUsed: 0n,
          gasUsed: 0n,
          effectiveGasPrice: 0n,
        },
      }, Date.now() + RECEIPT_TTL_MS);
    }
  }

  getReceipt(userOpHash: string): UserOperationReceipt | undefined {
    const entry = this.receiptStore.get(userOpHash);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.deleteReceipt(userOpHash);
      return undefined;
    }
    return entry.receipt;
  }

  getUserOpByHash(
    userOpHash: string,
  ): { userOp: MempoolEntry["userOp"]; receipt?: UserOperationReceipt } | undefined {
    const memEntry = this.mempool.get(userOpHash);
    if (memEntry) return { userOp: memEntry.userOp };
    const receipt = this.getReceipt(userOpHash);
    if (receipt) return { userOp: undefined as unknown as MempoolEntry["userOp"], receipt };
    return undefined;
  }
}
