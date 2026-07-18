/**
 * Unit tests for simulation module — validation data checking, execution result parsing,
 * and revert data extraction.
 *
 * These tests cover the pure-logic functions extracted during the P0/P1 refactoring.
 * RPC-dependent simulation (simulateValidation, simulateExecution, simulateBundle)
 * is tested via integration tests with a live Anvil node.
 */

import { it, expect } from "vitest";
import {
  decodeErrorResult,
  encodeErrorResult,
  encodeFunctionData,
} from "viem";
import { ENTRYPOINT_V07_ABI, RPC_ERROR_CODES } from "../shared/contracts/entrypoint.ts";
import { parseValidationData, isValidTimeRange } from "../shared/userop/validate.ts";
import { isExecutionRevertError, isManagedRpcUrl, buildSimulationRpcList } from "../shared/simulation/index.ts";
import type { BundlerConfig } from "../shared/config/types.ts";

// ---- Helpers: build encoded data for simulation result parsing ----

/** Encode an ExecutionResult error (as v0.6 compat revert). */
function encodeExecutionResultError(opts: {
  preOpGas?: bigint;
  paid?: bigint;
  accountValidationData?: bigint;
  paymasterValidationData?: bigint;
  targetSuccess: boolean;
  targetResult?: `0x${string}`;
}): `0x${string}` {
  return encodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    errorName: "ExecutionResult",
    args: [
      opts.preOpGas ?? 100_000n,
      opts.paid ?? 50_000n,
      opts.accountValidationData ?? 0n,
      opts.paymasterValidationData ?? 0n,
      opts.targetSuccess,
      opts.targetResult ?? "0x",
    ],
  });
}

/** Encode a FailedOp error. */
function encodeFailedOp(opIndex: bigint, reason: string): `0x${string}` {
  return encodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    errorName: "FailedOp",
    args: [opIndex, reason],
  });
}

/** Encode a FailedOpWithRevert error. */
function encodeFailedOpWithRevert(
  opIndex: bigint,
  reason: string,
  inner: `0x${string}`,
): `0x${string}` {
  return encodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    errorName: "FailedOpWithRevert",
    args: [opIndex, reason, inner],
  });
}

/** Encode a ValidationResult error (revert path). */
function encodeValidationResultError(opts: {
  preOpGas?: bigint;
  prefund?: bigint;
  accountValidationData?: bigint;
  paymasterValidationData?: bigint;
  paymasterContext?: `0x${string}`;
}): `0x${string}` {
  return encodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    errorName: "ValidationResult",
    args: [
      {
        preOpGas: opts.preOpGas ?? 100_000n,
        prefund: opts.prefund ?? 200_000n,
        accountValidationData: opts.accountValidationData ?? 0n,
        paymasterValidationData: opts.paymasterValidationData ?? 0n,
        paymasterContext: opts.paymasterContext ?? "0x",
      },
      { stake: 0n, unstakeDelaySec: 0n },
      { stake: 0n, unstakeDelaySec: 0n },
      { stake: 0n, unstakeDelaySec: 0n },
    ],
  });
}

// ---- parseValidationData tests ----

it("parseValidationData - zero data means valid forever, no aggregator", () => {
  const result = parseValidationData(0n);
  expect(result.aggregator).toEqual("0x0000000000000000000000000000000000000000");
  expect(result.validAfter).toEqual(0);
  expect(result.validUntil).toEqual(0xffffffffffff); // 0 means no expiry
});

it("parseValidationData - sig failure aggregator == address(1)", () => {
  // Canonical ERC-4337 v0.7: aggregator occupies the LOW 160 bits; SIG_VALIDATION_FAILED == 1.
  const sigFail = 1n;
  const result = parseValidationData(sigFail);
  expect(result.aggregator).toEqual("0x0000000000000000000000000000000000000001");
});

it("parseValidationData - encodes validAfter and validUntil correctly", () => {
  // Canonical packing: validUntil << 160, validAfter << 208.
  const validUntil = 1700000000n;
  const validAfter = 1600000000n;
  const data = (validUntil << 160n) | (validAfter << 208n);
  const result = parseValidationData(data);
  expect(result.validAfter).toEqual(1600000000);
  expect(result.validUntil).toEqual(1700000000);
});

