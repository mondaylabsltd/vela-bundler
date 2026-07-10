/**
 * Round-4 hardening regression tests (the "no silent stuck money, everything alerts" pass).
 *
 * Covers:
 *  - broadcast error classification (ambiguous vs definitive vs insufficient-funds)
 *  - EOA lock: stale-write version guard, proof-based (inFlightNonce) recovery,
 *    pending-read-failure keeps the lock, restorePending opts
 *  - checkPendingReceipts: proof-based dropped verdict (never on an in-flight nonce,
 *    requires consecutive confirmations), prior-hash receipt polling
 *  - automatic same-nonce fee-bump (bounds, ceiling, reservation re-base)
 *  - mempool: firstSeenAt across replacement, serialize round-trip (incl. feeToken),
 *    restoreEntry dedup, paymaster reservation cleanup
 *  - RepeatedErrorEscalator, heartbeat, alerter cooldown override + reminder escalation
 *  - process.ts: unmarked {code,message} objects are NOT forwarded to clients
 */

import { assertEquals, assert, assertThrows } from "@std/assert";
import { privateKeyToAccount } from "viem/accounts";
import {
  BundlerService,
  classifyBroadcastError,
  isInsufficientFundsError,
  serializeReceipt,
  deserializeReceipt,
} from "../shared/bundler/index.ts";
import {
  Mempool,
  serializeMempoolEntry,
  deserializeMempoolEntry,
} from "../shared/mempool/index.ts";
import { EOALockManager } from "../shared/account/eoa-lock.ts";
import { RepeatedErrorEscalator } from "../shared/monitoring/escalation.ts";
import { maybeSendAliveHeartbeat } from "../shared/monitoring/operational.ts";
import { TelegramAlerter, type Alerter } from "../shared/monitoring/telegram.ts";
import { processRequest } from "../shared/rpc/process.ts";
import { methodNotFound } from "../shared/rpc/errors.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { Simulator } from "../shared/simulation/index.ts";
import type { AccountService } from "../shared/account/index.ts";
import type { ChainRegistryLike } from "../shared/chain/index.ts";
import type { UserOperation, UserOperationReceipt } from "../shared/userop/types.ts";
import type { PublicClient, Transport, Chain } from "viem";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;
// A real key so fee-bump's deriveEOA-consistency check passes.
const TEST_KEY = ("0x" + "00".repeat(31) + "01") as `0x${string}`;
const TEST_EOA = privateKeyToAccount(TEST_KEY).address;
const SAFE = ("0x" + "22".repeat(20)) as `0x${string}`;

class RecordingAlerter implements Alerter {
  readonly enabled = true;
  readonly sent: { id: string; message: string }[] = [];
  send(id: string, message: string, _opts?: { cooldownMs?: number; noEscalation?: boolean }): Promise<boolean> {
    this.sent.push({ id, message });
    return Promise.resolve(true);
  }
}

function mockConfig(): BundlerConfig {
  return {
    chainId: 1, rpcUrl: "https://rpc.example.com", publicRpcs: [], chainInfo: null,
    entryPointAddress: ENTRY_POINT, port: 0, host: "", bundlingMode: "manual",
    maxBundleSize: 10, maxBundleGas: 5_000_000n, minPriorityFeePerGas: 0n,
    minProfitMarginBps: 1000, maxProfitMarginBps: 15000, walletGasMarkup: 1.5,
    useEip1559: true, baseFeeMultiplier: 1.25, bundlerTipGwei: 0.5, autoBundleIntervalMs: 10000,
    operatorSecret: "0x" + "ab".repeat(32), oldOperatorSecrets: [],
    treasuryAddress: "0x" + "cc".repeat(20) as `0x${string}`, splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    apiRateLimitPerMinute: 60, rateLimitAllowlist: [], balanceReserveMultiplier: 1, alchemyApiKey: null,
    telegramBotToken: null, telegramChatId: null, treasuryAlertThresholdWei: 0n, treasuryAlertThresholdPathUsd: 0n,
  } as BundlerConfig;
}

