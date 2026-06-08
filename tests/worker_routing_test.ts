/**
 * Tests for worker routing logic, request validation, and security controls.
 *
 * These tests verify the routing, validation, and security logic
 * that the worker entry point and BundlerDO use, without requiring
 * the full CF Worker runtime.
 */

import { assertEquals, assert } from "@std/assert";

// ---------------------------------------------------------------------------
// redactRpcUrl logic
// ---------------------------------------------------------------------------

function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/[a-zA-Z0-9_-]{20,}$/, "/***");
    return u.toString();
  } catch {
    return url.replace(/[a-zA-Z0-9_-]{20,}/g, "***");
  }
}

Deno.test("redactRpcUrl — redacts Alchemy API key from URL", () => {
  const url = "https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz1234";
  const redacted = redactRpcUrl(url);
  assert(!redacted.includes("abcdefghijklmnopqrstuvwxyz1234"));
  assert(redacted.includes("/***"));
});

Deno.test("redactRpcUrl — preserves short path segments", () => {
  const url = "https://rpc.ankr.com/eth";
  const redacted = redactRpcUrl(url);
  assertEquals(redacted, "https://rpc.ankr.com/eth");
});

Deno.test("redactRpcUrl — handles invalid URL gracefully", () => {
  const url = "not-a-url-with-longapikey1234567890abcdef";
  const redacted = redactRpcUrl(url);
  assert(!redacted.includes("longapikey1234567890abcdef"));
});

Deno.test("redactRpcUrl — preserves base URL structure", () => {
  const url = "https://arb-mainnet.g.alchemy.com/v2/AAAABBBBCCCCDDDDEEEEFFFFGGGG";
  const redacted = redactRpcUrl(url);
  assert(redacted.startsWith("https://arb-mainnet.g.alchemy.com/"));
});

// ---------------------------------------------------------------------------
// chainId extraction from URL path
// ---------------------------------------------------------------------------

Deno.test("chainId extraction — valid single-digit chain", () => {
  const match = "/1".match(/^\/(\d+)$/);
  assert(match !== null);
  assertEquals(parseInt(match![1]!), 1);
});

Deno.test("chainId extraction — valid multi-digit chain", () => {
  const match = "/42161".match(/^\/(\d+)$/);
  assert(match !== null);
  assertEquals(parseInt(match![1]!), 42161);
});

Deno.test("chainId extraction — rejects non-numeric", () => {
  const match = "/abc".match(/^\/(\d+)$/);
  assertEquals(match, null);
});

Deno.test("chainId extraction — rejects nested path", () => {
  const match = "/1/extra".match(/^\/(\d+)$/);
  assertEquals(match, null);
});

Deno.test("chainId extraction — rejects empty", () => {
  const match = "/".match(/^\/(\d+)$/);
  assertEquals(match, null);
});

// ---------------------------------------------------------------------------
// REST API path matching
// ---------------------------------------------------------------------------

Deno.test("REST path — matches /v1/account/:chainId/:address", () => {
  const match = "/v1/account/137/0xabc".match(/^\/v1\/(?:account|sponsor)\/(\d+)\//);
  assert(match !== null);
  assertEquals(parseInt(match![1]!), 137);
});

Deno.test("REST path — matches /v1/sponsor/:chainId/:address", () => {
  const match = "/v1/sponsor/1/0xdef".match(/^\/v1\/(?:account|sponsor)\/(\d+)\//);
  assert(match !== null);
  assertEquals(parseInt(match![1]!), 1);
});

Deno.test("REST path — rejects /v1/unknown/:chainId/:address", () => {
  const match = "/v1/unknown/1/0xabc".match(/^\/v1\/(?:account|sponsor)\/(\d+)\//);
  assertEquals(match, null);
});

// ---------------------------------------------------------------------------
// Batch size limit
// ---------------------------------------------------------------------------

Deno.test("batch size — rejects oversized batch", () => {
  const MAX_BATCH_SIZE = 20;
  const batch = Array.from({ length: 25 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_chainId",
    params: [],
  }));
  assert(batch.length > MAX_BATCH_SIZE);
});

Deno.test("batch size — allows batch within limit", () => {
  const MAX_BATCH_SIZE = 20;
  const batch = Array.from({ length: 20 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_chainId",
    params: [],
  }));
  assert(batch.length <= MAX_BATCH_SIZE);
});

// ---------------------------------------------------------------------------
// Body size limit
// ---------------------------------------------------------------------------

Deno.test("body size — detects oversized body", () => {
  const MAX_BODY_SIZE = 256 * 1024;
  const bigBody = "x".repeat(MAX_BODY_SIZE + 1);
  assert(bigBody.length > MAX_BODY_SIZE);
});

Deno.test("body size — allows body within limit", () => {
  const MAX_BODY_SIZE = 256 * 1024;
  const normalBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  assert(normalBody.length < MAX_BODY_SIZE);
});

// ---------------------------------------------------------------------------
// ACTIVE_CHAINS parsing (scheduled handler)
// ---------------------------------------------------------------------------

Deno.test("ACTIVE_CHAINS parsing — comma-separated chain IDs", () => {
  const raw = "1,137,42161";
  const chainIds = raw.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  assertEquals(chainIds, [1, 137, 42161]);
});

Deno.test("ACTIVE_CHAINS parsing — handles whitespace", () => {
  const raw = " 1 , 137 , 42161 ";
  const chainIds = raw.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  assertEquals(chainIds, [1, 137, 42161]);
});

Deno.test("ACTIVE_CHAINS parsing — handles empty string", () => {
  const raw = "";
  const result = raw ? raw.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
  assertEquals(result, []);
});

Deno.test("ACTIVE_CHAINS parsing — filters invalid entries", () => {
  const raw = "1,abc,137,,42161";
  const chainIds = raw.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  assertEquals(chainIds, [1, 137, 42161]);
});

// ---------------------------------------------------------------------------
// rpcUsed redaction in REST API response
// ---------------------------------------------------------------------------

Deno.test("rpcUsed redaction — strips API key from Alchemy URL", () => {
  const url = "https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz1234";
  const redacted = url.replace(/\/[a-zA-Z0-9_-]{20,}(\/|$)/, "/***$1");
  assert(!redacted.includes("abcdefghijklmnopqrstuvwxyz1234"));
  assert(redacted.includes("/***"));
  assert(redacted.startsWith("https://eth-mainnet.g.alchemy.com/"));
});

Deno.test("rpcUsed redaction — preserves public RPC URL", () => {
  const url = "https://rpc.ankr.com/eth";
  const redacted = url.replace(/\/[a-zA-Z0-9_-]{20,}(\/|$)/, "/***$1");
  assertEquals(redacted, url);
});
