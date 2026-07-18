/**
 * Stage 4 queue-transport producer (docs/pool-queue-architecture.md).
 *
 * The chain BundlerDO wires this hook into its BundlerService (setEnqueueHook). After the
 * SHARED validate+simulate path passes, acceptUserOp calls it for chains where queue transport
 * is active: it enqueues a UserOpQueueMessage to USEROP_QUEUE and writes an accepted-op status
 * marker to USEROP_STATUS so a wallet poll can resolve before the op reaches a RelayerDO.
 */

import type { Env, UserOpQueueMessage } from "./types.ts";
import type { EnqueueRequest } from "../shared/bundler/index.ts";
import { userOpToRpc } from "../shared/userop/normalize.ts";
import { relayerIndexForSender, resolveRoutingWidth } from "../shared/queue/routing.ts";
import { redactError } from "../shared/reliability/log.ts";

/**
 * Build the enqueue hook for one chain. Returns false — never throws — when USEROP_QUEUE is
 * unbound at runtime (the binding stays commented in wrangler until deploy-time queues exist),
 * so acceptUserOp degrades to the in-DO mempool and an accepted op is never dropped.
 *
 * The status marker's `index` is the SAME hash(sender)%RELAYER_POOL_SIZE the queue consumer
 * routes by (both import relayerIndexForSender), so the producer's KV index and the destination
 * RelayerDO always agree. The marker carries STATUS ONLY — never nonce or lock state (KV is not
 * atomic; the per-EOA DO owns the nonce).
 */
export function makeEnqueueHook(
  env: Env,
  opts: { chainId: number; entryPoint: `0x${string}` },
): (req: EnqueueRequest) => Promise<boolean> {
  let warnedNoQueue = false;
  return async (req: EnqueueRequest): Promise<boolean> => {
    const queue = env.USEROP_QUEUE;
    if (!queue) {
      // Log ONCE per isolate — a chain with the flag on but the queue binding absent degrades
      // to the mempool path silently thereafter (the op still lands; never drop it).
      if (!warnedNoQueue) {
        warnedNoQueue = true;
        console.warn(
          `[Producer] QUEUE_TRANSPORT_ENABLED covers chain ${opts.chainId} but USEROP_QUEUE is ` +
            `unbound — degrading to the in-DO mempool path.`,
        );
      }
      return false;
    }

    // Advisory routing index for the accepted marker (powers /debug fan-out before the op
    // reaches a RelayerDO). Under dynamic leasing the CONSUMER picks the real index at consume
    // time and the RelayerDO overwrites this marker with it, so this is only a best-guess for
    // the pre-consume window — computed at the same width the consumer's fallback uses.
    const index = relayerIndexForSender(req.userOp.sender, resolveRoutingWidth(env.POOL_ROUTING_WIDTH));
    const message: UserOpQueueMessage = {
      chainId: opts.chainId,
      entryPoint: opts.entryPoint,
      rpcUserOp: userOpToRpc(req.userOp),
      rpcUrlOverride: req.rpcUrlOverride,
      userOpHash: req.userOpHash,
      prefund: req.prefund.toString(),
    };
    await queue.send(message);

    // Best-effort accepted marker so the wallet's poll resolves to "pending" (not a scary
    // null-that-looks-like-lost) before the op reaches its RelayerDO. Status only; a KV blip
    // must never fail the accept (the op is already durably enqueued above).
    const kv = env.USEROP_STATUS;
    if (kv) {
      try {
        await kv.put(
          req.userOpHash,
          JSON.stringify({ status: "accepted", index, sender: req.userOp.sender, chainId: opts.chainId }),
          { expirationTtl: 900 },
        );
      } catch (err) {
        console.warn(`[Producer] status marker write failed for ${req.userOpHash}: ${redactError(err)}`);
      }
    }
    return true;
  };
}
