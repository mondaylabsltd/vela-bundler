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
import { shouldSweep, executeSweep } from "./sweep.ts";
import type { BundlerConfig } from "../config/index.ts";
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
  calcUserOpMaxGas,
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

export class BundlerService {
  private receiptStore: Map<string, { receipt: UserOperationReceipt; expiresAt: number }> = new Map();
  private readonly publicClient: PublicClient<Transport, Chain>;
  private autoBundleTimer?: ReturnType<typeof setInterval>;
  private receiptCleanupTimer?: ReturnType<typeof setInterval>;
  private currentBundlingMode: "auto" | "manual";

  constructor(
    private readonly config: BundlerConfig,
    private readonly mempool: Mempool,
    private readonly simulator: Simulator,
    private readonly accountService: AccountService,
  ) {
    this.currentBundlingMode = config.bundlingMode;
    this.publicClient = createPublicClient({
      transport: http(config.rpcUrl),
    }) as PublicClient<Transport, Chain>;
    // Receipt cleanup runs regardless of bundling mode (every 10 min)
    this.receiptCleanupTimer = setInterval(() => this.cleanExpiredReceipts(), 600_000);
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

  private cleanExpiredReceipts(): void {
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

    // --- Sweep check: before bundling, inside lock ---
    const eoaState = this.accountService.lockManager.getState(eoa.address);
    const currentNonce = eoaState?.latestNonce ?? 0;
    if (
      eoa.privateKey &&
      shouldSweep(currentNonce, this.config.sweepInterval, this.config.treasuryAddress)
    ) {
      await executeSweep({
        eoaAddress: eoa.address,
        eoaPrivateKey: eoa.privateKey,
        treasuryAddress: this.config.treasuryAddress!,
        rpcUrl: effectiveRpc,
        config: this.config,
      });
      // Re-init EOA state after sweep (nonce changed)
      await this.accountService.lockManager.initEOA(
        eoa.address,
        getPublicClient(effectiveRpc),
      );
    }

    const gasPrices = await this.simulator.getGasPrices(rpcOverride);
    const baseFee = gasPrices.baseFee;

    // Derive outer tx gas price from the first UserOp's maxFeePerGas.
    // The wallet sets userOpMaxFee = intendedBundlerPrice × 1.3, so:
    //   intendedBundlerPrice = userOpMaxFee / 1.3
    // The bundler uses this as the actual on-chain gas price, guaranteeing
    // the 30% margin between what EntryPoint charges and what the bundler pays.
    const firstUserOp = entries[0]!.userOp;
    const userOpEffective = calcUserOpGasPrice(firstUserOp, baseFee);
    const intendedGasPrice = (userOpEffective * 10n) / 13n;

    // Use the user's intended price directly — if below baseFee, the tx
    // waits until baseFee drops (slow but cheaper, which is what the user chose).
    const outerGas = {
      maxFeePerGas: intendedGasPrice,
      maxPriorityFeePerGas: 0n,
      effectiveGasPrice: intendedGasPrice,
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

    // Profitability check
    const actualGasCosts = checkedEntries.map((checked) => {
      const opGasPrice = calcUserOpGasPrice(checked.entry.userOp, baseFee);
      return calcUserOpMaxGas(checked.entry.userOp) * opGasPrice;
    });

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

      // Process receipt in background — unlocks EOA on success
      this.processReceipt(txHash, submittedEntries, eoa.address, expectedCost, rpcOverride)
        .then(async () => {
          // Re-init EOA to restore ACTIVE state with updated nonce.
          // Retry up to 3 times with exponential backoff to avoid
          // permanently locking the EOA due to transient RPC failures.
          const client = rpcOverride ? getPublicClient(rpcOverride) : this.publicClient;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await this.accountService.lockManager.initEOA(eoa.address, client);
              return; // success — EOA is now ACTIVE
            } catch (err) {
              const delay = 2_000 * (2 ** attempt); // 2s, 4s, 8s
              console.warn(
                `[Bundler] initEOA recovery attempt ${attempt + 1}/3 failed for ${eoa.address}: ${err instanceof Error ? err.message : err}. Retrying in ${delay}ms...`,
              );
              await new Promise((r) => setTimeout(r, delay));
            }
          }
          // All retries failed — EOA stays locked, health loop will keep trying
          console.error(
            `[Bundler] Failed to recover EOA ${eoa.address} after 3 retries. ` +
            `EOA remains LOCKED_PENDING_UNKNOWN — health loop will continue recovery attempts.`,
          );
        })
        .catch((err) => {
          console.error("[Bundler] Failed to process receipt:", err);
          // Fail closed: keep locked if we can't confirm
          this.accountService.lockManager.lockEOA(
            eoa.address,
            "LOCKED_PENDING_UNKNOWN",
          );
        });

      return { submitted: true, transactionHash: txHash, userOpHashes };
    } catch (err) {
      // Release reservation on submission failure
      this.accountService.releaseBalance(eoa.address, expectedCost);
      console.error("[Bundler] Failed to submit bundle:", err);

      // Fail closed if state uncertain
      this.accountService.lockManager.lockEOA(
        eoa.address,
        "LOCKED_PENDING_UNKNOWN",
      );

      return {
        submitted: false,
        userOpHashes,
        error: err instanceof Error ? err.message : String(err),
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

      // Retry receipt polling up to 3 times with increasing timeout.
      // Avoids locking the EOA just because the RPC is slow.
      let receipt;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          receipt = await receiptClient.waitForTransactionReceipt({
            hash: txHash,
            timeout: 120_000, // 2 min per attempt
          });
          break;
        } catch (err) {
          if (attempt < 2) {
            console.warn(
              `[Bundler] Receipt poll attempt ${attempt + 1} failed for ${txHash}, retrying...`,
            );
            await new Promise((r) => setTimeout(r, 5_000));
          } else {
            throw err;
          }
        }
      }
      if (!receipt) throw new Error(`Receipt not found for ${txHash} after retries`);

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
    } finally {
      // Always release reservation after confirmation/failure
      this.accountService.releaseBalance(eoaAddress, reservedAmount);
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
