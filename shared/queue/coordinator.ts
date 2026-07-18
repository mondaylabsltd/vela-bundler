/**
 * Dynamic-lease coordinator core (pure) — the routing-decision logic behind the per-chain
 * BundlerDO /lease endpoint. Kept as a pure function so it is unit-testable without a Durable
 * Object: the DO supplies the live/durable route maps + busy set, this decides the index.
 *
 * WHY THIS EXISTS (the correctness invariant): the queue is at-least-once, and dedup is
 * per-RelayerDO (each pinned index has its OWN seen-set). So routing MUST be dedup-stable — every
 * delivery of a given sender's op (first, redelivered, or an ambiguous-enqueue re-send) has to land
 * on the SAME pool index, or two different RelayerDOs admit + bundle the same userOp → same-nonce
 * AA25 → the whole handleOps reverts. Static hash routing is stable by construction. Dynamic
 * leasing is NOT — it picks a FREE index that changes over time — so the DO makes the assignment
 * DURABLE (persisted per sender) and this function ALWAYS reuses an existing route before assigning
 * a new one. That durable reuse is what survives BundlerDO eviction/deploy and a DYNAMIC_LEASE
 * rollback (both of which wipe the in-memory map), closing the cross-index double-bundle window.
 */

import { relayerIndexForSender } from "./routing.ts";

export interface RouteRecord {
  /** Assigned pool index. */
  index: number;
  /** Epoch ms the route was last (re)touched — for TTL expiry. */
  ts: number;
}

export interface DecideParams {
  /** The sender's already-assigned index (from the in-memory OR durable route store), if it is
   *  still live (within the sticky TTL). null → this sender has no live route → assign fresh. The
   *  caller guarantees a non-null value is a REAL derived pool index (0 ≤ i < RELAYER_POOL_SIZE);
   *  it is reused verbatim even if it is ≥ the current routing width — a route leased before
   *  POOL_ROUTING_WIDTH was lowered MUST still be honored (its in-flight op lives on that index), or
   *  a redelivery double-bundles. Only NEW assignments are constrained to [0, width). */
  existingIndex: number | null;
  /** Assignment policy for a NEW sender: lease a FREE index (true) vs static hash(sender)%width. */
  lease: boolean;
  /** Active routing width — new traffic spreads across [0, width-1]. */
  width: number;
  /** Lowercased sender address (for the hash-policy fallback). */
  sender: string;
  /** Indices currently BUSY (a RelayerDO registered stranded money-path state, rwatch). */
  busy: Set<number>;
  /** Optimistic per-index "just handed out" stamps — index → ts. */
  recentlyLeased: Map<number, number>;
  now: number;
  /** How long a just-handed-out index is treated as busy (covers the gap until rwatch registers). */
  recentTtlMs: number;
  /** Round-robin cursor (returned updated). */
  cursor: number;
}

/**
 * Decide one sender's pool index. Precedence:
 *  1. REUSE an existing (durable-or-memory) route — dedup-stable across eviction/rollback.
 *  2. New sender, lease OFF → deterministic hash(sender)%width (already dedup-stable).
 *  3. New sender, lease ON → a FREE index (not busy, not recently handed out), round-robin scan;
 *     if every index is taken, round-robin fallback (never blocks — a busy EOA just queues the op).
 */
export function decidePoolIndex(p: DecideParams): { index: number; cursor: number } {
  const w = p.width >= 1 ? p.width : 1;
  // Reuse an existing route verbatim — NOT clamped to the width. A route on an index ≥ width (e.g.
  // one leased before the width was lowered) must still be honored so a redelivery lands on the
  // SAME RelayerDO and dedups; the caller has already validated it is a real pool index.
  if (p.existingIndex !== null && Number.isInteger(p.existingIndex) && p.existingIndex >= 0) {
    return { index: p.existingIndex, cursor: p.cursor };
  }
  if (!p.lease) {
    return { index: relayerIndexForSender(p.sender, w), cursor: p.cursor };
  }
  for (let n = 0; n < w; n++) {
    const i = (p.cursor + n) % w;
    const recent = p.recentlyLeased.get(i);
    if (!p.busy.has(i) && !(recent !== undefined && p.now - recent <= p.recentTtlMs)) {
      return { index: i, cursor: (i + 1) % w };
    }
  }
  const i = p.cursor % w;
  return { index: i, cursor: (i + 1) % w };
}
