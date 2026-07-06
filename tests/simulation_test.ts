/**
 * Unit tests for simulation module — validation data checking, execution result parsing,
 * and revert data extraction.
 *
 * These tests cover the pure-logic functions extracted during the P0/P1 refactoring.
 * RPC-dependent simulation (simulateValidation, simulateExecution, simulateBundle)
 * is tested via integration tests with a live Anvil node.
 */

import { assertEquals, assert } from "@std/assert";
import {
  decodeErrorResult,
  encodeErrorResult,
  encodeFunctionResult,
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

Deno.test("parseValidationData - zero data means valid forever, no aggregator", () => {
  const result = parseValidationData(0n);
  assertEquals(result.aggregator, "0x0000000000000000000000000000000000000000");
  assertEquals(result.validAfter, 0);
  assertEquals(result.validUntil, 0xffffffffffff); // 0 means no expiry
});

Deno.test("parseValidationData - sig failure aggregator == address(1)", () => {
  // aggregator = 0x0000...0001 at bits [96..256]
  const sigFail = 1n << 96n;
  const result = parseValidationData(sigFail);
  assertEquals(result.aggregator, "0x0000000000000000000000000000000000000001");
});

Deno.test("parseValidationData - encodes validAfter and validUntil correctly", () => {
  // validUntil = 1700000000 (6 bytes at bits [48..96])
  // validAfter = 1600000000 (6 bytes at bits [0..48])
  const validUntil = 1700000000n;
  const validAfter = 1600000000n;
  const data = (validUntil << 48n) | validAfter;
  const result = parseValidationData(data);
  assertEquals(result.validAfter, 1600000000);
  assertEquals(result.validUntil, 1700000000);
});

Deno.test("parseValidationData - combined aggregator + time range", () => {
  const aggregator = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefn;
  const validUntil = 2000000000n;
  const validAfter = 1000000000n;
  const data = (aggregator << 96n) | (validUntil << 48n) | validAfter;
  const result = parseValidationData(data);
  assertEquals(result.aggregator, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assertEquals(result.validAfter, 1000000000);
  assertEquals(result.validUntil, 2000000000);
});

// ---- isValidTimeRange tests ----

Deno.test("isValidTimeRange - zero validUntil means no expiry", () => {
  assert(isValidTimeRange(0, 0));
});

Deno.test("isValidTimeRange - future validAfter returns false", () => {
  const farFuture = Math.floor(Date.now() / 1000) + 100_000;
  assert(!isValidTimeRange(farFuture, 0));
});

Deno.test("isValidTimeRange - past validUntil returns false (expired)", () => {
  const past = Math.floor(Date.now() / 1000) - 100;
  assert(!isValidTimeRange(0, past));
});

Deno.test("isValidTimeRange - valid range passes", () => {
  const now = Math.floor(Date.now() / 1000);
  assert(isValidTimeRange(now - 100, now + 100));
});

Deno.test("isValidTimeRange - safety margin is respected", () => {
  const now = Math.floor(Date.now() / 1000);
  // validUntil is now + 5 seconds, but with 30s margin it should fail
  assert(!isValidTimeRange(0, now + 5, 30));
  // With 3s margin it should pass
  assert(isValidTimeRange(0, now + 5, 3));
});

// ---- ExecutionResult error encoding/decoding roundtrip ----

Deno.test("ExecutionResult error - can encode and decode targetSuccess=true", () => {
  const encoded = encodeExecutionResultError({ targetSuccess: true, paid: 42n });
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  assertEquals(decoded.errorName, "ExecutionResult");
  const args = decoded.args as unknown as [bigint, bigint, bigint, bigint, boolean, `0x${string}`];
  assertEquals(args[4], true); // targetSuccess
  assertEquals(args[1], 42n); // paid
});

Deno.test("ExecutionResult error - can encode and decode targetSuccess=false", () => {
  const encoded = encodeExecutionResultError({
    targetSuccess: false,
    targetResult: "0xacfdb444", // ExecutionFailed() selector
    paid: 100n,
  });
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  assertEquals(decoded.errorName, "ExecutionResult");
  const args = decoded.args as unknown as [bigint, bigint, bigint, bigint, boolean, `0x${string}`];
  assertEquals(args[4], false); // targetSuccess
  assert(args[5].startsWith("0xacfdb444"));
});

// ---- FailedOp error encoding/decoding roundtrip ----

Deno.test("FailedOp error - roundtrip encoding and decoding", () => {
  const encoded = encodeFailedOp(0n, "AA21 didn't pay prefund");
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  assertEquals(decoded.errorName, "FailedOp");
  const [opIndex, reason] = decoded.args as unknown as [bigint, string];
  assertEquals(opIndex, 0n);
  assertEquals(reason, "AA21 didn't pay prefund");
});

Deno.test("FailedOpWithRevert error - roundtrip encoding and decoding", () => {
  const encoded = encodeFailedOpWithRevert(1n, "AA23 reverted", "0xdeadbeef");
  const decoded = decodeErrorResult({
    abi: ENTRYPOINT_V07_ABI,
    data: encoded,
  });
  assertEquals(decoded.errorName, "FailedOpWithRevert");
  const [opIndex, reason, inner] = decoded.args as unknown as [bigint, string, `0x${string}`];
  assertEquals(opIndex, 1n);
  assertEquals(reason, "AA23 reverted");
  assert(inner.startsWith("0xdeadbeef"));
});

// ---- ValidationResult error encoding/decoding roundtrip ----

Deno.test("ValidationResult error - roundtrip with valid data", () => {
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
  assertEquals(decoded.errorName, "ValidationResult");
});

Deno.test("ValidationResult error - sig failure aggregator is detectable", () => {
  // accountValidationData with aggregator=0x01 (sig fail)
  const sigFail = 1n << 96n;
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
  assertEquals(vd.aggregator, "0x0000000000000000000000000000000000000001");
});

// ---- simulateHandleOp ABI encoding test ----

Deno.test("simulateHandleOp ABI - can encode function data", () => {
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
  assert(calldata.startsWith("0x"));
  assert(calldata.length > 10); // Has data beyond the selector
});

Deno.test("simulateHandleOp ABI - outputs include targetSuccess field", () => {
  // Verify the ABI has outputs defined (we fixed this)
  const simulateHandleOp = ENTRYPOINT_V07_ABI.find(
    (entry) => entry.type === "function" && entry.name === "simulateHandleOp",
  );
  assert(simulateHandleOp);
  assert("outputs" in simulateHandleOp);
  const outputs = (simulateHandleOp as unknown as { outputs: readonly unknown[] }).outputs;
  assert(outputs.length > 0, "simulateHandleOp should have outputs defined");
  // The output is a tuple with targetSuccess
  const outputTuple = outputs[0] as { components: { name: string }[] };
  const fieldNames = outputTuple.components.map((c) => c.name);
  assert(fieldNames.includes("targetSuccess"), "outputs must include targetSuccess");
  assert(fieldNames.includes("targetResult"), "outputs must include targetResult");
  assert(fieldNames.includes("paid"), "outputs must include paid");
});

// ---- isExecutionRevertError: provider/transport vs. genuine revert ----

Deno.test("isExecutionRevertError - dRPC 'can't route' (code 12) is transient, not a revert", () => {
  // The exact Gnosis production failure: dRPC couldn't route the state-override eth_call.
  assert(!isExecutionRevertError({
    code: 12,
    message: "Can't route your request to suitable provider, if you specified certain providers revise the list",
  }));
});

Deno.test("isExecutionRevertError - rate limit / capacity errors are transient", () => {
  assert(!isExecutionRevertError({ code: -32005, message: "rate limit exceeded" }));
  assert(!isExecutionRevertError({ code: -32000, message: "exceeded capacity, try again" }));
  assert(!isExecutionRevertError({ message: "429 Too Many Requests" }));
});

Deno.test("isExecutionRevertError - unsupported method / state override is transient", () => {
  assert(!isExecutionRevertError({ code: -32601, message: "the method eth_call is not supported" }));
  assert(!isExecutionRevertError({ message: "missing trie node" }));
  assert(!isExecutionRevertError({ message: "header not found" }));
});

Deno.test("isExecutionRevertError - genuine execution revert IS definitive", () => {
  assert(isExecutionRevertError({ code: 3, message: "execution reverted" }));
  assert(isExecutionRevertError({ message: "execution reverted: AA24 signature error" }));
  assert(isExecutionRevertError({ message: "err: intrinsic gas too low; out of gas" }));
});

Deno.test("isExecutionRevertError - empty / unknown no-data error defaults to transient", () => {
  assert(!isExecutionRevertError(undefined));
  assert(!isExecutionRevertError(null));
  assert(!isExecutionRevertError({ message: "" }));
  assert(!isExecutionRevertError({ code: 99, message: "something weird happened" }));
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

Deno.test("isManagedRpcUrl - detects Alchemy, rejects public/dRPC", () => {
  assert(isManagedRpcUrl(ALCHEMY_GNOSIS));
  assert(isManagedRpcUrl("https://eth-mainnet.g.alchemy.com/v2/x"));
  assert(!isManagedRpcUrl("https://gnosis.drpc.org"));
  assert(!isManagedRpcUrl("https://rpc.gnosischain.com"));
  assert(!isManagedRpcUrl(undefined));
  assert(!isManagedRpcUrl("not a url"));
});

Deno.test("buildSimulationRpcList - Alchemy primary → NO public fallthrough (dRPC excluded)", () => {
  const list = buildSimulationRpcList(cfg(ALCHEMY_GNOSIS, GNOSIS_PUBLIC));
  assertEquals(list, [ALCHEMY_GNOSIS]);
  assert(!list.some((u) => u.includes("drpc.org")), "dRPC must never be in the Alchemy list");
});

Deno.test("buildSimulationRpcList - client X-Rpc-Url wins, Alchemy backs it, still no public", () => {
  const custom = "https://my-own-node.example/rpc";
  const list = buildSimulationRpcList(cfg(ALCHEMY_GNOSIS, GNOSIS_PUBLIC), custom);
  assertEquals(list, [custom, ALCHEMY_GNOSIS]);
  assert(!list.some((u) => u.includes("drpc.org")));
});

Deno.test("buildSimulationRpcList - no Alchemy (public primary) → keeps capped public fallback", () => {
  // Chain with no Alchemy support: primary is a public node, fallbacks retained for resilience.
  const list = buildSimulationRpcList(cfg(PUBLICNODE, GNOSIS_PUBLIC));
  assertEquals(list[0], PUBLICNODE);
  assert(list.length > 1, "public-only chains still get fallbacks");
  assert(list.length <= 1 + 2, "public fallbacks are capped at MAX_PUBLIC_FALLBACKS");
});

Deno.test("buildSimulationRpcList - custom Alchemy override also suppresses public fallthrough", () => {
  const customAlchemy = "https://gnosis-mainnet.g.alchemy.com/v2/otherkey";
  const list = buildSimulationRpcList(cfg(PUBLICNODE, GNOSIS_PUBLIC), customAlchemy);
  assertEquals(list, [customAlchemy, PUBLICNODE]);
});

// ---- RPC error codes ----

Deno.test("RPC_ERROR_CODES - has all required ERC-4337 error codes", () => {
  assertEquals(RPC_ERROR_CODES.INVALID_USEROPERATION, -32602);
  assertEquals(RPC_ERROR_CODES.ENTRYPOINT_SIMULATION_REJECTED, -32500);
  assertEquals(RPC_ERROR_CODES.PAYMASTER_REJECTED, -32501);
  assertEquals(RPC_ERROR_CODES.OPCODE_VIOLATION, -32502);
  assertEquals(RPC_ERROR_CODES.OUT_OF_TIME_RANGE, -32503);
  assertEquals(RPC_ERROR_CODES.THROTTLED_OR_BANNED, -32504);
  assertEquals(RPC_ERROR_CODES.STAKE_TOO_LOW, -32505);
  assertEquals(RPC_ERROR_CODES.SIGNATURE_VALIDATION_FAILED, -32507);
  assertEquals(RPC_ERROR_CODES.PAYMASTER_BALANCE_INSUFFICIENT, -32508);
});
