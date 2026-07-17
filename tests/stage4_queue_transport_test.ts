// deno-lint-ignore-file no-explicit-any -- partial `as any` mocks of AccountService/Simulator/Env/queue.
/**
 * Stage 4 queue-transport tests (QUEUE_TRANSPORT_ENABLED, docs/pool-queue-architecture.md):
 *  - hash(sender)%N routing: deterministic + stable, pinned vectors; the producer's KV index
 *    is the SAME function the consumer routes by
 *  - producer (BundlerService.acceptUserOp + makeEnqueueHook): queue mode + USEROP_QUEUE present
 *    → enqueued, mempool untouched, KV marker written; USEROP_QUEUE unbound → mempool fallback
 *    (no throw); flag off → enqueue hook never called
 *  - consumer (worker.queue): a mixed batch routes each group to the right RelayerDO name; ack on
 *    2xx, retry on non-2xx
 *  - RelayerDO /submit (relayerSubmit): dedups a repeated userOpHash (at-least-once); unique ops
 *    reach the mempool; the fixedPoolIndex bundle is signed by pool EOA #i
 *  - BundlerService fixedPoolIndex: tryPoolBundle uses getPoolEOA(i), never leaseFreePoolEOA
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
import { packUserOp } from "../shared/userop/pack.ts";
import { getUserOpHash } from "../shared/userop/hash.ts";
import { userOpToRpc } from "../shared/userop/normalize.ts";
import { relayerIndexForSender, RELAYER_POOL_SIZE } from "../shared/queue/routing.ts";
import { relayerSubmit } from "../worker/relayer-do.ts";
import { makeEnqueueHook } from "../worker/producer.ts";
import workerEntry from "../worker/index.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { Simulator } from "../shared/simulation/index.ts";
import type { AccountService } from "../shared/account/index.ts";
import type { UserOperation } from "../shared/userop/types.ts";
import type { UserOpQueueMessage } from "../worker/types.ts";

// --- Fixtures (mirrors tests/stage3_pool_bundling_test.ts) ---

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;
const TREASURY = ("0x" + "cc".repeat(20)) as `0x${string}`;
const SAFE_A = ("0x" + "aa".repeat(20)) as `0x${string}`;
const SAFE_B = ("0x" + "bb".repeat(20)) as `0x${string}`;

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
    // Stage 3 prerequisites + the Stage 4 queue flag.
    inBandChains: "all",
    settlementVaultChains: "all",
    poolEoaChains: "1",
    queueTransportChains: "1",
    apiRateLimitPerMinute: 60,
    rateLimitAllowlist: [],
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
    ...overrides,
  } as BundlerConfig;
}

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

function poolAccountService() {
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

const multiSend = parseAbi(["function multiSend(bytes transactions)"]);
const execUserOp = parseAbi([
  "function executeUserOp(address to, uint256 value, bytes data, uint8 operation)",
]);
const MULTI_SEND = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526" as const;

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
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0x" as `0x${string}`,
    feeToken: null,
  } as UserOperation;
}

function newMempool(): Mempool {
  return new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
}

function stubPublicClient(svc: BundlerService, opts: { nonce?: number; balance?: bigint } = {}): void {
  (svc as any).publicClient = {
    getTransactionCount: async () => opts.nonce ?? 7,
    getBalance: async () => opts.balance ?? 10n ** 18n,
    getTransactionReceipt: async () => { throw new Error("not found"); },
  };
}

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

/** The canonical hash the producer/mempool would compute for an op. */
function hashOf(op: UserOperation): `0x${string}` {
  return getUserOpHash(packUserOp(op), ENTRY_POINT, 1);
}
/** A queue message for an op, exactly as the producer builds it. */
function msgFor(op: UserOperation, chainId = 1): UserOpQueueMessage {
  return { chainId, entryPoint: ENTRY_POINT, rpcUserOp: userOpToRpc(op), userOpHash: hashOf(op), prefund: "0" };
}

// ---------------------------------------------------------------------------
// hash(sender) routing
// ---------------------------------------------------------------------------

it("hash(sender) routing - deterministic, stable, pinned vectors, producer==consumer", () => {
  const zeros = "0x" + "00".repeat(20);
  const aa = "0x" + "aa".repeat(20);
  const bb = "0x" + "bb".repeat(20);
  // Pinned vectors: last 8 nibbles as uint32 mod 100.
  expect(relayerIndexForSender(zeros)).toEqual(0);
  expect(relayerIndexForSender(aa)).toEqual(0xaaaaaaaa % RELAYER_POOL_SIZE); // 30
  expect(relayerIndexForSender(bb)).toEqual(0xbbbbbbbb % RELAYER_POOL_SIZE); // 83
  // Only the LAST 8 nibbles matter (high prefix ignored), and the modulo wraps at 100.
  expect(relayerIndexForSender("0x" + "00".repeat(18) + "0064")).toEqual(0);   // 0x00000064 = 100 → 0
  expect(relayerIndexForSender("0x" + "ff".repeat(16) + "00000065")).toEqual(1); // 0x00000065 = 101 → 1
  // Deterministic + case-insensitive + in range.
  for (const s of [zeros, aa, bb]) {
    expect(relayerIndexForSender(s)).toEqual(relayerIndexForSender(s.toUpperCase()));
    const i = relayerIndexForSender(s);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(RELAYER_POOL_SIZE);
  }
});

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

