/**
 * Tests for the treasury-balance monitor + Telegram alerter (shared/monitoring/).
 */

import { assertEquals, assert } from "@std/assert";
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

Deno.test("TelegramAlerter - posts to the Telegram API with chat_id + text", async () => {
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
  assertEquals(capturedUrl, "https://api.telegram.org/botTOK/sendMessage");
  assertEquals(capturedBody.chat_id, "CHAT");
  assertEquals(capturedBody.text, "hello");
});

Deno.test("TelegramAlerter - dedups the same id within the cooldown, re-sends after it elapses", async () => {
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
  assertEquals(sends, 3); // a, c, d (b suppressed)
});

Deno.test("TelegramAlerter - a failed send does not hold the cooldown (retries next call)", async () => {
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
  assertEquals(sends, 2);
});

Deno.test("createAlerter - Noop when creds missing, Telegram when both present", () => {
  assert(createAlerter({ telegramBotToken: null, telegramChatId: null }) instanceof NoopAlerter);
  assert(createAlerter({ telegramBotToken: "T", telegramChatId: null }) instanceof NoopAlerter);
  assert(createAlerter({ telegramBotToken: null, telegramChatId: "C" }) instanceof NoopAlerter);
  assert(createAlerter({ telegramBotToken: "T", telegramChatId: "C" }) instanceof TelegramAlerter);
});

Deno.test("NoopAlerter - send resolves without throwing", async () => {
  await new NoopAlerter().send("id", "msg");
});

// --- Treasury monitor ---

class RecordingAlerter implements Alerter {
  readonly sent: { id: string; message: string }[] = [];
  send(id: string, message: string): Promise<void> {
    this.sent.push({ id, message });
    return Promise.resolve();
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

Deno.test("checkTreasuryBalance - alerts when native balance is below threshold", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: 1, chainName: "Ethereum", treasuryAddress: TREASURY,
    client: mockClient({ balance: 5n }), thresholdWei: 10n, thresholdPathUsd: 0n, alerter,
  });
  assertEquals(res?.belowThreshold, true);
  assertEquals(res?.token, "native");
  assertEquals(alerter.sent.length, 1);
  assertEquals(alerter.sent[0]!.id, "treasury-low-1");
  assert(alerter.sent[0]!.message.includes("Ethereum"));
});

Deno.test("checkTreasuryBalance - does NOT alert when native balance is at/above threshold", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: 1, chainName: null, treasuryAddress: TREASURY,
    client: mockClient({ balance: 10n }), thresholdWei: 10n, thresholdPathUsd: 0n, alerter,
  });
  assertEquals(res?.belowThreshold, false);
  assertEquals(alerter.sent.length, 0);
});

Deno.test("checkTreasuryBalance - Tempo chain uses the pathUSD balance + threshold", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: TEMPO_CHAIN, chainName: "Tempo", treasuryAddress: TREASURY,
    client: mockClient({ readContract: 100_000n }), thresholdWei: 0n, thresholdPathUsd: 500_000n, alerter,
  });
  assertEquals(res?.token, "pathUSD");
  assertEquals(res?.belowThreshold, true);
  assertEquals(alerter.sent.length, 1);
  assert(alerter.sent[0]!.message.includes("pathUSD"));
});

Deno.test("checkTreasuryBalance - returns null and does not alert on an RPC error", async () => {
  const alerter = new RecordingAlerter();
  const res = await checkTreasuryBalance({
    chainId: 1, chainName: null, treasuryAddress: TREASURY,
    client: mockClient({ throwOn: true }), thresholdWei: 10n, thresholdPathUsd: 0n, alerter,
  });
  assertEquals(res, null);
  assertEquals(alerter.sent.length, 0);
});

// --- Operational-health monitor (stuck-money → intervention alerts) ---

function healthySnap(overrides: Partial<OperationalSnapshot> = {}): OperationalSnapshot {
  return {
    chainId: 1, chainName: "Ethereum",
    oldestMempoolAgeMs: 0, lockedEoaCount: 0, oldestLockedAgeMs: 0,
    pendingReceiptCount: 0, oldestPendingReceiptAgeMs: 0, circuitDegraded: 0,
    reputationBannedSenders: 0,
    ...overrides,
  };
}

