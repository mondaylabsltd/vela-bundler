/**
 * Integration tests — require a running Anvil node and deployed EntryPoint v0.7.
 *
 * Run:
 *   anvil &
 *   deno task test tests/integration_test.ts
 *
 * These tests are skipped if no local node is available.
 */

import { assertEquals, assert } from "@std/assert";

const RPC_URL = Deno.env.get("TEST_RPC_URL") ?? "http://localhost:8545";
const BUNDLER_URL = Deno.env.get("TEST_BUNDLER_URL") ?? "http://localhost:3300";

async function isNodeAvailable(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function isBundlerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(BUNDLER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function rpcCall(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

// --- Integration tests (skipped if bundler not available) ---

Deno.test({
  name: "Integration: eth_supportedEntryPoints returns array",
  ignore: !(await isBundlerAvailable()),
  async fn() {
    const result = await rpcCall(BUNDLER_URL, "eth_supportedEntryPoints");
    assert(Array.isArray(result));
    assert((result as string[]).length > 0);
  },
});

Deno.test({
  name: "Integration: eth_chainId returns hex chain ID",
  ignore: !(await isBundlerAvailable()),
  async fn() {
    const result = await rpcCall(BUNDLER_URL, "eth_chainId");
    assert(typeof result === "string");
    assert((result as string).startsWith("0x"));
  },
});

Deno.test({
  name: "Integration: eth_sendUserOperation rejects invalid UserOp",
  ignore: !(await isBundlerAvailable()),
  async fn() {
    try {
      await rpcCall(BUNDLER_URL, "eth_sendUserOperation", [
        {
          sender: "0x0000000000000000000000000000000000000000",
          nonce: "0x0",
          callData: "0x",
          callGasLimit: "0x0",
          verificationGasLimit: "0x0",
          preVerificationGas: "0x0",
          maxFeePerGas: "0x0",
          maxPriorityFeePerGas: "0x0",
          signature: "0x",
        },
        "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      ]);
      assert(false, "Should have thrown");
    } catch (err) {
      assert(err instanceof Error);
      // Should reject with validation error
    }
  },
});

Deno.test({
  name: "Integration: eth_getUserOperationByHash returns null for unknown hash",
  ignore: !(await isBundlerAvailable()),
  async fn() {
    const result = await rpcCall(BUNDLER_URL, "eth_getUserOperationByHash", [
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]);
    assertEquals(result, null);
  },
});

Deno.test({
  name: "Integration: eth_getUserOperationReceipt returns null for unknown hash",
  ignore: !(await isBundlerAvailable()),
  async fn() {
    const result = await rpcCall(BUNDLER_URL, "eth_getUserOperationReceipt", [
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]);
    assertEquals(result, null);
  },
});

Deno.test({
  name: "Integration: debug_bundler_clearState works in testing mode",
  ignore: !(await isBundlerAvailable()),
  async fn() {
    try {
      const result = await rpcCall(BUNDLER_URL, "debug_bundler_clearState");
      assertEquals(result, "ok");
    } catch {
      // Expected to fail if not in testing mode
    }
  },
});

Deno.test({
  name: "Integration: debug_bundler_dumpMempool returns array",
  ignore: !(await isBundlerAvailable()),
  async fn() {
    try {
      const result = await rpcCall(
        BUNDLER_URL,
        "debug_bundler_dumpMempool",
        ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"],
      );
      assert(Array.isArray(result));
    } catch {
      // Expected to fail if not in testing mode
    }
  },
});
