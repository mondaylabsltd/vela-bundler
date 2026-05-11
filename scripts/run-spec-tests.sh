#!/usr/bin/env bash
#
# Launcher script for running eth-infinitism bundler-spec-tests against Vela Bundler.
#
# Prerequisites:
#   - Anvil (from foundry) installed: https://book.getfoundry.sh/
#   - Deno 2+ installed
#   - bundler-spec-tests cloned: https://github.com/eth-infinitism/bundler-spec-tests
#
# Usage:
#   ./scripts/run-spec-tests.sh [path-to-bundler-spec-tests]
#
# Environment:
#   BUNDLER_PORT       Port for the bundler (default: 3300)
#   ANVIL_PORT         Port for Anvil (default: 8545)
#   ENTRY_POINT        EntryPoint v0.7 address (default: 0x0000000071727De22E5E9d8BAf0edAc6f37da032)
#

set -euo pipefail

SPEC_TESTS_DIR="${1:-./bundler-spec-tests}"
BUNDLER_PORT="${BUNDLER_PORT:-3300}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
ENTRY_POINT="${ENTRY_POINT:-0x0000000071727De22E5E9d8BAf0edAc6f37da032}"
BUNDLER_URL="http://localhost:${BUNDLER_PORT}/rpc"

echo "=== Vela Bundler Spec Test Runner ==="
echo "Bundler port:  $BUNDLER_PORT"
echo "Anvil port:    $ANVIL_PORT"
echo "EntryPoint:    $ENTRY_POINT"
echo ""

# 1. Start Anvil
echo "[1/4] Starting Anvil on port $ANVIL_PORT..."
anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
sleep 2

cleanup() {
  echo "Cleaning up..."
  kill $ANVIL_PID 2>/dev/null || true
  kill $BUNDLER_PID 2>/dev/null || true
}
trap cleanup EXIT

# 2. Deploy EntryPoint v0.7
echo "[2/4] EntryPoint v0.7 should be deployed at deterministic address."
echo "       If using a fresh Anvil, you may need to deploy it first."
echo "       See: https://github.com/eth-infinitism/account-abstraction"

# 3. Start Vela Bundler
echo "[3/4] Starting Vela Bundler on port $BUNDLER_PORT..."
RPC_URL="http://localhost:${ANVIL_PORT}" \
CHAIN_ID=31337 \
ENTRY_POINT_ADDRESS="$ENTRY_POINT" \
BENEFICIARY_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" \
PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" \
PORT="$BUNDLER_PORT" \
MODE=testing \
BUNDLING_MODE=manual \
MIN_PRIORITY_FEE_PER_GAS=0 \
MIN_PROFIT_MARGIN_BPS=0 \
deno run --allow-net --allow-env --allow-read main.ts &
BUNDLER_PID=$!
sleep 3

# Verify bundler is running
echo "Checking bundler health..."
curl -s -X POST "$BUNDLER_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}' \
  | python3 -m json.tool || {
    echo "ERROR: Bundler is not responding"
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
