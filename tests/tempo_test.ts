import { it, expect } from "vitest";
import {
  concat,
  encodeFunctionData,
  encodePacked,
  getAddress,
  parseAbi,
  type Hex,
} from "viem";
import {
  isTempoChain,
  parseTempoReimbursement,
  parseInBandReimbursement,
  TRUSTED_MULTISEND,
  resolveFeeToken,
  tempoCostInFeeToken,
  tempoHandleOpsGasLimit,
  TEMPO_DEFAULT_FEE_TOKEN,
} from "../shared/tempo.ts";
import type { PackedUserOperation } from "../shared/userop/types.ts";

const erc20 = parseAbi(["function transfer(address to, uint256 amount)"]);
const multiSend = parseAbi(["function multiSend(bytes transactions)"]);
const execUserOp = parseAbi([
  "function executeUserOp(address to, uint256 value, bytes data, uint8 operation)",
]);
const MULTI_SEND = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526" as const;

/** Reproduce the wallet's Tempo batch encoding: executeUserOp → multiSend([CALLs]). */
function packTx(to: Hex, data: Hex): Hex {
  const len = BigInt((data.length - 2) / 2);
  return encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [0, to, 0n, len, data],
  );
}
function buildBatch(calls: { to: Hex; data: Hex }[]): Hex {
  const packed = concat(calls.map((c) => packTx(c.to, c.data)));
  const msData = encodeFunctionData({
    abi: multiSend,
    functionName: "multiSend",
    args: [packed],
  });
  return encodeFunctionData({
    abi: execUserOp,
    functionName: "executeUserOp",
    args: [MULTI_SEND, 0n, msData, 1],
  });
}

/** Pack a MultiSend leg with an explicit operation byte (0 = CALL, 1 = DELEGATECALL). */
function packTxOp(to: Hex, data: Hex, operation: number): Hex {
  const len = BigInt((data.length - 2) / 2);
  return encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [operation, to, 0n, len, data],
  );
}
function buildBatchOps(calls: { to: Hex; data: Hex; operation: number }[]): Hex {
  const packed = concat(calls.map((c) => packTxOp(c.to, c.data, c.operation)));
  const msData = encodeFunctionData({ abi: multiSend, functionName: "multiSend", args: [packed] });
  return encodeFunctionData({ abi: execUserOp, functionName: "executeUserOp", args: [MULTI_SEND, 0n, msData, 1] });
}

const transfer = (to: Hex, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] });

it("isTempoChain", () => {
  expect(isTempoChain(4217)).toEqual(true);
  expect(isTempoChain(42431)).toEqual(true);
  expect(isTempoChain(1)).toEqual(false);
  expect(isTempoChain(137)).toEqual(false);
});

it("resolveFeeToken falls back to pathUSD, checksums input", () => {
  expect(resolveFeeToken(null)).toEqual(getAddress(TEMPO_DEFAULT_FEE_TOKEN));
  expect(resolveFeeToken(undefined)).toEqual(getAddress(TEMPO_DEFAULT_FEE_TOKEN));
  expect(
    resolveFeeToken("0x20c0000000000000000000000000000000000001"),
  ).toEqual(
    getAddress("0x20c0000000000000000000000000000000000001"),
  );
});

it("tempoCostInFeeToken: 50k gas @ 20e9 atto = 1000 fee-token units ($0.001)", () => {
  expect(tempoCostInFeeToken(50_000n, 20_000_000_000n)).toEqual(1000n);
  // falls back to base fee when price is 0
  expect(tempoCostInFeeToken(50_000n, 0n)).toEqual(1000n);
});

const PATHUSD = getAddress("0x20c0000000000000000000000000000000000000");

