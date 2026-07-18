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

import { it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseTransaction } from "viem";
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

it("classifyBroadcastError - ambiguous outcomes (tx may be in flight)", () => {
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
    expect(classifyBroadcastError(new Error(msg)), msg).toEqual("ambiguous");
  }
});

it("classifyBroadcastError - definitive rejections (node provably refused)", () => {
  for (const msg of [
    "insufficient funds for gas * price + value",
    "transaction underpriced", // initial send, not replacement
    "invalid transaction: malformed RLP",
    "execution reverted",
  ]) {
    expect(classifyBroadcastError(new Error(msg)), msg).toEqual("definitive");
  }
});

it("isInsufficientFundsError - native + Tempo shapes", () => {
  expect(isInsufficientFundsError(new Error("insufficient funds for gas * price + value"))).toBeTruthy();
  expect(isInsufficientFundsError(new Error("total cost exceeds balance"))).toBeTruthy();
  expect(!isInsufficientFundsError(new Error("nonce too low"))).toBeTruthy();
});

it("isInsufficientFundsError - Alchemy/geth 'gas required exceeds allowance' (the chain-1 stall)", () => {
  // The exact production string: a drained fronting EOA's eth_estimateGas fails like this,
  // and it MUST be recognised as needs-top-up (not a generic transient defer) or the top-up
  // hook never fires and the op never lands.
  expect(isInsufficientFundsError(
    new Error("Execution reverted with reason: gas required exceeds allowance (0)."),
  )).toBeTruthy();
  expect(isInsufficientFundsError(new Error("gas required exceeds allowance (16600)"))).toBeTruthy();
  expect(isInsufficientFundsError(new Error("sender doesn't have enough funds to send tx"))).toBeTruthy();
  // A genuinely-reverting op (not a funds issue) must NOT be laundered into needs-top-up.
  expect(!isInsufficientFundsError(new Error("execution reverted: AA23 reverted"))).toBeTruthy();
});

// ---------------------------------------------------------------------------
// EOA lock: version guard + proof-based recovery
// ---------------------------------------------------------------------------

it("initEOA - stale reads must not clobber a lock taken during the await (#11)", async () => {
  const lm = new EOALockManager();
  // Seed an ACTIVE state (the ingress path refreshes existing EOAs).
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  expect(lm.getState(TEST_EOA)?.status).toEqual("ACTIVE");

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

  expect(result.status, "stale refresh must return the current state").toEqual("LOCKED_PENDING_UNKNOWN");
  expect(lm.getState(TEST_EOA)?.status, "the lock must survive").toEqual("LOCKED_PENDING_UNKNOWN");
  expect(lm.getState(TEST_EOA)?.inFlightNonce).toEqual(5);
});

it("initEOA - a locked EOA with a known inFlightNonce needs PROOF to unlock (#9)", async () => {
  const lm = new EOALockManager();
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  lm.lockEOA(TEST_EOA, "LOCKED_PENDING_UNKNOWN", 5); // our tx uses nonce 5

  // pending==latest==5 on an RPC without reliable "pending" support: the OLD heuristic
  // unlocked here (false ACTIVE while our tx is in flight). Now: nonce 5 not consumed → LOCKED.
  const still = await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  expect(still.status).toEqual("LOCKED_PENDING_UNKNOWN");

  // latest advanced PAST our nonce → the chain consumed it → recovery is safe.
  const recovered = await lm.initEOA(TEST_EOA, nonceClient({ latest: 6, pending: 6 }));
  expect(recovered.status).toEqual("ACTIVE");
  expect(recovered.inFlightNonce, "proof consumed — the pin is cleared").toEqual(undefined);
});

it("initEOA - failed nonce reads never unlock a locked EOA", async () => {
  const lm = new EOALockManager();
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  lm.lockEOA(TEST_EOA, "LOCKED_PENDING_UNKNOWN", 5);

  // Both reads fail — the old code aliased pending=latest(cached) and unlocked blind.
  const state = await lm.initEOA(TEST_EOA, nonceClient({ latest: new Error("down"), pending: new Error("down") }));
  expect(state.status).toEqual("LOCKED_PENDING_UNKNOWN");
});

