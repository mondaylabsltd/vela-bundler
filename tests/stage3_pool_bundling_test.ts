// deno-lint-ignore-file no-explicit-any -- partial `as any` mocks of AccountService/Simulator/etc.
/**
 * Stage 3 pool-bundling tests (POOL_EOA_ENABLED, docs/pool-queue-architecture.md):
 *  - flag off → the per-safe path runs byte-identical (leaseFreePoolEOA never called);
 *    flag on WITHOUT the in-band+vault prerequisites → same (warn-once fallback)
 *  - pool mode: ops from DIFFERENT senders land in ONE handleOps, signed by pool EOA #0,
 *    beneficiary = treasury, receipt keyed to the pool index
 *  - iterative drop-resim-reassemble: a definitively-failing op is dropped (terminal
 *    receipt + reputation penalty) and the survivor submits on the next round
 *  - pool exhaustion: all leases busy → defer (ops stay in the mempool, no receipts)
 *  - receipt re-keying: a pending receipt with poolIndex fee-bumps with the POOL key,
 *    a legacy receipt (no poolIndex) keeps the per-safe derivation
 */

import { it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  concat,
  encodePacked,
  encodeFunctionData,
  parseAbi,
  parseTransaction,
  decodeFunctionData,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import { BundlerService } from "../shared/bundler/index.ts";
import { Mempool } from "../shared/mempool/index.ts";
import { ENTRYPOINT_V07_ABI } from "../shared/contracts/entrypoint.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { Simulator } from "../shared/simulation/index.ts";
import type { AccountService } from "../shared/account/index.ts";
import type { UserOperation } from "../shared/userop/types.ts";

// --- Fixtures ---

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;
const TREASURY = ("0x" + "cc".repeat(20)) as `0x${string}`;
const SAFE_A = ("0x" + "aa".repeat(20)) as `0x${string}`;
const SAFE_B = ("0x" + "bb".repeat(20)) as `0x${string}`;
const ZERO_HASH = ("0x" + "00".repeat(32)) as `0x${string}`;

// Real keys so signing/recovery works end-to-end.
const POOL0_KEY = ("0x" + "00".repeat(31) + "02") as `0x${string}`;
const POOL0 = privateKeyToAccount(POOL0_KEY).address.toLowerCase() as `0x${string}`;
const PER_SAFE_KEY = ("0x" + "00".repeat(31) + "01") as `0x${string}`;
const PER_SAFE_EOA = privateKeyToAccount(PER_SAFE_KEY).address.toLowerCase() as `0x${string}`;

function poolConfig(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
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
    treasuryAddress: TREASURY,
    splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    // Stage 3 prerequisites: in-band settlement + vault (treasury recipient) + the pool flag.
    inBandChains: "all",
    settlementVaultChains: "all",
    poolEoaChains: "1",
    apiRateLimitPerMinute: 60,
    rateLimitAllowlist: [],
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
    ...overrides,
  } as BundlerConfig;
}

/** Simulator whose bundle-level simulateExecutionSuccess replays a scripted queue (then
 *  succeeds) — the knob the drop-resim-reassemble test turns. */
function poolSimulator(execSuccessQueue: Array<{ success: boolean; failedOpIndex?: number; errorMessage?: string; gasUsed?: bigint }> = []): Simulator {
  const queue = [...execSuccessQueue];
  return {
    simulateValidation: async () => ({ valid: true }),
    simulateExecution: async () => ({ success: true }),
    simulateBundle: async () => ({ success: true, estimatedGas: 200_000n }),
    simulateExecutionSuccess: async () =>
      queue.length > 0 ? queue.shift()! : { success: true, gasUsed: 150_000n },
    getCurrentBaseFee: async () => 1_000_000_000n,
    getGasPrices: async () => ({
      baseFee: 1_000_000_000n,
      suggestedMaxPriorityFeePerGas: 100_000_000n,
      chainGasPrice: 1_100_000_000n,
    }),
  } as unknown as Simulator;
}

