# EOA pool + Cloudflare Queue + per-EOA DO rework

Status: DESIGN LOCKED, not started. Follows the in-band gas work (docs/inband-gas-settlement.md).
This retires the per-safe dedicated EOA in favor of a fixed pool + queue transport + per-EOA lock.

## Locked decisions (do not re-litigate)
- **Queue is mandatory** (transport). **Per-EOA Durable Object = the lock** (its input gate serializes
  → correct nonce, no cross-isolate race). **NO D1, NO KV** (KV isn't atomic → nonce races; D1 adds a
  layer the DO already provides). **NO cron** — reconciliation is each per-EOA DO's own self-rearming
  alarm (reuse the existing DO alarm machinery, re-scoped per-EOA).
- **100 EOA pool**: `HKDF(OPERATOR_SECRET, salt=DOMAIN_SEPARATOR, info="relayer-#${i}")`, i=0..99,
  **NO chainId** → identical 100 addresses on every network (mirror `deriveTreasuryPrivateKey`,
  shared/keys/derive.ts:104). UserOps are NOT bound to an EOA at sign time.
- **Reimbursement recipient = the treasury EOA** (decision A: no new vault contract). The wallet signs
  its in-band reimbursement transfer to the treasury (knowable at sign time). Pool EOAs front native
  gas and are topped up FROM the treasury.
- **Deno app: dropped** (queues are Cloudflare-only; do not port).
- Concurrency = 100 (100 per-EOA DOs run in parallel, each internally serialized).

## Architecture
```
Producer (Worker, eth_sendUserOperation): validate + simulate (reuse handleSendUserOperation) →
    on pass, env.USEROP_QUEUE.send({chainId, entryPoint, rpcUserOp, rpcUrlOverride, userOpHash, prefund})
    instead of mempool.add + requestBundleKick. Delete the per-safe EOA lock/nonce block and the
    "Deposit to {eoa}" native-balance gate. Write an accepted-op status marker so polls resolve.
Queue: one `vela-userops` (chainId in each message; CF can't create queues per-chain at runtime),
    DLQ `vela-userops-dlq`, max_retries=3.
Consumer (Worker queue() handler — ACTIVE consumption, not cron): group batch by chainId; route each
    op by hash(sender)%100 → DO `chain-${chainId}-eoa-${i}`, stub.fetch('/submit', {ops}). ack on ok.
Per-EOA DO `chain-${chainId}-eoa-${i}` (i=0..99):
    - owns pool EOA #i; input gate = the per-EOA lock.
    - storage: this EOA's nonce + pending receipts (reuse the current DO persistence hooks).
    - /submit: dedup by userOpHash (queues are at-least-once) → assign nonce → per-op simulate+filter
      (drop definitive failures with a terminal receipt + reputation penalty) → assemble a MULTI-SENDER
      handleOps over the surviving ops → beneficiary = treasury → sign with pool key #i → broadcast raw
      tx via trusted RPC → record pending receipt.
    - alarm (reuse the existing self-rearming alarm): checkPendingReceipts, recover stuck nonce/tx,
      idle-stop when empty.
Reimbursement → treasury EOA. Pool EOA low on native → top up from treasury.
```

## Multi-sender assembly (the 4337 gotcha)
`EntryPoint.handleOps` reverts the ENTIRE tx with `FailedOp(opIndex)` if ANY op fails the validation
phase; `simulateBundle` returns only the first failed index. So inside a per-EOA DO's /submit: an
iterative **drop-resimulate-reassemble** loop — per-op `simulateValidation`+`simulateExecutionSuccess`
in parallel, drop definitive failures (terminal receipt via `dropWithReceipt` + reputation), reassemble
the survivors, bounded retries. The producer's enqueue-time sim filters most; re-sim at assembly because
state may have changed.

## The one extra coordination point
Treasury top-up of the 100 pool EOAs must serialize the TREASURY's own nonce (else 100 per-EOA DOs
collide on it). Route all top-up sends through ONE coordinator (a `chain-${id}-treasury` DO, or reuse
SponsorService's `runTreasuryExclusive` behind a single DO). Keep that DO alive (not idle-stopped).

## in-band interaction (preserve byte-for-byte)
The in-band settlement (maxFee=0 gate, `IN_BAND_MARKUP_X=3`, DEX `quoteNativeToStable`, $0.01
stablecoin floor, `TRUSTED_MULTISEND` delegatecall anti-drain) is unchanged EXCEPT the reimbursement
recipient. Three recipient sites must move together from `eoa.address` to the treasury:
`beneficiary` (bundler/index.ts ~724), `parseInBandReimbursement`/`parseTempoReimbursement` recipient
(~768), and the `vela_getInBandGasQuote` handler. Miss one → funds go to treasury while the gate credits
the EOA → silent stuck ops.

## Phased plan (each behind a flag, per-chain canary, typecheck+tests every step)
0. Additive dead code (zero behavior): `derivePoolRelayerPrivateKey/Address` (derive.ts) + KeyManager
   pool accessor; treasury-as-vault config/plumbing; declare (unused) queue + status bindings in
   wrangler.jsonc/worker types. Golden-vector tests for the pool addresses.
1. Pool lease layer (unused): `AccountService.leaseFreePoolEOA` over EOALockManager; unit tests.
2. Flag `SETTLEMENT_VAULT_ENABLED` (still per-safe EOA + mempool + alarm): redirect the 3 recipient
   sites to the treasury (atomically with the wallet change; dual-accept window); add the treasury→pool
   top-up loop (NOT nonce-gated, per-chain serialized). Proves vault + top-up in isolation.
3. Flag `POOL_EOA_ENABLED` (still no queues, inside the single per-chain DO): multi-sender bundling +
   pool leasing + iterative drop-resim-reassemble; re-key fee-bump/reconciliation to the pool EOA.
   Proves multi-sender assembly under the DO single-writer.
4. Flag `QUEUE_TRANSPORT_ENABLED` (one chain at a time): producer enqueues (delete ingress EOA
   lock/deposit gate); queue consumer routes hash(sender)%100 → per-EOA DOs; /submit dedup+assemble;
   status index; DLQ.
5. Cleanup after bake: drain legacy per-safe EOA balances via old secrets; remove per-safe deriveEOA +
   the dual-accept branch; retire flags.

## Open questions to resolve when resuming
- Shard/pool: is 100 EOAs enough for the peak burst per chain in a 5-min window? (concurrency=100.)
- Status index for the wallet's accept poll: KV-with-TTL vs writing the marker to the destination
  per-EOA DO on enqueue. (KV is fine for a status marker — it's not the nonce.)
- Same-sender multiple in-flight: the mempool's one-pending-per-sender throttle disappears with queues;
  confirm the workload (one op per sender per window vs many).
- Fee-bump ownership if the routing (hash%100) ever changes: keep it stable, or store the owning EOA
  index in the pending receipt.

## Current repo state at handoff
- in-band work: UNCOMMITTED on branch `feat/sponsor-hardening-dryrun`, all verified (504 vitest tests,
  typecheck clean), fully gated behind `inBandEnabled=false`. Files: shared/{tempo,bundler/index,
  config/types,config/chain-registry,userop/validate,rpc/handlers,gas/stable-rate}.ts + tests.
- Critical Tempo drain hotfix: committed + PUSHED as `fix/tempo-reimbursement-multisend-binding` (off
  main, a07c1a9), 7/7 Deno tests pass, PR pending at github.com/mondaylabsltd/vela-bundler.
```
