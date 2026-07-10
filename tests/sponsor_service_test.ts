/**
 * SponsorService unit tests — the treasury-protection logic, exercised
 * end-to-end through sponsor() with a stubbed global fetch that serves BOTH
 * viem's JSON-RPC transport and the WebAuthn index lookup. No network.
 *
 * Covered: dryRun probes never move money, probe/denial caches, the
 * eligibility gates (nonce / 2× Safe balance / passkey index / treasury),
 * client-hint capping, the 24h budget circuit breaker (hard, pre-consumed,
 * refunded on failure), success cooldown, and index-outage fail-closed.
 */

import { assert, assertEquals } from "@std/assert";
import { SponsorService } from "../shared/account/sponsor.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { Alerter } from "../shared/monitoring/telegram.ts";

const SAFE_A = "0x" + "aa".repeat(20) as `0x${string}`;
const SAFE_B = "0x" + "ab".repeat(20) as `0x${string}`;
const RELAYER = "0x" + "bb".repeat(20) as `0x${string}`;
const TREASURY = "0x" + "cc".repeat(20) as `0x${string}`;
const RPC = "http://rpc.sponsor-test.invalid";

const GAS_PRICE = 1_000_000_000n; // 1 gwei
// Mirrors sponsor.ts: serverEstimate = gasPrice × 600k × 2 × 1.5
const SERVER_ESTIMATE = (GAS_PRICE * 600_000n * 2n * 15_000n) / 10_000n; // 1.8e15

function config(): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: RPC,
    operatorSecret: "0x" + "ab".repeat(32),
    treasuryAddress: TREASURY,
    telegramBotToken: null,
    telegramChatId: null,
  } as unknown as BundlerConfig;
}

interface StubOpts {
  /** Relayer EOA nonce (new-user gate). */
  relayerNonce?: number;
  /** Balances by lowercase address (wei). */
  balances?: Record<string, bigint>;
  /** WebAuthn index HTTP status for any walletRef. */
  indexStatus?: number;
  /** JSON-RPC error message for eth_sendRawTransaction (simulates a failing transfer). */
  sendRawError?: string;
}

interface StubLog {
  rpcMethods: string[];
  rawTxCount: number;
  indexQueries: number;
}

/** Install a fetch stub serving JSON-RPC + the index; returns a call log. */
function stubFetch(opts: StubOpts): { log: StubLog; restore: () => void } {
  const real = globalThis.fetch;
  const log: StubLog = { rpcMethods: [], rawTxCount: 0, indexQueries: 0 };

  const rpcAnswer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "eth_chainId": return "0x1";
      case "eth_getTransactionCount": {
        const addr = String((params as string[])[0]).toLowerCase();
        return addr === RELAYER.toLowerCase()
          ? "0x" + (opts.relayerNonce ?? 0).toString(16)
          : "0x0";
      }
      case "eth_getBalance": {
        const addr = String((params as string[])[0]).toLowerCase();
        return "0x" + (opts.balances?.[addr] ?? 0n).toString(16);
      }
      case "eth_gasPrice": return "0x" + GAS_PRICE.toString(16);
      case "eth_maxPriorityFeePerGas": return "0x" + GAS_PRICE.toString(16);
      case "eth_estimateGas": return "0x5208"; // 21000
      case "eth_sendRawTransaction":
        log.rawTxCount++;
        if (opts.sendRawError) throw new Error(opts.sendRawError);
        return "0x" + "12".repeat(32);
      case "eth_getTransactionReceipt":
        return {
          transactionHash: "0x" + "12".repeat(32),
          blockNumber: "0x1",
          blockHash: "0x" + "34".repeat(32),
          status: "0x1",
          transactionIndex: "0x0",
          from: TREASURY,
          to: RELAYER,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x" + GAS_PRICE.toString(16),
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          type: "0x2",
          contractAddress: null,
        };
      case "eth_blockNumber": return "0x1";
      default:
        throw new Error(`unstubbed RPC method: ${method}`);
    }
  };

  globalThis.fetch = ((input: Request | URL | string, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/api/query")) {
      log.indexQueries++;
      const status = opts.indexStatus ?? 200;
      return Promise.resolve(new Response(status === 200 ? "{}" : "", { status }));
    }
    // JSON-RPC
    const bodyP = input instanceof Request ? input.text() : Promise.resolve(String(_init?.body ?? ""));
    return bodyP.then((raw) => {
      const body = JSON.parse(raw);
      const answer = (one: { id: number; method: string; params: unknown[] }) => {
        log.rpcMethods.push(one.method);
        try {
          return { jsonrpc: "2.0", id: one.id, result: rpcAnswer(one.method, one.params) };
        } catch (e) {
          return { jsonrpc: "2.0", id: one.id, error: { code: -32000, message: (e as Error).message } };
        }
      };
      const payload = Array.isArray(body) ? body.map(answer) : answer(body);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }) as typeof fetch;

  return { log, restore: () => { globalThis.fetch = real; } };
}

