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
import { createAlerter } from "../shared/monitoring/telegram.ts";
import { redactError } from "../shared/reliability/log.ts";

async function main() {
  // Treasury address is always derived from OPERATOR_SECRET (same address on all chains).
  const secret = Deno.env.get("OPERATOR_SECRET");
  if (!secret) throw new Error("Missing required environment variable: OPERATOR_SECRET");
  const treasuryAddress = await deriveTreasuryAddress(secret);
  const config = loadConfig(treasuryAddress);

  // One process-level alerter, shared with the registry/sponsor so every alert id dedups
  // against a single map. Logs loudly whether alerting is ENABLED or DISABLED.
  const alerter = createAlerter(config);

  // A code bug escaping every inner catch must NOT kill the fund-custody process silently:
  // keep the process alive (preventDefault), page the operator, and log. Timers, server and
  // in-memory state remain coherent — an unhandled rejection here is by definition a bug in
  // a background promise, not a corrupted core loop.
  globalThis.addEventListener("unhandledrejection", (ev) => {
    ev.preventDefault();
    console.error("[Fatal] unhandled rejection:", redactError(ev.reason));
    void alerter.send(
      "fatal-unhandled",
      `🐛 Vela Bundler (deno) — UNHANDLED REJECTION (code bug):\n${redactError(ev.reason).slice(0, 500)}\n` +
        `Process kept alive; investigate immediately.`,
    );
  });
  globalThis.addEventListener("error", (ev) => {
    ev.preventDefault();
    console.error("[Fatal] uncaught error:", redactError(ev.error ?? ev.message));
    void alerter.send(
      "fatal-uncaught",
      `🐛 Vela Bundler (deno) — UNCAUGHT ERROR (code bug):\n${redactError(ev.error ?? ev.message).slice(0, 500)}\n` +
        `Process kept alive; investigate immediately.`,
    );
  });

  console.log(`[Vela Bundler] Starting...`);
  console.log(`  EntryPoint:      ${config.entryPointAddress}`);
  console.log(`  Multi-chain:     yes (chainId per-request)`);
  console.log(`  Treasury:        ${config.treasuryAddress} (derived)`);
  console.log(`  Splitter:        ${config.splitterAddress} (CREATE2 beneficiary, native chains)`);
  console.log(`  Min Margin:      ${config.minProfitMarginBps} bps`);
  console.log(`  Balance Reserve: ${config.balanceReserveMultiplier}x`);

  const keyManager = new LocalKeyManager({
    operatorSecret: config.operatorSecret,
    oldOperatorSecrets: config.oldOperatorSecrets,
  });

  const chainRegistry = new ChainRegistry(config, keyManager, alerter);
  const sponsorService = new SponsorService(config, alerter);

  const server = startRpcServer(config, chainRegistry, sponsorService);

  // Boot ping: proves the Telegram pipe end-to-end on every start, and makes a systemd
  // crash-restart loop VISIBLE as repeated boot messages (cooldownMs 0 — each restart has
  // a fresh dedup map anyway; the explicit 0 documents the intent).
  void alerter.send(
    "startup",
    `🟢 Vela Bundler (deno) started — ${config.host}:${config.port}, treasury ${config.treasuryAddress}`,
    { cooldownMs: 0 },
  );

  // Graceful shutdown: stop accepting requests, stop all timers (no new bundles start while
  // draining), then let in-flight HTTP requests finish. In-flight on-chain txs are recovered
  // from chain nonce on next start (conservative-restart invariant), so we don't block on them.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Vela Bundler] ${signal} received — draining…`);
    chainRegistry.dispose();
    try {
      await server.shutdown();
    } catch (err) {
      console.error("[Vela Bundler] Error during server shutdown:", err);
    }
    console.log("[Vela Bundler] Shutdown complete.");
  };
  // SIGTERM: systemd stop/restart. SIGINT: Ctrl-C in a terminal.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(sig, () => void shutdown(sig));
    } catch {
      // Some platforms don't support all signals — non-fatal.
    }
  }

  console.log(`[Vela Bundler] Ready — listening on ${config.host}:${config.port}`);
}

if (import.meta.main) {
  // A startup failure must exit non-zero (systemd Restart= + OnFailure= alert unit key off
  // it) instead of leaving a half-started process behind an unhandled rejection.
  main().catch((err) => {
    console.error("[Vela Bundler] fatal startup error:", err);
    Deno.exit(1);
  });
}

export { main };
