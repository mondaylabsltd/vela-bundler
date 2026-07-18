# Vela Bundler

ERC-4337 / ERC-7769 multi-chain bundler for EntryPoint v0.7.

Supports any EVM network listed at [ethereum-data.awesometools.dev](https://ethereum-data.awesometools.dev/).

Runs on **Cloudflare Workers** (Durable Objects, edge).

## Quick Start

```bash
npm install

# secrets (encrypted store; also settable in .dev.vars for local dev)
npx wrangler secret put OPERATOR_SECRET     # required — 32+ byte hex, derives every EOA + treasury
npx wrangler secret put ALCHEMY_API_KEY     # recommended — preferred (paid) RPC
npx wrangler secret put TELEGRAM_BOT_TOKEN  # set both in prod — operator alerts
npx wrangler secret put TELEGRAM_CHAT_ID

npm run dev                                 # local dev → wrangler.jsonc (the production shape)
npm run deploy                              # deploy → see the queue prerequisite under Deployment
```

Any EVM chain is supported automatically — the first request for a chain creates its Durable Object.

**Two local configs:** `npm run dev` uses `wrangler.jsonc` (exactly what production runs). `npx wrangler dev -c wrangler.dev.jsonc` forces pool+queue on with a fully miniflare-emulated queue/KV — use it to exercise the Stage-3/4 transport in isolation.

## How It Works

- **In-band gas settlement** (all EVM chains): a bundler-controlled EOA fronts the native gas for `handleOps`; the UserOp batches an in-band transfer that repays it. The wallet quotes/signs **3× the real gas**; the bundler gate accepts **≥ 2×** (stablecoins floored at ~$0.01-equiv, native has no floor). In **vault** mode the reimbursement + the EntryPoint beneficiary are the **treasury**, and the fronting EOA's native float is refilled from the treasury on demand.
- **Two transports, flag-gated** (`POOL_EOA_ENABLED` / `QUEUE_TRANSPORT_ENABLED`, per-chain):
  - **Per-safe** (default): each safe has a dedicated EOA `deriveEOA(sender)`; the chain DO bundles it directly.
  - **Pool + queue** (Stage 3/4): a **100-EOA HKDF pool** (same address on every chain, no chainId) + a Cloudflare Queue; each `(chain, pool index)` is its own **RelayerDO** whose input gate is the per-EOA lock.

No external database — money-path state (accepted ops, in-flight receipts, terminal receipts, dead-man registrations) is persisted in per-chain / per-index Durable Object storage; the rest is derived or in-memory.

## Transaction Lifecycle

Where a UserOp flows and how each failure is handled. Watch any op live at **`GET /debug`** (enter chainId + hash); fleet balances (treasury + 100 pool EOAs per chain) are on the same page.

```
 WALLET ──POST /:chainId──▶ Worker ──idFromName(chain-N)──▶ BundlerDO (one per chain)

 1. INGRESS  handleSendUserOperation
    validate → simulate validation → simulate execution (eth_simulateV1) → gas price
    → in-band reimbursement gate (≥2× real gas; stablecoins floored at $0.01)
    ✗ reject → synchronous JSON-RPC error to the wallet (nothing stored)

 2. ACCEPT  acceptUserOp — transport is flag-gated:
    ├─ QUEUE off ─▶ DO mempool  (persisted mp:<hash>)  ── kicks the alarm
    └─ QUEUE on  ─▶ Cloudflare Queue + KV 'accepted' marker
                     └─ consumer routes hash(sender)%100 ─▶ RelayerDO /submit
                          └─▶ RelayerDO mempool  (persisted mp:<hash>)
       ✗ queue send ambiguous → NOT dropped (wallet retries, deduped)   ✗ unbound → mempool fallback

 3. BUNDLE  ~10s alarm → kickBundle → build ONE handleOps
    select ops → simulate bundle → in-band gate → sign with the FRONTING EOA
    (per-safe: deriveEOA(sender) · pool: pool EOA #i) → broadcast → PENDING receipt (persisted)
    ✗ EOA can't afford gas → KEEP the op, flag the EOA, refill it from the treasury, retry each alarm
    ✗ one op underpays (pool) → drop only that op (failed receipt), reassemble the survivors

 4. RECONCILE  alarm → checkPendingReceipts
    confirmed → TERMINAL receipt (success) → rc:<hash> (+ KV in queue mode) → wallet reads it
    ✗ reverted / no UserOperationEvent → TERMINAL failed receipt
    ✗ underpriced / stuck             → fee-bump (≤2×) → same-nonce CANCELLATION (unbricks the EOA)
    ✗ dropped (nonce consumed, no rcpt) → TERMINAL failed receipt
```

**Failure / retry summary**

| Situation | Handling | Bound |
|---|---|---|
| Fronting EOA out of gas | keep op · refill EOA from treasury (sized to the bundle's gas) · retry | 5-min mempool TTL |
| Mempool TTL reached | evict → terminal **failed** receipt (wallet resubmits) | 5 min |
| Tx stuck / underpriced | fee-bump ≤2× → same-nonce cancellation | ~1h abandonment |
| Treasury can't fund the EOA | defer + `float-topup-depleted` alert; self-heals on top-up | — |
| Queue delivery fails (queue mode) | CF retries ×3 → **DLQ** consumer writes a failed receipt + pages | 3 retries |
| RelayerDO alarm dies (queue mode) | 5-min cron dead-man probe re-arms + alerts | 5-min cron |

Every money-stuck condition (stuck mempool, unconfirmed bundle, locked EOA, underfunded EOA, DLQ arrival, degraded pricing) fires a de-duplicated **Telegram alert**. Durable state survives DO eviction; a 5-minute liveness cron revives any broken alarm chain (chain DO **and** RelayerDOs).

## Architecture

```
shared/              Platform-agnostic bundler logic (consumed by the worker)
├── config/          Configuration types + chain registry + Alchemy
├── keys/            Deterministic key derivation (HKDF-SHA256)
├── account/         Per-EOA balance, reservations, lock management
├── auth/            Rate limiting
├── contracts/       EntryPoint v0.7 ABI, constants, error codes
├── userop/          UserOperation types, packing, hashing, validation
├── gas/             preVerificationGas, profitability model
├── simulation/      simulateValidation + bundle simulation
├── mempool/         In-memory mempool with reputation tracking
├── bundler/         Bundle building, submission, receipt reconciliation
├── chain/           Per-chain service registry (lazy init + health loop)
├── rpc/             JSON-RPC handlers + REST API + request processing
└── utils/           Hex utilities, RPC client factory

worker/              Cloudflare Workers runtime
├── index.ts         Fetch handler + queue consumer + DLQ + /debug routes
├── bundler-do.ts    BundlerDO — one Durable Object per chain
├── relayer-do.ts    RelayerDO — one per (chain, pool index) for queue transport
├── producer.ts      Queue enqueue hook (ingress → USEROP_QUEUE + KV marker)
├── debug-page.ts    /debug observability UI (self-contained HTML)
├── config.ts        Env-based config (CF bindings)
└── types.ts         Env interface

tests/               shared/ unit tests (vitest, node project)
worker/tests/        worker/ runtime tests (vitest, workerd pool)
```

## Deployment

```bash
npm install
npm run dev                # Local dev (wrangler dev)
npm run deploy             # Deploy to Cloudflare (wrangler deploy)
npm run typecheck          # tsc --noEmit
npm test                   # All tests (node + workers vitest projects)
npm run test:node          # shared/ unit tests only
npm run test:worker        # worker/ runtime tests only (vitest + miniflare)
```

**Secrets** (set via `npx wrangler secret put`):

- `OPERATOR_SECRET` — required
- `ALCHEMY_API_KEY` — recommended, for preferred RPCs
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — set both in production for operator alerts

**Deploy prerequisite (queue transport):** when `QUEUE_TRANSPORT_ENABLED` covers any chain, the queues must exist remotely before `wrangler deploy` (local `wrangler dev` auto-creates them via miniflare):

```bash
wrangler queues create vela-userops
wrangler queues create vela-userops-dlq
# USEROP_STATUS KV: the id in wrangler.jsonc must exist — `wrangler kv namespace list`
```

Also ensure each active chain's **treasury holds native ETH** — the pool EOAs front gas and refill from it.

**How it works**: Each chain gets a `BundlerDO` (created on first request) holding its mempool, EOA locks, reputation, and alarm-driven auto-bundling. Requests route `POST /:chainId` → `env.BUNDLER.idFromName("chain-${chainId}")`. In **queue mode** ingress instead enqueues to `USEROP_QUEUE`; the consumer routes `hash(sender)%100` to a per-index `RelayerDO`, each pinned to one pool EOA (its input gate is that EOA's lock). DO alarms persist across eviction; every activated chain self-registers with a `chain-registry` DO, and a 5-minute cron probes each registered chain **and each stranded RelayerDO** (storage-only) to revive a broken alarm chain — zero per-chain configuration. Fully idle chains stop their alarm after ~5 minutes and wake instantly on the next accepted op.

## Key Derivation

```
HKDF-SHA256(
  IKM  = operatorSecret,
  salt = "vela-bundler-dedicated-eoa-v1",
  info = "chainId={id}|entryPoint={addr}|safeAddress={addr}",
  L    = 32 bytes
) → secp256k1 private key → Ethereum address
```

Treasury address is also derived from `operatorSecret` (same on all chains).

## RPC URL Priority


| Priority | Source             | Scope                                     |
| ---------- | -------------------- | ------------------------------------------- |
| 1        | `X-Rpc-Url` header | Per-request                               |
| 2        | Alchemy RPC        | If`ALCHEMY_API_KEY` set + chain supported |
| 3        | Chain registry     | Public RPCs, health-checked               |

For **gas-price reads**, when the primary is the paid managed (Alchemy) RPC it is the *sole* authority — no public-RPC fallback (they can be flaky or return a different price the user then signs). Public fallback applies only when the primary is itself a public/user-supplied RPC. State-override simulation likewise stays on the managed RPC.

## API

> **Full contract:** [`docs/api-contract.md`](docs/api-contract.md) is the authoritative,
> type-level reference (every request/response shape, error code, and envelope rule) — the
> pin a refactor must preserve. The tables below are the summary.

### JSON-RPC: `POST /:chainId`


| Method                              | Description                                             |
| ------------------------------------- | -------------------------------------------------------- |
| `eth_sendUserOperation`             | Submit UserOp (checks balance, binding, profitability) |
| `eth_estimateUserOperationGas`      | Estimate gas limits                                    |
| `eth_getUserOperationByHash`        | Get UserOp by hash                                     |
| `eth_getUserOperationReceipt`       | Get receipt                                             |
| `eth_supportedEntryPoints`          | List EntryPoints                                       |
| `eth_chainId`                       | Chain ID                                               |
| `pimlico_getUserOperationGasPrice`  | 3-tier gas price quote (network/relayer split)         |
| `vela_getInBandGasQuote`            | In-band gas reimbursement sizing (native / stablecoin) |

All methods support `X-Rpc-Url` header. Batch requests capped at 20.

### REST API


| Endpoint                            | Method | Description                                          |
| ------------------------------------- | -------- | ----------------------------------------------------- |
| `/v1/account/:chainId/:safeAddress` | GET    | Account info (fronting EOA, balance, nonce, status)  |
| `/v1/treasury`                      | GET    | Treasury address                                     |
| `/v1/treasury/:chainId`             | GET    | Per-chain treasury balance + `bootstrapNeeded`       |
| `/v1/splitter`                      | GET    | Settlement splitter address + derivation inputs      |
| `/v1/sponsor/:chainId/:safeAddress` | POST   | Request gas sponsorship (new-user grant)             |
| `/health` · `/health/:chainId`      | GET    | Global (minimal) · per-chain degraded state          |

### Observability

| Endpoint                        | Method | Description                                                        |
| --------------------------------- | -------- | ------------------------------------------------------------------- |
| `/debug`                        | GET    | Single-page UserOp inspector UI (enter chainId + hash)             |
| `/v1/debug/:chainId/:hash`      | GET    | Per-op lifecycle: stage, storage, fronting EOA + its gas balance, submit RPC, KV marker, chain health |
| `/v1/pool/:chainId`             | GET    | Treasury + all 100 pool EOAs' native balances (one Multicall3 read) |

Open **`/debug`** to watch an op move through Ingress → Mempool → In-flight → Terminal, see **which EOA pays the gas and whether it can**, the submission RPC, and a per-chain **fleet-balances grid** (treasury + 100 pool EOAs, 🔴 empty · 🟡 low · 🟢 ok). Every money-stuck condition also fires a de-duplicated **Telegram alert**.

### Health Endpoint

Global `/health` is intentionally minimal (no chain init):

```json
{ "service": "vela-bundler", "runtime": "cloudflare-workers", "status": "ok" }
```

Per-chain `GET /health/:chainId` reports real degraded state (locked EOAs, pending receipts,
mempool age, circuit breaker, alerting) from that chain's Durable Object — read-only, does not
force a chain init.

## Secret Rotation

1. Generate new `OPERATOR_SECRET`
2. Put old one in `OLD_OPERATOR_SECRETS` (comma-separated)
3. New secret → new EOAs; old secret → old EOAs still **derivable** (their addresses are surfaced on `GET /v1/account/...` as `oldDepositAddresses`)
4. Remove old secret only once old EOAs are drained

> ⚠️ There is **no built-in drain tool** in this repo — draining an old EOA is a manual,
> out-of-band step (derive its key from the retained old secret and sweep it). Do **not** discard
> the old secret until you have confirmed every old EOA is empty, or those funds become
> unrecoverable. See `docs/project-takeover/08-open-issues.md`.

## Configuration

Only `OPERATOR_SECRET` is required. Treasury address is derived from it.

**Transport & settlement flags** take a per-chain spec: `""` / `false` = off, `all` / `true` = every chain, or a chainId CSV like `1,42161`. Rollback/canary is instant — narrow the spec and redeploy, no code change.

| Variable                                  | Default                                      | Description                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPERATOR_SECRET`                         | —                                           | **Required.** 32+ byte hex secret                                                                                                                                                                                                 |
| `INBAND_ENABLED`                          | `all`                                        | In-band gas settlement (EOA fronts gas, repaid in-band) — per-chain spec                                                                                                                                                          |
| `SETTLEMENT_VAULT_ENABLED`                | `all`                                        | Vault mode: reimbursement + beneficiary → treasury, EOA float refilled from it — per-chain spec                                                                                                                                   |
| `POOL_EOA_ENABLED`                        | `""` (off)                                   | Stage 3: bundle from the 100-EOA shared pool instead of per-safe EOAs — per-chain spec                                                                                                                                            |
| `QUEUE_TRANSPORT_ENABLED`                 | `""` (off)                                   | Stage 4: route ingress via the Cloudflare Queue to per-index RelayerDOs — per-chain spec (requires pool)                                                                                                                          |
| `POOL_FLOAT_MIN_WEI`                      | `500000000000000` (0.0005)                   | Round-robin sweep: refill a pool EOA when below this                                                                                                                                                                              |
| `POOL_FLOAT_TARGET_WEI`                   | `2000000000000000` (0.002)                   | Round-robin sweep target (the event-driven refill instead sizes to the bounced bundle's gas)                                                                                                                                      |
| `ENTRY_POINT_ADDRESS`                     | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | EntryPoint v0.7                                                                                                                                                                                                                   |
| `BUNDLING_MODE`                           | `auto`                                       | `auto` or `manual`                                                                                                                                                                                                                |
| `MAX_BUNDLE_SIZE`                         | `10`                                         | Max UserOps per bundle                                                                                                                                                                                                            |
| `MAX_BUNDLE_GAS`                          | `5000000`                                    | Max gas per bundle                                                                                                                                                                                                                |
| `AUTO_BUNDLE_INTERVAL_MS`                 | `10000`                                      | Auto-bundling interval (ms)                                                                                                                                                                                                       |
| `OLD_OPERATOR_SECRETS`                    | —                                           | Old secrets for draining rotated EOAs (comma-separated)                                                                                                                                                                           |
| `ALCHEMY_API_KEY`                         | —                                           | Alchemy API key for preferred RPCs                                                                                                                                                                                                |
| `USE_EIP1559`                             | `true`                                       | Enable EIP-1559 gas pricing                                                                                                                                                                                                       |
| `BASE_FEE_MULTIPLIER`                     | `1.25`                                       | Base fee buffer multiplier                                                                                                                                                                                                        |
| `BUNDLER_TIP_GWEI`                        | `0.5`                                        | Fallback priority fee (Gwei)                                                                                                                                                                                                      |
| `MIN_PRIORITY_FEE_PER_GAS`                | `0`                                          | Minimum priority fee (wei)                                                                                                                                                                                                        |
| `MIN_PROFIT_MARGIN_BPS`                   | `1000`                                       | Minimum margin (10%)                                                                                                                                                                                                              |
| `MAX_PROFIT_MARGIN_BPS`                   | `15000`                                      | Maximum margin cap                                                                                                                                                                                                                |
| `API_RATE_LIMIT_PER_MINUTE`               | `60`                                         | Rate limit per IP                                                                                                                                                                                                                 |
| `RATE_LIMIT_ALLOWLIST`                    | —                                           | Comma-separated client IPs exempt from rate limiting (your own bot)                                                                                                                                                               |
| `BALANCE_RESERVE_MULTIPLIER`              | `1`                                          | Balance reserve multiplier                                                                                                                                                                                                        |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | —                                           | **Set both in production.** Telegram alerts for every intervention-worthy state (stuck money, broadcast failures, treasury low, code errors) + 6h alive heartbeat. Unset = disabled (loud warning; `alerting` field in `/health`) |
| `TREASURY_ALERT_THRESHOLD_WEI`            | `0.02 ETH`                                   | Treasury alert floor (auto-raised to the sponsor's dynamic fail-closed floor on native chains)                                                                                                                                    |
| `TREASURY_ALERT_THRESHOLD_PATHUSD`        | `0.5`                                        | Tempo treasury alert floor (6-dec units)                                                                                                                                                                                          |

## Known Limitations

- **No external database** — money-path state persists in Durable Object storage and survives eviction; ephemeral caches (reputation decay, circuit-breaker state) reset on cold start.
- **Throughput** — in per-safe mode a chain is bounded by its single `BundlerDO` (serialized by design). In **pool+queue mode** the 100 per-index `RelayerDO`s parallelize a chain, each its own serialization point.
- **Native/stablecoin float imbalance** — the operator fronts native gas but is repaid in the fee token; on a native-gas chain paid in a stablecoin the treasury's native balance only drains, so it needs periodic top-ups (or a stablecoin→native swap).
- **No opcode tracing** — ERC-7562 not implemented.
- **No aggregator support.**
- **Conservative restart** — unknown pending nonce locks the EOA until the alarm health loop recovers it.

## License

MIT
