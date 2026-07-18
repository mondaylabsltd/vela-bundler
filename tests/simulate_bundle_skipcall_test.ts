/**
 * simulateBundle skipCallVerification (A8) — the in-band path runs simulateExecutionSuccess
 * (eth_simulateV1) right after, which already proves per-op execution + returns real gasUsed, so
 * simulateBundle's redundant step-2 eth_call is skipped there. This verifies:
 *  - skipCallVerification=false → eth_estimateGas AND eth_call (non-in-band safety net intact)
 *  - skipCallVerification=true  → eth_estimateGas ONLY (one fewer heavy round-trip on the hot path)
 */

import { it, expect } from "vitest";
import { createSimulator } from "../shared/simulation/index.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { PackedUserOperation } from "../shared/userop/types.ts";

const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

function cfg(rpc: string): BundlerConfig {
  return { chainId: 1, rpcUrl: rpc, publicRpcs: [], chainInfo: null, entryPointAddress: EP } as unknown as BundlerConfig;
}

function op(): PackedUserOperation {
  return {
    sender: ("0x" + "33".repeat(20)) as `0x${string}`,
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    accountGasLimits: ("0x" + "00".repeat(32)) as `0x${string}`,
    preVerificationGas: 21000n,
    gasFees: ("0x" + "00".repeat(32)) as `0x${string}`,
    paymasterAndData: "0x",
    signature: ("0x" + "ab".repeat(65)) as `0x${string}`,
  };
}

/** fetch stub that records which JSON-RPC methods were called. */
function stub(host: string): { restore: () => void; methods: string[] } {
  const real = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const bodyP = input instanceof Request ? input.text() : Promise.resolve(String(init?.body ?? ""));
    return bodyP.then((raw) => {
      const body = JSON.parse(raw);
      const one = (r: { id: number; method: string }) => {
        methods.push(r.method);
        // estimateGas → a hex gas; eth_call → empty success; anything else → benign.
        const result = r.method === "eth_estimateGas" ? "0x5208" : "0x";
        return { jsonrpc: "2.0", id: r.id, result };
      };
      const payload = Array.isArray(body) ? body.map(one) : one(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; }, methods };
}

it("simulateBundle - default (non-in-band) runs estimateGas AND the eth_call safety net", async () => {
  const rpc = "https://a8-both.invalid";
  const s = stub(new URL(rpc).host);
  try {
    const sim = createSimulator(cfg(rpc));
    const r = await sim.simulateBundle([op()], ("0x" + "ee".repeat(20)) as `0x${string}`, ("0x" + "ee".repeat(20)) as `0x${string}`);
    expect(r.success).toEqual(true);
    expect(s.methods).toContain("eth_estimateGas");
    expect(s.methods).toContain("eth_call");
  } finally { s.restore(); }
});

it("simulateBundle - skipCallVerification skips the redundant eth_call (in-band hot path)", async () => {
  const rpc = "https://a8-skip.invalid";
  const s = stub(new URL(rpc).host);
  try {
    const sim = createSimulator(cfg(rpc));
    const r = await sim.simulateBundle([op()], ("0x" + "ee".repeat(20)) as `0x${string}`, ("0x" + "ee".repeat(20)) as `0x${string}`, undefined, undefined, true);
    expect(r.success).toEqual(true);
    expect(r.estimatedGas).toEqual(21000n);       // still estimated
    expect(s.methods).toContain("eth_estimateGas");
    expect(s.methods).not.toContain("eth_call");   // the redundant round-trip is gone
  } finally { s.restore(); }
});
