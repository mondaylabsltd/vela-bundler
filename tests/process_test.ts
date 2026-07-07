/**
 * Tests for shared/rpc/process.ts — JSON-RPC request processing and response serialization.
 */

import { assertEquals, assert } from "@std/assert";
import { processRequest, jsonResponse, type RequestContext } from "../shared/rpc/process.ts";

// Mock a minimal ChainRegistryLike
const mockChainRegistry = {
  async getChain(_chainId: number) {
    throw { code: -32602, message: "No chains in test" };
  },
  getAll() {
    return [];
  },
};

// Minimal config for testing
const mockConfig = {
  chainId: 1,
  rpcUrl: "https://rpc.test",
  publicRpcs: [],
  chainInfo: null,
  entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`,
  port: 3300,
  host: "0.0.0.0",
  bundlingMode: "auto" as const,
  maxBundleSize: 10,
  maxBundleGas: 5000000n,
  minPriorityFeePerGas: 0n,
  minProfitMarginBps: 1000,
  maxProfitMarginBps: 15000,
  walletGasMarkup: 1.5,
  useEip1559: true,
  baseFeeMultiplier: 1.25,
  bundlerTipGwei: 0.5,
  autoBundleIntervalMs: 10000,
  operatorSecret: "0x" + "ab".repeat(32),
  oldOperatorSecrets: [] as string[],
  treasuryAddress: "0x" + "00".repeat(20) as `0x${string}`,
  splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
  apiRateLimitPerMinute: 60,
  balanceReserveMultiplier: 1,
  alchemyApiKey: null,
};

const reqCtx: RequestContext = { chainId: 1 };

Deno.test("processRequest — rejects null body", async () => {
  const result = await processRequest(null, mockConfig, mockChainRegistry, reqCtx);
  assertEquals(result.jsonrpc, "2.0");
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32600);
});

Deno.test("processRequest — rejects non-object body", async () => {
  const result = await processRequest("invalid", mockConfig, mockChainRegistry, reqCtx);
  assert(result.error !== undefined);
});

Deno.test("processRequest — rejects missing jsonrpc field", async () => {
  const result = await processRequest(
    { method: "eth_chainId", id: 1, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.message, "jsonrpc must be '2.0'");
});

Deno.test("processRequest — rejects non-string method", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: 123, id: 1 },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.message, "method must be a string");
});

Deno.test("processRequest — returns eth_supportedEntryPoints", async () => {
  // This method doesn't need chain services
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_supportedEntryPoints", id: 1, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  assertEquals(result.jsonrpc, "2.0");
  assertEquals(result.id, 1);
  assert(Array.isArray(result.result));
  assertEquals((result.result as string[])[0], mockConfig.entryPointAddress);
});

Deno.test("processRequest — returns eth_chainId", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_chainId", id: 2, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  assertEquals(result.id, 2);
  assertEquals(result.result, "0x1");
});

Deno.test("processRequest — returns error for unknown method", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_unknownMethod", id: 3, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32601); // Method not found
});

Deno.test("processRequest — preserves request id", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_chainId", id: "abc-123", params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  assertEquals(result.id, "abc-123");
});

Deno.test("processRequest — null id when missing", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_chainId", params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  assertEquals(result.id, null);
});

// ---------------------------------------------------------------------------
// jsonResponse
// ---------------------------------------------------------------------------

Deno.test("jsonResponse — serializes bigint as hex", async () => {
  const res = jsonResponse({ value: 255n });
  const body = await res.json();
  assertEquals(body.value, "0xff");
});

Deno.test("jsonResponse — preserves normal values", async () => {
  const res = jsonResponse({ str: "hello", num: 42, bool: true });
  const body = await res.json();
  assertEquals(body.str, "hello");
  assertEquals(body.num, 42);
  assertEquals(body.bool, true);
});

Deno.test("jsonResponse — includes extra headers", () => {
  const res = jsonResponse({}, { "X-Custom": "test" });
  assertEquals(res.headers.get("X-Custom"), "test");
  assertEquals(res.headers.get("Content-Type"), "application/json");
});

Deno.test("jsonResponse — status is 200", () => {
  const res = jsonResponse({});
  assertEquals(res.status, 200);
});
