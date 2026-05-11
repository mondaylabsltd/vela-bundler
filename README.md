# Vela Bundler

Private prepaid ERC-4337 / ERC-7769 bundler for EntryPoint v0.7, built with Deno 2 + TypeScript.

Supports any EVM network listed at [ethereum-data.awesometools.dev](https://ethereum-data.awesometools.dev/).

## Architecture

```
src/
├── config/          Configuration + chain registry (auto-resolve RPC from chainId)
├── keys/            Deterministic key derivation (HKDF-SHA256) + KeyManager interface
├── account/         Per-EOA balance, reservations, lock management (no database)
├── auth/            Bearer token auth + rate limiting
├── contracts/       EntryPoint v0.7 ABI, constants, ERC-7769 error codes
├── userop/          UserOperation types, packing, hashing, validation, encoding
├── gas/             preVerificationGas calculation, profitability model
├── simulation/      EntryPoint simulateValidation + bundle simulation
├── mempool/         In-memory mempool with reputation tracking
├── bundler/         Bundle building per-safeAddress, profitability gating, submission
├── rpc/             JSON-RPC server (ERC-7769) + REST API (/v1/account)
└── utils/           Hex utilities
```

## Quick Start

```bash
cp .env.example .env
# Edit .env: set CHAIN_ID, OPERATOR_SECRET, API_TOKEN

deno task dev     # Development with watch mode
deno task start   # Production
deno task test    # Run tests
deno task lint    # Lint + type-check
```

## Private Prepaid Bundler Model

### How It Works

1. Each user's **safeAddress** (ERC-4337 smart account) gets a **dedicated bundler EOA**.
2. The EOA address is **deterministically derived** from `(chainId, entryPoint, safeAddress, operatorSecret, keyVersion)` — no database needed.
3. Users deposit native tokens (ETH) to their dedicated EOA address.
4. The bundler only submits `handleOps` when the EOA has sufficient balance.
5. Each bundle contains ops from **one safeAddress only**, signed by its dedicated EOA.

### Deterministic Key Derivation

```
HKDF-SHA256(
  IKM  = operatorSecret,
  salt = "vela-bundler-dedicated-eoa-v1",
  info = "chainId={id}|entryPoint={addr}|safeAddress={addr}|keyVersion={v}",
  L    = 32 bytes
) → secp256k1 private key → Ethereum address
```

- Uses **HKDF-SHA256** with explicit domain separation (not simple hash concatenation).
- Inputs are canonicalized (lowercased addresses, decimal chainId).
- Invalid keys (0 or >= secp256k1 N) are rejected and re-derived with a counter.
- The `KeyManager` interface allows swapping in KMS/HSM/MPC in production.

### No Database

- **No** safeAddress → bundlerEOA mapping table.
- **No** deposit records, user balances, or transaction history.
- **No** PostgreSQL, SQLite, Redis, MongoDB, or any external state.
- All state is either derived on-the-fly or held in process memory.
- Process memory (mempool, reservations, locks) is lost on restart.

### Balance Model

```
onchainBalance   = eth_getBalance(bundlerEOA, "latest")
reservedBalance  = in-memory pending reservation
spendableBalance = onchainBalance - reservedBalance
```

## REST API

### GET /v1/account/:chainId/:safeAddress

Returns deposit address, balance, and status. Requires `Authorization: Bearer <token>`.

**Response:**
```json
{
  "chainId": 1,
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "safeAddress": "0x...",
  "activeDepositAddress": "0x...",
  "oldDrainingAddresses": [],
  "keyVersion": "1",
  "onchainBalance": "0x...",
  "reservedBalance": "0x0",
  "spendableBalance": "0x...",
  "latestNonce": 0,
  "pendingNonce": 0,
  "status": "ACTIVE"
}
```

**Status values:**
- `ACTIVE` — ready to process UserOperations.
- `INSUFFICIENT_BALANCE` — deposit needed.
- `LOCKED_PENDING_UNKNOWN` — EOA has unknown pending tx (restart recovery).
- `LOCKED_IN_MEMORY_PENDING` — bundle currently in flight.

## ERC-7769 JSON-RPC Methods

| Method | Description |
|--------|-------------|
| `eth_sendUserOperation` | Submit a UserOperation (checks balance, binding, profitability) |
| `eth_estimateUserOperationGas` | Estimate gas limits |
| `eth_getUserOperationByHash` | Get UserOperation by hash |
| `eth_getUserOperationReceipt` | Get receipt for included UserOperation |
| `eth_supportedEntryPoints` | List supported EntryPoints |
| `eth_chainId` | Get chain ID |

### Debug Methods (MODE=testing only)

`debug_bundler_clearState`, `debug_bundler_dumpMempool`, `debug_bundler_sendBundleNow`,
`debug_bundler_setBundlingMode`, `debug_bundler_setReputation`, `debug_bundler_dumpReputation`,
`debug_bundler_addUserOps`

## Binding Rules

- Each `dedicatedBundlerEOA` only serves its bound `safeAddress`.
- A bundle only contains UserOps where `sender == safeAddress`.
- `handleOps` signer = dedicated EOA.
- `handleOps` beneficiary = dedicated EOA.
- Dedicated EOA only sends to the configured EntryPoint.
- Calldata is only `handleOps`.

## Concurrency Control

- **Per-EOA mutex**: only one `handleOps` tx in flight per EOA at a time.
- **Atomic reservation**: balance reserved before submission, released after confirmation.
- **Fail-closed**: if submission state is uncertain, the EOA is locked until nonce resolves.

## Restart Recovery

On restart, for each EOA about to be used:
```
latestNonce  = eth_getTransactionCount(eoa, "latest")
pendingNonce = eth_getTransactionCount(eoa, "pending")
```
If `pendingNonce > latestNonce`, the EOA is locked (`LOCKED_PENDING_UNKNOWN`) until the pending tx confirms or drops. New bundles are rejected for that EOA.

## Key Rotation

- `ACTIVE_KEY_VERSION` — current version for new deposit addresses.
- `DRAINING_KEY_VERSIONS` — old versions, no new ops accepted.
- Old EOAs remain derivable for balance queries and optional sweep.
- `GET /v1/account` shows both active and draining addresses.

## Profitability Model

### Per-UserOp Check
```
userOpGasPrice = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)
requiredPrice  = outerTxGasPrice × (10000 + minProfitMarginBps) / 10000
```

### Bundle-Level Check
```
expectedRevenue = Σ(gasUsed × gasPrice per op)
expectedCost    = handleOpsGas × outerTxGasPrice
requiredRevenue = expectedCost × (10000 + minProfitMarginBps) / 10000
```

### Balance Gate
```
spendableBalance >= expectedCost × balanceReserveMultiplier
```

## Configuration

See [.env.example](.env.example) for all variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAIN_ID` | — | Required. Chain ID |
| `OPERATOR_SECRET` | — | Required. Master secret for key derivation |
| `API_TOKEN` | — | Required. Bearer token for REST API |
| `ACTIVE_KEY_VERSION` | `1` | Current key version |
| `DRAINING_KEY_VERSIONS` | — | Comma-separated old versions |
| `BALANCE_RESERVE_MULTIPLIER` | `2` | Require N× expected cost |
| `MIN_PROFIT_MARGIN_BPS` | `2000` | Minimum profit margin (20%) |
| `RPC_URL` | auto | Manual override (local dev only) |

## Known Limitations

- **No database**: No historical billing, deposit records, or profit reports. All in-memory state is lost on restart.
- **Single instance only**: No distributed locking. Multiple instances would cause double-spend and nonce conflicts.
- **No opcode tracing**: ERC-7562 opcode validation via `debug_traceCall` is not implemented.
- **No aggregator support**: UserOps requiring signature aggregators are rejected.
- **Reorg risk**: The bundler cannot guarantee against losses from reorgs, RPC bugs, or state races. Profitability checks apply to normal successful execution only.
- **L2 data fees**: Requires chain-specific adapters (not yet implemented).
- **Restart recovery is conservative**: Any EOA with `pendingNonce > latestNonce` is locked until resolved.
- **No multi-entrypoint**: One EntryPoint per instance.

### To enable in the future:
- Multi-instance deployment → requires external lock (Redis/etcd) + shared state.
- Historical billing → requires database.
- Precise profit tracking → requires database for `realizedProfit` / `failedTxLoss`.
- Automated sweep of draining EOAs → requires scheduled job.

## License

MIT
