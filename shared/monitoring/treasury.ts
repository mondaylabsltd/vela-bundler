/**
 * Treasury-balance monitor.
 *
 * The treasury (one address, same on every chain) pays for gas sponsorship and accrues the
 * settlement split. If it depletes, sponsorship silently fails closed and the operator loses
 * new-user onboarding with no other signal. This checks the treasury's balance on a chain each
 * health cycle and fires a de-duplicated Telegram alert when it drops below a threshold.
 *
 * Native chains: the native coin balance (wei). Tempo chains: the pathUSD float (6-dec units).
 */

import { type PublicClient, type Transport, type Chain } from "viem";
import { withTimeout, RPC_TIMEOUT_MS } from "../utils/timeout.ts";
import { isTempoChain, tempoPathUsdBalance } from "../tempo.ts";
import type { Alerter } from "./telegram.ts";

export interface TreasuryCheckResult {
  chainId: number;
  balance: bigint;
  threshold: bigint;
  belowThreshold: boolean;
  token: "native" | "pathUSD";
}

/** Human-readable amount for an alert (approximate; for display only). */
function fmt(value: bigint, decimals: number, symbol: string): string {
  const whole = value / 10n ** BigInt(decimals);
  const frac = value % 10n ** BigInt(decimals);
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole}.${fracStr} ${symbol}`;
}

/**
 * Check a chain's treasury balance and alert (deduped) if below the configured threshold.
 * Returns the result, or null if the balance read failed (RPC error — no alert, try next cycle).
 * Never throws.
 */
export async function checkTreasuryBalance(params: {
  chainId: number;
  chainName: string | null;
  treasuryAddress: `0x${string}`;
  client: PublicClient<Transport, Chain>;
  thresholdWei: bigint;
  thresholdPathUsd: bigint;
  alerter: Alerter;
}): Promise<TreasuryCheckResult | null> {
  const { chainId, chainName, treasuryAddress, client, alerter } = params;
  const tempo = isTempoChain(chainId);
  const token: "native" | "pathUSD" = tempo ? "pathUSD" : "native";
  const threshold = tempo ? params.thresholdPathUsd : params.thresholdWei;

  let balance: bigint;
  try {
    balance = tempo
      ? await withTimeout(tempoPathUsdBalance(client, treasuryAddress), RPC_TIMEOUT_MS, "treasury pathUSD balance")
      : await withTimeout(client.getBalance({ address: treasuryAddress }), RPC_TIMEOUT_MS, "treasury balance");
  } catch (err) {
    console.warn(`[TreasuryMonitor] balance read failed on chain ${chainId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  const belowThreshold = balance < threshold;
  if (belowThreshold) {
    const label = chainName ? `${chainName} (${chainId})` : `chain ${chainId}`;
    const amount = tempo ? fmt(balance, 6, "pathUSD") : fmt(balance, 18, "ETH");
    const thr = tempo ? fmt(threshold, 6, "pathUSD") : fmt(threshold, 18, "ETH");
    // Dedup key is per-chain so each chain alerts independently but not repeatedly.
    await alerter.send(
      `treasury-low-${chainId}`,
      `⚠️ Vela Bundler: treasury LOW on ${label}\n` +
        `balance ${amount} < threshold ${thr}\n` +
        `address ${treasuryAddress}\n` +
        `Sponsorship will fail closed below the floor — top up the treasury.`,
    );
  }

  return { chainId, balance, threshold, belowThreshold, token };
}