it("producer - queue mode + USEROP_QUEUE present: enqueued, mempool untouched, KV marker written", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  const sends: UserOpQueueMessage[] = [];
  const kvPuts: Array<{ key: string; value: string; ttl?: number }> = [];
  const env = {
    USEROP_QUEUE: { send: async (m: UserOpQueueMessage) => { sends.push(m); } },
    USEROP_STATUS: { put: async (k: string, v: string, o?: { expirationTtl?: number }) => { kvPuts.push({ key: k, value: v, ttl: o?.expirationTtl }); } },
  } as any;
  svc.setEnqueueHook(makeEnqueueHook(env, { chainId: 1, entryPoint: ENTRY_POINT }));

  const op = makeInBandOp(SAFE_A, 1n);
  const hash = await svc.acceptUserOp(op, 0n, undefined);

  // Enqueued exactly once, keyed by the op hash, carrying the round-trippable rpc op.
  expect(sends.length).toEqual(1);
  expect(sends[0]!.userOpHash).toEqual(hash);
  expect(sends[0]!.chainId).toEqual(1);
  expect((sends[0]!.rpcUserOp as { sender: string }).sender).toEqual(SAFE_A);
  // NOT added to the in-DO mempool (transport moved to the queue).
  expect(mempool.size, "queue mode does not add to the in-DO mempool").toEqual(0);
  // KV accepted marker with the SAME index the consumer routes by.
  expect(kvPuts.length).toEqual(1);
  expect(kvPuts[0]!.key).toEqual(hash);
  const marker = JSON.parse(kvPuts[0]!.value) as { status: string; index: number };
  expect(marker.status).toEqual("accepted");
  expect(marker.index, "producer KV index == consumer routing index").toEqual(relayerIndexForSender(SAFE_A));
  expect(kvPuts[0]!.ttl).toEqual(900);
});

it("producer - USEROP_QUEUE unbound: falls back to mempool.add, no throw", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  // No USEROP_QUEUE in env → the hook returns false → acceptUserOp keeps the op in the mempool.
  svc.setEnqueueHook(makeEnqueueHook({} as any, { chainId: 1, entryPoint: ENTRY_POINT }));

  const op = makeInBandOp(SAFE_A, 1n);
  const hash = await svc.acceptUserOp(op, 0n, undefined);
  expect(mempool.get(hash), "op landed in the mempool (never dropped)").toBeDefined();
  expect(mempool.size).toEqual(1);
});

it("producer - flag off: enqueue hook never called even when wired", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  // queueTransportChains "" → queueModeActive() false → the hook is never consulted.
  const svc = new BundlerService(poolConfig({ queueTransportChains: "" }), mempool, poolSimulator(), acct, { disableTimers: true });
  let calls = 0;
  svc.setEnqueueHook(async () => { calls++; return true; });

  const op = makeInBandOp(SAFE_A, 1n);
  const hash = await svc.acceptUserOp(op, 0n, undefined);
  expect(calls, "enqueue hook must not be called with the flag off").toEqual(0);
  expect(mempool.get(hash)).toBeDefined();
});

// ---------------------------------------------------------------------------
// Consumer (worker.queue)
// ---------------------------------------------------------------------------

type FakeMsg = { body: UserOpQueueMessage; ack: () => void; retry: () => void; acked: boolean; retried: boolean };
function fakeMsg(body: UserOpQueueMessage): FakeMsg {
  const m: FakeMsg = {
    body,
    acked: false,
    retried: false,
    ack: () => { m.acked = true; },
    retry: () => { m.retried = true; },
  };
  return m;
}
function fakeRelayerEnv(status: number) {
  const idNames: string[] = [];
  const posts: Array<{ name: string; ops: UserOpQueueMessage[] }> = [];
  const env = {
    RELAYER: {
      idFromName: (name: string) => { idNames.push(name); return { name }; },
      get: (id: { name: string }) => ({
        fetch: async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body) as { ops: UserOpQueueMessage[] };
          posts.push({ name: id.name, ops: body.ops });
          return new Response(JSON.stringify({ accepted: [] }), { status });
        },
      }),
    },
  } as any;
  return { env, idNames, posts };
}

