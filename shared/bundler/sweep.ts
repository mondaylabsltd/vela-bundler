/**
 * Treasury sweep — after each bundle, transfer 25% of the relayer EOA's
 * remaining balance to the treasury.
 *
 * This keeps the treasury funded for sponsoring new users while leaving
 * enough balance on the relayer for future transactions.
 *
 * Failure is non-fatal — sweep is skipped on error, next bundle will retry.
 */

import {
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BundlerConfig } from "../config/types.ts";
import { getPublicClient } from "../utils/rpc-client.ts";

/** Fallback gas limit for simple ETH transfers. Arbitrum and other L2s may need
 *  more than 21k due to L1 data fees counted in gas. */
const SWEEP_GAS_FALLBACK = 100_000n;

/** Fraction of balance to sweep: 25% (numerator / denominator). */
const SWEEP_FRACTION_NUM = 25n;
const SWEEP_FRACTION_DEN = 100n;

/** Minimum sweepable amount — don't bother with dust. */
const MIN_SWEEPABLE = 10_000n; // 10k wei

export interface SweepResult {
  swept: boolean;
  txHash?: `0x${string}`;
  amount?: bigint;
  error?: string;
}

/**
 * Execute a sweep: transfer 25% of the relayer EOA's balance to treasury.
 *
 * Called after each successful bundle submission. Non-fatal on failure.
 */
export async function executeSweep(params: {
  eoaAddress: `0x${string}`;
  eoaPrivateKey: `0x${string}`;
  treasuryAddress: `0x${string}`;
  rpcUrl: string;
  config: BundlerConfig;
}): Promise<SweepResult> {
  const { eoaAddress, eoaPrivateKey, treasuryAddress, rpcUrl } = params;

  try {
    const client = getPublicClient(rpcUrl);

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

    // 25% of current balance, minus gas cost for the sweep tx
    const sweepable = (balance * SWEEP_FRACTION_NUM) / SWEEP_FRACTION_DEN - sweepGasCost;

    if (sweepable <= MIN_SWEEPABLE) {
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
      `[Sweep] ${eoaAddress} → ${treasuryAddress}: ${sweepable} wei (25% of ${balance}) tx: ${txHash}`,
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
