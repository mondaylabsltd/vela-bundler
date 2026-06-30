/**
 * Tests for the SERVICE_DEGRADED (-32000) error semantics: transient infrastructure
 * failures must be distinguishable (stable code + retryable hint) from permanent business
 * rejections, instead of being masked as INVALID_USEROPERATION.
 */

import { assertEquals } from "@std/assert";
import { serviceDegraded, bundlerError } from "../shared/rpc/errors.ts";
import { RPC_ERROR_CODES } from "../shared/contracts/entrypoint.ts";

Deno.test("serviceDegraded - uses the stable -32000 code with a retryable hint", () => {
  const e = serviceDegraded("balance check temporarily unavailable — please retry", { reason: "timeout", retryAfterMs: 2000 });
  assertEquals(e.code, -32000);
  assertEquals(e.code, RPC_ERROR_CODES.SERVICE_DEGRADED);
  const data = e.data as { retryable: boolean; retryAfterMs?: number; reason?: string };
  assertEquals(data.retryable, true);
  assertEquals(data.retryAfterMs, 2000);
  assertEquals(data.reason, "timeout");
});

Deno.test("serviceDegraded - distinct from the permanent business code", () => {
  const degraded = serviceDegraded("rpc down");
  const business = bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, "insufficient balance");
  // A transient infra failure and a permanent business rejection must NOT share a code,
  // so a client can decide retry-vs-surface from the code alone.
  assertEquals(degraded.code === business.code, false);
  assertEquals(degraded.code, -32000);
  assertEquals(business.code, -32602);
});

Deno.test("serviceDegraded - omits Retry-After when not provided", () => {
  const e = serviceDegraded("simulation temporarily unavailable");
  const data = e.data as { retryable: boolean; retryAfterMs?: number };
  assertEquals(data.retryable, true);
  assertEquals(data.retryAfterMs, undefined);
});
