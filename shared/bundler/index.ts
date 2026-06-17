/**
 * Bundle builder and submitter — private prepaid bundler mode.
 *
 * In private mode, each bundle contains ops from ONE safeAddress only,
 * signed by the dedicated bundler EOA derived for that safeAddress.
 * The beneficiary is the dedicated EOA itself.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
  type Chain,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRYPOINT_V07_ABI } from "../contracts/entrypoint.ts";
import { getPublicClient } from "../utils/rpc-client.ts";
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
import { parseValidationData, isValidTimeRange } from "../userop/validate.ts";

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

/** Max polling attempts for a single pending receipt (60 × ~10s alarm = 10 min). */
const PENDING_RECEIPT_MAX_CHECKS = 60;

/** Post-bundle treasury sweep toggle. Temporarily disabled — we no longer skim
 *  25% of the relayer balance to the treasury after every bundle. Flip back to
 *  `true` to re-enable. */
const SWEEP_ENABLED = false;

/** Metadata for a pending transaction that needs receipt confirmation. */
interface PendingReceipt {
  txHash: `0x${string}`;
  entries: MempoolEntry[];
  eoaAddress: `0x${string}`;
  reservedAmount: bigint;
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

  constructor(
    private readonly config: BundlerConfig,
    private readonly mempool: Mempool,
    private readonly simulator: Simulator,
    private readonly accountService: AccountService,
    options?: { disableTimers?: boolean },
  ) {
    this.currentBundlingMode = config.bundlingMode;
    this.disableTimers = options?.disableTimers ?? false;
    this.publicClient = createPublicClient({
      transport: http(config.rpcUrl),
    }) as PublicClient<Transport, Chain>;
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
    // Use user-provided RPC if any entry has one (all ops for same sender share the same RPC)
    const rpcOverride = entries.find((e) => e.rpcUrlOverride)?.rpcUrlOverride;
    const effectiveRpc = rpcOverride ?? this.config.rpcUrl;

    const gasPrices = await this.simulator.getGasPrices(rpcOverride);
    const baseFee = gasPrices.baseFee;

    // Derive outer tx gas price from the UserOp's maxFeePerGas.
    // Wallet sets: maxFeePerGas = gasPrice × speedTier × WALLET_GAS_MARKUP
    // Bundler reverses: outerGasPrice = userOpGasPrice / WALLET_GAS_MARKUP = gasPrice × speedTier
    // Margin = WALLET_GAS_MARKUP - 1 (constant, independent of tier).
    // Speed tier is preserved: higher tier → higher outer gas → faster inclusion.
    const firstUserOp = entries[0]!.userOp;
    const userOpEffective = calcUserOpGasPrice(firstUserOp, baseFee);
    const markupScaled = BigInt(Math.round(this.config.walletGasMarkup * 100));
    const intendedGasPrice = (userOpEffective * 100n) / markupScaled;

    // Put the whole intended premium into the priority fee so a higher-tier op
    // (higher intendedGasPrice) genuinely gets faster inclusion — not just more
    // base-fee headroom. Floor at the chain's suggested tip (some chains enforce a
    // minimum priority fee). This also makes effectiveGasPrice the price actually
    // paid (baseFee + priorityFee), so the reported margin matches reality.
    const chainTip = gasPrices.suggestedMaxPriorityFeePerGas ?? 0n;
    let priorityFee = intendedGasPrice > baseFee ? intendedGasPrice - baseFee : 0n;
    if (priorityFee < chainTip) priorityFee = chainTip;
    const outerGas = {
      maxFeePerGas: intendedGasPrice > baseFee + priorityFee ? intendedGasPrice : baseFee + priorityFee,
      maxPriorityFeePerGas: priorityFee,
      effectiveGasPrice: baseFee + priorityFee,
    };

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
        const simResult = await this.simulator.simulateValidation(entry.userOp, rpcOverride);
        if (!simResult.valid) {
          console.warn(`[Bundler] UserOp ${entry.userOpHash} failed re-validation: ${simResult.errorMessage}`);
          return null;
        }
        const execResult = await this.simulator.simulateExecution(entry.userOp, rpcOverride);
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
    const bundleSim = await this.simulator.simulateBundle(packedOps, beneficiary, rpcOverride);

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
    const expectedCost = bundleSim.estimatedGas! * outerGas.effectiveGasPrice;
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

    // Reserve balance atomically
    this.accountService.reserveBalance(eoa.address, expectedCost);

    // Submit using the dedicated EOA as signer, via user's RPC if provided
    const account = privateKeyToAccount(eoa.privateKey!);
    const submitRpcUrl = rpcOverride ?? this.config.rpcUrl;
    const walletClient = createWalletClient({
      account,
      transport: http(submitRpcUrl),
    });

    const calldata = encodeHandleOps(packedOps, beneficiary);
    const userOpHashes = checkedEntries.map((e) => e.entry.userOpHash);

    try {
      const txHash = await walletClient.sendTransaction({
        to: this.config.entryPointAddress,
        data: calldata,
        maxFeePerGas: outerGas.maxFeePerGas,
        maxPriorityFeePerGas: outerGas.maxPriorityFeePerGas,
        chain: null,
        account,
      });

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
          entries: submittedEntries,
          eoaAddress: eoa.address,
          reservedAmount: expectedCost,
          rpcOverride,
          submittedAt: Date.now(),
          checkCount: 0,
        });
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
      // Post-bundle sweep: transfer 25% of relayer balance to treasury.
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

      // Give up after max checks
      if (pending.checkCount >= PENDING_RECEIPT_MAX_CHECKS) {
        console.error(`[Bundler] Giving up on receipt for ${pending.txHash} after ${pending.checkCount} checks`);
        this.storeFailedReceipts(pending.entries, pending.txHash, pending.eoaAddress);
        this.accountService.releaseBalance(pending.eoaAddress, pending.reservedAmount);
        continue;
      }

      remaining.push(pending);
    }

    this.pendingReceipts = remaining;
  }

  /** Store event logs from a confirmed receipt into the receipt store. */
  private storeReceiptLogs(receipt: { status: string; logs: readonly any[]; blockNumber: bigint; blockHash: `0x${string}`; transactionHash: `0x${string}`; transactionIndex: number; from: `0x${string}`; to: `0x${string}` | null; cumulativeGasUsed: bigint; gasUsed: bigint; effectiveGasPrice: bigint }, entries: MempoolEntry[]): void {
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
  private storeFailedReceipts(entries: MempoolEntry[], txHash: `0x${string}`, eoaAddress: `0x${string}`): void {
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
