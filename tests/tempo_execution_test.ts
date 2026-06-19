/**
 * Tests for the Tempo fund-drain guard: simulateExecutionSuccess must reject a UserOp
 * whose on-chain EXECUTION would revert (so the in-band reimbursement transfer never
 * happens) BEFORE the bundler spends 0x76 gas. handleOps hides the inner revert, so the
 * guard reads UserOperationEvent.success from an eth_simulateV1 run.
 */
import { assertEquals } from "@std/assert";
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

Deno.test("simulateExecutionSuccess: all ops succeed → success", async () => {
  await withMock({ result: [{ calls: [{ status: "0x1", logs: [uoeLog(true, 0)] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    assertEquals(r.success, true);
  });
});

Deno.test("simulateExecutionSuccess: returns the REAL gasUsed (drives the cost basis)", async () => {
  await withMock({ result: [{ calls: [{ status: "0x1", gasUsed: "0x668a5", logs: [uoeLog(true, 0)] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    assertEquals(r.success, true);
    assertEquals(r.gasUsed, 420_005n); // 0x668a5
  });
});

Deno.test("simulateExecutionSuccess: a reverting op (success=false) is REJECTED with its index", async () => {
  await withMock({ result: [{ calls: [{ status: "0x1", logs: [uoeLog(false, 0)] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    assertEquals(r.success, false);
    assertEquals(r.failedOpIndex, 0);
  });
});

Deno.test("simulateExecutionSuccess: rejects the right op in a multi-op bundle", async () => {
  await withMock(
    { result: [{ calls: [{ status: "0x1", logs: [uoeLog(true, 0), uoeLog(false, 1)] }] }] },
    async () => {
      const r = await createSimulator(config).simulateExecutionSuccess([op(), op()], BENE);
      assertEquals(r.success, false);
      assertEquals(r.failedOpIndex, 1);
    },
  );
});

Deno.test("simulateExecutionSuccess: missing UserOperationEvent (op never executed) → reject", async () => {
  // 1 op submitted but 0 events emitted — op reverted before producing an event.
  await withMock({ result: [{ calls: [{ status: "0x1", logs: [] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    assertEquals(r.success, false);
  });
});

Deno.test("simulateExecutionSuccess: handleOps reverted (status 0x0) → reject", async () => {
  await withMock({ result: [{ calls: [{ status: "0x0", error: { message: "FailedOp" }, logs: [] }] }] }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    assertEquals(r.success, false);
  });
});

Deno.test("simulateExecutionSuccess: FAILS CLOSED on RPC error (no submit without proof)", async () => {
  await withMock({ error: { message: "rate limited" } }, async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    assertEquals(r.success, false);
  });
});

Deno.test("simulateExecutionSuccess: FAILS CLOSED when fetch throws", async () => {
  await withMock("throw", async () => {
    const r = await createSimulator(config).simulateExecutionSuccess([op()], BENE);
    assertEquals(r.success, false);
  });
});