Deno.test("checkOperationalHealth - no alerts when everything is healthy", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap(), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  assertEquals(alerter.sent.length, 0);
});

Deno.test("checkOperationalHealth - alerts on a stuck mempool op", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ oldestMempoolAgeMs: 200_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  assertEquals(alerter.sent.length, 1);
  assertEquals(alerter.sent[0]!.id, "stuck-mempool-1");
  assert(alerter.sent[0]!.message.includes("STUCK in mempool"));
});

Deno.test("checkOperationalHealth - alerts on a stuck pending bundle", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ pendingReceiptCount: 1, oldestPendingReceiptAgeMs: 400_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  assertEquals(alerter.sent.map((s) => s.id), ["stuck-pending-1"]);
});

Deno.test("checkOperationalHealth - alerts on a stuck locked EOA only when count>0 AND age>threshold", async () => {
  const a1 = new RecordingAlerter();
  // count>0 but age below threshold → no alert (transient lock is normal)
  await checkOperationalHealth(healthySnap({ lockedEoaCount: 1, oldestLockedAgeMs: 1_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, a1);
  assertEquals(a1.sent.length, 0);
  const a2 = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ lockedEoaCount: 2, oldestLockedAgeMs: 200_000 }), DEFAULT_OPERATIONAL_THRESHOLDS, a2);
  assertEquals(a2.sent.map((s) => s.id), ["stuck-eoa-1"]);
  assert(a2.sent[0]!.message.includes("2 dedicated EOA"));
});

Deno.test("checkOperationalHealth - alerts on a degraded RPC circuit with a GLOBAL dedup key", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ circuitDegraded: 2 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  // Global key (not per-chain) so the Deno loop doesn't multiply it across cached chains.
  assertEquals(alerter.sent.map((s) => s.id), ["circuit-degraded"]);
});

Deno.test("checkOperationalHealth - alerts on penalized sender Safes (repeated failures)", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(healthySnap({ reputationBannedSenders: 3 }), DEFAULT_OPERATIONAL_THRESHOLDS, alerter);
  assertEquals(alerter.sent.map((s) => s.id), ["reputation-blocked-1"]);
  assert(alerter.sent[0]!.message.includes("3 sender Safe"));
});

Deno.test("checkOperationalHealth - multiple simultaneous conditions each alert once", async () => {
  const alerter = new RecordingAlerter();
  await checkOperationalHealth(
    healthySnap({ oldestMempoolAgeMs: 200_000, oldestPendingReceiptAgeMs: 400_000, pendingReceiptCount: 1, lockedEoaCount: 1, oldestLockedAgeMs: 200_000, circuitDegraded: 1 }),
    DEFAULT_OPERATIONAL_THRESHOLDS, alerter,
  );
  assertEquals(new Set(alerter.sent.map((s) => s.id)).size, 4);
});

Deno.test("fmtDuration - human durations", () => {
  assertEquals(fmtDuration(5_000), "5s");
  assertEquals(fmtDuration(125_000), "2m5s");
});

// --- EOA lock-age tracking (feeds the stuck-EOA alert) ---

Deno.test("EOALockManager - oldestLockedAgeMs tracks lock duration; clears on recovery", () => {
  const lm = new EOALockManager();
  const eoa = "0x" + "1a".repeat(20) as `0x${string}`;
  assertEquals(lm.oldestLockedAgeMs(), 0); // nothing locked
  const t0 = Date.now();
  lm.restorePending(eoa, 0n); // creates LOCKED_PENDING_UNKNOWN with lockedSince ≈ now
  const age = lm.oldestLockedAgeMs(t0 + 300_000);
  assert(age > 299_000 && age <= 300_000, `expected ~300000ms, got ${age}`);
  assertEquals(lm.getState(eoa)?.status, "LOCKED_PENDING_UNKNOWN");
});
