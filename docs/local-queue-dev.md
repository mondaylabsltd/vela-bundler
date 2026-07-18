# Local queue / RelayerDO testing

**Yes — the Stage-4 queue transport and per-EOA `RelayerDO` run fully locally.** Cloudflare's
local dev (`wrangler dev`, backed by miniflare) emulates Queues, KV, and Durable Objects in-process,
so you get the real producer → queue → consumer → RelayerDO flow without touching Cloudflare's cloud.

## Why the bindings are commented in the production config

`wrangler.jsonc` keeps the `queues` / `kv_namespaces` blocks commented because **`wrangler deploy`
(remote)** refuses to publish a producer/consumer for a queue that doesn't exist yet in your CF
account. That restriction is a *deploy-time* check — it does **not** apply to `wrangler dev`, where
miniflare creates a local queue on the fly. `wrangler.dev.jsonc` is a local-only copy with those
bindings live.

The producer also degrades gracefully: when `USEROP_QUEUE` is unbound at runtime (the default prod
state today), `acceptUserOp` just uses the in-DO mempool path — so nothing breaks if you run the
prod config locally; you simply won't exercise the queue.

## Run it

```sh
# 1. A throwaway operator secret (32+ hex bytes) — NEVER a real key.
echo 'OPERATOR_SECRET = "0x'$(printf 'ab%.0s' {1..32})'"' > .dev.vars

# 2. Run the dev config (queues + KV + both DOs live; flags on for chain 31337).
npx wrangler dev -c wrangler.dev.jsonc
```

`wrangler.dev.jsonc` turns `POOL_EOA_ENABLED` and `QUEUE_TRANSPORT_ENABLED` on for chain **31337**
(a local anvil/hardhat devnet). In-band + vault already default to `"all"`. Point that chain's RPC at
your local node (the wallet/request sends `X-Rpc-Url`, or resolveChain falls back to it).

## What to watch

An `eth_sendUserOperation` for a 31337 op then flows:

1. **Producer** (`worker/producer.ts`): after validate+simulate, `acceptUserOp` enqueues a
   `UserOpQueueMessage` to `USEROP_QUEUE` and writes an `accepted` marker to `USEROP_STATUS` KV.
   Log line: `[Producer] …` (only on the fallback warning) / the op returns its hash immediately.
2. **Consumer** (`worker/index.ts` `queue()`): groups by chain + `hash(sender)%100`, POSTs `/submit`
   to `env.RELAYER.idFromName(\`chain-31337-eoa-${i}\`)`.
3. **RelayerDO** (`worker/relayer-do.ts`): dedups by `userOpHash`, adds to its mempool, kicks a
   bundle signed by pool EOA `#i`, arms its alarm, and on a terminal receipt writes it back to
   `USEROP_STATUS` KV. Log lines: `[RelayerDO:31337#i] …`.
4. **Poll**: `eth_getUserOperationReceipt` on the chain endpoint returns the KV receipt once mined
   (`fillQueueModeReceiptLookups`).

Miniflare prints queue deliveries and DO alarm firings to the same console, so you can follow one op
end-to-end. To force the mempool fallback instead, run with the prod `wrangler.jsonc` (no
`USEROP_QUEUE` binding) — the same request bundles inside the chain `BundlerDO` with no queue hop.

## Automated coverage

The routing, producer, consumer, dedup, and RelayerDO `/submit` behaviors are unit-tested in
`tests/stage4_queue_transport_test.ts` (node) — run `npm run test:node`. The end-to-end miniflare
flow above is the manual/integration complement.
