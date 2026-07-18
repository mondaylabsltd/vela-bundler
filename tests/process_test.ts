/**
 * Tests for shared/rpc/process.ts — JSON-RPC request processing and response serialization.
 */

import { it, expect } from "vitest";
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
  rateLimitAllowlist: [],
  balanceReserveMultiplier: 1,
  alchemyApiKey: null,
  telegramBotToken: null,
  telegramChatId: null,
  treasuryAlertThresholdWei: 0n,
  treasuryAlertThresholdPathUsd: 0n,
};

const reqCtx: RequestContext = { chainId: 1 };

it("processRequest — rejects null body", async () => {
  const result = await processRequest(null, mockConfig, mockChainRegistry, reqCtx);
  expect(result.jsonrpc).toEqual("2.0");
  expect(result.error !== undefined).toBeTruthy();
  expect(result.error!.code).toEqual(-32600);
});

it("processRequest — rejects non-object body", async () => {
  const result = await processRequest("invalid", mockConfig, mockChainRegistry, reqCtx);
  expect(result.error !== undefined).toBeTruthy();
});

it("processRequest — rejects missing jsonrpc field", async () => {
  const result = await processRequest(
    { method: "eth_chainId", id: 1, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  expect(result.error !== undefined).toBeTruthy();
  expect(result.error!.message).toEqual("jsonrpc must be '2.0'");
});

it("processRequest — rejects non-string method", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: 123, id: 1 },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  expect(result.error !== undefined).toBeTruthy();
  expect(result.error!.message).toEqual("method must be a string");
});

it("processRequest — returns eth_supportedEntryPoints", async () => {
  // This method doesn't need chain services
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_supportedEntryPoints", id: 1, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  expect(result.jsonrpc).toEqual("2.0");
  expect(result.id).toEqual(1);
  expect(Array.isArray(result.result)).toBeTruthy();
  expect((result.result as string[])[0]).toEqual(mockConfig.entryPointAddress);
});

it("processRequest — returns eth_chainId", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_chainId", id: 2, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  expect(result.id).toEqual(2);
  expect(result.result).toEqual("0x1");
});

it("processRequest — returns error for unknown method", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_unknownMethod", id: 3, params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  expect(result.error !== undefined).toBeTruthy();
  expect(result.error!.code).toEqual(-32601); // Method not found
});

it("processRequest — preserves request id", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_chainId", id: "abc-123", params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  expect(result.id).toEqual("abc-123");
});

it("processRequest — null id when missing", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", method: "eth_chainId", params: [] },
    mockConfig,
    mockChainRegistry,
    reqCtx,
  );
  expect(result.id).toEqual(null);
});

// ---------------------------------------------------------------------------
// jsonResponse
// ---------------------------------------------------------------------------

it("jsonResponse — serializes bigint as hex", async () => {
  const res = jsonResponse({ value: 255n });
  const body = await res.json();
  expect(body.value).toEqual("0xff");
});

it("jsonResponse — preserves normal values", async () => {
  const res = jsonResponse({ str: "hello", num: 42, bool: true });
  const body = await res.json();
  expect(body.str).toEqual("hello");
  expect(body.num).toEqual(42);
  expect(body.bool).toEqual(true);
});

it("jsonResponse — includes extra headers", () => {
  const res = jsonResponse({}, { "X-Custom": "test" });
  expect(res.headers.get("X-Custom")).toEqual("test");
  expect(res.headers.get("Content-Type")).toEqual("application/json");
});

it("jsonResponse — status is 200", () => {
  const res = jsonResponse({});
  expect(res.status).toEqual(200);
});
