/**
 * Vela Bundler — Private prepaid ERC-4337 / ERC-7769 bundler for EntryPoint v0.7.
 *
 * - Supports any EVM network listed at https://ethereum-data.awesometools.dev/
 * - Deterministic per-safeAddress dedicated bundler EOAs via HKDF-SHA256.
 * - No database — all state is derived or in-memory.
 *
 * Usage:
 *   deno task dev     — run with watch mode
 *   deno task start   — run in production
 *   deno task test    — run tests
 */

import { loadConfig } from "./src/config/index.ts";
import { createSimulator } from "./src/simulation/index.ts";
import { Mempool } from "./src/mempool/index.ts";
import { BundlerService } from "./src/bundler/index.ts";
import { AccountService } from "./src/account/index.ts";
import { LocalKeyManager } from "./src/keys/local.ts";
import { startRpcServer, type RpcContext } from "./src/rpc/index.ts";

async function main() {
  const config = await loadConfig();

  console.log(`[Vela Bundler] Starting...`);
  console.log(`  Chain:          ${config.chainInfo?.name ?? "Unknown"} (${config.chainId})`);
  console.log(`  RPC:            ${config.rpcUrl}`);
  if (config.publicRpcs.length > 1) {
    console.log(`  Fallback RPCs:  ${config.publicRpcs.length - 1} available`);
  }
  console.log(`  EntryPoint:     ${config.entryPointAddress}`);
  console.log(`  EIP-1559:       ${config.useEip1559}`);
  console.log(`  Mode:           ${config.mode}`);
  console.log(`  Bundling:       ${config.bundlingMode}`);
  if (config.oldOperatorSecrets.length > 0) {
    console.log(`  Old secrets:    ${config.oldOperatorSecrets.length} (for sweep)`);
  }
  if (config.treasuryAddress) {
    console.log(`  Treasury:       ${config.treasuryAddress}`);
    console.log(`  Sweep interval: every ${config.sweepInterval} bundles per EOA`);
  }
  console.log(`  Min Margin:     ${config.minProfitMarginBps} bps`);
  console.log(`  Balance Reserve: ${config.balanceReserveMultiplier}x`);

  // Create key manager
  const keyManager = new LocalKeyManager({
    operatorSecret: config.operatorSecret,
    oldOperatorSecrets: config.oldOperatorSecrets,
  });

  // Create services
  const simulator = createSimulator(config);

  const mempool = new Mempool({
    entryPointAddress: config.entryPointAddress,
    chainId: config.chainId,
    maxMempoolSize: 4096,
    stakedSenderMaxOps: 4,
  });

  const accountService = new AccountService({
    keyManager,
    config,
    balanceReserveMultiplier: config.balanceReserveMultiplier,
  });

  const bundler = new BundlerService(config, mempool, simulator, accountService);

  const ctx: RpcContext = { config, mempool, simulator, bundler, accountService };

  // Start RPC + REST server
  startRpcServer(ctx);

  // Start auto-bundling if configured
  bundler.startAutoBundling();

  // Reputation decay every hour
  setInterval(() => {
    mempool.reputation.decay();
  }, 3600_000);

  console.log(`[Vela Bundler] Ready.`);
}

if (import.meta.main) {
  main();
}

export { main };
