/**
 * Treasury sweep — every `sweepInterval` transactions, transfer up to half of the
 * relayer EOA's *surplus* balance back to the treasury, never dipping below a floor
 * that keeps the gas account funded for the user's next few transactions.
 *
 * Why this shape (see the two user goals):
 *   1. Keep the gas account solvent — we sweep `min(50% of balance, balance − floor)`,
 *      so we only ever skim the surplus that has accumulated from per-tx reimbursement
 *      (each bundle repays the relayer with a markup), never the working float.
 *   2. Keep the treasury topped up — recycling that surplus funds sponsorship of new
 *      users. The mechanism self-regulates: a relayer hovering near its float doesn't
 *      get swept; only one that has genuinely accumulated does.
 *
 * Cadence: gated on the relayer's on-chain nonce (`nonce % sweepInterval == 0`). The
 * nonce IS the per-(user, chain) transaction count, so no extra state is needed.
 *
 * Tempo (no native coin): the relayer's float is pathUSD; we sweep it back via a 0x76
 * `feeToken.transfer` (gas paid in pathUSD), floor = the sponsor float target.
 *
 * Failure is non-fatal — sweep is skipped on error, the next interval retries.
 */

import {
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BundlerConfig } from "../config/types.ts";
import { getPublicClient } from "../utils/rpc-client.ts";
import {
  isTempoChain,
  tempoPathUsdBalance,
  sponsorTempoPathUsd,
  TEMPO_SPONSOR_TARGET,
} from "../tempo.ts";

/** Fallback gas limit for simple ETH transfers. Arbitrum and other L2s may need
 *  more than 21k due to L1 data fees counted in gas. */
const SWEEP_GAS_FALLBACK = 100_000n;

/** Fraction of balance to sweep: 50% (numerator / denominator). Bounded below by
 *  the floor (see SWEEP_FLOOR_GAS), so this is an upper bound, not a fixed cut. */
const SWEEP_FRACTION_NUM = 50n;
const SWEEP_FRACTION_DEN = 100n;

/** Native floor: keep at least this many gas-units' worth of native on the relayer
 *  (× current gasPrice) so the next few bundles can still be fronted after a sweep.
 *  A freshly-sponsored relayer sits below this, so it's never swept until per-tx
 *  reimbursement has pushed it into genuine surplus. Tunable. */
const SWEEP_FLOOR_GAS = 3_000_000n;

/** Minimum sweepable amount — don't bother with dust (also used for pathUSD units). */
const MIN_SWEEPABLE = 10_000n; // 10k wei native / 0.01 pathUSD

export interface SweepResult {
  swept: boolean;
  txHash?: `0x${string}`;
  amount?: bigint;
  error?: string;
}

/**
 * Interval gate: does this relayer nonce land on a sweep boundary? The nonce is the
 * per-(user, chain) tx count, so `nonce % interval == 0` fires once every `interval`
 * txs. `interval <= 0` disables the gate (always sweep); nonce 0 means no tx yet.
 * Pure — unit-tested in sweep_test.ts.
 */
export function isSweepNonce(nonce: number, interval: number): boolean {
  if (interval <= 0) return true;
  return nonce > 0 && nonce % interval === 0;
}

/**
 * Surplus to sweep back to treasury: `min(50% of balance, balance − floor)`, then less
 * the sweep tx's own gas (`gasCost`, 0 for pathUSD). Returns 0n when the result is at
 * or below the dust threshold — i.e. nothing worth sweeping, or balance ≤ floor. This
 * is what guarantees the gas account keeps ≥ floor for the user's next txs. Pure —
 * unit-tested in sweep_test.ts.
 */
export function sweepableAmount(balance: bigint, floor: bigint, gasCost: bigint = 0n): bigint {
  const half = (balance * SWEEP_FRACTION_NUM) / SWEEP_FRACTION_DEN;
  const aboveFloor = balance > floor ? balance - floor : 0n;
  const capped = half < aboveFloor ? half : aboveFloor;
  const net = capped - gasCost;
  return net > MIN_SWEEPABLE ? net : 0n;
}

/**
 * Execute a sweep of the relayer EOA's surplus back to treasury.
 *
 * Called after each confirmed-successful bundle. Reads the relayer nonce and only
 * proceeds when `nonce % config.sweepInterval == 0` (the interval gate); otherwise
 * returns early. Routes to native or Tempo (pathUSD) settlement by `config.chainId`.
 * Non-fatal on failure.
 */
