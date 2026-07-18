/**
 * Tests for the treasury-balance monitor + Telegram alerter (shared/monitoring/).
 */

import { it, expect } from "vitest";
import { TelegramAlerter, NoopAlerter, createAlerter, type Alerter } from "../shared/monitoring/telegram.ts";
import { checkTreasuryBalance } from "../shared/monitoring/treasury.ts";
import { checkOperationalHealth, DEFAULT_OPERATIONAL_THRESHOLDS, fmtDuration, type OperationalSnapshot } from "../shared/monitoring/operational.ts";
import { EOALockManager } from "../shared/account/eoa-lock.ts";
import type { PublicClient, Transport, Chain } from "viem";

const TREASURY = "0x00000000000000000000000000000000000000aa" as `0x${string}`;
const TEMPO_CHAIN = 4217; // isTempoChain(4217) === true (see tempo_test.ts)

// --- Telegram alerter ---

function withStubbedFetch<T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

it("TelegramAlerter - posts to the Telegram API with chat_id + text", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const run = async () => {
    const alerter = new TelegramAlerter({ botToken: "TOK", chatId: "CHAT" });
    await alerter.send("id-1", "hello");
  };
  await withStubbedFetch((url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init!.body as string);
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }, run);
  expect(capturedUrl).toEqual("https://api.telegram.org/botTOK/sendMessage");
  expect(capturedBody.chat_id).toEqual("CHAT");
  expect(capturedBody.text).toEqual("hello");
});

it("TelegramAlerter - dedups the same id within the cooldown, re-sends after it elapses", async () => {
  let clock = 1_000_000;
  let sends = 0;
  const run = async () => {
    const alerter = new TelegramAlerter({ botToken: "T", chatId: "C", cooldownMs: 1000, now: () => clock });
    await alerter.send("dup", "a"); // sends
    await alerter.send("dup", "b"); // within cooldown → skipped
    clock += 1500; // past cooldown
    await alerter.send("dup", "c"); // sends again
    await alerter.send("other", "d"); // different id → sends
  };
  await withStubbedFetch(() => {
    sends++;
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }, run);
  expect(sends).toEqual(3); // a, c, d (b suppressed)
});

it("TelegramAlerter - a failed send does not hold the cooldown (retries next call)", async () => {
  let sends = 0;
  const run = async () => {
    const alerter = new TelegramAlerter({ botToken: "T", chatId: "C", cooldownMs: 60_000, now: () => 5 });
    await alerter.send("x", "1"); // 500 → failure, cooldown released
    await alerter.send("x", "2"); // retried immediately despite cooldown window
  };
  await withStubbedFetch(() => {
    sends++;
    return Promise.resolve(new Response("nope", { status: 500 }));
  }, run);
  expect(sends).toEqual(2);
});

it("createAlerter - Noop when creds missing, Telegram when both present", () => {
  expect(createAlerter({ telegramBotToken: null, telegramChatId: null }) instanceof NoopAlerter).toBeTruthy();
  expect(createAlerter({ telegramBotToken: "T", telegramChatId: null }) instanceof NoopAlerter).toBeTruthy();
  expect(createAlerter({ telegramBotToken: null, telegramChatId: "C" }) instanceof NoopAlerter).toBeTruthy();
  expect(createAlerter({ telegramBotToken: "T", telegramChatId: "C" }) instanceof TelegramAlerter).toBeTruthy();
});

it("NoopAlerter - send resolves without throwing", async () => {
  await new NoopAlerter().send("id", "msg");
});

// --- Treasury monitor ---

class RecordingAlerter implements Alerter {
  readonly enabled = true;
  readonly sent: { id: string; message: string; cooldownMs?: number }[] = [];
  send(id: string, message: string, opts?: { cooldownMs?: number; noEscalation?: boolean }): Promise<boolean> {
    this.sent.push({ id, message, cooldownMs: opts?.cooldownMs });
    return Promise.resolve(true);
  }
}

function mockClient(opts: { balance?: bigint; readContract?: bigint; throwOn?: boolean }): PublicClient<Transport, Chain> {
  return {
    getBalance: (_args: unknown) =>
      opts.throwOn ? Promise.reject(new Error("rpc down")) : Promise.resolve(opts.balance ?? 0n),
    readContract: (_args: unknown) =>
      opts.throwOn ? Promise.reject(new Error("rpc down")) : Promise.resolve(opts.readContract ?? 0n),
  } as unknown as PublicClient<Transport, Chain>;
}

