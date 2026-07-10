// deno-lint-ignore-file no-explicit-any -- partial `as any` mocks of AccountService/Simulator/etc.
/**
 * Tests for BundlerService (shared/bundler/index.ts).
 *
 * Tests receipt store, mode switching, receipt expiry, and the getUserOpByHash/getReceipt
 * public API without requiring real RPC connections.
 */

import { assertEquals, assertExists } from "@std/assert";
import { BundlerService } from "../shared/bundler/index.ts";
import { Mempool } from "../shared/mempool/index.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { Simulator } from "../shared/simulation/index.ts";
import type { AccountService } from "../shared/account/index.ts";

// --- Mock helpers ---

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;

function mockConfig(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: "https://rpc.example.com",
    publicRpcs: [],
    chainInfo: null,
    entryPointAddress: ENTRY_POINT,
    port: 3300,
    host: "0.0.0.0",
    bundlingMode: "manual",
    maxBundleSize: 10,
    maxBundleGas: 5000000n,
    minPriorityFeePerGas: 0n,
    minProfitMarginBps: 1000,
    maxProfitMarginBps: 15000,
    walletGasMarkup: 1.5,
    useEip1559: true,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 0.5,
    autoBundleIntervalMs: 10000,
    operatorSecret: "0x" + "ab".repeat(32),
    oldOperatorSecrets: [],
    treasuryAddress: "0x" + "cc".repeat(20) as `0x${string}`,
    splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    apiRateLimitPerMinute: 60,
    rateLimitAllowlist: [],
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
    ...overrides,
  } as BundlerConfig;
}

function mockSimulator(): Simulator {
  return {
    simulateValidation: async () => ({ valid: true }),
    simulateExecution: async () => ({ success: true }),
    simulateBundle: async () => ({ success: true, estimatedGas: 100000n }),
    estimateUserOpGas: async () => ({
      preVerificationGas: 50000n,
      verificationGasLimit: 100000n,
      callGasLimit: 100000n,
      paymasterVerificationGasLimit: null,
    }),
    getCurrentBaseFee: async () => 1000000000n,
    getGasPrices: async () => ({
      baseFee: 1000000000n,
      suggestedMaxPriorityFeePerGas: 100000000n,
      chainGasPrice: 1100000000n,
    }),
  } as unknown as Simulator;
}

function mockAccountService(): AccountService {
  return {
    deriveEOA: async () => ({
      address: "0x" + "aa".repeat(20) as `0x${string}`,
      privateKey: "0x" + "bb".repeat(32) as `0x${string}`,
    }),
    lockManager: {
      isAvailable: () => true,
      acquireBundleLock: () => true,
      releaseBundleLock: () => {},
      lockEOA: () => {},
      initEOA: async () => ({ status: "ACTIVE", latestNonce: 0, pendingNonce: 0 }),
      getState: () => null,
      getReservedBalance: () => 0n,
      addReservation: () => {},
      releaseReservation: () => {},
    },
    reserveBalance: () => {},
    releaseBalance: () => {},
    checkBalance: async () => ({ sufficient: true, spendableBalance: 10n ** 18n, requiredBalance: 10n ** 15n }),
    getClient: () => ({} as any),
  } as unknown as AccountService;
}

// --- Tests ---

Deno.test("BundlerService - constructor sets manual mode", () => {
  const config = mockConfig({ bundlingMode: "manual" });
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });
  assertExists(service);
});

Deno.test("BundlerService - tryBundle returns empty mempool error", async () => {
  const config = mockConfig();
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });

  const result = await service.tryBundle();
  assertEquals(result.submitted, false);
  assertEquals(result.error, "Empty mempool");
  assertEquals(result.userOpHashes.length, 0);
});

Deno.test("BundlerService - getReceipt returns undefined for unknown hash", () => {
  const config = mockConfig();
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });

  const receipt = service.getReceipt("0x" + "ab".repeat(32));
  assertEquals(receipt, undefined);
});

Deno.test("BundlerService - getUserOpByHash returns undefined for unknown hash", () => {
  const config = mockConfig();
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });

  const result = service.getUserOpByHash("0x" + "ab".repeat(32));
  assertEquals(result, undefined);
});

Deno.test("BundlerService - cleanExpiredReceipts is callable", () => {
  const config = mockConfig();
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });

  // Should not throw even with empty receipt store
  service.cleanExpiredReceipts();
});

Deno.test("BundlerService - setBundlingMode to auto then manual", () => {
  const config = mockConfig({ bundlingMode: "manual" });
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });

  // Switch to auto — with disableTimers this won't start real timers
  service.setBundlingMode("auto");
  // Switch back to manual
  service.setBundlingMode("manual");
  // Should not throw
});

Deno.test("BundlerService - stopAutoBundling is idempotent", () => {
  const config = mockConfig({ bundlingMode: "manual" });
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });

  // Calling stop when not started should be safe
  service.stopAutoBundling();
  service.stopAutoBundling();
});

Deno.test("BundlerService - dispose() releases timers and is idempotent (chain-eviction safety)", () => {
  // A chain evicted from the registry calls bundler.dispose() to release BOTH the auto-bundle
  // and the receipt-cleanup interval, so a flood of distinct chainIds can't leak timers.
  const config = mockConfig({ bundlingMode: "auto" });
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  // disableTimers:false so the receipt-cleanup interval is actually created (then disposed).
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: false });
  service.startAutoBundling();
  // Must not throw and must be safe to call twice (leaves no live intervals to leak the test runner).
  service.dispose();
  service.dispose();
});

Deno.test("BundlerService - checkPendingReceipts does nothing when empty", async () => {
  const config = mockConfig();
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const service = new BundlerService(config, mempool, mockSimulator(), mockAccountService(), { disableTimers: true });

  // Should complete without error
  await service.checkPendingReceipts();
});
