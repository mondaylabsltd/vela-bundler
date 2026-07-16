/**
 * Tests for the SERVICE_DEGRADED (-32000) error semantics: transient infrastructure
 * failures must be distinguishable (stable code + retryable hint) from permanent business
 * rejections, instead of being masked as INVALID_USEROPERATION.
 */

import { it, expect } from "vitest";
import { serviceDegraded, bundlerError } from "../shared/rpc/errors.ts";
import { RPC_ERROR_CODES } from "../shared/contracts/entrypoint.ts";

it("serviceDegraded - uses the stable -32000 code with a retryable hint", () => {
  const e = serviceDegraded("balance check temporarily unavailable — please retry", { reason: "timeout", retryAfterMs: 2000 });
  expect(e.code).toEqual(-32000);
  expect(e.code).toEqual(RPC_ERROR_CODES.SERVICE_DEGRADED);
  const data = e.data as { retryable: boolean; retryAfterMs?: number; reason?: string };
  expect(data.retryable).toEqual(true);
  expect(data.retryAfterMs).toEqual(2000);
  expect(data.reason).toEqual("timeout");
});

it("serviceDegraded - distinct from the permanent business code", () => {
  const degraded = serviceDegraded("rpc down");
  const business = bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, "insufficient balance");
  // A transient infra failure and a permanent business rejection must NOT share a code,
  // so a client can decide retry-vs-surface from the code alone.
  expect(degraded.code === business.code).toEqual(false);
  expect(degraded.code).toEqual(-32000);
  expect(business.code).toEqual(-32602);
});

it("serviceDegraded - omits Retry-After when not provided", () => {
  const e = serviceDegraded("simulation temporarily unavailable");
  const data = e.data as { retryable: boolean; retryAfterMs?: number };
  expect(data.retryable).toEqual(true);
  expect(data.retryAfterMs).toEqual(undefined);
});
