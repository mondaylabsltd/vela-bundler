/**
 * Bundle builder and submitter — private prepaid bundler mode.
 *
 * In private mode, each bundle contains ops from ONE safeAddress only,
 * signed by the dedicated bundler EOA derived for that safeAddress.
 * The beneficiary is the dedicated EOA itself.
 */

import {
  createWalletClient,
  http,
  type PublicClient,
  type Transport,
  type Chain,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRYPOINT_V07_ABI } from "../contracts/entrypoint.ts";
import { getPublicClient } from "../utils/rpc-client.ts";
import { metrics } from "../reliability/log.ts";
import { createDeadline } from "../reliability/retry.ts";
import { executeSweep } from "./sweep.ts";
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
  checkBundleProfitability,
} from "../gas/profitability.ts";
import { computeOuterGas, reverseMarkup, markupToBps } from "../gas/fee-model.ts";
import { parseValidationData, isValidTimeRange } from "../userop/validate.ts";
import {
  isTempoChain,
  resolveFeeToken,
  tempoCostInFeeToken,
  parseTempoReimbursement,
  submitTempoBundle,
  TEMPO_COST_BUFFER_GAS,
} from "../tempo.ts";

export interface BundleResult {
  submitted: boolean;
  transactionHash?: `0x${string}`;
  userOpHashes: `0x${string}`[];
  error?: string;
}

/** Receipt TTL — 24 hours. */
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** Max receipt store entries — prevents unbounded memory growth. */
const RECEIPT_STORE_MAX = 10_000;

/** Max polling attempts for a single pending receipt. Now that pending receipts are
 *  persisted across DO evictions, we can poll far longer before giving up — a stuck
 *  (underpriced) tx may take many minutes to clear. 360 × ~10s alarm ≈ 1 hour. */
const PENDING_RECEIPT_MAX_CHECKS = 360;

/** Per-sender bundle-prep budget: bounds one sender's RPC reads + simulations so a slow
 *  sender can't starve the others (or the alarm) within a cycle. */
const PER_SENDER_BUNDLE_DEADLINE_MS = 20_000;

/** Treasury sweep toggle. When on, after a confirmed bundle the relayer's surplus
 *  is skimmed back to the treasury, but only every `sweepInterval` txs and only the
 *  portion above a per-tx float floor (see bundler/sweep.ts). Set false to disable. */
const SWEEP_ENABLED = true;

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
  entries: PendingEntry[];
  eoaAddress: `0x${string}`;
  reservedAmount: bigint;
  rpcOverride?: string;
  submittedAt: number;
  checkCount: number;
}

/** Serialized form persisted to DO storage (bigints → decimal strings). */
interface SerializedPendingReceipt {
  txHash: `0x${string}`;
  entries: Array<{ userOpHash: `0x${string}`; sender: `0x${string}`; nonce: string }>;
  eoaAddress: `0x${string}`;
  reservedAmount: string;
  rpcOverride?: string;
  submittedAt: number;
  checkCount: number;
}

