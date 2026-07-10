# Vela Bundler

ERC-4337 / ERC-7769 multi-chain bundler for EntryPoint v0.7.

Supports any EVM network listed at [ethereum-data.awesometools.dev](https://ethereum-data.awesometools.dev/).

Two deployment targets: **Deno** (self-hosted) and **Cloudflare Workers** (edge).

## Quick Start

### Deno (self-hosted)

```bash
export OPERATOR_SECRET=0x...   # 32+ byte hex secret for key derivation
deno task start
```

### Cloudflare Workers

```bash
npm install
npx wrangler secret put OPERATOR_SECRET
npx wrangler secret put ALCHEMY_API_KEY    # optional
npm run deploy
```

Any EVM chain is supported automatically — the first request for a chain creates its Durable Object.

## How It Works

1. Each user's **safeAddress** gets a **dedicated bundler EOA**, deterministically derived from `(chainId, entryPoint, safeAddress, operatorSecret)`.
2. Users deposit native tokens to their dedicated EOA (or a `pathUSD` stablecoin float on Tempo).
3. The bundler submits `handleOps` when the EOA has sufficient balance.
4. Each bundle contains ops from **one safeAddress only**, signed by its dedicated EOA.
5. On native chains the `handleOps` **beneficiary is the `VelaGasSettlementSplitter`**, whose `receive()` splits the EntryPoint gas refund 50/50 between the EOA and the treasury. On Tempo the bundler is repaid by an in-band stablecoin transfer. (There is no periodic treasury sweep — that mechanism was removed in favor of the on-chain splitter.)

No database — all state is derived or in-memory.

## Architecture

```
shared/              Platform-agnostic logic (used by both runtimes)
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

deno/                Deno runtime
├── main.ts          Entry point
├── config.ts        Env-based config (Deno.env)
└── server.ts        HTTP server (Deno.serve)

worker/              Cloudflare Workers runtime
├── index.ts         Fetch handler — routes by chainId to DO
├── bundler-do.ts    BundlerDO — one Durable Object per chain
├── config.ts        Env-based config (CF bindings)
└── types.ts         Env interface
```

## Deployment

### Deno

```bash
deno task dev              # Dev with watch mode
deno task start            # Production
deno task test             # Run tests
deno task deploy           # Interactive SSH deploy to remote server
deno task deploy status    # Check remote status
deno task deploy rollback  # Rollback to previous release
```

Uses systemd on the remote server. See `deploy/systemd/vela-bundler.service`.

### Cloudflare Workers

```bash
npm install
npm run dev                # Local dev (wrangler dev)
npm run deploy             # Deploy to Cloudflare
npm run test:worker        # Run worker tests (vitest + miniflare)
```

**Secrets** (set via `npx wrangler secret put`):
- `OPERATOR_SECRET` — required
- `ALCHEMY_API_KEY` — optional, for preferred RPCs

**How it works**: Each chain gets its own Durable Object instance (`BundlerDO`), created on first request. The DO encapsulates mempool, EOA locks, reputation, and auto-bundling via alarms (replaces `setInterval`). Requests are routed by `POST /:chainId` → `env.BUNDLER.idFromName("chain-${chainId}")`. DO alarms persist across eviction, every activated chain self-registers with a `chain-registry` DO, and a 5-minute cron probes each registered chain (storage-only) to revive a broken alarm chain — zero per-chain configuration. Fully idle chains (e.g. one-off testnets someone activated via `X-Rpc-Url`) stop their own alarm after ~5 minutes and wake instantly on the next accepted op.

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

| Priority | Source | Scope |
|----------|--------|-------|
| 1 | `X-Rpc-Url` header | Per-request |
| 2 | Alchemy RPC | If `ALCHEMY_API_KEY` set + chain supported |
| 3 | Chain registry | Public RPCs, health-checked |

## API

### JSON-RPC: `POST /:chainId`

| Method | Description |
|--------|-------------|
| `eth_sendUserOperation` | Submit UserOp (checks balance, binding, profitability) |
| `eth_estimateUserOperationGas` | Estimate gas limits |
| `eth_getUserOperationByHash` | Get UserOp by hash |
| `eth_getUserOperationReceipt` | Get receipt |
| `eth_supportedEntryPoints` | List EntryPoints |
| `eth_chainId` | Chain ID |

All methods support `X-Rpc-Url` header. Batch requests capped at 20.

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/account/:chainId/:safeAddress` | GET | Account info (balance, nonce, status) |
| `/v1/treasury` | GET | Treasury address |
| `/v1/sponsor/:chainId/:safeAddress` | POST | Request gas sponsorship |
| `/health` | GET | Service health + stats |

### Health Endpoint

```json
{
  "service": "vela-bundler",
  "status": "ok",
  "activeChains": 3,
  "mempoolSize": 0,
  "lockedEOAs": 0,
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
}
```

On CF Workers, global `/health` returns minimal info. Per-chain health available via the DO.

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

| Variable | Default | Description |
|----------|---------|-------------|
| `OPERATOR_SECRET` | — | **Required.** 32+ byte hex secret |
| `PORT` | `3300` | Server port (Deno only) |
| `HOST` | `0.0.0.0` | Server bind address (Deno only) |
| `ENTRY_POINT_ADDRESS` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | EntryPoint v0.7 |
| `BUNDLING_MODE` | `auto` | `auto` or `manual` |
| `MAX_BUNDLE_SIZE` | `10` | Max UserOps per bundle |
| `MAX_BUNDLE_GAS` | `5000000` | Max gas per bundle |
| `AUTO_BUNDLE_INTERVAL_MS` | `10000` | Auto-bundling interval (ms) |
| `OLD_OPERATOR_SECRETS` | — | Old secrets for draining rotated EOAs (comma-separated) |
| `ALCHEMY_API_KEY` | — | Alchemy API key for preferred RPCs |
| `USE_EIP1559` | `true` | Enable EIP-1559 gas pricing |
| `BASE_FEE_MULTIPLIER` | `1.25` | Base fee buffer multiplier |
| `BUNDLER_TIP_GWEI` | `0.5` | Fallback priority fee (Gwei) |
| `MIN_PRIORITY_FEE_PER_GAS` | `0` | Minimum priority fee (wei) |
| `MIN_PROFIT_MARGIN_BPS` | `1000` | Minimum margin (10%) |
| `MAX_PROFIT_MARGIN_BPS` | `15000` | Maximum margin cap |
| `API_RATE_LIMIT_PER_MINUTE` | `60` | Rate limit per IP |
| `RATE_LIMIT_ALLOWLIST` | — | Comma-separated client IPs exempt from rate limiting (your own bot) |
| `BALANCE_RESERVE_MULTIPLIER` | `1` | Balance reserve multiplier |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | **Set both in production.** Telegram alerts for every intervention-worthy state (stuck money, broadcast failures, treasury low, code errors) + 6h alive heartbeat. Unset = disabled (loud warning; `alerting` field in `/health`) |
| `TREASURY_ALERT_THRESHOLD_WEI` | `0.02 ETH` | Treasury alert floor (auto-raised to the sponsor's dynamic fail-closed floor on native chains) |
| `TREASURY_ALERT_THRESHOLD_PATHUSD` | `0.5` | Tempo treasury alert floor (6-dec units) |

## Known Limitations

- **No database** — in-memory state lost on restart.
- **Single instance** per deployment (Deno). CF Workers scale via Durable Objects.
- **No opcode tracing** — ERC-7562 not implemented.
- **No aggregator support.**
- **Conservative restart** — unknown pending nonce locks the EOA until health loop recovers it.

## License

MIT
