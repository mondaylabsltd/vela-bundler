# 08 — Open Issues

> Everything not fixed in the 2026-07-09 pass, with severity, evidence, a fix recipe, and an
> acceptance criterion. Fixed items are recorded in [04-production-readiness.md](04-production-readiness.md)
> and omitted here. Severity is the adversarially-verified/corrected value.

## Closed — round 1 (2026-07-09)
Unbounded chain-registry DoS · broken CI/test/lint gate · `parseValidationData` inverted layout ·
Tempo delegatecall reimbursement drain · DO cold-start restore no-op · `OPERATOR_SECRET` validation +
`hexToBytes` coercion. See [04](04-production-readiness.md) for evidence and regression tests.

## Closed — round 2 defensive hardening (2026-07-09), each with a regression test
- **O-20** [reliability] gas/fee fields ≥ 2¹²⁸ now rejected cleanly at validation ([shared/userop/validate.ts](../../shared/userop/validate.ts)) instead of throwing inside `packUint128`. Tests in `tests/userop_test.ts`.
- **O-17** [stability] `ReputationManager` map bounded at `maxEntries` (default 50k) with oldest-**ok**-only eviction (never drops throttled/banned) ([shared/mempool/reputation.ts](../../shared/mempool/reputation.ts)). Tests in `tests/reputation_test.ts`.
- **O-16** [reliability] Worker body-size cap now measured on `arrayBuffer().byteLength`, not UTF-16 `String.length` ([worker/bundler-do.ts](../../worker/bundler-do.ts)). (Deno already byte-capped; e2e covers the Deno path.)
- **O-4** [stability] Deno SIGTERM/SIGINT graceful shutdown: `ChainRegistry.dispose()` stops the health timer + every chain's bundler timers, then `server.shutdown()` drains ([deno/main.ts](../../deno/main.ts), [shared/chain/index.ts](../../shared/chain/index.ts)). Timer-leak test in `tests/chain_registry_test.ts`.
- **O-3** [observability] Worker per-chain health reachable: `GET /health/:chainId` → the chain's DO, **read-only** (no forced init) ([worker/index.ts](../../worker/index.ts), [worker/bundler-do.ts](../../worker/bundler-do.ts)). Test in `worker/tests/worker.test.ts`.
- **O-15** [security] RPC URLs (Alchemy keys) redacted from money-path error messages that are logged **and** returned to the client (`redactError`) ([shared/reliability/log.ts](../../shared/reliability/log.ts), applied in bundler submit + sponsor). Tests in `tests/reliability_errors_test.ts`.
- **O-8** [observability] Treasury-balance monitor + Telegram alerting (round-2 feature) — see [06](06-operations-runbook.md). Live delivery verified via `deno task e2e`.

## Closed — round 3: money-out robustness audit (2026-07-09)
A 21-agent workflow enumerated every way a user's op can get stuck / money can't transfer out, and
adversarially verified each (12 confirmed, 4 refuted). Core operator requirement: **no silent stuck
money; any intervention-worthy state must Telegram-alert.**

**Fixed (each with a regression test):**
- **#1 [P1] Bundler silently banning a legit user** — in this per-Safe custodial model a "banned"
  sender was hard-rejected at ingress, blocking a real user from moving money for ~1–3h with no
  alert. Now senders are **never hard-banned** (only rate-limited to 1 pending op; factory/paymaster
  bans stay), and the operational monitor fires a `reputation-blocked` alert when a user's ops keep
  failing. ([shared/mempool/index.ts](../../shared/mempool/index.ts), [operational.ts](../../shared/monitoring/operational.ts))
- **#10 [P1] Tempo gas-account drained, un-refillable** — the "new user" nonce gate blocked
  re-sponsoring a drained, actively-used Tempo gas float (nonce > 6), silently stranding the user.
  Tempo re-sponsorship now bypasses the nonce gate (still guarded by passkey + treasury floor +
  per-transfer cap + cooldown). ([shared/account/sponsor.ts](../../shared/account/sponsor.ts))
- **#2 [P2] TTL-evicted op vanished silently** — an op that aged out of the mempool was deleted with
  no receipt, so the wallet polled `null` forever (indistinguishable from "never seen"). A TTL
  eviction now stores a terminal `success:false` receipt so the wallet gets "dropped, resubmit."
  ([shared/mempool/index.ts](../../shared/mempool/index.ts) TTL hook → [shared/bundler/index.ts](../../shared/bundler/index.ts))