export async function executeSweep(params: {
  eoaAddress: `0x${string}`;
  eoaPrivateKey: `0x${string}`;
  treasuryAddress: `0x${string}`;
  rpcUrl: string;
  config: BundlerConfig;
}): Promise<SweepResult> {
  const { eoaAddress, eoaPrivateKey, treasuryAddress, rpcUrl, config } = params;

  try {
    const client = getPublicClient(rpcUrl);

    // Interval gate — the relayer nonce is the per-(user, chain) tx count. Read it only
    // when the gate is active, then defer to isSweepNonce.
    if (config.sweepInterval > 0) {
      const nonce = await client.getTransactionCount({ address: eoaAddress });
      if (!isSweepNonce(nonce, config.sweepInterval)) {
        return { swept: false, error: "not_at_sweep_interval" };
      }
    }

    if (isTempoChain(config.chainId)) {
      return await executeTempoSweep({ eoaAddress, eoaPrivateKey, treasuryAddress, rpcUrl, config });
    }

    const [balance, block] = await Promise.all([
      client.getBalance({ address: eoaAddress }),
      client.getBlock({ blockTag: "latest" }),
    ]);

    const baseFee = block.baseFeePerGas ?? 1_000_000_000n;

    // Query chain-suggested tip
    let tip = 0n;
    try {
      const tipRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_maxPriorityFeePerGas", params: [] }),
      });
      const tipJson = await tipRes.json() as { result?: string };
      if (tipJson.result) tip = BigInt(tipJson.result);
    } catch {
      tip = baseFee / 10n || 1n; // 10% of baseFee as fallback
    }

    const gasPrice = baseFee + tip;

    // Estimate gas for the transfer — L2s like Arbitrum need more than 21k
    let sweepGas = SWEEP_GAS_FALLBACK;
    try {
      const estimated = await client.estimateGas({
        account: eoaAddress,
        to: treasuryAddress,
        value: 1n, // minimal value for estimation
      });
      sweepGas = (estimated * 120n) / 100n; // 20% buffer
      if (sweepGas < 21_000n) sweepGas = 21_000n;
    } catch { /* use fallback */ }

    const sweepGasCost = sweepGas * gasPrice;

    // Sweep the surplus above a float floor (keeps enough native for the user's next
    // few bundles), net of the sweep tx's own gas. See sweepableAmount.
    const floor = SWEEP_FLOOR_GAS * gasPrice;
    const sweepable = sweepableAmount(balance, floor, sweepGasCost);

    if (sweepable <= 0n) {
      return { swept: false, error: "Sweepable amount too small" };
    }

    const account = privateKeyToAccount(eoaPrivateKey);
    const walletClient = createWalletClient({
      account,
      transport: http(rpcUrl),
    });

    const txHash = await walletClient.sendTransaction({
      to: treasuryAddress,
      value: sweepable,
      maxFeePerGas: baseFee * 2n + tip,
      maxPriorityFeePerGas: tip,
      gas: sweepGas,
      chain: null,
      account,
    });

    console.log(
      `[Sweep] ${eoaAddress} → ${treasuryAddress}: ${sweepable} wei (50% above floor of ${balance}) tx: ${txHash}`,
    );

    // Wait for confirmation (short timeout — don't block too long)
    try {
      await client.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    } catch {
      console.warn(`[Sweep] Confirmation timeout for ${txHash}, continuing`);
    }

    return { swept: true, txHash, amount: sweepable };
  } catch (err) {
    console.warn(
      `[Sweep] Failed for ${eoaAddress}: ${err instanceof Error ? err.message : err}`,
    );
    return { swept: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Tempo sweep — relayer's float is pathUSD (6-dec), gas is paid in pathUSD via 0x76.
 * Sweep min(50% of balance, balance − TEMPO_SPONSOR_TARGET) back to the treasury; the
 * floor (= the sponsor top-up target) leaves ample pathUSD to both front the next few
 * txs and pay this sweep's own (~$0.01) gas. Mirrors the sponsor's treasury→relayer
 * transfer, reversed.
 */
async function executeTempoSweep(params: {
  eoaAddress: `0x${string}`;
  eoaPrivateKey: `0x${string}`;
  treasuryAddress: `0x${string}`;
  rpcUrl: string;
  config: BundlerConfig;
}): Promise<SweepResult> {
  const { eoaAddress, eoaPrivateKey, treasuryAddress, rpcUrl, config } = params;

  const client = getPublicClient(rpcUrl);
  const balance = await tempoPathUsdBalance(client, eoaAddress);

  // pathUSD gas comes out of the retained floor, so no separate gasCost here.
  const sweepable = sweepableAmount(balance, TEMPO_SPONSOR_TARGET);

  if (sweepable <= 0n) {
    return { swept: false, error: "Sweepable amount too small" };
  }

  const txHash = await sponsorTempoPathUsd({
    chainId: config.chainId,
    privateKey: eoaPrivateKey,
    rpcUrl,
    to: treasuryAddress,
    amount: sweepable,
  });

  console.log(
    `[Sweep][Tempo] ${eoaAddress} → ${treasuryAddress}: ${sweepable} pathUSD units (50% above floor of ${balance}) tx: ${txHash}`,
  );

  return { swept: true, txHash, amount: sweepable };
}