function mockAccountService(lockManager: EOALockManager): AccountService {
  return {
    reserveBalance: (addr: `0x${string}`, amt: bigint) => lockManager.addReservation(addr, amt),
    releaseBalance: (addr: `0x${string}`, amt: bigint) => lockManager.releaseReservation(addr, amt),
    deriveEOA: () => Promise.resolve({ address: TEST_EOA, privateKey: TEST_KEY }),
    lockManager,
  } as unknown as AccountService;
}

function newService(lockManager: EOALockManager, simulator?: Partial<Simulator>) {
  const mempool = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  return new BundlerService(
    mockConfig(), mempool, (simulator ?? {}) as unknown as Simulator,
    mockAccountService(lockManager), { disableTimers: true },
  );
}

function makeUserOp(overrides: Partial<UserOperation> = {}): UserOperation {
  return {
    sender: SAFE,
    nonce: 1n,
    factory: null, factoryData: null,
    callData: "0x" as `0x${string}`,
    callGasLimit: 100_000n, verificationGasLimit: 100_000n, preVerificationGas: 50_000n,
    maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    paymaster: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0x" as `0x${string}`,
    feeToken: null,
    ...overrides,
  } as UserOperation;
}

/** A client stub for the lock manager: nonce reads are scripted per blockTag. */
function nonceClient(script: { latest?: number | Error; pending?: number | Error }): PublicClient<Transport, Chain> {
  return {
    getTransactionCount: ({ blockTag }: { blockTag: "latest" | "pending" }) => {
      const v = script[blockTag];
      if (v instanceof Error) return Promise.reject(v);
      if (v === undefined) return Promise.reject(new Error("no script"));
      return Promise.resolve(v);
    },
  } as unknown as PublicClient<Transport, Chain>;
}

// ---------------------------------------------------------------------------
// Broadcast error classification
// ---------------------------------------------------------------------------

Deno.test("classifyBroadcastError - ambiguous outcomes (tx may be in flight)", () => {
  for (const msg of [
    "already known",
    "known transaction: 0xabc",
    "ALREADY_EXISTS: tx already imported",
    "nonce too low",
    "replacement transaction underpriced",
    "The request timed out",
    "fetch failed: network error",
    "HTTP request failed: 502 Bad Gateway",
    "503 Service Unavailable",
  ]) {
    assertEquals(classifyBroadcastError(new Error(msg)), "ambiguous", msg);
  }
});

Deno.test("classifyBroadcastError - definitive rejections (node provably refused)", () => {
  for (const msg of [
    "insufficient funds for gas * price + value",
    "transaction underpriced", // initial send, not replacement
    "invalid transaction: malformed RLP",
    "execution reverted",
  ]) {
    assertEquals(classifyBroadcastError(new Error(msg)), "definitive", msg);
  }
});

Deno.test("isInsufficientFundsError - native + Tempo shapes", () => {
  assert(isInsufficientFundsError(new Error("insufficient funds for gas * price + value")));
  assert(isInsufficientFundsError(new Error("total cost exceeds balance")));
  assert(!isInsufficientFundsError(new Error("nonce too low")));
});

// ---------------------------------------------------------------------------
// EOA lock: version guard + proof-based recovery
// ---------------------------------------------------------------------------