export class BundlerService {
  private receiptStore: Map<string, { receipt: UserOperationReceipt; expiresAt: number }> = new Map();
  private readonly publicClient: PublicClient<Transport, Chain>;
  private autoBundleTimer?: ReturnType<typeof setInterval>;
  private receiptCleanupTimer?: ReturnType<typeof setInterval>;
  private currentBundlingMode: "auto" | "manual";
  private readonly disableTimers: boolean;
  /** Pending receipts tracked for alarm-driven polling (CF Worker mode). */
  private pendingReceipts: PendingReceipt[] = [];
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
        if (this.mempool.size > 0) {
          await this.tryBundle();
        }
      } catch (err) {
        console.error("[Bundler] Auto-bundle error:", err);
      }
      // Periodic receipt cleanup
      this.cleanExpiredReceipts();
    }, this.config.autoBundleIntervalMs);
  }

  cleanExpiredReceipts(): void {
    const now = Date.now();
    for (const [hash, entry] of this.receiptStore) {
      if (now > entry.expiresAt) this.receiptStore.delete(hash);
    }
  }

  stopAutoBundling(): void {
    if (this.autoBundleTimer) {
      clearInterval(this.autoBundleTimer);
      this.autoBundleTimer = undefined;
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

    // Process one sender at a time
    let lastResult: BundleResult = {
      submitted: false,
      userOpHashes: [],
      error: "No bundles processed",
    };

    for (const [sender, senderEntries] of bySender) {
      const result = await this.trySenderBundle(
        sender as `0x${string}`,
        senderEntries,
      );
      if (result.submitted) {
        lastResult = result;
      }
    }

    return lastResult;
  }

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
    const effectiveRpc = rpcOverride ?? this.config.rpcUrl;

    // Bound this single sender's bundle prep by a deadline shared across all its RPC
    // reads/simulations, so one slow sender can't starve the rest of the senders (or the
    // alarm itself) within a cycle. Real cancellation flows through rpcCall's AbortSignal.
    const dl = createDeadline(PER_SENDER_BUNDLE_DEADLINE_MS);

    const gasPrices = await this.simulator.getGasPrices(rpcOverride, dl);
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
    const outerGas = computeOuterGas({
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

    // Re-validate all ops in parallel: validation + execution simulation
    type CheckedEntry = { entry: MempoolEntry; accountValidationData: bigint; paymasterValidationData: bigint };
    const simResults = await Promise.allSettled(
      validEntries.map(async (entry): Promise<CheckedEntry | null> => {
        const simResult = await this.simulator.simulateValidation(entry.userOp, rpcOverride, dl);
        if (!simResult.valid) {
          console.warn(`[Bundler] UserOp ${entry.userOpHash} failed re-validation: ${simResult.errorMessage}`);
          return null;
        }
        const execResult = await this.simulator.simulateExecution(entry.userOp, rpcOverride, dl);
        if (!execResult.success) {
          console.warn(`[Bundler] UserOp ${entry.userOpHash} failed execution simulation: ${execResult.errorMessage}`);
          return null;
        }
        return {
          entry,
          accountValidationData: simResult.validationResult?.accountValidationData ?? 0n,
          paymasterValidationData: simResult.validationResult?.paymasterValidationData ?? 0n,
        };
      }),
    );

    const checkedEntries: CheckedEntry[] = [];
    for (let i = 0; i < simResults.length; i++) {
      const result = simResults[i]!;
      if (result.status === "fulfilled" && result.value) {
        checkedEntries.push(result.value);
      } else {
        // Failed validation or execution — remove from mempool
        const failed = validEntries[i]!;
        this.mempool.remove(failed.userOpHash);
        this.mempool.reputation.penalize(failed.userOp.sender, "sender");
      }
    }

    if (checkedEntries.length === 0) {
      return { submitted: false, userOpHashes: [], error: "All ops failed re-validation" };
    }

    // Beneficiary = the dedicated bundler EOA itself
    const beneficiary = eoa.address;

    // Full bundle simulation
    const packedOps = checkedEntries.map((e) => e.entry.packed);
    const bundleSim = await this.simulator.simulateBundle(packedOps, beneficiary, rpcOverride, dl);

    if (!bundleSim.success) {
      // Remove failed op if identified
      if (bundleSim.failedOpIndex !== undefined) {
        const failed = checkedEntries[bundleSim.failedOpIndex];
        if (failed) {
          this.mempool.remove(failed.entry.userOpHash);
          this.mempool.reputation.penalize(failed.entry.userOp.sender, "sender");
        }
      }
      return {
        submitted: false,
        userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
        error: `Bundle simulation failed: ${bundleSim.errorMessage}`,
      };
    }

    const tempo = isTempoChain(this.config.chainId);

    // expectedCost is the native outer-tx cost (used for native balance reserve).
    // On Tempo it's meaningless (no native coin) and unused.
    const expectedCost = bundleSim.estimatedGas! * outerGas.effectiveGasPrice;

    if (tempo) {
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
      const execCheck = await this.simulator.simulateExecutionSuccess(packedOps, beneficiary, rpcOverride, dl);
      if (!execCheck.success) {
        if (execCheck.failedOpIndex !== undefined) {
          const failed = checkedEntries[execCheck.failedOpIndex];
          if (failed) {
            this.mempool.remove(failed.entry.userOpHash);
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
        balanceCheck = await this.accountService.checkBalance(safeAddress, expectedCost, rpcOverride);
      } catch (err) {
        console.error(`[Bundler] Balance check failed for ${safeAddress}:`, err);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: "Balance check RPC failed",
        };
      }
      if (!balanceCheck.sufficient) {
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
        this.mempool.remove(checked.entry.userOpHash);
        return {
          submitted: false,
          userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
          error: `UserOp ${checked.entry.userOpHash} expired before submission (validUntil=${acctVD.validUntil})`,
        };
      }
      if (checked.paymasterValidationData !== 0n) {
        const pmVD = parseValidationData(checked.paymasterValidationData);
        if (!isValidTimeRange(pmVD.validAfter, pmVD.validUntil, 10)) {
          this.mempool.remove(checked.entry.userOpHash);
          return {
            submitted: false,
            userOpHashes: checkedEntries.map((e) => e.entry.userOpHash),
            error: `UserOp ${checked.entry.userOpHash} paymaster expired before submission`,
          };
        }
      }
    }

    // Reserve balance atomically (native only — Tempo settles in stablecoin in-band).
    if (!tempo) this.accountService.reserveBalance(eoa.address, expectedCost);

    // Submit using the dedicated EOA as signer, via user's RPC if provided
    const account = privateKeyToAccount(eoa.privateKey!);
    const submitRpcUrl = rpcOverride ?? this.config.rpcUrl;
    const walletClient = createWalletClient({
      account,
      transport: http(submitRpcUrl),
    });

    const calldata = encodeHandleOps(packedOps, beneficiary);
    const userOpHashes = checkedEntries.map((e) => e.entry.userOpHash);

    console.log(
      `[Bundler] Submitting bundle for ${safeAddress} via ${tempo ? "Tempo 0x76" : "EIP-1559"} (eoa=${eoa.address}, rpc=${submitRpcUrl})`,
    );

    try {
      // Tempo: submit handleOps inside a native 0x76 tx paying gas in the stablecoin.
      // Every other chain: standard EIP-1559 handleOps from the dedicated EOA.
      const txHash = tempo
        ? await submitTempoBundle({
            chainId: this.config.chainId,
            privateKey: eoa.privateKey!,
            rpcUrl: submitRpcUrl,
            entryPoint: this.config.entryPointAddress,
            packedOps,
            beneficiary,
            feeToken: resolveFeeToken(checkedEntries[0]!.entry.userOp.feeToken),
          })
        : await walletClient.sendTransaction({
            to: this.config.entryPointAddress,
            data: calldata,
            maxFeePerGas: outerGas.maxFeePerGas,
            maxPriorityFeePerGas: outerGas.maxPriorityFeePerGas,
            chain: null,
            account,
          });

      metrics.inc("bundle_submit_total", 1, { chain: this.config.chainId, outcome: "ok" });
      console.log(
        `[Bundler] Bundle submitted for ${safeAddress}: ${txHash} ` +
        `(${checkedEntries.length} ops, EOA: ${eoa.address})`,
      );

      // Remove from mempool
      const submittedEntries = checkedEntries.map((e) => e.entry);
      for (const entry of submittedEntries) {
        this.mempool.remove(entry.userOpHash);
        this.mempool.reputation.updateIncluded(entry.userOp.sender, "sender");
      }

      // Lock EOA until receipt is confirmed to prevent double-spend
      this.accountService.lockManager.lockEOA(eoa.address, "LOCKED_PENDING_UNKNOWN");

      if (this.disableTimers) {
        // CF Worker mode: track pending receipt for alarm-driven polling.
        // DO alarm calls checkPendingReceipts() each cycle — no fire-and-forget.
        this.pendingReceipts.push({
          txHash,
          entries: submittedEntries.map((e) => ({
            userOpHash: e.userOpHash,
            userOp: { sender: e.userOp.sender, nonce: e.userOp.nonce ?? 0n },
          })),
          eoaAddress: eoa.address,
          reservedAmount: expectedCost,
          rpcOverride,
          submittedAt: Date.now(),
          checkCount: 0,
        });
        // Persist immediately so an eviction in the gap before the next alarm tick
        // cannot abandon this in-flight bundle's reconciliation. Non-fatal on error.
        await this.flushPendingReceipts();
      } else {
        // Deno mode: process receipt in background — unlocks EOA on success
        this.processReceipt(txHash, submittedEntries, eoa.address, expectedCost, rpcOverride)
          .then(async () => {
            const client = rpcOverride ? getPublicClient(rpcOverride) : this.publicClient;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await this.accountService.lockManager.initEOA(eoa.address, client);
                return;
              } catch (err) {
                const delay = 2_000 * (2 ** attempt);
                console.warn(
                  `[Bundler] initEOA recovery attempt ${attempt + 1}/3 failed for ${eoa.address}: ${err instanceof Error ? err.message : err}. Retrying in ${delay}ms...`,
                );
                await new Promise((r) => setTimeout(r, delay));
              }
            }
            console.error(
              `[Bundler] Failed to recover EOA ${eoa.address} after 3 retries. ` +
              `EOA remains LOCKED_PENDING_UNKNOWN — health loop will continue recovery attempts.`,
            );
          })
          .catch((err) => {
            console.error("[Bundler] Failed to process receipt:", err);
            this.accountService.lockManager.lockEOA(eoa.address, "LOCKED_PENDING_UNKNOWN");
          });
      }

      return { submitted: true, transactionHash: txHash, userOpHashes };
    } catch (err) {
      // Release reservation on submission failure
      this.accountService.releaseBalance(eoa.address, expectedCost);
      metrics.inc("bundle_submit_total", 1, { chain: this.config.chainId, outcome: "error" });
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[Bundler] Failed to submit bundle:", errorMsg);

      // Remove failed UserOps from mempool so the user can retry without
      // hitting the "Replacement UserOp must have higher gas" error.
      for (const checked of checkedEntries) {
        this.mempool.remove(checked.entry.userOpHash);
      }

      // Store failed receipts so wallet gets immediate feedback via
      // eth_getUserOperationReceipt instead of polling until timeout.
      for (const checked of checkedEntries) {
        const entry = checked.entry;
        if (this.receiptStore.size >= RECEIPT_STORE_MAX) {
          const oldest = this.receiptStore.keys().next().value;
          if (oldest !== undefined) this.receiptStore.delete(oldest);
        }
        this.receiptStore.set(entry.userOpHash, {
          receipt: {
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
              transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
              transactionIndex: 0,
              blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
              blockNumber: 0n,
              from: eoa.address,
              to: this.config.entryPointAddress,
              cumulativeGasUsed: 0n,
              gasUsed: 0n,
              effectiveGasPrice: 0n,
            },
          },
          expiresAt: Date.now() + RECEIPT_TTL_MS,
        });
      }

      // Re-check nonce to determine if we should lock or recover
      try {
        await this.accountService.lockManager.initEOA(
          eoa.address,
          this.publicClient as PublicClient<Transport, Chain>,
        );
      } catch {
        this.accountService.lockManager.lockEOA(eoa.address, "LOCKED_PENDING_UNKNOWN");
      }

      return {
        submitted: false,
        userOpHashes,
        error: errorMsg,
      };
    }
  }

  /**
   * Wait for receipt, store results, release reservation.
   */
  private async processReceipt(
    txHash: `0x${string}`,
    entries: MempoolEntry[],
    eoaAddress: `0x${string}`,
    reservedAmount: bigint,
    rpcOverride?: string,
  ): Promise<void> {
    try {
      const receiptClient = rpcOverride
        ? getPublicClient(rpcOverride)
        : this.publicClient;

      // Poll for receipt with dropped-tx detection.
      // Between receipt polls, check if the tx is still in the mempool.
      // If pendingNonce == latestNonce, the tx was dropped — fail fast.
      let receipt;
      const maxAttempts = 60; // 60 × 4s = 240s max
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          receipt = await receiptClient.getTransactionReceipt({ hash: txHash });
          if (receipt) break;
        } catch {
          // getTransactionReceipt returns null or throws if not found — continue polling
        }

        // Every 5 polls (~20s), check if the tx was dropped from mempool
        if (attempt > 0 && attempt % 5 === 0) {
          try {
            const [latestNonce, pendingNonce] = await Promise.all([
              receiptClient.getTransactionCount({ address: eoaAddress, blockTag: "latest" }),
              receiptClient.getTransactionCount({ address: eoaAddress, blockTag: "pending" }),
            ]);
            if (pendingNonce <= latestNonce) {
              // No pending tx — it was dropped from mempool
              console.warn(
                `[Bundler] Tx ${txHash} dropped from mempool (pending=${pendingNonce}, latest=${latestNonce}). Marking UserOps as failed.`,
              );
              // Store a failed receipt so wallet gets immediate feedback
              for (const entry of entries) {
                if (this.receiptStore.size >= RECEIPT_STORE_MAX) {
                  const oldest = this.receiptStore.keys().next().value;
                  if (oldest !== undefined) this.receiptStore.delete(oldest);
                }
                this.receiptStore.set(entry.userOpHash, {
                  receipt: {
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
                  },
                  expiresAt: Date.now() + RECEIPT_TTL_MS,
                });
              }
              return; // exit early — finally block releases reservation
            }
          } catch {
            // Nonce check failed — continue polling for receipt
          }
        }

        await new Promise((r) => setTimeout(r, 4_000));
      }
      if (!receipt) throw new Error(`Receipt not found for ${txHash} after polling`);

      const logs = parseEventLogs({
        abi: ENTRYPOINT_V07_ABI,
        logs: receipt.logs,
        eventName: "UserOperationEvent",
      });

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
            from: receipt.from as `0x${string}`,
            to: (receipt.to ?? this.config.entryPointAddress) as `0x${string}`,
            cumulativeGasUsed: receipt.cumulativeGasUsed,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
          },
        };

        // Evict oldest entry if at capacity (Map iterates in insertion order)
        if (this.receiptStore.size >= RECEIPT_STORE_MAX) {
          const oldest = this.receiptStore.keys().next().value;
          if (oldest !== undefined) this.receiptStore.delete(oldest);
        }

        this.receiptStore.set(userOpHash, {
          receipt: opReceipt,
          expiresAt: Date.now() + RECEIPT_TTL_MS,
        });
      }
      // Post-bundle sweep: skim the relayer's surplus back to treasury (only every
      // `sweepInterval` txs, only above the float floor — see executeSweep).
      // Runs after receipt is confirmed, inside the finally block would be too late
      // (reservation is released there). Non-fatal — errors are logged and ignored.
      if (SWEEP_ENABLED && receipt && receipt.status === "success" && this.config.treasuryAddress) {
        try {
          const eoaDerived = await this.accountService.deriveEOA(
            entries[0]!.userOp.sender as `0x${string}`,
          );
          if (eoaDerived.privateKey) {
            const sweepRpc = rpcOverride ?? this.config.rpcUrl;
            await executeSweep({
              eoaAddress,
              eoaPrivateKey: eoaDerived.privateKey,
              treasuryAddress: this.config.treasuryAddress,
              rpcUrl: sweepRpc,
              config: this.config,
            });
          }
        } catch (err) {
          console.warn(`[Bundler] Post-bundle sweep failed for ${eoaAddress}:`, err);
        }
      }
    } finally {
      // Always release reservation after confirmation/failure
      this.accountService.releaseBalance(eoaAddress, reservedAmount);
    }
  }

  /**
   * Check all pending receipts (alarm-driven mode for CF Workers).
   * Called each alarm cycle (~10s). Each pending receipt gets one check attempt per cycle.
   * After PENDING_RECEIPT_MAX_CHECKS failures, the receipt is abandoned and the EOA
   * is left locked for the health loop to recover.
   */
  async checkPendingReceipts(): Promise<void> {
    if (this.pendingReceipts.length === 0) return;

    const remaining: PendingReceipt[] = [];

    for (const pending of this.pendingReceipts) {
      pending.checkCount++;

      const receiptClient = pending.rpcOverride
        ? getPublicClient(pending.rpcOverride)
        : this.publicClient;

      try {
        const receipt = await receiptClient.getTransactionReceipt({ hash: pending.txHash });
        if (receipt) {
          // Receipt found — process it synchronously
          this.storeReceiptLogs(receipt, pending.entries);

          // Post-bundle sweep
          if (SWEEP_ENABLED && receipt.status === "success" && this.config.treasuryAddress) {
            try {
              const eoaDerived = await this.accountService.deriveEOA(
                pending.entries[0]!.userOp.sender as `0x${string}`,
              );
              if (eoaDerived.privateKey) {
                await executeSweep({
                  eoaAddress: pending.eoaAddress,
                  eoaPrivateKey: eoaDerived.privateKey,
                  treasuryAddress: this.config.treasuryAddress,
                  rpcUrl: pending.rpcOverride ?? this.config.rpcUrl,
                  config: this.config,
                });
              }
            } catch (err) {
              console.warn(`[Bundler] Post-bundle sweep failed for ${pending.eoaAddress}:`, err);
            }
          }

          // Release reservation and recover EOA
          this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
          try {
            await this.accountService.lockManager.initEOA(pending.eoaAddress, receiptClient);
          } catch {
            // Health loop will recover
          }
          continue; // Don't add back to remaining
        }
      } catch {
        // Receipt not found yet — check if tx was dropped
      }

      // Check if tx was dropped (every 3 checks)
      if (pending.checkCount % 3 === 0) {
        try {
          const [latestNonce, pendingNonce] = await Promise.all([
            receiptClient.getTransactionCount({ address: pending.eoaAddress, blockTag: "latest" }),
            receiptClient.getTransactionCount({ address: pending.eoaAddress, blockTag: "pending" }),
          ]);
          if (pendingNonce <= latestNonce) {
            // Tx was dropped — store failed receipts, release reservation
            console.warn(`[Bundler] Tx ${pending.txHash} dropped (pending=${pendingNonce}, latest=${latestNonce})`);
            this.storeFailedReceipts(pending.entries, pending.txHash, pending.eoaAddress);
            this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
            try {
              await this.accountService.lockManager.initEOA(pending.eoaAddress, receiptClient);
            } catch {
              // Health loop will recover
            }
            continue;
          }
        } catch {
          // Nonce check failed — keep polling
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
        // still confirm and we must not build a new bundle on its nonce.
        this.accountService.lockManager.lockEOA(pending.eoaAddress, "LOCKED_PENDING_UNKNOWN");
        continue;
      }

      remaining.push(pending);
    }

    this.pendingReceipts = remaining;
    // Persist the trimmed list so completed/abandoned receipts aren't re-polled after an
    // eviction, and so a restart resumes exactly the still-in-flight set.
    await this.flushPendingReceipts();
  }

  // ---------------------------------------------------------------------------
  // Durable pending-receipt state (CF Worker mode)
  // ---------------------------------------------------------------------------

  /** Wire the durable-storage persistence hook (called by BundlerDO). */
  setPersistPendingHook(hook: (state: SerializedPendingReceipt[]) => Promise<void>): void {
    this.persistPendingHook = hook;
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
      entries: p.entries.map((e) => ({ userOpHash: e.userOpHash, sender: e.userOp.sender, nonce: e.userOp.nonce.toString() })),
      eoaAddress: p.eoaAddress,
      reservedAmount: p.reservedAmount.toString(),
      rpcOverride: p.rpcOverride,
      submittedAt: p.submittedAt,
      checkCount: p.checkCount,
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
          entries: (s.entries ?? []).map((e) => ({ userOpHash: e.userOpHash, userOp: { sender: e.sender, nonce: BigInt(e.nonce) } })),
          eoaAddress: s.eoaAddress,
          reservedAmount: BigInt(s.reservedAmount),
          rpcOverride: s.rpcOverride,
          submittedAt: s.submittedAt,
          checkCount: s.checkCount,
        });
        // Re-establish the reservation + lock so a recovered DO doesn't double-spend the
        // EOA while the prior tx is still in flight.
        this.accountService.reserveBalance(s.eoaAddress, BigInt(s.reservedAmount));
        this.accountService.lockManager.lockEOA(s.eoaAddress, "LOCKED_PENDING_UNKNOWN");
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

  /** Store event logs from a confirmed receipt into the receipt store. */
  private storeReceiptLogs(receipt: { status: string; logs: readonly any[]; blockNumber: bigint; blockHash: `0x${string}`; transactionHash: `0x${string}`; transactionIndex: number; from: `0x${string}`; to: `0x${string}` | null; cumulativeGasUsed: bigint; gasUsed: bigint; effectiveGasPrice: bigint }, entries: PendingEntry[]): void {
    const logs = parseEventLogs({
      abi: ENTRYPOINT_V07_ABI,
      logs: receipt.logs as any,
      eventName: "UserOperationEvent",
    });

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
        logs: receipt.logs.map((l: any, i: number) => ({
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

      if (this.receiptStore.size >= RECEIPT_STORE_MAX) {
        const oldest = this.receiptStore.keys().next().value;
        if (oldest !== undefined) this.receiptStore.delete(oldest);
      }
      this.receiptStore.set(userOpHash, { receipt: opReceipt, expiresAt: Date.now() + RECEIPT_TTL_MS });
    }
  }

  /** Store failed receipt entries for user-facing feedback. */
  private storeFailedReceipts(entries: PendingEntry[], txHash: `0x${string}`, eoaAddress: `0x${string}`): void {
    for (const entry of entries) {
      if (this.receiptStore.size >= RECEIPT_STORE_MAX) {
        const oldest = this.receiptStore.keys().next().value;
        if (oldest !== undefined) this.receiptStore.delete(oldest);
      }
      this.receiptStore.set(entry.userOpHash, {
        receipt: {
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
        },
        expiresAt: Date.now() + RECEIPT_TTL_MS,
      });
    }
  }

  getReceipt(userOpHash: string): UserOperationReceipt | undefined {
    const entry = this.receiptStore.get(userOpHash);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.receiptStore.delete(userOpHash);
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
