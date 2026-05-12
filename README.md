# Vela Bundler

Private prepaid ERC-4337 / ERC-7769 bundler for EntryPoint v0.7, built with Deno 2 + TypeScript.

Supports any EVM network listed at [ethereum-data.awesometools.dev](https://ethereum-data.awesometools.dev/).

## Quick Start

```bash
# Only two required env vars:
export OPERATOR_SECRET=0x...   # 32+ byte hex secret for key derivation
export TREASURY_ADDRESS=0x...  # Where excess EOA balance is swept

deno task start
```

Everything else has sensible defaults (Ethereum mainnet, auto RPC, port 3300).

## How It Works

1. Each user's **safeAddress** gets a **dedicated bundler EOA**, deterministically derived from `(chainId, entryPoint, safeAddress, operatorSecret)`.
2. Users deposit native tokens to their dedicated EOA.
3. The bundler submits `handleOps` when the EOA has sufficient balance.
4. Each bundle contains ops from **one safeAddress only**, signed by its dedicated EOA.
5. Every 30 bundles, excess balance is swept to the treasury.

No database — all state is derived or in-memory.

## Architecture

```
src/
├── config/          Configuration + chain registry + Alchemy RPC support
├── keys/            Deterministic key derivation (HKDF-SHA256)
├── account/         Per-EOA balance, reservations, lock management
├── auth/            Rate limiting
├── contracts/       EntryPoint v0.7 ABI, constants, error codes
├── userop/          UserOperation types, packing, hashing, validation
├── gas/             preVerificationGas, profitability model
├── simulation/      simulateValidation + bundle simulation
├── mempool/         In-memory mempool with reputation tracking
├── bundler/         Bundle building, submission, treasury sweep
├── chain/           Per-chain service registry (lazy init + health loop)
├── rpc/             JSON-RPC (ERC-7769) + REST API
└── utils/           Hex utilities, RPC client factory
```

## Key Derivation

```
HKDF-SHA256(
  IKM  = operatorSecret,
  salt = "vela-bundler-dedicated-eoa-v1",
  info = "chainId={id}|entryPoint={addr}|safeAddress={addr}",
  L    = 32 bytes
) → secp256k1 private key → Ethereum address
```

- HKDF-SHA256 with domain separation.
- Inputs canonicalized (lowercase, decimal chainId).
- Invalid keys auto-retry with counter.
- `KeyManager` interface for future KMS/HSM/MPC.

## RPC URL Priority

| Priority | Source | Scope |
|----------|--------|-------|
| 1 | `X-Rpc-Url` header | Per-request |
| 2 | Alchemy RPC | If `ALCHEMY_API_KEY` set + chain supported |
| 3 | Chain registry | Public RPCs, health-checked |

Per-request RPCs flow through the entire chain: simulation, submission, balance queries.

## REST API

### GET /v1/account/:chainId/:safeAddress

No authentication. Rate limited per IP. Supports `X-Rpc-Url` header.

```json
{
  "chainId": 1,
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "safeAddress": "0x...",
  "activeDepositAddress": "0x...",
  "oldDepositAddresses": [],
  "onchainBalance": "0x...",
  "reservedBalance": "0x0",
  "spendableBalance": "0x...",
  "latestNonce": 0,
  "pendingNonce": 0,
  "status": "ACTIVE",
  "rpcUsed": "https://..."
}
```

**Status:** `ACTIVE` | `INSUFFICIENT_BALANCE` | `LOCKED_PENDING_UNKNOWN` | `LOCKED_IN_MEMORY_PENDING`

## JSON-RPC Methods

Endpoint: `POST /:chainId` (e.g., `POST /1`, `POST /137`, `POST /42161`).

| Method | Description |
|--------|-------------|
| `eth_sendUserOperation` | Submit UserOp (checks balance, binding, profitability) |
| `eth_estimateUserOperationGas` | Estimate gas limits |
| `eth_getUserOperationByHash` | Get UserOp by hash |
| `eth_getUserOperationReceipt` | Get receipt |
| `eth_supportedEntryPoints` | List EntryPoints |
| `eth_chainId` | Chain ID |

All methods support `X-Rpc-Url` header.

## Health Endpoint

`GET /health` or `GET /api/health`

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

**Status:** `ok` when no locked EOAs, `degraded` when any EOA is locked.

## Treasury Sweep

Excess EOA balance is automatically swept to `TREASURY_ADDRESS`:

- **Trigger:** before bundling, when `nonce % SWEEP_INTERVAL === 0`
- **Retain:** `currentGasPrice × 10M gas` (enough for future bundles)
- **Runs inside bundle lock** — no nonce conflicts
- **Non-fatal:** failure skips, retries next trigger

## Secret Rotation

No `keyVersion`. Rotation = change `OPERATOR_SECRET`, put old one in `OLD_OPERATOR_SECRETS`.

- New secret → new EOAs for all users
- Old secret → old EOAs still derivable for balance queries + sweep
- Sweep clears old EOAs → remove old secret from config

## Binding Rules

- Dedicated EOA only serves its bound safeAddress
- One safeAddress per bundle
- Signer = beneficiary = dedicated EOA
- Only `handleOps` calldata to configured EntryPoint

## Configuration

Only `OPERATOR_SECRET` and `TREASURY_ADDRESS` are required. See [.env.example](.env.example).

Chain ID is per-request (via URL path), not a global config.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPERATOR_SECRET` | — | **Required.** 32+ byte hex secret |
| `TREASURY_ADDRESS` | — | **Required.** Sweep destination |
| `PORT` | `3300` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `ENTRY_POINT_ADDRESS` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | EntryPoint v0.7 address |
| `BUNDLING_MODE` | `auto` | `auto` or `manual` |
| `MAX_BUNDLE_SIZE` | `10` | Max UserOps per bundle |
| `MAX_BUNDLE_GAS` | `5000000` | Max gas per bundle |
| `AUTO_BUNDLE_INTERVAL_MS` | `10000` | Auto-bundling interval (ms) |
| `SWEEP_INTERVAL` | `30` | Sweep every N bundles per EOA |
| `OLD_OPERATOR_SECRETS` | — | Old secrets for sweep (comma-separated) |
| `ALCHEMY_API_KEY` | — | Alchemy API key for preferred RPCs |
| `USE_EIP1559` | `true` | Enable EIP-1559 gas pricing |
| `BASE_FEE_MULTIPLIER` | `1.25` | Base fee buffer multiplier |
| `BUNDLER_TIP_GWEI` | `1.5` | Minimum priority fee tip (Gwei) |
| `MIN_PRIORITY_FEE_PER_GAS` | `1000000000` | Minimum priority fee (wei) |
| `MIN_PROFIT_MARGIN_BPS` | `2000` | Minimum profitability (basis points) |
| `TARGET_PROFIT_MARGIN_BPS` | `3500` | Target margin (basis points) |
| `HIGH_RISK_MARGIN_BPS` | `5000` | High-risk margin (basis points) |
| `API_RATE_LIMIT_PER_MINUTE` | `60` | Rate limit per IP |
| `BALANCE_RESERVE_MULTIPLIER` | `2` | Balance reserve requirement multiplier |

## Known Limitations

- **No database** — no billing history, profit reports. In-memory state lost on restart.
- **Single instance** — no distributed locking.
- **No opcode tracing** — ERC-7562 not implemented.
- **No aggregator support.**
- **Reorg risk** — profitability checks apply to normal execution only.
- **Conservative restart** — unknown pending nonce locks the EOA.

## License

MIT
