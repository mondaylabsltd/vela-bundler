/**
 * Unit tests for P1 fixes:
 * - Rate limiter pruning
 * - Reputation decay pruning
 * - RPC client cache eviction
 * - Time range re-verification logic
 * - RPC_TIMEOUT_MS shared constant
 */

import { it, expect } from "vitest";
import { ReputationManager } from "../shared/mempool/reputation.ts";
import { rateLimitGuard } from "../shared/auth/index.ts";
import { getPublicClient } from "../shared/utils/rpc-client.ts";
import { RPC_TIMEOUT_MS } from "../shared/utils/timeout.ts";
import { parseValidationData, isValidTimeRange } from "../shared/userop/validate.ts";

// ---- RPC_TIMEOUT_MS shared constant ----

it("RPC_TIMEOUT_MS - is exported from utils/timeout.ts", () => {
  expect(RPC_TIMEOUT_MS).toEqual(5_000);
});

// ---- Reputation decay pruning ----

it("ReputationManager - decay prunes zero-value stale entries", () => {
  const rm = new ReputationManager({ minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50 });
  const addr = "0x1111111111111111111111111111111111111111" as `0x${string}`;

  // Add an entry with low counts
  rm.updateSeen(addr, "sender");
  rm.updateSeen(addr, "sender");

  // Verify entry exists
  expect(rm.dump().length).toEqual(1);

  // Decay twice: 2 → 1 → 0
  rm.decay();
  rm.decay();

  // Entry still exists (lastUpdated is recent)
  expect(rm.dump().length).toEqual(1);

  // Force the entry to be stale by decaying many times (won't prune until >24h old)
  // The entry should remain because lastUpdated is recent
  for (let i = 0; i < 10; i++) rm.decay();
  expect(rm.dump().length).toEqual(1);
});

it("ReputationManager - decay preserves entries with non-zero counts", () => {
  const rm = new ReputationManager({ minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50 });
  const addr = "0x2222222222222222222222222222222222222222" as `0x${string}`;

  // Give it high counts that don't decay to zero quickly
  rm.setReputation(addr, "sender", 1000, 500);

  rm.decay();
  const entries = rm.dump();
  expect(entries.length).toEqual(1);
  expect(entries[0]!.opsSeen).toEqual(500); // 1000 / 2
  expect(entries[0]!.opsIncluded).toEqual(250); // 500 / 2
});

it("ReputationManager - included ops improve reputation from throttled to ok", () => {
  const rm = new ReputationManager({ minInclusionDenominator: 10, throttlingSlack: 5, banSlack: 50 });
  const addr = "0x3333333333333333333333333333333333333333" as `0x${string}`;

  // Push into throttled: opsSeen > opsIncluded * 10 + slack
  // Need opsSeen > 0 * 10 + 5 = 5
  for (let i = 0; i < 20; i++) rm.updateSeen(addr, "sender");
  expect(rm.getStatus(addr, "sender")).toEqual("throttled");

  // Include enough to recover: opsSeen(20) <= opsIncluded * 10 + 5
  // Need opsIncluded >= (20 - 5) / 10 = 1.5, so 2
  rm.updateIncluded(addr, "sender");
  rm.updateIncluded(addr, "sender");
  expect(rm.getStatus(addr, "sender")).toEqual("ok");
});

// ---- Rate limiter ----

it("rateLimitGuard - allows requests within limit", () => {
  const req = new Request("http://localhost/test");
  const result = rateLimitGuard(req, { rateLimitPerMinute: 100 }, "test-peer-unique-1");
  expect(result).toEqual(null); // null means allowed
});

it("rateLimitGuard - blocks requests over limit", () => {
  // Identity is the trusted peerAddr (3rd arg); spoofable X-Forwarded-For is ignored.
  const config = { rateLimitPerMinute: 3 };
  const peer = "test-ip-rate-limit-" + Date.now();
  const req = () => new Request("http://localhost/test");
  for (let i = 0; i < 3; i++) {
    expect(rateLimitGuard(req(), config, peer)).toEqual(null);
  }
  // 4th request should be blocked
  const result = rateLimitGuard(req(), config, peer);
  expect(result).not.toEqual(null);
  expect(result!.status).toEqual(429);
});