it("parseTempoReimbursement decodes the transfer that pays the bundler EOA in the feeToken", () => {
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  const recipient = getAddress("0x6007462A7A3409DD8E23EED2C81Cb439cD95F4d4");
  const callData = buildBatch([
    { to: PATHUSD, data: transfer(recipient, 10_000n) }, // the user's actual send
    { to: PATHUSD, data: transfer(eoa, 1234n) }, // the gas reimbursement (feeToken)
  ]);
  expect(parseTempoReimbursement(callData, eoa, PATHUSD)).toEqual(1234n);
});

it("parseTempoReimbursement ignores transfers to a NON-EOA recipient", () => {
  const tokenB = getAddress("0x20c0000000000000000000000000000000000002");
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  expect(
    parseTempoReimbursement(buildBatch([{ to: PATHUSD, data: transfer(tokenB, 9999n) }]), eoa, PATHUSD),
  ).toEqual(
    0n,
  );
});

it("parseTempoReimbursement SECURITY: ignores reimbursement paid in a non-feeToken (anti fake-token drain)", () => {
  const fakeToken = getAddress("0x20c0000000000000000000000000000000000002"); // attacker's worthless token
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  // A transfer to the EOA, but NOT in the trusted feeToken → must NOT count.
  expect(
    parseTempoReimbursement(buildBatch([{ to: fakeToken, data: transfer(eoa, 9_999_999n) }]), eoa, PATHUSD),
  ).toEqual(
    0n,
  );
  // Mixed batch: only the feeToken leg counts; the fake-token leg is ignored.
  const mixed = buildBatch([
    { to: fakeToken, data: transfer(eoa, 9_999_999n) },
    { to: PATHUSD, data: transfer(eoa, 1234n) },
  ]);
  expect(parseTempoReimbursement(mixed, eoa, PATHUSD)).toEqual(1234n);
});

it("parseTempoReimbursement matches a LOWERCASE recipient (bundler passes eoa.address lowercased)", () => {
  const eoa = getAddress("0xd2d4245d0444653adefaa8b12eae1a15bda0edac");
  const callData = buildBatch([{ to: PATHUSD, data: transfer(eoa, 1234n) }]);
  // the bundler passes eoa.address LOWERCASE — must still find the reimbursement
  expect(parseTempoReimbursement(callData, eoa.toLowerCase() as `0x${string}`, PATHUSD)).toEqual(1234n);
});

it("parseTempoReimbursement returns 0 for non-batch callData (no crash)", () => {
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  expect(parseTempoReimbursement("0xdeadbeef", eoa, PATHUSD)).toEqual(0n);
});

// ---------------------------------------------------------------------------
// parseInBandReimbursement — the generalized (native + allowlisted-stablecoin) decoder.
// ---------------------------------------------------------------------------

/** Pack a MultiSend leg with explicit value + operation (the base helpers force value=0/op=0). */
function packTxFull(to: Hex, value: bigint, data: Hex, operation: number): Hex {
  const len = BigInt((data.length - 2) / 2);
  return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [operation, to, value, len, data]);
}
function buildBatchFull(calls: { to: Hex; value?: bigint; data?: Hex; operation?: number }[]): Hex {
  const packed = concat(calls.map((c) => packTxFull(c.to, c.value ?? 0n, c.data ?? "0x", c.operation ?? 0)));
  const msData = encodeFunctionData({ abi: multiSend, functionName: "multiSend", args: [packed] });
  return encodeFunctionData({ abi: execUserOp, functionName: "executeUserOp", args: [MULTI_SEND, 0n, msData, 1] });
}

const EOA = getAddress("0x1111111111111111111111111111111111111111");
const USDC = getAddress("0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48");
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");

it("parseInBandReimbursement counts native value sent to the EOA", () => {
  const r = parseInBandReimbursement(buildBatchFull([{ to: EOA, value: 5000n }]), EOA, [USDC]);
  expect(r.native).toEqual(5000n);
  expect(r.byToken).toEqual({});
});

