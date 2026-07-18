/**
 * getGasPrices (A4 hardening) — the basic gas-price reads must:
 *  (a) NOT return baseFee=0 when the base-fee read FAILED but the chain is 1559 (a tip-only
 *      quote is grossly underpriced and stalls the signed op) — degrade instead;
 *  (b) fall back to the resolved public RPCs when the managed primary is down, so a
 *      single-provider outage doesn't take the whole chain offline for pricing.
 *
 * Each case uses a UNIQUE primary/fallback host so the module-level circuit breaker
 * (keyed by host) can't leak state between cases.
 */

import { it, expect } from "vitest";
import { createSimulator } from "../shared/simulation/index.ts";
import type { BundlerConfig } from "../shared/config/types.ts";

const GWEI = 1_000_000_000n;

function cfg(primary: string, publicRpcs: string[] = []): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: primary,
    publicRpcs,
    chainInfo: null,
    entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  } as unknown as BundlerConfig;
}

/** Per-method behaviour: a hex result string, or "fail" to answer HTTP 503 (transient → rejected). */
type MethodPlan = Record<string, string | "fail">;

/** Install a fetch stub answering JSON-RPC by (host → per-method plan). */
function stub(plans: Record<string, MethodPlan>): { restore: () => void } {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const host = new URL(url).host;
    const plan = plans[host];
    const bodyP = input instanceof Request ? input.text() : Promise.resolve(String(init?.body ?? ""));
    return bodyP.then((raw) => {
      const body = JSON.parse(raw);
      const one = (r: { id: number; method: string }) => {
        const outcome = plan?.[r.method];
        if (outcome === undefined || outcome === "fail") return { __fail: true, id: r.id };
        // eth_getBlockByNumber returns an object with baseFeePerGas; the others a hex string.
        const result = r.method === "eth_getBlockByNumber" ? { baseFeePerGas: outcome } : outcome;
        return { jsonrpc: "2.0", id: r.id, result };
      };
      const arr = Array.isArray(body) ? body : [body];
      const answers = arr.map(one);
      // If ANY method in the batch is planned to fail, fail the whole HTTP response (503) so
      // rpcCall throws for those calls. getGasPrices issues each read as its own request, so a
      // batch here is a single method — simple and sufficient.
      if (answers.some((a) => (a as { __fail?: boolean }).__fail)) {
        return new Response("upstream unavailable", { status: 503 });
      }
      const payload = Array.isArray(body) ? answers : answers[0];
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; } };
}

it("getGasPrices - block read fails + gasPrice fails + tip ok → degrades (never a tip-only quote)", async () => {
  const primary = "https://a4-case-a.invalid";
  const s = stub({ [new URL(primary).host]: {
    eth_getBlockByNumber: "fail",
    eth_gasPrice: "fail",
    eth_maxPriorityFeePerGas: "0x" + GWEI.toString(16),
  } });
  try {
    const sim = createSimulator(cfg(primary));
    await expect(sim.getGasPrices()).rejects.toBeDefined();
  } finally { s.restore(); }
});

it("getGasPrices - block read fails but gasPrice OK → chainGasPrice rescues (no degrade)", async () => {
  const primary = "https://a4-case-b.invalid";
  const s = stub({ [new URL(primary).host]: {
    eth_getBlockByNumber: "fail",
    eth_gasPrice: "0x" + (30n * GWEI).toString(16),
    eth_maxPriorityFeePerGas: "0x" + GWEI.toString(16),
  } });
  try {
    const sim = createSimulator(cfg(primary));
    const r = await sim.getGasPrices();
    expect(r.chainGasPrice).toEqual(30n * GWEI); // full-price floor available → usable
  } finally { s.restore(); }
});

it("getGasPrices - a MANAGED (Alchemy) primary does NOT fall back to public RPCs (operator priority)", async () => {
  const primary = "https://arb-mainnet.g.alchemy.com/v2/testkey"; // managed → highest priority, sole authority
  const fallback = "https://a4-would-have-worked.invalid";
  const s = stub({
    [new URL(primary).host]: { eth_getBlockByNumber: "fail", eth_gasPrice: "fail", eth_maxPriorityFeePerGas: "fail" },
    [new URL(fallback).host]: {
      eth_getBlockByNumber: "0x" + (25n * GWEI).toString(16),
      eth_gasPrice: "0x" + (26n * GWEI).toString(16),
      eth_maxPriorityFeePerGas: "0x" + (2n * GWEI).toString(16),
    },
  });
  try {
    const sim = createSimulator(cfg(primary, [fallback]));
    // Alchemy is down, but a working public RPC exists — we DEGRADE (retry Alchemy) rather than
    // trust the public price. If the fallback had been used this would resolve, not reject.
    await expect(sim.getGasPrices()).rejects.toBeDefined();
  } finally { s.restore(); }
});

it("getGasPrices - primary all-fail falls over to a public RPC", async () => {
  const primary = "https://a4-primary.invalid";
  const fallback = "https://a4-fallback.invalid";
  const s = stub({
    [new URL(primary).host]: { eth_getBlockByNumber: "fail", eth_gasPrice: "fail", eth_maxPriorityFeePerGas: "fail" },
    [new URL(fallback).host]: {
      eth_getBlockByNumber: "0x" + (25n * GWEI).toString(16),
      eth_gasPrice: "0x" + (26n * GWEI).toString(16),
      eth_maxPriorityFeePerGas: "0x" + (2n * GWEI).toString(16),
    },
  });
  try {
    const sim = createSimulator(cfg(primary, [fallback]));
    const r = await sim.getGasPrices();
    expect(r.baseFee).toEqual(25n * GWEI);
    expect(r.suggestedMaxPriorityFeePerGas).toEqual(2n * GWEI);
  } finally { s.restore(); }
});

it("getGasPrices - a legitimately non-1559 chain (block OK, no baseFeePerGas) keeps baseFee=0", async () => {
  const primary = "https://a4-nonzero1559.invalid";
  // Block read SUCCEEDS but carries no baseFeePerGas (our stub omits it by planning gasPrice only
  // as the block value would be an object with baseFeePerGas — model non-1559 via a fulfilled
  // block whose baseFeePerGas is absent by returning an empty-ish value).
  const s = stub({ [new URL(primary).host]: {
    // Return a block object with NO baseFeePerGas by using a plan the stub maps to {baseFeePerGas: undefined}.
    eth_getBlockByNumber: "",
    eth_gasPrice: "0x" + (5n * GWEI).toString(16),
    eth_maxPriorityFeePerGas: "0x0",
  } });
  try {
    const sim = createSimulator(cfg(primary));
    const r = await sim.getGasPrices();
    expect(r.baseFee).toEqual(0n);
    expect(r.chainGasPrice).toEqual(5n * GWEI);
  } finally { s.restore(); }
});
