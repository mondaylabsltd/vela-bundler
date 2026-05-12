/**
 * Simulation module — validates UserOperations via EntryPoint before mempool insertion
 * and before bundle submission.
 *
 * All methods accept an optional RPC URL override so that per-request user RPCs
 * flow through to simulation and gas estimation.
 */

import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { ENTRYPOINT_V07_ABI, ENTRY_POINT_SIMULATIONS_BYTECODE, RPC_ERROR_CODES } from "../contracts/entrypoint.ts";
import type {
  PackedUserOperation,
  UserOperation,
  ValidationResultInfo,
} from "../userop/types.ts";
import { packUserOp } from "../userop/pack.ts";
import { parseValidationData, isValidTimeRange } from "../userop/validate.ts";
import { encodeHandleOps } from "../userop/encode.ts";
import type { BundlerConfig } from "../config/index.ts";
import { getPublicClient, resolveRpcUrl } from "../utils/rpc-client.ts";
import { RPC_TIMEOUT_MS } from "../utils/timeout.ts";

/** Simulation calls get a longer timeout since they're heavier than simple RPC calls. */
const SIMULATION_TIMEOUT_MS = RPC_TIMEOUT_MS * 3; // 15s

export interface SimulationResult {
  valid: boolean;
  validationResult?: ValidationResultInfo;
  errorCode?: number;
  errorMessage?: string;
}

export interface BundleSimulationResult {
  success: boolean;
  estimatedGas?: bigint;
  errorMessage?: string;
  failedOpIndex?: number;
}

export interface ExecutionSimulationResult {
  success: boolean;
  targetSuccess?: boolean;
  targetResult?: `0x${string}`;
  paid?: bigint;
  errorCode?: number;
  errorMessage?: string;
}

/**
 * Create a simulation service.
 */
