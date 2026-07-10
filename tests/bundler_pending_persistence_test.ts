/**
 * Tests for crash/eviction durability of in-flight receipt reconciliation
 * (shared/bundler/index.ts): export/import round-trip, idempotent replay (dedup), and
 * re-locking + re-reserving the EOA on restore so a recovered DO can't double-spend.
 */

import { assertEquals, assert } from "@std/assert";
import { BundlerService } from "../shared/bundler/index.ts";
import { Mempool } from "../shared/mempool/index.ts";
import { EOALockManager } from "../shared/account/eoa-lock.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { Simulator } from "../shared/simulation/index.ts";
import type { AccountService } from "../shared/account/index.ts";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;
const EOA = "0x" + "aa".repeat(20) as `0x${string}`;

function mockConfig(): BundlerConfig {
  return {
    chainId: 1, rpcUrl: "https://rpc.example.com", publicRpcs: [], chainInfo: null,
    entryPointAddress: ENTRY_POINT, port: 0, host: "", bundlingMode: "manual",
    maxBundleSize: 10, maxBundleGas: 5_000_000n, minPriorityFeePerGas: 0n,
    minProfitMarginBps: 1000, maxProfitMarginBps: 15000, walletGasMarkup: 1.5,
    useEip1559: true, baseFeeMultiplier: 1.25, bundlerTipGwei: 0.5, autoBundleIntervalMs: 10000,
    operatorSecret: "0x" + "ab".repeat(32), oldOperatorSecrets: [],
    treasuryAddress: "0x" + "cc".repeat(20) as `0x${string}`, splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    apiRateLimitPerMinute: 60, balanceReserveMultiplier: 1, alchemyApiKey: null,
    rateLimitAllowlist: [],
    telegramBotToken: null, telegramChatId: null, treasuryAlertThresholdWei: 0n, treasuryAlertThresholdPathUsd: 0n,
  } as BundlerConfig;
}

function mockSimulator(): Simulator {
  return {} as unknown as Simulator;
}

// Back the mock AccountService with a REAL EOALockManager so the tests assert the actual
// effect of importPendingState (state created, reservation applied, EOA locked) rather than
// merely that some method was called. This is the exact scenario the fix targets: a fresh,
// empty lock manager (as a cold-started DO builds) restoring in-flight state.
function mockAccountService(lockManager: EOALockManager): AccountService {
  return {
    reserveBalance: (addr: `0x${string}`, amt: bigint) => lockManager.addReservation(addr, amt),
    releaseBalance: (addr: `0x${string}`, amt: bigint) => lockManager.releaseReservation(addr, amt),
    lockManager,
  } as unknown as AccountService;
}

function newService(lockManager: EOALockManager) {
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  return new BundlerService(mockConfig(), mempool, mockSimulator(), mockAccountService(lockManager), { disableTimers: true });
}

const sampleSerialized = (txHash: string) => ([{
  txHash: txHash as `0x${string}`,
  entries: [{ userOpHash: ("0x" + "11".repeat(32)) as `0x${string}`, sender: ("0x" + "22".repeat(20)) as `0x${string}`, nonce: "5" }],
  eoaAddress: EOA,
  reservedAmount: "1000000000000000",
  rpcOverride: undefined as string | undefined,
  submittedAt: 1000,
  checkCount: 2,
}]);

const serialized = (txHash: string, checkCount = 0) => ({
  txHash: txHash as `0x${string}`,
  entries: [{ userOpHash: (txHash.slice(0, 66)) as `0x${string}`, sender: ("0x" + "22".repeat(20)) as `0x${string}`, nonce: "5" }],
  eoaAddress: EOA, reservedAmount: "0", rpcOverride: undefined as string | undefined, submittedAt: 1000, checkCount,
});

