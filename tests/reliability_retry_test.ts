/**
 * Tests for shared/reliability/retry.ts — unified retry + deadline.
 * Uses an injected fake clock/sleep/rng so the whole suite runs with ZERO real
 * wall-time and is fully deterministic.
 */

import { assertEquals, assert, assertRejects } from "@std/assert";
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

Deno.test("withRetry - succeeds on the 3rd attempt after 2 transient failures", async () => {
  const clk = fakeClock();
  let calls = 0;
  const result = await withRetry(async (attempt) => {
    calls = attempt;
    if (attempt < 3) throw transient();
    return "ok";
  }, { maxAttempts: 5, now: clk.now, sleep: clk.sleep, rng: () => 0 });
  assertEquals(result, "ok");
  assertEquals(calls, 3);
});

Deno.test("withRetry - exhausts after maxAttempts on persistent transient failure", async () => {
  const clk = fakeClock();
  let calls = 0;
  await assertRejects(
    () => withRetry(async () => { calls++; throw transient(); },
      { maxAttempts: 3, now: clk.now, sleep: clk.sleep, rng: () => 0 }),
    Error,
  );
  assertEquals(calls, 3); // exactly maxAttempts, no more
});

Deno.test("withRetry - never retries a permanent (non-retryable) error", async () => {
  const clk = fakeClock();
  let calls = 0;
  await assertRejects(
    () => withRetry(async () => { calls++; throw permanent(); },
      { maxAttempts: 5, now: clk.now, sleep: clk.sleep, rng: () => 0 }),
    Error,
  );
  assertEquals(calls, 1); // bailed immediately
});

Deno.test("withRetry - total deadline budget stops retries early", async () => {
  const clk = fakeClock();
  let calls = 0;
  // base 1000ms, rng=1 → each backoff ≈ cap; deadline 1500ms → only ~1 sleep fits.
  await assertRejects(
    () => withRetry(async () => { calls++; throw transient(); }, {
      maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 1000,
      deadlineMs: 1500, now: clk.now, sleep: clk.sleep, rng: () => 1,
    }),
    DeadlineExceededError,
  );
  // 1st call fails → sleep ~1000 (fits, t=1000) → 2nd call fails → next sleep 1000 >
  // remaining 500 → DeadlineExceededError. So 2 calls.
  assertEquals(calls, 2);
});

Deno.test("withRetry - honours Retry-After as a floor on the backoff delay", async () => {
  const clk = fakeClock();
  let calls = 0;
  const err = () => Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "2" }) });
  await withRetry(async (attempt) => {
    calls = attempt;
    if (attempt === 1) throw err();
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, now: clk.now, sleep: clk.sleep, rng: () => 0 });
  // rng=0 would give 0 delay, but Retry-After=2000ms is the floor.
  assertEquals(clk.t, 2000);
  assertEquals(calls, 2);
});

Deno.test("withRetry - full jitter keeps delay within [0, cap]", async () => {
  const clk = fakeClock();
  const delays: number[] = [];
  const prev = clk.t;
  await assertRejects(() => withRetry(async () => { throw transient(); }, {
    maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 800,
    now: clk.now, sleep: (ms) => { delays.push(ms); clk.advance(ms); return Promise.resolve(); },
    rng: () => 0.999999,
  }));
  // caps: attempt1 → 100, attempt2 → 200, attempt3 → 400 (all < maxDelay 800)
  assert(delays[0]! <= 100);
  assert(delays[1]! <= 200);
  assert(delays[2]! <= 400);
  void prev;
});

Deno.test("withRetry - external abort signal stops immediately", async () => {
  const clk = fakeClock();
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assertRejects(() => withRetry(async () => { calls++; return "x"; },
    { signal: ac.signal, now: clk.now, sleep: clk.sleep }));
  assertEquals(calls, 0);
});

Deno.test("createDeadline - remaining + expired track the injected clock", () => {
  const clk = fakeClock();
  const dl = createDeadline(1000, clk.now);
  assertEquals(dl.remainingMs(), 1000);
  assertEquals(dl.expired(), false);
  clk.advance(600);
  assertEquals(dl.remainingMs(), 400);
  clk.advance(500);
  assertEquals(dl.remainingMs(), 0);
  assertEquals(dl.expired(), true);
});
