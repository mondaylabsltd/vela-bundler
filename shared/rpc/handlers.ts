/**
 * RPC method handlers implementing ERC-7769 / ERC-4337 bundler spec.
 * Multi-chain: chainId resolved from request (X-Chain-Id header or RPC params).
 */

import type { RequestContext } from "./process.ts";
import type { BundlerConfig } from "../config/types.ts";
import type { ChainRegistryLike, ChainServices } from "../chain/index.ts";
import {
  methodNotFound,
  invalidParams,
  bundlerError,
  serviceDegraded,
} from "./errors.ts";
import { RPC_ERROR_CODES } from "../contracts/entrypoint.ts";
import { normalizeUserOp, userOpToRpc } from "../userop/normalize.ts";
import { validateUserOpFields, UserOpValidationError } from "../userop/validate.ts";
import { isTempoChain } from "../tempo.ts";
import { calcPreVerificationGas } from "../gas/preVerificationGas.ts";
import {
  calcUserOpGasPrice,
  calcUserOpMaxGas,
  calcOuterTxGasPrice,
} from "../gas/profitability.ts";
import { blacklistRpc, isRpcBlacklisted, hasFallback } from "../utils/rpc-blacklist.ts";
import { applyMarkup, reverseMarkup, markupToBps } from "../gas/fee-model.ts";
import { createDeadline } from "../reliability/retry.ts";
import { getClassification } from "../reliability/errors.ts";
import { redactUrl } from "../reliability/log.ts";

/**
 * End-to-end budget for the synchronous accept path (eth_sendUserOperation /
 * eth_estimateUserOperationGas). All downstream read RPCs (gas price, balance,
 * simulation) share this single deadline so a slow/down upstream can NEVER make the
 * request hang for minutes — it fails fast with a stable, retryable degraded error.
 */
const REQUEST_DEADLINE_MS = 15_000;

/**
 * Map an upstream-dependency error to a stable, retryable SERVICE_DEGRADED JSON-RPC
 * error. Never leaks the raw provider message/stack — only a stable reason + optional
 * Retry-After hint, so the client can back off and retry without parsing prose.
 */
function degradedFromError(err: unknown, what: string): ReturnType<typeof serviceDegraded> {
  const cls = getClassification(err);
  return serviceDegraded(
    `${what} temporarily unavailable — please retry`,
    { reason: cls.reason, retryAfterMs: cls.retryAfterMs },
  );
}

/**
 * Dispatch an RPC method to its handler.
 */
