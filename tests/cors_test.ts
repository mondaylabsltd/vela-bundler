/**
 * Regression tests for the site-wide CORS policy.
 *
 * INCIDENT: the wallet started sending an `Idempotency-Key` request header; the preflight's
 * hand-maintained Access-Control-Allow-Headers list didn't include it, so the browser
 * blocked POST /v1/sponsor. The fix is a permissive, centralized policy (Allow-Headers: *)
 * so any new client header works without editing a list. These tests lock that in.
 */

import { assertEquals, assert } from "@std/assert";
import { CORS_HEADERS, corsPreflight } from "../shared/rpc/cors.ts";
import { handleRestApi } from "../shared/rpc/rest-api.ts";
import type { RateLimitConfig } from "../shared/auth/index.ts";

Deno.test("CORS_HEADERS - fully permissive (origin *, headers *, methods, max-age)", () => {
  assertEquals(CORS_HEADERS["Access-Control-Allow-Origin"], "*");
  assertEquals(CORS_HEADERS["Access-Control-Allow-Headers"], "*");
  assert(CORS_HEADERS["Access-Control-Allow-Methods"].includes("POST"));
  assert(CORS_HEADERS["Access-Control-Allow-Methods"].includes("OPTIONS"));
  assert(Number(CORS_HEADERS["Access-Control-Max-Age"]) > 0, "preflight should be cacheable");
});

Deno.test("corsPreflight - 204 with permissive headers", () => {
  const res = corsPreflight();
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Access-Control-Allow-Headers"), "*");
});

Deno.test("handleRestApi - OPTIONS preflight for /v1/sponsor allows an arbitrary header (Idempotency-Key)", async () => {
  // Mirrors the browser preflight that was being blocked. The registry is never touched on
  // the OPTIONS path, so a stub is fine.
  const stubRegistry = { getChain: () => Promise.reject(new Error("unused")), getAll: () => [] };
  const rl: RateLimitConfig = { rateLimitPerMinute: 60 };
  const url = new URL("http://localhost/v1/sponsor/56/0x14fb1fb21751e29f7ec48dc450017552e3d1ea5c");
  const req = new Request(url, {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "idempotency-key, content-type",
      origin: "http://localhost:8081",
    },
  });

  const res = await handleRestApi(
    req, url,
    // deno-lint-ignore no-explicit-any
    stubRegistry as any,
    // deno-lint-ignore no-explicit-any
    {} as any,
    rl,
  );
  assert(res !== null, "OPTIONS on /v1/ must be handled");
  assertEquals(res!.status, 204);
  // `*` allows the idempotency-key header (and any future header) without a list edit.
  assertEquals(res!.headers.get("Access-Control-Allow-Headers"), "*");
  assertEquals(res!.headers.get("Access-Control-Allow-Origin"), "*");
});
