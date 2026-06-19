/**
 * Tempo (chainId 4217) settlement — the single home for Tempo-specific bundler logic.
 *
 * Tempo has no native gas coin, so the canonical ERC-4337 prefund/refund is impossible
 * (a non-zero-maxFee UserOp fails AA21; EntryPoint.depositTo{value} reverts). Vela keeps
 * the SAME EntryPoint + Safe + passkey stack and adapts only settlement:
 *
 *   - The wallet signs the UserOp with maxFeePerGas = maxPriorityFeePerGas = 0 (so
 *     EntryPoint's native accounting is a no-op) and batches a
 *     `feeToken.transfer(bundlerEOA, reimbursement)` call into the UserOp.
 *   - This bundler submits `handleOps` inside a native Tempo 0x76 transaction with
 *     `feeToken` = a USD stablecoin (paying the real chain gas in it), and is repaid
 *     in-band by the batched transfer. It verifies the reimbursement covers its cost.
 *
 * The standard native gas path (profitability, native deposit/balance checks) is
 * SKIPPED on Tempo — see bundler/index.ts (one `isTempoChain` branch).
 */

import {
  createWalletClient,
  http,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  getAddress,
  slice,
  size,
  hexToNumber,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoMainnet, tempoModerato } from "viem/chains";
import { tempoActions } from "viem/tempo";
import type { PackedUserOperation } from "./userop/types.ts";
import { encodeHandleOps } from "./userop/encode.ts";

/** Tempo mainnet (4217) → its viem chain; Moderato testnet (42431) for dev. */
const TEMPO_CHAINS: Record<number, Chain> = {
  4217: tempoMainnet,
  42431: tempoModerato,
};

export function isTempoChain(chainId: number): boolean {
  return chainId in TEMPO_CHAINS;
}

/** Protocol-default fee token (pathUSD), used when a UserOp doesn't specify one. */
export const TEMPO_DEFAULT_FEE_TOKEN = "0x20c0000000000000000000000000000000000000" as const;
/** Every Tempo TIP-20 USD stablecoin uses 6 decimals (microdollar). */
export const TEMPO_FEE_TOKEN_DECIMALS = 6;
/** Tempo's protocol base fee fallback: 20e9 attodollars (USD×1e-18) per gas. */
export const TEMPO_BASE_FEE_ATTO = 20_000_000_000n;

/**
 * Added to the simulated handleOps gas when pricing the bundler's cost. The 0x76 tx
 * carries base-tx + fee-settlement overhead beyond what an `eth_simulateV1` of handleOps
 * reports, so we bump the cost basis up to stay conservative — the bundler must never
 * accept a reimbursement below its real on-chain outlay.
 */
export const TEMPO_COST_BUFFER_GAS = 80_000n;

/** Resolve & checksum the fee token, falling back to pathUSD. */
export function resolveFeeToken(feeToken?: string | null): `0x${string}` {
  if (feeToken && /^0x[0-9a-fA-F]{40}$/.test(feeToken)) return getAddress(feeToken);
  return getAddress(TEMPO_DEFAULT_FEE_TOKEN);
}

/** Our expected outer-0x76 cost in fee-token smallest units: gas × price (atto) → units. */
export function tempoCostInFeeToken(
  estimatedGas: bigint,
  gasPriceAtto: bigint,
  decimals: number = TEMPO_FEE_TOKEN_DECIMALS,
): bigint {
  const price = gasPriceAtto > 0n ? gasPriceAtto : TEMPO_BASE_FEE_ATTO;
  const atto = estimatedGas * price;
  return (atto * 10n ** BigInt(decimals)) / 10n ** 18n;
}

const EXECUTE_USER_OP_ABI = parseAbi([
  "function executeUserOp(address to, uint256 value, bytes data, uint8 operation)",
]);
const MULTISEND_ABI = parseAbi(["function multiSend(bytes transactions)"]);
const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
]);

/** Target pathUSD float to top a gas account up to when sponsoring. The gas account
 *  only needs to FRONT one tx's gas (~$0.01 transfer, ~$0.08 first-tx deploy); a small
 *  float is plenty and is replenished in-kind by each tx's reimbursement. */
export const TEMPO_SPONSOR_TARGET = 300_000n; // 0.3 pathUSD
/** Keep at least this much pathUSD in the treasury — won't sponsor below it. */
export const TEMPO_TREASURY_FLOOR = 200_000n; // 0.2 pathUSD

