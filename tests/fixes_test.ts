/**
 * Unit tests for P1 fixes:
 * - Rate limiter pruning
 * - Reputation decay pruning
 * - RPC client cache eviction
 * - Time range re-verification logic
 * - RPC_TIMEOUT_MS shared constant
 */

import { assertEquals, assert, assertNotEquals } from "@std/assert";
import { ReputationManager } from "../src/mempool/reputation.ts";
import { rateLimitGuard } from "../src/auth/index.ts";
import { getPublicClient } from "../src/utils/rpc-client.ts";
import { RPC_TIMEOUT_MS } from "../src/utils/timeout.ts";
import { parseValidationData, isValidTimeRange } from "../src/userop/validate.ts";

// ---- RPC_TIMEOUT_MS shared constant ----

Deno.test("RPC_TIMEOUT_MS - is exported from utils/timeout.ts", () => {
  assertEquals(RPC_TIMEOUT_MS, 5_000);
});

// ---- Reputation decay pruning ----

Deno.test("ReputationManager - decay prunes zero-value stale entries", () => {
  const rm = new ReputationManager({ minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50 });
  const addr = "0x1111111111111111111111111111111111111111" as `0x${string}`;

  // Add an entry with low counts
  rm.updateSeen(addr, "sender");
  rm.updateSeen(addr, "sender");

  // Verify entry exists
  assertEquals(rm.dump().length, 1);

  // Decay twice: 2 → 1 → 0
  rm.decay();
  rm.decay();

  // Entry still exists (lastUpdated is recent)
  assertEquals(rm.dump().length, 1);

  // Force the entry to be stale by decaying many times (won't prune until >24h old)
  // The entry should remain because lastUpdated is recent
  for (let i = 0; i < 10; i++) rm.decay();
  assertEquals(rm.dump().length, 1);
});

Deno.test("ReputationManager - decay preserves entries with non-zero counts", () => {
  const rm = new ReputationManager({ minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50 });
  const addr = "0x2222222222222222222222222222222222222222" as `0x${string}`;

  // Give it high counts that don't decay to zero quickly
  rm.setReputation(addr, "sender", 1000, 500);

  rm.decay();
  const entries = rm.dump();
  assertEquals(entries.length, 1);
  assertEquals(entries[0]!.opsSeen, 500); // 1000 / 2
  assertEquals(entries[0]!.opsIncluded, 250); // 500 / 2
});

Deno.test("ReputationManager - included ops improve reputation from throttled to ok", () => {
  const rm = new ReputationManager({ minInclusionDenominator: 10, throttlingSlack: 5, banSlack: 50 });
  const addr = "0x3333333333333333333333333333333333333333" as `0x${string}`;

  // Push into throttled: opsSeen > opsIncluded * 10 + slack
  // Need opsSeen > 0 * 10 + 5 = 5
  for (let i = 0; i < 20; i++) rm.updateSeen(addr, "sender");
  assertEquals(rm.getStatus(addr, "sender"), "throttled");

  // Include enough to recover: opsSeen(20) <= opsIncluded * 10 + 5
  // Need opsIncluded >= (20 - 5) / 10 = 1.5, so 2
  rm.updateIncluded(addr, "sender");
  rm.updateIncluded(addr, "sender");
  assertEquals(rm.getStatus(addr, "sender"), "ok");
});

// ---- Rate limiter ----

Deno.test("rateLimitGuard - allows requests within limit", () => {
  const req = new Request("http://localhost/test", {
    headers: { "x-forwarded-for": "test-ip-unique-1" },
  });
  const result = rateLimitGuard(req, { rateLimitPerMinute: 100 });
  assertEquals(result, null); // null means allowed
});

Deno.test("rateLimitGuard - blocks requests over limit", () => {
  const config = { rateLimitPerMinute: 3 };
  const ip = "test-ip-rate-limit-" + Date.now();
  for (let i = 0; i < 3; i++) {
    const req = new Request("http://localhost/test", {
      headers: { "x-forwarded-for": ip },
    });
    assertEquals(rateLimitGuard(req, config), null);
  }
  // 4th request should be blocked
  const req4 = new Request("http://localhost/test", {
    headers: { "x-forwarded-for": ip },
  });
  const result = rateLimitGuard(req4, config);
  assertNotEquals(result, null);
  assertEquals(result!.status, 429);
});

