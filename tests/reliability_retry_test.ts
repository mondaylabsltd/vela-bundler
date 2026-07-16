/**
 * Tests for shared/reliability/retry.ts — unified retry + deadline.
 * Uses an injected fake clock/sleep/rng so the whole suite runs with ZERO real
 * wall-time and is fully deterministic.
 */

import { it, expect } from "vitest";
import { withRetry, createDeadline } from "../shared/reliability/retry.ts";
import { DeadlineExceededError } from "../shared/reliability/errors.ts";

/** Virtual clock: sleep advances time, so deadlines fire deterministically. */
function fakeClock() {
  const state = { t: 0 };
  return {
    now: () => state.t,
    sleep: (ms: number) => { state.t += ms; return Promise.resolve(); },
    advance: (ms: number) => { state.t += ms; },
    get t() { return state.t; },
  };
}

const transient = (msg = "ETIMEDOUT") => Object.assign(new Error(msg), { code: "ETIMEDOUT" });
const permanent = () => Object.assign(new Error("bad params"), { code: -32602 });

it("withRetry - succeeds on the 3rd attempt after 2 transient failures", async () => {
  const clk = fakeClock();
  let calls = 0;
  const result = await withRetry(async (attempt) => {
    calls = attempt;
    if (attempt < 3) throw transient();
    return "ok";
  }, { maxAttempts: 5, now: clk.now, sleep: clk.sleep, rng: () => 0 });
  expect(result).toEqual("ok");
  expect(calls).toEqual(3);
});

it("withRetry - exhausts after maxAttempts on persistent transient failure", async () => {
  const clk = fakeClock();
  let calls = 0;
  await expect(
    withRetry(async () => { calls++; throw transient(); },
      { maxAttempts: 3, now: clk.now, sleep: clk.sleep, rng: () => 0 }),
  ).rejects.toThrow();
  expect(calls).toEqual(3); // exactly maxAttempts, no more
});

it("withRetry - never retries a permanent (non-retryable) error", async () => {
  const clk = fakeClock();
  let calls = 0;
  await expect(
    withRetry(async () => { calls++; throw permanent(); },
      { maxAttempts: 5, now: clk.now, sleep: clk.sleep, rng: () => 0 }),
  ).rejects.toThrow();
  expect(calls).toEqual(1); // bailed immediately
});

it("withRetry - total deadline budget stops retries early", async () => {
  const clk = fakeClock();
  let calls = 0;
  // base 1000ms, rng=1 → each backoff ≈ cap; deadline 1500ms → only ~1 sleep fits.
  await expect(
    withRetry(async () => { calls++; throw transient(); }, {
      maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 1000,
      deadlineMs: 1500, now: clk.now, sleep: clk.sleep, rng: () => 1,
    }),
  ).rejects.toThrow(DeadlineExceededError);
  // 1st call fails → sleep ~1000 (fits, t=1000) → 2nd call fails → next sleep 1000 >
  // remaining 500 → DeadlineExceededError. So 2 calls.
  expect(calls).toEqual(2);
});

it("withRetry - honours Retry-After as a floor on the backoff delay", async () => {
  const clk = fakeClock();
  let calls = 0;
  const err = () => Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "2" }) });
  await withRetry(async (attempt) => {
    calls = attempt;
    if (attempt === 1) throw err();
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, now: clk.now, sleep: clk.sleep, rng: () => 0 });
  // rng=0 would give 0 delay, but Retry-After=2000ms is the floor.
  expect(clk.t).toEqual(2000);
  expect(calls).toEqual(2);
});

it("withRetry - full jitter keeps delay within [0, cap]", async () => {
  const clk = fakeClock();
  const delays: number[] = [];
  const prev = clk.t;
  await expect(withRetry(async () => { throw transient(); }, {
    maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 800,
    now: clk.now, sleep: (ms) => { delays.push(ms); clk.advance(ms); return Promise.resolve(); },
    rng: () => 0.999999,
  })).rejects.toThrow();
  // caps: attempt1 → 100, attempt2 → 200, attempt3 → 400 (all < maxDelay 800)
  expect(delays[0]! <= 100).toBeTruthy();
  expect(delays[1]! <= 200).toBeTruthy();
  expect(delays[2]! <= 400).toBeTruthy();
  void prev;
});

it("withRetry - external abort signal stops immediately", async () => {
  const clk = fakeClock();
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await expect(withRetry(async () => { calls++; return "x"; },
    { signal: ac.signal, now: clk.now, sleep: clk.sleep })).rejects.toThrow();
  expect(calls).toEqual(0);
});

it("createDeadline - remaining + expired track the injected clock", () => {
  const clk = fakeClock();
  const dl = createDeadline(1000, clk.now);
  expect(dl.remainingMs()).toEqual(1000);
  expect(dl.expired()).toEqual(false);
  clk.advance(600);
  expect(dl.remainingMs()).toEqual(400);
  clk.advance(500);
  expect(dl.remainingMs()).toEqual(0);
  expect(dl.expired()).toEqual(true);
});