it("parseValidationData - combined aggregator + time range", () => {
  // Canonical: aggregator(low 160) | validUntil<<160 | validAfter<<208.
  const aggregator = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn;
  const validUntil = 2000000000n;
  const validAfter = 1000000000n;
  const data = aggregator | (validUntil << 160n) | (validAfter << 208n);
  const result = parseValidationData(data);
  expect(result.aggregator).toEqual("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  expect(result.validAfter).toEqual(1000000000);
  expect(result.validUntil).toEqual(2000000000);
});

// ---- isValidTimeRange tests ----

it("isValidTimeRange - zero validUntil means no expiry", () => {
  expect(isValidTimeRange(0, 0)).toBeTruthy();
});

it("isValidTimeRange - future validAfter returns false", () => {
  const farFuture = Math.floor(Date.now() / 1000) + 100_000;
  expect(!isValidTimeRange(farFuture, 0)).toBeTruthy();
});

it("isValidTimeRange - past validUntil returns false (expired)", () => {
  const past = Math.floor(Date.now() / 1000) - 100;
  expect(!isValidTimeRange(0, past)).toBeTruthy();
});

it("isValidTimeRange - valid range passes", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(isValidTimeRange(now - 100, now + 100)).toBeTruthy();
});

it("isValidTimeRange - safety margin is respected", () => {
  const now = Math.floor(Date.now() / 1000);
  // validUntil is now + 5 seconds, but with 30s margin it should fail
  expect(!isValidTimeRange(0, now + 5, 30)).toBeTruthy();
  // With 3s margin it should pass
  expect(isValidTimeRange(0, now + 5, 3)).toBeTruthy();
});

// ---- ExecutionResult error encoding/decoding roundtrip ----

it("ExecutionResult error - can encode and decode targetSuccess=true", () => {
  const encoded = encodeExecutionResultError({ targetSuccess: true, paid: 42n });
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  expect(decoded.errorName).toEqual("ExecutionResult");
  const args = decoded.args as unknown as [bigint, bigint, bigint, bigint, boolean, `0x${string}`];
  expect(args[4]).toEqual(true); // targetSuccess
  expect(args[1]).toEqual(42n); // paid
});

it("ExecutionResult error - can encode and decode targetSuccess=false", () => {
  const encoded = encodeExecutionResultError({
    targetSuccess: false,
    targetResult: "0xacfdb444", // ExecutionFailed() selector
    paid: 100n,
  });
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  expect(decoded.errorName).toEqual("ExecutionResult");
  const args = decoded.args as unknown as [bigint, bigint, bigint, bigint, boolean, `0x${string}`];
  expect(args[4]).toEqual(false); // targetSuccess
  expect(args[5].startsWith("0xacfdb444")).toBeTruthy();
});

// ---- FailedOp error encoding/decoding roundtrip ----

it("FailedOp error - roundtrip encoding and decoding", () => {
  const encoded = encodeFailedOp(0n, "AA21 didn't pay prefund");
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  expect(decoded.errorName).toEqual("FailedOp");
  const [opIndex, reason] = decoded.args as unknown as [bigint, string];
  expect(opIndex).toEqual(0n);
  expect(reason).toEqual("AA21 didn't pay prefund");
});

it("FailedOpWithRevert error - roundtrip encoding and decoding", () => {
  const encoded = encodeFailedOpWithRevert(1n, "AA23 reverted", "0xdeadbeef");
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  expect(decoded.errorName).toEqual("FailedOpWithRevert");
  const [opIndex, reason, inner] = decoded.args as unknown as [bigint, string, `0x${string}`];
  expect(opIndex).toEqual(1n);
  expect(reason).toEqual("AA23 reverted");
  expect(inner.startsWith("0xdeadbeef")).toBeTruthy();
});

// ---- ValidationResult error encoding/decoding roundtrip ----

it("ValidationResult error - roundtrip with valid data", () => {
  const encoded = encodeValidationResultError({
    preOpGas: 150_000n,
    prefund: 300_000n,
    accountValidationData: 0n,
    paymasterValidationData: 0n,
  });
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  expect(decoded.errorName).toEqual("ValidationResult");
});

it("ValidationResult error - sig failure aggregator is detectable", () => {
  // accountValidationData with aggregator=0x01 (sig fail) — canonical low-bit encoding.
  const sigFail = 1n;
  const encoded = encodeValidationResultError({
    accountValidationData: sigFail,
  });
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  const args = decoded.args as unknown as [
    { accountValidationData: bigint },
    unknown, unknown, unknown,
  ];
  const vd = parseValidationData(args[0].accountValidationData);
  expect(vd.aggregator).toEqual("0x0000000000000000000000000000000000000001");
});

