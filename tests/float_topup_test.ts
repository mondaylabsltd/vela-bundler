/**
 * SponsorService.topUpFloatEOA — the fronting-EOA float refill (Stage 2/3 vault mode).
 *
 * Covers the review-hardened behaviors that topUpPoolEOAs' tests don't reach:
 *  - shortfall-sized refill (a bundle prefund many× the static target must clear)
 *  - the estimateTransferGas path (+20% vs the 100k fallback)
 *  - the treasuryTxStuck defer (an unconfirmed treasury tx jams all sends)
 *  - the in-flight dedup, treasury-floor guard, and the Tempo (pathUSD) branch split.
 *
 * The stub parses each broadcast raw tx (viem parseTransaction) so value/gas are asserted
 * directly, not inferred.
 */

import { it, expect } from "vitest";
import { parseTransaction } from "viem";
import { SponsorService } from "../shared/account/sponsor.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { Alerter } from "../shared/monitoring/telegram.ts";

const TREASURY = ("0x" + "cc".repeat(20)) as `0x${string}`;
const EOA = ("0x" + "d1".repeat(20)) as `0x${string}`;
const RPC = "http://float-topup.invalid";
const GAS_PRICE = 1_000_000_000n; // 1 gwei
const NATIVE = 10n ** 18n;

// Static float defaults (sponsor.ts): min 0.0005, target 0.002 native.
const STATIC_TARGET = 2n * 10n ** 15n;

function cfg(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: RPC,
    operatorSecret: "0x" + "ab".repeat(32),
    treasuryAddress: TREASURY,
    telegramBotToken: null,
    telegramChatId: null,
    ...overrides,
  } as unknown as BundlerConfig;
}

function fakeAlerter(): { alerter: Alerter; ids: string[] } {
  const ids: string[] = [];
  return { ids, alerter: { send: (id: string) => { ids.push(id); return Promise.resolve(true); } } as unknown as Alerter };
}

interface Sent { to: `0x${string}`; value: bigint; gas: bigint }

/** RPC stub: scriptable balances, treasury nonce (latest/pending), estimateGas, and a
 *  raw-tx-decoding sendRawTransaction. Also answers eth_call balanceOf (Tempo pathUSD). */
function stub(opts: {
  eoaBalance?: bigint;
  treasuryBalance?: bigint;
  latestNonce?: number;
  pendingNonce?: number;
  estimateGas?: bigint | "throw";
  /** eth_call balanceOf answers by lowercased address (Tempo pathUSD). */
  pathUsd?: Record<string, bigint>;
}): { sends: Sent[]; restore: () => void } {
  const real = globalThis.fetch;
  const sends: Sent[] = [];

  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId": return "0x1";
      case "eth_blockNumber": return "0x1";
      case "eth_gasPrice": return "0x" + GAS_PRICE.toString(16);
      case "eth_maxPriorityFeePerGas": return "0x" + GAS_PRICE.toString(16);
      case "eth_getTransactionCount": {
        const tag = params[1];
        const n = tag === "pending" ? (opts.pendingNonce ?? 0) : (opts.latestNonce ?? 0);
        return "0x" + n.toString(16);
      }
      case "eth_estimateGas": {
        if (opts.estimateGas === "throw") throw new Error("estimateGas unsupported");
        return "0x" + (opts.estimateGas ?? 21_000n).toString(16);
      }
      case "eth_getBalance": {
        const addr = String(params[0]).toLowerCase();
        if (addr === TREASURY.toLowerCase()) return "0x" + (opts.treasuryBalance ?? 100n * NATIVE).toString(16);
        return "0x" + (opts.eoaBalance ?? 0n).toString(16);
      }
      case "eth_call": {
        // balanceOf(address): selector 0x70a08231 + 32-byte owner.
        const data = String(params[0]?.data ?? "");
        const owner = "0x" + data.slice(-40);
        return "0x" + (opts.pathUsd?.[owner.toLowerCase()] ?? 0n).toString(16).padStart(64, "0");
      }
      case "eth_sendRawTransaction": {
        const tx = parseTransaction(String(params[0]) as `0x${string}`);
        sends.push({ to: tx.to as `0x${string}`, value: tx.value ?? 0n, gas: tx.gas ?? 0n });
        return "0x" + "12".repeat(32);
      }
      default: throw new Error(`unstubbed RPC method: ${method}`);
    }
  };

  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const bodyP = input instanceof Request ? input.text() : Promise.resolve(String(init?.body ?? ""));
    return bodyP.then((raw) => {
      const body = JSON.parse(raw);
      const one = (r: { id: number; method: string; params: any[] }) => {
        try { return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params) }; }
        catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } }; }
      };
      const payload = Array.isArray(body) ? body.map(one) : one(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }) as typeof fetch;

  return { sends, restore: () => { globalThis.fetch = real; } };
}

