/**
 * Tests for shared/reliability/breaker.ts — circuit breaker open/half-open/closed
 * transitions with an injected clock (no real time).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { CircuitBreaker } from "../shared/reliability/breaker.ts";
import { CircuitOpenError } from "../shared/reliability/errors.ts";

function fakeClock() {
  const s = { t: 0 };
  return { now: () => s.t, advance: (ms: number) => { s.t += ms; }, get t() { return s.t; } };
}

const KEY = "https://rpc.example";

Deno.test("breaker - opens after N consecutive failures, then fast-fails", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clk.now });
  assertEquals(b.state(KEY), "closed");
  b.onFailure(KEY); b.onFailure(KEY);
  assertEquals(b.state(KEY), "closed"); // 2 < 3
  b.onFailure(KEY);
  assertEquals(b.state(KEY), "open");
  assertEquals(b.allow(KEY), false); // fast-fail while open
});

Deno.test("breaker - a success resets the consecutive failure count", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clk.now });
  b.onFailure(KEY); b.onFailure(KEY);
  b.onSuccess(KEY);
  b.onFailure(KEY); b.onFailure(KEY);
  assertEquals(b.state(KEY), "closed"); // never reached 3 in a row
});

Deno.test("breaker - transitions open → half-open after cooldown, success closes", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: clk.now });
  b.onFailure(KEY); b.onFailure(KEY);
  assertEquals(b.state(KEY), "open");
  assertEquals(b.allow(KEY), false);
  clk.advance(1000);
  assertEquals(b.state(KEY), "half-open");
  assertEquals(b.allow(KEY), true);   // admits a probe
  assertEquals(b.allow(KEY), false);  // only one probe at a time (halfOpenMaxProbes=1)
  b.onSuccess(KEY);
  assertEquals(b.state(KEY), "closed");
});

Deno.test("breaker - a half-open probe failure re-opens immediately", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: clk.now });
  b.onFailure(KEY); b.onFailure(KEY);
  clk.advance(1000);
  assertEquals(b.state(KEY), "half-open");
  b.allow(KEY);
  b.onFailure(KEY);
  assertEquals(b.state(KEY), "open");
  assertEquals(b.allow(KEY), false);
});

Deno.test("breaker - guard() throws CircuitOpenError without invoking fn when open", async () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clk.now });
  // First call fails → opens.
  await assertRejects(() => b.guard(KEY, () => Promise.reject(new Error("boom"))));
  assertEquals(b.state(KEY), "open");
  let invoked = false;
  await assertRejects(
    () => b.guard(KEY, () => { invoked = true; return Promise.resolve("x"); }),
    CircuitOpenError,
  );
  assertEquals(invoked, false); // fn never ran — fast fail
});

Deno.test("breaker - degradedCount + snapshot reflect non-closed endpoints", () => {
  const clk = fakeClock();
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clk.now });
  b.onFailure("https://a.example");
  b.onFailure("https://b.example");
  assertEquals(b.degradedCount(), 2);
  const snap = b.snapshot();
  assertEquals(snap.length, 2);
  assertEquals(snap.every((s) => s.state === "open"), true);
});