Deno.test("initEOA - stale reads must not clobber a lock taken during the await (#11)", async () => {
  const lm = new EOALockManager();
  // Seed an ACTIVE state (the ingress path refreshes existing EOAs).
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  assertEquals(lm.getState(TEST_EOA)?.status, "ACTIVE");

  // Start a refresh that blocks inside the nonce read…
  let releaseLatest: (n: number) => void = () => {};
  const blockedClient = {
    getTransactionCount: ({ blockTag }: { blockTag: string }) => {
      if (blockTag === "latest") return new Promise<number>((r) => { releaseLatest = r; });
      return Promise.resolve(5);
    },
  } as unknown as PublicClient<Transport, Chain>;
  const refresh = lm.initEOA(TEST_EOA, blockedClient);
  await new Promise((r) => setTimeout(r, 0)); // let it reach the await

  // …meanwhile a broadcast locks the EOA (this is the handleOps submit path).
  lm.lockEOA(TEST_EOA, "LOCKED_PENDING_UNKNOWN", 5);

  releaseLatest(5); // the refresh completes with reads from BEFORE the lock
  const result = await refresh;

  assertEquals(result.status, "LOCKED_PENDING_UNKNOWN", "stale refresh must return the current state");
  assertEquals(lm.getState(TEST_EOA)?.status, "LOCKED_PENDING_UNKNOWN", "the lock must survive");
  assertEquals(lm.getState(TEST_EOA)?.inFlightNonce, 5);
});

Deno.test("initEOA - a locked EOA with a known inFlightNonce needs PROOF to unlock (#9)", async () => {
  const lm = new EOALockManager();
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  lm.lockEOA(TEST_EOA, "LOCKED_PENDING_UNKNOWN", 5); // our tx uses nonce 5

  // pending==latest==5 on an RPC without reliable "pending" support: the OLD heuristic
  // unlocked here (false ACTIVE while our tx is in flight). Now: nonce 5 not consumed → LOCKED.
  const still = await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  assertEquals(still.status, "LOCKED_PENDING_UNKNOWN");

  // latest advanced PAST our nonce → the chain consumed it → recovery is safe.
  const recovered = await lm.initEOA(TEST_EOA, nonceClient({ latest: 6, pending: 6 }));
  assertEquals(recovered.status, "ACTIVE");
  assertEquals(recovered.inFlightNonce, undefined, "proof consumed — the pin is cleared");
});

Deno.test("initEOA - failed nonce reads never unlock a locked EOA", async () => {
  const lm = new EOALockManager();
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  lm.lockEOA(TEST_EOA, "LOCKED_PENDING_UNKNOWN", 5);

  // Both reads fail — the old code aliased pending=latest(cached) and unlocked blind.
  const state = await lm.initEOA(TEST_EOA, nonceClient({ latest: new Error("down"), pending: new Error("down") }));
  assertEquals(state.status, "LOCKED_PENDING_UNKNOWN");
});

Deno.test("initEOA - unknown in-flight nonce still recovers via the heuristic (restart path)", async () => {
  const lm = new EOALockManager();
  // A restart-restored lock has no nonce proof (pre-upgrade persisted state).
  lm.restorePending(TEST_EOA, 0n);
  assertEquals(lm.getState(TEST_EOA)?.status, "LOCKED_PENDING_UNKNOWN");
  // Successful reads with pending == latest → heuristic recovery (the ONLY path after restart).
  const state = await lm.initEOA(TEST_EOA, nonceClient({ latest: 7, pending: 7 }));
  assertEquals(state.status, "ACTIVE");
});

Deno.test("restorePending - carries the persisted nonce pin and lock clock", () => {
  const lm = new EOALockManager();
  lm.restorePending(TEST_EOA, 100n, { inFlightNonce: 9, lockedSince: 12345 });
  const s = lm.getState(TEST_EOA)!;
  assertEquals(s.inFlightNonce, 9);
  assertEquals(s.lockedSince, 12345);
  assertEquals(lm.oldestLockedAgeMs(20000), 20000 - 12345);
});

Deno.test("initEOA - proof unlock needs ONLY a live latest read (pending-tag failure must not brick the EOA)", async () => {
  // Regression for the review finding: an RPC that errors on blockTag "pending" (common)
  // must still unlock a locked EOA once `latest` proves the nonce was consumed.
  const lm = new EOALockManager();
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  lm.lockEOA(TEST_EOA, "LOCKED_PENDING_UNKNOWN", 5);

  const state = await lm.initEOA(TEST_EOA, nonceClient({ latest: 6, pending: new Error("pending unsupported") }));
  assertEquals(state.status, "ACTIVE", "latest=6 > inFlightNonce=5 is proof — pending read is irrelevant");
});

