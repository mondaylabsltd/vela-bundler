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
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
   * Parse successful return data from EntryPointSimulations.simulateValidation (v0.7).
   * Returns ValidationResult struct directly (not via revert).
   */
  function parseReturnedValidationResult(data: `0x${string}`): SimulationResult {
    try {
      const decoded = decodeFunctionResult({
        abi: ENTRYPOINT_V07_ABI,
        functionName: "simulateValidation",
        data,
      }) as any;

      // Result is a ValidationResult struct:
      // { returnInfo, senderInfo, factoryInfo, paymasterInfo, aggregatorInfo }
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

      // Check signature validation
      const accountVD = parseValidationData(returnInfo.accountValidationData);
      if (accountVD.aggregator !== "0x0000000000000000000000000000000000000000" &&
          accountVD.aggregator !== "0x0000000000000000000000000000000000000001") {
        return { valid: false, errorCode: RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED, errorMessage: "Aggregated signatures not supported" };
      }
      if (accountVD.aggregator === "0x0000000000000000000000000000000000000001") {
        return { valid: false, errorCode: RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED, errorMessage: "Account signature validation failed" };
      }
      if (!isValidTimeRange(accountVD.validAfter, accountVD.validUntil)) {
        return { valid: false, errorCode: RPC_ERROR_CODES.OUT_OF_TIME_RANGE, errorMessage: `Account validation out of time range` };
      }

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

        const accountVD = parseValidationData(returnInfo.accountValidationData);
        if (accountVD.aggregator !== "0x0000000000000000000000000000000000000000" &&
            accountVD.aggregator !== "0x0000000000000000000000000000000000000001") {
          return {
            valid: false,
            errorCode: RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED,
            errorMessage: "Aggregated signatures not supported",
          };
        }

        if (accountVD.aggregator === "0x0000000000000000000000000000000000000001") {
          return {
            valid: false,
            errorCode: RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED,
            errorMessage: "Account signature validation failed",
          };
        }

        if (!isValidTimeRange(accountVD.validAfter, accountVD.validUntil)) {
          return {
            valid: false,
            errorCode: RPC_ERROR_CODES.OUT_OF_TIME_RANGE,
            errorMessage: `Account validation out of time range: validAfter=${accountVD.validAfter}, validUntil=${accountVD.validUntil}`,
          };
        }

        if (returnInfo.paymasterValidationData !== 0n) {
          const pmVD = parseValidationData(returnInfo.paymasterValidationData);
          if (pmVD.aggregator === "0x0000000000000000000000000000000000000001") {
            return {
              valid: false,
              errorCode: RPC_ERROR_CODES.PAYMASTER_REJECTED,
              errorMessage: "Paymaster signature validation failed",
            };
          }
          if (!isValidTimeRange(pmVD.validAfter, pmVD.validUntil)) {
            return {
              valid: false,
              errorCode: RPC_ERROR_CODES.OUT_OF_TIME_RANGE,
              errorMessage: `Paymaster validation out of time range: validAfter=${pmVD.validAfter}, validUntil=${pmVD.validUntil}`,
            };
          }
        }

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
   * Simulate a full handleOps bundle via eth_estimateGas.
   */
  async function simulateBundle(
    packedOps: PackedUserOperation[],
    beneficiary: `0x${string}`,
    rpcUrlOverride?: string,
  ): Promise<BundleSimulationResult> {
    const client = clientFor(rpcUrlOverride);
    const calldata = encodeHandleOps(packedOps, beneficiary);

    try {
      const gas = await client.estimateGas({
        to: config.entryPointAddress,
        data: calldata,
        account: beneficiary,
      });
      return { success: true, estimatedGas: gas };
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

  return {
    simulateValidation,
    simulateBundle,
    estimateUserOpGas,
    getCurrentBaseFee,
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
