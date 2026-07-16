# 05 — Deployment Runbook

> Cloudflare Workers only (Durable Objects). Commands verified against the repo at
> commit `4beaaef` + this pass's changes.

## Pre-deploy checklist

1. `npm run typecheck` → exit 0. (Was `deno task lint`; typecheck is now the gate — there is no separate style-linter.)
2. `npm test` → 0 failed — runs both vitest projects: `node` (shared/ logic) and `workers` (worker/ runtime). (Was `deno test -A` + `npm run test:worker`.)
3. `OPERATOR_SECRET` is a ≥32-byte CSPRNG hex value, stored only in the target's secret store. **Never** commit it. Startup now fails closed on a short/malformed secret.
4. Decide `MIN_PROFIT_MARGIN_BPS` for native chains — see the splitter-haircut open issue in [08](08-open-issues.md). The shipped default (1000 = 10%) under-provisions the never-a-loss invariant when the beneficiary is the splitter.
5. **The `VelaGasSettlementSplitter` must be deployed** on each native chain you serve (CREATE2, same address everywhere) before native settlement routes to it, or gas refunds are trapped. Confirm with `GET /v1/splitter` (returns the deterministic address) and an on-chain `eth_getCode` at that address. The wallet normally deploys it in its first batch.

## Deploy (Cloudflare Workers)

Cloudflare Workers is the only deployment target — no self-hosted server, systemd, or SSH deploy.

```bash
npm install
npx wrangler secret put OPERATOR_SECRET     # required
npx wrangler secret put ALCHEMY_API_KEY      # optional
npm run deploy                                # npx wrangler deploy
```

Facts ([wrangler.jsonc](../../wrangler.jsonc)):
- One `BundlerDO` Durable Object **per chain**, created on first `POST /:chainId`.
- Migration tag `v1` declares `BundlerDO` (`new_classes`). Adding a DO class later needs a new migration tag.
- Auto-bundling/reconciliation/decay run on a persisted **10s alarm** — no cron needed.
- `observability.enabled=true` + `logs.enabled=true` → structured logs (incl. the per-cycle heartbeat) are queryable in Cloudflare Workers Logs.

### Rollback (Workers)
```bash
npx wrangler rollback        # revert to the previous deployment
```
DO storage (persisted `chainId`, `pendingReceipts`, `lastDecayAt`) survives a code rollback. A DO **migration** that deletes/renames a class is destructive and NOT covered by `wrangler rollback` — avoid unless you have a migration plan.

## Post-deploy smoke test (run against the live base URL)

```bash
BASE=https://<your-host>            # your workers.dev subdomain or custom route
curl -s $BASE/health | jq          # {"status":"ok", ...}
curl -s $BASE/v1/treasury | jq     # derived treasury address
curl -s $BASE/v1/splitter | jq     # splitter address + derivation inputs
curl -s -X POST $BASE/1 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'   # {"result":"0x1"}
# Security controls (both must be rejected):
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/1 \
  -H 'X-Rpc-Url: https://169.254.169.254/' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'   # 400 (SSRF blocked)
```

These exact checks were run locally this pass and passed (health, treasury, `eth_chainId`, `eth_supportedEntryPoints`, SSRF→400, batch>20→400, weak-secret→startup abort).

## Data migration

**None.** The service has no database or schema. "Migration" only ever means a Cloudflare DO class migration (`wrangler.jsonc` `migrations`), which is code-shape, not data. There is no backup/restore because there is no persistent business data — all state is either derived from `OPERATOR_SECRET` or reconstructable from chain.