// ---------------------------------------------------------------------------
// Dropped verdict: proof-based, never on an in-flight nonce
// ---------------------------------------------------------------------------

type SerializedPending = ReturnType<BundlerService["exportPendingState"]>[number];

function pinnedPending(txHash: string, txNonce: number, extra: Partial<SerializedPending> = {}): SerializedPending[] {
  return [{
    txHash: txHash as `0x${string}`,
    entries: [{ userOpHash: ("0x" + "11".repeat(32)) as `0x${string}`, sender: SAFE, nonce: "5" }],
    eoaAddress: TEST_EOA,
    reservedAmount: "1000",
    rpcOverride: undefined,
    submittedAt: Date.now(),
    checkCount: 0,
    txNonce,
    ...extra,
  } as SerializedPending];
}

Deno.test("checkPendingReceipts - NEVER declares dropped while latestNonce <= txNonce (#9)", async () => {
  const svc = newService(new EOALockManager());
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: () => Promise.reject(new Error("not found")),
    getTransactionCount: () => Promise.resolve(7), // == txNonce: our tx is still in flight
  };
  svc.importPendingState(pinnedPending("0x" + "a1".repeat(32), 7));

  // Many cycles: the old heuristic (pending<=latest) would have declared dropped on cycle 3.
  for (let i = 0; i < 12; i++) await svc.checkPendingReceipts();

  assertEquals(svc.pendingReceiptCount, 1, "still pending — no dropped verdict without proof");
  assertEquals(svc.getReceipt("0x" + "11".repeat(32)), undefined, "no fabricated failed receipt");
});

Deno.test("checkPendingReceipts - dropped only after consecutive nonce-consumed confirmations", async () => {
  const lm = new EOALockManager();
  const svc = newService(lm);
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: () => Promise.reject(new Error("not found")),
    getTransactionCount: () => Promise.resolve(8), // > txNonce 7: consumed by something else
  };
  svc.importPendingState(pinnedPending("0x" + "b2".repeat(32), 7));

  // Nonce probes run every 3rd check; 3 consecutive consumed-observations are required.
  // Cycles 3, 6 → observations 1, 2 (still pending); cycle 9 → observation 3 → dropped.
  for (let i = 0; i < 8; i++) await svc.checkPendingReceipts();
  assertEquals(svc.pendingReceiptCount, 1, "not yet — needs the third confirmation");
  await svc.checkPendingReceipts();
  assertEquals(svc.pendingReceiptCount, 0, "proven dropped after 3 consecutive probes");
  const receipt = svc.getReceipt("0x" + "11".repeat(32));
  assert(receipt && receipt.success === false, "honest failed receipt stored");
  assertEquals(lm.getReservedBalance(TEST_EOA), 0n, "reservation released");
});

Deno.test("checkPendingReceipts - a receipt on a PRIOR (pre-bump) hash reconciles the bundle", async () => {
  const lm = new EOALockManager();
  const svc = newService(lm);
  const oldHash = ("0x" + "c3".repeat(32)) as `0x${string}`;
  const receipt = {
    status: "success",
    logs: [],
    blockNumber: 1n,
    blockHash: ("0x" + "00".repeat(32)) as `0x${string}`,
    transactionHash: oldHash,
    transactionIndex: 0,
    from: TEST_EOA,
    to: ENTRY_POINT,
    cumulativeGasUsed: 0n,
    gasUsed: 0n,
    effectiveGasPrice: 0n,
  };
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: ({ hash }: { hash: string }) =>
      hash === oldHash ? Promise.resolve(receipt) : Promise.reject(new Error("not found")),
    getTransactionCount: () => Promise.resolve(8),
  };
  svc.importPendingState(pinnedPending("0x" + "d4".repeat(32), 7, { priorTxHashes: [oldHash] } as Partial<SerializedPending>));

  await svc.checkPendingReceipts();
  assertEquals(svc.pendingReceiptCount, 0, "reconciled via the prior hash");
});

