/**
 * Vela Bundler — Private prepaid ERC-4337 / ERC-7769 multi-chain bundler.
 *
 * - Supports any EVM network listed at https://ethereum-data.awesometools.dev/
 * - Deterministic per-safeAddress dedicated bundler EOAs via HKDF-SHA256.
 * - No database — all state is derived or in-memory.
 * - Multi-chain: chainId comes per-request, services created lazily.
 *
 * Usage:
 *   deno task dev     — run with watch mode
 *   deno task start   — run in production
 *   deno task test    — run tests
 */

import { loadConfig } from "./src/config/index.ts";
import { LocalKeyManager } from "./src/keys/local.ts";
import { ChainRegistry } from "./src/chain/index.ts";
import { startRpcServer } from "./src/rpc/index.ts";

function main() {
  const config = loadConfig();

  console.log(`[Vela Bundler] Starting...`);
  console.log(`  EntryPoint:      ${config.entryPointAddress}`);
  console.log(`  Multi-chain:     yes (chainId per-request)`);
  if (config.userRpcUrls.length > 0) {
    console.log(`  User RPCs:       ${config.userRpcUrls.length} configured`);
  }
  console.log(`  Treasury:        ${config.treasuryAddress}`);
  console.log(`  Sweep interval:  every ${config.sweepInterval} bundles per EOA`);
  console.log(`  Min Margin:      ${config.minProfitMarginBps} bps`);
  console.log(`  Balance Reserve: ${config.balanceReserveMultiplier}x`);

  const keyManager = new LocalKeyManager({
    operatorSecret: config.operatorSecret,
    oldOperatorSecrets: config.oldOperatorSecrets,
  });

  const chainRegistry = new ChainRegistry(config, keyManager);

  startRpcServer(config, chainRegistry);

  console.log(`[Vela Bundler] Ready — listening on ${config.host}:${config.port}`);
}

if (import.meta.main) {
  main();
}

export { main };