/** AccountService mock with a recording pool lease (index 0) and per-safe derivation. */
function poolAccountService(opts: { exhausted?: boolean } = {}) {
  const calls = {
    lease: 0,
    released: 0,
    lockEOA: [] as Array<{ address: string; reason: string; nonce?: number }>,
    getPoolEOA: [] as number[],
    deriveEOA: [] as string[],
  };
  const svc = {
    calls,
    deriveEOA: async (safe: `0x${string}`) => {
      calls.deriveEOA.push(safe.toLowerCase());
      return { address: PER_SAFE_EOA, privateKey: PER_SAFE_KEY };
    },
    getPoolEOA: async (i: number) => {
      calls.getPoolEOA.push(i);
      return { address: POOL0, privateKey: POOL0_KEY };
    },
    leaseFreePoolEOA: async () => {
      calls.lease++;
      if (opts.exhausted) return null;
      return {
        index: 0,
        eoa: { address: POOL0, privateKey: POOL0_KEY },
        release: () => { calls.released++; },
      };
    },
    lockManager: {
      isAvailable: () => true,
      acquireBundleLock: () => true,
      releaseBundleLock: () => {},
      lockEOA: (address: string, reason: string, nonce?: number) =>
        calls.lockEOA.push({ address, reason, nonce }),
      initEOA: async () => ({ status: "ACTIVE", latestNonce: 7, pendingNonce: 7 }),
      getState: () => null,
      getReservedBalance: () => 0n,
      addReservation: () => {},
      releaseReservation: () => {},
      restorePending: () => {},
    },
    reserveBalance: () => {},
    releaseBalance: () => {},
    checkBalance: async () => ({ sufficient: true, spendableBalance: 10n ** 18n, requiredBalance: 0n }),
    getClient: () => ({} as any),
  };
  return svc as unknown as AccountService & { calls: typeof calls };
}

// In-band reimbursement callData: executeUserOp → DELEGATECALL the canonical MultiSend with
// a native-value leg to the treasury (same builders as stage2_vault_test.ts).
const erc20 = parseAbi(["function transfer(address to, uint256 amount)"]);
const multiSend = parseAbi(["function multiSend(bytes transactions)"]);
const execUserOp = parseAbi([
  "function executeUserOp(address to, uint256 value, bytes data, uint8 operation)",
]);
const MULTI_SEND = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526" as const;
void erc20; // (kept for parity with the stage2 helpers; native legs suffice here)

function packTx(to: Hex, value: bigint, data: Hex): Hex {
  const len = BigInt((data.length - 2) / 2);
  return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, value, len, data]);
}
function buildBatch(calls: { to: Hex; value?: bigint; data: Hex }[]): Hex {
  const packed = concat(calls.map((c) => packTx(c.to, c.value ?? 0n, c.data)));
  const msData = encodeFunctionData({ abi: multiSend, functionName: "multiSend", args: [packed] });
  return encodeFunctionData({ abi: execUserOp, functionName: "executeUserOp", args: [MULTI_SEND, 0n, msData, 1] });
}

/** An in-band op (maxFee=0) repaying 1 native to the treasury — clears every gate. */
function makeInBandOp(sender: `0x${string}`, nonce: bigint): UserOperation {
  return {
    sender,
    nonce,
    factory: null,
    factoryData: null,
    callData: buildBatch([{ to: TREASURY, value: 10n ** 18n, data: "0x" }]),
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 0n, // in-band opt-in: zero EntryPoint fee
    maxPriorityFeePerGas: 0n,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0x" as `0x${string}`,
    feeToken: null,
  } as UserOperation;
}

/** An in-band op repaying `value` native to the treasury (0 = a non-payer that must be
 *  dropped by per-op attribution in a pool bundle). */
function makeInBandOpPaying(sender: `0x${string}`, nonce: bigint, value: bigint): UserOperation {
  const op = makeInBandOp(sender, nonce);
  op.callData = value > 0n
    ? buildBatch([{ to: TREASURY, value, data: "0x" }])
    : buildBatch([{ to: TREASURY, value: 0n, data: "0x" }]); // structurally valid, zero reimbursement
  return op;
}

function newMempool(): Mempool {
  return new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
}

/** Nonce/balance/receipt reads for the trusted publicClient, scripted per test. */
function stubPublicClient(svc: BundlerService, opts: { nonce?: number; balance?: bigint } = {}): void {
  (svc as any).publicClient = {
    getTransactionCount: async () => opts.nonce ?? 7,
    getBalance: async () => opts.balance ?? 10n ** 18n,
    getTransactionReceipt: async () => { throw new Error("not found"); },
  };
}