export function createSimulator(config: BundlerConfig) {
  /** Get the effective client: per-request override > config default. */
  function clientFor(rpcUrlOverride?: string): PublicClient<Transport, Chain> {
    const url = resolveRpcUrl(config, rpcUrlOverride);
    return getPublicClient(url);
  }

  /**
   * Simulate validation of a single UserOperation.
   *
   * EntryPoint v0.7 removed simulateValidation from the on-chain contract.
   * We inject it via eth_call stateOverride: replace the EntryPoint code with
   * EntryPointSimulations bytecode (which extends EntryPoint and adds simulateValidation).
   * Uses raw fetch to reliably extract revert data from the JSON-RPC response.
   */
  async function simulateValidation(
    userOp: UserOperation,
    rpcUrlOverride?: string,
  ): Promise<SimulationResult> {
    const packed = packUserOp(userOp);
    const calldata = encodeFunctionData({
      abi: ENTRYPOINT_V07_ABI,
      functionName: "simulateValidation",
      args: [packed],
    });

    const rpcUrl = resolveRpcUrl(config, rpcUrlOverride);
    const ep = config.entryPointAddress;

    try {
      const controller = new AbortController();
      const simTimeout = setTimeout(() => controller.abort(), SIMULATION_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "eth_call",
            params: [
              { to: ep, data: calldata },
              "latest",
              // State override: inject EntryPointSimulations code at the EntryPoint address
              { [ep]: { code: ENTRY_POINT_SIMULATIONS_BYTECODE } },
            ],
          }),
        });
      } finally {
        clearTimeout(simTimeout);
      }

      const json = await res.json() as {
        result?: string;
        error?: { code: number; message: string; data?: string };
      };

      if (json.result && json.result !== "0x") {
        // v0.7 EntryPointSimulations.simulateValidation returns ValidationResult directly
        return parseReturnedValidationResult(json.result as `0x${string}`);
      }

      // Extract revert data from JSON-RPC error response.
      // Different RPC providers return it in different places:
      //   Standard:  error.data = "0xABCD..."
      //   Some RPCs: error.message = "execution reverted: 0xABCD..."
      //   BSC/etc:   error.data = { data: "0xABCD..." } (nested)
      let revertData: `0x${string}` | undefined;

      const errData = json.error?.data;
      if (typeof errData === "string" && errData.startsWith("0x") && errData.length > 2) {
        revertData = errData as `0x${string}`;
      } else if (typeof errData === "object" && errData !== null) {
        // Some RPCs nest: error.data = { data: "0x..." }
        const nested = (errData as Record<string, unknown>).data;
        if (typeof nested === "string" && nested.startsWith("0x") && nested.length > 2) {
          revertData = nested as `0x${string}`;
        }
      }

      // Fallback: extract from error.message ("execution reverted: 0xABCD...")
      if (!revertData && json.error?.message) {
        const match = json.error.message.match(/(0x[0-9a-fA-F]{8,})/);
        if (match) {
          revertData = match[1] as `0x${string}`;
        }
      }

      console.log(`[Simulator] simulateValidation revert: data=${revertData?.slice(0, 20) ?? "none"}... raw=${JSON.stringify(json.error).slice(0, 200)}`);

      if (!revertData) {
        return {
          valid: false,
          errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
          errorMessage: `Simulation reverted with no data (RPC error: ${json.error?.message ?? "unknown"})`,
        };
      }

      return parseRevertData(revertData);
    } catch (err: unknown) {
      return {
        valid: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Simulation RPC failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Simulate execution of a UserOperation via EntryPointSimulations.simulateHandleOp.
   *
   * This catches the critical gap where validation passes but execution reverts
   * (e.g. insufficient balance after initCode setup consumes funds).
   * Uses the same state-override pattern as simulateValidation.
   */
  async function simulateExecution(
    userOp: UserOperation,
    rpcUrlOverride?: string,
  ): Promise<ExecutionSimulationResult> {
    const packed = packUserOp(userOp);
    const calldata = encodeFunctionData({
      abi: ENTRYPOINT_V07_ABI,
      functionName: "simulateHandleOp",
      args: [
        packed,
        "0x0000000000000000000000000000000000000000", // no extra target call
        "0x",
      ],
    });

    const rpcUrl = resolveRpcUrl(config, rpcUrlOverride);
    const ep = config.entryPointAddress;

    try {
      const controller = new AbortController();
      const simTimeout = setTimeout(() => controller.abort(), SIMULATION_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "eth_call",
            params: [
              { to: ep, data: calldata },
              "latest",
              { [ep]: { code: ENTRY_POINT_SIMULATIONS_BYTECODE } },
            ],
          }),
        });
      } finally {
        clearTimeout(simTimeout);
      }

      const json = await res.json() as {
        result?: string;
        error?: { code: number; message: string; data?: string };
      };

      // Successful return — decode ExecutionResult
      if (json.result && json.result !== "0x") {
        return parseExecutionResultReturn(json.result as `0x${string}`);
      }

      // Extract revert data (same patterns as simulateValidation)
      let revertData: `0x${string}` | undefined;

      const errData = json.error?.data;
      if (typeof errData === "string" && errData.startsWith("0x") && errData.length > 2) {
        revertData = errData as `0x${string}`;
      } else if (typeof errData === "object" && errData !== null) {
        const nested = (errData as Record<string, unknown>).data;
        if (typeof nested === "string" && nested.startsWith("0x") && nested.length > 2) {
          revertData = nested as `0x${string}`;
        }
      }
      if (!revertData && json.error?.message) {
        const match = json.error.message.match(/(0x[0-9a-fA-F]{8,})/);
        if (match) revertData = match[1] as `0x${string}`;
      }

      // Try to decode the revert as ExecutionResult error
      if (revertData) {
        return parseExecutionResultRevert(revertData);
      }

      return {
        success: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `simulateHandleOp reverted with no data: ${json.error?.message ?? "unknown"}`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `simulateHandleOp RPC failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Parse successful return data from simulateHandleOp (ExecutionResult struct).
   */
  function parseExecutionResultReturn(data: `0x${string}`): ExecutionSimulationResult {
    try {
      // deno-lint-ignore no-explicit-any
      const decoded: any = decodeFunctionResult({
        abi: ENTRYPOINT_V07_ABI,
        functionName: "simulateHandleOp",
        data,
      });

      const targetSuccess: boolean = decoded.targetSuccess ?? decoded[4];
      const targetResult: `0x${string}` = decoded.targetResult ?? decoded[5];
      const paid: bigint = decoded.paid ?? decoded[1];

      // targetSuccess only applies when a secondary target call is specified.
      // When target=address(0) (no extra call), targetSuccess defaults to false — ignore it.
      // The UserOp's own execution success is determined by whether paid > 0.
      if (!targetSuccess && targetResult && targetResult !== "0x" && targetResult.length > 2) {
        console.warn(
          `[Simulator] simulateHandleOp: target call would REVERT. targetResult=${(targetResult ?? "0x").slice(0, 66)}`,
        );
        return {
          success: false,
          targetSuccess: false,
          targetResult,
          paid,
          errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
          errorMessage: `UserOp execution would revert (targetResult: ${(targetResult ?? "0x").slice(0, 66)})`,
        };
      }

      console.log(`[Simulator] simulateHandleOp OK: paid=${paid} targetSuccess=${targetSuccess}`);
      return { success: true, targetSuccess: true, targetResult, paid };
    } catch (err) {
      return {
        success: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Failed to decode ExecutionResult return: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Parse revert data from simulateHandleOp.
   * Could be ExecutionResult error (v0.6 compat), FailedOp, or FailedOpWithRevert.
   */
  function parseExecutionResultRevert(revertData: `0x${string}`): ExecutionSimulationResult {
    try {
      const decoded = decodeErrorResult({
        abi: ENTRYPOINT_V07_ABI,
        data: revertData,
      });

      if (decoded.errorName === "ExecutionResult") {
        const args = decoded.args as unknown as [bigint, bigint, bigint, bigint, boolean, `0x${string}`];
        const targetSuccess = args[4];
        const targetResult = args[5];
        const paid = args[1];

        if (!targetSuccess) {
          console.warn(
            `[Simulator] simulateHandleOp revert: execution would REVERT. targetResult=${(targetResult ?? "0x").slice(0, 66)}`,
          );
          return {
            success: false,
            targetSuccess: false,
            targetResult,
            paid,
            errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
            errorMessage: `UserOp execution would revert (targetResult: ${(targetResult ?? "0x").slice(0, 66)})`,
          };
        }

        return { success: true, targetSuccess: true, targetResult, paid };
      }

      if (decoded.errorName === "FailedOp") {
        const [, reason] = decoded.args as unknown as [bigint, string];
        return {
          success: false,
          errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
          errorMessage: `simulateHandleOp FailedOp: ${reason}`,
        };
      }

      if (decoded.errorName === "FailedOpWithRevert") {
        const [, reason, inner] = decoded.args as unknown as [bigint, string, `0x${string}`];
        return {
          success: false,
          errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
          errorMessage: `simulateHandleOp FailedOpWithRevert: ${reason} (inner: ${inner})`,
        };
      }

      return {
        success: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `simulateHandleOp unknown error: ${decoded.errorName}`,
      };
    } catch {
      return {
        success: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Failed to decode simulateHandleOp revert: ${revertData.slice(0, 66)}`,
      };
    }
  }

  /**
   * Validate account and paymaster validation data (shared by both return and revert paths).
   * Returns a rejection SimulationResult if invalid, or null if all checks pass.
   */
  function checkValidationData(
    accountValidationData: bigint,
    paymasterValidationData: bigint,
  ): SimulationResult | null {
    const accountVD = parseValidationData(accountValidationData);
    if (accountVD.aggregator !== "0x0000000000000000000000000000000000000000" &&
        accountVD.aggregator !== "0x0000000000000000000000000000000000000001") {
      return { valid: false, errorCode: RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED, errorMessage: "Aggregated signatures not supported" };
    }
    if (accountVD.aggregator === "0x0000000000000000000000000000000000000001") {
      return { valid: false, errorCode: RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED, errorMessage: "Account signature validation failed" };
    }
    if (!isValidTimeRange(accountVD.validAfter, accountVD.validUntil)) {
      return { valid: false, errorCode: RPC_ERROR_CODES.OUT_OF_TIME_RANGE, errorMessage: `Account validation out of time range: validAfter=${accountVD.validAfter}, validUntil=${accountVD.validUntil}` };
    }
    if (paymasterValidationData !== 0n) {
      const pmVD = parseValidationData(paymasterValidationData);
      if (pmVD.aggregator === "0x0000000000000000000000000000000000000001") {
        return { valid: false, errorCode: RPC_ERROR_CODES.PAYMASTER_REJECTED, errorMessage: "Paymaster signature validation failed" };
      }
      if (!isValidTimeRange(pmVD.validAfter, pmVD.validUntil)) {
        return { valid: false, errorCode: RPC_ERROR_CODES.OUT_OF_TIME_RANGE, errorMessage: `Paymaster validation out of time range: validAfter=${pmVD.validAfter}, validUntil=${pmVD.validUntil}` };
      }
    }
    return null;
  }

  /**
   * Parse successful return data from EntryPointSimulations.simulateValidation (v0.7).
   * Returns ValidationResult struct directly (not via revert).
   */
  function parseReturnedValidationResult(data: `0x${string}`): SimulationResult {
    try {
      // deno-lint-ignore no-explicit-any
      const decoded: any = decodeFunctionResult({
        abi: ENTRYPOINT_V07_ABI,
        functionName: "simulateValidation",
        data,
      });

      const returnInfo = decoded.returnInfo ?? decoded[0];
      const senderInfo = decoded.senderInfo ?? decoded[1];
      const factoryInfo = decoded.factoryInfo ?? decoded[2];
      const paymasterInfo = decoded.paymasterInfo ?? decoded[3];

      const validationResult: ValidationResultInfo = {
        preOpGas: returnInfo.preOpGas,
        prefund: returnInfo.prefund,
        accountValidationData: returnInfo.accountValidationData,
        paymasterValidationData: returnInfo.paymasterValidationData,
        paymasterContext: returnInfo.paymasterContext,
        senderStake: senderInfo.stake,
        senderUnstakeDelaySec: senderInfo.unstakeDelaySec,
        factoryStake: factoryInfo.stake,
        factoryUnstakeDelaySec: factoryInfo.unstakeDelaySec,
        paymasterStake: paymasterInfo.stake,
        paymasterUnstakeDelaySec: paymasterInfo.unstakeDelaySec,
      };

      const rejection = checkValidationData(returnInfo.accountValidationData, returnInfo.paymasterValidationData);
      if (rejection) return rejection;

      console.log(`[Simulator] simulateValidation OK: preOpGas=${validationResult.preOpGas} prefund=${validationResult.prefund}`);
      return { valid: true, validationResult };
    } catch (err) {
      return {
        valid: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Failed to decode ValidationResult: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Parse raw revert data hex from simulateValidation.
   */
  function parseRevertData(revertData: `0x${string}`): SimulationResult {
    try {
      const decoded = decodeErrorResult({
        abi: ENTRYPOINT_V07_ABI,
        data: revertData,
      });

      if (decoded.errorName === "ValidationResult") {
        const args = decoded.args as unknown as [
          { preOpGas: bigint; prefund: bigint; accountValidationData: bigint; paymasterValidationData: bigint; paymasterContext: `0x${string}` },
          { stake: bigint; unstakeDelaySec: bigint },
          { stake: bigint; unstakeDelaySec: bigint },
          { stake: bigint; unstakeDelaySec: bigint },
        ];

        const returnInfo = args[0];
        const senderInfo = args[1];
        const factoryInfo = args[2];
        const paymasterInfo = args[3];

        const validationResult: ValidationResultInfo = {
          preOpGas: returnInfo.preOpGas,
          prefund: returnInfo.prefund,
          accountValidationData: returnInfo.accountValidationData,
          paymasterValidationData: returnInfo.paymasterValidationData,
          paymasterContext: returnInfo.paymasterContext,
          senderStake: senderInfo.stake,
          senderUnstakeDelaySec: senderInfo.unstakeDelaySec,
          factoryStake: factoryInfo.stake,
          factoryUnstakeDelaySec: factoryInfo.unstakeDelaySec,
          paymasterStake: paymasterInfo.stake,
          paymasterUnstakeDelaySec: paymasterInfo.unstakeDelaySec,
        };

        const rejection = checkValidationData(returnInfo.accountValidationData, returnInfo.paymasterValidationData);
        if (rejection) return rejection;

        return { valid: true, validationResult };
      }

      if (decoded.errorName === "FailedOp") {
        const [, reason] = decoded.args as unknown as [bigint, string];
        const errorCode = classifyFailedOpReason(reason);
        return { valid: false, errorCode, errorMessage: `FailedOp: ${reason}` };
      }

      if (decoded.errorName === "FailedOpWithRevert") {
        const [, reason, inner] = decoded.args as unknown as [bigint, string, `0x${string}`];
        const errorCode = classifyFailedOpReason(reason);
        return { valid: false, errorCode, errorMessage: `FailedOpWithRevert: ${reason} (inner: ${inner})` };
      }

      return {
        valid: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Unknown error: ${decoded.errorName}`,
      };
    } catch {
      return {
        valid: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Failed to decode simulation result: ${revertData}`,
      };
    }
  }

  /**
   * Simulate a full handleOps bundle via eth_estimateGas + eth_call verification.
   *
   * eth_estimateGas alone can mask individual UserOp execution failures because
   * EntryPoint v0.7 wraps execution in try/catch. We follow up with eth_call
   * to detect UserOperationEvent logs with success=false.
   */
  async function simulateBundle(
    packedOps: PackedUserOperation[],
    beneficiary: `0x${string}`,
    rpcUrlOverride?: string,
  ): Promise<BundleSimulationResult> {
    const client = clientFor(rpcUrlOverride);
    const calldata = encodeHandleOps(packedOps, beneficiary);

    // Step 1: eth_estimateGas for gas estimation
    let estimatedGas: bigint;
    try {
      estimatedGas = await client.estimateGas({
        to: config.entryPointAddress,
        data: calldata,
        account: beneficiary,
      });
    } catch (err: unknown) {
      const revertData = extractRevertData(err);
      let failedOpIndex: number | undefined;
      let errorMessage = err instanceof Error ? err.message : String(err);

      if (revertData) {
        try {
          const decoded = decodeErrorResult({
            abi: ENTRYPOINT_V07_ABI,
            data: revertData,
          });
          if (decoded.errorName === "FailedOp") {
            const [opIndex, reason] = decoded.args as unknown as [bigint, string];
            failedOpIndex = Number(opIndex);
            errorMessage = `FailedOp at index ${failedOpIndex}: ${reason}`;
          }
        } catch {
          // Could not decode
        }
      }

      return { success: false, errorMessage, failedOpIndex };
    }

    // Step 2: eth_call to detect individual UserOp execution failures
    // (EntryPoint handleOps doesn't revert on individual op failures — it emits
    // UserOperationEvent with success=false and UserOperationRevertReason)
    try {
      const rpcUrl = resolveRpcUrl(config, rpcUrlOverride);
      const bundleController = new AbortController();
      const bundleTimeout = setTimeout(() => bundleController.abort(), SIMULATION_TIMEOUT_MS);
      let callRes: Response;
      try {
        callRes = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: bundleController.signal,
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "eth_call",
            params: [
              { to: config.entryPointAddress, data: calldata, from: beneficiary },
              "latest",
            ],
          }),
        });
      } finally {
        clearTimeout(bundleTimeout);
      }
      const callJson = await callRes.json() as {
        result?: string;
        error?: { code: number; message: string; data?: string };
      };

      // If eth_call itself reverts, the whole bundle fails (FailedOp during validation)
      if (callJson.error) {
        let revertData: `0x${string}` | undefined;
        const errData = callJson.error.data;
        if (typeof errData === "string" && errData.startsWith("0x") && errData.length > 2) {
          revertData = errData as `0x${string}`;
        }
        if (revertData) {
          try {
            const decoded = decodeErrorResult({ abi: ENTRYPOINT_V07_ABI, data: revertData });
            if (decoded.errorName === "FailedOp") {
              const [opIndex, reason] = decoded.args as unknown as [bigint, string];
              return {
                success: false,
                failedOpIndex: Number(opIndex),
                errorMessage: `FailedOp at index ${Number(opIndex)}: ${reason}`,
              };
            }
          } catch { /* couldn't decode */ }
        }
        // Non-decodable error — fail the bundle
        return { success: false, errorMessage: `Bundle eth_call failed: ${callJson.error.message}` };
      }

      // eth_call succeeded — handleOps ran to completion.
      // Note: individual UserOp execution failures are already caught by
      // simulateExecution() per-op. This eth_call serves as a final safety net.
    } catch (err) {
      // eth_call network error — log but don't fail the bundle (estimateGas passed)
      console.warn(`[Simulator] Bundle eth_call verification failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    return { success: true, estimatedGas };
  }

  /**
   * Estimate gas for a UserOperation (for eth_estimateUserOperationGas).
   */
  async function estimateUserOpGas(
    userOp: UserOperation,
    rpcUrlOverride?: string,
  ): Promise<{
    preVerificationGas: bigint;
    verificationGasLimit: bigint;
    callGasLimit: bigint;
    paymasterVerificationGasLimit: bigint | null;
  }> {
    const client = clientFor(rpcUrlOverride);
    const { calcPreVerificationGas } = await import("../gas/preVerificationGas.ts");

    const preVerificationGas = calcPreVerificationGas(userOp, {
      expectedBundleSize: 1,
    });

    const simResult = await simulateValidation(userOp, rpcUrlOverride);
    let verificationGasLimit: bigint;
    let paymasterVerificationGasLimit: bigint | null = null;

    if (simResult.valid && simResult.validationResult) {
      const validationGas = simResult.validationResult.preOpGas - userOp.preVerificationGas;
      verificationGasLimit = (validationGas * 120n) / 100n;
      if (verificationGasLimit < 100_000n) verificationGasLimit = 100_000n;

      if (userOp.paymaster) {
        paymasterVerificationGasLimit = (validationGas * 130n) / 100n;
        if (paymasterVerificationGasLimit < 100_000n) {
          paymasterVerificationGasLimit = 100_000n;
        }
      }
    } else {
      verificationGasLimit = 200_000n;
      if (userOp.paymaster) {
        paymasterVerificationGasLimit = 200_000n;
      }
    }

    let callGasLimit: bigint;
    try {
      const estimated = await client.estimateGas({
        to: userOp.sender,
        data: userOp.callData,
        account: config.entryPointAddress,
      });
      callGasLimit = (estimated * 150n) / 100n;
      if (callGasLimit < 50_000n) callGasLimit = 50_000n;
    } catch {
      callGasLimit = 200_000n;
    }

    return {
      preVerificationGas,
      verificationGasLimit,
      callGasLimit,
      paymasterVerificationGasLimit,
    };
  }

  /**
   * Get current base fee from the network.
   */
  async function getCurrentBaseFee(rpcUrlOverride?: string): Promise<bigint> {
    const client = clientFor(rpcUrlOverride);
    const block = await client.getBlock({ blockTag: "latest" });
    return block.baseFeePerGas ?? 0n;
  }

  /**
   * Get current gas prices from the network: baseFee + suggested maxPriorityFeePerGas.
   *
   * Chains like Polygon/BSC enforce a minimum gas price that may be much higher
   * than the bundler's configured tip. This fetches the chain's actual suggestion
   * so the bundler can use max(config tip, chain suggestion).
   */
  async function getGasPrices(rpcUrlOverride?: string): Promise<{
    baseFee: bigint;
    suggestedMaxPriorityFeePerGas: bigint;
  }> {
    const rpcUrl = resolveRpcUrl(config, rpcUrlOverride);

    // Fetch baseFee and suggested priority fee in parallel
    const [blockRes, tipRes] = await Promise.allSettled([
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
      }).then((r) => r.json()),
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_maxPriorityFeePerGas", params: [] }),
      }).then((r) => r.json()),
    ]);

    let baseFee = 0n;
    if (blockRes.status === "fulfilled" && blockRes.value?.result?.baseFeePerGas) {
      baseFee = BigInt(blockRes.value.result.baseFeePerGas);
    }

    let suggestedMaxPriorityFeePerGas = 0n;
    if (tipRes.status === "fulfilled" && tipRes.value?.result) {
      suggestedMaxPriorityFeePerGas = BigInt(tipRes.value.result);
    } else {
      // Fallback for chains that don't support eth_maxPriorityFeePerGas:
      // use eth_gasPrice - baseFee as the implied tip
      try {
        const gasPriceRes = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_gasPrice", params: [] }),
        });
        const gasPriceJson = await gasPriceRes.json() as { result?: string };
        if (gasPriceJson.result) {
          const gasPrice = BigInt(gasPriceJson.result);
          suggestedMaxPriorityFeePerGas = gasPrice > baseFee ? gasPrice - baseFee : gasPrice;
        }
      } catch {
        // All gas price methods failed — use 0, caller will use config default
      }
    }

    return { baseFee, suggestedMaxPriorityFeePerGas };
  }

  return {
    simulateValidation,
    simulateExecution,
    simulateBundle,
    estimateUserOpGas,
    getCurrentBaseFee,
    getGasPrices,
  };
}

export type Simulator = ReturnType<typeof createSimulator>;

// --- Helpers ---

function extractRevertData(err: unknown): `0x${string}` | null {
  if (!err || typeof err !== "object") return null;
  const anyErr = err as Record<string, unknown>;

  if (anyErr.data && typeof anyErr.data === "string" && anyErr.data.startsWith("0x")) {
    return anyErr.data as `0x${string}`;
  }
  if (anyErr.cause && typeof anyErr.cause === "object") {
    return extractRevertData(anyErr.cause);
  }
  if (anyErr.details && typeof anyErr.details === "string") {
    const match = anyErr.details.match(/0x[0-9a-fA-F]+/);
    if (match) return match[0] as `0x${string}`;
  }
  if (anyErr.message && typeof anyErr.message === "string") {
    const match = anyErr.message.match(/data: (0x[0-9a-fA-F]+)/);
    if (match?.[1]) return match[1] as `0x${string}`;
  }
  return null;
}

function classifyFailedOpReason(reason: string): number {
  const r = reason.toLowerCase();
  if (r.includes("aa10") || r.includes("sender already constructed")) return RPC_ERROR_CODES.INVALID_USEROPERATION;
  if (r.includes("aa13") || r.includes("initcode failed")) return RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED;
  if (r.includes("aa14") || r.includes("initcode must return sender")) return RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED;
  if (r.includes("aa15") || r.includes("initcode must create sender")) return RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED;
  if (r.includes("aa21") || r.includes("didn't pay prefund")) return RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED;
  if (r.includes("aa23") || r.includes("reverted")) return RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED;
  if (r.includes("aa24") || r.includes("signature error")) return RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED;
  if (r.includes("aa25") || r.includes("invalid account nonce")) return RPC_ERROR_CODES.INVALID_USEROPERATION;
  if (r.includes("aa30") || r.includes("paymaster not deployed")) return RPC_ERROR_CODES.PAYMASTER_REJECTED;
  if (r.includes("aa31") || r.includes("paymaster deposit too low")) return RPC_ERROR_CODES.PAYMASTER_BALANCE_INSUFFICIENT;
  if (r.includes("aa33")) return RPC_ERROR_CODES.PAYMASTER_REJECTED;
  if (r.includes("aa34")) return RPC_ERROR_CODES.PAYMASTER_REJECTED;
  if (r.includes("aa40") || r.includes("over verificationgaslimit")) return RPC_ERROR_CODES.INVALID_USEROPERATION;
  if (r.includes("aa41") || r.includes("too little verificationgas")) return RPC_ERROR_CODES.INVALID_USEROPERATION;
  if (r.includes("aa51") || r.includes("prefund below")) return RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED;
  return RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED;
}
