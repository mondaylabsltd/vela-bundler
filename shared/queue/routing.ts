/**
 * Queue transport routing (Stage 4 of docs/pool-queue-architecture.md).
 *
 * A validated UserOp is routed to a per-EOA RelayerDO by hashing its sender. This is the
 * SINGLE definition of that hash, imported by BOTH the producer (which writes the resulting
 * index into the USEROP_STATUS marker) AND the queue consumer (which routes the message to
 * `chain-${chainId}-eoa-${index}`). The two MUST agree, so there is exactly one function.
 */

import { RELAYER_POOL_SIZE, RELAYER_ROUTING_WIDTH } from "../keys/derive.ts";

export { RELAYER_POOL_SIZE, RELAYER_ROUTING_WIDTH };

/**
 * Resolve the effective routing width from the raw POOL_ROUTING_WIDTH env value. Empty/invalid
 * → RELAYER_ROUTING_WIDTH (default 10). Clamped to [1, RELAYER_POOL_SIZE] so it can never
 * exceed the key-derivation ceiling (an index the pool has no deterministic key for) nor go to
 * zero (a `% 0` NaN). The producer and consumer MUST resolve this identically, so both pass the
 * same env value through this one helper.
 */
export function resolveRoutingWidth(raw: string | undefined): number {
  const n = parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return RELAYER_ROUTING_WIDTH;
  return Math.min(n, RELAYER_POOL_SIZE);
}

/**
 * Map a UserOp sender to its pool relayer index in [0, width-1] — the STATIC hash routing used
 * when dynamic leasing is off (the rollback path). Deterministic + stable: lowercase the
 * address, take the LAST 8 hex nibbles (the low 32 bits) as an unsigned integer, mod width.
 * Stability matters — the producer's KV index and the consumer's DO routing derive from this
 * identical computation, and a fee-bump/reconciliation receipt is owned by whichever RelayerDO
 * this resolves to, so it must never drift for a given sender at a fixed width. A malformed
 * (non-hex) sender falls back to index 0.
 */
export function relayerIndexForSender(sender: string, width: number = RELAYER_ROUTING_WIDTH): number {
  const w = width >= 1 ? width : RELAYER_ROUTING_WIDTH;
  const clean = sender.toLowerCase().replace(/^0x/, "");
  const last8 = clean.slice(-8);
  const n = parseInt(last8, 16);
  if (!Number.isFinite(n)) return 0;
  return n % w;
}
