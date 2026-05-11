/**
 * RPC method handlers implementing ERC-7769 / ERC-4337 bundler spec
 * with private prepaid bundler binding rules.
 */

import type { RpcContext, RequestContext } from "./index.ts";
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
import { resolveRpcUrl } from "../utils/rpc-client.ts";

/**
 * Dispatch an RPC method to its handler.
 */
export async function handleRpcMethod(
  method: string,
  params: unknown[],
  ctx: RpcContext,
  reqCtx: RequestContext = {},
): Promise<unknown> {
  // Standard ERC-7769 methods
  switch (method) {
    case "eth_sendUserOperation":
      return await handleSendUserOperation(params, ctx, reqCtx);
    case "eth_estimateUserOperationGas":
      return await handleEstimateUserOperationGas(params, ctx, reqCtx);
    case "eth_getUserOperationByHash":
      return await handleGetUserOperationByHash(params, ctx);
    case "eth_getUserOperationReceipt":
      return await handleGetUserOperationReceipt(params, ctx);
    case "eth_supportedEntryPoints":
      return handleSupportedEntryPoints(ctx);
    case "eth_chainId":
      return handleChainId(ctx);
    default:
      break;
  }

  // Debug methods (testing mode only)
  if (method.startsWith("debug_bundler_")) {
    if (ctx.config.mode !== "testing") {
      throw methodNotFound(method);
    }
    return await handleDebugMethod(method, params, ctx);
  }

  throw methodNotFound(method);
}

// --- Standard ERC-7769 Methods ---

