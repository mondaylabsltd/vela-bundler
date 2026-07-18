/**
 * Tests for the money-path RPC failover (shared/utils/rpc-client.ts):
 *   - trustedMoneyPathRpcs: ordered, deduped, primary-first trusted set.
 *   - getFailoverPublicClient: a rate-limited (429) primary fails over to the next trusted RPC
 *     so a nonce/receipt read is served instead of stalling an accepted op at "submitted".
 *   - When the primary is healthy, the fallback URL is never touched (no gratuitous public-RPC use).
 *
 * viem's http transport calls the global fetch, so we stub globalThis.fetch and route by URL.
 */

import { it, expect, afterEach, vi } from "vitest";
import {
  trustedMoneyPathRpcs,
  getFailoverPublicClient,
} from "../shared/utils/rpc-client.ts";

const PRIMARY = "https://primary.example/v2/key";
const FALLBACK1 = "https://fallback-one.example/rpc";
const FALLBACK2 = "https://fallback-two.example/rpc";

function jsonRpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rateLimited(): Response {
  return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("trustedMoneyPathRpcs - primary first, then public RPCs, deduped, no empties", () => {
  expect(
    trustedMoneyPathRpcs({ rpcUrl: PRIMARY, publicRpcs: [FALLBACK1, PRIMARY, "", FALLBACK2, FALLBACK1] }),
  ).toEqual([PRIMARY, FALLBACK1, FALLBACK2]);

  // Single URL, no public list → just the primary.
  expect(trustedMoneyPathRpcs({ rpcUrl: PRIMARY })).toEqual([PRIMARY]);
});

it("getFailoverPublicClient - 429 on the primary fails over to the next trusted RPC", async () => {
  const calls: string[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url === PRIMARY) return rateLimited();
    if (url === FALLBACK1) return jsonRpcResult("0x2a"); // 42
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchStub as unknown as typeof fetch);

  // Distinct URL set so we don't collide with a cached client from another test.
  const client = getFailoverPublicClient([PRIMARY, FALLBACK1, FALLBACK2]);
  const block = await client.getBlockNumber();

  expect(block).toBe(42n);
  // Primary was tried (and rate-limited), then the first fallback served the read.
  expect(calls).toContain(PRIMARY);
  expect(calls).toContain(FALLBACK1);
});

it("getFailoverPublicClient - a healthy primary is used ALONE (fallbacks never touched)", async () => {
  const calls: string[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url === PRIMARY) return jsonRpcResult("0x63"); // 99
    return rateLimited();
  });
  vi.stubGlobal("fetch", fetchStub as unknown as typeof fetch);

  // A fresh URL set (distinct key) to avoid the module-level client cache from other tests.
  const client = getFailoverPublicClient([PRIMARY, "https://unused-a.example", "https://unused-b.example"]);
  const block = await client.getBlockNumber();

  expect(block).toBe(99n);
  expect(calls).toEqual([PRIMARY]); // no fallback URL was contacted
});
