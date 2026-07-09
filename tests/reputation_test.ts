/**
 * Tests for ReputationManager, focused on the memory bound (O-17): the entity map must not
 * grow past maxEntries, and eviction must never drop a throttled/banned entity (which would
 * reset a bad actor's penalty).
 */

import { assertEquals, assert } from "@std/assert";
import { ReputationManager } from "../shared/mempool/reputation.ts";

const A = "0x" + "a1".repeat(20) as `0x${string}`;
const B = "0x" + "b2".repeat(20) as `0x${string}`;
const C = "0x" + "c3".repeat(20) as `0x${string}`;
const D = "0x" + "d4".repeat(20) as `0x${string}`;

Deno.test("ReputationManager - evicts the oldest ok entry at the cap (bounded map)", () => {
  const rep = new ReputationManager({ maxEntries: 3 });
  rep.updateSeen(A, "sender");
  rep.updateSeen(B, "sender");
  rep.updateSeen(C, "sender");
  assertEquals(rep.dump().length, 3);

  rep.updateSeen(D, "sender"); // at cap → evict oldest ok (A, inserted first)
  const addrs = rep.dump().map((e) => e.address);
  assertEquals(rep.dump().length, 3);
  assert(!addrs.includes(A.toLowerCase() as `0x${string}`), "A (oldest ok) should have been evicted");
  assert(addrs.includes(D.toLowerCase() as `0x${string}`), "D should have been added");
});

Deno.test("ReputationManager - never evicts a banned entity (penalty is not resettable via flood)", () => {
  const rep = new ReputationManager({ maxEntries: 3 });
  rep.updateSeen(A, "sender");
  rep.updateSeen(B, "sender");
  rep.updateSeen(C, "sender");
  // Ban A.
  for (let i = 0; i < 10; i++) rep.penalize(A, "sender");
  assertEquals(rep.getStatus(A, "sender"), "banned");

  rep.updateSeen(D, "sender"); // at cap → must evict an OK entry (B), NOT banned A
  const addrs = rep.dump().map((e) => e.address);
  assertEquals(rep.dump().length, 3);
  assert(addrs.includes(A.toLowerCase() as `0x${string}`), "banned A must survive eviction");
  assert(addrs.includes(D.toLowerCase() as `0x${string}`), "D should have been added");
});

Deno.test("ReputationManager - stays bounded under a large distinct-sender flood", () => {
  const rep = new ReputationManager({ maxEntries: 100 });
  for (let i = 0; i < 1000; i++) {
    const addr = ("0x" + i.toString(16).padStart(40, "0")) as `0x${string}`;
    rep.updateSeen(addr, "sender");
  }
  assert(rep.dump().length <= 100, `map should stay ≤ 100, got ${rep.dump().length}`);
});

Deno.test("ReputationManager - HARD cap holds even when every entry is penalized (regression)", () => {
  // Adversarial-review finding: when no "ok" entry exists to evict, the cap must still hold by
  // evicting the oldest overall — not silently grow past maxEntries.
  const rep = new ReputationManager({ maxEntries: 3 });
  for (const a of [A, B, C]) {
    for (let i = 0; i < 12; i++) rep.updateSeen(a, "sender"); // opsSeen 12 > throttlingSlack 10 → throttled
    assert(rep.getStatus(a, "sender") !== "ok", "should be penalized");
  }
  assertEquals(rep.dump().length, 3);
  // Flood more distinct penalized senders — size must NOT exceed the cap.
  for (const seed of [D, "0x" + "e5".repeat(20) as `0x${string}`, "0x" + "f6".repeat(20) as `0x${string}`]) {
    for (let i = 0; i < 12; i++) rep.updateSeen(seed, "sender");
    assert(rep.dump().length <= 3, `hard cap breached: ${rep.dump().length}`);
  }
});
