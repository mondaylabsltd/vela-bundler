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
import { TREASURY_FLOOR } from "../account/sponsor.ts";
import { normalizeUserOp, userOpToRpc } from "../userop/normalize.ts";
import { receiptToRpc, receiptToByHashRpc } from "./receipt-format.ts";
import { validateUserOpFields, UserOpValidationError } from "../userop/validate.ts";
import { EnqueueAmbiguousError } from "../bundler/index.ts";
import { isTempoChain, inBandActiveForChain, vaultActiveForChain, IN_BAND_MARKUP_X } from "../tempo.ts";
import { quoteNativeToStable, stableDecimals, requiredStableCharge, requiredNativeCharge } from "../gas/stable-rate.ts";
import { getAddress } from "viem";
import { getPublicClient } from "../utils/rpc-client.ts";
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
import { redactUrl, logEvent, metrics } from "../reliability/log.ts";

/**
 * End-to-end budget for the synchronous accept path (eth_sendUserOperation /
 * eth_estimateUserOperationGas). All downstream read RPCs (gas price, balance,
 * simulation) share this single deadline so a slow/down upstream can NEVER make the
 * request hang for minutes — it fails fast with a stable, retryable degraded error.
 */
const REQUEST_DEADLINE_MS = 15_000;

/** Per-(chain, what) consecutive-degrade streaks. A synchronous degrade rides an HTTP-200
 *  envelope so it never trips the RPC circuit breaker — without this a chain stuck quoting
 *  zero, or a fee-token whose DEX quoter persistently fails, would degrade every request while
 *  the operator sees only healthy-looking telemetry. Module-level state is correct: handlers run
 *  inside the long-lived per-chain DO isolate. A clean success resets the streak (see noteOk). */
const degradeStreaks = new Map<string, number>();
/** Escalate the log to error level once a (chain, what) has degraded this many times in a row. */
const DEGRADE_ESCALATE_AT = 5;

/** Record a SUCCESSFUL pricing/quote op so a recovered dependency clears its degrade streak. */
function noteOk(what: string, chainId?: number): void {
  degradeStreaks.delete(`${chainId ?? 0}:${what}`);
}

/**
 * Map an upstream-dependency error to a stable, retryable SERVICE_DEGRADED JSON-RPC
 * error. Never leaks the raw provider message/stack — only a stable reason + optional
 * Retry-After hint, so the client can back off and retry without parsing prose.
 *
 * ALSO the single observability choke point for every degrade path: emits a log + a per-chain
 * counter (these degrades bypass the circuit breaker, so this is the ONLY operator-facing signal
 * that a chain/fee-token is failing to price), and escalates the log level once a (chain, what)
 * degrades repeatedly in a row so an external log/metric alert can page on a persistent outage.
 */
function degradedFromError(err: unknown, what: string, chainId?: number): ReturnType<typeof serviceDegraded> {
  const cls = getClassification(err);
  const key = `${chainId ?? 0}:${what}`;
  const streak = (degradeStreaks.get(key) ?? 0) + 1;
  degradeStreaks.set(key, streak);
  metrics.inc("rpc_degraded_total", 1, { chain: chainId ?? 0, what, reason: cls.reason });
  logEvent({
    level: streak >= DEGRADE_ESCALATE_AT ? "error" : "warn",
    dependency: "rpc", operation: what, outcome: "degraded", reason: cls.reason,
    chain_id: chainId, retryable: true, detail: streak >= DEGRADE_ESCALATE_AT ? `persistent: ${streak}x in a row` : undefined,
  });
  return serviceDegraded(
    `${what} temporarily unavailable — please retry`,
    { reason: cls.reason, retryAfterMs: cls.retryAfterMs },
  );
}

/** Signature of a single JSON-RPC method handler. A sync handler may return a plain value;
 *  handleRpcMethod awaits the result either way. */
type RpcMethodHandler = (
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
) => unknown | Promise<unknown>;

/**
 * The JSON-RPC dispatch table — the SINGLE source of truth for the bundler's public method surface.
 * Its keys (`EXPOSED_RPC_METHODS`) are the contract the wallet and docs/api-contract.md §1 depend
 * on: adding or removing an entry is a DELIBERATE change to the external surface (pinned by
 * tests/api_contract_test.ts, which asserts this set against the documented list).
 */