it("checkTreasuryBalance - alerts when native balance is below threshold", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: 1, chainName: "Ethereum", treasuryAddress: TREASURY,
    client: mockClient({ balance: 5n }), thresholdWei: 10n, thresholdPathUsd: 0n, alerter,
  });
  expect(res?.belowThreshold).toEqual(true);
  expect(res?.token).toEqual("native");
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.id).toEqual("treasury-low-1");
  expect(alerter.sent[0]!.message.includes("Ethereum")).toBeTruthy();
});

it("checkTreasuryBalance - does NOT alert when native balance is at/above threshold", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: 1, chainName: null, treasuryAddress: TREASURY,
    client: mockClient({ balance: 10n }), thresholdWei: 10n, thresholdPathUsd: 0n, alerter,
  });
  expect(res?.belowThreshold).toEqual(false);
  expect(alerter.sent.length).toEqual(0);
});

it("checkTreasuryBalance - Tempo chain uses the pathUSD balance + threshold", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: TEMPO_CHAIN, chainName: "Tempo", treasuryAddress: TREASURY,
    client: mockClient({ readContract: 100_000n }), thresholdWei: 0n, thresholdPathUsd: 500_000n, alerter,
  });
  expect(res?.token).toEqual("pathUSD");
  expect(res?.belowThreshold).toEqual(true);
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.message.includes("pathUSD")).toBeTruthy();
});

it("checkTreasuryBalance - returns null and does not alert on an RPC error", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: 1, chainName: null, treasuryAddress: TREASURY,
    client: mockClient({ throwOn: true }), thresholdWei: 10n, thresholdPathUsd: 0n, alerter,
  });
  expect(res).toEqual(null);
  expect(alerter.sent.length).toEqual(0);
});

// --- Operational-health monitor (stuck-money → intervention alerts) ---

function healthySnap(overrides: Partial<OperationalSnapshot> = {}): OperationalSnapshot {
  return {
    chainId: 1, chainName: "Ethereum",
    oldestMempoolAgeMs: 0, lockedEoaCount: 0, oldestLockedAgeMs: 0,
    pendingReceiptCount: 0, oldestPendingReceiptAgeMs: 0, circuitDegraded: 0,
    reputationBannedSenders: 0,
    submitFailureStreak: 0, lastSubmitError: null, insufficientFundsEoa: null,
    ...overrides,
  };
}

it("checkOperationalHealth - repeated broadcast failures fire submit-failing", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(
    healthySnap({ submitFailureStreak: 3, lastSubmitError: "nonce too low" }),
    DEFAULT_OPERATIONAL_THRESHOLDS, alerter,
  );
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.id).toEqual("submit-failing-1");
  expect(alerter.sent[0]!.message.includes("nonce too low")).toBeTruthy();
});

it("checkOperationalHealth - poolIndex namespaces the alert id + label (B6, per-RelayerDO)", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(
    healthySnap({ poolIndex: 7, lockedEoaCount: 1, oldestLockedAgeMs: 200_000 }),
    DEFAULT_OPERATIONAL_THRESHOLDS, alerter,
  );
  expect(alerter.sent.length).toEqual(1);
  // Without the suffix all 100 relayers on chain 1 would dedup to `stuck-eoa-1` and only ONE
  // would ever alert — masking 99 stuck pool EOAs.
  expect(alerter.sent[0]!.id).toEqual("stuck-eoa-1-eoa7");
  expect(alerter.sent[0]!.message.includes("pool EOA #7"), "label distinguishes the index").toBeTruthy();
});

it("checkOperationalHealth - without poolIndex the ids are unchanged (chain BundlerDO)", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ lockedEoaCount: 1, oldestLockedAgeMs: 200_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  expect(alerter.sent[0]!.id).toEqual("stuck-eoa-1"); // no suffix — backward compatible
});

it("checkOperationalHealth - a streak below the threshold stays quiet", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(
    healthySnap({ submitFailureStreak: 2, lastSubmitError: "blip" }),
    DEFAULT_OPERATIONAL_THRESHOLDS, alerter,
  );
  expect(alerter.sent.length).toEqual(0);
});