export async function handleRpcMethod(
  method: string,
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<unknown> {
  switch (method) {
    case "eth_sendUserOperation":
      return await handleSendUserOperation(params, config, chainRegistry, reqCtx);
    case "eth_estimateUserOperationGas":
      return await handleEstimateUserOperationGas(params, config, chainRegistry, reqCtx);
    case "eth_getUserOperationByHash":
      return handleGetUserOperationByHash(params, config, chainRegistry, reqCtx);
    case "eth_getUserOperationReceipt":
      return handleGetUserOperationReceipt(params, config, chainRegistry, reqCtx);
    case "eth_supportedEntryPoints":
      return [config.entryPointAddress];
    case "eth_chainId":
      return "0x" + reqCtx.chainId.toString(16);
    case "pimlico_getUserOperationGasPrice":
      return await handleGetUserOperationGasPrice(config, chainRegistry, reqCtx);
    default:
      throw methodNotFound(method);
  }
}

async function resolveChain(
  chainId: number,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<ChainServices> {
  try {
    return await chainRegistry.getChain(chainId, reqCtx.requestRpcUrl);
  } catch (err) {
    console.error(`[RPC] Chain resolution failed for chainId ${chainId}:`, err);
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `Unsupported or unreachable chain: ${chainId}`,
    );
  }
}

// --- Standard ERC-7769 Methods ---

async function handleSendUserOperation(
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<`0x${string}`> {
  if (!params[0] || !params[1]) {
    throw invalidParams("Expected [userOp, entryPoint]");
  }

  const chain = await resolveChain(reqCtx.chainId, chainRegistry, reqCtx);
  // Single end-to-end budget shared by all downstream read RPCs (gas/balance/sim) so a
  // slow/down upstream fails fast with a stable retryable error instead of hanging.
  const deadline = createDeadline(REQUEST_DEADLINE_MS);
  // Tempo public RPCs are flaky (timeouts) — use the bundler's configured (Alchemy) RPC.
  let rpcOverride = isTempoChain(reqCtx.chainId) ? undefined : reqCtx.requestRpcUrl;

  // If the user's RPC was previously blacklisted and we have a different
  // chain default (Alchemy / public), skip the bad URL upfront.
  // For dev networks where chain.rpcUrl === rpcOverride (no alternative), keep using it.
  if (rpcOverride && isRpcBlacklisted(rpcOverride) && hasFallback(rpcOverride, chain.rpcUrl)) {
    console.warn(`[RPC] Skipping blacklisted user RPC ${redactUrl(rpcOverride)}, using chain default ${redactUrl(chain.rpcUrl)}`);
    rpcOverride = undefined;
  }

  const entryPoint = params[1] as string;
  if (entryPoint.toLowerCase() !== config.entryPointAddress.toLowerCase()) {
    throw invalidParams(`Unsupported EntryPoint: ${entryPoint}`);
  }

  let userOp;
  try {
    userOp = normalizeUserOp(params[0]);
  } catch (err) {
    if (err instanceof UserOpValidationError) {
      throw bundlerError(err.code, err.message);
    }
    throw invalidParams("Invalid UserOperation");
  }

  try {
    // Tempo requires maxFeePerGas = 0 (no native coin; gas paid in a stablecoin 0x76).
    validateUserOpFields(userOp, isTempoChain(reqCtx.chainId));
  } catch (err) {
    if (err instanceof UserOpValidationError) {
      throw bundlerError(err.code, err.message);
    }
    throw err;
  }

  // --- Private bundler binding checks ---
  const safeAddress = userOp.sender;
  const eoa = await chain.accountService.deriveEOA(safeAddress);

  // Check EOA nonce/lock state — always refresh from chain to auto-recover
  // from dropped/confirmed txs (e.g. low gas price txs evicted from mempool).
  const eoaState = chain.accountService.lockManager.getState(eoa.address);
  if (eoaState?.status === "LOCKED_IN_MEMORY_PENDING") {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      "Dedicated bundler EOA is currently processing a bundle. Retry later.",
    );
  }
  // For LOCKED_PENDING_UNKNOWN or first-time init: re-check chain nonce.
  // If the pending tx was dropped or confirmed, initEOA will recover to ACTIVE.
  const freshState = await chain.accountService.lockManager.initEOA(
    eoa.address,
    chain.accountService.getClient(),
  );
  if (freshState.status === "LOCKED_PENDING_UNKNOWN") {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      "EOA_HAS_UNKNOWN_PENDING_TX: dedicated bundler EOA has unknown pending transactions.",
    );
  }

  // Tempo settles gas in a stablecoin via the bundler's 0x76 (see shared/tempo.ts), so
  // the native balance / priority-fee floor / gas-price-margin checks below don't apply
  // (maxFeePerGas = 0 there is required, not a misconfiguration).
  const tempo = isTempoChain(reqCtx.chainId);

  // Check balance — use chain-aware gas pricing
  let gasPrices;
  try {
    gasPrices = await chain.simulator.getGasPrices(rpcOverride, deadline);
  } catch (err) {
    if (rpcOverride && hasFallback(rpcOverride, chain.rpcUrl)) {
      console.warn(`[RPC] getGasPrices failed on user RPC ${redactUrl(rpcOverride)}, blacklisting and retrying with chain default ${redactUrl(chain.rpcUrl)}`);
      blacklistRpc(rpcOverride);
      rpcOverride = undefined;
      try {
        gasPrices = await chain.simulator.getGasPrices(undefined, deadline);
      } catch (retryErr) {
        throw degradedFromError(retryErr, "gas price");
      }
    } else {
      throw degradedFromError(err, "gas price");
    }
  }
  const baseFee = gasPrices.baseFee;
  const outerGas = calcOuterTxGasPrice({
    currentBaseFee: baseFee,
    baseFeeMultiplier: config.baseFeeMultiplier,
    bundlerTipGwei: config.bundlerTipGwei,
    chainSuggestedTip: gasPrices.suggestedMaxPriorityFeePerGas,
  });
  const maxGas = calcUserOpMaxGas(userOp);
  // Gate on the node's PREFUND rule (gasLimit × maxFeePerGas), matching the bundler's
  // submit-time gate — gating on the softer effective price here would accept ops whose
  // EOA can never afford the actual broadcast, so the user gets "accepted" and then a
  // guaranteed 5-min TTL miss instead of a synchronous "deposit to X" error.
  const estimatedCost = maxGas * outerGas.maxFeePerGas;

  console.log(`[RPC] Balance check: eoa=${eoa.address} maxGas=${maxGas} effectiveGasPrice=${outerGas.effectiveGasPrice} estimatedCost=${estimatedCost} rpcOverride=${rpcOverride ?? 'none'}`);
  let balanceCheck;
  try {
    balanceCheck = await chain.accountService.checkBalance(safeAddress, estimatedCost, rpcOverride);
    console.log(`[RPC] Balance result: spendable=${balanceCheck.spendableBalance} required=${balanceCheck.requiredBalance} sufficient=${balanceCheck.sufficient}`);
  } catch (err) {
    // If user-provided RPC failed and chain has a different default, blacklist + retry.
    // A balance-query failure is INFRA (transient), not a bad UserOp — return the stable
    // retryable SERVICE_DEGRADED code, never the business INVALID_USEROPERATION code.
    if (rpcOverride && hasFallback(rpcOverride, chain.rpcUrl)) {
      console.warn(`[RPC] User RPC ${redactUrl(rpcOverride)} failed, blacklisting and retrying with chain default (${redactUrl(chain.rpcUrl)})`);
      blacklistRpc(rpcOverride);
      rpcOverride = undefined;
      try {
        balanceCheck = await chain.accountService.checkBalance(safeAddress, estimatedCost, undefined);
        console.log(`[RPC] Balance result (fallback): spendable=${balanceCheck.spendableBalance} required=${balanceCheck.requiredBalance} sufficient=${balanceCheck.sufficient}`);
      } catch (retryErr) {
        console.error(`[RPC] Balance query also failed on chain default RPC:`, getClassification(retryErr).reason);
        throw degradedFromError(retryErr, "balance check");
      }
    } else {
      // No fallback available (dev network or already using chain default)
      console.error(`[RPC] Balance query failed for ${safeAddress}:`, getClassification(err).reason);
      throw degradedFromError(err, "balance check");
    }
  }
  if (!balanceCheck.sufficient) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `Insufficient ${tempo ? 'pathUSD' : 'native'} balance on dedicated bundler gas account. ` +
      `Spendable: ${balanceCheck.spendableBalance}, required: ${balanceCheck.requiredBalance}. ` +
      `Deposit to: ${eoa.address}`,
    );
  }

  // --- Standard ERC-4337 checks ---
  const minPvg = calcPreVerificationGas(userOp, {
    expectedBundleSize: config.maxBundleSize,
  });
  if (userOp.preVerificationGas < minPvg) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `preVerificationGas too low: ${userOp.preVerificationGas} < required ${minPvg}`,
    );
  }

  if (!tempo && userOp.maxPriorityFeePerGas < config.minPriorityFeePerGas) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `maxPriorityFeePerGas too low: ${userOp.maxPriorityFeePerGas} < minimum ${config.minPriorityFeePerGas}`,
    );
  }

  // Gas price margin check.
  // Derive the intended outer gas price the same way the bundler does:
  //   outerGasPrice = userOpGasPrice / walletGasMarkup
  // Margin = walletGasMarkup - 1 (constant, independent of speed tier).
  // Speed tier scales both the user cost and the outer gas price equally.
  const userOpGasPrice = calcUserOpGasPrice(userOp, baseFee);
  // Reverse the markup to recover the intended network price (single source of truth:
  // shared/gas/fee-model.ts, consistent bps scale with the quote below).
  const derivedOuterPrice = reverseMarkup(userOpGasPrice, markupToBps(config.walletGasMarkup));

  // Sanity check: derived outer price must not be absurdly below chain rate.
  // Use 5x tolerance — on cheap-gas chains (Gnosis, ~0.001 Gwei) the gas price
  // fluctuates by 2-3x between blocks, making a 50% threshold too strict.
  if (!tempo && derivedOuterPrice * 5n < outerGas.effectiveGasPrice) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `Gas price too low: derived outer price ${derivedOuterPrice} < ` +
      `20% of chain rate ${outerGas.effectiveGasPrice}`,
    );
  }

  // Simulate validation. A `transient` result means the simulation could not be
  // completed (RPC degraded / deadline), NOT that the UserOp is invalid — surface it as
  // a retryable degraded error so the wallet retries instead of discarding a good op.
  const simResult = await chain.simulator.simulateValidation(userOp, rpcOverride, deadline);
  if (!simResult.valid) {
    if (simResult.transient) throw serviceDegraded("validation simulation temporarily unavailable — please retry", { reason: "simulation_degraded" });
    throw bundlerError(
      simResult.errorCode ?? RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
      simResult.errorMessage ?? "Simulation failed",
    );
  }

  // Simulate execution — catch callData reverts before accepting into mempool
  const execResult = await chain.simulator.simulateExecution(userOp, rpcOverride, deadline);
  if (!execResult.success) {
    if (execResult.transient) throw serviceDegraded("execution simulation temporarily unavailable — please retry", { reason: "simulation_degraded" });
    throw bundlerError(
      execResult.errorCode ?? RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
      execResult.errorMessage ?? "Execution simulation failed",
    );
  }

  // Add to mempool
  try {
    const userOpHash = chain.mempool.add(
      userOp,
      simResult.validationResult?.prefund ?? 0n,
      rpcOverride,
    );
    // Kick a bundle pass NOW (fire-and-forget) instead of waiting out the next 10s
    // alarm/interval tick — for a 5-minute trading window those seconds are money.
    // Never blocks or fails this response; the periodic tick remains the safety net.
    chain.bundler.requestBundleKick();
    return userOpHash;
  } catch (err) {
    if (err instanceof UserOpValidationError) {
      throw bundlerError(err.code, err.message);
    }
    throw err;
  }
}