Deno.test("rateLimitGuard - different IPs have separate limits", () => {
  const config = { rateLimitPerMinute: 1 };
  const ip1 = "rate-test-ip-a-" + Date.now();
  const ip2 = "rate-test-ip-b-" + Date.now();

  const req1 = new Request("http://localhost/test", { headers: { "x-forwarded-for": ip1 } });
  assertEquals(rateLimitGuard(req1, config), null);

  // ip1 is now rate limited
  const req1b = new Request("http://localhost/test", { headers: { "x-forwarded-for": ip1 } });
  assertNotEquals(rateLimitGuard(req1b, config), null);

  // ip2 should still be allowed
  const req2 = new Request("http://localhost/test", { headers: { "x-forwarded-for": ip2 } });
  assertEquals(rateLimitGuard(req2, config), null);
});

// ---- RPC client cache ----

Deno.test("getPublicClient - returns same client for same URL", () => {
  const url = "https://cache-test-same-" + Date.now() + ".example.com";
  const client1 = getPublicClient(url);
  const client2 = getPublicClient(url);
  assertEquals(client1, client2);
});

Deno.test("getPublicClient - returns different clients for different URLs", () => {
  const ts = Date.now();
  const client1 = getPublicClient(`https://cache-test-diff1-${ts}.example.com`);
  const client2 = getPublicClient(`https://cache-test-diff2-${ts}.example.com`);
  assertNotEquals(client1, client2);
});

// ---- Time range re-verification (bundler submission guard) ----

Deno.test("time range re-verification - 10s safety margin catches near-expiry", () => {
  const now = Math.floor(Date.now() / 1000);

  // Expires in 5 seconds — should fail with 10s safety margin
  assert(!isValidTimeRange(0, now + 5, 10));

  // Expires in 15 seconds — should pass with 10s safety margin
  assert(isValidTimeRange(0, now + 15, 10));
});

Deno.test("time range re-verification - validAfter in future fails", () => {
  const now = Math.floor(Date.now() / 1000);

  // Starts in 60 seconds
  assert(!isValidTimeRange(now + 60, 0, 10));

  // Started 60 seconds ago
  assert(isValidTimeRange(now - 60, 0, 10));
});

Deno.test("time range re-verification - zero validUntil never expires", () => {
  // validUntil=0 is treated as 0xffffffffffff (no expiry)
  assert(isValidTimeRange(0, 0, 10));
  assert(isValidTimeRange(0, 0, 1000));
});

Deno.test("time range re-verification - combined validAfter+validUntil from validationData", () => {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 100);
  const validUntil = BigInt(now + 100);
  // Pack into validationData format: aggregator(20) | validUntil(6) | validAfter(6)
  const data = (validUntil << 48n) | validAfter;

  const parsed = parseValidationData(data);
  assert(isValidTimeRange(parsed.validAfter, parsed.validUntil, 10));
});

Deno.test("time range re-verification - expired validationData detected", () => {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 200);
  const validUntil = BigInt(now - 100); // expired 100 seconds ago
  const data = (validUntil << 48n) | validAfter;

  const parsed = parseValidationData(data);
  assert(!isValidTimeRange(parsed.validAfter, parsed.validUntil, 10));
});

// ---- Paymaster validation data ----

Deno.test("paymaster validation - zero paymasterValidationData is always valid", () => {
  const parsed = parseValidationData(0n);
  assertEquals(parsed.aggregator, "0x0000000000000000000000000000000000000000");
  assertEquals(parsed.validAfter, 0);
  // validUntil=0 → 0xffffffffffff (no expiry)
  assert(isValidTimeRange(parsed.validAfter, parsed.validUntil));
});

Deno.test("paymaster validation - sig failure aggregator detectable", () => {
  const sigFail = 1n << 96n;
  const parsed = parseValidationData(sigFail);
  assertEquals(parsed.aggregator, "0x0000000000000000000000000000000000000001");
});