it("initEOA - unknown in-flight nonce still recovers via the heuristic (restart path)", async () => {
  const lm = new EOALockManager();
  // A restart-restored lock has no nonce proof (pre-upgrade persisted state).
  lm.restorePending(TEST_EOA, 0n);
  expect(lm.getState(TEST_EOA)?.status).toEqual("LOCKED_PENDING_UNKNOWN");
  // Successful reads with pending == latest → heuristic recovery (the ONLY path after restart).
  const state = await lm.initEOA(TEST_EOA, nonceClient({ latest: 7, pending: 7 }));
  expect(state.status).toEqual("ACTIVE");
});

it("restorePending - carries the persisted nonce pin and lock clock", () => {
  const lm = new EOALockManager();
  lm.restorePending(TEST_EOA, 100n, { inFlightNonce: 9, lockedSince: 12345 });
  const s = lm.getState(TEST_EOA)!;
  expect(s.inFlightNonce).toEqual(9);
  expect(s.lockedSince).toEqual(12345);
  expect(lm.oldestLockedAgeMs(20000)).toEqual(20000 - 12345);
});

it("initEOA - proof unlock needs ONLY a live latest read (pending-tag failure must not brick the EOA)", async () => {
  // Regression for the review finding: an RPC that errors on blockTag "pending" (common)
  // must still unlock a locked EOA once `latest` proves the nonce was consumed.
  const lm = new EOALockManager();
  await lm.initEOA(TEST_EOA, nonceClient({ latest: 5, pending: 5 }));
  lm.lockEOA(TEST_EOA, "LOCKED_PENDING_UNKNOWN", 5);

  const state = await lm.initEOA(TEST_EOA, nonceClient({ latest: 6, pending: new Error("pending unsupported") }));
  expect(state.status, "latest=6 > inFlightNonce=5 is proof — pending read is irrelevant").toEqual("ACTIVE");
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

it("checkPendingReceipts - NEVER declares dropped while latestNonce <= txNonce (#9)", async () => {
  const svc = newService(new EOALockManager());
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: () => Promise.reject(new Error("not found")),
    getTransactionCount: () => Promise.resolve(7), // == txNonce: our tx is still in flight
  };
  svc.importPendingState(pinnedPending("0x" + "a1".repeat(32), 7));

  // Many cycles: the old heuristic (pending<=latest) would have declared dropped on cycle 3.
  for (let i = 0; i < 12; i++) await svc.checkPendingReceipts();

  expect(svc.pendingReceiptCount, "still pending — no dropped verdict without proof").toEqual(1);
  expect(svc.getReceipt("0x" + "11".repeat(32)), "no fabricated failed receipt").toEqual(undefined);
});

it("checkPendingReceipts - dropped only after consecutive nonce-consumed confirmations", async () => {
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
  expect(svc.pendingReceiptCount, "not yet — needs the third confirmation").toEqual(1);
  await svc.checkPendingReceipts();
  expect(svc.pendingReceiptCount, "proven dropped after 3 consecutive probes").toEqual(0);
  const receipt = svc.getReceipt("0x" + "11".repeat(32));
  expect(receipt && receipt.success === false, "honest failed receipt stored").toBeTruthy();
  expect(lm.getReservedBalance(TEST_EOA), "reservation released").toEqual(0n);
});

it("checkPendingReceipts - a receipt on a PRIOR (pre-bump) hash reconciles the bundle", async () => {
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
  expect(svc.pendingReceiptCount, "reconciled via the prior hash").toEqual(0);
});

it("checkPendingReceipts - a REVERTED outer tx still yields terminal failed receipts", async () => {
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
  expect(svc.pendingReceiptCount, "settled").toEqual(0);
  const receipt = svc.getReceipt("0x" + "11".repeat(32));
  expect(receipt && receipt.success === false, "terminal failed receipt for the reverted bundle").toBeTruthy();
  expect(receipt.receipt.transactionHash, "tied to the landed tx").toEqual(txHash);
});

it("checkPendingReceipts - legacy (unpinned) dropped verdict is debounced too", async () => {
  // Regression: a MINED sync-submitted (Tempo) tx has pending==latest as its NORMAL state;
  // a transient receipt-read failure must not fabricate a failed receipt on one observation.
  const svc = newService(new EOALockManager());
  (svc as unknown as { publicClient: unknown }).publicClient = {
    getTransactionReceipt: () => Promise.reject(new Error("transient")),
    getTransactionCount: () => Promise.resolve(8), // pending==latest==8
  };
  svc.importPendingState(pinnedPending("0x" + "ad".repeat(32), undefined as unknown as number));

  for (let i = 0; i < 8; i++) await svc.checkPendingReceipts();
  expect(svc.pendingReceiptCount, "cycle 3 and 6 observations are not enough").toEqual(1);
  await svc.checkPendingReceipts(); // cycle 9 → third consecutive observation
  expect(svc.pendingReceiptCount, "dropped after the debounce").toEqual(0);
});

// ---------------------------------------------------------------------------
// Automatic same-nonce fee-bump
// ---------------------------------------------------------------------------

function feeBumpFetchStub(sentRaw: string[]) {
  return (_input: string | URL | Request, init?: RequestInit) => {
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

it("tryFeeBump - replaces the stuck tx at ≥12.5% higher fees and re-bases the reservation", async () => {
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

  expect(sentRaw.length, "one raw replacement broadcast").toEqual(1);
  expect(pending.bumpCount).toEqual(1);
  expect((pending.priorTxHashes as string[]).length, "old hash still polled").toEqual(1);
  const newMax = pending.maxFeePerGas as bigint;
  expect(newMax >= (2_000_000_000n * 1125n) / 1000n, "≥12.5% replacement minimum").toBeTruthy();
  expect(newMax >= (3_000_000_000n * 125n) / 100n, "targets current base fee headroom").toBeTruthy();
  // Reservation re-based on the new worst-case prefund.
  expect(lm.getReservedBalance(TEST_EOA)).toEqual(100_000n * newMax);
});

it("tryFeeBump - refuses to bump past the bounded-loss ceiling", async () => {
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

  expect(pending.bumpCount, "no bump — the loss would exceed the cap").toEqual(0);
  expect(pending.txHash, "original tx untouched").toEqual("0x" + "f6".repeat(32));
});

it("tryCancellation - replaces a stuck tx with a 0-value self-transfer at the pinned nonce (B7 anti-brick)", async () => {
  // Base fee rose past the fee-bump ceiling (revenueCap too low), so the tx can neither land nor be
  // re-priced. Without a cancellation the pinned pool EOA stays LOCKED_PENDING_UNKNOWN forever
  // (latestNonce never passes txNonce). The cancellation replaces it at the SAME nonce so, whoever
  // wins, the nonce advances and the EOA recovers.
  const lm = new EOALockManager();
  const svc = newService(lm, {
    getGasPrices: () => Promise.resolve({ baseFee: 100_000_000_000n, suggestedMaxPriorityFeePerGas: 1_000_000_000n, chainGasPrice: 0n }),
  });
  (svc as unknown as { publicClient: unknown }).publicClient = { getBalance: () => Promise.resolve(10n ** 18n) };
  svc.importPendingState(pinnedPending("0x" + "c7".repeat(32), 7, {
    txTo: ENTRY_POINT, txData: "0x1234", txGas: "100000",
    maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000000",
    revenueCapPerGas: "2000000000", bumpCount: 2, // fee-bumps exhausted
  } as Partial<SerializedPending>));
  lm.restorePending(TEST_EOA, 1000n);
  const pending = (svc as unknown as { pendingReceipts: Record<string, unknown>[] }).pendingReceipts[0]!;
  const original = pending.txHash as string;

  const originalFetch = globalThis.fetch;
  const sentRaw: string[] = [];
  globalThis.fetch = feeBumpFetchStub(sentRaw) as typeof fetch;
  try {
    await (svc as unknown as { tryCancellation: (p: unknown) => Promise<void> }).tryCancellation(pending);
  } finally { globalThis.fetch = originalFetch; }

  expect(sentRaw.length, "one cancellation broadcast").toEqual(1);
  expect(pending.lastCancelAt, "cooldown stamped so it isn't re-sent immediately").toBeGreaterThan(0);
  expect((pending.priorTxHashes as string[]).includes(original), "original still polled (may still win)").toBeTruthy();
  expect(pending.txHash, "now also tracking the cancellation hash").not.toEqual(original);
  const tx = parseTransaction(sentRaw[0]! as `0x${string}`);
  expect(tx.to?.toLowerCase(), "self-transfer to the EOA").toEqual(TEST_EOA.toLowerCase());
  expect(tx.value ?? 0n, "zero value").toEqual(0n);
  expect(tx.nonce, "the pinned nonce").toEqual(7);
});

it("tryCancellation - unaffordable → defers + flags the EOA for top-up, no broadcast", async () => {
  const lm = new EOALockManager();
  const svc = newService(lm, {
    getGasPrices: () => Promise.resolve({ baseFee: 100_000_000_000n, suggestedMaxPriorityFeePerGas: 1_000_000_000n, chainGasPrice: 0n }),
  });
  (svc as unknown as { publicClient: unknown }).publicClient = { getBalance: () => Promise.resolve(1n) }; // broke EOA
  svc.importPendingState(pinnedPending("0x" + "c8".repeat(32), 7, {
    txTo: ENTRY_POINT, txData: "0x1234", txGas: "100000",
    maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000000", revenueCapPerGas: "2000000000", bumpCount: 2,
  } as Partial<SerializedPending>));
  const pending = (svc as unknown as { pendingReceipts: Record<string, unknown>[] }).pendingReceipts[0]!;

  const originalFetch = globalThis.fetch;
  const sentRaw: string[] = [];
  globalThis.fetch = feeBumpFetchStub(sentRaw) as typeof fetch;
  try {
    await (svc as unknown as { tryCancellation: (p: unknown) => Promise<void> }).tryCancellation(pending);
  } finally { globalThis.fetch = originalFetch; }

  expect(sentRaw.length, "no broadcast when unaffordable").toEqual(0);
  expect((pending.priorTxHashes as string[] | undefined) ?? [], "no hash tracked — nothing was broadcast").toEqual([]);
  expect((svc.insufficientFundsEoa ?? "").toLowerCase(), "flagged for the treasury refill loop").toEqual(TEST_EOA.toLowerCase());
});

it("tryCancellation - a FAILED broadcast does NOT latch: it is retried after the cooldown (B7 fix)", async () => {
  // Self-review regression: latching on any broadcast failure permanently disabled recovery. Now a
  // reject just cools down (lastCancelAt) and the next cycle retries with a recomputed fee.
  const lm = new EOALockManager();
  const svc = newService(lm, {
    getGasPrices: () => Promise.resolve({ baseFee: 100_000_000_000n, suggestedMaxPriorityFeePerGas: 1_000_000_000n, chainGasPrice: 0n }),
  });
  (svc as unknown as { publicClient: unknown }).publicClient = { getBalance: () => Promise.resolve(10n ** 18n) };
  svc.importPendingState(pinnedPending("0x" + "c9".repeat(32), 7, {
    txTo: ENTRY_POINT, txData: "0x1234", txGas: "100000",
    maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1000000000", revenueCapPerGas: "2000000000", bumpCount: 2,
  } as Partial<SerializedPending>));
  lm.restorePending(TEST_EOA, 1000n);
  const pending = (svc as unknown as { pendingReceipts: Record<string, unknown>[] }).pendingReceipts[0]!;
  const original = pending.txHash as string;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
    if (body.method === "eth_chainId") return Promise.resolve(answer("0x1"));
    if (body.method === "eth_sendRawTransaction") {
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "max fee per gas less than block base fee" } }), { headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(answer(null));
  }) as typeof fetch;
  try {
    await (svc as unknown as { tryCancellation: (p: unknown) => Promise<void> }).tryCancellation(pending);
  } finally { globalThis.fetch = originalFetch; }

  expect(pending.lastCancelAt, "cooldown stamped → a retry is scheduled").toBeGreaterThan(0);
  expect(pending.txHash, "a failed broadcast is NOT tracked as the new hash").toEqual(original);
  expect((pending.priorTxHashes as string[] | undefined) ?? [], "and the original is not shuffled into priorTxHashes").toEqual([]);
});

