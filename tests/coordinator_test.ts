/**
 * Unit coverage for the dynamic-lease coordinator decision core (shared/queue/coordinator.ts).
 * This is the routing brain behind the BundlerDO /lease endpoint; the DO supplies the durable +
 * in-memory route state and this decides the index. The load-bearing invariant under test is
 * dedup-STABILITY: an existing route (durable or cached) is ALWAYS reused, so a redelivered /
 * re-sent op returns to the same pool index and the destination RelayerDO's per-index seen-set
 * dedups it (no cross-index double-bundle) — even across eviction / DYNAMIC_LEASE rollback.
 */

import { it, expect } from "vitest";
import { decidePoolIndex } from "../shared/queue/coordinator.ts";
import { relayerIndexForSender } from "../shared/queue/routing.ts";

const base = {
  width: 10,
  now: 1_000_000,
  recentTtlMs: 30_000,
  busy: new Set<number>(),
  recentlyLeased: new Map<number, number>(),
  cursor: 0,
};

it("reuses an existing route regardless of policy (dedup-stable across eviction/rollback)", () => {
  // lease ON: an existing route wins over any free-index pick.
  expect(decidePoolIndex({ ...base, sender: "0x" + "ab".repeat(20), lease: true, existingIndex: 7 }).index).toEqual(7);
  // lease OFF (rollback): the existing LEASED route still wins over the hash index — this is what
  // stops an in-flight leased op from double-bundling when routing reverts to hash.
  const sender = "0x" + "cd".repeat(20);
  expect(relayerIndexForSender(sender, 10)).not.toEqual(7); // hash would send it elsewhere…
  expect(decidePoolIndex({ ...base, sender, lease: false, existingIndex: 7 }).index).toEqual(7); // …but the route is honored
});

it("HONORS an existing route on an index >= width (leased before the width was lowered)", () => {
  const sender = "0x" + "ef".repeat(20);
  // A route persisted at index 15 must be reused verbatim even though the active width is now 10 —
  // its in-flight op lives on RelayerDO-15, so a redelivery must return there (else double-bundle).
  expect(decidePoolIndex({ ...base, sender, lease: true, existingIndex: 15 }).index).toEqual(15);
  expect(decidePoolIndex({ ...base, sender, lease: false, existingIndex: 15 }).index).toEqual(15);
  // Only a nonsense index (negative / non-integer) is dropped → reassigned within the width.
  const r = decidePoolIndex({ ...base, sender, lease: false, existingIndex: -1 });
  expect(r.index).toEqual(relayerIndexForSender(sender, 10));
  expect(r.index).toBeLessThan(10);
});

it("new sender, lease OFF → deterministic hash(sender)%width", () => {
  const sender = "0x" + "12".repeat(20);
  expect(decidePoolIndex({ ...base, sender, lease: false, existingIndex: null }).index)
    .toEqual(relayerIndexForSender(sender, 10));
});

it("new sender, lease ON → a FREE index, skipping busy + recently-leased, advancing the cursor", () => {
  const busy = new Set<number>([0, 1, 2]);
  const recentlyLeased = new Map<number, number>([[3, base.now]]); // 3 just handed out
  const r = decidePoolIndex({ ...base, sender: "0xnew", lease: true, existingIndex: null, busy, recentlyLeased });
  expect(r.index).toEqual(4);       // 0,1,2 busy; 3 recent → first free is 4
  expect(r.cursor).toEqual(5);      // cursor advances past the pick
});

it("lease ON, every index busy → round-robin fallback (never blocks / never NaN)", () => {
  const busy = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const r = decidePoolIndex({ ...base, sender: "0xnew", lease: true, existingIndex: null, busy, cursor: 3 });
  expect(r.index).toEqual(3);       // cursor position
  expect(r.index).toBeGreaterThanOrEqual(0);
  expect(r.index).toBeLessThan(10);
  expect(r.cursor).toEqual(4);
});

it("recentlyLeased older than the TTL no longer blocks an index", () => {
  const recentlyLeased = new Map<number, number>([[0, base.now - 31_000]]); // expired (>30s)
  const r = decidePoolIndex({ ...base, sender: "0xnew", lease: true, existingIndex: null, recentlyLeased, cursor: 0 });
  expect(r.index).toEqual(0); // expired recent-lease → index 0 is free again
});