export const RPC_METHOD_HANDLERS: Record<string, RpcMethodHandler> = {
  eth_sendUserOperation: (params, config, registry, reqCtx) => handleSendUserOperation(params, config, registry, reqCtx),
  eth_estimateUserOperationGas: (params, config, registry, reqCtx) => handleEstimateUserOperationGas(params, config, registry, reqCtx),
  eth_getUserOperationByHash: (params, config, registry, reqCtx) => handleGetUserOperationByHash(params, config, registry, reqCtx),
  eth_getUserOperationReceipt: (params, config, registry, reqCtx) => handleGetUserOperationReceipt(params, config, registry, reqCtx),
  eth_supportedEntryPoints: (_params, config) => [config.entryPointAddress],
  eth_chainId: (_params, _config, _registry, reqCtx) => "0x" + reqCtx.chainId.toString(16),
  pimlico_getUserOperationGasPrice: (_params, config, registry, reqCtx) => handleGetUserOperationGasPrice(config, registry, reqCtx),
  vela_getInBandGasQuote: (params, config, registry, reqCtx) => handleGetInBandGasQuote(params, config, registry, reqCtx),
};

/** The exact set of JSON-RPC methods this bundler exposes (the dispatch-table keys). */
export const EXPOSED_RPC_METHODS: readonly string[] = Object.keys(RPC_METHOD_HANDLERS);

/**
 * Dispatch an RPC method to its handler. Unknown method → methodNotFound (-32601).
 */