function fakeAlerter(): { alerter: Alerter; ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    alerter: { send: (id: string, _msg: string) => { ids.push(id); return Promise.resolve(); } } as unknown as Alerter,
  };
}

/** Balances for a fully eligible new user. */
function eligibleBalances(): Record<string, bigint> {
  return {
    [SAFE_A.toLowerCase()]: 10n ** 16n,      // ≥ 2× sponsor amount
    [SAFE_B.toLowerCase()]: 10n ** 16n,
    [RELAYER.toLowerCase()]: 0n,
    [TREASURY.toLowerCase()]: 10n ** 18n,    // well above floor
  };
}

Deno.test("dryRun: eligible probe passes every gate and moves NO money", async () => {
  const { log, restore } = stubFetch({ balances: eligibleBalances() });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    const result = await svc.sponsor(1, SAFE_A, RELAYER, RPC, undefined, true);
    assertEquals(result, { sponsored: false, dryRun: true, eligible: true });
    assertEquals(log.rawTxCount, 0);
  } finally { restore(); }
});

Deno.test("dryRun: repeated probes are served from the probe cache (no extra RPC)", async () => {
  const { log, restore } = stubFetch({ balances: eligibleBalances() });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    await svc.sponsor(1, SAFE_A, RELAYER, RPC, undefined, true);
    const callsAfterFirst = log.rpcMethods.length + log.indexQueries;
    const second = await svc.sponsor(1, SAFE_A, RELAYER, RPC, undefined, true);
    assertEquals(second.eligible, true);
    assertEquals(log.rpcMethods.length + log.indexQueries, callsAfterFirst);
  } finally { restore(); }
});

Deno.test("dryRun: an already-funded gas account probes as eligible (needs no grant)", async () => {
  const balances = eligibleBalances();
  balances[RELAYER.toLowerCase()] = 10n ** 16n; // float already above target
  const { log, restore } = stubFetch({ balances });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    const result = await svc.sponsor(1, SAFE_A, RELAYER, RPC, undefined, true);
    assertEquals(result.eligible, true);
    assertEquals(result.reason, "already_funded");
    assertEquals(log.rawTxCount, 0);
  } finally { restore(); }
});

Deno.test("gate: relayer nonce past the new-user window denies, and the denial is cached", async () => {
  const { log, restore } = stubFetch({ relayerNonce: 7, balances: eligibleBalances() });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    const first = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(first, { sponsored: false, reason: "nonce_exceeded" });
    const callsAfterFirst = log.rpcMethods.length;
    const second = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(second.reason, "nonce_exceeded");
    assertEquals(log.rpcMethods.length, callsAfterFirst); // served from denial cache
  } finally { restore(); }
});

Deno.test("gate: a Safe that cannot cover 2× the sponsor amount is denied (founder policy: no repayment ability → no grant)", async () => {
  const balances = eligibleBalances();
  balances[SAFE_A.toLowerCase()] = 0n; // empty / token-only wallet
  const { restore } = stubFetch({ balances });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    const result = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(result, { sponsored: false, reason: "wallet_balance_too_low" });
  } finally { restore(); }
});

