# 06 — Operations Runbook

> How to observe, diagnose, and recover the running bundler. Reflects the code at this pass.

## What to watch

### Health endpoints
- `GET /health` returns only a **static** `{status:"ok"}` — the per-chain DO health is currently **not reachable** (open issue). Use logs instead (below).

> ⚠️ `/health` always returns **HTTP 200** even when `status:"degraded"`. Alert on the JSON `status` field / the metrics, not the HTTP code.

### Structured heartbeat (the primary Worker signal)
Every alarm cycle (~10s) the DO emits a structured `logEvent` `operation:"alarm_heartbeat"` with `mempool_size`, `mempool_oldest_age_ms`, `locked_eoas`, `pending_receipts`, `pending_receipt_oldest_age_ms`, `circuit_degraded` — escalated to `warn` when EOAs are locked or the mempool is stale ([worker/bundler-do.ts:209-215](../../worker/bundler-do.ts#L209)). Captured by `observability` in `wrangler.jsonc`; query in Cloudflare Workers Logs.

### Metrics
`metrics` counters/gauges (`bundle_submit_total`, `pending_receipt_abandoned_total`, `mempool_size`, `locked_eoas`, `pending_receipts`, …) are recorded in-process. **There is no `/metrics` scrape endpoint** — they are only visible via the heartbeat log. (Adding a metrics endpoint is an open item — [08](08-open-issues.md).)

### Telegram alerting — the "developer must intervene" signal
When `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are configured, the Worker runs two monitors in the
health loop (~10s), each firing **de-duplicated** alerts (once per 30 min per chain
per condition). Every alert corresponds to a state where **a developer or operator must act** —
either the treasury needs funding, or a user's money is stuck. Unconfigured → no-op. Monitors only
cover chains that have been initialized by a request.

**1. Treasury monitor** ([shared/monitoring/treasury.ts](../../shared/monitoring/treasury.ts)) — "needs funding":
sends an alert when an active chain's treasury drops below `TREASURY_ALERT_THRESHOLD_WEI` (native) /
`TREASURY_ALERT_THRESHOLD_PATHUSD` (Tempo). Below this, sponsorship fails closed.

**2. Operational monitor** ([shared/monitoring/operational.ts](../../shared/monitoring/operational.ts)) —
"a user's money is stuck", alerts on any of:
| Condition | Meaning | Default threshold | Likely cause |
|-----------|---------|-------------------|--------------|
| `stuck-mempool-<chain>` | a UserOp accepted but not being bundled | oldest mempool age > 2 min | RPC down, unprofitable pricing, EOA balance too low |
| `stuck-pending-<chain>` | a bundle broadcast but not confirming | oldest pending receipt > 5 min | underpriced/dropped tx |
| `stuck-eoa-<chain>` | a dedicated EOA stuck `LOCKED_PENDING_UNKNOWN` | oldest lock age > 3 min | RPC without reliable `pending` nonce; needs resubmit |
| `circuit-degraded-<chain>` | RPC circuit breaker degraded | any degraded endpoint | upstream RPC/Alchemy outage |

Thresholds live in `DEFAULT_OPERATIONAL_THRESHOLDS` ([operational.ts](../../shared/monitoring/operational.ts)).
Each alert message states what is stuck, where, for how long, and the likely cause. The
monitoring/alert logic is covered by the vitest suite (`npm test`); the former live end-to-end probe
(`deno task e2e`, which sent a real alert to your chat) was removed in the 2026-07-16 migration.

### Log signals to alert on
- `LOCKED_PENDING_UNKNOWN` persisting across many cycles for the same EOA → stuck settlement.
- `[Bundler] Tx … dropped` → a broadcast tx fell out of the mempool (repricing/underpriced).
- `[Bundler][Tempo] REJECT — reimbursement … < cost` → users being quoted too low, or feeToken mismatch.
- `[ChainRegistry] At capacity … no idle chain to evict` → chainId flood or genuine chain-count pressure.
- `[ChainRegistry] Evicted idle chain …` at high frequency → chainId-flood churn (expected to be bounded/rate-limited).
- `circuit.degraded > 0` in health/heartbeat → an RPC endpoint is failing; failover in effect.

## Secrets in logs — what is and isn't safe
- RPC URLs are **redacted** before logging (`redactUrl`/`redactRpcUrl` strip API keys). ([shared/reliability/log.ts], [worker/bundler-do.ts:65](../../worker/bundler-do.ts#L65))
- **Do not add logs that print `OPERATOR_SECRET`, any derived private key, or an un-redacted RPC URL.** Treasury/EOA **addresses** are safe to log; keys are not. (One P3 finding notes raw `console.error(viemError)` can still leak an Alchemy URL in a stack — prefer `redactUrl` — see [08](08-open-issues.md).)

## Common failures → diagnosis → action

| Symptom | Likely cause | Diagnose | Action |
|---------|--------------|----------|--------|
| An EOA stuck `LOCKED_PENDING_UNKNOWN` | Broadcast tx pending/dropped; or RPC lacks reliable `pending` nonce | Check chain nonce (`latest` vs `pending`) for the EOA; check pending receipts | Health loop retries every ~10s. If the tx confirmed, next `initEOA` unlocks it. If truly stuck, verify the RPC supports `pending`; consider a better RPC. |
| Client polls receipt forever → null | Deno restarted mid-flight (no receipt persistence) — N-A after 2026-07-16 Deno removal (on Workers, in-flight receipts persist in DO storage across eviction) | Check restart time vs submit time; check chain for the actual tx | The on-chain tx still lands; tell client to re-query by tx hash / resubmit (nonce-safe). |
| Users report "unprofitable"/"insufficient balance" rejects | Base fee rose after quote; or margin misconfigured | Look for `Unprofitable`/`Insufficient balance` logs | Expected under volatility. Review `MIN/MAX_PROFIT_MARGIN_BPS`, `BALANCE_RESERVE_MULTIPLIER`. See splitter-haircut issue for native chains. |
| Treasury slowly draining | Sponsorships + gas | **Telegram alert** now fires when the treasury on an active chain drops below `TREASURY_ALERT_THRESHOLD_WEI` (native) / `TREASURY_ALERT_THRESHOLD_PATHUSD` (Tempo). Also query `GET /v1/treasury` → `eth_getBalance`. | Top up the treasury. If no alert arrived, confirm `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` are set and the chain is active (monitor only runs for chains that have been initialized). |
| Native gas refunds "disappearing" | Splitter not deployed on that chain | `eth_getCode` at `GET /v1/splitter` address | Deploy the splitter (CREATE2 via the Arachnid factory). Trapped funds at an undeployed address are unrecoverable — deploy BEFORE routing. |
| Memory/CPU climbing | chainId flood (now capped at 256) or mempool growth | `/health.activeChains`, RSS, timer count | The `MAX_CHAINS` cap bounds it; if legitimately serving >256 chains, raise the cap. |
| All RPCs for a chain down | Upstream outage | `circuit.degraded`, repeated RPC errors | Failover order is header > Alchemy > registry public RPCs; add `ALCHEMY_API_KEY` or a healthy `X-Rpc-Url`. Bundling defers (keeps ops) rather than dropping. |

## Recovery procedures
- **Stuck EOAs:** no manual action normally needed — the health loop (`recoverLockedEOAs` → `tryRecoverEOA` → `initEOA`) recovers them once the chain nonce settles. On Deno, recovery only fires when the EOA has in-memory state; after a restart it fires on the next request for that safe. (N-A after 2026-07-16 Deno removal: on Workers the DO restores in-flight EOA state from storage, so recovery resumes automatically after eviction — see the Worker restart/eviction note below.)
- **Restart (Deno):** safe at any time (systemd `Restart=on-failure`). In-flight receipt tracking is lost; on-chain txs are unaffected. (N-A after 2026-07-16 Deno removal: Cloudflare Workers has no self-hosted process or systemd to restart — see the Worker restart/eviction note below.)
- **Restart/eviction (Worker):** DO restores `chainId` + `pendingReceipts` from storage and **re-locks/re-reserves** the in-flight EOAs (fixed this pass) so reconciliation resumes.
- **Secret rotation:** see README "Secret Rotation" — new secret → new EOAs; old EOAs remain derivable from `OLD_OPERATOR_SECRETS`. **Draining old EOAs is a manual, out-of-band step (no in-repo tool).** Do not discard an old secret until its EOAs are empty.

## Disaster recovery
There is no stateful datastore to restore. Full recovery = redeploy the code + set the **same** `OPERATOR_SECRET`. All EOA/treasury keys and addresses are deterministically re-derived; balances live on-chain. Losing `OPERATOR_SECRET` = losing custody of every EOA and the treasury — back it up as your only irreplaceable asset.