- **#8 [P2] Deno receipt poll gave up at 4 min** — extended to 10 min so a slow-confirming tx's
  receipt is still captured (the dropped-tx nonce check still fails fast). ([bundler/index.ts](../../shared/bundler/index.ts))
- **#11 [P2, my own new bug] circuit-degraded alert multiplied per cached chain** in the Deno loop —
  now a process-global dedup key. ([operational.ts](../../shared/monitoring/operational.ts))

**Covered by existing/new alerts (verified, no code change needed):**
- **#7 Worker abandonment (~60m)** deliberately does NOT fabricate a receipt (the stuck tx may still
  land) and keeps the EOA `LOCKED_PENDING_UNKNOWN` — so the new **stuck-eoa alert re-fires every
  30 min** until resolved. That is the correct, honest intervention signal.
- **#5 / #12 stuck-pending alert is Worker-only** (Deno doesn't populate the pending-receipt array):
  on Deno the **stuck-eoa alert covers it** — the EOA is locked at broadcast time in BOTH runtimes
  ([bundler/index.ts:632](../../shared/bundler/index.ts#L632)), so a submitted-but-stuck bundle alerts
  via stuck-eoa at 3 min regardless of runtime. Coverage is complete; only the alert's specificity differs.

## Closed — round 4: total-alerting + robustness pass (2026-07-10)
A 42-agent audit (6 finder dimensions → dedup → adversarial verify: 34 confirmed / 1 refuted)
followed by a full implementation pass. Operator requirement: **every developer-intervention
state (code bug OR needs top-up) must reach Telegram; no more silent stuck money; performance
is a money property (5-min trading windows).** Each fix has a regression test
(`tests/hardening_round4_test.ts`, `tests/monitoring_test.ts` additions).

**Money-stuck correctness:**
- **#9 CLOSED** — broadcast pins the outer nonce (trusted RPC) and the dropped verdict is
  PROOF-based: only `latestNonce > txNonce` for 3 consecutive probes counts; the "pending"
  tag can no longer fabricate failed receipts for in-flight txs. EOA recovery is equally
  proof-gated (`inFlightNonce` on the lock; blind/failed reads never unlock).
- **#3 CLOSED** — mempool age + TTL measured from `firstSeenAt` (survives fee-bump replacement).
- **#6 CLOSED** — automatic same-nonce fee-bump for stuck txs: ≥12.5% raise toward current
  base fee, max 2 bumps, hard ceiling 2× the bundle's revenue cap (bounded loss, inclusion-first
  per O-1); all broadcast hashes polled for the receipt.
- **Ambiguous broadcast outcomes** (timeout / "already known" / raced retry) are now tracked as
  pending receipts under a PRE-COMPUTED tx hash (sign-locally + sendRawTransaction split) instead
  of being declared failed — closes the double-position vector for the trading bot.
- **All definitive drops store terminal receipts** (re-validation, bundle-sim, expiry — same as
  the TTL hook), and initEOA carries a version stamp so a concurrent refresh can't clobber a
  fresh lock (await-overwrite race). `/v1/account` no longer lets a user RPC write lock state.
- **Worker persistence**: accepted-unbundled mempool ops and terminal receipts now persist to DO
  storage (per-hash keys) — a deploy/eviction can no longer vanish accepted ops or regress
  receipt polls; `feeToken` survives the round-trip.

**Alert coverage (Telegram):**
- Broadcast failure streak (`submit-failing`) + insufficient-funds EOA (`eoa-underfunded`, names
  the address) — submit failures used to delete their ops and reset every age-based alert.
- Balance gate re-based on the node's actual prefund rule (estimatedGas × maxFeePerGas) so the
  silent bounce band is gone (ops stay in the mempool where stuck-mempool sees them).
- Sponsor: `sponsor-depleted` (with shortfall), `sponsor-transfer-failed`,
  `sponsor-passkey-index-down` (outage now distinct from "not registered" → REST 503 retryable);
  Tempo empty-float refills bypass the 5-min cooldown (60s floor).
- Treasury: dynamic threshold (raised to the sponsor's fail-closed floor at current gas price —
  the 0.02 ETH dead zone is gone) + `treasury-unreadable` after 10 failed read cycles.
- Code errors: `RepeatedErrorEscalator` pages when the SAME phase fails 3 consecutive cycles
  (both runtimes); Deno global `unhandledrejection`/`error` hooks page + keep the process alive;
  Worker DO alarm re-arms FIRST and any body error pages; chain-init failure streak pages
  (alerter now built in the DO constructor — init errors were unalertable before).
- Alerting misconfig: loud startup log + `alerting: "telegram"|"disabled"` in /health;
  money-stuck alerts re-fire every 10 min with "STILL FIRING — reminder #N" escalation.
- Dead-man switch, 3 layers: ✅ alive heartbeat every 6h (both runtimes; silence = dead),
  systemd `OnFailure=vela-bundler-alert.service` Telegram push (Deno), and a 5-min Workers cron
  that probes ACTIVE_CHAINS DOs and re-arms + alerts on a broken alarm chain.

**Performance / resilience:**
- **Ingress bundle kick**: `eth_sendUserOperation` triggers bundling immediately (Deno inline,
  Worker `setAlarm(now)`) — up to a full alarm interval of latency removed per op.
- **O-6 mitigated**: Deno health loop runs chains CONCURRENTLY (60s per-chain cap); broadcast
  transport tuned (10s timeout, 1 retry); `simulateBundle` now honours its deadline (the
  estimateGas leg escaped it entirely); Worker honours AUTO_BUNDLE_INTERVAL_MS (O-12 remainder).
- getGasPrices throws (retryable degraded) when ALL price reads fail instead of quoting 0x0.
- RATE_LIMIT_ALLOWLIST exempts the operator's own bot; 429s log structured.
- process.ts forwards ONLY factory-built errors (marker symbol) — unmarked upstream objects are
  redacted internal errors. Strict numeric env validation fails fast at startup (Deno).

## Remaining — documented limitations (mitigated; recommended follow-ups)
- **Deno reconciliation is less durable than Worker** (#5/#8): Deno keeps pending receipts
  in-memory (Worker persists them + mempool + terminal receipts to DO storage). Mitigated
  (nonce-proof recovery + stuck-eoa alert + boot ping makes restarts visible), but for heavy
  Deno production use add a file-backed `setPersistPendingHook`. **Production target is
  Cloudflare Workers, where reconciliation, mempool and receipts are all durable.**
- **Tempo ambiguous submit** (sync-submit timeout): no pre-computed 0x76 hash (viem's Tempo
  extension owns the serialization), so the ops are removed with NO receipt (honest unknown,
  never a fabricated failure). The outer nonce IS pinned pre-submit, so the EOA locks with
  nonce proof (no heuristic unlock while the 0x76 may still land) and `submit-failing` alerts.
  Follow-up: split sign/broadcast in `submitTempoBundle` to pre-compute the hash and
  reconcile like native.
- **Post-review accepted trade-offs** (adversarial review 2026-07-10, documented not fixed):
  submit-failure/underfunded signals are per-chain single cells (a busy multi-user chain can
  mask one EOA's failures behind another's successes — the stuck-mempool alert still covers
  the ops themselves); fee-bump policy constants (45s / 2 bumps / 2× revenue cap) are
  compile-time, not config; the Workers liveness cron
  enumerates a self-registering chain-registry DO (no manual list; ACTIVE_CHAINS was
  removed), probes are storage-only, and fully-idle chains stop their own alarm (the
  ingress kick re-arms on the next accepted op) so abandoned user-RPC testnets go quiet
  instead of self-alarming forever; the per-chain monitor sequence
  is duplicated between the Deno registry and the Worker DO (new snapshot fields must be
  threaded through both).
- **#10 per-user Tempo gas-account "empty" alert** — the refill path now bypasses the cooldown
  for a verifiably-empty float and `sponsor-depleted` covers the funding source; a dedicated
  per-gas-account low-float alert still needs Tempo integration testing before shipping.
- **O-5 (viem calls bypass the circuit breaker)**: narrowed, not closed — the broadcast leg is
  timeout-tuned and `simulateBundle`'s estimateGas now rides `rpcCall` (breaker + deadline), but
  balance/nonce/receipt reads still use plain viem transports (bounded 5s timeout + 2 retries).
  Full closure = a viem `custom()` transport over `rpcCall`; do it as its own reviewed change.

## Evidence-based decisions — NOT changed (with rationale)
- **O-1** (splitter 50% haircut vs profit floor) — **RESOLVED as a correct design choice, not a blocker.**
  Re-analysis for this product (a time-sensitive prepaid custodial bot, e.g. BTC 5-min up/down): the
  current behavior **favors inclusion**, which is what the user wants — their op MUST land within the
  window. During a *moderate* base-fee spike the bundle still includes and the **user's own prepaid
  EOA float** (not the operator) absorbs a small under-refund; during an *extreme* spike the
  profitability gate rejects and the op waits + fires the `stuck-mempool` alert. The erosion is
  therefore **bounded** (only moderate spikes), **observable** (`GET /v1/account` shows the EOA
  balance), **alerted** (stuck-mempool when it can no longer submit), and **user-refillable** (deposit
  more). The operator never loses (treasury always takes its 50%). The fee-model doc now states this
  precisely. An operator who prefers strict EOA-break-even over inclusion can set
  `MIN_PROFIT_MARGIN_BPS ≥ 10000`, at the cost of dropping the user's tx during volatility — **not**
  the right default for a bot. No code change; no longer a launch condition.
- **O-9a** (native execution-success not verified): NOT a fund bug. On native chains the account pays gas even if its inner call reverts (standard 4337), so the bundler is reimbursed regardless — verifying inner success only matters on Tempo (in-band reimbursement), which already does it (`simulateExecutionSuccess`).
- **O-9b** (estimate returns hardcoded 200k on failure): intentional leniency for the estimate-before-sign flow (a dummy-signed op fails validation but should still get an estimate). Changing it risks breaking wallet estimation.
- **O-18** (pin outer gas / nonce to avoid re-estimate): NOT done — the trusted-RPC `eth_estimateGas` before broadcast is the safety net that reverts a bad-signature `handleOps` before it is signed and sent (it is exactly what makes the X-Rpc-Url forced-revert vector a non-issue). Pinning gas would remove that guard.
- **O-19** (Tempo cost buffer scale with op count): NOT changed — the buffer is a cross-repo contract with the wallet (like the splitter bytecode); raising it would reject ops that wallets quoted against the current 80k. A wallet-coordinated change, not a safe unilateral one.
- **O-3b** (Worker DO alarm never idles): NOT done — on Workers each chain is a separate CF-hibernated Durable Object (not an in-process map like Deno's registry), so an idle alarm's cost is negligible, whereas adding re-arm logic to a money path risks stuck (never-bundled) ops. Accepted.

---

## P2 — fix before broad launch, or launch with an explicit control

### O-1 [P2] Splitter 50% haircut vs 10% profitability floor (economic calibration)
- **Evidence:** [evm_contracts/src/VelaGasSettlementSplitter.sol:26](../../evm_contracts/src/VelaGasSettlementSplitter.sol) (EOA gets 50% of the refund) vs [shared/gas/profitability.ts:74](../../shared/gas/profitability.ts#L74) + `minProfitMarginBps=1000`. The gate uses full revenue and never models the beneficiary haircut, so at margins in [10%,100%) the user-funded EOA nets negative when base fee rises post-quote.
- **Not** operator loss or treasury siphon (verified): treasury take is constant, operator aggregate positive, and the balance gate self-limits erosion.
- **Fix recipe:** either set `MIN_PROFIT_MARGIN_BPS=10000` for native chains, **or** make `checkBundleProfitability` require `refund/2 ≥ outerCost` (i.e. model the split explicitly) and fix the stale "constant margin" comment at [shared/bundler/index.ts:485](../../shared/bundler/index.ts#L485).
- **Control if not fixed:** document that native EOAs bear base-fee risk between quote and inclusion; keep `BALANCE_RESERVE_MULTIPLIER ≥ 2`.
- **Acceptance:** a unit test asserting a bundle with revenue between 1.1× and 2× outer cost is **rejected** when the beneficiary is the splitter; on-chain, EOA balance non-decreasing across a base-fee-climbing sequence. **Requires an operator pricing decision.**

### O-2 [P3, corrected] Splitter-not-deployed → refund accrues, recovered on next settlement (NOT trapped)
- **Correction (2026-07-09):** an earlier draft called this "trapped/unrecoverable." That was **wrong**. The splitter's `receive()` sends `treasuryAmount = address(this).balance` — the **full** balance, not just `msg.value` — to the treasury ([evm_contracts/src/VelaGasSettlementSplitter.sol:33-37](../../evm_contracts/src/VelaGasSettlementSplitter.sol#L33)). So any refunds that accrued at the address while it was codeless are swept **entirely to the treasury on the first settlement after the splitter is deployed** (CREATE2, deterministic, deployable any time). No funds are lost; the operator can deploy later and collect.
- **Actual (minor) effect:** during the undeployed window the dedicated EOA receives **0%** of the refund (its share accrues to the address instead of coming back 50/50), so the EOA's gas float depletes a bit faster until the splitter exists. Pre-deployment refunds end up 100% in the treasury rather than split — a reallocation, not a loss (treasury and operator are the same party). Self-limiting via the balance gate.
- **Disposition:** **not a launch blocker.** Optional nicety: expose the splitter deploy state so ops can deploy proactively (avoids the temporary EOA-float drag). No code guard required.

### O-3 [P2] Worker per-chain health/metrics endpoint unreachable
- **Evidence:** global `/health` is static ([worker/index.ts:38](../../worker/index.ts#L38)); the DO's `handleHealth` (real degraded logic) is only dispatched on `/health` inside the DO but `routeToDO` is only ever called with `/rpc`/`/rest` ([worker/index.ts:50,58](../../worker/index.ts#L50)) → dead code. No `/metrics` endpoint.
- **Fix recipe:** route `GET /health/:chainId` (or aggregate) through `routeToDO(..., "/health")`; optionally emit metrics via Workers Analytics Engine/logpush.
- **Control if not fixed:** alert off the 10s structured heartbeat log (already emitted + captured).
- **Acceptance:** a per-chain health URL returns `lockedEOAs`/`pendingReceipts`/`reliability` on a Worker deployment.

### O-3b [P2] Worker DO alarm never idles
- **Evidence:** [worker/bundler-do.ts:221](../../worker/bundler-do.ts#L221) reschedules the 10s alarm unconditionally, even with empty mempool/pending/locked. A poked bogus chain self-alarms forever (Worker analog of the registry DoS).
- **Fix recipe:** stop rescheduling when `mempool + pendingReceipts + lockedEOAs` are all empty; re-arm on the next request.
- **Acceptance:** an idle DO stops its alarm and consumes no periodic cost.

### O-4 [P2] Deno runtime: no durability, no graceful shutdown
- **Evidence:** [deno/main.ts](../../deno/main.ts) wires no `setPersistPendingHook` and no SIGTERM/SIGINT handler; `flushPendingReceipts` is a no-op in Deno.
- **Fix recipe:** add a SIGTERM handler that stops timers and awaits in-flight `processReceipt`; optionally a file/KV persistence backend via `setPersistPendingHook`, mirroring the Worker.
- **Control if not fixed:** accept receipt-visibility gaps on restart (no fund loss — nonce monotonicity). Prefer rolling restarts during low traffic.
- **Acceptance:** kill+restart mid-flight → EOA stays `LOCKED_PENDING_UNKNOWN` and reconciliation resumes (or a failed receipt is stored).

### O-5 [P2] Circuit-breaker & unified retry bypassed for direct viem calls
- **Evidence:** the reliability layer (`rpcCall`) wraps only some calls; balance/nonce/estimateGas/broadcast/receipt via viem clients ([shared/utils/rpc-client.ts](../../shared/utils/rpc-client.ts)) use viem's own bounded retry, not the circuit breaker.
- **Fix recipe:** route the money-path reads/broadcast through the reliability wrapper, or extend the breaker to the viem transport.
- **Acceptance:** a degraded endpoint trips the breaker for viem calls too.

### O-6 [P2] Single slow/hanging trusted RPC serializes the whole cycle
- **Evidence:** per-sender deadline bounds one sender, but the outer bundle loop / alarm is sequential; a hung `config.rpcUrl` can wedge the cycle.
- **Fix recipe:** cap total cycle time; parallelize independent senders with a global budget.
- **Acceptance:** one hung RPC does not delay other chains'/senders' progress beyond a bound.

### O-7 [P2] SSRF via DNS rebinding (bounded, read-only)
- **Evidence:** [shared/utils/rpc-client.ts:45](../../shared/utils/rpc-client.ts#L45) `validateRpcUrl` is **lexical** — a public hostname resolving to an internal/metadata IP passes. Redirects are handled (`redirect:manual`), DNS is not.
- **Scope:** the user RPC is read-only (never signs/broadcasts), so worst case is reading internal HTTP into a JSON-RPC response the caller already controls. Real on self-hosted Deno in a cloud VPC; minimal on Workers.
- **Fix recipe:** resolve the hostname and re-check the resolved IP against the blocklist before connecting (or use an egress allowlist / a pinned resolver).
- **Acceptance:** a hostname resolving to `169.254.169.254`/RFC1918 is rejected.

### O-8 [P2] Treasury depletion is unobservable
- **Evidence:** no metric/log/health field tracks treasury balance; sponsor fails closed **silently** below its floor.
- **Fix recipe:** expose treasury balance in `/health` and/or a metric; log a warning when sponsorship is skipped for `treasury_depleted`.
- **Control if not fixed:** external monitor on the treasury address (`GET /v1/treasury` → `eth_getBalance`).
- **Acceptance:** an operator can alert on low treasury without on-chain polling.

### O-9 [P2] Simulation gaps
- **`simulateExecution` doesn't verify native execution success** ([shared/simulation/index.ts]) — the "catch callData reverts" gate is weaker than advertised on native chains (Tempo has an explicit `simulateExecutionSuccess`). Fix: assert `success` on native too, or document the reliance on bundle-sim revert.
- **`estimateUserOpGas` returns a hardcoded 200k `verificationGasLimit` on TRANSIENT RPC failure** — should distinguish transient from definitive and surface a retryable error.
- **TOCTOU:** the sender Safe's on-chain state can change between bundle simulation and inclusion; only the EOA is locked. Accept as inherent to 4337, or add a tighter pre-broadcast recheck window.

### O-10 [P2] No persistence of confirmed receipts / accepted mempool ops
- Confirmed `UserOperationReceipt`s and accepted-but-unbundled ops are in-memory only; lost on eviction/restart with no on-chain fallback for the receipt lookup. Clients must re-derive from chain. Fix: persist recent receipts (Worker DO storage) or document the client's fallback contract.

### O-11 [P2] Rate-limit bypass on directly-bound Deno via spoofable `CF-Connecting-IP`
- **Evidence:** Deno keys the limiter off the real TCP peer (`info.remoteAddr`) — good — but if the Deno server is ever placed behind a proxy that forwards `CF-Connecting-IP`/`X-Forwarded-For` and code is changed to trust it, spoofing returns. Keep trusting only the TCP peer on directly-bound deployments; only trust forwarded headers behind a proxy you control.

### O-12 [P2] Doc/behavior drift (mostly fixed this pass)
- Fixed: `BALANCE_RESERVE_MULTIPLIER` default (2→1), `MIN_PRIORITY_FEE_PER_GAS` default (→0), removed-sweep description, `TREASURY_ADDRESS`/`SWEEP_INTERVAL` in `.env.example`, rotation-drain warning, `test:worker` now real.
- **Remaining:** `AUTO_BUNDLE_INTERVAL_MS` is parsed but unused on Workers (DO hardcodes 10s) — either honor it or drop it from the Worker config/docs.

---

## P3 — tech debt / low priority

- **O-13** `OLD_OPERATOR_SECRETS` has no in-repo drain tool; rotation "draining" is manual. README now warns; consider shipping a `scripts/drain-old-eoa.ts`.
- **O-14** Attacker `X-Rpc-Url` can push forged ops for arbitrary safes through the read-only pipeline up to the (failing) broadcast → griefing/CPU + potential co-bundle eviction. No fund loss (refuted P1). Consider dropping ops that fail sim on the trusted RPC before mempool insertion regardless of user RPC.
- **O-15** Raw `console.error(viemError)` can leak an Alchemy URL (API key) in a stack trace — route through `redactUrl`.
- **O-16** Worker body-size cap measures UTF-16 code units, not bytes ([worker/bundler-do.ts:368]) — a multibyte body can slightly exceed 256KB. Use a byte length.
- **O-17** `ReputationManager` map has no hard size cap while sibling maps do — bound it.
- **O-18** Broadcast omits an explicit `nonce`/pinned `gas` (re-estimates, N+1) — minor latency/cost.
- **O-19** Tempo cost buffer is a flat 80k gas regardless of bundle size — heavy bundles/deploys can be accepted slightly under-reimbursed. Scale the buffer with op count.
- **O-20** Unbounded gas/fee fields can make `packUint128` throw inside `simulateValidation`, surfacing as a generic internal error — validate ranges for a clean rejection.
- **O-21** Deploy writes the operator secret as base64 in the ssh command argv → visible in process listings on both hosts during deploy. Pipe via stdin instead.
- **O-22** `/health` returns HTTP 200 even when degraded; the deploy health-gate only matches literal `"ok"`. Consider a non-2xx on degraded, or alert on the JSON field.

---

## Acceptance summary for a clean future GO
1. O-1 economic decision made (or native margin raised) — **operator input required**.
2. O-2 splitter-deployment guarded or made a hard deploy precondition with a check.
3. O-8 treasury-balance monitoring in place (metric or external).
4. O-3/O-3b Worker health reachable + DO alarm idles (if Workers is the launch target).
5. O-4 Deno graceful shutdown (if Deno is the launch target and receipt-visibility across restarts matters).