/** fetch stub for the broadcast wallet client (prepare → sign → sendRawTransaction). */
function stubBroadcastFetch(sentRaw: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const one = (b: { id: number; method: string; params?: unknown[] }) => {
      switch (b.method) {
        case "eth_chainId": return { jsonrpc: "2.0", id: b.id, result: "0x1" };
        case "eth_estimateGas": return { jsonrpc: "2.0", id: b.id, result: "0x30d40" };
        case "eth_sendRawTransaction":
          sentRaw.push(String((b.params as string[])[0]));
          return { jsonrpc: "2.0", id: b.id, result: "0x" + "ee".repeat(32) };
        default: return { jsonrpc: "2.0", id: b.id, result: null };
      }
    };
    const payload = Array.isArray(body) ? body.map(one) : one(body);
    return Promise.resolve(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------
// Flag off / prerequisites off → per-safe path, pool machinery untouched
// ---------------------------------------------------------------------------

it("pool bundling - flag off: the per-safe path runs and leaseFreePoolEOA is never called", async () => {
  const acct = poolAccountService();
  // Per-safe path probe: the bundle lock is busy, so trySenderBundle bails after its
  // per-safe deriveEOA — proof the per-safe pipeline (not the pool one) ran.
  (acct.lockManager as any).acquireBundleLock = () => false;
  const mempool = newMempool();
  mempool.add(makeInBandOp(SAFE_A, 1n));
  const svc = new BundlerService(poolConfig({ poolEoaChains: "" }), mempool, poolSimulator(), acct, { disableTimers: true });

  const result = await svc.tryBundle();

  expect(result.submitted).toEqual(false);
  expect(result.error, "the per-safe loop's default result").toEqual("No bundles processed");
  expect(acct.calls.deriveEOA, "per-safe derivation ran for the sender").toEqual([SAFE_A]);
  expect(acct.calls.lease, "pool lease must never be touched with the flag off").toEqual(0);
});

it("pool bundling - flag on but vault off: falls back to the per-safe path (warn-once)", async () => {
  const acct = poolAccountService();
  (acct.lockManager as any).acquireBundleLock = () => false;
  const mempool = newMempool();
  mempool.add(makeInBandOp(SAFE_A, 1n));
  // Pool flag covers chain 1, but the vault prerequisite is off → per-safe path.
  const svc = new BundlerService(poolConfig({ settlementVaultChains: "" }), mempool, poolSimulator(), acct, { disableTimers: true });

  const result = await svc.tryBundle();
  expect(result.error).toEqual("No bundles processed");
  expect(acct.calls.deriveEOA).toEqual([SAFE_A]);
  expect(acct.calls.lease).toEqual(0);

  // Second pass takes the same fallback without re-warning (the latch, not re-derived state).
  await svc.tryBundle();
  expect(acct.calls.lease).toEqual(0);
});

// ---------------------------------------------------------------------------
// Multi-sender pool bundle: one handleOps, pool EOA signer, pool-keyed receipt
// ---------------------------------------------------------------------------

it("pool bundling - two senders land in ONE handleOps signed by pool EOA #0", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const hashA = mempool.add(makeInBandOp(SAFE_A, 1n));
  const hashB = mempool.add(makeInBandOp(SAFE_B, 1n));
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  stubPublicClient(svc);

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  let result;
  try {
    result = await svc.tryBundle();
  } finally {
    restore();
  }

  expect(result.submitted).toEqual(true);
  expect(sentRaw.length, "exactly one outer tx for both senders").toEqual(1);

  // The single handleOps carries BOTH senders' ops, beneficiary = treasury (vault).
  const tx = parseTransaction(sentRaw[0]! as `0x${string}`);
  expect(tx.to!.toLowerCase()).toEqual(ENTRY_POINT.toLowerCase());
  const decoded = decodeFunctionData({ abi: ENTRYPOINT_V07_ABI, data: tx.data! });
  expect(decoded.functionName).toEqual("handleOps");
  const ops = decoded.args[0] as Array<{ sender: string }>;
  expect(ops.length).toEqual(2);
  expect(ops.map((o) => o.sender.toLowerCase()).sort()).toEqual([SAFE_A, SAFE_B].sort());
  expect((decoded.args[1] as string).toLowerCase()).toEqual(TREASURY.toLowerCase());

  // The outer signer is pool EOA #0.
  const signer = await recoverTransactionAddress({ serializedTransaction: sentRaw[0]! as `0x${string}` });
  expect(signer.toLowerCase()).toEqual(POOL0);

  // Broadcast bookkeeping: EOA locked on the pinned nonce, lease released (bundle lock
  // only — the LOCKED_PENDING_UNKNOWN transition is lockEOA's), receipt keyed to the pool.
  expect(acct.calls.lockEOA).toEqual([{ address: POOL0, reason: "LOCKED_PENDING_UNKNOWN", nonce: 7 }]);
  expect(acct.calls.released).toEqual(1);
  expect(mempool.size).toEqual(0);
  const pending = svc.exportPendingState();
  expect(pending.length).toEqual(1);
  expect(pending[0]!.eoaAddress).toEqual(POOL0);
  expect(pending[0]!.poolIndex).toEqual(0);
  expect(pending[0]!.entries.map((e) => e.userOpHash).sort()).toEqual([hashA, hashB].sort());
});

// ---------------------------------------------------------------------------
// Iterative drop-resim-reassemble (the 4337 gotcha)
// ---------------------------------------------------------------------------

it("pool bundling - a failing op is dropped (receipt + penalty) and the survivor submits on round 2", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const hashA = mempool.add(makeInBandOp(SAFE_A, 1n));
  const hashB = mempool.add(makeInBandOp(SAFE_B, 1n));
  const penalized: string[] = [];
  const origPenalize = mempool.reputation.penalize.bind(mempool.reputation);
  (mempool.reputation as any).penalize = (addr: `0x${string}`, kind: any) => {
    penalized.push(addr.toLowerCase());
    return origPenalize(addr, kind);
  };

  // Round 1: op B (index 1) definitively fails the full-bundle execution sim; then clean.
  const svc = new BundlerService(
    poolConfig(),
    mempool,
    poolSimulator([{ success: false, failedOpIndex: 1, errorMessage: "op B execution would revert" }]),
    acct,
    { disableTimers: true },
  );
  stubPublicClient(svc);

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  let result;
  try {
    result = await svc.tryBundle();
  } finally {
    restore();
  }

  // Survivor (op A) submitted on round 2 — one broadcast carrying ONLY op A.
  expect(result.submitted).toEqual(true);
  expect(result.userOpHashes).toEqual([hashA]);
  expect(sentRaw.length).toEqual(1);
  const decoded = decodeFunctionData({ abi: ENTRYPOINT_V07_ABI, data: parseTransaction(sentRaw[0]! as `0x${string}`).data! });
  const ops = decoded.args[0] as Array<{ sender: string }>;
  expect(ops.length).toEqual(1);
  expect(ops[0]!.sender.toLowerCase()).toEqual(SAFE_A);

  // Op B: terminal failed receipt (never broadcast → zero txHash) + reputation penalty.
  const receiptB = svc.getReceipt(hashB);
  expect(receiptB?.success).toEqual(false);
  expect(receiptB?.receipt.transactionHash).toEqual(ZERO_HASH);
  expect(penalized).toEqual([SAFE_B]);
  expect(mempool.size).toEqual(0);
  expect(svc.exportPendingState()[0]!.entries.map((e) => e.userOpHash)).toEqual([hashA]);
});

