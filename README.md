# Vela Relay

Vela Relay is an ERC-4337 relay and bundler service. It accepts UserOperations over JSON-RPC,
durably enqueues them in Iggy, records their state in Redis, and executes queued operations in
the background.

The executor is enabled by default. Chain payment-asset metadata comes from Vela's controlled
public directory; native-asset prices come from Binance and listed stablecoins are valued at
1 USD. Gnosis xDAI is fixed at 1 USD and does not use an exchange quote. No per-chain asset or
oracle configuration is required. Tempo is the exception by design:
it has no native gas coin, so Relay uses pathUSD directly and does not query either the chain
directory or Binance for Tempo quotes.

## Requirements

- Remote Iggy instance reachable from the Relay process.
- Remote Redis instance reachable from the Relay process.
- `OPERATOR_SECRET` for the relayer pool when the executor is enabled.

## Configure and run

Copy the example configuration and replace every placeholder. Keep the resulting `.env` private.

```sh
cp .env.example .env
cargo run --release
```

The minimal configuration is:

```dotenv
VELA_RELAY_IGGY_URL=iggy+tcp://username:password@iggy.example.com:3000
VELA_RELAY_REDIS_URL=redis://:password@redis.example.com:6379
OPERATOR_SECRET=your-operator-secret
```

`VELA_RELAY_IGGY_URL` is the only Iggy connection setting required. Consumer and provisioner
connections inherit it automatically. For a producer-only instance, set
`VELA_RELAY_EXECUTOR_ENABLED=false`; then an operator secret is not needed.

For execution, Relay resolves RPC endpoints automatically from Vela's controlled chain directory.
If `ALCHEMY_API_KEY` is set, its endpoint is tried first for networks Alchemy supports. You can
optionally prepend an explicit trusted endpoint for a particular chain:

```dotenv
VELA_RELAY_EXECUTOR_RPC_URLS={"42161":"https://your-rpc.example"}
```

For native-gas chains, a low relayer balance triggers a durable treasury top-up. The target is
the greater of the next bundle prefund multiplied by `100` and the configured float target. If
Binance supplies the native USD price, a single top-up is capped at USD 2; without a price the
existing `VELA_RELAY_EXECUTOR_TOP_UP_MAX_WEI` cap is used instead.

## Tempo (pathUSD gas)

Tempo mainnet (`4217`) and Moderato (`42431`) are enabled without asset or oracle configuration.
Their outer transactions use Tempo's native `0x76` envelope and pay fees in pathUSD
(`0x20c0000000000000000000000000000000000000`, six decimals).

`vela_getInBandGasQuote` therefore returns the Safe's pathUSD balance as the single `erc20`
quote with `usdPrice: "1"`; it does not return a synthetic native-coin quote and makes no Binance
request. The UserOperation still uses zero EntryPoint fee fields and must include a trusted Safe
MultiSend transfer of at least `0.01` pathUSD to the settlement vault. `feeToken` is optional and
defaults to pathUSD; a different fee token is rejected until it has an explicit float-management
policy.

The executor derives the relayer's required pathUSD float from the declared UserOperation gas
limits, verifies the final `eth_simulateV1` execution and the exact pathUSD transfer log, then
submits `handleOps` in a signed `0x76` transaction. If the relayer float is low, the treasury
automatically sends a durable pathUSD top-up through a separate self-paying `0x76` transaction.

Tempo uses the same automatic controlled-directory RPC resolution. No Tempo-specific RPC
configuration is needed. Add an explicit endpoint only when you want it tried ahead of the
directory endpoints:

```dotenv
VELA_RELAY_EXECUTOR_RPC_URLS={"4217":"https://your-tempo-rpc.example"}
```

## Docker

Docker Compose starts only Relay; it deliberately connects to your existing remote Iggy and
Redis services rather than creating either of them.

```sh
cp .env.example .env
docker compose up --build -d
curl --fail http://127.0.0.1:4567/readyz
```

When Iggy or Redis runs on the Docker host, use `host.docker.internal` in their URLs instead of
`127.0.0.1`. For a published release image, set `VELA_RELAY_IMAGE` in `.env`, then run:

```sh
docker compose pull relay
docker compose up -d --no-build
```

See [the Docker deployment guide](docs/docker.md) for configuration details and Docker Hub
publishing setup.

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /{chain_id}` | ERC-4337 JSON-RPC endpoint for a chain, for example `POST /42161`. |
| `GET /healthz` | Liveness check; returns `204` while the process is alive. |
| `GET /readyz` | Readiness check; returns `204` after all worker jobs are ready. |
| `GET /health` | Service health information. |
| `GET /version` | Version information. |

## Releases

Pushing a `v*` tag creates native GitHub Release assets for Linux, macOS, and Windows across
Intel/AMD64 and ARM64 where the platform supports it. The same workflow publishes multi-platform
Linux Docker images (`linux/amd64` and `linux/arm64`) to
`${DOCKERHUB_USERNAME}/vela-relay`.

Each Docker image packages the exact matching Linux executable produced for the GitHub Release;
the workflow does not compile Rust a second time inside Docker.

For Docker Hub publishing, configure the repository Actions settings:

- Variable: `DOCKERHUB_USERNAME`
- Secret: `DOCKERHUB_TOKEN` (a Docker Hub token permitted to push the repository)

## Development

```sh
cargo fmt --check
cargo clippy --all-targets --locked
cargo test --locked
```

The integration test that requires a running Iggy service is intentionally ignored by default.
