# 04 — Production Readiness Audit

> Audit date: **2026-07-09**. Baseline commit at audit start: **`4beaaef`**.
> Method: independent line-by-line trace of the fund-custody paths + a 26-agent parallel audit
> (8 subsystem maps → 8 dimension audits → adversarial verification of every P0/P1). Raw finding
> count: 49. After adversarial verification: **8 confirmed launch-relevant (2 real P1)**, 2 refuted,
> 39 P2/P3. Every claim below is cited to `file:line` and marked **FIXED** or **OPEN**.

## Verdict inputs at a glance

| Gate | Baseline (`4beaaef`) | After this pass |
|------|----------------------|-----------------|
| `deno task lint` | ❌ 45 problems | ✅ exit 0 (96 files) |
| `deno test -A` (typecheck+run) | ❌ fails to compile (47 type errors) + 1 failure | ✅ **443 passed / 0 failed / 5 ignored** |
| `npm run test:worker` | ❌ exit 1 "No test files found" | ✅ **10 passed** (new hermetic suite) |
| `deno task e2e` (new) | — | ✅ **26/26** (accuracy/reliability/stability/perf + **live Telegram delivery**) |
| Smoke test (Deno boot + endpoints) | not run | ✅ health / treasury / JSON-RPC / SSRF-block / batch-cap / weak-secret-reject all verified |

> Three rounds followed the initial audit: (1) P0/P1 fixes, (2) defensive hardening, (3) a money-out
> robustness audit driven by *"no user's money silently stuck; every intervention-worthy state must
> Telegram-alert."* Round 3 added treasury + operational Telegram alerting (stuck mempool op / stuck
> pending bundle / stuck locked EOA / degraded RPC / reputation-blocked sender / low treasury), stopped
> the bundler from hard-banning legit custodial senders, made TTL-dropped ops yield a terminal receipt,
> and enabled Tempo gas-account re-sponsoring. Every round was adversarially re-reviewed by an
> independent multi-agent pass — that layer caught 3 real bugs in my own hardening code (all fixed);
> the round-3 review came back clean.

## Confirmed findings (adversarially verified) and disposition

Severity legend: **P0** block launch (incident/data-loss/fund-loss), **P1** fix before launch,
**P2** deferrable with controls, **P3** tech-debt. "Corrected" = severity after adversarial review.