// ---------------------------------------------------------------------------
// Pool exhaustion → defer, never drop
// ---------------------------------------------------------------------------

it("pool bundling - all leases busy: submitted=false, ops stay in the mempool, no receipts", async () => {
  const acct = poolAccountService({ exhausted: true });
  const mempool = newMempool();
  const hashA = mempool.add(makeInBandOp(SAFE_A, 1n));
  const hashB = mempool.add(makeInBandOp(SAFE_B, 1n));
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  stubPublicClient(svc);

  const result = await svc.tryBundle();

  expect(result.submitted).toEqual(false);
  expect(result.error).toEqual("pool EOAs exhausted — deferred");
  expect(acct.calls.lease).toEqual(1);
  expect(mempool.size, "deferred ops stay queued").toEqual(2);
  expect(svc.pendingReceiptCount).toEqual(0);
  expect(svc.getReceipt(hashA)).toEqual(undefined);
  expect(svc.getReceipt(hashB)).toEqual(undefined);
});

// ---------------------------------------------------------------------------
// Receipt re-keying: poolIndex → pool key; legacy → per-safe key
// ---------------------------------------------------------------------------

type SerializedPending = ReturnType<BundlerService["exportPendingState"]>[number];

function stuckPending(eoaAddress: `0x${string}`, extra: Partial<SerializedPending> = {}): SerializedPending[] {
  return [{
    txHash: ("0x" + "e5".repeat(32)) as `0x${string}`,
    entries: [{ userOpHash: ("0x" + "11".repeat(32)) as `0x${string}`, sender: SAFE_A, nonce: "1" }],
    eoaAddress,
    reservedAmount: "0",
    rpcOverride: undefined,
    submittedAt: Date.now() - 60_000, // past FEE_BUMP_AFTER_MS → bump-eligible
    checkCount: 0,
    txNonce: 7,
    txTo: ENTRY_POINT,
    txData: "0x1234" as `0x${string}`,
    txGas: "100000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000000",
    revenueCapPerGas: "10000000000",
    bumpCount: 0,
    ...extra,
  } as SerializedPending];
}