/** Read a pathUSD balance (6 decimals). */
export async function tempoPathUsdBalance(
  client: PublicClient,
  address: `0x${string}`,
): Promise<bigint> {
  return (await client.readContract({
    address: TEMPO_DEFAULT_FEE_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

/** Transfer pathUSD from the treasury to a gas account via a native 0x76 (gas in pathUSD). */
export async function sponsorTempoPathUsd(params: {
  chainId: number;
  privateKey: `0x${string}`;
  rpcUrl: string;
  to: `0x${string}`;
  amount: bigint;
}): Promise<`0x${string}`> {
  const chain = TEMPO_CHAINS[params.chainId];
  if (!chain) throw new Error(`Not a Tempo chain: ${params.chainId}`);
  const account = privateKeyToAccount(params.privateKey);
  const client = createWalletClient({ account, chain, transport: http(params.rpcUrl) }).extend(tempoActions());
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [params.to, params.amount] });
  const receipt = await client.sendTransactionSync({
    to: TEMPO_DEFAULT_FEE_TOKEN,
    data,
    feeToken: TEMPO_DEFAULT_FEE_TOKEN,
  });
  return receipt.transactionHash;
}

/**
 * Decode the in-band reimbursement: walk the UserOp's MultiSend batch and sum every
 * TIP-20 transfer to `recipient` (the bundler EOA) **in the trusted `feeToken`** — the
 * same stablecoin the bundler settles the 0x76 gas in. Returns 0n if the UserOp isn't a
 * MultiSend batch or contains no qualifying transfer.
 *
 * SECURITY — token allowlist: we must NOT count a transfer in an arbitrary token. The
 * amount is taken at face value (all Tempo stablecoins are 6-decimal, $1-pegged), so an
 * attacker could repay in a worthless token they deployed (face value ≥ cost), pass this
 * check AND execution, and drain the bundler's real pathUSD gas. Restricting to the
 * feeToken the bundler actually pays gas in closes that and removes cross-token valuation
 * risk (same token in, same token out). Trust-minimised: reads the signed calldata, not a
 * wallet-supplied amount.
 */
export function parseTempoReimbursement(
  callData: Hex,
  recipient: `0x${string}`,
  feeToken: `0x${string}`,
): bigint {
  // Normalise `recipient` (the bundler passes a lowercase eoa.address) and the trusted
  // `feeToken` so both match the checksummed addresses decoded from the batch.
  let target: `0x${string}`;
  let trustedToken: `0x${string}`;
  try {
    target = getAddress(recipient);
    trustedToken = getAddress(feeToken);
  } catch {
    return 0n;
  }
  try {
    const exec = decodeFunctionData({ abi: EXECUTE_USER_OP_ABI, data: callData });
    const innerData = exec.args[2] as Hex; // bytes -> the multiSend(bytes) call
    const ms = decodeFunctionData({ abi: MULTISEND_ABI, data: innerData });
    const txs = ms.args[0] as Hex; // packed: op(1) to(20) value(32) len(32) data(len)
    const total = size(txs);
    let off = 0;
    let sum = 0n;
    while (off < total) {
      const callTo = slice(txs, off + 1, off + 21); // sub-call target = the token contract
      const dataLen = hexToNumber(slice(txs, off + 53, off + 85));
      const innerCall = slice(txs, off + 85, off + 85 + dataLen);
      off += 85 + dataLen;
      // Only the trusted feeToken counts — see SECURITY note above.
      let tokenTrusted = false;
      try {
        tokenTrusted = getAddress(callTo) === trustedToken;
      } catch {
        tokenTrusted = false;
      }
      if (!tokenTrusted) continue;
      try {
        const t = decodeFunctionData({ abi: ERC20_ABI, data: innerCall });
        if (t.functionName === "transfer" && getAddress(t.args[0] as string) === target) {
          sum += t.args[1] as bigint;
        }
      } catch {
        // not a transfer call — ignore
      }
    }
    return sum;
  } catch {
    return 0n;
  }
}

/**
 * Outer-0x76 gas limit needed to honour every op's DECLARED limits. The EntryPoint
 * forwards `verificationGasLimit` then `callGasLimit` per op (each subject to the
 * 63/64 rule), so the tx must carry at least their sum plus tx/handleOps overhead.
 *
 * We must NOT lean on `eth_estimateGas` here: handleOps catches a UserOp's inner
 * revert/OOG and still succeeds, so the estimate settles at a value where the outer
 * tx passes but the inner op ran out of gas — exactly the failure we're avoiding.
 */
export function tempoHandleOpsGasLimit(packedOps: PackedUserOperation[]): bigint {
  let declared = 0n;
  for (const op of packedOps) {
    const agl = op.accountGasLimits.slice(2); // bytes32: vGL(16) | cGL(16)
    const vGL = BigInt("0x" + agl.slice(0, 32));
    const cGL = BigInt("0x" + agl.slice(32, 64));
    declared += vGL + cGL + op.preVerificationGas;
  }
  // 64/63 covers the gas the EntryPoint must retain to forward each call limit in
  // full; + per-op handleOps overhead + base-tx headroom. Unused gas isn't charged
  // on Tempo (fee = gasUsed × price), so a generous ceiling is free.
  return (declared * 64n) / 63n + BigInt(packedOps.length) * 50_000n + 60_000n;
}

/**
 * Submit `handleOps` inside a native Tempo 0x76 transaction paying gas in `feeToken`.
 * Returns the transaction hash. Uses viem's Tempo extension to build/sign the 0x76.
 */
export async function submitTempoBundle(params: {
  chainId: number;
  privateKey: `0x${string}`;
  rpcUrl: string;
  entryPoint: `0x${string}`;
  packedOps: PackedUserOperation[];
  beneficiary: `0x${string}`;
  feeToken: `0x${string}`;
}): Promise<`0x${string}`> {
  const chain = TEMPO_CHAINS[params.chainId];
  if (!chain) throw new Error(`Not a Tempo chain: ${params.chainId}`);
  const account = privateKeyToAccount(params.privateKey);
  const client = createWalletClient({
    account,
    chain,
    transport: http(params.rpcUrl),
  }).extend(tempoActions());

  const calldata = encodeHandleOps(params.packedOps, params.beneficiary);
  // Pin the outer gas to the ops' declared needs. Without this viem's eth_estimateGas
  // under-provisions (handleOps swallows inner OOG), starving the execution phase and
  // reverting the UserOp on-chain while the 0x76 still "succeeds".
  const gas = tempoHandleOpsGasLimit(params.packedOps);
  try {
    const receipt = await client.sendTransactionSync({
      to: params.entryPoint,
      data: calldata,
      feeToken: params.feeToken,
      gas,
    });
    return receipt.transactionHash;
  } catch (err) {
    // Surface the real reason instead of a swallowed promise rejection.
    const msg = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
    console.error(`[Tempo] 0x76 handleOps submit failed (eoa=${account.address}, feeToken=${params.feeToken}): ${msg}`);
    throw err;
  }
}
