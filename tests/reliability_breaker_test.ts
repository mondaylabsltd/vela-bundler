/**
 * Tests for shared/reliability/breaker.ts — circuit breaker open/half-open/closed
 * transitions with an injected clock (no real time).
 */

import { it, expect } from "vitest";
import { CircuitBreaker } from "../shared/reliability/breaker.ts";
import { CircuitOpenError } from "../shared/reliability/errors.ts";

function fakeClock() {
  const s = { t: 0 };
  return { now: () => s.t, advance: (ms: number) => { s.t += ms; }, get t() { return s.t; } };
}

const KEY = "https://rpc.example";

it("breaker - opens after N consecutive failures, then fast-fails", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clk.now });
  expect(b.state(KEY)).toEqual("closed");
  b.onFailure(KEY); b.onFailure(KEY);
  expect(b.state(KEY)).toEqual("closed"); // 2 < 3
  b.onFailure(KEY);
  expect(b.state(KEY)).toEqual("open");
  expect(b.allow(KEY)).toEqual(false); // fast-fail while open
});

it("breaker - a success resets the consecutive failure count", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clk.now });
  b.onFailure(KEY); b.onFailure(KEY);
  b.onSuccess(KEY);
  b.onFailure(KEY); b.onFailure(KEY);
  expect(b.state(KEY)).toEqual("closed"); // never reached 3 in a row
});

it("breaker - transitions open → half-open after cooldown, success closes", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: clk.now });
  b.onFailure(KEY); b.onFailure(KEY);
  expect(b.state(KEY)).toEqual("open");
  expect(b.allow(KEY)).toEqual(false);
  clk.advance(1000);
  expect(b.state(KEY)).toEqual("half-open");
  expect(b.allow(KEY)).toEqual(true);   // admits a probe
  expect(b.allow(KEY)).toEqual(false);  // only one probe at a time (halfOpenMaxProbes=1)
  b.onSuccess(KEY);
  expect(b.state(KEY)).toEqual("closed");
});

it("breaker - a half-open probe failure re-opens immediately", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: clk.now });
  b.onFailure(KEY); b.onFailure(KEY);
  clk.advance(1000);
  expect(b.state(KEY)).toEqual("half-open");
  b.allow(KEY);
  b.onFailure(KEY);
  expect(b.state(KEY)).toEqual("open");
  expect(b.allow(KEY)).toEqual(false);
});

it("breaker - guard() throws CircuitOpenError without invoking fn when open", async () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clk.now });
  // First call fails → opens.
  await expect(b.guard(KEY, () => Promise.reject(new Error("boom")))).rejects.toThrow();
  expect(b.state(KEY)).toEqual("open");
  let invoked = false;
  await expect(
    b.guard(KEY, () => { invoked = true; return Promise.resolve("x"); }),
  ).rejects.toThrow(CircuitOpenError);
  expect(invoked).toEqual(false); // fn never ran — fast fail
});

it("breaker - degradedCount + snapshot reflect non-closed endpoints", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clk.now });
  b.onFailure("https://a.example");
  b.onFailure("https://b.example");
  expect(b.degradedCount()).toEqual(2);
  const snap = b.snapshot();
  expect(snap.length).toEqual(2);
  expect(snap.every((s) => s.state === "open")).toEqual(true);
});