it("receipt re-keying - a poolIndex receipt fee-bumps with the POOL key (pool from-address)", async () => {
  const acct = poolAccountService();
  const svc = new BundlerService(poolConfig(), newMempool(), poolSimulator(), acct, { disableTimers: true });
  // Receipt still in flight (nonce not consumed), pool EOA well funded for the new prefund.
  stubPublicClient(svc, { nonce: 7 });
  svc.importPendingState(stuckPending(POOL0, { poolIndex: 0 }));
  expect(svc.exportPendingState()[0]!.poolIndex, "poolIndex survives the persistence round-trip").toEqual(0);

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  try {
    await svc.checkPendingReceipts();
  } finally {
    restore();
  }

  expect(sentRaw.length, "replacement broadcast").toEqual(1);
  const signer = await recoverTransactionAddress({ serializedTransaction: sentRaw[0]! as `0x${string}` });
  expect(signer.toLowerCase(), "re-derived from the pool index, not the sender's safe").toEqual(POOL0);
  expect(acct.calls.getPoolEOA).toEqual([0]);
  expect(acct.calls.deriveEOA, "per-safe derivation must not run for a pool receipt").toEqual([]);
  expect(svc.exportPendingState()[0]!.bumpCount).toEqual(1);
});

it("receipt re-keying - a legacy receipt (no poolIndex) still uses the per-safe key", async () => {
  const acct = poolAccountService();
  const svc = new BundlerService(poolConfig(), newMempool(), poolSimulator(), acct, { disableTimers: true });
  stubPublicClient(svc, { nonce: 7 });
  // Old-shape persisted state: no poolIndex field at all (pre-Stage-3 receipt).
  svc.importPendingState(stuckPending(PER_SAFE_EOA));

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  try {
    await svc.checkPendingReceipts();
  } finally {
    restore();
  }

  expect(sentRaw.length).toEqual(1);
  const signer = await recoverTransactionAddress({ serializedTransaction: sentRaw[0]! as `0x${string}` });
  expect(signer.toLowerCase(), "legacy re-keying: derived from the bound safe").toEqual(PER_SAFE_EOA);
  expect(acct.calls.deriveEOA).toEqual([SAFE_A]);
  expect(acct.calls.getPoolEOA).toEqual([]);
  expect(svc.exportPendingState()[0]!.bumpCount).toEqual(1);
});

// ---------------------------------------------------------------------------
// Stage-3 review fixes: per-op attribution, in-flight sender exclusion
// ---------------------------------------------------------------------------

const SAFE_C = ("0x" + "dd".repeat(20)) as `0x${string}`;

