# RPC handlers

## `eth_supportedEntryPoints`

Call `POST /{chainId}/rpc` with the following request body:

```json
{
  "jsonrpc": "2.0",
  "method": "eth_supportedEntryPoints",
  "params": [],
  "id": 1
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"]
}
```

The address list is defined by the `SUPPORTED_ENTRY_POINTS` constant in `supported_entry_points.rs`. The first address is the Bundler's preferred EntryPoint. The current implementation returns the same list for every `chainId`.

## `pimlico_getUserOperationGasPrice`

Call `POST /{chainId}/rpc` with the following request body:

```json
{
  "jsonrpc": "2.0",
  "method": "pimlico_getUserOperationGasPrice",
  "params": [],
  "id": 1
}
```

The handler delegates estimation to `GasPriceManager`. On EIP-1559 chains it uses `eth_feeHistory` to calculate a 120%-of-base-fee cap plus a median priority fee. If fee history is unavailable, it falls back to `eth_maxPriorityFeePerGas`, then to `eth_gasPrice` for legacy-compatible pricing.

The manager returns slow (100%), standard (110%), and fast (120%) tiers. `maxFeePerGas` and `maxPriorityFeePerGas` are scaled independently, while preserving `maxFeePerGas >= maxPriorityFeePerGas`.

Successful gas-price quotes are cached for five seconds. The cache is isolated by `chainId` and caller-provided RPC identity, so callers with different RPC headers never share a quote. Concurrent cache misses for the same key are coalesced into one upstream calculation.

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "slow": {
      "maxFeePerGas": "0x829b42b5",
      "maxPriorityFeePerGas": "0x829b42b5"
    },
    "standard": {
      "maxFeePerGas": "0x88d36a75",
      "maxPriorityFeePerGas": "0x88d36a75"
    },
    "fast": {
      "maxFeePerGas": "0x8f0b9234",
      "maxPriorityFeePerGas": "0x8f0b9234"
    }
  }
}
```

RPC sources are tried in this order:

1. The HTTPS URL supplied by the `x-vela-rpc-url` request header.
2. Alchemy when `ALCHEMY_API_KEY` is set and the numeric EVM `chainId` is present in the Alchemy Chain Resource Directory registry. The registry includes all 80 networks currently listed at `https://www.alchemy.com/rpc`; non-EVM entries are retained for future use but are outside this ERC-4337 JSON-RPC API's scope.
3. HTTPS URLs from `https://ethereum-data.awesometools.dev/chains/eip155-{chainId}.json`, in the published order.

Each upstream request has a one-second deadline. The full gas-price calculation, including `eth_feeHistory`, priority-fee fallback, legacy fallback, and every source switch, has a 2.8-second internal budget. This leaves time for the HTTP response to reach the caller within three seconds. If no source succeeds in that budget, the handler returns JSON-RPC error `-32000` with the message `gas price RPC request timed out` instead of waiting longer.

Source-selection logs include `source`, `method`, and `rpc_url`. The URL contains only the scheme, host, and port; its path and query string are redacted so API keys are not written to logs.

Successful responses include the `x-vela-rpc-domain` header. Its value is the domain of the RPC that supplied the primary gas-price data, such as `eth-mainnet.g.alchemy.com`; endpoint paths and API keys are never returned.

When an RPC request fails, that `chainId`, URL, and method combination enters a 30-second cooldown. Calls skip it during the cooldown and continue with the next source. The shared failure cache holds at most 1,024 entries to keep memory bounded when callers supply many distinct URLs.

The shared source selection, upstream JSON-RPC request, and failover logic lives in `../../../utils/rpc.rs`. Future services and RPC handlers can reuse `utils::rpc::call` with their own method name and parameters.

Set the Alchemy key in the process environment or in the project-root `.env` file before starting the service. Process environment variables take precedence over `.env` values:

```sh
export ALCHEMY_API_KEY="your-key"
cargo run
```

