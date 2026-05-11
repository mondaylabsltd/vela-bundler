/**
 * Treasury sweep — periodically transfer excess balance from dedicated EOAs
 * to the operator's treasury address.
 *
 * Trigger: before bundling, when EOA's nonce is a multiple of sweepInterval.
 * Runs inside the bundle lock so nonce ordering is safe.
 * Failure is non-fatal — sweep is skipped, next trigger will retry.
 */

import {
  createWalletClient,
  http,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BundlerConfig } from "../config/index.ts";
import { getPublicClient } from "../utils/rpc-client.ts";

const SWEEP_GAS = 21_000n;

export interface SweepResult {
  swept: boolean;
  txHash?: `0x${string}`;
  amount?: bigint;
  error?: string;
}

/**
 * Check if a sweep should be attempted for this EOA at the given nonce.
 */
export function shouldSweep(
  nonce: number,
  sweepInterval: number,
  treasuryAddress: `0x${string}` | null,
): boolean {
  if (!treasuryAddress) return false;
  if (sweepInterval <= 0) return false;
  if (nonce === 0) return false; // Don't sweep on first ever tx
  return nonce % sweepInterval === 0;
}

/**
 * Execute a sweep: transfer excess balance to treasury.
 *
 * retainAmount = currentGasPrice × 10_000_000 (enough for ~10+ future bundles)
 * sweepable = balance - retainAmount - sweepGasCost
 *
 * Must be called inside bundle lock. Non-fatal on failure.
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

    // Get current balance and gas price
    const [balance, block] = await Promise.all([
      client.getBalance({ address: eoaAddress }),
      client.getBlock({ blockTag: "latest" }),
    ]);

    const baseFee = block.baseFeePerGas ?? parseGwei("1");
    const tip = BigInt(Math.ceil(config.bundlerTipGwei * 1e9));
    const gasPrice = baseFee + tip;

    // Retain enough for future bundles: gasPrice × 10_000_000
    const retainAmount = gasPrice * 10_000_000n;
    const sweepGasCost = SWEEP_GAS * gasPrice;
    const sweepable = balance - retainAmount - sweepGasCost;

    if (sweepable <= 0n) {
      return { swept: false, error: "Balance below retain threshold" };
    }

    // Send sweep transaction
    const account = privateKeyToAccount(eoaPrivateKey);
    const walletClient = createWalletClient({
      account,
      transport: http(rpcUrl),
    });

    const txHash = await walletClient.sendTransaction({
      to: treasuryAddress,
      value: sweepable,
      maxFeePerGas: baseFee * 2n + tip, // generous to ensure inclusion
      maxPriorityFeePerGas: tip,
      gas: SWEEP_GAS,
      chain: null,
      account,
    });

    console.log(
      `[Sweep] ${eoaAddress} → ${treasuryAddress}: ${sweepable} wei (tx: ${txHash})`,
    );

    // Wait for confirmation (short timeout — don't block bundling too long)
    try {
      await client.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    } catch {
      // Confirmation timeout is OK — tx is submitted, nonce is consumed
      console.warn(`[Sweep] Confirmation timeout for ${txHash}, continuing`);
    }

    return { swept: true, txHash, amount: sweepable };
  } catch (err) {
    // Sweep failure is non-fatal
    console.warn(
      `[Sweep] Failed for ${eoaAddress}: ${err instanceof Error ? err.message : err}`,
    );
    return { swept: false, error: err instanceof Error ? err.message : String(err) };
  }
}
