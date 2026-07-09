# 07 — Maintenance Guide

> How to change this codebase without causing a fund-loss or double-submit regression.

## Golden rules

1. **Two runtimes, one core.** Any change under `shared/` affects **both** the Deno server and the CF Worker DO. Always reason about both: Deno is a multi-request single process (in-memory state, timers, no durability); the Worker is one serialized DO per chain (DO-storage durability, alarm-driven). A fix applied to only one runtime is a divergence bug — several past findings were exactly this.
2. **On-chain nonce is the double-submit safety net.** In-memory locks/reservations are optimizations layered on top. Never write code that submits a second `handleOps` for an EOA without either holding `acquireBundleLock` or confirming the nonce advanced.
3. **User `X-Rpc-Url` is read-only, forever.** It may be used for balance/gas/simulation reads only. **Never** sign, broadcast, or move treasury funds over it. Signing/broadcast and the sponsor path must use `config.rpcUrl` (the trusted registry RPC). This is enforced today at [shared/bundler/index.ts:561-568](../../shared/bundler/index.ts#L561) and [shared/rpc/rest-api.ts:183-188](../../shared/rpc/rest-api.ts#L183) — keep it that way.
4. **Fail closed on money paths.** Tempo reimbursement, profitability, balance, and secret validation all reject on uncertainty. Preserve that: a new branch that "assumes success" on an RPC error is a fund-loss vector.
5. **The splitter creation code is a cross-repo contract.** `SPLITTER_CREATION_CODE`/`SALT`/`FACTORY` in [shared/contracts/splitter.ts](../../shared/contracts/splitter.ts) must stay byte-identical to the wallet repo, or the beneficiary address silently diverges and refunds misroute. Regenerate only via `forge inspect` from `evm_contracts/` and update **both** repos + the golden vectors in `tests/splitter_test.ts`.

## Highest-risk files (touch with tests + review)

| File | Why risky |
|------|-----------|
| [shared/bundler/index.ts](../../shared/bundler/index.ts) (1148 LOC) | The submit + reconciliation state machine: locks, reservations, mempool, receipts, two settlement models. Most fund-loss/stuck-EOA risk lives here. |
| [shared/gas/fee-model.ts](../../shared/gas/fee-model.ts) + [profitability.ts](../../shared/gas/profitability.ts) | The "never a loss" invariant. A sign/clamp error loses money on every bundle. Note the invariant is currently only exact at 100% margin on native chains (splitter haircut — see [08](08-open-issues.md)). |
| [shared/account/eoa-lock.ts](../../shared/account/eoa-lock.ts) | Concurrency + nonce recovery. `acquireBundleLock` is only atomic because it is **synchronous** — never introduce an `await` between its check and set. |
| [shared/tempo.ts](../../shared/tempo.ts) | 0x76 tx construction, attodollar/1e12 cost math, reimbursement parsing (now `operation`-byte-aware). |
| [shared/userop/validate.ts](../../shared/userop/validate.ts) | Field validation + `parseValidationData` (now canonical ERC-4337 v0.7 layout — do not "simplify" the bit math). |
| [shared/keys/derive.ts](../../shared/keys/derive.ts) | HKDF derivation. Changing the salt/info format re-keys **every** user EOA and the treasury — an implicit, catastrophic migration. |

## Testing strategy

- **Deno suite (`deno test -A`)** is the primary gate — it typechecks **and** runs. Keep it green: it now compiles cleanly (do not reintroduce stale-API drift). Tests live in `tests/*.ts`.
- **Worker suite (`npm run test:worker`)** runs under vitest + miniflare, tests live in `worker/tests/*.test.ts`. Keep DO-internal logic hermetic: paths that call `resolveChain` hit the network, so test config/routing/pure logic, not full chain init. `deno.json` `test.include` scopes the Deno runner to `tests/` so it does not pick up the vitest files.
- **When fixing a bug, add the regression test first** and confirm it fails against the unpatched code (this pass's `parseValidationData`, `restorePending`, Tempo-delegatecall, and secret-validation tests were all written this way). Prefer tests that assert **effect** against real objects (e.g. a real `EOALockManager`) over tests that spy on a mock — a call-spy test masked the DO-restore no-op for months.
- **Before committing a non-trivial change**, run all three: `deno task lint && deno test -A && npm run test:worker`, then the smoke test in [05](05-deployment-runbook.md).

## Adding a new chain
No code change needed — chains are resolved lazily via `resolveChain` (Alchemy-preferred, awesometools registry). Just ensure the `VelaGasSettlementSplitter` is deployed on that chain (native settlement) and, for Tempo-class chains, that `shared/tempo.ts` recognizes it (`isTempoChain`/`TEMPO_CHAINS`).

## Config & lint conventions
- All tunables are env vars parsed in [deno/config.ts](../../deno/config.ts) / [worker/config.ts](../../worker/config.ts). Keep the two in sync and keep [02-local-development.md](02-local-development.md)'s table accurate — several doc-drift findings came from defaults diverging from docs.
- `require-await` is disabled project-wide (async interface conformance); `no-explicit-any` stays **on** for production and is file-scoped-off only in the two mock-heavy test files. Do not add `any` to `shared/`, `deno/`, or `worker/` code.