Deno.test("checkPendingReceipts - a REVERTED outer tx still yields terminal failed receipts", async () => {
  // Regression for the review finding: a landed-but-reverted tx carries no
  // UserOperationEvent logs — the ops must not end with receipt=null forever.
  const lm = new EOALockManager();
  const svc = newService(lm);
  const txHash = ("0x" + "ee".repeat(32)) as `0x${string}`;
  const revertedReceipt = {
    status: "reverted",
    logs: [],
    blockNumber: 1n,
    blockHash: ("0x" + "00".repeat(32)) as `0x${string}`,
    transactionHash: txHash,
    transactionIndex: 0,
    from: TEST_EOA,
    to: ENTRY_POINT,
    cumulativeGasUsed: 0n,
    gasUsed: 0n,
    effectiveGasPrice: 0n,
  };
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: () => Promise.resolve(revertedReceipt),
    getTransactionCount: () => Promise.resolve(8),
  };
  svc.importPendingState(pinnedPending(txHash, 7));

  await svc.checkPendingReceipts();
  assertEquals(svc.pendingReceiptCount, 0, "settled");
  const receipt = svc.getReceipt("0x" + "11".repeat(32));
  assert(receipt && receipt.success === false, "terminal failed receipt for the reverted bundle");
  assertEquals(receipt.receipt.transactionHash, txHash, "tied to the landed tx");
});

Deno.test("checkPendingReceipts - legacy (unpinned) dropped verdict is debounced too", async () => {
  // Regression: a MINED sync-submitted (Tempo) tx has pending==latest as its NORMAL state;
  // a transient receipt-read failure must not fabricate a failed receipt on one observation.
  const svc = newService(new EOALockManager());
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: () => Promise.reject(new Error("transient")),
    getTransactionCount: () => Promise.resolve(8), // pending==latest==8
  };
  svc.importPendingState(pinnedPending("0x" + "ad".repeat(32), undefined as unknown as number));

  for (let i = 0; i < 8; i++) await svc.checkPendingReceipts();
  assertEquals(svc.pendingReceiptCount, 1, "cycle 3 and 6 observations are not enough");
  await svc.checkPendingReceipts(); // cycle 9 → third consecutive observation
  assertEquals(svc.pendingReceiptCount, 0, "dropped after the debounce");
});

// ---------------------------------------------------------------------------
// Automatic same-nonce fee-bump
// ---------------------------------------------------------------------------

function feeBumpFetchStub(sentRaw: string[]) {
  return (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answer = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "Content-Type": "application/json" },
      });
    if (body.method === "eth_chainId") return Promise.resolve(answer("0x1"));
    if (body.method === "eth_sendRawTransaction") {
      sentRaw.push(body.params[0]);
      return Promise.resolve(answer("0x" + "ee".repeat(32)));
    }
    return Promise.resolve(answer(null));
  };
}

