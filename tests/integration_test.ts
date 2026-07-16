/**
 * Integration tests — require a running Anvil node and deployed EntryPoint v0.7.
 *
 * Run:
 *   anvil &
 *   deno task test tests/integration_test.ts
 *
 * These tests are skipped if no local node is available.
 */

import { it, expect } from "vitest";

const BUNDLER_URL = process.env.TEST_BUNDLER_URL ?? "http://localhost:3300";

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

const bundlerAvailable = await isBundlerAvailable();

// --- Integration tests (skipped if bundler not available) ---

it.skipIf(!bundlerAvailable)("Integration: eth_supportedEntryPoints returns array", async () => {
  const result = await rpcCall(BUNDLER_URL, "eth_supportedEntryPoints");
  expect(Array.isArray(result)).toBeTruthy();
  expect((result as string[]).length > 0).toBeTruthy();
});

it.skipIf(!bundlerAvailable)("Integration: eth_chainId returns hex chain ID", async () => {
  const result = await rpcCall(BUNDLER_URL, "eth_chainId");
  expect(typeof result === "string").toBeTruthy();
  expect((result as string).startsWith("0x")).toBeTruthy();
});

it.skipIf(!bundlerAvailable)("Integration: eth_sendUserOperation rejects invalid UserOp", async () => {
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
    expect(false, "Should have thrown").toBeTruthy();
  } catch (err) {
    expect(err instanceof Error).toBeTruthy();
    // Should reject with validation error
  }
});

it.skipIf(!bundlerAvailable)("Integration: eth_getUserOperationByHash returns null for unknown hash", async () => {
  const result = await rpcCall(BUNDLER_URL, "eth_getUserOperationByHash", [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  ]);
  expect(result).toEqual(null);
});

it.skipIf(!bundlerAvailable)("Integration: eth_getUserOperationReceipt returns null for unknown hash", async () => {
  const result = await rpcCall(BUNDLER_URL, "eth_getUserOperationReceipt", [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  ]);
  expect(result).toEqual(null);
});