async function handleSendUserOperation(
  params: unknown[],
  ctx: RpcContext,
  reqCtx: RequestContext = {},
): Promise<`0x${string}`> {
  const rpcOverride = reqCtx.requestRpcUrl;
  if (!params[0] || !params[1]) {
    throw invalidParams("Expected [userOp, entryPoint]");
  }

  const entryPoint = params[1] as string;
  if (entryPoint.toLowerCase() !== ctx.config.entryPointAddress.toLowerCase()) {
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

  // Validate fields
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

  // Derive the dedicated bundler EOA for this safeAddress
  const eoa = await ctx.accountService.deriveEOA(safeAddress);

  // Check EOA nonce/lock state
  const eoaState = ctx.accountService.lockManager.getState(eoa.address);
  if (eoaState) {
    if (eoaState.status === "LOCKED_PENDING_UNKNOWN") {
      throw bundlerError(
        RPC_ERROR_CODES.INVALID_USEROPERATION,
        "EOA_HAS_UNKNOWN_PENDING_TX: dedicated bundler EOA has unknown pending transactions. Wait for resolution.",
      );
    }
    if (eoaState.status === "LOCKED_IN_MEMORY_PENDING") {
      throw bundlerError(
        RPC_ERROR_CODES.INVALID_USEROPERATION,
        "Dedicated bundler EOA is currently processing a bundle. Retry later.",
      );
    }
  } else {
    // First time seeing this EOA — initialize it
    const state = await ctx.accountService.lockManager.initEOA(
      eoa.address,
      ctx.accountService.getClient(),
    );
    if (state.status === "LOCKED_PENDING_UNKNOWN") {
      throw bundlerError(
        RPC_ERROR_CODES.INVALID_USEROPERATION,
        "EOA_HAS_UNKNOWN_PENDING_TX: dedicated bundler EOA has unknown pending transactions.",
      );
    }
  }

  // Check balance
  const baseFee = await ctx.simulator.getCurrentBaseFee(rpcOverride);
  const outerGas = calcOuterTxGasPrice({
    currentBaseFee: baseFee,
    baseFeeMultiplier: ctx.config.baseFeeMultiplier,
    bundlerTipGwei: ctx.config.bundlerTipGwei,
  });
  const maxGas = calcUserOpMaxGas(userOp);
  const estimatedCost = maxGas * outerGas.effectiveGasPrice;

  const balanceCheck = await ctx.accountService.checkBalance(safeAddress, estimatedCost);
  if (!balanceCheck.sufficient) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `Insufficient balance on dedicated bundler EOA. ` +
      `Spendable: ${balanceCheck.spendableBalance}, required: ${balanceCheck.requiredBalance}. ` +
      `Deposit to: ${eoa.address}`,
    );
  }

  // --- Standard ERC-4337 checks ---

  // Check preVerificationGas is not too low
  const minPvg = calcPreVerificationGas(userOp, {
    expectedBundleSize: ctx.config.maxBundleSize,
  });
  if (userOp.preVerificationGas < minPvg) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `preVerificationGas too low: ${userOp.preVerificationGas} < required ${minPvg}`,
    );
  }

  // Check minimum priority fee
  if (userOp.maxPriorityFeePerGas < ctx.config.minPriorityFeePerGas) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      `maxPriorityFeePerGas too low: ${userOp.maxPriorityFeePerGas} < minimum ${ctx.config.minPriorityFeePerGas}`,
    );
  }

  // Check profitability at per-op level
  const userOpGasPrice = calcUserOpGasPrice(userOp, baseFee);

  if (!checkUserOpProfitability({
    userOpGasPrice,
    outerTxEffectiveGasPrice: outerGas.effectiveGasPrice,
    marginBps: ctx.config.minProfitMarginBps,
  })) {
    throw bundlerError(
      RPC_ERROR_CODES.INVALID_USEROPERATION,
      "UserOperation gas price too low for profitability requirements",
    );
  }

  // Simulate validation
  const simResult = await ctx.simulator.simulateValidation(userOp, rpcOverride);
  if (!simResult.valid) {
    throw bundlerError(
      simResult.errorCode ?? RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
      simResult.errorMessage ?? "Simulation failed",
    );
  }

  // Add to mempool
  try {
    const userOpHash = ctx.mempool.add(
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
  ctx: RpcContext,
  reqCtx: RequestContext = {},
): Promise<Record<string, string>> {
  if (!params[0] || !params[1]) {
    throw invalidParams("Expected [userOp, entryPoint]");
  }

  const entryPoint = params[1] as string;
  if (entryPoint.toLowerCase() !== ctx.config.entryPointAddress.toLowerCase()) {
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

  const gasEstimate = await ctx.simulator.estimateUserOpGas(userOp, reqCtx.requestRpcUrl);

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

async function handleGetUserOperationByHash(
  params: unknown[],
  ctx: RpcContext,
): Promise<Record<string, unknown> | null> {
  const hash = params[0] as string;
  if (!hash || typeof hash !== "string" || !hash.startsWith("0x")) {
    throw invalidParams("Expected userOpHash as hex string");
  }

  // Check mempool first
  const memEntry = ctx.mempool.get(hash);
  if (memEntry) {
    return {
      userOperation: userOpToRpc(memEntry.userOp),
      entryPoint: ctx.config.entryPointAddress,
      blockNumber: null,
      blockHash: null,
      transactionHash: null,
    };
  }

  // Check receipt store
  const receipt = ctx.bundler.getReceipt(hash);
  if (receipt) {
    return {
      userOperation: {
        sender: receipt.sender,
        nonce: "0x" + receipt.nonce.toString(16),
      },
      entryPoint: receipt.entryPoint,
      blockNumber: "0x" + receipt.receipt.blockNumber.toString(16),
      blockHash: receipt.receipt.blockHash,
      transactionHash: receipt.receipt.transactionHash,
    };
  }

  return null;
}

async function handleGetUserOperationReceipt(
  params: unknown[],
  ctx: RpcContext,
): Promise<Record<string, unknown> | null> {
  const hash = params[0] as string;
  if (!hash || typeof hash !== "string" || !hash.startsWith("0x")) {
    throw invalidParams("Expected userOpHash as hex string");
  }

  const receipt = ctx.bundler.getReceipt(hash);
  if (!receipt) return null;

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

function handleSupportedEntryPoints(ctx: RpcContext): string[] {
  return [ctx.config.entryPointAddress];
}

function handleChainId(ctx: RpcContext): string {
  return "0x" + ctx.config.chainId.toString(16);
}

// --- Debug Methods (testing mode only) ---

async function handleDebugMethod(
  method: string,
  params: unknown[],
  ctx: RpcContext,
): Promise<unknown> {
  switch (method) {
    case "debug_bundler_clearState":
      ctx.mempool.clear();
      return "ok";

    case "debug_bundler_dumpMempool": {
      const entryPoint = params[0] as string;
      if (
        entryPoint &&
        entryPoint.toLowerCase() !== ctx.config.entryPointAddress.toLowerCase()
      ) {
        throw invalidParams(`Unsupported EntryPoint: ${entryPoint}`);
      }
      return ctx.mempool.dump().map((e) => userOpToRpc(e.userOp));
    }

    case "debug_bundler_sendBundleNow": {
      const result = await ctx.bundler.tryBundle();
      return result.transactionHash ?? result.error ?? "no bundle";
    }

    case "debug_bundler_setBundlingMode": {
      const mode = params[0] as string;
      if (mode !== "auto" && mode !== "manual") {
        throw invalidParams("Expected 'auto' or 'manual'");
      }
      ctx.bundler.setBundlingMode(mode);
      return "ok";
    }

    case "debug_bundler_setReputation": {
      const entries = params[0] as Array<{
        address: string;
        opsSeen: number | string;
        opsIncluded: number | string;
        status?: string;
      }>;
      const entryPoint = params[1] as string;
      if (
        entryPoint &&
        entryPoint.toLowerCase() !== ctx.config.entryPointAddress.toLowerCase()
      ) {
        throw invalidParams(`Unsupported EntryPoint: ${entryPoint}`);
      }
      if (!Array.isArray(entries)) {
        throw invalidParams("Expected array of reputation entries");
      }
      for (const e of entries) {
        ctx.mempool.reputation.setReputation(
          e.address.toLowerCase() as `0x${string}`,
          "sender",
          Number(e.opsSeen),
          Number(e.opsIncluded),
          e.status as "ok" | "throttled" | "banned" | undefined,
        );
      }
      return "ok";
    }

    case "debug_bundler_dumpReputation": {
      const entryPoint = params[0] as string;
      if (
        entryPoint &&
        entryPoint.toLowerCase() !== ctx.config.entryPointAddress.toLowerCase()
      ) {
        throw invalidParams(`Unsupported EntryPoint: ${entryPoint}`);
      }
      return ctx.mempool.reputation.dump().map((e) => ({
        address: e.address,
        opsSeen: e.opsSeen,
        opsIncluded: e.opsIncluded,
        status: e.status,
      }));
    }

    case "debug_bundler_addUserOps": {
      const userOps = params[0] as unknown[];
      const entryPoint = params[1] as string;
      if (
        entryPoint &&
        entryPoint.toLowerCase() !== ctx.config.entryPointAddress.toLowerCase()
      ) {
        throw invalidParams(`Unsupported EntryPoint: ${entryPoint}`);
      }
      if (!Array.isArray(userOps)) {
        throw invalidParams("Expected array of UserOperations");
      }
      for (const raw of userOps) {
        const userOp = normalizeUserOp(raw);
        ctx.mempool.add(userOp);
      }
      return "ok";
    }

    default:
      throw methodNotFound(method);
  }
}
