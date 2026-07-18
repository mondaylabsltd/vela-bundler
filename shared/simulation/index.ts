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
  parseEventLogs,
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
import type { BundlerConfig } from "../config/types.ts";
import { getPublicClient, resolveRpcUrl } from "../utils/rpc-client.ts";
import { RPC_TIMEOUT_MS } from "../utils/timeout.ts";
import { rpcCall, type RpcEnvelope } from "../reliability/rpc-fetch.ts";
import { createDeadline, type Deadline } from "../reliability/retry.ts";
import { getClassification } from "../reliability/errors.ts";
import { redactUrl } from "../reliability/log.ts";
import { isL2WithDataFee, isArbitrumChain, isOpStackChain, estimateArbitrumL1Gas, estimateOpStackL1Gas } from "../gas/l2-data-fee.ts";

/** Simulation calls get a longer timeout since they're heavier than simple RPC calls. */
const SIMULATION_TIMEOUT_MS = RPC_TIMEOUT_MS * 3; // 15s

/** Public RPCs tried (single attempt each) for the basic gas-price reads after the managed
 *  primary fails — bounds failure-path latency while still surviving a single-provider outage. */
const MAX_GAS_PRICE_FALLBACK_RPCS = 3;

/**
 * Total wall-time budget for a multi-RPC simulation fan-out. Bounds the worst case
 * where the primary RPC is down and we walk the fallback list — without this, a
 * dead upstream made a single simulate take (per-RPC timeout × list length).
 */
const SIMULATION_TOTAL_DEADLINE_MS = SIMULATION_TIMEOUT_MS * 2; // 30s across all RPCs

/** Cap on how many public fallback RPCs we walk per simulation (after user + default). */
const MAX_PUBLIC_FALLBACKS = 2;

/** L1-data-fee volatility buffer (bps) applied to the rollup L1 component baked into
 *  preVerificationGas — protects the bundler when the L1 base fee rises between quote and
 *  inclusion. 15000 = ×1.5. */
const L2_DATA_FEE_BUFFER_BPS = 15_000n;


