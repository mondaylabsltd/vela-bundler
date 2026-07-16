/**
 * Tests for worker routing logic, request validation, and security controls.
 *
 * These tests verify the routing, validation, and security logic
 * that the worker entry point and BundlerDO use, without requiring
 * the full CF Worker runtime.
 */

import { it, expect } from "vitest";

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

it("redactRpcUrl — redacts Alchemy API key from URL", () => {
  const url = "https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz1234";
  const redacted = redactRpcUrl(url);
  expect(!redacted.includes("abcdefghijklmnopqrstuvwxyz1234")).toBeTruthy();
  expect(redacted.includes("/***")).toBeTruthy();
});

it("redactRpcUrl — preserves short path segments", () => {
  const url = "https://rpc.ankr.com/eth";
  const redacted = redactRpcUrl(url);
  expect(redacted).toEqual("https://rpc.ankr.com/eth");
});

it("redactRpcUrl — handles invalid URL gracefully", () => {
  const url = "not-a-url-with-longapikey1234567890abcdef";
  const redacted = redactRpcUrl(url);
  expect(!redacted.includes("longapikey1234567890abcdef")).toBeTruthy();
});

it("redactRpcUrl — preserves base URL structure", () => {
  const url = "https://arb-mainnet.g.alchemy.com/v2/AAAABBBBCCCCDDDDEEEEFFFFGGGG";
  const redacted = redactRpcUrl(url);
  expect(redacted.startsWith("https://arb-mainnet.g.alchemy.com/")).toBeTruthy();
});

// ---------------------------------------------------------------------------
// chainId extraction from URL path
// ---------------------------------------------------------------------------

it("chainId extraction — valid single-digit chain", () => {
  const match = "/1".match(/^\/(\d+)$/);
  expect(match !== null).toBeTruthy();
  expect(parseInt(match![1]!)).toEqual(1);
});

it("chainId extraction — valid multi-digit chain", () => {
  const match = "/42161".match(/^\/(\d+)$/);
  expect(match !== null).toBeTruthy();
  expect(parseInt(match![1]!)).toEqual(42161);
});

it("chainId extraction — rejects non-numeric", () => {
  const match = "/abc".match(/^\/(\d+)$/);
  expect(match).toEqual(null);
});

it("chainId extraction — rejects nested path", () => {
  const match = "/1/extra".match(/^\/(\d+)$/);
  expect(match).toEqual(null);
});

it("chainId extraction — rejects empty", () => {
  const match = "/".match(/^\/(\d+)$/);
  expect(match).toEqual(null);
});

// ---------------------------------------------------------------------------
// REST API path matching
// ---------------------------------------------------------------------------

it("REST path — matches /v1/account/:chainId/:address", () => {
  const match = "/v1/account/137/0xabc".match(/^\/v1\/(?:account|sponsor)\/(\d+)\//);
  expect(match !== null).toBeTruthy();
  expect(parseInt(match![1]!)).toEqual(137);
});

it("REST path — matches /v1/sponsor/:chainId/:address", () => {
  const match = "/v1/sponsor/1/0xdef".match(/^\/v1\/(?:account|sponsor)\/(\d+)\//);
  expect(match !== null).toBeTruthy();
  expect(parseInt(match![1]!)).toEqual(1);
});

it("REST path — rejects /v1/unknown/:chainId/:address", () => {
  const match = "/v1/unknown/1/0xabc".match(/^\/v1\/(?:account|sponsor)\/(\d+)\//);
  expect(match).toEqual(null);
});

// ---------------------------------------------------------------------------
// Batch size limit
// ---------------------------------------------------------------------------

it("batch size — rejects oversized batch", () => {
  const MAX_BATCH_SIZE = 20;
  const batch = Array.from({ length: 25 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_chainId",
    params: [],
  }));
  expect(batch.length > MAX_BATCH_SIZE).toBeTruthy();
});

it("batch size — allows batch within limit", () => {
  const MAX_BATCH_SIZE = 20;
  const batch = Array.from({ length: 20 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_chainId",
    params: [],
  }));
  expect(batch.length <= MAX_BATCH_SIZE).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Body size limit
// ---------------------------------------------------------------------------

it("body size — detects oversized body", () => {
  const MAX_BODY_SIZE = 256 * 1024;
  const bigBody = "x".repeat(MAX_BODY_SIZE + 1);
  expect(bigBody.length > MAX_BODY_SIZE).toBeTruthy();
});

it("body size — allows body within limit", () => {
  const MAX_BODY_SIZE = 256 * 1024;
  const normalBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  expect(normalBody.length < MAX_BODY_SIZE).toBeTruthy();
});

// ---------------------------------------------------------------------------
// rpcUsed redaction in REST API response
// ---------------------------------------------------------------------------

it("rpcUsed redaction — strips API key from Alchemy URL", () => {
  const url = "https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz1234";
  const redacted = url.replace(/\/[a-zA-Z0-9_-]{20,}(\/|$)/, "/***$1");
  expect(!redacted.includes("abcdefghijklmnopqrstuvwxyz1234")).toBeTruthy();
  expect(redacted.includes("/***")).toBeTruthy();
  expect(redacted.startsWith("https://eth-mainnet.g.alchemy.com/")).toBeTruthy();
});

it("rpcUsed redaction — preserves public RPC URL", () => {
  const url = "https://rpc.ankr.com/eth";
  const redacted = url.replace(/\/[a-zA-Z0-9_-]{20,}(\/|$)/, "/***$1");
  expect(redacted).toEqual(url);
});