// --- Native float refill ------------------------------------------------------

it("topUpFloatEOA - refills a below-target EOA up to the static target", async () => {
  const s = stub({ eoaBalance: 10n ** 14n }); // 0.0001 < target
  try {
    const svc = new SponsorService(cfg(), fakeAlerter().alerter);
    const res = await svc.topUpFloatEOA(1, RPC, EOA);
    expect(res.toppedUp).toEqual(true);
    expect(s.sends.length).toEqual(1);
    expect(s.sends[0]!.to.toLowerCase()).toEqual(EOA.toLowerCase());
    expect(s.sends[0]!.value).toEqual(STATIC_TARGET - 10n ** 14n);
  } finally { s.restore(); }
});

it("topUpFloatEOA - an EOA already at/above target is left alone", async () => {
  const s = stub({ eoaBalance: STATIC_TARGET });
  try {
    const svc = new SponsorService(cfg(), fakeAlerter().alerter);
    const res = await svc.topUpFloatEOA(1, RPC, EOA);
    expect(res).toEqual({ toppedUp: false, reason: "already_funded" });
    expect(s.sends.length).toEqual(0);
  } finally { s.restore(); }
});

it("topUpFloatEOA - SHORTFALL sizing: refills to shortfall×1.5 where a static-target refill would no-op", async () => {
  // EOA balance is ABOVE the static target (so static-only would say already_funded) but a
  // pool bundle prefund (shortfall) is 30× the target — the refill must size to it.
  const shortfall = 60n * 10n ** 15n; // 0.06 native
  const balance = 3n * 10n ** 15n;    // 0.003 native (> 0.002 static target)
  const s = stub({ eoaBalance: balance });
  try {
    const svc = new SponsorService(cfg(), fakeAlerter().alerter);
    const res = await svc.topUpFloatEOA(1, RPC, EOA, shortfall);
    expect(res.toppedUp).toEqual(true);
    expect(s.sends.length).toEqual(1);
    // target = shortfall × 3/2 = 0.09; amount = target − balance.
    expect(s.sends[0]!.value).toEqual((shortfall * 3n) / 2n - balance);
  } finally { s.restore(); }
});

it("topUpFloatEOA - defers when the treasury has an unconfirmed tx (pending nonce > latest)", async () => {
  const s = stub({ eoaBalance: 0n, latestNonce: 5, pendingNonce: 6 });
  try {
    const svc = new SponsorService(cfg(), fakeAlerter().alerter);
    const res = await svc.topUpFloatEOA(1, RPC, EOA);
    expect(res).toEqual({ toppedUp: false, reason: "treasury_tx_stuck" });
    expect(s.sends.length).toEqual(0);
  } finally { s.restore(); }
});