it("consumer - mixed batch routes each group to the right RelayerDO name and acks on 2xx", async () => {
  const { env, idNames, posts } = fakeRelayerEnv(200);
  // 3 ops across 2 senders (A→30, B→83) and 2 chains (1, 8453).
  const m1 = fakeMsg(msgFor(makeInBandOp(SAFE_A, 1n), 1));
  const m2 = fakeMsg(msgFor(makeInBandOp(SAFE_B, 1n), 1));
  const m3 = fakeMsg(msgFor(makeInBandOp(SAFE_A, 2n), 8453));
  const batch = { messages: [m1, m2, m3] } as any;

  await (workerEntry as any).queue(batch, env, {} as any);

  const idxA = relayerIndexForSender(SAFE_A);
  const idxB = relayerIndexForSender(SAFE_B);
  expect(idNames.sort()).toEqual([
    `chain-1-eoa-${idxA}`,
    `chain-1-eoa-${idxB}`,
    `chain-8453-eoa-${idxA}`,
  ].sort());
  // Each distinct (chain,index) is one POST carrying its ops.
  const byName = new Map(posts.map((p) => [p.name, p.ops]));
  expect(byName.get(`chain-1-eoa-${idxA}`)!.length).toEqual(1);
  expect(byName.get(`chain-1-eoa-${idxB}`)!.length).toEqual(1);
  expect(byName.get(`chain-8453-eoa-${idxA}`)!.length).toEqual(1);
  // 2xx → every message acked, none retried.
  for (const m of [m1, m2, m3]) {
    expect(m.acked).toEqual(true);
    expect(m.retried).toEqual(false);
  }
});

it("consumer - same (chain,sender) ops collapse into ONE group / one POST", async () => {
  const { env, posts } = fakeRelayerEnv(200);
  const m1 = fakeMsg(msgFor(makeInBandOp(SAFE_A, 1n), 1));
  const m2 = fakeMsg(msgFor(makeInBandOp(SAFE_A, 2n), 1));
  const batch = { messages: [m1, m2] } as any;

  await (workerEntry as any).queue(batch, env, {} as any);

  expect(posts.length, "one POST for the single (chain,index) group").toEqual(1);
  expect(posts[0]!.ops.length).toEqual(2);
  expect(m1.acked && m2.acked).toEqual(true);
});

it("consumer - non-2xx from a RelayerDO retries the whole group (no ack)", async () => {
  const { env } = fakeRelayerEnv(500);
  const m1 = fakeMsg(msgFor(makeInBandOp(SAFE_A, 1n), 1));
  const m2 = fakeMsg(msgFor(makeInBandOp(SAFE_A, 2n), 1));
  const batch = { messages: [m1, m2] } as any;

  await (workerEntry as any).queue(batch, env, {} as any);

  for (const m of [m1, m2]) {
    expect(m.retried).toEqual(true);
    expect(m.acked).toEqual(false);
  }
});

// ---------------------------------------------------------------------------
// RelayerDO /submit (relayerSubmit) — dedup + fixedPoolIndex signing
// ---------------------------------------------------------------------------

it("relayerSubmit - dedups a repeated userOpHash, unique ops bundle under pool EOA #0", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true, fixedPoolIndex: 0 });
  stubPublicClient(svc, { nonce: 7 });

  const opA = makeInBandOp(SAFE_A, 1n);
  const opB = makeInBandOp(SAFE_B, 1n);
  // Third message is a REDELIVERY of opA (queues are at-least-once) — same userOpHash.
  const ops = [msgFor(opA), msgFor(opB), msgFor(opA)];
  const seen = new Set<string>();

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  let accepted: `0x${string}`[];
  try {
    ({ accepted } = await relayerSubmit({ ops, mempool, bundler: svc, seen }));
  } finally {
    restore();
  }

  // Every delivery is ACKed (including the duplicate), but only the two unique ops bundle.
  expect(accepted.length).toEqual(3);
  expect(sentRaw.length, "exactly one bundle for the two unique senders").toEqual(1);
  const decoded = decodeFunctionData({ abi: ENTRYPOINT_V07_ABI, data: parseTransaction(sentRaw[0]! as `0x${string}`).data! });
  const bundled = decoded.args[0] as Array<{ sender: string }>;
  expect(bundled.length).toEqual(2);
  expect(bundled.map((o) => o.sender.toLowerCase()).sort()).toEqual([SAFE_A, SAFE_B].sort());
  // Signed by the DO's fixed pool EOA (#0), not the per-safe EOA.
  const signer = await recoverTransactionAddress({ serializedTransaction: sentRaw[0]! as `0x${string}` });
  expect(signer.toLowerCase()).toEqual(POOL0);
  expect(acct.calls.lease, "fixedPoolIndex never leases").toEqual(0);
});

