# Vela Bundler — Takeover Documentation

Evidence-based takeover audit. Baseline commit `4beaaef`; audit + fixes dated **2026-07-09**.

> **⚠ 2026-07-16 — Deno runtime removed. Vela Bundler now targets Cloudflare Workers only.**
> The Deno self-hosted server (`deno/`), its systemd/SSH deployment (`deploy/`, `scripts/deploy*`),
> the e2e + homepage-build scripts, and `deno.json`/`deno.lock` were deleted. The former Deno test
> suite (`tests/*_test.ts`) was ported to **vitest** (a Node project for `shared/` logic + a workerd
> pool for `worker/`). Current toolchain:
>
> | Was (Deno) | Now (Node / Workers) |
> |------------|----------------------|
> | `deno task start` / `deno task dev` | `npm run dev` (`wrangler dev`) |
> | `deno task deploy` (SSH + systemd)  | `npm run deploy` (`wrangler deploy`) |
> | `deno task test` / `deno test -A`   | `npm test` (vitest: `node` + `workers` projects) |
> | `deno task lint` (`deno lint && deno check`) | `npm run typecheck` (`tsc --noEmit`) |
> | `deno task e2e` / `deno task build` | removed |
>
> **The audit content below predates this migration** and describes the former dual-runtime
> (Deno + Workers) system. Dated verification snapshots (e.g. "`deno test -A` 444 passed") are
> preserved as historical record — they reflect the pre-migration toolchain, not today's. Where a
> doc gives instructions to run *now*, follow the Workers-only commands above.

| Doc | Contents |
|-----|----------|
| [01-system-overview.md](01-system-overview.md) | What it is, architecture, module map, runtimes, API, the money path |
| [02-local-development.md](02-local-development.md) | From-zero setup, env vars, commands + their **actual** status |
| [03-core-flows.md](03-core-flows.md) | `eth_sendUserOperation` → bundle → settle → reconcile, sponsor flow, invariants |
| [04-production-readiness.md](04-production-readiness.md) | Audit results, severities, what was fixed (with evidence + tests), remaining risk |
| [05-deployment-runbook.md](05-deployment-runbook.md) | Pre-deploy checklist, Deno + Workers deploy/rollback, smoke test, migrations |
| [06-operations-runbook.md](06-operations-runbook.md) | Health/metrics/logs, failure→diagnosis→action table, recovery, DR |
| [07-maintenance-guide.md](07-maintenance-guide.md) | Golden rules, highest-risk files, testing strategy |
| [08-open-issues.md](08-open-issues.md) | Remaining P2/P3 with fix recipes + acceptance criteria |

## Verdict: `GO`

Production-intent, carefully-engineered custodial ERC-4337 bundler. **No unresolved P0/P1**; the two
originally-claimed fund-loss P1s were refuted, and every real launch blocker found across four rounds
of audit is fixed and independently re-verified. Both runtimes (Deno + Cloudflare Workers) now have
**durable in-flight reconciliation**, and every state that requires operator intervention — treasury
low, or a user's money stuck (mempool op not bundling / bundle unconfirmed / EOA locked / RPC circuit
degraded / a user's ops repeatedly failing) — fires a **Telegram alert**, verified with **live delivery**.

**How it was hardened (four rounds, each adversarially re-reviewed):**
1. **P0/P1 fixes** — chain-registry DoS cap; a non-functional test/lint gate made green.
2. **Defensive hardening** — uint128 gas validation, bounded reputation map, byte-accurate body cap,
   Deno graceful shutdown, reachable Worker per-chain health, money-path log redaction.
3. **Money-out robustness** — the operator requirement *"no user's money silently stuck; every
   intervention-worthy state must Telegram-alert."* Added the treasury + operational alerting layer;
   stopped the bundler from hard-banning a legit custodial sender; TTL-dropped ops now yield a terminal
   receipt; Tempo gas accounts are re-sponsorable.
4. **Reconciliation unification** — Deno now uses the same durable pending-receipt reconciliation as
   the Worker (removing the runtime-specific limitation). The review caught a concurrency race this
   introduced; it was fixed (reentrancy + snapshot + live-array filter) with a deterministic test and
   re-reviewed clean.

The independent multi-agent review layer caught **5 real bugs in my own fixes** across the session
(a soft reputation cap, a `/health` chainId bug, a Telegram-token log leak, and a reconciliation race)
— all fixed and regression-tested. That is why this is a GO you can trust, not a hopeful one.

**Verification at close:** `deno task lint` exit 0 · `deno test -A` **444 passed / 0 failed** ·
`npm run test:worker` **10 passed** · `deno task e2e` **26/26** (accuracy / reliability / stability /
performance + **live Telegram delivery**) · plus the original Deno smoke test (health, treasury,
JSON-RPC, SSRF-block, batch-cap, weak-secret-reject).

**Standard deploy hygiene (not code blockers), before flipping prod traffic:**
1. Set secrets in the production environment: `OPERATOR_SECRET` (required) and `TELEGRAM_BOT_TOKEN` +
   `TELEGRAM_CHAT_ID` (for alerting) — via `wrangler secret put` (Workers) or the systemd env file (Deno).
2. Run the smoke test (`deno task e2e` locally, or the `curl` checks in [05](05-deployment-runbook.md))
   against the deployed URL as the first post-deploy step.
3. Optional pricing choice: the native-chain profit floor vs the splitter's 50% share is a tunable
   (`MIN_PROFIT_MARGIN_BPS`); the default correctly favors tx inclusion for a time-sensitive bot — see
   [08](08-open-issues.md) O-1.

> The splitter does **not** need to be pre-deployed per chain — pre-deployment refunds sweep entirely
> to the treasury on the first settlement after it is deployed (`receive()` forwards
> `address(this).balance`). Not a blocker.

Verification at audit close: `deno task lint` exit 0 · `deno test -A` 409 passed / 0 failed ·
`npm run test:worker` 9 passed · live smoke test (health, treasury, JSON-RPC, SSRF-block,
batch-cap, weak-secret-reject) all pass.