it("topUpFloatEOA - treasury below floor for the needed amount → depleted + alert, no send", async () => {
  // Treasury just above the 0.01 floor but not enough for floor + amount + gas.
  const s = stub({ eoaBalance: 0n, treasuryBalance: 10n ** 16n });
  const { alerter, ids } = fakeAlerter();
  try {
    const svc = new SponsorService(cfg(), alerter);
    const res = await svc.topUpFloatEOA(1, RPC, EOA);
    expect(res.toppedUp).toEqual(false);
    expect(res.reason).toEqual("treasury_depleted");
    expect(s.sends.length).toEqual(0);
    expect(ids.some((id) => id.startsWith("float-topup-depleted"))).toBeTruthy();
  } finally { s.restore(); }
});

it("topUpFloatEOA - the same EOA is in-flight-skipped on an immediate second call", async () => {
  const s = stub({ eoaBalance: 0n });
  try {
    const svc = new SponsorService(cfg(), fakeAlerter().alerter);
    const first = await svc.topUpFloatEOA(1, RPC, EOA);
    expect(first.toppedUp).toEqual(true);
    const second = await svc.topUpFloatEOA(1, RPC, EOA);
    expect(second).toEqual({ toppedUp: false, reason: "in_flight" });
    expect(s.sends.length).toEqual(1);
  } finally { s.restore(); }
});

it("topUpFloatEOA - uses the estimated transfer gas (+20%) when eth_estimateGas answers", async () => {
  const s = stub({ eoaBalance: 0n, estimateGas: 50_000n });
  try {
    const svc = new SponsorService(cfg(), fakeAlerter().alerter);
    await svc.topUpFloatEOA(1, RPC, EOA);
    expect(s.sends[0]!.gas).toEqual((50_000n * 120n) / 100n); // +20%
  } finally { s.restore(); }
});

it("topUpFloatEOA - falls back to the 100k gas limit when eth_estimateGas throws", async () => {
  const s = stub({ eoaBalance: 0n, estimateGas: "throw" });
  try {
    const svc = new SponsorService(cfg(), fakeAlerter().alerter);
    await svc.topUpFloatEOA(1, RPC, EOA);
    expect(s.sends[0]!.gas).toEqual(100_000n); // TRANSFER_GAS_FALLBACK
  } finally { s.restore(); }
});

// --- Tempo (pathUSD) branch split --------------------------------------------

it("topUpFloatEOA - Tempo routes to the pathUSD branch (already-funded reads pathUSD, not native)", async () => {
  // pathUSD balance >= TEMPO_FLOAT_MIN (0.1 pathUSD = 100000 units) → already_funded via
  // eth_call balanceOf, and the native getBalance/send path is never taken.
  const s = stub({ pathUsd: { [EOA.toLowerCase()]: 300_000n }, eoaBalance: 0n });
  try {
    const svc = new SponsorService(cfg({ chainId: 4217 }), fakeAlerter().alerter);
    const res = await svc.topUpFloatEOA(4217, RPC, EOA);
    expect(res).toEqual({ toppedUp: false, reason: "already_funded" });
    expect(s.sends.length).toEqual(0);
  } finally { s.restore(); }
});

it("topUpFloatEOA - Tempo treasury pathUSD below floor → depleted + alert (no native send)", async () => {
  // EOA pathUSD low (needs refill), treasury pathUSD below TEMPO_TREASURY_FLOOR + amount.
  const s = stub({ pathUsd: { [EOA.toLowerCase()]: 0n, [TREASURY.toLowerCase()]: 50_000n } });
  const { alerter, ids } = fakeAlerter();
  try {
    const svc = new SponsorService(cfg({ chainId: 4217 }), alerter);
    const res = await svc.topUpFloatEOA(4217, RPC, EOA);
    expect(res.reason).toEqual("treasury_depleted");
    expect(ids.some((id) => id.startsWith("float-topup-depleted"))).toBeTruthy();
    expect(s.sends.length).toEqual(0);
  } finally { s.restore(); }
  // NOTE: the successful Tempo pathUSD SEND (sponsorTempoPathUsd via tempoActions
  // sendTransactionSync, a 0x76 fee-token tx) isn't cleanly stubbable through a plain fetch
  // mock — it's exercised end-to-end by the Tempo integration path, not this unit.
});