// ---- simulateHandleOp ABI encoding test ----

it("simulateHandleOp ABI - can encode function data", () => {
  const packed = {
    sender: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
    nonce: 0n,
    initCode: "0x" as `0x${string}`,
    callData: "0xdeadbeef" as `0x${string}`,
    accountGasLimits: ("0x" + "00".repeat(32)) as `0x${string}`,
    preVerificationGas: 60_000n,
    gasFees: ("0x" + "00".repeat(32)) as `0x${string}`,
    paymasterAndData: "0x" as `0x${string}`,
    signature: "0xaabb" as `0x${string}`,
  };
  const calldata = encodeFunctionData({
    abi: ENTRYPOINT_V07_ABI,
    functionName: "simulateHandleOp",
    args: [
      packed,
      "0x0000000000000000000000000000000000000000",
      "0x",
    ],
  });
  expect(calldata.startsWith("0x")).toBeTruthy();
  expect(calldata.length > 10).toBeTruthy(); // Has data beyond the selector
});

it("simulateHandleOp ABI - outputs include targetSuccess field", () => {
  // Verify the ABI has outputs defined (we fixed this)
  const simulateHandleOp = ENTRYPOINT_V07_ABI.find(
    (entry) => entry.type === "function" && entry.name === "simulateHandleOp",
  );
  expect(simulateHandleOp).toBeTruthy();
  expect("outputs" in simulateHandleOp).toBeTruthy();
  const outputs = (simulateHandleOp as unknown as { outputs: readonly unknown[] }).outputs;
  expect(outputs.length > 0, "simulateHandleOp should have outputs defined").toBeTruthy();
  // The output is a tuple with targetSuccess
  const outputTuple = outputs[0] as { components: { name: string }[] };
  const fieldNames = outputTuple.components.map((c) => c.name);
  expect(fieldNames.includes("targetSuccess"), "outputs must include targetSuccess").toBeTruthy();
  expect(fieldNames.includes("targetResult"), "outputs must include targetResult").toBeTruthy();
  expect(fieldNames.includes("paid"), "outputs must include paid").toBeTruthy();
});

// ---- isExecutionRevertError: provider/transport vs. genuine revert ----

it("isExecutionRevertError - dRPC 'can't route' (code 12) is transient, not a revert", () => {
  // The exact Gnosis production failure: dRPC couldn't route the state-override eth_call.
  expect(!isExecutionRevertError({
    code: 12,
    message: "Can't route your request to suitable provider, if you specified certain providers revise the list",
  })).toBeTruthy();
});

it("isExecutionRevertError - rate limit / capacity errors are transient", () => {
  expect(!isExecutionRevertError({ code: -32005, message: "rate limit exceeded" })).toBeTruthy();
  expect(!isExecutionRevertError({ code: -32000, message: "exceeded capacity, try again" })).toBeTruthy();
  expect(!isExecutionRevertError({ message: "429 Too Many Requests" })).toBeTruthy();
});

it("isExecutionRevertError - unsupported method / state override is transient", () => {
  expect(!isExecutionRevertError({ code: -32601, message: "the method eth_call is not supported" })).toBeTruthy();
  expect(!isExecutionRevertError({ message: "missing trie node" })).toBeTruthy();
  expect(!isExecutionRevertError({ message: "header not found" })).toBeTruthy();
});

it("isExecutionRevertError - genuine execution revert IS definitive", () => {
  expect(isExecutionRevertError({ code: 3, message: "execution reverted" })).toBeTruthy();
  expect(isExecutionRevertError({ message: "execution reverted: AA24 signature error" })).toBeTruthy();
  expect(isExecutionRevertError({ message: "err: intrinsic gas too low; out of gas" })).toBeTruthy();
});

it("isExecutionRevertError - genuine revert whose text contains a transient word is still definitive", () => {
  // Ordering guard: the definitive AAxx/'reverted' signal must win over broad transient
  // keywords, so a real rejection is never mis-flagged retryable.
  expect(isExecutionRevertError({ message: "AA23 reverted: paymaster temporarily unavailable" })).toBeTruthy();
  expect(isExecutionRevertError({ message: "execution reverted: rate limit on target contract" })).toBeTruthy();
});

it("isExecutionRevertError - empty / unknown no-data error defaults to transient", () => {
  expect(!isExecutionRevertError(undefined)).toBeTruthy();
  expect(!isExecutionRevertError(null)).toBeTruthy();
  expect(!isExecutionRevertError({ message: "" })).toBeTruthy();
  expect(!isExecutionRevertError({ code: 99, message: "something weird happened" })).toBeTruthy();
});