it("pool per-op attribution - a non-paying op is DROPPED (receipt + penalty), payers survive", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  // A pays a large share, B pays nothing. B must be dropped, not drag the whole bundle.
  const hashA = mempool.add(makeInBandOpPaying(SAFE_A, 1n, 10n ** 18n));
  const hashB = mempool.add(makeInBandOpPaying(SAFE_B, 1n, 0n));
  // Round 1 exec sim reports whole-bundle success (per-op gate, not exec, does the drop).
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  stubPublicClient(svc, { nonce: 7 });

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  try {
    // Round 1 drops B (per-op share), round 2 submits A alone.
    await svc.tryBundle();
  } finally {
    restore();
  }

  // B dropped with a terminal receipt; A submitted.
  expect(mempool.get(hashB), "underpayer removed from mempool").toBeUndefined();
  const rcptB = svc.getReceipt(hashB);
  expect(rcptB?.success, "underpayer got a terminal failed receipt").toEqual(false);
  expect(mempool.get(hashA), "payer left the mempool via submit").toBeUndefined();
  expect(sentRaw.length, "exactly one bundle broadcast (the survivor)").toEqual(1);
});

it("pool per-op attribution - two full payers both ride in one bundle (no false drop)", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  mempool.add(makeInBandOpPaying(SAFE_A, 1n, 10n ** 18n));
  mempool.add(makeInBandOpPaying(SAFE_B, 1n, 10n ** 18n));
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  stubPublicClient(svc, { nonce: 7 });

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  try {
    const r = await svc.tryBundle();
    expect(r.submitted).toEqual(true);
  } finally {
    restore();
  }
  expect(sentRaw.length).toEqual(1);
});

it("pool in-flight guard - a sender with a pending receipt is excluded from the next bundle", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  mempool.add(makeInBandOpPaying(SAFE_A, 1n, 10n ** 18n));
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  stubPublicClient(svc, { nonce: 7 });
  // SAFE_A already has a bundle in flight (restored pending receipt; its entry is SAFE_A).
  svc.importPendingState(stuckPending(POOL0));

  const before = acct.calls.lease;
  const r = await svc.tryBundle();
  // No fresh op is eligible → defer without leasing a new pool EOA.
  expect(r.submitted).toEqual(false);
  expect(acct.calls.lease, "no new lease when every sender is in flight").toEqual(before);
  expect(mempool.get(mempool.getAll()[0]!.userOpHash), "the op stays in the mempool").toBeDefined();
});

// ---------------------------------------------------------------------------
// Immediate treasury top-up on insufficient funds (queue-mode funding gap fix)
// ---------------------------------------------------------------------------

it("insufficient-funds hook fires with the EOA + shortfall (drives the immediate top-up)", async () => {
  // Legacy (non-in-band) path so the deterministic balance gate runs: checkBalance reports the
  // EOA can't afford the prefund → flagInsufficientFunds → the hook fires. (In-band skips the
  // balance gate and only trips at broadcast, which viem-mocking classifies as ambiguous.)
  const acct = poolAccountService();
  (acct as any).checkBalance = async () => ({ sufficient: false, spendableBalance: 1n, requiredBalance: 10n ** 15n });
  const mempool = newMempool();
  // A legacy op pays a real EntryPoint fee (maxFee > 0) so it passes validation and reaches the
  // balance gate (a maxFee=0 op is only valid on an in-band chain).
  const legacyOp = { ...makeInBandOp(SAFE_A, 1n), maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  mempool.add(legacyOp);
  const svc = new BundlerService(
    poolConfig({ inBandChains: "", settlementVaultChains: "", poolEoaChains: "" }),
    mempool, poolSimulator(), acct, { disableTimers: true },
  );
  stubPublicClient(svc, { nonce: 7 });

  const flags: Array<{ eoa: string; shortfall: bigint }> = [];
  svc.setInsufficientFundsHook((eoa, shortfall) => flags.push({ eoa: eoa.toLowerCase(), shortfall }));

  const r = await svc.tryBundle();
  expect(r.submitted).toEqual(false); // deferred, ops kept in the mempool

  // The underfunded EOA is surfaced with a positive shortfall so the DO's immediate-refill
  // wiring can fund it without waiting for the healthLoop.
  expect(flags.length).toBeGreaterThanOrEqual(1);
  expect(flags[0]!.eoa).toEqual(PER_SAFE_EOA);
  expect(flags[0]!.shortfall).toBeGreaterThan(0n);
  expect(svc.insufficientFundsEoa?.toLowerCase()).toEqual(PER_SAFE_EOA);
  expect(svc.insufficientFundsWei).toEqual(flags[0]!.shortfall);
});
