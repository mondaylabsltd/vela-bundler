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
import { MAX_SPONSOR_GAS, TRANSFER_GAS_FALLBACK, TREASURY_FLOOR } from "../account/sponsor.ts";
import type { Alerter } from "./telegram.ts";

/** Consecutive balance-read failures before alerting that the treasury is UNMONITORABLE.
 *  ≈100s at the Worker's 10s alarm / 5 min at Deno's 30s loop — long enough to skip RPC
 *  blips, short enough that depletion can't proceed unwatched for long. */
const READ_FAILURE_ALERT_STREAK = 10;

/** Consecutive read failures per chain. Module-level (mirrors the process-global circuit
 *  signal): one map per isolate is exactly the scope of the monitor itself. */
const readFailures = new Map<number, number>();

/** How long a fetched gas price is reused for the dynamic threshold — avoids adding one
 *  eth_gasPrice call to EVERY health cycle. */
const GAS_PRICE_CACHE_MS = 5 * 60 * 1000;
const gasPriceCache = new Map<number, { at: number; price: bigint }>();

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
  let threshold = tempo ? params.thresholdPathUsd : params.thresholdWei;

  let balance: bigint;
  try {
    balance = tempo
      ? await withTimeout(tempoPathUsdBalance(client, treasuryAddress), RPC_TIMEOUT_MS, "treasury pathUSD balance")
      : await withTimeout(client.getBalance({ address: treasuryAddress }), RPC_TIMEOUT_MS, "treasury balance");
    readFailures.delete(chainId);
  } catch (err) {
    console.warn(`[TreasuryMonitor] balance read failed on chain ${chainId}: ${err instanceof Error ? err.message : err}`);
    // A monitor that can't read is itself an unwatched-depletion risk: after a sustained
    // failure streak, tell the operator the treasury is UNMONITORABLE (not merely "low").
    const streak = (readFailures.get(chainId) ?? 0) + 1;
    readFailures.set(chainId, streak);
    if (streak >= READ_FAILURE_ALERT_STREAK) {
      await alerter.send(
        `treasury-unreadable-${chainId}`,
        `⚠️ Vela Bundler — treasury balance UNREADABLE on chain ${chainId} for ${streak} consecutive ` +
          `health cycles. Depletion below the alert threshold would go UNDETECTED. Check the RPC.`,
      );
    }
    return null;
  }

  // Native chains: raise the static threshold to the sponsor's DYNAMIC fail-closed floor
  // (TREASURY_FLOOR + worst-case sponsor amount + transfer gas at the current gas price).
  // Without this there is a dead zone — e.g. 0.03 ETH at 10 gwei — where sponsorship is
  // already failing closed but the static 0.02 ETH alert never fires. Gas price is cached
  // (5 min) and failure-tolerant: on read failure the static threshold still applies.
  if (!tempo) {
    try {
      const cached = gasPriceCache.get(chainId);
      let gasPrice: bigint;
      if (cached && Date.now() - cached.at < GAS_PRICE_CACHE_MS) {
        gasPrice = cached.price;
      } else {
        gasPrice = await withTimeout(client.getGasPrice(), RPC_TIMEOUT_MS, "treasury gasPrice");
        gasPriceCache.set(chainId, { at: Date.now(), price: gasPrice });
      }
      const dynamicFloor = TREASURY_FLOOR + (MAX_SPONSOR_GAS + TRANSFER_GAS_FALLBACK) * gasPrice;
      if (dynamicFloor > threshold) threshold = dynamicFloor;
    } catch {
      // Keep the static threshold — the read-failure streak above covers a dead RPC.
    }
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