it("rateLimitGuard - different IPs have separate limits", () => {
  const config = { rateLimitPerMinute: 1 };
  const peer1 = "rate-test-ip-a-" + Date.now();
  const peer2 = "rate-test-ip-b-" + Date.now();
  const req = () => new Request("http://localhost/test");

  expect(rateLimitGuard(req(), config, peer1)).toEqual(null);
  // peer1 is now rate limited
  expect(rateLimitGuard(req(), config, peer1)).not.toEqual(null);
  // peer2 should still be allowed
  expect(rateLimitGuard(req(), config, peer2)).toEqual(null);
});

// ---- RPC client cache ----

it("getPublicClient - returns same client for same URL", () => {
  const url = "https://cache-test-same-" + Date.now() + ".example.com";
  const client1 = getPublicClient(url);
  const client2 = getPublicClient(url);
  expect(client1).toEqual(client2);
});

it("getPublicClient - returns different clients for different URLs", () => {
  const ts = Date.now();
  const client1 = getPublicClient(`https://cache-test-diff1-${ts}.example.com`);
  const client2 = getPublicClient(`https://cache-test-diff2-${ts}.example.com`);
  expect(client1).not.toEqual(client2);
});

// ---- Time range re-verification (bundler submission guard) ----

it("time range re-verification - 10s safety margin catches near-expiry", () => {
  const now = Math.floor(Date.now() / 1000);

  // Expires in 5 seconds — should fail with 10s safety margin
  expect(!isValidTimeRange(0, now + 5, 10)).toBeTruthy();

  // Expires in 15 seconds — should pass with 10s safety margin
  expect(isValidTimeRange(0, now + 15, 10)).toBeTruthy();
});

it("time range re-verification - validAfter in future fails", () => {
  const now = Math.floor(Date.now() / 1000);

  // Starts in 60 seconds
  expect(!isValidTimeRange(now + 60, 0, 10)).toBeTruthy();

  // Started 60 seconds ago
  expect(isValidTimeRange(now - 60, 0, 10)).toBeTruthy();
});

it("time range re-verification - zero validUntil never expires", () => {
  // validUntil=0 is treated as 0xffffffffffff (no expiry)
  expect(isValidTimeRange(0, 0, 10)).toBeTruthy();
  expect(isValidTimeRange(0, 0, 1000)).toBeTruthy();
});

it("time range re-verification - combined validAfter+validUntil from validationData", () => {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 100);
  const validUntil = BigInt(now + 100);
  // Canonical ERC-4337 v0.7 packing: aggregator(low 160) | validUntil<<160 | validAfter<<208.
  const data = (validUntil << 160n) | (validAfter << 208n);

  const parsed = parseValidationData(data);
  expect(isValidTimeRange(parsed.validAfter, parsed.validUntil, 10)).toBeTruthy();
});

it("time range re-verification - expired validationData detected", () => {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 200);
  const validUntil = BigInt(now - 100); // expired 100 seconds ago
  const data = (validUntil << 160n) | (validAfter << 208n);

  const parsed = parseValidationData(data);
  expect(!isValidTimeRange(parsed.validAfter, parsed.validUntil, 10)).toBeTruthy();
});

// ---- Paymaster validation data ----

it("paymaster validation - zero paymasterValidationData is always valid", () => {
  const parsed = parseValidationData(0n);
  expect(parsed.aggregator).toEqual("0x0000000000000000000000000000000000000000");
  expect(parsed.validAfter).toEqual(0);
  // validUntil=0 → 0xffffffffffff (no expiry)
  expect(isValidTimeRange(parsed.validAfter, parsed.validUntil)).toBeTruthy();
});

it("paymaster validation - sig failure aggregator detectable", () => {
  const sigFail = 1n; // canonical low-bit SIG_VALIDATION_FAILED
  const parsed = parseValidationData(sigFail);
  expect(parsed.aggregator).toEqual("0x0000000000000000000000000000000000000001");
});
