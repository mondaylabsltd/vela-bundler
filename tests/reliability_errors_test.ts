/**
 * Tests for shared/reliability/errors.ts — structured error classification.
 * Verifies classification is driven by STRUCTURED signals (status / code / abort),
 * not free text, and that the transient/permanent/poison split is correct.
 */

import { assertEquals } from "@std/assert";
import {
  classifyError,
  classifyHttpStatus,
  getClassification,
  parseRetryAfter,
  PoisonError,
  CircuitOpenError,
  DeadlineExceededError,
} from "../shared/reliability/errors.ts";

Deno.test("classifyHttpStatus - 429 is transient + rate-limited reason", () => {
  const c = classifyHttpStatus(429);
  assertEquals(c.category, "transient");
  assertEquals(c.retryable, true);
  assertEquals(c.reason, "http_429_rate_limited");
});

Deno.test("classifyHttpStatus - 408/425/500/502/503/504 are transient", () => {
  for (const s of [408, 425, 500, 502, 503, 504]) {
    const c = classifyHttpStatus(s);
    assertEquals(c.category, "transient", `status ${s}`);
    assertEquals(c.retryable, true, `status ${s}`);
  }
});

Deno.test("classifyHttpStatus - 400/401/403/404/422/501 are permanent (not retried)", () => {
  for (const s of [400, 401, 403, 404, 422, 501]) {
    const c = classifyHttpStatus(s);
    assertEquals(c.category, "permanent", `status ${s}`);
    assertEquals(c.retryable, false, `status ${s}`);
  }
});

Deno.test("classifyHttpStatus - 2xx/3xx are never transient (200 not retried)", () => {
  for (const s of [200, 201, 204, 301, 302]) {
    const c = classifyHttpStatus(s);
    assertEquals(c.retryable, false, `status ${s}`);
    assertEquals(c.category, "permanent", `status ${s}`);
  }
});

Deno.test("classifyHttpStatus - 429 Retry-After (seconds) parsed into floor", () => {
  const c = classifyHttpStatus(429, "2");
  assertEquals(c.retryAfterMs, 2000);
});

Deno.test("parseRetryAfter - seconds and HTTP-date", () => {
  assertEquals(parseRetryAfter("5"), 5000);
  assertEquals(parseRetryAfter(null), undefined);
  assertEquals(parseRetryAfter("not-a-date"), undefined);
  // HTTP-date 10s in the future relative to a fixed now
  const now = 1_000_000_000_000;
  const future = new Date(now + 10_000).toUTCString();
  const ms = parseRetryAfter(future, now)!;
  // toUTCString truncates to whole seconds, so allow a 1s slack
  assertEquals(ms >= 9000 && ms <= 10000, true);
});

Deno.test("classifyError - AbortError / timeout is transient", () => {
  const abort = Object.assign(new Error("The signal has been aborted"), { name: "AbortError" });
  assertEquals(classifyError(abort).category, "transient");
  const timeout = Object.assign(new Error("request timed out after 5000ms"), { name: "TimeoutError" });
  const c = classifyError(timeout);
  assertEquals(c.category, "transient");
  assertEquals(c.reason, "timeout");
});

Deno.test("classifyError - transient socket codes", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]) {
    const err = Object.assign(new Error("socket error"), { code });
    assertEquals(classifyError(err).category, "transient", code);
  }
});

Deno.test("classifyError - permanent JSON-RPC codes are not retryable", () => {
  for (const code of [-32600, -32601, -32602, -32700]) {
    const err = Object.assign(new Error("bad request"), { code });
    const c = classifyError(err);
    assertEquals(c.category, "permanent", `code ${code}`);
    assertEquals(c.retryable, false, `code ${code}`);
  }
});

Deno.test("classifyError - server JSON-RPC codes (-32000..-32099) are transient", () => {
  const err = Object.assign(new Error("server overloaded"), { code: -32005 });
  assertEquals(classifyError(err).category, "transient");
});

Deno.test("classifyError - HTTP status on a nested cause is found", () => {
  const inner = Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "3" }) });
  const outer = Object.assign(new Error("request failed"), { cause: inner });
  const c = classifyError(outer);
  assertEquals(c.category, "transient");
  assertEquals(c.httpStatus, 429);
  assertEquals(c.retryAfterMs, 3000);
});

Deno.test("classifyError - unrecognised error defaults to permanent (no blind retry)", () => {
  const c = classifyError(new Error("something weird and specific"));
  assertEquals(c.category, "permanent");
  assertEquals(c.retryable, false);
  assertEquals(c.reason, "unclassified");
});

Deno.test("classifyError - text fallback recognises obvious transient phrases", () => {
  const c = classifyError(new Error("fetch failed: connection reset by peer"));
  assertEquals(c.category, "transient");
});

Deno.test("getClassification - honours attached classification (Poison/Circuit/Deadline)", () => {
  assertEquals(getClassification(new PoisonError("missing_field")).category, "poison");
  const co = getClassification(new CircuitOpenError("https://x.example"));
  assertEquals(co.reason, "circuit_open");
  assertEquals(co.retryable, false); // open circuit must not be retried in-line
  assertEquals(getClassification(new DeadlineExceededError()).reason, "deadline_exceeded");
});

Deno.test("classifyError - never leaks an over-long raw message (truncated detail)", () => {
  const big = "x".repeat(5000);
  const c = classifyError(new Error(big));
  assertEquals((c.detail ?? "").length <= 201, true);
});