```dotenv
ALCHEMY_API_KEY="your-key"
```

To use a caller-provided RPC before Alchemy and fallback sources, include an HTTPS URL in the request header:

```sh
curl http://127.0.0.1:4567/1/rpc \
  -H 'content-type: application/json' \
  -H 'x-vela-rpc-url: https://your-rpc.example.com' \
  --data '{"jsonrpc":"2.0","method":"pimlico_getUserOperationGasPrice","params":[],"id":1}'
```

## Settlement vault

When `OPERATOR_SECRET` is configured, the settlement recipient is derived with the same HKDF-SHA256 treasury derivation as `vela-bundler`: salt `vela-bundler-dedicated-eoa-v1`, info `treasury`, and a secp256k1 Ethereum address. The derived address is chain-independent and is used as the settlement vault recipient.

`VELA_RELAY_SETTLEMENT_RECIPIENT` remains available for deployments without `OPERATOR_SECRET`. If both variables are set, their addresses must match or startup fails.

## `eth_estimateUserOperationGas`

The relay supports the unpacked EntryPoint v0.7 UserOperation format for the configured EntryPoint. It accepts the optional third `stateOverrides` parameter defined by Pimlico.

```json
{
  "jsonrpc": "2.0",
  "method": "eth_estimateUserOperationGas",
  "params": [
    {
      "sender": "0x1111111111111111111111111111111111111111",
      "nonce": "0x0",
      "factory": null,
      "factoryData": null,
      "callData": "0x",
      "callGasLimit": "0x0",
      "verificationGasLimit": "0x0",
      "preVerificationGas": "0x0",
      "maxFeePerGas": "0x0",
      "maxPriorityFeePerGas": "0x0",
      "paymaster": null,
      "paymasterVerificationGasLimit": null,
      "paymasterPostOpGasLimit": null,
      "paymasterData": null,
      "signature": "0x1234"
    },
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
  ],
  "id": 1
}
```

The relay does not forward this bundler-specific method to a normal EVM RPC. It injects the EntryPoint v0.7 simulation code through the standard `eth_call` state-override parameter, then estimates the account execution phase with `eth_estimateGas` using the EntryPoint as `from`.

During simulation, the copied operation uses one wei gas-fee fields and a temporary sender balance. The submitted operation is never modified. This is required for Tempo's signed zero-fee operations: `maxFeePerGas` and `maxPriorityFeePerGas` remain zero in the original request, so no native EntryPoint prefund is required.

An RPC that rejects state overrides, times out, or is rate limited is cooled down and the next configured source is tried. A genuine EVM revert is returned as a UserOperation simulation error without cooling down that RPC. Successful responses include the selected simulation source in `x-vela-rpc-domain`.

The response contains the v0.7 gas fields, including zero-valued paymaster limits when no paymaster is present:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "preVerificationGas": "0x0",
    "verificationGasLimit": "0x0",
    "callGasLimit": "0x0",
    "paymasterVerificationGasLimit": "0x0",
    "paymasterPostOpGasLimit": "0x0"
  }
}
```

## Tempo submission guard

Before the still-unconfigured submission backend is reached, `eth_sendUserOperation` applies the Tempo admission rules for chain IDs `4217` and `42431`:

- `maxFeePerGas` and `maxPriorityFeePerGas` must both be exactly `0x0`.
- The signed Safe calldata must be `executeUserOp` delegating to the canonical Safe MultiSend contract.
- The batch must transfer to the configured settlement recipient either at least `0.00001` native coin or at least `$0.01` of one stablecoin listed in that chain's `stables` metadata.
- Stablecoin amounts are converted to smallest units using the token's on-chain `decimals()` result. Transfers in unlisted tokens are ignored.

The guard reads the encoded calls rather than accepting a wallet-supplied reimbursement amount. It therefore cannot credit a transfer-shaped payload that does not execute against the Safe.
