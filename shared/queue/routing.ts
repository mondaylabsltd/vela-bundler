/**
 * Queue transport routing (Stage 4 of docs/pool-queue-architecture.md).
 *
 * A validated UserOp is routed to a per-EOA RelayerDO by hashing its sender. This is the
 * SINGLE definition of that hash, imported by BOTH the producer (which writes the resulting
 * index into the USEROP_STATUS marker) AND the queue consumer (which routes the message to
 * `chain-${chainId}-eoa-${index}`). The two MUST agree, so there is exactly one function.
 */

import { RELAYER_POOL_SIZE } from "../keys/derive.ts";

export { RELAYER_POOL_SIZE };

/**
 * Map a UserOp sender to its pool relayer index in [0, RELAYER_POOL_SIZE-1].
 *
 * Deterministic + stable: lowercase the address, take the LAST 8 hex nibbles (the low 32
 * bits) as an unsigned integer, mod RELAYER_POOL_SIZE. Stability matters — the producer's KV
 * index and the consumer's DO routing derive from this identical computation, and a
 * fee-bump/reconciliation receipt is owned by whichever RelayerDO this resolves to, so it
 * must never drift for a given sender. A malformed (non-hex) sender falls back to index 0.
 */
export function relayerIndexForSender(sender: string): number {
  const clean = sender.toLowerCase().replace(/^0x/, "");
  const last8 = clean.slice(-8);
  const n = parseInt(last8, 16);
  if (!Number.isFinite(n)) return 0;
  return n % RELAYER_POOL_SIZE;
}