Deno.test("tryFeeBump - replaces the stuck tx at ≥12.5% higher fees and re-bases the reservation", async () => {
  const lm = new EOALockManager();
  const svc = newService(lm, {
    getGasPrices: () => Promise.resolve({ baseFee: 3_000_000_000n, suggestedMaxPriorityFeePerGas: 1_000_000_000n, chainGasPrice: 0n }),
  });
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getBalance: () => Promise.resolve(10n ** 18n),
  };
  svc.importPendingState(pinnedPending("0x" + "e5".repeat(32), 7, {
    txTo: ENTRY_POINT,
    txData: "0x1234",
    txGas: "100000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000000",
    revenueCapPerGas: "10000000000",
    bumpCount: 0,
  } as Partial<SerializedPending>));
  lm.restorePending(TEST_EOA, 1000n);

  const pending = (svc as unknown as { pendingReceipts: Record<string, unknown>[] }).pendingReceipts[0]!;
  const originalFetch = globalThis.fetch;
  const sentRaw: string[] = [];
  globalThis.fetch = feeBumpFetchStub(sentRaw) as typeof fetch;
  try {
    await (svc as unknown as { tryFeeBump: (p: unknown) => Promise<void> }).tryFeeBump(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(sentRaw.length, 1, "one raw replacement broadcast");
  assertEquals(pending.bumpCount, 1);
  assertEquals((pending.priorTxHashes as string[]).length, 1, "old hash still polled");
  const newMax = pending.maxFeePerGas as bigint;
  assert(newMax >= (2_000_000_000n * 1125n) / 1000n, "≥12.5% replacement minimum");
  assert(newMax >= (3_000_000_000n * 125n) / 100n, "targets current base fee headroom");
  // Reservation re-based on the new worst-case prefund.
  assertEquals(lm.getReservedBalance(TEST_EOA), 100_000n * newMax);
});

Deno.test("tryFeeBump - refuses to bump past the bounded-loss ceiling", async () => {
  const svc = newService(new EOALockManager(), {
    getGasPrices: () => Promise.resolve({ baseFee: 100_000_000_000n, suggestedMaxPriorityFeePerGas: 1_000_000_000n, chainGasPrice: 0n }),
  });
  svc.importPendingState(pinnedPending("0x" + "f6".repeat(32), 7, {
    txTo: ENTRY_POINT, txData: "0x1234", txGas: "100000",
    maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000000",
    revenueCapPerGas: "2000000000", // ceiling = 2× revenue = 4 gwei << 125 gwei target
    bumpCount: 0,
  } as Partial<SerializedPending>));
  const pending = (svc as unknown as { pendingReceipts: Record<string, unknown>[] }).pendingReceipts[0]!;

  await (svc as unknown as { tryFeeBump: (p: unknown) => Promise<void> }).tryFeeBump(pending);

  assertEquals(pending.bumpCount, 0, "no bump — the loss would exceed the cap");
  assertEquals(pending.txHash, "0x" + "f6".repeat(32), "original tx untouched");
});

// ---------------------------------------------------------------------------
// Mempool: firstSeenAt, serialization, restore
// ---------------------------------------------------------------------------

Deno.test("mempool - replacement preserves firstSeenAt (stuck-age can't be masked, #3)", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  mp.add(makeUserOp());
  const first = mp.dump()[0]!;
  (first as { firstSeenAt: number }).firstSeenAt = Date.now() - 100_000;

  // Fee-bumped replacement (same sender+nonce, +10% fees, equal deltas).
  mp.add(makeUserOp({ maxFeePerGas: 2_400_000_000n, maxPriorityFeePerGas: 1_400_000_000n }));

  assertEquals(mp.size, 1);
  const age = mp.oldestEntryAgeMs();
  assert(age >= 100_000, `age must survive the replacement (got ${age})`);
});

Deno.test("mempool - serialize/deserialize round-trips (feeToken included)", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const feeToken = ("0x" + "fe".repeat(20)) as `0x${string}`;
  const hash = mp.add(makeUserOp({ feeToken }), 123n, "https://user-rpc.example.com");
  const entry = mp.get(hash)!;

  const restored = deserializeMempoolEntry(serializeMempoolEntry(entry), ENTRY_POINT, 1);
  assertEquals(restored.userOpHash, hash, "hash re-derivation must match");
  assertEquals(restored.userOp.feeToken?.toLowerCase(), feeToken.toLowerCase());
  assertEquals(restored.prefund, 123n);
  assertEquals(restored.rpcUrlOverride, "https://user-rpc.example.com");
  assertEquals(restored.firstSeenAt, entry.firstSeenAt);
});