it("checkOperationalHealth - an underfunded EOA fires eoa-underfunded with the address", async () => {
  const alerter = new RecordingAlerter();
  const eoa = ("0x" + "ab".repeat(20)) as `0x${string}`;
  await checkOperationalHealth(
    healthySnap({ insufficientFundsEoa: eoa, lastSubmitError: "insufficient funds" }),
    DEFAULT_OPERATIONAL_THRESHOLDS, alerter,
  );
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.id).toEqual(`eoa-underfunded-1-${eoa}`);
  expect(alerter.sent[0]!.message.includes(eoa), "the alert must name the address to top up").toBeTruthy();
});

it("checkOperationalHealth - money-stuck alerts use the shorter cooldown", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(
    healthySnap({ oldestMempoolAgeMs: 200_000 }),
    DEFAULT_OPERATIONAL_THRESHOLDS, alerter,
  );
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.cooldownMs).toEqual(10 * 60 * 1000);
});

it("checkOperationalHealth - no alerts when everything is healthy", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap(), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  expect(alerter.sent.length).toEqual(0);
});

it("checkOperationalHealth - alerts on a stuck mempool op", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ oldestMempoolAgeMs: 200_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  expect(alerter.sent.length).toEqual(1);
  expect(alerter.sent[0]!.id).toEqual("stuck-mempool-1");
  expect(alerter.sent[0]!.message.includes("STUCK in mempool")).toBeTruthy();
});

it("checkOperationalHealth - alerts on a stuck pending bundle", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ pendingReceiptCount: 1, oldestPendingReceiptAgeMs: 400_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  expect(alerter.sent.map((s) => s.id)).toEqual(["stuck-pending-1"]);
});

it("checkOperationalHealth - alerts on a stuck locked EOA only when count>0 AND age>threshold", async () => {
  const a1 = new RecordingAlerter();
  // count>0 but age below threshold → no alert (transient lock is normal)
  await checkOperationalHealth(healthySnap({ lockedEoaCount: 1, oldestLockedAgeMs: 1_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, a1);
  expect(a1.sent.length).toEqual(0);
  const a2 = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ lockedEoaCount: 2, oldestLockedAgeMs: 200_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, a2);
  expect(a2.sent.map((s) => s.id)).toEqual(["stuck-eoa-1"]);
  expect(a2.sent[0]!.message.includes("2 dedicated EOA")).toBeTruthy();
});

it("checkOperationalHealth - alerts on a degraded RPC circuit with a GLOBAL dedup key", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ circuitDegraded: 2 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  // Global key (not per-chain) so the Deno loop doesn't multiply it across cached chains.
  expect(alerter.sent.map((s) => s.id)).toEqual(["circuit-degraded"]);
});

it("checkOperationalHealth - alerts on penalized sender Safes (repeated failures)", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ reputationBannedSenders: 3 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  expect(alerter.sent.map((s) => s.id)).toEqual(["reputation-blocked-1"]);
  expect(alerter.sent[0]!.message.includes("3 sender Safe")).toBeTruthy();
});

it("checkOperationalHealth - multiple simultaneous conditions each alert once", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(
    healthySnap({ oldestMempoolAgeMs: 200_000, oldestPendingReceiptAgeMs: 400_000, pendingReceiptCount: 1, lockedEoaCount: 1, oldestLockedAgeMs: 200_000, circuitDegraded: 1 }),
    DEFAULT_OPERATIONAL_THRESHOLDS, alerter,
  );
  expect(new Set(alerter.sent.map((s) => s.id)).size).toEqual(4);
});

it("fmtDuration - human durations", () => {
  expect(fmtDuration(5_000)).toEqual("5s");
  expect(fmtDuration(125_000)).toEqual("2m5s");
});

// --- EOA lock-age tracking (feeds the stuck-EOA alert) ---

it("EOALockManager - oldestLockedAgeMs tracks lock duration; clears on recovery", () => {
  const lm = new EOALockManager();
  const eoa = "0x" + "1a".repeat(20) as `0x${string}`;
  expect(lm.oldestLockedAgeMs()).toEqual(0); // nothing locked
  const t0 = Date.now();
  lm.restorePending(eoa, 0n); // creates LOCKED_PENDING_UNKNOWN with lockedSince ≈ now
  const age = lm.oldestLockedAgeMs(t0 + 300_000);
  expect(age > 299_000 && age <= 300_000, `expected ~300000ms, got ${age}`).toBeTruthy();
  expect(lm.getState(eoa)?.status).toEqual("LOCKED_PENDING_UNKNOWN");
});