Deno.test("gate: unregistered passkey index entry denies; an index OUTAGE is a distinct retryable reason + alert", async () => {
  const notRegistered = stubFetch({ balances: eligibleBalances(), indexStatus: 404 });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    const result = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(result, { sponsored: false, reason: "no_passkey_registered" });
  } finally { notRegistered.restore(); }

  const outage = stubFetch({ balances: eligibleBalances(), indexStatus: 500 });
  try {
    const { alerter, ids } = fakeAlerter();
    const svc = new SponsorService(config(), alerter);
    const result = await svc.sponsor(1, SAFE_B, RELAYER, RPC);
    assertEquals(result, { sponsored: false, reason: "passkey_index_unavailable" });
    assert(ids.includes("sponsor-passkey-index-down"));
  } finally { outage.restore(); }
});

Deno.test("hint cap: an attacker-supplied requiredWei is bounded to 3× the server estimate", async () => {
  // Safe balance sized so the CAPPED hint passes the 2× gate but the raw
  // 1-ETH hint would not: capped sponsor amount = min(3×estimate, per-tx cap).
  const cappedHint = SERVER_ESTIMATE * 3n;
  const perTxCap = 5_000_000n * GAS_PRICE;
  const sponsorAmount = cappedHint < perTxCap ? cappedHint : perTxCap;
  const balances = eligibleBalances();
  balances[SAFE_A.toLowerCase()] = sponsorAmount * 2n + 1n;
  // Index 404 so the flow stops right AFTER the balance gate — reaching
  // no_passkey_registered proves the capped hint cleared the 2× check.
  const { restore } = stubFetch({ balances, indexStatus: 404 });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    const result = await svc.sponsor(1, SAFE_A, RELAYER, RPC, 10n ** 18n);
    assertEquals(result.reason, "no_passkey_registered");
  } finally { restore(); }
});

Deno.test("grant: a fully eligible request transfers once and starts the per-safe success cooldown", async () => {
  const { log, restore } = stubFetch({ balances: eligibleBalances() });
  try {
    const svc = new SponsorService(config(), fakeAlerter().alerter);
    const result = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(result.sponsored, true);
    assertEquals(log.rawTxCount, 1);
    // Immediate re-ask for the same safe: rate-limited by the success cooldown.
    const again = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(again, { sponsored: false, reason: "rate_limited" });
    assertEquals(log.rawTxCount, 1);
  } finally { restore(); }
});

Deno.test("budget: the ceiling is hard — the grant after the limit is refused with budget_exhausted + alert", async () => {
  const { log, restore } = stubFetch({ balances: eligibleBalances() });
  try {
    const { alerter, ids } = fakeAlerter();
    const svc = new SponsorService(config(), alerter, { maxGrants: 1 });
    const first = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(first.sponsored, true);
    const second = await svc.sponsor(1, SAFE_B, RELAYER, RPC);
    assertEquals(second, { sponsored: false, reason: "budget_exhausted" });
    assert(ids.includes("sponsor-budget-1"));
    assertEquals(log.rawTxCount, 1);
  } finally { restore(); }
});

Deno.test("budget: a failed transfer refunds its reservation (the ceiling counts money moved, not attempts)", async () => {
  const failing = stubFetch({ balances: eligibleBalances(), sendRawError: "boom" });
  const { alerter, ids } = fakeAlerter();
  const svc = new SponsorService(config(), alerter, { maxGrants: 1 });
  try {
    const first = await svc.sponsor(1, SAFE_A, RELAYER, RPC);
    assertEquals(first.reason, "transfer_failed");
    assert(ids.includes("sponsor-transfer-failed-1"));
  } finally { failing.restore(); }

  // Budget was refunded → the single allowed grant is still available.
  const working = stubFetch({ balances: eligibleBalances() });
  try {
    const second = await svc.sponsor(1, SAFE_B, RELAYER, RPC);
    assertEquals(second.sponsored, true);
  } finally { working.restore(); }
});