// ---------------------------------------------------------------------------
// Mempool: firstSeenAt, serialization, restore
// ---------------------------------------------------------------------------

it("mempool - replacement preserves firstSeenAt (stuck-age can't be masked, #3)", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  mp.add(makeUserOp());
  const first = mp.dump()[0]!;
  (first as { firstSeenAt: number }).firstSeenAt = Date.now() - 100_000;

  // Fee-bumped replacement (same sender+nonce, +10% fees, equal deltas).
  mp.add(makeUserOp({ maxFeePerGas: 2_400_000_000n, maxPriorityFeePerGas: 1_400_000_000n }));

  expect(mp.size).toEqual(1);
  const age = mp.oldestEntryAgeMs();
  expect(age >= 100_000, `age must survive the replacement (got ${age})`).toBeTruthy();
});

it("mempool - serialize/deserialize round-trips (feeToken included)", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const feeToken = ("0x" + "fe".repeat(20)) as `0x${string}`;
  const hash = mp.add(makeUserOp({ feeToken }), 123n, "https://user-rpc.example.com");
  const entry = mp.get(hash)!;

  const restored = deserializeMempoolEntry(serializeMempoolEntry(entry), ENTRY_POINT, 1);
  expect(restored.userOpHash, "hash re-derivation must match").toEqual(hash);
  expect(restored.userOp.feeToken?.toLowerCase()).toEqual(feeToken.toLowerCase());
  expect(restored.prefund).toEqual(123n);
  expect(restored.rpcUrlOverride).toEqual("https://user-rpc.example.com");
  expect(restored.firstSeenAt).toEqual(entry.firstSeenAt);
});

