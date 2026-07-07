/**
 * Tests for crash/eviction durability of in-flight receipt reconciliation
 * (shared/bundler/index.ts): export/import round-trip, idempotent replay (dedup), and
 * re-locking + re-reserving the EOA on restore so a recovered DO can't double-spend.
 */

import { assertEquals, assert } from "@std/assert";
import { BundlerService } from "../shared/bundler/index.ts";
import { Mempool } from "../shared/mempool/index.ts";
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
  } as BundlerConfig;
}

function mockSimulator(): Simulator {
  return {} as unknown as Simulator;
}

interface Spy { reserved: Array<[string, bigint]>; locked: Array<[string, string]>; }

function mockAccountService(spy: Spy): AccountService {
  return {
    reserveBalance: (addr: string, amt: bigint) => spy.reserved.push([addr, amt]),
    releaseBalance: () => {},
    lockManager: {
      lockEOA: (addr: string, reason: string) => spy.locked.push([addr, reason]),
      getLockedEOAs: () => [],
    },
  } as unknown as AccountService;
}

function newService(spy: Spy) {
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  return new BundlerService(mockConfig(), mempool, mockSimulator(), mockAccountService(spy), { disableTimers: true });
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

Deno.test("pending persistence - export/import round-trips losslessly", () => {
  const spy: Spy = { reserved: [], locked: [] };
  const svc = newService(spy);
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
  const spy: Spy = { reserved: [], locked: [] };
  const svc = newService(spy);
  svc.importPendingState(sampleSerialized("0x" + "cd".repeat(32)));
  assertEquals(spy.reserved.length, 1);
  assertEquals(spy.reserved[0]![0], EOA);
  assertEquals(spy.reserved[0]![1], 1_000_000_000_000_000n);
  assertEquals(spy.locked.length, 1);
  assertEquals(spy.locked[0]![1], "LOCKED_PENDING_UNKNOWN");
});

Deno.test("pending persistence - replay is idempotent (dedups by txHash)", () => {
  const spy: Spy = { reserved: [], locked: [] };
  const svc = newService(spy);
  const saved = sampleSerialized("0x" + "ef".repeat(32));
  svc.importPendingState(saved);
  svc.importPendingState(saved); // replay same DLQ payload — must NOT duplicate
  assertEquals(svc.pendingReceiptCount, 1);
  assertEquals(spy.reserved.length, 1); // no double reservation on replay
});

Deno.test("pending persistence - import tolerates empty / null without throwing", () => {
  const spy: Spy = { reserved: [], locked: [] };
  const svc = newService(spy);
  svc.importPendingState(undefined);
  svc.importPendingState(null);
  svc.importPendingState([]);
  assertEquals(svc.pendingReceiptCount, 0);
});

Deno.test("pending persistence - oldestPendingReceiptAgeMs reflects submittedAt", () => {
  const spy: Spy = { reserved: [], locked: [] };
  const svc = newService(spy);
  svc.importPendingState(sampleSerialized("0x" + "12".repeat(32))); // submittedAt=1000
  const age = svc.oldestPendingReceiptAgeMs(5000);
  assertEquals(age, 4000);
  assert(svc.oldestPendingReceiptAgeMs(1000) === 0);
});
