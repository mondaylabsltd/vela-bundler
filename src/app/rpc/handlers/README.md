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
