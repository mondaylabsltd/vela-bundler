# 03 — Core Flows

> Traced from source at commit `4beaaef`. Each step cites `file:line`.

## Flow A — `eth_sendUserOperation` (ingress → mempool)

Entry: `POST /:chainId` → [deno/server.ts:212](../../deno/server.ts#L212) / [worker/bundler-do.ts:415](../../worker/bundler-do.ts#L415) → `processRequest` ([shared/rpc/process.ts](../../shared/rpc/process.ts)) → handler in [shared/rpc/handlers.ts](../../shared/rpc/handlers.ts).

1. **Rate limit** by IP (real peer address on Deno; `CF-Connecting-IP` on Worker) — [shared/auth/index.ts](../../shared/auth/index.ts).
2. **Body cap** 256 KB, streamed (Deno) / length-checked on read (Worker). Batch cap 20.
3. **Field validation** ([shared/userop/validate.ts](../../shared/userop/validate.ts)): sender format, gas limits > 0, `verificationGasLimit ≤ MAX` (5M native / 8M Tempo), fee-field sanity, factory/paymaster consistency, signature present.
4. **Binding**: the op's `sender` (Safe) determines the dedicated EOA. The bundler will later re-assert `UserOp.sender == boundSafe` before bundling ([shared/bundler/index.ts:319-331](../../shared/bundler/index.ts#L319)).
5. **Simulation** (`simulateValidation`) decides accept/reject. A **transient** RPC failure is distinguished from a definitive rejection: transient → retryable degraded error (keep), definitive → reject ([shared/simulation/index.ts](../../shared/simulation/index.ts)).
6. **Mempool add** with per-sender reputation/quota ([shared/mempool/index.ts](../../shared/mempool/index.ts), cap 4096, staked-sender max 4 ops).

## Flow B — auto-bundle → submit → settle (the money path)

Driver: Deno `ChainRegistry` interval / Worker DO `alarm()` (10s) → `bundler.tryBundle()` → per-Safe `executeSenderBundle` ([shared/bundler/index.ts:270](../../shared/bundler/index.ts#L270)).

1. **Per-EOA lock**: `acquireBundleLock` is a **synchronous check-then-set** on an in-memory map — atomic under both the DO (serialized) and Deno (no `await` in the critical section) ([shared/account/eoa-lock.ts:134-144](../../shared/account/eoa-lock.ts#L134)). Released in a `finally` ([bundler/index.ts:265-267](../../shared/bundler/index.ts#L265)).
2. **Deadline**: one shared `PER_SENDER_BUNDLE_DEADLINE_MS` deadline bounds all RPC reads for a sender so one slow sender can't starve the cycle ([bundler/index.ts:286](../../shared/bundler/index.ts#L286)).
3. **Fee model** ([shared/gas/fee-model.ts](../../shared/gas/fee-model.ts)): `revenueCap = min over ops of the signed EntryPoint refund price`; the outer `maxFeePerGas` is clamped to `[baseFee+priority, revenueCap]` with base-fee headroom — guarantees **never a loss** (maxFee ≤ revenue) while keeping inclusion when base fee rises.
4. **Re-validate + execution-sim** every op in parallel; `drop` (remove + penalize) vs `defer` (keep, no penalty) vs `ok` ([bundler/index.ts:337-398](../../shared/bundler/index.ts#L337)).
5. **Beneficiary**: splitter (native) or EOA (Tempo) ([bundler/index.ts:405](../../shared/bundler/index.ts#L405)).
6. **Settlement gate**:
   - **Native**: profitability check (`minProfitMarginBps ≤ margin ≤ maxProfitMarginBps`) + balance check (`spendable ≥ expectedCost × reserveMultiplier`) ([bundler/index.ts:484-531](../../shared/bundler/index.ts#L484)).
   - **Tempo**: parse the in-band reimbursement — **only** transfers to the EOA **in the trusted feeToken** count (guards against repay-in-worthless-token drain) — verify execution succeeds, price real gas, require `reimbursed ≥ cost` **fail-closed** ([bundler/index.ts:433-482](../../shared/bundler/index.ts#L433)).
7. **Time-range re-check** right before submit (validAfter/validUntil, 10s skew) ([bundler/index.ts:534-556](../../shared/bundler/index.ts#L534)).
8. **Reserve balance** (native only), then **sign + broadcast via the trusted RPC only** — never the user's `X-Rpc-Url` ([bundler/index.ts:558-602](../../shared/bundler/index.ts#L558)).
9. **Post-submit**: remove ops from mempool, mark included in reputation, **lock EOA** `LOCKED_PENDING_UNKNOWN`. Worker: push to `pendingReceipts` and **persist immediately** (survives eviction). Deno: background `processReceipt` promise ([bundler/index.ts:610-666](../../shared/bundler/index.ts#L610)).
10. **Reconciliation** ([bundler/index.ts:738-960](../../shared/bundler/index.ts#L738)): poll receipt (up to ~240s Deno / alarm-driven Worker); every few polls compare `pending` vs `latest` nonce to detect a **dropped tx** and fail fast; on any terminal outcome **release the reservation** (`finally`) and refresh nonce. Failed/dropped ops get a stored failure receipt so the wallet gets immediate feedback instead of polling to timeout.

## Flow C — `POST /v1/sponsor` (treasury → user EOA top-up)

Entry: [shared/rpc/rest-api.ts:166-206](../../shared/rpc/rest-api.ts#L166) → [shared/account/sponsor.ts](../../shared/account/sponsor.ts).

**Recipient is server-derived** (`deriveEOA(safeAddress)`, [rest-api.ts:191](../../shared/rpc/rest-api.ts#L191)) — the client cannot redirect funds. Sponsorship **always uses the trusted registry RPC** (X-Rpc-Url ignored, [rest-api.ts:188](../../shared/rpc/rest-api.ts#L188)). Layered eligibility guards ([sponsor.ts:113-291](../../shared/account/sponsor.ts#L113)):

1. Per-Safe **cooldown** 5 min (set only on success).
2. Per-relayer **in-progress** guard.
3. **New-user only**: relayer nonce ≤ 6.
4. **Wallet must hold ≥ 2×** the sponsor amount (empty wallets can't drain the treasury).
5. **Passkey gate**: the Safe must have a WebAuthn key registered in the external index `webauthnp256-publickey-index.biubiu.tools` (fail-closed on error).
6. **Treasury floor** + per-transfer cap (`MAX_SPONSOR_GAS × gasPrice`).
7. Treasury sends are **serialized against the treasury nonce** (`runTreasuryExclusive`) so concurrent sponsorships of different safes don't collide on a nonce.

## Key domain rules & invariants

- **One Safe per bundle.** Every op in a bundle shares one `sender`; the dedicated EOA signs. Cross-sender bundling is not done.
- **On-chain nonce is the source of truth for double-submit safety.** In-memory locks/reservations are optimizations; after a restart the EOA state is re-derived from chain nonce, and a still-pending tx re-locks the EOA (`LOCKED_PENDING_UNKNOWN`) until the health loop confirms it. A used nonce makes a resubmitted op fail validation. This is why "no database" is tolerable.
- **User `X-Rpc-Url` is read-only.** It is used for balance/gas/simulation reads (worst case: the user griefs their own op) but **never** for signing/broadcast or the sponsor money path.
- **Splitter address is CREATE2-deterministic** from the treasury and identical on every chain; the creation code is metadata-stripped and PUSH0-free so bytecode (hence address) is stable cross-chain. It **must be deployed** (by the wallet's first batch) before native settlement routes to it — see [04](04-production-readiness.md).
- **Tempo reimbursement must be in the trusted feeToken and paid to the EOA**, or the op is rejected fail-closed.

## Hardest-to-change / highest-regression-risk areas

1. **`shared/bundler/index.ts`** (1148 LOC) — the submit + reconciliation state machine; touches locks, reservations, mempool, receipts, and two settlement models. Small changes here can cause fund loss or stuck EOAs.
2. **`shared/gas/fee-model.ts` + `profitability.ts`** — the never-a-loss invariant. A sign/clamp error means the operator loses money on every bundle.
3. **`shared/contracts/splitter.ts` bytecode constants** — must stay byte-identical to the wallet repo; drift silently misroutes the beneficiary payout.
4. **`shared/tempo.ts`** — 0x76 tx construction, cost math (attodollar/1e12 scaling), reimbursement parsing.
5. **`shared/account/eoa-lock.ts`** — the concurrency + nonce-recovery logic underpinning double-submit safety.
