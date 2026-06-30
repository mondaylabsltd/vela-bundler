/**
 * L2 data fee estimation for rollup chains (Arbitrum, Optimism, Base, etc.).
 *
 * On rollups, transactions pay an additional fee for posting calldata to L1.
 * This module estimates that fee in L2 gas units so it can be included in
 * preVerificationGas.
 *
 * Architecture follows rundler's DAGasOracle pattern:
 * - Arbitrum: NodeInterface.gasEstimateL1Component → returns gas units directly
 * - OP Stack: GasPriceOracle.getL1Fee → returns wei, divided by gasPrice → gas units
 */

import { getPublicClient } from "../utils/rpc-client.ts";
import { ceilDiv } from "./fee-model.ts";

// ---------------------------------------------------------------------------
// Chain ID sets
// ---------------------------------------------------------------------------

/** Arbitrum One and Arbitrum Sepolia. */
const ARBITRUM_CHAIN_IDS = new Set([42161, 421614]);

/** OP Stack chains: Optimism, Base, and their testnets. */
const OP_STACK_CHAIN_IDS = new Set([10, 8453, 11155420, 84532]);

// ---------------------------------------------------------------------------
// Precompile addresses
// ---------------------------------------------------------------------------

/**
 * Arbitrum NodeInterface precompile.
 * gasEstimateL1Component(address, bool, bytes) → (gasEstimateForL1, baseFee, l1BaseFeeEstimate)
 * See: https://docs.arbitrum.io/build-decentralized-apps/nodeinterface/reference
 */
const ARB_NODE_INTERFACE = "0x00000000000000000000000000000000000000C8" as const;

/**
 * OP Stack GasPriceOracle precompile.
 * getL1Fee(bytes) → uint256 (fee in wei)
 * See: https://docs.optimism.io/stack/transactions/fees#the-l1-data-fee
 */
const OP_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F" as const;

// ---------------------------------------------------------------------------
// Function selectors
// ---------------------------------------------------------------------------

/** gasEstimateL1Component(address,bool,bytes) */
const GAS_ESTIMATE_L1_COMPONENT_SIG = "0x77d488a2" as const;

/** getL1Fee(bytes) */
const GET_L1_FEE_SIG = "0x49948e0e" as const;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function isArbitrumChain(chainId: number): boolean {
  return ARBITRUM_CHAIN_IDS.has(chainId);
}

export function isOpStackChain(chainId: number): boolean {
  return OP_STACK_CHAIN_IDS.has(chainId);
}

/** Check if a chain is an L2 rollup that needs DA fee estimation. */
export function isL2WithDataFee(chainId: number): boolean {
  return isArbitrumChain(chainId) || isOpStackChain(chainId);
}

// ---------------------------------------------------------------------------
// Arbitrum — NodeInterface
// ---------------------------------------------------------------------------

/**
 * Estimate the L1 data fee for an Arbitrum transaction,
 * expressed in L2 gas units (NodeInterface returns gas units directly).
 */
export async function estimateArbitrumL1Gas(
  to: `0x${string}`,
  calldata: `0x${string}`,
  rpcUrl: string,
): Promise<bigint> {
  try {
    const client = getPublicClient(rpcUrl);

    // Encode: gasEstimateL1Component(address to, bool contractCreation, bytes data)
    const paddedTo = to.slice(2).padStart(64, "0");
    const contractCreation = "0".repeat(64); // false
    // Dynamic offset for bytes parameter (3 × 32 = 96 = 0x60)
    const bytesOffset = "0000000000000000000000000000000000000000000000000000000000000060";
    const rawCalldata = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
    const calldataLen = (rawCalldata.length / 2).toString(16).padStart(64, "0");
    const paddedCalldata = rawCalldata + "0".repeat((64 - (rawCalldata.length % 64)) % 64);

    const data = `${GAS_ESTIMATE_L1_COMPONENT_SIG}${paddedTo}${contractCreation}${bytesOffset}${calldataLen}${paddedCalldata}` as `0x${string}`;

    const result = await client.call({
      to: ARB_NODE_INTERFACE,
      data,
    });

    if (!result.data || result.data.length < 66) {
      console.warn("[L2Fee] NodeInterface returned empty/short result");
      return 0n;
    }

    // First 32 bytes of return = gasEstimateForL1 (already in L2 gas units)
    const gasEstimateForL1 = BigInt("0x" + result.data.slice(2, 66));
    console.log(`[L2Fee] Arbitrum L1 gas estimate: ${gasEstimateForL1} gas units`);
    return gasEstimateForL1;
  } catch (err) {
    console.warn("[L2Fee] Failed to estimate Arbitrum L1 gas, falling back to 0:", err);
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// OP Stack — GasPriceOracle
// ---------------------------------------------------------------------------

/**
 * Estimate the L1 data fee for an OP Stack transaction,
 * expressed in L2 gas units.
 *
 * GasPriceOracle.getL1Fee returns the fee in wei. We divide by the current
 * L2 gas price to convert to gas units (same approach as rundler).
 */
export async function estimateOpStackL1Gas(
  calldata: `0x${string}`,
  gasPrice: bigint,
  rpcUrl: string,
): Promise<bigint> {
  if (gasPrice === 0n) {
    console.warn("[L2Fee] gasPrice is zero, cannot convert OP Stack L1 fee to gas units");
    return 0n;
  }

  try {
    const client = getPublicClient(rpcUrl);

    // Encode: getL1Fee(bytes data)
    // Dynamic offset for bytes parameter (1 × 32 = 32 = 0x20)
    const bytesOffset = "0000000000000000000000000000000000000000000000000000000000000020";
    const rawCalldata = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
    const calldataLen = (rawCalldata.length / 2).toString(16).padStart(64, "0");
    const paddedCalldata = rawCalldata + "0".repeat((64 - (rawCalldata.length % 64)) % 64);

    const data = `${GET_L1_FEE_SIG}${bytesOffset}${calldataLen}${paddedCalldata}` as `0x${string}`;

    const result = await client.call({
      to: OP_GAS_PRICE_ORACLE,
      data,
    });

    if (!result.data || result.data.length < 66) {
      console.warn("[L2Fee] GasPriceOracle returned empty/short result");
      return 0n;
    }

    // Return value = L1 fee in wei
    const l1FeeWei = BigInt("0x" + result.data.slice(2, 66));
    // Convert wei → gas units by dividing by gasPrice. Round UP: this is a COST the
    // bundler must recover via preVerificationGas — truncating down would under-recover
    // the L1 data fee by up to ~1 gas-unit's worth of wei per tx.
    const l1GasUnits = ceilDiv(l1FeeWei, gasPrice);

    console.log(`[L2Fee] OP Stack L1 fee: ${l1FeeWei} wei → ${l1GasUnits} gas units (at gasPrice=${gasPrice})`);
    return l1GasUnits;
  } catch (err) {
    console.warn("[L2Fee] Failed to estimate OP Stack L1 gas, falling back to 0:", err);
    return 0n;
  }
}