it("mempool - restoreEntry dedups against a fresher same-(sender,nonce) entry", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const hash = mp.add(makeUserOp());
  const stale = deserializeMempoolEntry(serializeMempoolEntry(mp.get(hash)!), ENTRY_POINT, 1);
  expect(mp.restoreEntry(stale), "duplicate must be rejected").toEqual(false);
  expect(mp.size).toEqual(1);

  mp.remove(hash);
  expect(mp.restoreEntry(stale), "restores cleanly when absent").toEqual(true);
  expect(mp.size).toEqual(1);
});

it("mempool - paymaster reservation key is deleted at zero (no unbounded growth)", () => {
  const mp = new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
  const paymaster = ("0x" + "9a".repeat(20)) as `0x${string}`;
  const hash = mp.add(makeUserOp({ paymaster, paymasterVerificationGasLimit: 50_000n, paymasterPostOpGasLimit: 50_000n, paymasterData: "0x" as `0x${string}` }));
  expect(mp.getPaymasterReserved(paymaster) > 0n).toBeTruthy();
  mp.remove(hash);
  expect(mp.getPaymasterReserved(paymaster)).toEqual(0n);
  const reservations = (mp as unknown as { paymasterReservations: Map<string, bigint> }).paymasterReservations;
  expect(reservations.size, "zeroed key must be deleted, not kept").toEqual(0);
});