| # | Area | Title | Reported→Corrected | Status |
|---|------|-------|--------------------|--------|
| 1 | stability | Unbounded per-chain registry growth (DoS) | P1→**P1** | ✅ **FIXED** |
| 2 | eng-quality | No working CI gate (canonical test won't compile; 0 worker tests) | P1→**P1** | ✅ **FIXED** |
| 3 | simulation | `parseValidationData` inverted bit-layout vs ERC-4337 v0.7 | P1→P2 | ✅ **FIXED** |
| 4 | fund-custody | Tempo reimbursement parser ignores MultiSend `operation` byte (delegatecall drain) | P2→P2 | ✅ **FIXED** |
| 5 | data-state / concurrency | DO cold-start restore of reservation+lock is a silent no-op | P1→P2 | ✅ **FIXED** |
| 6 | fund-custody | No `OPERATOR_SECRET` runtime validation; `hexToBytes` coerces bad hex to 0 | P2/P3→P2 | ✅ **FIXED** |
| 7 | fund-custody | Splitter 50% haircut vs 10% profitability floor (no-loss invariant broken on native) | P1→P2 | 🟡 **OPEN** (documented; economic decision) |
| 8 | data-state | Deno runtime has no durability / graceful shutdown | P1→P2 | 🟡 **OPEN** (mitigated by nonce recovery) *(N-A after 2026-07-16 Deno removal.)* |
| 9 | observability | Worker per-chain health/metrics endpoint unreachable | P1→P2 | 🟡 **OPEN** (heartbeat logs mitigate) |
| 10 | fund-custody | Splitter-not-deployed → refund accrues then recovers to treasury | ~~P2~~→**P3** | ✅ **corrected** (not trapped; funds recoverable) |
| — | observability | Treasury depletion unobservable | P2 | ✅ **being addressed** (Telegram monitor) |
| — | security | Attacker X-Rpc-Url → forced-revert fund loss | P1→**REFUTED (P3)** | n/a — trusted-RPC gas estimate blocks broadcast |
| — | ops | `OLD_OPERATOR_SECRETS` drain "documented but unimplemented" | P1→**REFUTED (P3)** | 🟡 doc clarified in README |

---

## Fixed in this pass (with evidence + regression test)

### 1. [P1] Unbounded per-chain registry growth → memory/timer exhaustion (DoS) — FIXED
- **Evidence:** [shared/chain/index.ts:56](../../shared/chain/index.ts#L56) `chains` Map was never bounded/evicted; [initChain:104-117](../../shared/chain/index.ts#L104) caches a chain even when `resolveChain` fails and only a user-supplied `X-Rpc-Url` was used. Each cached chain starts 2 `setInterval` timers ([shared/bundler/index.ts:133,147](../../shared/bundler/index.ts#L133)).
- **Trigger:** unauthenticated `POST /<bogus-chainId>` with a syntactically-valid public HTTPS `X-Rpc-Url`, iterating chainIds. Rate limit (60/min/IP) slows but does not bound growth.
- **Impact:** unbounded heap + V8 timer count on the Deno process → OOM/CPU starvation of a money-moving service.
- **Fix:** `MAX_CHAINS = 256` cap with idle-only eviction (`isChainIdle` = empty mempool + no pending receipts + no locked EOAs) that disposes the evicted chain's timers via a new `BundlerService.dispose()`. A busy chain is never evicted. ([shared/chain/index.ts:49-105](../../shared/chain/index.ts#L49), [shared/bundler/index.ts:174-189](../../shared/bundler/index.ts#L174)).
- **Regression test:** `tests/bundler_service_test.ts` — "dispose() releases timers and is idempotent". (Full registry-flood behavior is validated manually — see [06](06-operations-runbook.md).)
- **Residual:** an attacker can still force create/evict churn (bounded, rate-limited). The Worker analog (DO alarm reschedules unconditionally) is **OPEN** — see [08](08-open-issues.md).

### 2. [P1] No working CI quality gate — FIXED
- **Evidence:** `deno test -A` failed typecheck with **47** errors across `tests/worker_config_test.ts`, `tests/worker_routing_test.ts`, `tests/bundler_service_test.ts`, `tests/handlers_test.ts`, `tests/cors_test.ts`, `tests/rest_api_test.ts` (stale APIs, dead `??`/`never` narrowing). `vitest.config.ts:5` globbed `worker/tests/**` which **never existed** → the entire CF Worker runtime had **zero** executable tests. `deno lint` → 45 problems.
- **Fix:**
  - Fixed all 47 type errors to the current APIs (`Mempool`, `RateLimitConfig`, tier typing) — no production code changed.
  - Fixed the stale `MAX_VERIFICATION_GAS` test ([tests/userop_test.ts](../../tests/userop_test.ts)) and added a boundary-accept test.
  - Created the first real worker suite [worker/tests/worker.test.ts](../../worker/tests/worker.test.ts) (vitest + miniflare): `buildConfig` defaults/overrides + entry routing (CORS, health, `/v1/treasury`, `/v1/splitter`, 405). 9 tests.
  - Cleared all 45 lint problems: fixed production violations properly (unused imports/vars, `catch` bindings, typed viem `Log` instead of `any`); disabled the noisy `require-await` rule project-wide (verified no production `require-await` hides a missing `await`); scoped `no-explicit-any` file-ignores to the two mock-heavy test files only.
- **Verification:** `deno task lint` exit 0; `deno test -A` 409 pass; `npm run test:worker` 9 pass.

### 3. [P2, was P1] `parseValidationData` inverted bit-layout — FIXED
- **Evidence:** [shared/userop/validate.ts:114](../../shared/userop/validate.ts#L114) read `aggregator = data>>96`, `validUntil=bits[48,96)`, `validAfter=bits[0,48)`. Canonical ERC-4337 v0.7 `_packValidationData` is the reverse: `aggregator = low 160 bits`, `validUntil<<160`, `validAfter<<208`, `SIG_VALIDATION_FAILED == 1`. The **consumer** [shared/simulation/index.ts:474-492](../../shared/simulation/index.ts#L474) was already written for the canonical layout (it special-cases `aggregator==0x…01`), so the inverted parser made its sig-fail branch dead and falsely rejected every time-bounded op as "Aggregated signatures not supported".
- **Fix:** rewrote `parseValidationData` to the canonical layout; re-encoded the tests that had baked in the wrong layout to canonical, and added positive guards (sig-fail→`0x01`, time-bounded→`aggregator 0x0`). ([tests/simulation_test.ts](../../tests/simulation_test.ts), [tests/userop_test.ts](../../tests/userop_test.ts), [tests/fixes_test.ts](../../tests/fixes_test.ts)).
- **Why it was only P2:** the ingress execution-sim (`simulateHandleOp`) independently reverts `AA24` on a bad signature, so a sig-failed op never reached the mempool; the live impact was a false-reject of time-bounded ops (likely dormant for this wallet), not fund loss.

### 4. [P2] Tempo reimbursement parser ignored the MultiSend `operation` byte — FIXED
- **Evidence:** [shared/tempo.ts:149](../../shared/tempo.ts#L149) `parseTempoReimbursement` summed feeToken transfers to the EOA but never checked the leading `operation` byte. A **DELEGATECALL** (`operation=1`) to the feeToken with `transfer(EOA, amt)` calldata runs the token's code against the *Safe's* storage — it moves **no** feeToken — yet its face value would be counted as reimbursement, letting a crafted op pass the fail-closed gate while paying the bundler nothing (a Tempo gas drain).
- **Fix:** skip any leg whose `operation != 0` ([shared/tempo.ts:172-183](../../shared/tempo.ts#L172)).
- **Regression test:** `tests/tempo_test.ts` — "SECURITY: ignores a DELEGATECALL leg".

### 5. [P2, was P1] DO cold-start restore of reservation+lock was a silent no-op — FIXED
- **Evidence:** [shared/bundler/index.ts:1036-1039](../../shared/bundler/index.ts#L1036) `importPendingState` called `reserveBalance()` + `lockEOA()` to re-establish the anti-double-spend guard, but a cold-started DO constructs a **fresh, empty** `EOALockManager` ([worker/bundler-do.ts:289](../../worker/bundler-do.ts#L289)) and `addReservation`/`lockEOA` no-op when the state is absent — so nothing was restored.
- **Fix:** new `EOALockManager.restorePending(address, reservedBalance)` that **creates** a `LOCKED_PENDING_UNKNOWN` state carrying the reservation ([shared/account/eoa-lock.ts:187](../../shared/account/eoa-lock.ts#L187)); `importPendingState` now calls it. The restored lock is visible to the health loop for recovery.
- **Regression test:** `tests/bundler_pending_persistence_test.ts` — rewritten to use a **real** `EOALockManager` (the old mock spied on calls and masked the no-op) and assert `getReservedBalance` + `getState().status` + `getLockedEOAs()`.
- **Note:** true double-execution was already prevented by EOA nonce monotonicity; this restores the defense-in-depth accounting guard.

### 6. [P2] No `OPERATOR_SECRET` runtime validation; `hexToBytes` coerced bad hex to 0 — FIXED
- **Evidence:** [deno/config.ts](../../deno/config.ts) / [worker/config.ts](../../worker/config.ts) required the secret to be present but not valid; `deriveTreasuryAddress` runs on the public `/v1/treasury` path **before** any `KeyManager` validation, and [derive.ts `hexToBytes`](../../shared/keys/derive.ts) silently turned non-hex pairs into `0` bytes → a malformed secret produced a wrong-but-non-erroring treasury address and could derive keys from a corrupted secret.
- **Fix:** exported `validateOperatorSecret` (hex + ≥32 bytes), called at the top of `deriveEOAPrivateKey`/`deriveTreasuryPrivateKey` so **every** derivation path fails closed; `hexToBytes` now throws on non-hex ([shared/keys/derive.ts:24-40,180](../../shared/keys/derive.ts#L24)); `LocalKeyManager` reuses the single validator.
- **Regression test:** `tests/keys_test.ts` — rejects empty/non-hex/too-short; boundary 32 bytes accepted.
- **Verified live:** booting with `OPERATOR_SECRET=0x1234` aborts startup with "operatorSecret must be at least 32 bytes … got 2 bytes"; the server does not start.
- **Note:** the SSH deploy path already enforced ≥66 chars ([scripts/deploy.ts:163](../../scripts/deploy.ts#L163)); this closes the `wrangler secret` and direct-`deno` paths.

---

## Open / accepted risks (see [08-open-issues.md](08-open-issues.md) for full detail + fix recipes)

- **[P2] Splitter 50% haircut vs 10% profit floor** ([shared/gas/profitability.ts:74](../../shared/gas/profitability.ts#L74), [evm_contracts/src/VelaGasSettlementSplitter.sol:26](../../evm_contracts/src/VelaGasSettlementSplitter.sol)): on native chains the EOA receives only 50% of the EntryPoint refund but the gate accepts down to 10% margin, so a user-funded EOA can net-erode when base fee rises post-quote. **Not** an operator loss or treasury siphon (treasury take is constant; operator aggregate stays positive). This is an economic-calibration decision (raise `MIN_PROFIT_MARGIN_BPS` to ≥10000 for native, or model the haircut in `checkBundleProfitability`). **Requires an operator decision — left unchanged.**
- **[P3, corrected] Splitter-not-deployed → refund accrues, recovered later (NOT trapped)** ([shared/bundler/index.ts:405](../../shared/bundler/index.ts#L405)): an earlier draft called this trapped/unrecoverable — **incorrect**. The splitter sweeps `address(this).balance` (full balance) to the treasury, so pre-deployment accruals are collected on the first settlement after deployment (CREATE2, deployable any time). Only effect: the EOA gets 0% refund until the splitter exists (its float depletes faster; recovered to treasury). Not a launch blocker; no code guard required.
- **[P2] Deno durability / graceful shutdown** ([deno/main.ts](../../deno/main.ts)): no SIGTERM drain, no pending-receipt persistence (Worker has both). On restart, in-flight receipt tracking is lost; **no fund loss** (nonce monotonicity), only receipt-visibility gaps + a possibly-stuck EOA until the next request/health cycle. (Resolved/N-A after 2026-07-16 Deno removal — Workers-only; DO storage persists in-flight receipts.)
- **[P2] Worker health/metrics unreachable** ([worker/index.ts:38](../../worker/index.ts#L38), [worker/bundler-do.ts:140](../../worker/bundler-do.ts#L140)): global `/health` is static; the DO's real per-chain health is dead code (never routed). Mitigated by the 10s structured heartbeat log ([worker/bundler-do.ts:209](../../worker/bundler-do.ts#L209)) captured by `observability.enabled` in `wrangler.jsonc`.
- **[P2] Circuit-breaker/retry bypass on viem calls**, **slow-RPC serialization**, **SSRF via DNS-rebinding** (bounded read-only), **treasury-depletion invisibility**, **no receipt/mempool persistence** — see [08](08-open-issues.md).

## Overall assessment — `GO`

The core money paths (key derivation, per-EOA locking, profitability gating, trusted-RPC-only
broadcast, fail-closed Tempo reimbursement, durable dropped-tx reconciliation) are **carefully
engineered and hold up under four rounds of adversarial review** — no P0, and the two claimed
fund-loss P1s were refuted. Every real launch blocker is fixed and re-verified: the availability DoS,
the non-functional test/lint gate, the bundler silently blocking a legit user, silent op drops, and a
reconciliation race the hardening itself introduced. Both runtimes now reconcile in-flight bundles
durably, and every operator-intervention state Telegram-alerts (live-verified). The independent review
layer caught 5 real bugs in the fixes — all closed. Remaining items in [08](08-open-issues.md) are P2/P3
enhancements with mitigations, plus one operator pricing tunable (O-1) whose default is correct for a
time-sensitive bot. **No unresolved P0/P1; key paths verified.** Final verdict: **GO** — see the
[index](README.md) for the deploy-hygiene checklist.