export async function handleRpcMethod(
  method: string,
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<unknown> {
  const handler = RPC_METHOD_HANDLERS[method];
  if (!handler) throw methodNotFound(method);
  return await handler(params, config, chainRegistry, reqCtx);
}

async function resolveChain(
  chainId: number,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<ChainServices> {
  try {
    const chain = await chainRegistry.getChain(chainId, reqCtx.requestRpcUrl);
    noteOk("chain resolution", chainId);
    return chain;
  } catch (err) {
    // A TRANSIENT registry outage (blip / timeout / circuit-open) is RETRYABLE, not a permanent
    // business rejection. fetchChainInfo deliberately emits "temporarily unreachable … Retry
    // shortly" for that case (vs "is not supported" for a genuinely unknown chain). Collapsing
    // both into INVALID_USEROPERATION (a permanent -32602) makes the wallet DROP the op during
    // the exact window a retry would succeed. Degrade (retryable) unless it is provably a
    // not-supported chain.
    const msg = err instanceof Error ? err.message : String(err);
    const cls = getClassification(err);
    const isNotSupported = /not supported/i.test(msg);
    const isTransient = cls.category === "transient" || cls.retryable ||
      /temporarily unreachable|retry shortly/i.test(msg);
    if (isTransient && !isNotSupported) {
      console.warn(`[RPC] Chain resolution temporarily unavailable for chainId ${chainId} (${cls.reason})`);
      throw degradedFromError(err, "chain resolution", chainId);
    }
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
    // In-band chains allow maxFeePerGas = 0 (bundler repaid in-band); the raised verification-gas
    // ceiling is the Tempo ENVELOPE only. See docs/inband-gas-settlement.md.
    validateUserOpFields(
      userOp,
      inBandActiveForChain(config, reqCtx.chainId),
      isTempoChain(reqCtx.chainId),
    );
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

  // In-band chains settle gas by an in-band reimbursement (the bundler EOA is an OPERATOR float,
  // not a user deposit), so the native-balance / priority-fee-floor / gas-price-margin checks below
  // do not apply (maxFeePerGas = 0 is expected there, not a misconfiguration). See docs/.
  const tempo = isTempoChain(reqCtx.chainId);
  const inBand = inBandActiveForChain(config, reqCtx.chainId);

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
        throw degradedFromError(retryErr, "gas price", reqCtx.chainId);
      }
    } else {
      throw degradedFromError(err, "gas price", reqCtx.chainId);
    }
  }
  noteOk("gas price", reqCtx.chainId);
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

  // In-band: the EOA is an operator float (repaid in-band), not a user deposit — skip the
  // user-facing "deposit to {eoa}" balance gate entirely. A low float is handled at submit time
  // (defer + operator alert + top-up), never surfaced to the user as a bad UserOp.
  if (!inBand) {
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
        throw degradedFromError(retryErr, "balance check", reqCtx.chainId);
      }
    } else {
      // No fallback available (dev network or already using chain default)
      console.error(`[RPC] Balance query failed for ${safeAddress}:`, getClassification(err).reason);
      throw degradedFromError(err, "balance check", reqCtx.chainId);
    }
  }
  noteOk("balance check", reqCtx.chainId);
  if (!balanceCheck.sufficient) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `Insufficient ${tempo ? 'pathUSD' : 'native'} balance on dedicated bundler gas account. ` +
      `Spendable: ${balanceCheck.spendableBalance}, required: ${balanceCheck.requiredBalance}. ` +
      `Deposit to: ${eoa.address}`,
    );
  }
  } // end if (!inBand) balance gate

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

  if (!inBand && userOp.maxPriorityFeePerGas < config.minPriorityFeePerGas) {
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
  if (!inBand && derivedOuterPrice * 5n < outerGas.effectiveGasPrice) {
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

  // Admission gate — reject UP FRONT when this network's relayer treasury can't front the op's
  // native gas. On vault chains the bundler fronts gas from config.treasuryAddress; if it sits
  // below its operating floor, the op would otherwise be ADMITTED (a hash is returned → the wallet
  // shows "submitted") then stall in the mempool with no gas to bundle and eventually drop — a dead
  // receipt with no explanation. Rejecting here surfaces a stable, wallet-recognized error so the
  // client shows the "start this network's relayer" bootstrap flow instead. FAIL-OPEN on a read
  // error: a transient RPC blip must never block otherwise-healthy sends.
  if (!isTempoChain(reqCtx.chainId) && vaultActiveForChain(config.settlementVaultChains, reqCtx.chainId)) {
    let treasuryBalance: bigint | null = null;
    try {
      treasuryBalance = await getPublicClient(chain.rpcUrl || config.rpcUrl).getBalance({ address: config.treasuryAddress });
    } catch (err) {
      console.warn(`[Gate] treasury balance read failed for chain ${reqCtx.chainId} — allowing send (fail-open): ${String(err)}`);
    }
    if (treasuryBalance !== null && treasuryBalance < TREASURY_FLOOR) {
      throw bundlerError(
        RPC_ERROR_CODES.PAYMASTER_BALANCE_INSUFFICIENT,
        "gas relayer is unavailable — this network's relayer treasury needs a bootstrap deposit before it can package transactions",
      );
    }
  }

  // Accept the validated op. Default path: add to the in-DO mempool + kick a bundle pass NOW
  // (fire-and-forget) instead of waiting out the next 10s alarm/interval tick — for a 5-minute
  // trading window those seconds are money. When queue transport is active on this chain
  // (Stage 4, QUEUE_TRANSPORT_ENABLED) the same validated op is instead handed to a per-EOA
  // RelayerDO via the queue; acceptUserOp encapsulates that choice and falls back to the
  // mempool if the queue is unreachable, so a validated op is NEVER dropped. Flag off → this is
  // byte-identical to the pre-Stage-4 mempool.add + requestBundleKick.
  try {
    const hash = await chain.bundler.acceptUserOp(
      userOp,
      simResult.validationResult?.prefund ?? 0n,
      rpcOverride,
    );
    noteOk("op transport", reqCtx.chainId);
    return hash;
  } catch (err) {
    if (err instanceof UserOpValidationError) {
      throw bundlerError(err.code, err.message);
    }
    // Ambiguous enqueue → retryable degraded (the wallet re-sends; the RelayerDO dedups).
    if (err instanceof EnqueueAmbiguousError) {
      throw degradedFromError(err, "op transport", reqCtx.chainId);
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
        throw degradedFromError(retryErr, "gas estimation", reqCtx.chainId);
      }
    } else {
      throw degradedFromError(err, "gas estimation", reqCtx.chainId);
    }
  }
  noteOk("gas estimation", reqCtx.chainId);

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
 * vela_getInBandGasQuote — advisory sizing help for the in-band gas reimbursement the wallet batches
 * into its UserOp. The bundle GATE re-verifies at submit (so this only helps the wallet transfer
 * enough; it trusts the caller's `nativeCost` estimate). Params: [{ safeAddress, nativeCost (wei,
 * hex or decimal), feeToken? }]. Returns the recipient EOA + the amount to transfer — in native
 * (feeToken omitted) or a whitelisted stablecoin (priced by the chain's DEX, $0.01-floored).
 */
async function handleGetInBandGasQuote(
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistryLike,
  reqCtx: RequestContext,
): Promise<Record<string, unknown>> {
  if (!inBandActiveForChain(config, reqCtx.chainId)) {
    throw bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, "in-band gas settlement is not enabled on this chain");
  }
  const chain = await resolveChain(reqCtx.chainId, chainRegistry, reqCtx);
  const arg = (params?.[0] ?? {}) as { safeAddress?: string; nativeCost?: string; feeToken?: string | null };
  if (!arg.safeAddress || !/^0x[0-9a-fA-F]{40}$/.test(arg.safeAddress)) {
    throw bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, "safeAddress is required");
  }
  let nativeCost: bigint;
  try {
    nativeCost = BigInt(arg.nativeCost ?? "0");
  } catch {
    throw bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, "nativeCost must be a number (hex or decimal wei)");
  }
  if (nativeCost <= 0n) throw bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, "nativeCost must be > 0");

  const eoa = await chain.accountService.deriveEOA(getAddress(arg.safeAddress));
  // Vault mode (Stage 2, docs/pool-queue-architecture.md): the reimbursement recipient is
  // the treasury, not the per-safe EOA. Must move in lockstep with the bundle gate's
  // recipient — a quote pointing at the EOA while the gate credits the treasury (or vice
  // versa) silently strands every op at "reimbursement too low".
  const recipient = vaultActiveForChain(config.settlementVaultChains, reqCtx.chainId)
    ? config.treasuryAddress
    : eoa.address;

  // Read chain metadata from the RESOLVED chain services, falling back to config: in the
  // CF worker this handler receives the GLOBAL config (chainInfo null, rpcUrl "") — reading
  // config directly made every stablecoin quote 400 "unsupported" in production.
  const chainInfo = chain.chainInfo ?? config.chainInfo;

  if (!arg.feeToken) {
    // Native: markupX × cost, floored at 1e-5 of a native coin (the sibling of the $0.01 stable
    // floor) so a near-free-gas chain still charges a nonzero minimum. Must match the submit gate.
    const nativeDecimals = chainInfo?.nativeCurrency?.decimals ?? 18;
    const requiredNative = requiredNativeCharge(nativeCost, IN_BAND_MARKUP_X, nativeDecimals);
    return {
      recipient,
      asset: "native",
      feeToken: null,
      requiredAmount: "0x" + requiredNative.toString(16),
      markupX: Number(IN_BAND_MARKUP_X),
    };
  }

  // Stablecoin: must be whitelisted; priced by the chain's DEX; charge floored at $0.01.
  const stable = getAddress(arg.feeToken);
  const stables = (chainInfo?.stables ?? []).map((s) => {
    try {
      return getAddress(s.contract);
    } catch {
      return null;
    }
  });
  if (!stables.includes(stable)) {
    throw bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, `feeToken ${stable} is not a whitelisted stablecoin on this chain`);
  }
  const quoter = chainInfo?.dex?.contracts?.quoterV2;
  const wnative = chainInfo?.wrappedNativeToken;
  if (!quoter || !wnative) {
    throw bundlerError(RPC_ERROR_CODES.INVALID_USEROPERATION, "stablecoin gas is unsupported on this chain (no DEX quoter / wrappedNative)");
  }
  const client = getPublicClient(chain.rpcUrl || config.rpcUrl);
  const costStable = await quoteNativeToStable(client, { quoterV2: quoter, wrappedNative: wnative, stable }, nativeCost, reqCtx.chainId);
  if (costStable === null || costStable <= 0n) {
    throw degradedFromError(new Error("no DEX quote for stablecoin"), "stablecoin rate", reqCtx.chainId);
  }
  noteOk("stablecoin rate", reqCtx.chainId);
  const decimals = await stableDecimals(client, stable);
  const required = requiredStableCharge(costStable, decimals, IN_BAND_MARKUP_X);
  return {
    recipient,
    asset: "erc20",
    feeToken: stable,
    requiredAmount: "0x" + required.toString(16),
    decimals,
    markupX: Number(IN_BAND_MARKUP_X),
  };
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
    throw degradedFromError(err, "gas price", reqCtx.chainId);
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
    throw degradedFromError(new Error("all gas price signals are zero"), "gas price", reqCtx.chainId);
  }
  noteOk("gas price", reqCtx.chainId);

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
      return receiptToByHashRpc(receipt);
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
    return receiptToRpc(receipt);
  }

  return null;
}