it("relayerSubmit - a redelivered op already in flight is not re-bundled", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true, fixedPoolIndex: 0 });
  stubPublicClient(svc, { nonce: 7 });
  const seen = new Set<string>();
  const opA = makeInBandOp(SAFE_A, 1n);

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  try {
    await relayerSubmit({ ops: [msgFor(opA)], mempool, bundler: svc, seen }); // A submitted → now in flight
    expect(sentRaw.length).toEqual(1);
    // Redelivery of the SAME op: dedup (seen-set) → no second bundle.
    const { accepted } = await relayerSubmit({ ops: [msgFor(opA)], mempool, bundler: svc, seen });
    expect(accepted).toEqual([hashOf(opA)]);
  } finally {
    restore();
  }
  expect(sentRaw.length, "no second broadcast for the redelivered op").toEqual(1);
});

// ---------------------------------------------------------------------------
// BundlerService fixedPoolIndex
// ---------------------------------------------------------------------------

it("fixedPoolIndex - tryPoolBundle uses getPoolEOA(i), never leaseFreePoolEOA; receipt keyed to i", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  mempool.add(makeInBandOp(SAFE_A, 1n));
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true, fixedPoolIndex: 5 });
  stubPublicClient(svc, { nonce: 7 });

  const sentRaw: string[] = [];
  const restore = stubBroadcastFetch(sentRaw);
  try {
    await svc.tryBundle();
  } finally {
    restore();
  }

  expect(acct.calls.getPoolEOA, "pinned to pool EOA #5").toEqual([5]);
  expect(acct.calls.lease, "the fixed path must never lease").toEqual(0);
  expect(sentRaw.length).toEqual(1);
  const signer = await recoverTransactionAddress({ serializedTransaction: sentRaw[0]! as `0x${string}` });
  expect(signer.toLowerCase()).toEqual(POOL0);
  // The pending receipt is keyed to the fixed pool index so fee-bump/reconciliation re-key it.
  const pending = svc.exportPendingState();
  expect(pending.length).toEqual(1);
  expect(pending[0]!.poolIndex).toEqual(5);
  expect(acct.calls.lockEOA).toEqual([{ address: POOL0, reason: "LOCKED_PENDING_UNKNOWN", nonce: 7 }]);
});

// ---------------------------------------------------------------------------
// Stage-4 review fixes: ambiguous-enqueue no double-bundle, rejection → terminal receipt
// ---------------------------------------------------------------------------

it("acceptUserOp - an AMBIGUOUS enqueue throw does NOT fall through to the mempool (no double-bundle)", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  // Hook whose send() outcome is ambiguous (throws AFTER a possible durable enqueue).
  svc.setEnqueueHook(async () => { throw new Error("queue send timeout"); });

  const op = makeInBandOp(SAFE_A, 1n);
  await expect(svc.acceptUserOp(op, 0n, undefined)).rejects.toThrow();
  // The op must NOT have been added to the in-DO mempool (that second path would double-bundle).
  expect(mempool.size, "ambiguous enqueue must not re-add to the mempool").toEqual(0);
});

it("acceptUserOp - a definitive FALSE (queue unbound) DOES fall through to the mempool", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true });
  svc.setEnqueueHook(async () => false); // provably not enqueued → safe to keep in mempool

  const op = makeInBandOp(SAFE_A, 1n);
  const hash = await svc.acceptUserOp(op, 0n, undefined);
  expect(mempool.get(hash), "unbound queue → op kept in the in-DO mempool").toBeDefined();
});

it("relayerSubmit - a mempool-rejected op gets a TERMINAL failed receipt (wallet poll resolves)", async () => {
  const acct = poolAccountService();
  const mempool = newMempool();
  const svc = new BundlerService(poolConfig(), mempool, poolSimulator(), acct, { disableTimers: true, fixedPoolIndex: 0 });
  stubPublicClient(svc, { nonce: 7 });
  const seen = new Set<string>();

  // A and B are two ops from the SAME sender in ONE delivery. The loop adds A, then B hits the
  // one-op-per-sender guard (A still in the mempool — kickBundle runs after the loop) and is
  // rejected. B must get a terminal failed receipt, not vanish. Both are ACKed.
  const opA = makeInBandOp(SAFE_A, 1n);
  const opB = makeInBandOp(SAFE_A, 2n);
  const restore = stubBroadcastFetch([]);
  try {
    const { accepted } = await relayerSubmit({ ops: [msgFor(opA), msgFor(opB)], mempool, bundler: svc, seen });
    expect(accepted.sort()).toEqual([hashOf(opA), hashOf(opB)].sort()); // both ACKed
  } finally {
    restore();
  }
  const rcptB = svc.getReceipt(hashOf(opB));
  expect(rcptB, "rejected op has a terminal receipt").toBeDefined();
  expect(rcptB?.success).toEqual(false);
});