Deno.test("checkPendingReceipts - reentrancy-guarded AND preserves a concurrent push (no lost receipt)", async () => {
  // Regression for the adversarial-review finding: two overlapping health-loop invocations plus a
  // concurrent auto-bundle push must NOT drop the pushed pending receipt.
  const svc = newService(new EOALockManager());
  let receiptCalls = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  // Inject a controllable receipt client: getTransactionReceipt blocks until we release it.
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: async () => { receiptCalls++; await held; return null; },
    getTransactionCount: () => Promise.resolve(0),
  };

  svc.importPendingState([serialized("0x" + "a1".repeat(32))]); // E1
  const runA = svc.checkPendingReceipts();      // starts, blocks inside getTransactionReceipt
  await Promise.resolve();                        // let run A reach the await
  await svc.checkPendingReceipts();               // run B: reentrancy guard → returns immediately
  svc.importPendingState([serialized("0x" + "b2".repeat(32))]); // E2 pushed DURING run A's await
  release();                                      // let run A finish (E1 still pending: null receipt)
  await runA;

  assertEquals(receiptCalls, 1, "run B must have been skipped by the reentrancy guard");
  // Both E1 (still pending) and the concurrently-pushed E2 must survive.
  assertEquals(svc.pendingReceiptCount, 2);
  const hashes = svc.exportPendingState().map((p) => p.txHash).sort();
  assertEquals(hashes, ["0x" + "a1".repeat(32), "0x" + "b2".repeat(32)].sort());
});

Deno.test("pending persistence - export/import round-trips losslessly", () => {
  const svc = newService(new EOALockManager());
  const tx = "0x" + "ab".repeat(32);
  svc.importPendingState(sampleSerialized(tx));
  assertEquals(svc.pendingReceiptCount, 1);
  const exported = svc.exportPendingState();
  assertEquals(exported.length, 1);
  assertEquals(exported[0]!.txHash, tx);
  assertEquals(exported[0]!.reservedAmount, "1000000000000000");
  assertEquals(exported[0]!.entries[0]!.nonce, "5");
  assertEquals(exported[0]!.checkCount, 2);
});

Deno.test("pending persistence - import re-reserves balance and re-locks the EOA (no double-spend after recovery)", () => {
  // Regression test for the DO-cold-start no-op bug: a freshly-constructed EOALockManager
  // has NO state for EOA, so the old reserveBalance()/lockEOA() calls silently did nothing.
  // restorePending must CREATE the state with the reservation and the LOCKED status.
  const lockManager = new EOALockManager();
  const svc = newService(lockManager);
  svc.importPendingState(sampleSerialized("0x" + "cd".repeat(32)));
  assertEquals(lockManager.getReservedBalance(EOA), 1_000_000_000_000_000n);
  assertEquals(lockManager.getState(EOA)?.status, "LOCKED_PENDING_UNKNOWN");
  // The restored lock must be visible to the health loop so it can be recovered.
  assertEquals(lockManager.getLockedEOAs().length, 1);
});

Deno.test("pending persistence - replay is idempotent (dedups by txHash)", () => {
  const lockManager = new EOALockManager();
  const svc = newService(lockManager);
  const saved = sampleSerialized("0x" + "ef".repeat(32));
  svc.importPendingState(saved);
  svc.importPendingState(saved); // replay same DLQ payload — must NOT duplicate
  assertEquals(svc.pendingReceiptCount, 1);
  // No double reservation on replay (restorePending takes the max, not a sum).
  assertEquals(lockManager.getReservedBalance(EOA), 1_000_000_000_000_000n);
});

Deno.test("pending persistence - import tolerates empty / null without throwing", () => {
  const svc = newService(new EOALockManager());
  svc.importPendingState(undefined);
  svc.importPendingState(null);
  svc.importPendingState([]);
  assertEquals(svc.pendingReceiptCount, 0);
});

Deno.test("pending persistence - oldestPendingReceiptAgeMs reflects submittedAt", () => {
  const svc = newService(new EOALockManager());
  svc.importPendingState(sampleSerialized("0x" + "12".repeat(32))); // submittedAt=1000
  const age = svc.oldestPendingReceiptAgeMs(5000);
  assertEquals(age, 4000);
  assert(svc.oldestPendingReceiptAgeMs(1000) === 0);
});
