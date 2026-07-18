/**
 * Tests for the Tempo fund-drain guard: simulateExecutionSuccess must reject a UserOp
 * whose on-chain EXECUTION would revert (so the in-band reimbursement transfer never
 * happens) BEFORE the bundler spends 0x76 gas. handleOps hides the inner revert, so the
 * guard reads UserOperationEvent.success from an eth_simulateV1 run.
 */
import { it, expect } from "vitest";
import { encodeAbiParameters, pad } from "viem";
import { createSimulator } from "../shared/simulation/index.ts";
import type { PackedUserOperation } from "../shared/userop/types.ts";
import type { BundlerConfig } from "../shared/config/types.ts";

const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const BENE = "0xd2d4245d0444653adefaa8b12eae1a15bda0edac" as const;
// keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
const UOE_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as const;

const config = { entryPointAddress: EP, rpcUrl: "http://mock.local" } as unknown as BundlerConfig;

function op(): PackedUserOperation {
  return {
    sender: "0x14fb1fb21751e29f7ec48dc450017552e3d1ea5c",
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    accountGasLimits: ("0x" + "00".repeat(32)) as `0x${string}`,
    preVerificationGas: 0n,
    gasFees: ("0x" + "00".repeat(32)) as `0x${string}`,
    paymasterAndData: "0x",
    signature: "0x",
  };
}

function uoeLog(success: boolean, idx: number) {
  return {
    address: EP,
    topics: [
      UOE_TOPIC,
      pad(("0x" + (idx + 1).toString(16)) as `0x${string}`, { size: 32 }), // userOpHash
      pad("0x14fb1fb21751e29f7ec48dc450017552e3d1ea5c", { size: 32 }), // sender
      pad("0x00", { size: 32 }), // paymaster
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [0n, success, 0n, 0n],
    ),
  };
}

const realFetch = globalThis.fetch;
function mockJson(body: unknown) {
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
}
async function withMock(body: unknown, fn: () => Promise<void>) {
  if (body === "throw") globalThis.fetch = () => Promise.reject(new Error("network down"));
  else mockJson(body);
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

it("simulateExecutionSuccess: all ops succeed → success", async () => {
  await withMock({ result: [{ calls: [{ status: "0x1", logs: [uoeLog(true, 0)] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(true);
  });
});

it("simulateExecutionSuccess: returns the REAL gasUsed (drives the cost basis)", async () => {
  await withMock({ result: [{ calls: [{ status: "0x1", gasUsed: "0x668a5", logs: [uoeLog(true, 0)] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(true);
    expect(r.gasUsed).toEqual(420_005n); // 0x668a5
  });
});

it("simulateExecutionSuccess: a reverting op (success=false) is REJECTED with its index", async () => {
  await withMock({ result: [{ calls: [{ status: "0x1", logs: [uoeLog(false, 0)] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(false);
    expect(r.failedOpIndex).toEqual(0);
  });
});

it("simulateExecutionSuccess: rejects the right op in a multi-op bundle", async () => {
  await withMock(
    { result: [{ calls: [{ status: "0x1", logs: [uoeLog(true, 0), uoeLog(false, 1)] }] }] },
    async () => {
      const r = await createSimulator(config).simulateExecutionSuccess([op(), op()], BENE);
      expect(r.success).toEqual(false);
      expect(r.failedOpIndex).toEqual(1);
    },
  );
});

it("simulateExecutionSuccess: missing UserOperationEvent (op never executed) → reject", async () => {
  // 1 op submitted but 0 events emitted — op reverted before producing an event.
  await withMock({ result: [{ calls: [{ status: "0x1", logs: [] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(false);
  });
});

it("simulateExecutionSuccess: handleOps reverted (status 0x0) → reject", async () => {
  await withMock({ result: [{ calls: [{ status: "0x0", error: { message: "FailedOp" }, logs: [] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(false);
  });
});

it("simulateExecutionSuccess: FAILS CLOSED on RPC error (no submit without proof)", async () => {
  await withMock({ error: { message: "rate limited" } }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(false);
  });
});

it("simulateExecutionSuccess: FAILS CLOSED when fetch throws", async () => {
  await withMock("throw", async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(false);
  });
});

// --- eth_call fallback (RPCs without eth_simulateV1, e.g. X Layer free tier) ---
// Route responses by JSON-RPC method so we can drive "eth_simulateV1 unavailable → eth_call decides".
function mockByMethod(byMethod: Record<string, unknown>) {
  globalThis.fetch = ((_url: unknown, init?: { body?: string }) => {
    let method = "";
    try { method = JSON.parse(init?.body ?? "{}").method ?? ""; } catch { /* ignore */ }
    const resp = byMethod[method] ?? byMethod["*"] ?? { error: { message: `unmocked ${method}` } };
    return Promise.resolve(new Response(JSON.stringify(resp), { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
}
async function withMethodMock(byMethod: Record<string, unknown>, fn: () => Promise<void>) {
  mockByMethod(byMethod);
  try { await fn(); } finally { globalThis.fetch = realFetch; }
}
const V1_UNAVAILABLE = { error: { code: 35, message: "method is not available on freetier, please upgrade to paid tier" } };

it("fallback: eth_simulateV1 unavailable + single deployed op + eth_call OK → success (no gasUsed)", async () => {
  await withMethodMock({ eth_simulateV1: V1_UNAVAILABLE, eth_call: { result: "0x" } }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(true);
    expect(r.gasUsed).toBeUndefined();
    expect(r.transient).toBeFalsy();
  });
});

it("fallback: eth_simulateV1 unavailable + eth_call probe REVERTS → reject with failedOpIndex (not transient)", async () => {
  await withMethodMock({ eth_simulateV1: V1_UNAVAILABLE, eth_call: { error: { code: 3, message: "execution reverted" } } }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(false);
    expect(r.failedOpIndex).toEqual(0);
    expect(r.transient).toBeFalsy();
  });
});

it("fallback: eth_simulateV1 unavailable + MULTI-OP → DEFER (transient, no drop) — closes sequential-drain hole", async () => {
  // eth_call must NOT be trusted for a multi-op bundle (per-op probe can't see cross-op state).
  await withMethodMock({ eth_simulateV1: V1_UNAVAILABLE, eth_call: { result: "0x" } }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op(), op()], BENE);
    expect(r.success).toEqual(false);
    expect(r.transient).toEqual(true);
    expect(r.failedOpIndex).toBeUndefined();
  });
});

it("fallback: eth_simulateV1 unavailable + undeployed account (initCode present) → DEFER (transient)", async () => {
  const deployOp = { ...op(), initCode: "0xabcabcabc0000000000000000000000000000000deadbeef" as `0x${string}` };
  await withMethodMock({ eth_simulateV1: V1_UNAVAILABLE, eth_call: { result: "0x" } }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([deployOp], BENE);
    expect(r.success).toEqual(false);
    expect(r.transient).toEqual(true);
  });
});

it("fallback NOT taken: a genuine UserOperationEvent.success=false verdict still rejects (never transient)", async () => {
  // eth_simulateV1 RAN and returned a real verdict — must reject as a defect, not defer.
  await withMethodMock({ eth_simulateV1: { result: [{ calls: [{ status: "0x1", logs: [uoeLog(false, 0)] }] }] }, eth_call: { result: "0x" } }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    expect(r.success).toEqual(false);
    expect(r.failedOpIndex).toEqual(0);
    expect(r.transient).toBeFalsy();
  });
});