it("parseInBandReimbursement counts an allowlisted stablecoin transfer to the EOA", () => {
  const r = parseInBandReimbursement(buildBatchFull([{ to: USDC, data: transfer(EOA, 12345n) }]), EOA, [USDC, USDT]);
  expect(r.byToken[USDC.toLowerCase()]).toEqual(12345n);
  expect(r.native).toEqual(0n);
});

it("parseInBandReimbursement SECURITY: ignores a NON-allowlisted token (anti fake-token drain)", () => {
  const fake = getAddress("0x000000000000000000000000000000000000dEaD");
  const r = parseInBandReimbursement(buildBatchFull([{ to: fake, data: transfer(EOA, 9_999_999n) }]), EOA, [USDC]);
  expect(r).toEqual({ native: 0n, byToken: {} });
});

it("parseInBandReimbursement SECURITY: ignores DELEGATECALL legs (move nothing to the EOA)", () => {
  const r = parseInBandReimbursement(
    buildBatchFull([
      { to: USDC, data: transfer(EOA, 5000n), operation: 1 },
      { to: EOA, value: 5000n, operation: 1 },
    ]),
    EOA,
    [USDC],
  );
  expect(r).toEqual({ native: 0n, byToken: {} });
});

it("parseInBandReimbursement splits native + stablecoin and ignores the user's own send", () => {
  const other = getAddress("0x2222222222222222222222222222222222222222");
  const r = parseInBandReimbursement(
    buildBatchFull([
      { to: USDC, data: transfer(other, 50_000n) }, // user's actual send — not to the EOA
      { to: USDC, data: transfer(EOA, 700n) }, // stablecoin gas reimbursement
      { to: EOA, value: 300n }, // native gas reimbursement
    ]),
    EOA,
    [USDC],
  );
  expect(r.native).toEqual(300n);
  expect(r.byToken[USDC.toLowerCase()]).toEqual(700n);
});

// Build executeUserOp with an EXPLICIT outer target + operation (to test the phantom-batch guard).
function buildExecCustom(
  outerTo: Hex,
  outerOp: number,
  legs: { to: Hex; value?: bigint; data?: Hex; operation?: number }[],
): Hex {
  const packed = concat(legs.map((c) => packTxFull(c.to, c.value ?? 0n, c.data ?? "0x", c.operation ?? 0)));
  const msData = encodeFunctionData({ abi: multiSend, functionName: "multiSend", args: [packed] });
  return encodeFunctionData({ abi: execUserOp, functionName: "executeUserOp", args: [outerTo, 0n, msData, outerOp] });
}
const CODELESS = "0x000000000000000000000000000000000000dEaD" as Hex;

it("SECURITY: rejects a phantom CALL batch — not delegatecalling MultiSend (the drain fix)", () => {
  // executeUserOp(to=code-less, op=CALL): on-chain this moves NOTHING, so a batch-shaped `data`
  // must NOT be credited as a reimbursement (would let a zero-balance op drain the bundler).
  const cd = buildExecCustom(CODELESS, 0, [{ to: EOA, value: 5000n }, { to: USDC, data: transfer(EOA, 9000n) }]);
  expect(parseInBandReimbursement(cd, EOA, [USDC])).toEqual({ native: 0n, byToken: {} });
  // Same guard protects the live Tempo path.
  const cdTempo = buildExecCustom(CODELESS, 0, [{ to: PATHUSD, data: transfer(EOA, 9999n) }]);
  expect(parseTempoReimbursement(cdTempo, EOA, PATHUSD)).toEqual(0n);
});

it("SECURITY: rejects delegatecall to a NON-MultiSend target", () => {
  const cd = buildExecCustom(CODELESS, 1, [{ to: EOA, value: 5000n }]);
  expect(parseInBandReimbursement(cd, EOA, [USDC])).toEqual({ native: 0n, byToken: {} });
});

it("SECURITY: rejects a CALL (op=0) even to the real MultiSend", () => {
  const cd = buildExecCustom(TRUSTED_MULTISEND, 0, [{ to: EOA, value: 5000n }]);
  expect(parseInBandReimbursement(cd, EOA, [USDC])).toEqual({ native: 0n, byToken: {} });
});

