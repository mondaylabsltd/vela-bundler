/**
 * RPC method handlers implementing ERC-7769 / ERC-4337 bundler spec.
 * Multi-chain: chainId resolved from request (X-Chain-Id header or RPC params).
 */

import type { RequestContext } from "./index.ts";
import type { BundlerConfig } from "../config/index.ts";
import type { ChainRegistry, ChainServices } from "../chain/index.ts";
import {
  methodNotFound,
  invalidParams,
  bundlerError,
} from "./errors.ts";
import { RPC_ERROR_CODES } from "../contracts/entrypoint.ts";
import { normalizeUserOp, userOpToRpc } from "../userop/normalize.ts";
import { validateUserOpFields, UserOpValidationError } from "../userop/validate.ts";
import { calcPreVerificationGas } from "../gas/preVerificationGas.ts";
import {
  calcUserOpGasPrice,
  checkUserOpProfitability,
  calcUserOpMaxGas,
  calcOuterTxGasPrice,
} from "../gas/profitability.ts";

/**
 * Dispatch an RPC method to its handler.
 */
export async function handleRpcMethod(
  method: string,
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistry,
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
    default:
      throw methodNotFound(method);
  }
}

async function resolveChain(
  chainId: number,
  chainRegistry: ChainRegistry,
  reqCtx: RequestContext,
): Promise<ChainServices> {
  try {
    return await chainRegistry.getChain(chainId, reqCtx.requestRpcUrl);
  } catch (err) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `Unsupported chain ${chainId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// --- Standard ERC-7769 Methods ---

async function handleSendUserOperation(
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistry,
  reqCtx: RequestContext,
): Promise<`0x${string}`> {
  if (!params[0] || !params[1]) {
    throw invalidParams("Expected [userOp, entryPoint]");
  }

  const chain = await resolveChain(reqCtx.chainId, chainRegistry, reqCtx);
  const rpcOverride = reqCtx.requestRpcUrl;

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
    validateUserOpFields(userOp);
  } catch (err) {
    if (err instanceof UserOpValidationError) {
      throw bundlerError(err.code, err.message);
    }
    throw err;
  }

  // --- Private bundler binding checks ---
  const safeAddress = userOp.sender;
  const eoa = await chain.accountService.deriveEOA(safeAddress);

  // Check EOA nonce/lock state
  const eoaState = chain.accountService.lockManager.getState(eoa.address);
  if (eoaState) {
    if (eoaState.status === "LOCKED_PENDING_UNKNOWN") {
      throw bundlerError(
        RPC_ERROR_CODES.INVALID_USEROPERATION,
        "EOA_HAS_UNKNOWN_PENDING_TX: dedicated bundler EOA has unknown pending transactions.",
      );
    }
    if (eoaState.status === "LOCKED_IN_MEMORY_PENDING") {
      throw bundlerError(
        RPC_ERROR_CODES.INVALID_USEROPERATION,
        "Dedicated bundler EOA is currently processing a bundle. Retry later.",
      );
    }
  } else {
    const state = await chain.accountService.lockManager.initEOA(
      eoa.address,
      chain.accountService.getClient(),
    );
    if (state.status === "LOCKED_PENDING_UNKNOWN") {
      throw bundlerError(
        RPC_ERROR_CODES.INVALID_USEROPERATION,
        "EOA_HAS_UNKNOWN_PENDING_TX: dedicated bundler EOA has unknown pending transactions.",
      );
    }
  }

  // Check balance
  const baseFee = await chain.simulator.getCurrentBaseFee(rpcOverride);
  const outerGas = calcOuterTxGasPrice({
    currentBaseFee: baseFee,
    baseFeeMultiplier: config.baseFeeMultiplier,
    bundlerTipGwei: config.bundlerTipGwei,
  });
  const maxGas = calcUserOpMaxGas(userOp);
  const estimatedCost = maxGas * outerGas.effectiveGasPrice;

  const balanceCheck = await chain.accountService.checkBalance(safeAddress, estimatedCost);
  if (!balanceCheck.sufficient) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `Insufficient balance on dedicated bundler EOA. ` +
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

  if (userOp.maxPriorityFeePerGas < config.minPriorityFeePerGas) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `maxPriorityFeePerGas too low: ${userOp.maxPriorityFeePerGas} < minimum ${config.minPriorityFeePerGas}`,
    );
  }

  const userOpGasPrice = calcUserOpGasPrice(userOp, baseFee);
  if (!checkUserOpProfitability({
    userOpGasPrice,
    outerTxEffectiveGasPrice: outerGas.effectiveGasPrice,
    marginBps: config.minProfitMarginBps,
  })) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      "UserOperation gas price too low for profitability requirements",
    );
  }

  // Simulate validation
  const simResult = await chain.simulator.simulateValidation(userOp, rpcOverride);
  if (!simResult.valid) {
    throw bundlerError(
      simResult.errorCode ?? RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
      simResult.errorMessage ?? "Simulation failed",
    );
  }

  // Add to mempool
  try {
    const userOpHash = chain.mempool.add(
      userOp,
      simResult.validationResult?.prefund ?? 0n,
      rpcOverride,
    );
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
  chainRegistry: ChainRegistry,
  reqCtx: RequestContext,
): Promise<Record<string, string>> {
  if (!params[0] || !params[1]) {
    throw invalidParams("Expected [userOp, entryPoint]");
  }

  const chain = await resolveChain(reqCtx.chainId, chainRegistry, reqCtx);

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

  const gasEstimate = await chain.simulator.estimateUserOpGas(userOp, reqCtx.requestRpcUrl);

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

function handleGetUserOperationByHash(
  params: unknown[],
  config: BundlerConfig,
  chainRegistry: ChainRegistry,
  _reqCtx: RequestContext,
): Record<string, unknown> | null {
  const hash = params[0] as string;
  if (!hash || typeof hash !== "string" || !hash.startsWith("0x")) {
    throw invalidParams("Expected userOpHash as hex string");
  }

  // Search all initialized chains
  for (const chain of chainRegistry.getAll()) {
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
  chainRegistry: ChainRegistry,
  _reqCtx: RequestContext,
): Record<string, unknown> | null {
  const hash = params[0] as string;
  if (!hash || typeof hash !== "string" || !hash.startsWith("0x")) {
    throw invalidParams("Expected userOpHash as hex string");
  }

  for (const chain of chainRegistry.getAll()) {
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
