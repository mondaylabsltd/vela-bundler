# Vela Bundler — External API Contract

The authoritative reference for every interface the bundler exposes to the outside world
(wallets, the operator's bot, the observability UI). This is the contract a refactor must
preserve — the implementation behind any interface may change freely as long as the request
and response shapes documented here stay identical. Pinned by `tests/api_contract_test.ts`
(+ `handlers_test.ts`, `rest_api_test.ts`, `receipt_format_test.ts`, `rpc_errors_test.ts`,
`cors_test.ts`, `worker_routing_test.ts`).

- **Transport:** HTTP (+ CORS, fully permissive — see [§7](#7-request-envelope)).
- **Base URL:** the deployed Worker origin. Everything is keyed by `:chainId` in the path;
  the Worker routes each request to that chain's `BundlerDO` (`idFromName("chain-${chainId}")`).
- **Encoding:** all integers are `0x`-prefixed hex strings on the wire (request *and* response),
  per ERC-7769. `bigint`s are serialized by a single JSON replacer, never leaked raw.

## Surface at a glance

**13 HTTP endpoints.** One of them (`POST /:chainId`) multiplexes **8 JSON-RPC methods**.

| Group | Count | Endpoints |
|---|---|---|
| JSON-RPC | 1 endpoint · 8 methods | `POST /:chainId` |
| REST | 5 | `/v1/account/:chainId/:safe`, `/v1/treasury`, `/v1/treasury/:chainId`, `/v1/splitter`, `/v1/sponsor/:chainId/:safe` |
| Observability | 3 | `/debug`, `/v1/debug/:chainId/:hash`, `/v1/pool/:chainId` |
| Health | 2 | `/health` (= `/api/health`), `/health/:chainId` |
| Misc | 2 | `GET /` (homepage HTML), `OPTIONS *` (CORS preflight → 204) |

Anything unmatched → **405** with a JSON-RPC-shaped error `{ code: -32600 }`.

---

## 1. JSON-RPC — `POST /:chainId`

Standard JSON-RPC 2.0. Body is a single request object **or** a batch array (max **20**).
`chainId` comes from the URL path. All methods honour the `X-Rpc-Url` header
([§7](#7-request-envelope)). Dispatch lives in `shared/rpc/handlers.ts::handleRpcMethod`.

Envelope (`shared/rpc/process.ts`):

```jsonc
// request
{ "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": [] }
// success
{ "jsonrpc": "2.0", "id": 1, "result": <method result> }
// error
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "…", "data": <optional> } }
```

`id` (number | string | null) is echoed back. An unknown `method` → `-32601`. Only errors built
via the `errors.ts` factories are forwarded to the client; any other thrown value is redacted to
a generic `-32603` (a raw provider error can embed the RPC URL / API key).

### The 8 methods

| # | Method | Params | Result |
|---|---|---|---|
| 1 | `eth_sendUserOperation` | `[UserOp, entryPoint]` | `userOpHash` (`0x`+64 hex) |
| 2 | `eth_estimateUserOperationGas` | `[UserOp, entryPoint]` | `GasEstimate` |
| 3 | `eth_getUserOperationByHash` | `[hash]` | `ByHash` \| `null` |
| 4 | `eth_getUserOperationReceipt` | `[hash]` | `Receipt` \| `null` |
| 5 | `eth_supportedEntryPoints` | `[]` | `[entryPoint]` |
| 6 | `eth_chainId` | `[]` | `0x`-hex chain id |
| 7 | `pimlico_getUserOperationGasPrice` | `[]` | `{ slow, standard, fast }` |
| 8 | `vela_getInBandGasQuote` | `[{ safeAddress, nativeCost, feeToken? }]` | `InBandQuote` |

Methods 7–8 are Vela extensions; 1–6 are standard ERC-4337 / ERC-7769. (Not implemented:
`eth_getUserOperationLogs`, aggregator methods, debug/bundler admin methods.)

#### 1 · `eth_sendUserOperation`
Pipeline (in code order): validate fields → read gas price + the price-derived gates (balance,
preVerificationGas, priority fee, gas-margin) → simulate validation → simulate execution →
relayer-treasury bootstrap gate (vault chains only) → accept into the transport (mempool or
queue). On **in-band** chains the balance / priority-fee / gas-margin gates are *skipped* (the EOA
is an operator float repaid in-band); they are not replaced by a later gate. Returns the
`userOpHash` on acceptance; the op is then bundled asynchronously (poll methods 3–4 for the
outcome). Notable errors: `-32602` (bad op / EOA busy / insufficient balance / pvg or fee too low),
`-32500` (simulation rejected), `-32508` (relayer treasury below its bootstrap floor — vault
chains), `-32000` (retryable: chain/gas/balance/simulation upstream degraded). See [§4](#4-error-taxonomy).

#### 2 · `eth_estimateUserOperationGas`
```ts
type GasEstimate = {
  preVerificationGas: `0x${string}`;
  verificationGasLimit: `0x${string}`;
  callGasLimit: `0x${string}`;
  paymasterVerificationGasLimit?: `0x${string}`; // present iff the gas estimate returns a non-null paymaster limit
};
```

#### 3 · `eth_getUserOperationByHash` → `ByHash | null`
`null` until the bundler knows the op. **Pending** (still in a mempool) returns the submitted op;
**mined** returns the minimal identity + inclusion pointers.
```ts
type ByHash =
  | { userOperation: RpcUserOpEcho; entryPoint: Addr; blockNumber: null; blockHash: null; transactionHash: null }    // pending
  | { userOperation: { sender: Addr; nonce: `0x${string}` }; entryPoint: Addr; blockNumber: `0x${string}`; blockHash: Hash; transactionHash: Hash }; // mined
```
> `RpcUserOpEcho` is the 16-field serialization of the input `RpcUserOp` — identical **except** it
> omits `eip7702Auth` (accepted on submit, but not echoed back by this method; `feeToken` is
> always present, `null` when unset).

#### 4 · `eth_getUserOperationReceipt` → `Receipt | null`
`null` until terminal. Shape (`shared/rpc/receipt-format.ts::receiptToRpc`) — every integer hex,
a `null` paymaster becomes the zero address:
```ts
type Receipt = {
  userOpHash: Hash; entryPoint: Addr; sender: Addr; nonce: `0x${string}`;
  paymaster: Addr;                 // 0x000…0 when none
  actualGasCost: `0x${string}`; actualGasUsed: `0x${string}`; success: boolean;
  logs: Array<{ logIndex: `0x${string}`; address: Addr; topics: Hash[]; data: `0x${string}`;
                blockNumber: `0x${string}`; blockHash: Hash; transactionHash: Hash }>;
  receipt: { transactionHash: Hash; transactionIndex: `0x${string}`; blockHash: Hash;
             blockNumber: `0x${string}`; from: Addr; to: Addr; cumulativeGasUsed: `0x${string}`;
             gasUsed: `0x${string}`; effectiveGasPrice: `0x${string}` };
};
```

#### 7 · `pimlico_getUserOperationGasPrice`
The bundler is the single source of truth for gas price. Three speed tiers; the wallet signs the
quote verbatim. `maxPriorityFeePerGas === maxFeePerGas` (the EntryPoint charges exactly
`maxFeePerGas`). The extra `networkFeePerGas` / `relayerFeePerGas` split (`network + relayer ==
max`) is a Vela extension standard clients ignore.
```ts
type GasTier = { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}`;
                 networkFeePerGas: `0x${string}`; relayerFeePerGas: `0x${string}` };
type Result = { slow: GasTier; standard: GasTier; fast: GasTier };
```
All-zero upstream price signals → `-32000` retryable (never a `0x0` quote the wallet would sign
and have rejected at submit).

#### 8 · `vela_getInBandGasQuote`
Advisory sizing for the in-band gas reimbursement the wallet batches into its UserOp. Only on
chains where in-band settlement is active (else `-32602`). `nativeCost` is the wallet's own wei
estimate (hex or decimal). Charge = `3× cost` (`IN_BAND_MARKUP_X`), floored (native `1e-5` coin,
stablecoin `$0.01`). `recipient` is the fronting EOA, or the **treasury** in vault mode.
```ts
type InBandQuote =
  | { recipient: Addr; asset: "native"; feeToken: null;  requiredAmount: `0x${string}`; markupX: 3 }
  | { recipient: Addr; asset: "erc20";  feeToken: Addr;  requiredAmount: `0x${string}`; decimals: number; markupX: 3 };
```
`feeToken` (when given) must be a whitelisted stablecoin priced by the chain's DEX quoter, else
`-32602`; a DEX quote failure → `-32000`.

### Shared type — the RPC `UserOperation` input

Accepted by methods 1–2 (`shared/userop/normalize.ts`). ERC-4337 v0.7 packed-account fields;
numeric fields accept hex **or** decimal; address fields are lowercased; empty/`0x`/zero-address
optional fields normalize to `null`.
```ts
type RpcUserOp = {
  sender: Addr;                       // required, 20-byte address
  nonce: HexOrDec;                    // required
  factory: Addr | null; factoryData: Hex | null;
  callData: Hex;                      // required
  callGasLimit: HexOrDec; verificationGasLimit: HexOrDec; preVerificationGas: HexOrDec;
  maxFeePerGas: HexOrDec; maxPriorityFeePerGas: HexOrDec;
  paymaster: Addr | null; paymasterVerificationGasLimit: HexOrDec | null;
  paymasterPostOpGasLimit: HexOrDec | null; paymasterData: Hex | null;
  signature: Hex;                     // required
  eip7702Auth?: Eip7702Authorization[];
  feeToken?: Addr | null;             // Vela/Tempo extension
};
```
`entryPoint` (params[1]) must equal `config.entryPointAddress`
(`0x0000000071727De22E5E9d8BAf0edAc6f37da032`, EntryPoint v0.7) or `-32602`.

---

## 2. REST — `/v1/*`

`shared/rpc/rest-api.ts`. JSON responses, CORS on every response, rate-limited
([§7](#7-request-envelope)). Honours `X-Rpc-Url` on reads (**never** on `sponsor` — it moves
treasury funds and must use only the trusted registry RPC).

### `GET /v1/account/:chainId/:safeAddress`
Per-chain view of the safe's dedicated fronting EOA. `settlementRecipient` = where to send the
in-band reimbursement (the EOA, or the treasury in vault mode). `rpcUsed` is redacted (no API key).
```ts
type AccountInfo = {
  chainId: number; entryPoint: Addr; safeAddress: Addr;
  activeDepositAddress: Addr; settlementRecipient: Addr; oldDepositAddresses: Addr[];
  onchainBalance: `0x${string}`; reservedBalance: `0x${string}`; spendableBalance: `0x${string}`;
  latestNonce: number; pendingNonce: number; status: EOAStatus; rpcUsed: string;
};
```
Errors: `500 { error: "Internal error" }` on an account-read RPC failure (the account query threw
*after* the chain initialized). A **chain-init / resolution** failure is caught earlier — before
the REST handler runs — by the per-chain DO and returns `503` with a JSON-RPC body
`{ jsonrpc:"2.0", id:null, error:{ code:-32603, message:"Chain initialization failed" } }`. This
same 503 init gate fronts every chain-scoped `/v1/*` route (also `/v1/treasury/:chainId` and
`/v1/sponsor/:chainId/:safe`).

### `GET /v1/treasury` → `{ address: Addr }`
The operator treasury address (derived from `OPERATOR_SECRET`; identical on all chains).

### `GET /v1/treasury/:chainId`
Treasury balance on one chain + whether it needs a bootstrap deposit before its relayer can
package transactions. Native chains report `asset:"native"`; Tempo reports `asset:"pathUSD"`.
```ts
type TreasuryStatus = {
  chainId: number; address: Addr; asset: "native" | "pathUSD";
  balance: `0x${string}`; floor: `0x${string}`; bootstrapNeeded: boolean;
};
```
Errors: `500 { error: "Internal error" }`.

### `GET /v1/splitter`
The `VelaGasSettlementSplitter` address + its CREATE2 derivation inputs, so a wallet can recompute
and cross-check the address locally.
```ts
type Splitter = { address: Addr; treasury: Addr; factory: Addr; salt: Hash; creationCodeHash: Hash };
```

### `POST /v1/sponsor/:chainId/:safeAddress`
Request a one-time new-user gas grant. Body (optional): `{ requiredWei?: string; dryRun?: boolean }`
— `dryRun:true` runs the eligibility gates without moving money.
```ts
type SponsorResult = {
  sponsored: boolean;
  reason?: string;      // e.g. budget_exhausted | rate_limited | wallet_balance_too_low |
                        // no_passkey_registered | already_funded | treasury_depleted | …
  dryRun?: boolean; eligible?: boolean;  // present on dryRun responses
  // …grant details (amount, txHash) present on a successful real grant
};
```
Status mapping: `200` normally · `503` when `reason === "passkey_index_unavailable"` (an index
outage is infra, not "unregistered" — retry) · `500 { sponsored:false, reason:"internal_error" }`
on an unexpected throw. Requires a wired sponsor service, else `404`. A malformed `:safeAddress`
never reaches this handler — it fails the route regex and returns `404 { error:"Not found" }` (the
handler's own `400 "Invalid safeAddress"` guard is defensive-only and unreachable via the route).

---

## 3. Observability

`worker/index.ts` + `worker/bundler-do.ts`. Read-only, no mutation, no secrets, CORS + `no-store`.

### `GET /debug`
Single-page HTML op inspector (enter chainId + hash) with a per-chain fleet-balances grid.

### `GET /v1/debug/:chainId/:hash`
Full per-op lifecycle for the UI. `hash` must be `0x`+64 hex — enforced by the Worker route regex,
so a malformed hash simply fails to match the route and falls through to the catch-all `405
{ code:-32600 }` (the DO's internal `400 { error:"bad hash" }` guard is unreachable from this public
route). Uninitialized chain → `503`.
```ts
type OpInspection = {
  op: { hash: Hash; stage: "unknown"|"mempool"|"in-flight"|"confirmed"|"failed"; detail?: string; … };
  kv: { present: boolean; status?: string; hasReceipt?: boolean; index?: number } | null;
  eoa: { address: string; role: string; balanceWei?: string } | null;  // who fronts the gas + its balance
  submitRpc: string;                                                    // redacted
  chain: { chainId; mempoolSize; pendingReceiptCount; lockedEOAs: Addr[];
           insufficientFundsEoa; insufficientFundsWei; lastSubmitError; oldestMempoolAgeMs };
};
```

### `GET /v1/pool/:chainId`
Treasury + all 100 pool-EOA native balances (one Multicall3 read). Uninitialized chain → `503`.
```ts
type PoolBalances = {
  chainId: number;
  treasury: { address: Addr; balanceWei: string | null };
  pool: Array<{ index: number; address: Addr; balanceWei: string | null }>;   // length 100
};
```

---

## 4. Health

### `GET /health` (alias `GET /api/health`)
Intentionally minimal — **no chain init**. Always `200`:
```json
{ "service": "vela-bundler", "runtime": "cloudflare-workers", "status": "ok" }
```

### `GET /health/:chainId`
Real degraded state from the chain's DO — read-only, does not force init.
```ts
type ChainHealth =
  | { status: "uninitialized"; chainId: number }
  | { service: "vela-bundler"; runtime: "cloudflare-workers"; chainId: number; chainName: string;
      status: "ok" | "degraded"; alerting: "telegram" | "disabled";
      mempoolSize: number; oldestMempoolAgeMs: number; lockedEOAs: number;
      pendingReceipts: number; oldestPendingReceiptAgeMs: number; submitFailureStreak: number;
      reliability: object /* circuit breaker + RPC health */ };
```

---

## 5. Error taxonomy

`shared/rpc/errors.ts` + `shared/contracts/entrypoint.ts::RPC_ERROR_CODES`. All errors ride the
JSON-RPC `error` object `{ code, message, data? }`.

| Code | Name | Class | Meaning |
|---|---|---|---|
| `-32700` | Parse error | standard | Body was not valid JSON |
| `-32600` | Invalid request | standard | Not a valid JSON-RPC request (also the 405 fallback body) |
| `-32601` | Method not found | standard | Unknown `method` |
| `-32602` | Invalid params / **INVALID_USEROPERATION** | business | Bad params or a permanently-invalid UserOp |
| `-32603` | Internal error | standard | Unexpected/redacted server error |
| `-32500` | ENTRYPOINT_SIMULATION_REJECTED | business | Validation/execution simulation reverted |
| `-32501` | PAYMASTER_REJECTED | business | |
| `-32502` | OPCODE_VIOLATION | business | |
| `-32503` | OUT_OF_TIME_RANGE | business | |
| `-32504` | THROTTLED_OR_BANNED | business | |
| `-32505` | STAKE_TOO_LOW | business | |
| `-32507` | SIGNATURE_VALIDATION_FAILED | business | |
| `-32508` | PAYMASTER_BALANCE_INSUFFICIENT | business | Relayer treasury below its bootstrap floor (vault chains) |
| `-32000` | **SERVICE_DEGRADED** | transient | Upstream RPC/simulation degraded — **retryable** |

**Business** codes are permanent rejections (the wallet must not blindly retry). **Transient**
`-32000` carries `data: { retryable: true, retryAfterMs?: number, reason?: string }` — the wallet
should back off and retry. The distinction is load-bearing: collapsing a transient blip into a
business rejection makes wallets drop good ops during the exact retry window.

---

## 6. Request envelope

Applies to `POST /:chainId` (JSON-RPC) and, where noted, `/v1/*`. Enforced in
`worker/bundler-do.ts::handleRpc` + `shared/auth`.

| Control | Rule | On violation |
|---|---|---|
| **Rate limit** | Per client IP (`CF-Connecting-IP`, unspoofable), `API_RATE_LIMIT_PER_MINUTE` (default 60); `RATE_LIMIT_ALLOWLIST` IPs exempt | `429` |
| **Body size** | ≤ 256 KB, measured on raw **bytes** (not UTF-16 length) | `413` |
| **Batch size** | JSON-RPC array ≤ 20 items | `400` |
| **`X-Rpc-Url`** | Optional per-request RPC override; validated (`validateRpcUrl`); ignored for `sponsor` | `400` (JSON-RPC) / silently dropped (REST) |
| **CORS** | Fully permissive: `Allow-Origin: *`, `Allow-Headers: *`, `Allow-Methods: GET, POST, OPTIONS`, `Max-Age: 86400`. Credential-less API | preflight → `204` |

Batches are processed with `Promise.allSettled` (one failed item can't sink the batch); a
per-item rejection becomes that item's `-32603`. Every response is serialized with a JSON
replacer that hex-encodes any `bigint`.

---

## 7. What is *not* a public interface

Internal DO-to-DO routes (`/rpc`, `/rest`, `/inspect`, `/pool-balances`, `/health`, `/fund-eoa`,
`/ensure-alarm`, `/registry-*`, `/relayer-watch`, RelayerDO `/submit`) are reached only through the
Worker or the queue consumer — they are implementation detail, not part of this contract, and may
change without notice. The Cloudflare Queue / DLQ consumers and the liveness cron are likewise
internal.
