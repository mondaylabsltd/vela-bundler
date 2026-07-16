/**
 * Tests for shared/reliability/rpc-fetch.ts — the unified outbound call wrapper.
 * Uses an injected fetchImpl + fake clock/sleep/rng + a fresh breaker, so the suite is
 * deterministic and hits zero real network/time.
 */

import { it, expect } from "vitest";
import { rpcCall, reliableTextFetch } from "../shared/reliability/rpc-fetch.ts";
import { CircuitBreaker } from "../shared/reliability/breaker.ts";
import { getClassification } from "../shared/reliability/errors.ts";

function fakeClock() {
  const s = { t: 0 };
  return { now: () => s.t, sleep: (ms: number) => { s.t += ms; return Promise.resolve(); }, get t() { return s.t; } };
}

function jsonRes(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

const URL_A = "https://rpc.example/v2/key";

it("rpcCall - retries a 503 then succeeds, returns parsed envelope", async () => {
  const clk = fakeClock();
  let n = 0;
  const fetchImpl = (() => {
    n++;
    if (n < 3) return Promise.resolve(jsonRes(503, "service unavailable"));
    return Promise.resolve(jsonRes(200, { jsonrpc: "2.0", id: 1, result: "0x1" }));
  }) as unknown as typeof fetch;
  const out = await rpcCall(URL_A, { method: "eth_chainId" }, {
    breaker: new CircuitBreaker({ now: clk.now }), now: clk.now, sleep: clk.sleep, rng: () => 0, fetchImpl, maxAttempts: 4,
  });
  expect(out.result).toEqual("0x1");
  expect(n).toEqual(3);
});

it("rpcCall - 429 with Retry-After backs off by the header value", async () => {
  const clk = fakeClock();
  let n = 0;
  const fetchImpl = (() => {
    n++;
    if (n === 1) return Promise.resolve(jsonRes(429, "slow down", { "retry-after": "2" }));
    return Promise.resolve(jsonRes(200, { result: "0x2" }));
  }) as unknown as typeof fetch;
  await rpcCall(URL_A, {}, {
    breaker: new CircuitBreaker({ now: clk.now }), now: clk.now, sleep: clk.sleep, rng: () => 0, fetchImpl, maxAttempts: 3,
    timeoutMs: 5000, deadlineMs: 60_000,
  });
  expect(clk.t).toEqual(2000); // honoured the 2s Retry-After despite rng=0
});

it("rpcCall - persistent transient (timeout) exhausts and throws classified transient", async () => {
  const clk = fakeClock();
  let n = 0;
  const fetchImpl = (() => { n++; return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }) as unknown as typeof fetch;
  const err = await rpcCall(URL_A, {}, {
    breaker: new CircuitBreaker({ failureThreshold: 99, now: clk.now }), now: clk.now, sleep: clk.sleep, rng: () => 0, fetchImpl,
    maxAttempts: 3, deadlineMs: 60_000,
  }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
  expect(n).toEqual(3);
  expect(getClassification(err).category).toEqual("transient");
});

it("rpcCall - non-retryable 4xx (400) is NOT retried; envelope error returned", async () => {
  // A 400 with a JSON-RPC error body: reliableTextFetch returns the 400 (permanent),
  // rpcCall parses the envelope and hands the business error back without retrying.
  const clk = fakeClock();
  let n = 0;
  const fetchImpl = (() => { n++; return Promise.resolve(jsonRes(400, { jsonrpc: "2.0", error: { code: -32602, message: "bad" } })); }) as unknown as typeof fetch;
  const out = await rpcCall(URL_A, {}, {
    breaker: new CircuitBreaker({ now: clk.now }), now: clk.now, sleep: clk.sleep, rng: () => 0, fetchImpl, maxAttempts: 5,
  });
  expect(n).toEqual(1); // no retry
  expect(out.error?.code).toEqual(-32602);
});

it("rpcCall - 200 carrying a JSON-RPC error (revert data) is NOT retried", async () => {
  // EVM revert lives in a 200 body's error.data — must be returned verbatim, never retried.
  const clk = fakeClock();
  let n = 0;
  const fetchImpl = (() => { n++; return Promise.resolve(jsonRes(200, { jsonrpc: "2.0", error: { code: 3, message: "execution reverted", data: "0xdeadbeef" } })); }) as unknown as typeof fetch;
  const out = await rpcCall(URL_A, {}, { breaker: new CircuitBreaker({ now: clk.now }), now: clk.now, sleep: clk.sleep, fetchImpl });
  expect(n).toEqual(1);
  expect(out.error?.data as string).toEqual("0xdeadbeef");
});

it("rpcCall - malformed JSON on a 200 is treated as transient (non_json_response)", async () => {
  const clk = fakeClock();
  const fetchImpl = (() => Promise.resolve(new Response("<html>502 from edge</html>", { status: 200, headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
  const err = await rpcCall(URL_A, {}, {
    breaker: new CircuitBreaker({ failureThreshold: 99, now: clk.now }), now: clk.now, sleep: clk.sleep, rng: () => 0, fetchImpl, maxAttempts: 2, deadlineMs: 60_000,
  }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
  expect(getClassification(err).reason).toEqual("non_json_response");
});

it("reliableTextFetch - permanent 404 is returned (not thrown) for the caller to interpret", async () => {
  const clk = fakeClock();
  let n = 0;
  const fetchImpl = (() => { n++; return Promise.resolve(jsonRes(404, "not found")); }) as unknown as typeof fetch;
  const res = await reliableTextFetch(URL_A, { method: "GET" }, {
    breaker: new CircuitBreaker({ now: clk.now }), now: clk.now, sleep: clk.sleep, fetchImpl, maxAttempts: 5, dependency: "chain-registry",
  });
  expect(res.status).toEqual(404);
  expect(n).toEqual(1); // a 404 is permanent — no retry
});

it("rpcCall - open circuit fast-fails subsequent calls without invoking fetch", async () => {
  const clk = fakeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clk.now });
  let n = 0;
  const downFetch = (() => { n++; return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }) as unknown as typeof fetch;
  // First call: 1 attempt fails → breaker opens (threshold 1). maxAttempts:1 so it doesn't loop.
  await expect(rpcCall(URL_A, {}, { breaker, now: clk.now, sleep: clk.sleep, fetchImpl: downFetch, maxAttempts: 1, deadlineMs: 60_000 })).rejects.toThrow();
  const callsAfterOpen = n;
  // Second call: circuit is open → must fast-fail WITHOUT calling fetch again.
  await expect(rpcCall(URL_A, {}, { breaker, now: clk.now, sleep: clk.sleep, fetchImpl: downFetch, maxAttempts: 1, deadlineMs: 60_000 })).rejects.toThrow();
  expect(n).toEqual(callsAfterOpen); // fetch not invoked while open
});

it("rpcCall - request 'timed out' but underlying succeeded → classified transient (safe to surface, caller decides)", async () => {
  // Models the 'timeout but provider actually succeeded' case at the transport layer:
  // we cannot know, so we surface a transient/retryable signal rather than a false failure.
  const clk = fakeClock();
  const fetchImpl = (() => Promise.reject(Object.assign(new Error("request timed out after 5000ms"), { name: "TimeoutError" }))) as unknown as typeof fetch;
  const err = await rpcCall(URL_A, {}, {
    breaker: new CircuitBreaker({ failureThreshold: 99, now: clk.now }), now: clk.now, sleep: clk.sleep, fetchImpl, maxAttempts: 1, deadlineMs: 60_000,
  }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
  const c = getClassification(err);
  expect(c.category).toEqual("transient");
  expect(c.reason === "timeout" || c.reason === "deadline_exceeded").toBeTruthy();
});