async function handleEstimateUserOperationGas(
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<Record<string, string>> {
  if (!params[0] || !params[1]) {
    throw invalidParams("Expected [userOp, entryPoint]");
  }

  const chain = await resolveChain(reqCtx.chainId, chainRegistry, reqCtx);
  // Tempo public RPCs are flaky (timeouts) — use the bundler's configured (Alchemy) RPC.
  let rpcOverride = isTempoChain(reqCtx.chainId) ? undefined : reqCtx.requestRpcUrl;

  if (rpcOverride && isRpcBlacklisted(rpcOverride) && hasFallback(rpcOverride, chain.rpcUrl)) {
    console.warn(`[RPC] Skipping blacklisted user RPC ${redactUrl(rpcOverride)}, using chain default ${redactUrl(chain.rpcUrl)}`);
    rpcOverride = undefined;
  }

  const entryPoint = params[1] as string;
  if (entryPoint.toLowerCase() !== config.entryPointAddress.toLowerCase()) {
    throw invalidParams(`Unsupported EntryPoint: ${entryPoint}`);
  }

  let userOp;
  try {
    userOp = normalizeUserOp(params[0]);
  } catch (err) {
    if (err instanceof UserOpValidationError) {
      throw bundlerError(err.code, err.message);
    }
    throw invalidParams("Invalid UserOperation");
  }

  const deadline = createDeadline(REQUEST_DEADLINE_MS);
  let gasEstimate;
  try {
    gasEstimate = await chain.simulator.estimateUserOpGas(userOp, rpcOverride, deadline);
  } catch (err) {
    if (rpcOverride && hasFallback(rpcOverride, chain.rpcUrl)) {
      console.warn(`[RPC] estimateGas failed on user RPC ${redactUrl(rpcOverride)}, blacklisting and retrying with chain default ${redactUrl(chain.rpcUrl)}`);
      blacklistRpc(rpcOverride);
      try {
        gasEstimate = await chain.simulator.estimateUserOpGas(userOp, undefined, deadline);
      } catch (retryErr) {
        throw degradedFromError(retryErr, "gas estimation");
      }
    } else {
      throw degradedFromError(err, "gas estimation");
    }
  }

  const result: Record<string, string> = {
    preVerificationGas: "0x" + gasEstimate.preVerificationGas.toString(16),
    verificationGasLimit: "0x" + gasEstimate.verificationGasLimit.toString(16),
    callGasLimit: "0x" + gasEstimate.callGasLimit.toString(16),
  };

  if (gasEstimate.paymasterVerificationGasLimit !== null) {
    result.paymasterVerificationGasLimit =
      "0x" + gasEstimate.paymasterVerificationGasLimit.toString(16);
  }

  return result;
}

/**
 * pimlico_getUserOperationGasPrice — the bundler is the single source of truth for
 * the gas price. It quotes three speed tiers; the wallet uses the quote verbatim
 * and shows it (it never marks the price up on its own).
 *
 * Pricing policy (one knob, `config.walletGasMarkup`, default 2.0):
 *   networkPrice = max(baseFee + tip×tierMul, eth_gasPrice)   // real on-chain cost
 *   userPrice    = networkPrice × walletGasMarkup             // what the user pays
 *   relayerFee   = userPrice − networkPrice                   // Vela's cut (≈ networkPrice at 2×)
 *
 * `maxPriorityFeePerGas == maxFeePerGas` so the EntryPoint charges exactly
 * `userPrice` per gas (no on-chain price refund below it). Tiers scale only the
 * priority tip, i.e. inclusion speed; the markup is constant across tiers.
 *
 * The extra `networkFeePerGas` / `relayerFeePerGas` fields are a Vela extension
 * that lets the wallet render an honest "network vs relayer" split. Standard
 * clients ignore them.
 */
async function handleGetUserOperationGasPrice(
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<Record<string, Record<string, string>>> {
  const chain = await resolveChain(reqCtx.chainId, chainRegistry, reqCtx);

  let rpcOverride = reqCtx.requestRpcUrl;
  if (rpcOverride && isRpcBlacklisted(rpcOverride) && hasFallback(rpcOverride, chain.rpcUrl)) {
    rpcOverride = undefined;
  }

  let baseFee: bigint, suggestedMaxPriorityFeePerGas: bigint, chainGasPrice: bigint;
  try {
    ({ baseFee, suggestedMaxPriorityFeePerGas, chainGasPrice } =
      await chain.simulator.getGasPrices(rpcOverride));
  } catch (err) {
    // All price reads failed — return a RETRYABLE degraded error, never a 0x0 quote the
    // user would sign and then have rejected at submission.
    throw degradedFromError(err, "gas price");
  }

  // walletGasMarkup is a float (e.g. 2.0); scale to bps for integer math (single source
  // of truth: shared/gas/fee-model.ts — same scale the bundle uses to reverse it).
  const markupBps = markupToBps(config.walletGasMarkup);

  // Speed tiers scale the priority tip only (as a percentage). Faster tier →
  // higher tip → faster inclusion; the relayer markup stays the same.
  // Never quote 0: validateUserOpFields rejects maxFeePerGas = 0, so a 0x0 quote is
  // self-refuting — the wallet would display "~0", sign it, and be rejected right
  // here at submit. The catch above only covers THROWN price failures, but the reads
  // can RESOLVE to all-zeros (an HTTP-200 rate-limit/error envelope on the forwarded
  // X-Rpc-Url, or a zero-gas dev fork). All-zero signals = no usable price → the same
  // retryable degraded error, so the wallet falls back to its own local estimate.
  if (baseFee <= 0n && suggestedMaxPriorityFeePerGas <= 0n && chainGasPrice <= 0n) {
    throw degradedFromError(new Error("all gas price signals are zero"), "gas price");
  }

  function quote(tipMulPercent: number): Record<string, string> {
    const tip = (suggestedMaxPriorityFeePerGas * BigInt(tipMulPercent)) / 100n;
    // Real on-chain cost at this speed, floored at eth_gasPrice so legacy /
    // minimum-gas-price chains (BSC, Polygon) are never under-priced.
    let networkPrice = baseFee + tip;
    if (chainGasPrice > networkPrice) networkPrice = chainGasPrice;

    const userPrice = applyMarkup(networkPrice, markupBps);
    const relayerPrice = userPrice > networkPrice ? userPrice - networkPrice : 0n;

    return {
      maxFeePerGas: "0x" + userPrice.toString(16),
      maxPriorityFeePerGas: "0x" + userPrice.toString(16),
      networkFeePerGas: "0x" + networkPrice.toString(16),
      relayerFeePerGas: "0x" + relayerPrice.toString(16),
    };
  }

  return {
    slow: quote(100), // tip × 1.0
    standard: quote(150), // tip × 1.5
    fast: quote(200), // tip × 2.0
  };
}

function handleGetUserOperationByHash(
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Record<string, unknown> | null {
  const hash = params[0] as string;
  if (!hash || typeof hash !== "string" || !hash.startsWith("0x")) {
    throw invalidParams("Expected userOpHash as hex string");
  }

  // Search requested chain first, then fall back to all chains
  const allChains = chainRegistry.getAll();
  const sortedChains = allChains.sort((a, b) =>
    a.chainId === reqCtx.chainId ? -1 : b.chainId === reqCtx.chainId ? 1 : 0,
  );
  for (const chain of sortedChains) {
    const memEntry = chain.mempool.get(hash);
    if (memEntry) {
      return {
        userOperation: userOpToRpc(memEntry.userOp),
        entryPoint: config.entryPointAddress,
        blockNumber: null,
        blockHash: null,
        transactionHash: null,
      };
    }

    const receipt = chain.bundler.getReceipt(hash);
    if (receipt) {
      return {
        userOperation: { sender: receipt.sender, nonce: "0x" + receipt.nonce.toString(16) },
        entryPoint: receipt.entryPoint,
        blockNumber: "0x" + receipt.receipt.blockNumber.toString(16),
        blockHash: receipt.receipt.blockHash,
        transactionHash: receipt.receipt.transactionHash,
      };
    }
  }

  return null;
}

function handleGetUserOperationReceipt(
  params: unknown[],
  _config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Record<string, unknown> | null {
  const hash = params[0] as string;
  if (!hash || typeof hash !== "string" || !hash.startsWith("0x")) {
    throw invalidParams("Expected userOpHash as hex string");
  }

  const allChains = chainRegistry.getAll();
  const sortedChains = allChains.sort((a, b) =>
    a.chainId === reqCtx.chainId ? -1 : b.chainId === reqCtx.chainId ? 1 : 0,
  );
  for (const chain of sortedChains) {
    const receipt = chain.bundler.getReceipt(hash);
    if (!receipt) continue;

    return {
      userOpHash: receipt.userOpHash,
      entryPoint: receipt.entryPoint,
      sender: receipt.sender,
      nonce: "0x" + receipt.nonce.toString(16),
      paymaster: receipt.paymaster ?? "0x0000000000000000000000000000000000000000",
      actualGasCost: "0x" + receipt.actualGasCost.toString(16),
      actualGasUsed: "0x" + receipt.actualGasUsed.toString(16),
      success: receipt.success,
      logs: receipt.logs.map((l) => ({
        logIndex: "0x" + l.logIndex.toString(16),
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: "0x" + l.blockNumber.toString(16),
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
      })),
      receipt: {
        transactionHash: receipt.receipt.transactionHash,
        transactionIndex: "0x" + receipt.receipt.transactionIndex.toString(16),
        blockHash: receipt.receipt.blockHash,
        blockNumber: "0x" + receipt.receipt.blockNumber.toString(16),
        from: receipt.receipt.from,
        to: receipt.receipt.to,
        cumulativeGasUsed: "0x" + receipt.receipt.cumulativeGasUsed.toString(16),
        gasUsed: "0x" + receipt.receipt.gasUsed.toString(16),
        effectiveGasPrice: "0x" + receipt.receipt.effectiveGasPrice.toString(16),
      },
    };
  }

  return null;
}
