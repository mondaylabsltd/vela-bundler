/**
 * Tests for shared/reliability/errors.ts — structured error classification.
 * Verifies classification is driven by STRUCTURED signals (status / code / abort),
 * not free text, and that the transient/permanent/poison split is correct.
 */

import { it, expect } from "vitest";
import {
  classifyError,
  classifyHttpStatus,
  getClassification,
  parseRetryAfter,
  PoisonError,
  CircuitOpenError,
  DeadlineExceededError,
} from "../shared/reliability/errors.ts";
import { redactError } from "../shared/reliability/log.ts";

// --- redactError (O-15: don't leak the Alchemy key via a viem error message) ---

it("redactError - strips the API key from an Alchemy URL in an error message", () => {
  const err = new Error("HTTP request failed. URL: https://eth-mainnet.g.alchemy.com/v2/SECRETKEY1234567890abcdef");
  const out = redactError(err);
  expect(!out.includes("SECRETKEY1234567890abcdef"), `key leaked: ${out}`).toBeTruthy();
  expect(out.includes("eth-mainnet.g.alchemy.com"), "host should be kept for debuggability").toBeTruthy();
});

it("redactError - redacts a query-string key and handles non-Error input", () => {
  const out = redactError(new Error("failed calling https://rpc.example.com/?apikey=topsecretvalue now"));
  expect(!out.includes("topsecretvalue"), `query key leaked: ${out}`).toBeTruthy();
  expect(typeof redactError("plain string, no url")).toEqual("string");
});

it("redactError - strips a Telegram bot token from a fetch error (O-15 / monitoring leak)", () => {
  // The Telegram sendMessage URL embeds the bot token as a path segment.
  const err = new Error("error sending request for url (https://api.telegram.org/bot7654321:AAExampleBotTokenValue/sendMessage): connection refused");
  const out = redactError(err);
  expect(!out.includes("7654321:AAExampleBotTokenValue"), `bot token leaked: ${out}`).toBeTruthy();
  expect(out.includes("api.telegram.org"), "host kept for debuggability").toBeTruthy();
});

it("classifyHttpStatus - 429 is transient + rate-limited reason", () => {
  const c = classifyHttpStatus(429);
  expect(c.category).toEqual("transient");
  expect(c.retryable).toEqual(true);
  expect(c.reason).toEqual("http_429_rate_limited");
});

it("classifyHttpStatus - 408/425/500/502/503/504 are transient", () => {
  for (const s of [408, 425, 500, 502, 503, 504]) {
    const c = classifyHttpStatus(s);
    expect(c.category, `status ${s}`).toEqual("transient");
    expect(c.retryable, `status ${s}`).toEqual(true);
  }
});

it("classifyHttpStatus - 400/401/403/404/422/501 are permanent (not retried)", () => {
  for (const s of [400, 401, 403, 404, 422, 501]) {
    const c = classifyHttpStatus(s);
    expect(c.category, `status ${s}`).toEqual("permanent");
    expect(c.retryable, `status ${s}`).toEqual(false);
  }
});

it("classifyHttpStatus - 2xx/3xx are never transient (200 not retried)", () => {
  for (const s of [200, 201, 204, 301, 302]) {
    const c = classifyHttpStatus(s);
    expect(c.retryable, `status ${s}`).toEqual(false);
    expect(c.category, `status ${s}`).toEqual("permanent");
  }
});

it("classifyHttpStatus - 429 Retry-After (seconds) parsed into floor", () => {
  const c = classifyHttpStatus(429, "2");
  expect(c.retryAfterMs).toEqual(2000);
});

it("parseRetryAfter - seconds and HTTP-date", () => {
  expect(parseRetryAfter("5")).toEqual(5000);
  expect(parseRetryAfter(null)).toEqual(undefined);
  expect(parseRetryAfter("not-a-date")).toEqual(undefined);
  // HTTP-date 10s in the future relative to a fixed now
  const now = 1_000_000_000_000;
  const future = new Date(now + 10_000).toUTCString();
  const ms = parseRetryAfter(future, now)!;
  // toUTCString truncates to whole seconds, so allow a 1s slack
  expect(ms >= 9000 && ms <= 10000).toEqual(true);
});

it("classifyError - AbortError / timeout is transient", () => {
  const abort = Object.assign(new Error("The signal has been aborted"), { name: "AbortError" });
  expect(classifyError(abort).category).toEqual("transient");
  const timeout = Object.assign(new Error("request timed out after 5000ms"), { name: "TimeoutError" });
  const c = classifyError(timeout);
  expect(c.category).toEqual("transient");
  expect(c.reason).toEqual("timeout");
});

it("classifyError - transient socket codes", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]) {
    const err = Object.assign(new Error("socket error"), { code });
    expect(classifyError(err).category, code).toEqual("transient");
  }
});

it("classifyError - permanent JSON-RPC codes are not retryable", () => {
  for (const code of [-32600, -32601, -32602, -32700]) {
    const err = Object.assign(new Error("bad request"), { code });
    const c = classifyError(err);
    expect(c.category, `code ${code}`).toEqual("permanent");
    expect(c.retryable, `code ${code}`).toEqual(false);
  }
});

it("classifyError - server JSON-RPC codes (-32000..-32099) are transient", () => {
  const err = Object.assign(new Error("server overloaded"), { code: -32005 });
  expect(classifyError(err).category).toEqual("transient");
});

it("classifyError - HTTP status on a nested cause is found", () => {
  const inner = Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "3" }) });
  const outer = Object.assign(new Error("request failed"), { cause: inner });
  const c = classifyError(outer);
  expect(c.category).toEqual("transient");
  expect(c.httpStatus).toEqual(429);
  expect(c.retryAfterMs).toEqual(3000);
});

it("classifyError - unrecognised error defaults to permanent (no blind retry)", () => {
  const c = classifyError(new Error("something weird and specific"));
  expect(c.category).toEqual("permanent");
  expect(c.retryable).toEqual(false);
  expect(c.reason).toEqual("unclassified");
});

it("classifyError - text fallback recognises obvious transient phrases", () => {
  const c = classifyError(new Error("fetch failed: connection reset by peer"));
  expect(c.category).toEqual("transient");
});

it("getClassification - honours attached classification (Poison/Circuit/Deadline)", () => {
  expect(getClassification(new PoisonError("missing_field")).category).toEqual("poison");
  const co = getClassification(new CircuitOpenError("https://x.example"));
  expect(co.reason).toEqual("circuit_open");
  expect(co.retryable).toEqual(false); // open circuit must not be retried in-line
  expect(getClassification(new DeadlineExceededError()).reason).toEqual("deadline_exceeded");
});

it("classifyError - never leaks an over-long raw message (truncated detail)", () => {
  const big = "x".repeat(5000);
  const c = classifyError(new Error(big));
  expect((c.detail ?? "").length <= 201).toEqual(true);
});