it("credits a proper DELEGATECALL to the trusted MultiSend", () => {
  const cd = buildExecCustom(TRUSTED_MULTISEND, 1, [{ to: EOA, value: 5000n }]);
  expect(parseInBandReimbursement(cd, EOA, [USDC]).native).toEqual(5000n);
});

it("parseInBandReimbursement matches a LOWERCASE recipient", () => {
  const r = parseInBandReimbursement(
    buildBatchFull([{ to: EOA, value: 42n }, { to: USDC, data: transfer(EOA, 8n) }]),
    EOA.toLowerCase() as `0x${string}`,
    [USDC],
  );
  expect(r.native).toEqual(42n);
  expect(r.byToken[USDC.toLowerCase()]).toEqual(8n);
});

it("parseTempoReimbursement SECURITY: ignores a DELEGATECALL leg (anti no-op-reimbursement drain)", () => {
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  // A DELEGATECALL (operation=1) to the feeToken with transfer(EOA, amt) calldata runs the
  // token's code against the SAFE's storage — it does NOT move any feeToken to the bundler —
  // yet its face value would be counted as reimbursement if the operation byte were ignored.
  const delegatecallOnly = buildBatchOps([
    { to: PATHUSD, data: transfer(eoa, 9_999_999n), operation: 1 },
  ]);
  expect(parseTempoReimbursement(delegatecallOnly, eoa, PATHUSD)).toEqual(0n);

  // Mixed batch: only the real CALL leg counts; the delegatecall leg is ignored.
  const mixed = buildBatchOps([
    { to: PATHUSD, data: transfer(eoa, 9_999_999n), operation: 1 }, // fake (delegatecall)
    { to: PATHUSD, data: transfer(eoa, 1234n), operation: 0 }, // real (call)
  ]);
  expect(parseTempoReimbursement(mixed, eoa, PATHUSD)).toEqual(1234n);
});

// --- tempoHandleOpsGasLimit: the outer-0x76 gas must cover declared op limits ---

function packGasLimits(vGL: bigint, cGL: bigint): `0x${string}` {
  return ("0x" + vGL.toString(16).padStart(32, "0") + cGL.toString(16).padStart(32, "0")) as `0x${string}`;
}
function mkOp(vGL: bigint, cGL: bigint, pvg: bigint): PackedUserOperation {
  return {
    sender: ("0x" + "11".repeat(20)) as `0x${string}`,
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    accountGasLimits: packGasLimits(vGL, cGL),
    preVerificationGas: pvg,
    gasFees: ("0x" + "00".repeat(32)) as `0x${string}`,
    paymasterAndData: "0x",
    signature: "0x",
  };
}

it("tempoHandleOpsGasLimit: covers a deployed op's declared limits + overhead", () => {
  // Real deployed-Safe shape from the production trace: vGL≈300k, cGL=760k, pVG≈121k.
  const op = mkOp(300_000n, 760_000n, 121_000n);
  const declared = 300_000n + 760_000n + 121_000n;
  const expected = (declared * 64n) / 63n + 50_000n + 60_000n;
  expect(tempoHandleOpsGasLimit([op])).toEqual(expected);
  // The bug we fixed: outer gas was BELOW the declared total, starving execution.
  expect(tempoHandleOpsGasLimit([op]) > declared).toEqual(true);
});

it("tempoHandleOpsGasLimit: sums every op + scales overhead per op", () => {
  const a = mkOp(300_000n, 400_000n, 100_000n);
  const b = mkOp(6_000_000n, 380_000n, 120_000n);
  const declared = 300_000n + 400_000n + 100_000n + 6_000_000n + 380_000n + 120_000n;
  const expected = (declared * 64n) / 63n + 2n * 50_000n + 60_000n;
  expect(tempoHandleOpsGasLimit([a, b])).toEqual(expected);
});