// ---------------------------------------------------------------------------
// Receipt serialization round-trip
// ---------------------------------------------------------------------------

it("receipt serialize/deserialize - lossless bigint round-trip", () => {
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
  expect(roundTripped).toEqual(receipt);
});

// ---------------------------------------------------------------------------
// Escalator + heartbeat + alerter escalation
// ---------------------------------------------------------------------------

it("RepeatedErrorEscalator - pages at 3 consecutive failures, resets on success", async () => {
  const alerter = new RecordingAlerter();
  const esc = new RepeatedErrorEscalator(alerter);
  await esc.note("reconcile", 1, new Error("boom"));
  await esc.note("reconcile", 1, new Error("boom"));
  expect(alerter.sent.length, "transient noise must not page").toEqual(0);
  await esc.note("reconcile", 1, new Error("boom"));
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.id).toEqual("code-error-reconcile-1");
  expect(alerter.sent[0]!.message.includes("boom")).toBeTruthy();

  esc.ok("reconcile", 1);
  await esc.note("reconcile", 1, new Error("boom"));
  await esc.note("reconcile", 1, new Error("boom"));
  expect(alerter.sent.length, "streak reset — two failures after an ok stay quiet").toEqual(1);
});

it("maybeSendAliveHeartbeat - fires only past the interval, returns the new stamp", async () => {
  const alerter = new RecordingAlerter();
  const t0 = 1_000_000;
  const unchanged = await maybeSendAliveHeartbeat({
    alerter, lastSentAt: t0, stats: "s", runtime: "deno", intervalMs: 1000, now: t0 + 999,
  });
  expect(unchanged).toEqual(t0);
  expect(alerter.sent.length).toEqual(0);

  const bumped = await maybeSendAliveHeartbeat({
    alerter, lastSentAt: t0, stats: "2 chain(s)", runtime: "deno", intervalMs: 1000, now: t0 + 1001,
  });
  expect(bumped).toEqual(t0 + 1001);
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.message.includes("alive")).toBeTruthy();
});