// ---- RPC selection policy: prefer Alchemy, custom-override wins, no dRPC fallthrough ----

const ALCHEMY_GNOSIS = "https://gnosis-mainnet.g.alchemy.com/v2/testkey";
const PUBLICNODE = "https://gnosis-rpc.publicnode.com";
const GNOSIS_PUBLIC = [
  PUBLICNODE,
  "https://gnosis.drpc.org",
  "https://gnosis.oat.farm",
  "https://rpc.gnosischain.com",
];

/** Minimal config for buildSimulationRpcList (reads only rpcUrl + publicRpcs). */
function cfg(rpcUrl: string, publicRpcs: string[]): BundlerConfig {
  return { rpcUrl, publicRpcs } as unknown as BundlerConfig;
}

it("isManagedRpcUrl - detects Alchemy, rejects public/dRPC", () => {
  expect(isManagedRpcUrl(ALCHEMY_GNOSIS)).toBeTruthy();
  expect(isManagedRpcUrl("https://eth-mainnet.g.alchemy.com/v2/x")).toBeTruthy();
  expect(!isManagedRpcUrl("https://gnosis.drpc.org")).toBeTruthy();
  expect(!isManagedRpcUrl("https://rpc.gnosischain.com")).toBeTruthy();
  expect(!isManagedRpcUrl(undefined)).toBeTruthy();
  expect(!isManagedRpcUrl("not a url")).toBeTruthy();
});

it("buildSimulationRpcList - Alchemy primary → NO public fallthrough (dRPC excluded)", () => {
  const list = buildSimulationRpcList(cfg(ALCHEMY_GNOSIS, GNOSIS_PUBLIC));
  expect(list).toEqual([ALCHEMY_GNOSIS]);
  expect(!list.some((u) => u.includes("drpc.org")), "dRPC must never be in the Alchemy list").toBeTruthy();
});

it("buildSimulationRpcList - client X-Rpc-Url wins, Alchemy backs it, still no public", () => {
  const custom = "https://my-own-node.example/rpc";
  const list = buildSimulationRpcList(cfg(ALCHEMY_GNOSIS, GNOSIS_PUBLIC), custom);
  expect(list).toEqual([custom, ALCHEMY_GNOSIS]);
  expect(!list.some((u) => u.includes("drpc.org"))).toBeTruthy();
});

it("buildSimulationRpcList - no Alchemy (public primary) → keeps capped public fallback", () => {
  // Chain with no Alchemy support: primary is a public node, fallbacks retained for resilience.
  const list = buildSimulationRpcList(cfg(PUBLICNODE, GNOSIS_PUBLIC));
  expect(list[0]).toEqual(PUBLICNODE);
  expect(list.length > 1, "public-only chains still get fallbacks").toBeTruthy();
  expect(list.length <= 1 + 2, "public fallbacks are capped at MAX_PUBLIC_FALLBACKS").toBeTruthy();
});

it("buildSimulationRpcList - custom Alchemy override also suppresses public fallthrough", () => {
  const customAlchemy = "https://gnosis-mainnet.g.alchemy.com/v2/otherkey";
  const list = buildSimulationRpcList(cfg(PUBLICNODE, GNOSIS_PUBLIC), customAlchemy);
  expect(list).toEqual([customAlchemy, PUBLICNODE]);
});

// ---- RPC error codes ----

it("RPC_ERROR_CODES - has all required ERC-4337 error codes", () => {
  expect(RPC_ERROR_CODES.INVALID_USEROPERATION).toEqual(-32602);
  expect(RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED).toEqual(-32500);
  expect(RPC_ERROR_CODES.PAYMASTER_REJECTED).toEqual(-32501);
  expect(RPC_ERROR_CODES.OPCODE_VIOLATION).toEqual(-32502);
  expect(RPC_ERROR_CODES.OUT_OF_TIME_RANGE).toEqual(-32503);
  expect(RPC_ERROR_CODES.THROTTLED_OR_BANNED).toEqual(-32504);
  expect(RPC_ERROR_CODES.STAKE_TOO_LOW).toEqual(-32505);
  expect(RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED).toEqual(-32507);
  expect(RPC_ERROR_CODES.PAYMASTER_BALANCE_INSUFFICIENT).toEqual(-32508);
});
