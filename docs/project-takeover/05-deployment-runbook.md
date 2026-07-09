# 05 — Deployment Runbook

> Two deployment targets. Pick one per environment. Commands verified against the repo at
> commit `4beaaef` + this pass's changes.

## Pre-deploy checklist (both targets)

1. `deno task lint` → exit 0.
2. `deno test -A` → 0 failed (409 passed / 5 ignored at this pass).
3. `npm run test:worker` → 0 failed (9 passed) — required if deploying the Worker target.
4. `OPERATOR_SECRET` is a ≥32-byte CSPRNG hex value, stored only in the target's secret store. **Never** commit it. Startup now fails closed on a short/malformed secret.
5. Decide `MIN_PROFIT_MARGIN_BPS` for native chains — see the splitter-haircut open issue in [08](08-open-issues.md). The shipped default (1000 = 10%) under-provisions the never-a-loss invariant when the beneficiary is the splitter.
6. **The `VelaGasSettlementSplitter` must be deployed** on each native chain you serve (CREATE2, same address everywhere) before native settlement routes to it, or gas refunds are trapped. Confirm with `GET /v1/splitter` (returns the deterministic address) and an on-chain `eth_getCode` at that address. The wallet normally deploys it in its first batch.

## Target A — Deno (self-hosted, systemd)

The interactive deployer handles remote provisioning end-to-end over SSH.

```bash
deno task deploy            # interactive: pick/add target, upload release, activate
deno task deploy status     # systemctl status + current release + recent releases + health
deno task deploy rollback   # swap the `current` symlink to the previous release
```

What `deno task deploy` does ([scripts/deploy.ts](../../scripts/deploy.ts)):
1. Prompts for/persists an SSH target; primes the connection.
2. Installs Deno on the remote if missing; ensures the `vela` service user + directories.
3. Ensures `/opt/vela-bundler/data/vela.env` — **validates `OPERATOR_SECRET` is `0x…` and ≥66 chars** at this step (`scripts/deploy.ts:163`).
4. Installs a sudoers entry, uploads the release tar to `/opt/vela-bundler/releases/<tag>`.
5. Installs the systemd unit ([deploy/systemd/vela-bundler.service](../../deploy/systemd/vela-bundler.service)), `daemon-reload`, `enable`.
6. Swaps the `current` symlink → new release, `systemctl restart`.
7. **Health-gates**: polls `http://127.0.0.1:3300/health` up to 15×2s, looking for `"ok"`.

Service facts:
- Runs `deno task start` as user `vela`, `WorkingDirectory=/opt/vela-bundler/current`, `EnvironmentFile=/opt/vela-bundler/data/vela.env`.
- Hardened: `ProtectSystem=strict`, `NoNewPrivileges`, `MemoryMax=1G`/`MemoryHigh=800M`, `Restart=on-failure` (`StartLimitBurst=5`/`60s`).
- Logs to journald (`journalctl -u vela-bundler`).

### Rollback (Deno)
```bash
deno task deploy rollback     # atomic symlink swap to previous release + restart
```
No database → no data migration to reverse. In-memory state (mempool, reservations) is lost across the restart; this is safe (see the "conservative restart" invariant in [03](03-core-flows.md)) but in-flight receipts for the instant of restart are not persisted (Deno) — clients re-poll/resubmit.

## Target B — Cloudflare Workers

```bash
npm install
npx wrangler secret put OPERATOR_SECRET     # required
npx wrangler secret put ALCHEMY_API_KEY      # optional
npm run deploy                                # wrangler deploy
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
BASE=https://<your-host>            # Deno: http://host:3300 ; Workers: your workers.dev/route
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