it("maybeSendAliveHeartbeat - a FAILED delivery does not advance the stamp (no silent gap)", async () => {
  const failing: Alerter = { enabled: true, send: () => Promise.resolve(false) };
  const t0 = 1_000_000;
  const stamp = await maybeSendAliveHeartbeat({
    alerter: failing, lastSentAt: t0, stats: "s", runtime: "deno", intervalMs: 1000, now: t0 + 1001,
  });
  expect(stamp, "retry next cycle instead of opening a 2x-interval silence gap").toEqual(t0);
});

it("TelegramAlerter - per-call cooldown override + persistent-incident escalation", async () => {
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
    expect(sent.length, "the shorter per-call cooldown must win").toEqual(2);
    expect(sent[1]!.text.includes("reminder #2"), "a persisting condition escalates its wording").toBeTruthy();

    // Routine periodic messages (heartbeats) opt OUT of the incident prefix.
    await alerter.send("heartbeat-x", "alive", { cooldownMs: 0, noEscalation: true });
    now += 1;
    await alerter.send("heartbeat-x", "alive", { cooldownMs: 0, noEscalation: true });
    expect(!sent[3]!.text.includes("STILL FIRING"), "heartbeats repeat by design — never an incident").toBeTruthy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// process.ts: unmarked errors are internal (no upstream leak-through)
// ---------------------------------------------------------------------------

it("processRequest - an unmarked {code,message} object is NOT forwarded to the client", async () => {
  const leaky = { code: -32000, message: "upstream says: https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123 failed" };
  const registry = {
    getChain: () => Promise.reject(leaky),
    getAll: () => { throw leaky; },
  } as unknown as ChainRegistryLike;

  const res = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: ["0x" + "11".repeat(32)] },
    mockConfig(), registry, { chainId: 1 },
  );
  expect(res.error?.code, "generic internal error").toEqual(-32603);
  expect(res.error?.message).toEqual("Internal error");
  expect(!JSON.stringify(res).includes("SECRETKEY123"), "the upstream secret must not leak").toBeTruthy();
});

it("processRequest - deliberate factory errors ARE forwarded", async () => {
  const registry = { getChain: () => Promise.reject(methodNotFound("x")), getAll: () => [] } as unknown as ChainRegistryLike;
  const res = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_bogusMethod", params: [] },
    mockConfig(), registry, { chainId: 1 },
  );
  expect(res.error?.code, "methodNotFound passes the marker gate").toEqual(-32601);
});
