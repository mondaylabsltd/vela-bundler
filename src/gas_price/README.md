# Gas price service

`GasPriceManager` is the application-wide gas price service. It is stored in `AppState`, so RPC handlers, UserOperation estimators, and future executor code use the same policy and chain fee trackers.

## Usage

```rust
let gas_price_manager = state.gas_price();
let quote = gas_price_manager
    .user_operation_gas_prices(chain_id, request.headers().get("x-vela-rpc-url"))
    .await?;

let fast = quote.tiers.fast;
let rpc_domain = quote.rpc_domain;
```

`GasPrice` values are integer wei values. The JSON-RPC handler is responsible for converting them to hexadecimal quantities.

## Estimation policy

1. Request `eth_feeHistory` with 25th, 50th, and 75th reward percentiles.
2. Use the median 50th-percentile reward as `maxPriorityFeePerGas`.
3. Set `maxFeePerGas` to 120% of the newest base fee plus the priority fee.
4. If a priority fee is absent or zero, try `eth_maxPriorityFeePerGas`; use a small base-fee-derived value as the final fallback.
5. If EIP-1559 fee history is unavailable, use `eth_gasPrice` for both fee fields.
6. Produce slow (100%), standard (110%), and fast (120%) recommendations.

All upstream calls use `utils::rpc::call`, which applies the shared Alchemy, request-header, and AwesomeTools failover policy.
Each upstream request has a one-second deadline, while the full calculation has a 2.8-second internal response budget. A `GasPriceQuote` includes the domain of the RPC that supplied the primary gas-price data, so the HTTP handler can return it as `x-vela-rpc-domain` without exposing an endpoint path or API key.

Failed RPC requests enter a shared 30-second cooldown keyed by chain ID, RPC URL, and method. This prevents repeated failover attempts from spending time on a recently rate-limited or unavailable endpoint.

## Chain fee trackers

The manager also owns four rolling fee trackers, modelled after Alto's managers. They are intended for chain-specific `preVerificationGas` calculators and are independent from the base gas-price estimator.

- `ArbitrumManager`: L1 and L2 base-fee ranges.
- `CitreaManager`: minimum L1 fee rate.
- `MantleManager`: token ratio, scalar, rollup data gas and overhead, and L1 gas price.
- `OptimismManager`: minimum L1 fee.

Trackers keep a bounded in-memory history and provide conservative minimum or maximum values. They are ready for the corresponding chain-aware pre-verification gas implementation.
