#!/usr/bin/env bash
#
# Launcher script for running eth-infinitism bundler-spec-tests against Vela Bundler
# (Cloudflare Workers runtime, booted locally via `wrangler dev`).
#
# Prerequisites:
#   - Anvil (from foundry) installed: https://book.getfoundry.sh/
#   - Node 20+ and this repo's deps installed (`npm ci`)
#   - bundler-spec-tests cloned: https://github.com/eth-infinitism/bundler-spec-tests
#
# Usage:
#   ./scripts/run-spec-tests.sh [path-to-bundler-spec-tests]
#
# Environment:
#   BUNDLER_PORT       Port for `wrangler dev` (default: 8787)
#   ANVIL_PORT         Port for Anvil (default: 8545)
#   CHAIN_ID           Local chain id (default: 31337 — anvil's default)
#   ENTRY_POINT        EntryPoint v0.7 address (default: 0x0000000071727De22E5E9d8BAf0edAc6f37da032)
#
# ⚠ NOT EXERCISED IN CI, and NOT turnkey for a fresh local chain. The Workers bundler routes
#   JSON-RPC by path (POST /:chainId) and resolves each chain's RPC from its built-in registry,
#   Alchemy, or a per-request `X-Rpc-Url` header. A brand-new local anvil (chain 31337) is in
#   none of those, so the bundler cannot reach your anvil unless every request carries
#   `X-Rpc-Url: http://localhost:${ANVIL_PORT}`. The stock eth-infinitism harness does not send
#   custom headers, so to actually drive spec tests against local anvil you must either:
#     (a) point --url at a tiny reverse proxy that injects that header, or
#     (b) add a local registry entry for your chain id.
#   This script boots the stack and points the harness at it; wiring the local RPC is on you.

set -euo pipefail

SPEC_TESTS_DIR="${1:-./bundler-spec-tests}"
BUNDLER_PORT="${BUNDLER_PORT:-8787}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
CHAIN_ID="${CHAIN_ID:-31337}"
ENTRY_POINT="${ENTRY_POINT:-0x0000000071727De22E5E9d8BAf0edAc6f37da032}"
BUNDLER_URL="http://localhost:${BUNDLER_PORT}/${CHAIN_ID}"
HEALTH_URL="http://localhost:${BUNDLER_PORT}/health"

echo "=== Vela Bundler Spec Test Runner (Cloudflare Workers) ==="
echo "Bundler URL:   $BUNDLER_URL"
echo "Anvil port:    $ANVIL_PORT"
echo "Chain id:      $CHAIN_ID"
echo "EntryPoint:    $ENTRY_POINT"
echo ""

# 1. Start Anvil
echo "[1/4] Starting Anvil on port $ANVIL_PORT..."
anvil --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --silent &
ANVIL_PID=$!
sleep 2

cleanup() {
  echo "Cleaning up..."
  kill $ANVIL_PID 2>/dev/null || true
  kill $BUNDLER_PID 2>/dev/null || true
}
trap cleanup EXIT

# 2. Deploy EntryPoint v0.7
echo "[2/4] EntryPoint v0.7 should be deployed at its deterministic address."
echo "       If using a fresh Anvil, you may need to deploy it first."
echo "       See: https://github.com/eth-infinitism/account-abstraction"

# 3. Start Vela Bundler via wrangler dev (local Workers runtime)
echo "[3/4] Starting Vela Bundler (wrangler dev) on port $BUNDLER_PORT..."
npx wrangler dev \
  --port "$BUNDLER_PORT" \
  --var OPERATOR_SECRET:0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --var ENTRY_POINT_ADDRESS:"$ENTRY_POINT" \
  --var BUNDLING_MODE:manual \
  --var MIN_PRIORITY_FEE_PER_GAS:0 \
  --var MIN_PROFIT_MARGIN_BPS:0 &
BUNDLER_PID=$!
sleep 5

# Verify the worker is up (global /health needs no chain init / RPC)
echo "Checking bundler health..."
curl -s "$HEALTH_URL" | python3 -m json.tool || {
  echo "ERROR: Bundler is not responding on $HEALTH_URL"
  exit 1
}

echo ""

# 4. Run spec tests
echo "[4/4] Running bundler-spec-tests..."
if [ -d "$SPEC_TESTS_DIR" ]; then
  cd "$SPEC_TESTS_DIR"
  pdm run pytest -rsx -v \
    --url "$BUNDLER_URL" \
    --entry-point "$ENTRY_POINT" \
    --ethereum-node "http://localhost:${ANVIL_PORT}" \
    tests/
else
  echo "WARNING: bundler-spec-tests directory not found at $SPEC_TESTS_DIR"
  echo ""
  echo "To run spec tests:"
  echo "  1. git clone https://github.com/eth-infinitism/bundler-spec-tests"
  echo "  2. cd bundler-spec-tests && pdm install"
  echo "  3. ./scripts/run-spec-tests.sh ./bundler-spec-tests"
  echo ""
  echo "Bundler is running at $BUNDLER_URL — you can test manually."
  echo "Press Ctrl+C to stop."
  wait $BUNDLER_PID
fi