export interface SimulationResult {
  valid: boolean;
  validationResult?: ValidationResultInfo;
  errorCode?: number;
  errorMessage?: string;
  /** True when the failure was a transport/transient RPC issue (try another node), as
   *  opposed to a definitive validation rejection. Set from structured classification. */
  transient?: boolean;
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
  /** True when the failure was a transport/transient RPC issue (try another node). */
  transient?: boolean;
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
    deadline?: Deadline,
  ): Promise<SimulationResult> {
    const packed = packUserOp(userOp);
    // HOP 2 evidence: what the bundler RECEIVED (factory) vs what it PUTS ON-CHAIN (initCode).
    // An empty packed.initCode here for an undeployed sender is the AA20 cause — and it tells us
    // whether the wallet sent no factory (received factory null) or the bundler dropped it.
    console.log(`[Simulator] simulateValidation IN: sender=${userOp.sender} receivedFactory=${userOp.factory ?? "(none)"} receivedFactoryDataLen=${userOp.factoryData?.length ?? 0} packedInitCodeLen=${packed.initCode.length} packedInitCodeHead=${packed.initCode.slice(0, 46)}`);
    const calldata = encodeFunctionData({
      abi: ENTRYPOINT_V07_ABI,
      functionName: "simulateValidation",
      args: [packed],
    });

    const ep = config.entryPointAddress;
    // Bound the whole fan-out by a shared deadline (request budget if supplied, else
    // a local cap) so a degraded chain can't make this walk every RPC at full timeout.
    const dl = deadline ?? createDeadline(SIMULATION_TOTAL_DEADLINE_MS);

    // Build RPC list: user RPC first (if provided), then chain default, then publicRpcs.
    // stateOverride (EntryPointSimulations bytecode injection) is flaky on some providers,
    // so we try multiple RPCs before giving up.
    const rpcsToTry = buildSimulationRpcList(config, rpcUrlOverride);

    for (let i = 0; i < rpcsToTry.length; i++) {
      if (dl.expired()) break;
      const rpcUrl = rpcsToTry[i]!;
      const result = await _doSimulateValidation(calldata, ep, rpcUrl, dl);
      if (result.valid) return result;
      if (result.transient) {
        console.warn(`[Simulator] simulateValidation transient failure on ${redactUrl(rpcUrl).slice(0, 50)}... (${i + 1}/${rpcsToTry.length}), trying next RPC...`);
        continue;
      }
      return result; // Definitive failure — don't retry
    }
    return { valid: false, transient: true, errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED, errorMessage: `Simulation unavailable on all ${rpcsToTry.length} RPCs (within deadline)` };
  }

  async function _doSimulateValidation(
    calldata: `0x${string}`,
    ep: `0x${string}`,
    rpcUrl: string,
    deadline?: Deadline,
  ): Promise<SimulationResult> {
    let json: RpcEnvelope;
    try {
      json = await rpcCall(
        rpcUrl,
        {
          jsonrpc: "2.0", id: 1,
          method: "eth_call",
          params: [
            { to: ep, data: calldata },
            "latest",
            // State override: inject EntryPointSimulations code at the EntryPoint address
            { [ep]: { code: ENTRY_POINT_SIMULATIONS_BYTECODE } },
          ],
        },
        { dependency: "rpc", operation: "simulateValidation", timeoutMs: SIMULATION_TIMEOUT_MS, maxAttempts: 1, deadline },
      );
    } catch (err) {
      // Transport failure (network/timeout/transient status/circuit open) — flagged
      // transient so the caller advances to the next RPC.
      const cls = getClassification(err);
      return {
        valid: false, transient: true,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Simulation RPC ${cls.reason}`,
      };
    }
    try {
      if (json.result && typeof json.result === "string" && json.result !== "0x") {
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

      console.log(`[Simulator] simulateValidation revert: data=${revertData ?? "none"} decoded=${revertData ? JSON.stringify(parseRevertData(revertData)) : "n/a"} raw=${JSON.stringify(json.error).slice(0, 400)}`);

      if (!revertData) {
        // No decodable revert data. An EntryPoint verdict ALWAYS carries ABI revert
        // data, so a bare `{error}` here is almost always a provider/transport failure
        // (dRPC "can't route your request to suitable provider" code 12, unsupported
        // state override, rate-limit surfaced as a JSON body, pruned/stale state) — not
        // a validation rejection. Flag transient so the fan-out advances to the next RPC
        // instead of rejecting a possibly-valid UserOp on one flaky node.
        if (!isExecutionRevertError(json.error)) {
          return {
            valid: false, transient: true,
            errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
            errorMessage: `Simulation RPC error, no revert data (${json.error?.message ?? "unknown"})`,
          };
        }
        return {
          valid: false,
          errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
          errorMessage: `Simulation reverted with no data (RPC error: ${json.error?.message ?? "unknown"})`,
        };
      }

      return parseRevertData(revertData);
    } catch (err: unknown) {
      // Decode failure of a 200 body — a malformed response from THIS node shouldn't
      // doom the op, so flag transient to let the caller try another RPC.
      console.warn(`[Simulator] simulateValidation response decode failed:`, err instanceof Error ? err.message : err);
      return {
        valid: false, transient: true,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Simulation response decode failed`,
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
    deadline?: Deadline,
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

    const ep = config.entryPointAddress;
    const dl = deadline ?? createDeadline(SIMULATION_TOTAL_DEADLINE_MS);
    const rpcsToTry = buildSimulationRpcList(config, rpcUrlOverride);

    for (let i = 0; i < rpcsToTry.length; i++) {
      if (dl.expired()) break;
      const rpcUrl = rpcsToTry[i]!;
      const result = await _doSimulateExecution(calldata, ep, rpcUrl, dl);
      if (result.success) return result;
      if (result.transient) {
        console.warn(`[Simulator] simulateHandleOp transient failure on ${redactUrl(rpcUrl).slice(0, 50)}... (${i + 1}/${rpcsToTry.length}), trying next RPC...`);
        continue;
      }
      return result;
    }
    return { success: false, transient: true, errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED, errorMessage: `simulateHandleOp unavailable on all ${rpcsToTry.length} RPCs (within deadline)` };
  }

  async function _doSimulateExecution(
    calldata: `0x${string}`,
    ep: `0x${string}`,
    rpcUrl: string,
    deadline?: Deadline,
  ): Promise<ExecutionSimulationResult> {
    let json: RpcEnvelope;
    try {
      json = await rpcCall(
        rpcUrl,
        {
          jsonrpc: "2.0", id: 1,
          method: "eth_call",
          params: [
            { to: ep, data: calldata },
            "latest",
            { [ep]: { code: ENTRY_POINT_SIMULATIONS_BYTECODE } },
          ],
        },
        { dependency: "rpc", operation: "simulateHandleOp", timeoutMs: SIMULATION_TIMEOUT_MS, maxAttempts: 1, deadline },
      );
    } catch (err) {
      const cls = getClassification(err);
      return { success: false, transient: true, errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED, errorMessage: `simulateHandleOp RPC ${cls.reason}` };
    }
    try {
      // Successful return — decode ExecutionResult
      if (json.result && typeof json.result === "string" && json.result !== "0x") {
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

      // No revert data — same reasoning as simulateValidation: a provider/transport
      // error (route failure, unsupported override, rate limit) should walk to the next
      // RPC, not fail the op. Only a genuine execution revert is a definitive verdict.
      if (!isExecutionRevertError(json.error)) {
        return {
          success: false, transient: true,
          errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
          errorMessage: `simulateHandleOp RPC error, no revert data (${json.error?.message ?? "unknown"})`,
        };
      }
      return {
        success: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `simulateHandleOp reverted with no data: ${json.error?.message ?? "unknown"}`,
      };
    } catch (err: unknown) {
      console.warn(`[Simulator] simulateHandleOp response decode failed:`, err instanceof Error ? err.message : err);
      return {
        success: false, transient: true,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `simulateHandleOp response decode failed`,
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
    } catch {
      return {
        success: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Failed to decode ExecutionResult`,
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
    } catch {
      return {
        valid: false,
        errorCode: RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED,
        errorMessage: `Failed to decode ValidationResult`,
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
    from?: `0x${string}`,
    rpcUrlOverride?: string,
    deadline?: Deadline,
    /** Skip the step-2 eth_call verification. Set by callers (the in-band path) that run a
     *  separate full-execution check (simulateExecutionSuccess/eth_simulateV1) right after — that
     *  proves per-op execution success AND returns real gasUsed, so the eth_call here (documented
     *  as "a final safety net already caught by simulateExecution per-op") is a redundant heavy
     *  round-trip on the hot path. eth_estimateGas (step 1, kept) still provides gas + FailedOp. */
    skipCallVerification?: boolean,
  ): Promise<BundleSimulationResult> {
    // `beneficiary` is only the encoded handleOps arg; `from` is the actual outer-tx sender
    // (the bundler EOA / tx.origin). They differ once the beneficiary is the splitter — the
    // splitter distributes to tx.origin, so simulating with from=splitter would self-reference.
    const caller = from ?? beneficiary;
    const calldata = encodeHandleOps(packedOps, beneficiary);
    const rpcUrl = resolveRpcUrl(config, rpcUrlOverride);

    // Step 1: eth_estimateGas for gas estimation — via rpcCall so it HONOURS the per-sender
    // deadline (the plain viem client here used to escape the budget entirely, letting one
    // slow RPC stretch a "20s-bounded" sender cycle into minutes).
    let estimatedGas: bigint;
    try {
      const estJson = await rpcCall(
        rpcUrl,
        {
          jsonrpc: "2.0", id: 1,
          method: "eth_estimateGas",
          params: [{ to: config.entryPointAddress, data: calldata, from: caller }],
        },
        { dependency: "rpc", operation: "simulateBundle.estimateGas", timeoutMs: SIMULATION_TIMEOUT_MS, maxAttempts: 1, deadline },
      );
      if (estJson.error) {
        let failedOpIndex: number | undefined;
        let errorMessage = estJson.error.message ?? "eth_estimateGas failed";
        const revertData = revertDataFromRpcError(estJson.error);
        if (revertData) {
          try {
            const decoded = decodeErrorResult({ abi: ENTRYPOINT_V07_ABI, data: revertData });
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
      estimatedGas = BigInt(estJson.result as string);
    } catch (err: unknown) {
      // Transport-level failure (timeout / deadline / network) — no revert data available.
      return { success: false, errorMessage: err instanceof Error ? err.message : String(err) };
    }

    // Step 2: eth_call to detect individual UserOp execution failures
    // (EntryPoint handleOps doesn't revert on individual op failures — it emits
    // UserOperationEvent with success=false and UserOperationRevertReason).
    // Skipped on the in-band path, which runs eth_simulateV1 next (proves the same thing).
    if (!skipCallVerification) try {
      const callJson = await rpcCall(
        rpcUrl,
        {
          jsonrpc: "2.0", id: 1,
          method: "eth_call",
          params: [
            { to: config.entryPointAddress, data: calldata, from: caller },
            "latest",
          ],
        },
        { dependency: "rpc", operation: "simulateBundle.ethCall", timeoutMs: SIMULATION_TIMEOUT_MS, maxAttempts: 1, deadline },
      );

      // If eth_call itself reverts, the whole bundle fails (FailedOp during validation)
      if (callJson.error) {
        const revertData = revertDataFromRpcError(callJson.error);
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
    deadline?: Deadline,
  ): Promise<{
    preVerificationGas: bigint;
    verificationGasLimit: bigint;
    callGasLimit: bigint;
    paymasterVerificationGasLimit: bigint | null;
  }> {
    const dl = deadline ?? createDeadline(SIMULATION_TOTAL_DEADLINE_MS);
    const client = clientFor(rpcUrlOverride);
    const { calcPreVerificationGas } = await import("../gas/preVerificationGas.ts");

    // For L2 rollups, estimate the L1 data fee component in gas units.
    // - Arbitrum: NodeInterface.gasEstimateL1Component → gas units directly
    // - OP Stack: GasPriceOracle.getL1Fee → wei, divided by gasPrice → gas units
    let l2DataFeeGas: bigint | undefined;
    if (isL2WithDataFee(config.chainId)) {
      const rpcUrl = resolveRpcUrl(config, rpcUrlOverride);
      const packed = packUserOp(userOp);
      const handleOpsCalldata = encodeHandleOps([packed], config.entryPointAddress);

      if (isArbitrumChain(config.chainId)) {
        l2DataFeeGas = await estimateArbitrumL1Gas(
          config.entryPointAddress,
          handleOpsCalldata,
          rpcUrl,
        );
      } else if (isOpStackChain(config.chainId)) {
        // OP Stack needs current gas price to convert wei → gas units
        const { baseFee, suggestedMaxPriorityFeePerGas } = await getGasPrices(rpcUrlOverride, dl);
        const gasPrice = baseFee + suggestedMaxPriorityFeePerGas;
        l2DataFeeGas = await estimateOpStackL1Gas(
          handleOpsCalldata,
          gasPrice,
          rpcUrl,
        );
      }
      // L1-fee volatility buffer: the L1 data fee is fixed into preVerificationGas at
      // quote/estimate time, but the REAL L1 fee at inclusion depends on the L1 base fee
      // then (which can spike). Inflate the L1 component so the user's prepaid pvg still
      // covers the bundler's L1 cost across normal L1 volatility, rather than the bundler
      // eating the difference. Bounded (×1.5) so users aren't materially overcharged.
      if (l2DataFeeGas && l2DataFeeGas > 0n) {
        l2DataFeeGas = (l2DataFeeGas * L2_DATA_FEE_BUFFER_BPS) / 10_000n;
      }
    }

    const preVerificationGas = calcPreVerificationGas(userOp, {
      expectedBundleSize: 1,
      l2DataFeeGas,
    });

    const simResult = await simulateValidation(userOp, rpcUrlOverride, dl);
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
  async function getGasPrices(rpcUrlOverride?: string, deadline?: Deadline): Promise<{
    baseFee: bigint;
    suggestedMaxPriorityFeePerGas: bigint;
    /** eth_gasPrice — used as floor to prevent nodes rejecting txs with too-low gas price. */
    chainGasPrice: bigint;
  }> {
    const primary = resolveRpcUrl(config, rpcUrlOverride);

    // Basic gas reads (eth_getBlockByNumber / eth_gasPrice / eth_maxPriorityFeePerGas) are served
    // by EVERY node, so when the primary is a PUBLIC/user RPC we walk a capped set of the resolved
    // public RPCs before degrading — a single flaky endpoint won't take pricing offline.
    // BUT when the primary is the operator's paid, managed RPC (Alchemy) it is the highest-priority
    // and most reliable source: DO NOT fall back to public RPCs (they can be flaky or return a
    // different price the user then signs). Trust Alchemy alone — retry it, or degrade (retryable)
    // if it's genuinely down. Mirrors buildSimulationRpcList's managed-primary gating.
    const fallbacks = isManagedRpcUrl(primary)
      ? []
      : (config.publicRpcs ?? []).filter((u) => u && u !== primary).slice(0, MAX_GAS_PRICE_FALLBACK_RPCS);
    const urls = [primary, ...fallbacks];
    // Bound the whole walk even when the caller passes no deadline (the background fee-bump /
    // cancellation callers) — otherwise each URL mints a fresh per-call timeout and a full-outage
    // walk could run ~4× a single call's budget before returning.
    const dl = deadline ?? createDeadline(SIMULATION_TIMEOUT_MS);
    let lastReason: unknown = new Error("gas price unavailable");

    for (const rpcUrl of urls) {
      // Route through the unified wrapper: per-call timeout + circuit breaker + structured
      // classification. Single attempt per URL (the URL walk is the retry), no amplification.
      const call = (id: number, method: string) =>
        rpcCall(rpcUrl, { jsonrpc: "2.0", id, method, params: method === "eth_getBlockByNumber" ? ["latest", false] : [] },
          { dependency: "rpc", operation: method, timeoutMs: RPC_TIMEOUT_MS, maxAttempts: 1, deadline: dl });

      const [blockRes, tipRes, gpRes] = await Promise.allSettled([
        call(1, "eth_getBlockByNumber"),
        call(2, "eth_maxPriorityFeePerGas"),
        call(3, "eth_gasPrice"),
      ]);

      // ALL THREE reads failed → this RPC is unreachable, not "gas is free". Record the reason
      // and try the next URL; only the final throw surfaces a retryable degraded error to the
      // caller (never a maxFeePerGas=0x0 quote, which the user would SIGN and then get stuck).
      if (blockRes.status === "rejected" && tipRes.status === "rejected" && gpRes.status === "rejected") {
        lastReason = blockRes.reason;
        continue;
      }

      // A FAILED base-fee read (block rejected) is NOT a legitimately-zero base fee: on a 1559
      // chain baseFee is usually the dominant term, and returning 0 would quote a tip-only,
      // grossly-underpriced op that stalls. eth_gasPrice (chainGasPrice) is the caller's floor
      // and on 1559 chains ≈ base+tip, so it rescues us — but if BOTH the block read AND
      // eth_gasPrice failed while only the tip succeeded, we have no reliable price: skip to the
      // next URL, degrading only if none works. A block read that SUCCEEDED with no baseFeePerGas
      // (Tempo / non-1559) keeps baseFee=0 correctly and is unaffected.
      const baseFeeReadFailed = blockRes.status === "rejected";

      let baseFee = 0n;
      const blockResult = blockRes.status === "fulfilled" ? (blockRes.value?.result as { baseFeePerGas?: string } | undefined) : undefined;
      if (blockResult?.baseFeePerGas) {
        baseFee = BigInt(blockResult.baseFeePerGas);
      }

      let chainGasPrice = 0n;
      const gpResult = gpRes.status === "fulfilled" ? (gpRes.value?.result as string | undefined) : undefined;
      if (gpResult) {
        chainGasPrice = BigInt(gpResult);
      }

      let suggestedMaxPriorityFeePerGas = 0n;
      const tipResult = tipRes.status === "fulfilled" ? (tipRes.value?.result as string | undefined) : undefined;
      if (tipResult) {
        suggestedMaxPriorityFeePerGas = BigInt(tipResult);
      } else {
        // Fallback: derive tip from gasPrice - baseFee
        suggestedMaxPriorityFeePerGas = chainGasPrice > baseFee ? chainGasPrice - baseFee : chainGasPrice;
      }

      if (baseFeeReadFailed && chainGasPrice === 0n && suggestedMaxPriorityFeePerGas > 0n) {
        lastReason = blockRes.reason;
        continue; // tip-only, no base-fee and no gasPrice floor → unreliable, try next URL
      }

      return { baseFee, suggestedMaxPriorityFeePerGas, chainGasPrice };
    }

    throw lastReason;
  }

  /**
   * Verify every op's EXECUTION (not just validation) would succeed on-chain — i.e.
   * `UserOperationEvent.success` would be true for each. Critical on Tempo, where the
   * bundler is repaid only by an in-band feeToken transfer batched inside the UserOp:
   * if execution reverts (OOG, insufficient balance, …) handleOps still SUCCEEDS but the
   * reimbursement transfer is rolled back, so the bundler pays 0x76 gas for nothing.
   *
   * handleOps swallows the inner revert, so eth_call / eth_estimateGas can't see it. We
   * run handleOps through eth_simulateV1 (which returns logs) and read each
   * UserOperationEvent.success. The op's real callGasLimit is enforced by the EntryPoint
   * internally, so an OOG at the declared limit is faithfully reproduced. Fails CLOSED:
   * if we can't prove success, we don't submit.
   */
  async function simulateExecutionSuccess(
    packedOps: PackedUserOperation[],
    beneficiary: `0x${string}`,
    from?: `0x${string}`,
    rpcUrlOverride?: string,
    deadline?: Deadline,
  ): Promise<{ success: boolean; failedOpIndex?: number; errorMessage?: string; gasUsed?: bigint; transient?: boolean }> {
    // See simulateBundle: `from` is the real tx sender (EOA); differs from a splitter beneficiary.
    const caller = from ?? beneficiary;
    const calldata = encodeHandleOps(packedOps, beneficiary);
    const dl = deadline ?? createDeadline(SIMULATION_TOTAL_DEADLINE_MS);
    // WALK the trusted RPC list (like simulateValidation / simulateExecution) rather than a single
    // primary: eth_simulateV1 is NOT universally available (a free-tier node returns "method not
    // available on freetier"), and this chain's primary may be the incapable one while a fallback
    // (Alchemy) supports it. Crucial classification: a per-op execution VERDICT only ever appears
    // inside a 200 `json.result`; a top-level `json.error` or a transport failure means the node
    // could not RUN the method (a CAPABILITY failure) — NEVER that the op reverted. So we advance
    // to the next RPC on capability failures and only return on a genuine verdict. Misreading a
    // capability error as "execution would revert" is what silently killed every op on a free-RPC
    // chain (fronting the wallet a bogus terminal failure).
    const rpcsToTry = buildSimulationRpcList(config, rpcUrlOverride);
    type SimV1 = {
      result?: Array<{ calls?: Array<{ status?: string; gasUsed?: string; logs?: unknown[]; error?: { message?: string } }> }>;
      error?: { message?: string; code?: number };
    };
    let lastCapability = "no trusted RPC available";
    for (let i = 0; i < rpcsToTry.length; i++) {
      if (dl.expired()) break;
      const rpcUrl = rpcsToTry[i]!;
      let json: SimV1;
      try {
        json = (await rpcCall(
          rpcUrl,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_simulateV1",
            params: [
              {
                blockStateCalls: [
                  { calls: [{ from: caller, to: config.entryPointAddress, data: calldata }] },
                ],
                validation: false,
                traceTransfers: false,
              },
              "latest",
            ],
          },
          { dependency: "rpc", operation: "eth_simulateV1", timeoutMs: SIMULATION_TIMEOUT_MS, maxAttempts: 1, deadline: dl },
        )) as SimV1;
      } catch (err) {
        // Transport failure: the node couldn't serve the call — CAPABILITY, not a verdict.
        lastCapability = `eth_simulateV1 transport ${getClassification(err).reason}`;
        console.warn(`[Simulator] ${lastCapability} on ${redactUrl(rpcUrl).slice(0, 50)}... (${i + 1}/${rpcsToTry.length}), trying next RPC...`);
        continue;
      }
      if (json.error) {
        // A top-level JSON-RPC error means eth_simulateV1 itself could not run (unsupported /
        // freetier / rate-limited / routing) — an inner op revert lives in json.result, never here.
        // Treat as capability and advance; do NOT misclassify as "execution would revert".
        lastCapability = `eth_simulateV1 error: ${json.error.message ?? "unknown"}`;
        console.warn(`[Simulator] ${lastCapability} on ${redactUrl(rpcUrl).slice(0, 50)}... (${i + 1}/${rpcsToTry.length}), trying next RPC...`);
        continue;
      }
      const call = json.result?.[0]?.calls?.[0];
      if (!call) {
        lastCapability = "eth_simulateV1 returned no call result";
        console.warn(`[Simulator] ${lastCapability} on ${redactUrl(rpcUrl).slice(0, 50)}... (${i + 1}/${rpcsToTry.length}), trying next RPC...`);
        continue;
      }
      // Everything below is a genuine on-chain VERDICT derived from json.result.
      // handleOps itself reverted (e.g. validation FailedOp) — whole bundle is invalid.
      if (call.status !== undefined && BigInt(call.status) === 0n) {
        return { success: false, errorMessage: `handleOps reverted in simulation: ${call.error?.message ?? "unknown"}` };
      }
      const events = parseEventLogs({
        abi: ENTRYPOINT_V07_ABI,
        // deno-lint-ignore no-explicit-any
        logs: (call.logs ?? []) as any,
        eventName: "UserOperationEvent",
      });
      // EntryPoint emits one UserOperationEvent per op, in submission order.
      for (let k = 0; k < events.length; k++) {
        // deno-lint-ignore no-explicit-any
        if ((events[k] as any).args?.success === false) {
          return { success: false, failedOpIndex: k, errorMessage: `UserOp ${k} execution would revert on-chain` };
        }
      }
      if (events.length < packedOps.length) {
        return {
          success: false,
          errorMessage: `only ${events.length}/${packedOps.length} ops emitted a UserOperationEvent (op reverted before execution)`,
        };
      }
      // gasUsed = the REAL gas handleOps burns (execution actually run), unlike
      // eth_estimateGas which reserves the full padded callGasLimit. Used to price the
      // bundler's cost accurately on Tempo.
      let gasUsed: bigint | undefined;
      try {
        if (call.gasUsed) gasUsed = BigInt(call.gasUsed);
      } catch { /* leave undefined */ }
      return { success: true, gasUsed };
    }

    // No RPC could RUN eth_simulateV1 — fall back to a universal plain-eth_call execution probe so
    // a chain whose RPC lacks eth_simulateV1 is not permanently un-sendable.
    console.warn(`[Simulator] eth_simulateV1 unavailable on all ${rpcsToTry.length} RPC(s) (${lastCapability}) — falling back to eth_call execution probe`);
    return await simulateExecutionViaEthCall(packedOps, rpcsToTry, dl, lastCapability);
  }

  /**
   * Universal execution-success probe for RPCs that do NOT support eth_simulateV1.
   *
   * handleOps SWALLOWS an inner UserOp revert (the reimbursement transfer batched inside the op is
   * then rolled back while handleOps still succeeds), so a plain eth_call / eth_estimateGas of
   * handleOps cannot see it. Instead we eth_call the account's execution DIRECTLY — from the
   * EntryPoint, to the sender, with the op's callData — UNWRAPPED by handleOps, so an inner revert
   * (incl. the reimbursement leg reverting for insufficient balance) surfaces as an eth_call revert.
   * Correct for in-band ops: maxFee=0 ⇒ prefund 0 ⇒ validation has no balance side-effect, so
   * execution isolated from validation reproduces the balance state the reimbursement leg reads.
   *
   * Fail-closed guards (a false "OK" here = the operator fronts gas unpaid):
   *  - length must be 1: per-op eth_call runs each op against the SAME pre-bundle state, so it
   *    cannot reproduce op[i] seeing op[<i]'s effects — a sequential drain across a multi-op bundle
   *    would be a money hole. A multi-op bundle DEFERS (transient) so the queue reassembles it as
   *    single-op bundles, or the operator points the chain at an eth_simulateV1-capable RPC.
   *  - a deploy op (non-empty initCode) DEFERS: at 'latest' the sender has no code, so the eth_call
   *    can't test execution — passing it would be blind.
   *  - gas is pinned to the op's declared callGasLimit so an OOG-at-limit reverts in the safe
   *    direction. (A node that ignores the eth_call gas field leaves a residual OOG false-negative —
   *    the documented price of running a chain on a plain-eth_call RPC; use a capable RPC to close it.)
   */
  async function simulateExecutionViaEthCall(
    packedOps: PackedUserOperation[],
    rpcsToTry: string[],
    dl: Deadline,
    capabilityReason: string,
  ): Promise<{ success: boolean; failedOpIndex?: number; errorMessage?: string; gasUsed?: bigint; transient?: boolean }> {
    if (packedOps.length !== 1) {
      return { success: false, transient: true, errorMessage: `eth_simulateV1 unavailable (${capabilityReason}) and a ${packedOps.length}-op bundle can't be execution-verified via eth_call — deferring; point this chain at an eth_simulateV1-capable RPC` };
    }
    const op = packedOps[0]!;
    if (op.initCode && op.initCode !== "0x") {
      return { success: false, transient: true, errorMessage: `eth_simulateV1 unavailable (${capabilityReason}) and the account is undeployed (initCode present) — execution can't be verified via eth_call; deferring, needs a capable RPC` };
    }
    // callGasLimit = low 16 bytes of accountGasLimits (bytes32: verificationGasLimit | callGasLimit).
    const callGasLimit = BigInt("0x" + op.accountGasLimits.slice(2).padStart(64, "0").slice(32, 64));
    const gasHex = `0x${callGasLimit.toString(16)}`;
    let lastTransient = capabilityReason;
    for (let i = 0; i < rpcsToTry.length; i++) {
      if (dl.expired()) break;
      const rpcUrl = rpcsToTry[i]!;
      let json: RpcEnvelope;
      try {
        json = await rpcCall(
          rpcUrl,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            // from = EntryPoint (Safe4337Module.executeUserOp requires msg.sender == EntryPoint);
            // to = sender; data = the op's callData (exactly what the EntryPoint calls, unwrapped).
            params: [{ from: config.entryPointAddress, to: op.sender, data: op.callData, gas: gasHex }, "latest"],
          },
          { dependency: "rpc", operation: "eth_call_exec_probe", timeoutMs: SIMULATION_TIMEOUT_MS, maxAttempts: 1, deadline: dl },
        );
      } catch (err) {
        lastTransient = `eth_call probe transport ${getClassification(err).reason}`;
        continue;
      }
      if (typeof json.result === "string") {
        // Execution ran without reverting ⇒ the batched reimbursement leg would also execute.
        return { success: true };
      }
      if (json.error) {
        if (isExecutionRevertError(json.error)) {
          // Genuine execution revert ⇒ the whole atomic UserOp (incl. reimbursement) rolls back.
          return { success: false, failedOpIndex: 0, errorMessage: `execution would revert on-chain (eth_call probe): ${json.error.message ?? "reverted"}` };
        }
        lastTransient = `eth_call probe error: ${json.error.message ?? "unknown"}`;
        continue; // capability / transport — try next RPC
      }
      lastTransient = "eth_call probe returned no result";
    }
    // Couldn't get a definitive answer from any RPC — fail closed as transient (defer, no penalty).
    return { success: false, transient: true, errorMessage: `execution unverifiable via eth_call on all RPCs (${lastTransient})` };
  }

  return {
    simulateValidation,
    simulateExecution,
    simulateExecutionSuccess,
    simulateBundle,
    estimateUserOpGas,
    getCurrentBaseFee,
    getGasPrices,
  };
}

export type Simulator = ReturnType<typeof createSimulator>;

// --- Helpers ---

/**
 * True when `url` is a trusted managed RPC (Alchemy). A managed primary is reliable
 * enough — and supports the state-override `eth_call` that simulation needs — to be
 * used on its own, so we skip the flaky public registry fallbacks behind it.
 */
export function isManagedRpcUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.endsWith(".g.alchemy.com");
  } catch {
    return false;
  }
}

/**
 * Build the ordered RPC list a simulation call walks.
 *
 * Policy (per operator directive — "prefer Alchemy unless the client passes its own"):
 *   1. A client-supplied X-Rpc-Url wins — it is explicitly choosing its own node.
 *   2. The chain default (Alchemy when configured & supported) comes next.
 *   3. The registry's public RPCs are appended ONLY when NO managed primary is in front.
 *
 * Why (3) is gated: public Gnosis endpoints such as `gnosis.drpc.org` cannot route the
 * state-override `eth_call` and reply `{"code":12,"message":"Can't route your request to
 * suitable provider"}`. Walking onto them turned a healthy UserOp into a false rejection.
 * With Alchemy (which we verified serves the override) in front, those endpoints are
 * skipped entirely; chains WITHOUT Alchemy still get the capped public fallback for
 * resilience.
 */
export function buildSimulationRpcList(cfg: BundlerConfig, rpcUrlOverride?: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  const add = (url?: string | null) => { if (url && !seen.has(url)) { seen.add(url); list.push(url); } };

  add(rpcUrlOverride);       // 1. client's custom RPC wins, if provided
  add(cfg.rpcUrl);           // 2. chain default — Alchemy when configured & supported

  // 3. Append capped public fallbacks ONLY when the primary is not a managed/trusted node.
  const primaryIsManaged = isManagedRpcUrl(rpcUrlOverride) || isManagedRpcUrl(cfg.rpcUrl);
  if (!primaryIsManaged) {
    let publicAdded = 0;
    for (const r of (cfg.publicRpcs ?? [])) {
      if (publicAdded >= MAX_PUBLIC_FALLBACKS) break;
      if (!seen.has(r)) { add(r); publicAdded++; }
    }
  }
  return list;
}

/**
 * Decide whether a JSON-RPC `error` that carried NO decodable revert data represents a
 * genuine on-chain execution revert (a definitive EntryPoint verdict) versus a
 * provider/transport-level failure that should be retried on another node.
 *
 * EntryPoint verdicts always come back as ABI-encoded revert data
 * (ValidationResult / FailedOp / FailedOpWithRevert), so a no-data error is almost never
 * a real verdict. But some nodes surface the revert reason ONLY as plain text (no hex),
 * so we still confirm via the standard "execution reverted" signals before treating it
 * as definitive — otherwise a legitimate AAxx rejection could be mistaken for a blip.
 *
 * Returns true  → genuine execution revert (definitive; do NOT try another RPC).
 * Returns false → provider/transport failure (advance to the next RPC). This covers
 *   dRPC "Can't route your request to suitable provider" (code 12), capacity/rate-limit
 *   errors returned in a 200 body, unsupported method/state-override, and pruned state.
 */
export function isExecutionRevertError(error?: { code?: number; message?: string } | null): boolean {
  if (!error) return false;
  // EIP-1474 standard "execution reverted" code — authoritative.
  if (error.code === 3) return true;
  const msg = (error.message ?? "").toLowerCase();
  if (!msg) return false;
  // Check the DEFINITIVE revert signal FIRST: a real EntryPoint rejection ("AAxx",
  // "execution reverted", "out of gas") is a verdict even if its reason text happens to
  // contain a word like "temporarily"/"unavailable". Ordering this ahead of the transient
  // heuristic keeps the classifier fail-safe — a genuinely-invalid op is never admitted as
  // merely retryable. (Real verdicts carry hex data and never reach here, but be robust.)
  if (/execution reverted|reverted|out of gas|\baa\d{2}\b/.test(msg)) return true;
  // Otherwise, provider/transport signatures mean "this node can't serve the request"
  // (dRPC "can't route", rate limit, unsupported method/override, pruned state) → transient.
  if (/can'?t route|cannot route|suitable provider|no (backend|provider|suitable)|capacity|rate.?limit|too many requests|try again|timeout|timed out|method [^ ]* ?(not found|not supported|not available|unsupported)|not supported|unsupported|missing trie node|header not found|resource not found|state[^.]*(unavailable|pruned)|overloaded|temporarily|unavailable/.test(msg)) {
    return false;
  }
  // Unknown no-data error → treat as provider-level so the fan-out can recover.
  return false;
}

/**
 * Extract EVM revert bytes from a JSON-RPC error envelope. Providers disagree on the
 * shape: geth puts hex in `error.data`, Nethermind/Besu/some gateways nest it as
 * `error.data.data` or embed it in the message text — missing any of them leaves
 * failedOpIndex undecodable, so a permanently-reverting op is never evicted and blocks
 * its sender's slot for the full mempool TTL.
 */
function revertDataFromRpcError(error: { message?: string; data?: unknown }): `0x${string}` | undefined {
  const d = error.data;
  if (typeof d === "string" && d.startsWith("0x") && d.length > 10) return d as `0x${string}`;
  if (d && typeof d === "object") {
    const inner = (d as { data?: unknown }).data;
    if (typeof inner === "string" && inner.startsWith("0x") && inner.length > 10) return inner as `0x${string}`;
  }
  const m = error.message?.match(/0x[0-9a-fA-F]{10,}/);
  if (m) return m[0] as `0x${string}`;
  return undefined;
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
