# 02 — Local Development

> Verified on the takeover machine (macOS, Deno + Node/npm installed) at commit `4beaaef`.
> Command results below are **actual runs**, not copied from the README.

## Prerequisites

- **Node.js + npm** — the entire runtime toolchain: `wrangler` (`npm run dev` / `npm run deploy`) and `vitest` (all tests). `package.json` pins viem `^2.52.2`.
- **Foundry** (`forge`) — only if you need to rebuild the splitter contract bytecode. Not required to run the bundler.
- No database, no Redis, no external infra to run locally.

## Environment variables

Only **`OPERATOR_SECRET`** is strictly required. The treasury address is **derived** from it — it is
never read from the environment (treasury is always derived; `GET /v1/treasury` returns it). See
[worker/config.ts](../../worker/config.ts) and [shared/keys/derive.ts](../../shared/keys/derive.ts).

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `OPERATOR_SECRET` | **yes** | — | Hex secret; **all** user EOA private keys + the treasury key derive from it. See the warning below. |
| `ALCHEMY_API_KEY` | no | — | Enables preferred Alchemy RPCs. |
| `OLD_OPERATOR_SECRETS` | no | — | Comma-separated; old secrets kept derivable for draining rotated EOAs. |
| `ENTRY_POINT_ADDRESS` | no | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | EntryPoint v0.7. |
| `PORT` / `HOST` | no | `3300` / `0.0.0.0` | Deno server only — N-A on Workers (no listen port). |
| `BUNDLING_MODE` | no | `auto` | `auto` or `manual`. |
| `MAX_BUNDLE_SIZE` / `MAX_BUNDLE_GAS` | no | `10` / `5000000` | |
| `AUTO_BUNDLE_INTERVAL_MS` | no | `10000` | |
| `MIN_PROFIT_MARGIN_BPS` / `MAX_PROFIT_MARGIN_BPS` | no | `1000` / `15000` | Profitability gate for native chains. |
| `WALLET_GAS_MARGIN_PERCENT` | no | `100` | Relayer markup; user pays ~2× network fee at default. |
| `USE_EIP1559`, `BASE_FEE_MULTIPLIER`, `BUNDLER_TIP_GWEI`, `MIN_PRIORITY_FEE_PER_GAS` | no | `true`, `1.25`, `0.5`, `0` | Gas pricing. |
| `API_RATE_LIMIT_PER_MINUTE` | no | `60` | Per-IP. |
| `BALANCE_RESERVE_MULTIPLIER` | no | `1` (Deno loader) | ⚠️ README says `2`; the Deno loader default is `1` ([deno/config.ts:78](../../deno/config.ts#L78)). Documented drift — see [04](04-production-readiness.md). |

> ⚠️ **`OPERATOR_SECRET` is the root of all fund custody.** Anyone who learns it can derive every
> user's EOA private key and the treasury key, and drain all funds on all chains. Generate ≥32 bytes
> from a CSPRNG, store it only in the secret manager / `wrangler secret`, and never commit it. The
> loader does **not** currently validate its length/entropy — see [04](04-production-readiness.md) P1.

`.env` is gitignored; only `.env.example` is tracked. The `.env` that briefly appeared in git history
(commits `53020de`/`62b91d4`) contained the documented `0xdeadbeef…` placeholder, **not a real secret**
(verified by hashing the historical value against `.env.example`).

## Run — Cloudflare Workers

Cloudflare Workers (Durable Objects) is the only runtime. `npm run dev` boots `wrangler dev`, which
serves on `localhost:8787`; `npm run deploy` runs `npx wrangler deploy`. Secrets are set with
`npx wrangler secret put …`.

```bash
npm install
npx wrangler secret put OPERATOR_SECRET
npx wrangler secret put ALCHEMY_API_KEY      # optional
npx wrangler secret put TELEGRAM_BOT_TOKEN   # optional — enables treasury/ops alerting
npx wrangler secret put TELEGRAM_CHAT_ID     # optional
npm run dev        # wrangler dev — serves on localhost:8787
npm run deploy     # npx wrangler deploy
```

Smoke check (against `npm run dev` on `:8787`):

```bash
curl -s localhost:8787/health | jq
curl -s localhost:8787/v1/treasury | jq
# JSON-RPC (chainId in path):
curl -s -X POST localhost:8787/1 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

## Commands & their ACTUAL status (commit `4beaaef`)

| Command | What it does | Status as of takeover |
|---------|--------------|-----------------------|
| `deno task test` | `deno test -A` (typechecks then runs) | **FAILS** — see below |
| `deno test -A --no-check` | run tests without typecheck | **1 failure** / 401 pass / 5 ignored |
| `deno task lint` | `deno lint && deno check deno/main.ts` | **FAILS** — 45 lint problems |
| `npm run test:worker` | `vitest run` | **FAILS (exit 1)** — "No test files found" |
| `deno task build` | build homepage HTML from README | not exercised |
| `deno check deno/main.ts` | typecheck the Deno entry only | passes |
| `deno task e2e` | boot the local Deno server + run the e2e harness | **23/23 pass** (accuracy/reliability/stability/performance; alerting live-send when Telegram creds set) |

### E2E harness (`deno task e2e`)
[scripts/e2e.ts](../../scripts/e2e.ts) boots `deno/main.ts` on a test port and runs four dimensions an SRE would gate on — **accuracy** (correct responses, deterministic derivations), **reliability** (SSRF/caps/bad-input rejection), **stability** (sustained load leaves the process healthy), **performance** (latency/throughput). It raises the per-IP rate limit for the run so stability/perf measure real capacity (the limiter itself is covered by `tests/rate_limit_test.ts`). If `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are in `.env`, it also fires one **live** treasury alert to confirm end-to-end delivery; otherwise that check is skipped. Exit code is non-zero on any failure.

### Known-red details (baseline, pre-fix)

1. **`deno task test` typecheck failure**: 27 TypeScript errors, all in `tests/worker_config_test.ts` and `tests/worker_routing_test.ts` (dead `??` comparisons on string literals, `never`-narrowing on empty-string literals, implicit `any`). These tests inline-reimplement config parsing rather than exercising the real code.
2. **1 runtime test failure**: `tests/userop_test.ts:157` ("rejects verificationGasLimit over MAX") asserts `3_000_000n` is rejected, but `MAX_VERIFICATION_GAS` was raised to `5_000_000n` (commit `1a1245b`). The test is **stale**; the code is correct.
3. **`npm run test:worker` finds nothing**: `vitest.config.ts` globs `worker/tests/**/*.test.ts`, a directory that **has never existed** in git history. The entire Cloudflare Worker runtime (`BundlerDO`) has **zero automated tests**.
4. **45 `deno lint` problems**: 21 `require-await`, 13 `no-unused-vars`, 9 `no-explicit-any`, 1 `prefer-const`, 1 `no-import-prefix`.

> These are tracked with fixes in [04-production-readiness.md](04-production-readiness.md) and
> [08-open-issues.md](08-open-issues.md). CI cannot be trusted green until 1–3 are resolved.

## Test layout

Tests run under **vitest** in two projects (see [`vitest.workspace.ts`](../../vitest.workspace.ts)).
The **node** project covers the shared core in `tests/*.ts` (account, bundler, gas, fee model,
mempool, rate limit, rpc security/resolution, simulation, tempo, userop, reliability, splitter,
CORS, body cap); the **workers** project runs the Worker / Durable-Object adapter tests in
`worker/tests/**` under the real `workerd` pool (miniflare). `npm test` runs both projects;
`npm run test:node` / `npm run test:worker` run one. See
[07-maintenance-guide.md](07-maintenance-guide.md) for the testing strategy.
