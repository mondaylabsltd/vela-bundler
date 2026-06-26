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

import { loadConfig } from "./config.ts";
import { LocalKeyManager } from "../shared/keys/local.ts";
import { ChainRegistry } from "../shared/chain/index.ts";
import { startRpcServer } from "./server.ts";
import { deriveTreasuryAddress } from "../shared/keys/derive.ts";
import { SponsorService } from "../shared/account/sponsor.ts";

async function main() {
  // Treasury address is always derived from OPERATOR_SECRET (same address on all chains).
  const secret = Deno.env.get("OPERATOR_SECRET");
  if (!secret) throw new Error("Missing required environment variable: OPERATOR_SECRET");
  const treasuryAddress = await deriveTreasuryAddress(secret);
  const config = loadConfig(treasuryAddress);

  console.log(`[Vela Bundler] Starting...`);
  console.log(`  EntryPoint:      ${config.entryPointAddress}`);
  console.log(`  Multi-chain:     yes (chainId per-request)`);
  console.log(`  Treasury:        ${config.treasuryAddress} (derived)`);
  console.log(`  Sweep:           50% of surplus every ${config.sweepInterval} txs (native + Tempo pathUSD)`);
  console.log(`  Min Margin:      ${config.minProfitMarginBps} bps`);
  console.log(`  Balance Reserve: ${config.balanceReserveMultiplier}x`);

  const keyManager = new LocalKeyManager({
    operatorSecret: config.operatorSecret,
    oldOperatorSecrets: config.oldOperatorSecrets,
  });

  const chainRegistry = new ChainRegistry(config, keyManager);
  const sponsorService = new SponsorService(config);

  startRpcServer(config, chainRegistry, sponsorService);

  console.log(`[Vela Bundler] Ready — listening on ${config.host}:${config.port}`);
}

if (import.meta.main) {
  main();
}

export { main };