Deno.test("mempool - restoreEntry dedups against a fresher same-(sender,nonce) entry", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const hash = mp.add(makeUserOp());
  const stale = deserializeMempoolEntry(serializeMempoolEntry(mp.get(hash)!), ENTRY_POINT, 1);
  assertEquals(mp.restoreEntry(stale), false, "duplicate must be rejected");
  assertEquals(mp.size, 1);

  mp.remove(hash);
  assertEquals(mp.restoreEntry(stale), true, "restores cleanly when absent");
  assertEquals(mp.size, 1);
});

Deno.test("mempool - paymaster reservation key is deleted at zero (no unbounded growth)", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const paymaster = ("0x" + "9a".repeat(20)) as `0x${string}`;
  const hash = mp.add(makeUserOp({ paymaster, paymasterVerificationGasLimit: 50_000n, paymasterPostOpGasLimit: 50_000n, paymasterData: "0x" as `0x${string}` }));
  assert(mp.getPaymasterReserved(paymaster) > 0n);
  mp.remove(hash);
  assertEquals(mp.getPaymasterReserved(paymaster), 0n);
  const reservations = (mp as unknown as { paymasterReservations: Map<string, bigint> }).paymasterReservations;
  assertEquals(reservations.size, 0, "zeroed key must be deleted, not kept");
});

// ---------------------------------------------------------------------------
// Receipt serialization round-trip
// ---------------------------------------------------------------------------

Deno.test("receipt serialize/deserialize - lossless bigint round-trip", () => {
  const receipt: UserOperationReceipt = {
    userOpHash: ("0x" + "11".repeat(32)) as `0x${string}`,
    entryPoint: ENTRY_POINT,
    sender: SAFE,
    nonce: 5n,
    paymaster: null,
    actualGasCost: 123_456_789_000n,
    actualGasUsed: 250_000n,
    success: true,
    logs: [{
      logIndex: 3, address: ENTRY_POINT, topics: ["0x" + "aa".repeat(32) as `0x${string}`],
      data: "0x" as `0x${string}`, blockNumber: 99n,
      blockHash: ("0x" + "bb".repeat(32)) as `0x${string}`,
      transactionHash: ("0x" + "cc".repeat(32)) as `0x${string}`,
    }],
    receipt: {
      transactionHash: ("0x" + "cc".repeat(32)) as `0x${string}`, transactionIndex: 1,
      blockHash: ("0x" + "bb".repeat(32)) as `0x${string}`, blockNumber: 99n,
      from: TEST_EOA, to: ENTRY_POINT,
      cumulativeGasUsed: 1_000_000n, gasUsed: 250_000n, effectiveGasPrice: 2_000_000_000n,
    },
  };
  const roundTripped = deserializeReceipt(JSON.parse(JSON.stringify(serializeReceipt(receipt))));
  assertEquals(roundTripped, receipt);
});

// ---------------------------------------------------------------------------
// Escalator + heartbeat + alerter escalation
// ---------------------------------------------------------------------------

Deno.test("RepeatedErrorEscalator - pages at 3 consecutive failures, resets on success", async () => {
  const alerter = new RecordingAlerter();
  const esc = new RepeatedErrorEscalator(alerter);
  await esc.note("reconcile", 1, new Error("boom"));
  await esc.note("reconcile", 1, new Error("boom"));
  assertEquals(alerter.sent.length, 0, "transient noise must not page");
  await esc.note("reconcile", 1, new Error("boom"));
  assertEquals(alerter.sent.length, 1);
  assertEquals(alerter.sent[0]!.id, "code-error-reconcile-1");
  assert(alerter.sent[0]!.message.includes("boom"));

  esc.ok("reconcile", 1);
  await esc.note("reconcile", 1, new Error("boom"));
  await esc.note("reconcile", 1, new Error("boom"));
  assertEquals(alerter.sent.length, 1, "streak reset — two failures after an ok stay quiet");
});

Deno.test("maybeSendAliveHeartbeat - fires only past the interval, returns the new stamp", async () => {
  const alerter = new RecordingAlerter();
  const t0 = 1_000_000;
  const unchanged = await maybeSendAliveHeartbeat({
    alerter, lastSentAt: t0, stats: "s", runtime: "deno", intervalMs: 1000, now: t0 + 999,
  });
  assertEquals(unchanged, t0);
  assertEquals(alerter.sent.length, 0);

  const bumped = await maybeSendAliveHeartbeat({
    alerter, lastSentAt: t0, stats: "2 chain(s)", runtime: "deno", intervalMs: 1000, now: t0 + 1001,
  });
  assertEquals(bumped, t0 + 1001);
  assertEquals(alerter.sent.length, 1);
  assert(alerter.sent[0]!.message.includes("alive"));
});

Deno.test("maybeSendAliveHeartbeat - a FAILED delivery does not advance the stamp (no silent gap)", async () => {
  const failing: Alerter = { enabled: true, send: () => Promise.resolve(false) };
  const t0 = 1_000_000;
  const stamp = await maybeSendAliveHeartbeat({
    alerter: failing, lastSentAt: t0, stats: "s", runtime: "deno", intervalMs: 1000, now: t0 + 1001,
  });
  assertEquals(stamp, t0, "retry next cycle instead of opening a 2x-interval silence gap");
});

Deno.test("TelegramAlerter - per-call cooldown override + persistent-incident escalation", async () => {
  const sent: { text: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ text: JSON.parse(String(init?.body)).text });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    let now = 0;
    const alerter = new TelegramAlerter({ botToken: "T", chatId: "C", cooldownMs: 30 * 60 * 1000, now: () => now });
    await alerter.send("stuck-eoa-1", "money stuck", { cooldownMs: 10 * 60 * 1000 });
    now = 11 * 60 * 1000; // past the 10-min override, inside the default 30-min window
    await alerter.send("stuck-eoa-1", "money stuck", { cooldownMs: 10 * 60 * 1000 });
    assertEquals(sent.length, 2, "the shorter per-call cooldown must win");
    assert(sent[1]!.text.includes("reminder #2"), "a persisting condition escalates its wording");

    // Routine periodic messages (heartbeats) opt OUT of the incident prefix.
    await alerter.send("heartbeat-x", "alive", { cooldownMs: 0, noEscalation: true });
    now += 1;
    await alerter.send("heartbeat-x", "alive", { cooldownMs: 0, noEscalation: true });
    assert(!sent[3]!.text.includes("STILL FIRING"), "heartbeats repeat by design — never an incident");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// process.ts: unmarked errors are internal (no upstream leak-through)
// ---------------------------------------------------------------------------

Deno.test("processRequest - an unmarked {code,message} object is NOT forwarded to the client", async () => {
  const leaky = { code: -32000, message: "upstream says: https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123 failed" };
  const registry = {
    getChain: () => Promise.reject(leaky),
    getAll: () => { throw leaky; },
  } as unknown as ChainRegistryLike;

  const res = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: ["0x" + "11".repeat(32)] },
    mockConfig(), registry, { chainId: 1 },
  );
  assertEquals(res.error?.code, -32603, "generic internal error");
  assertEquals(res.error?.message, "Internal error");
  assert(!JSON.stringify(res).includes("SECRETKEY123"), "the upstream secret must not leak");
});

Deno.test("processRequest - deliberate factory errors ARE forwarded", async () => {
  const registry = { getChain: () => Promise.reject(methodNotFound("x")), getAll: () => [] } as unknown as ChainRegistryLike;
  const res = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_bogusMethod", params: [] },
    mockConfig(), registry, { chainId: 1 },
  );
  assertEquals(res.error?.code, -32601, "methodNotFound passes the marker gate");
});
