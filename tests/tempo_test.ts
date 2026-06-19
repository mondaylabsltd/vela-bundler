import { assertEquals } from "@std/assert";
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

const transfer = (to: Hex, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] });

Deno.test("isTempoChain", () => {
  assertEquals(isTempoChain(4217), true);
  assertEquals(isTempoChain(42431), true);
  assertEquals(isTempoChain(1), false);
  assertEquals(isTempoChain(137), false);
});

Deno.test("resolveFeeToken falls back to pathUSD, checksums input", () => {
  assertEquals(resolveFeeToken(null), getAddress(TEMPO_DEFAULT_FEE_TOKEN));
  assertEquals(resolveFeeToken(undefined), getAddress(TEMPO_DEFAULT_FEE_TOKEN));
  assertEquals(
    resolveFeeToken("0x20c0000000000000000000000000000000000001"),
    getAddress("0x20c0000000000000000000000000000000000001"),
  );
});

Deno.test("tempoCostInFeeToken: 50k gas @ 20e9 atto = 1000 fee-token units ($0.001)", () => {
  assertEquals(tempoCostInFeeToken(50_000n, 20_000_000_000n), 1000n);
  // falls back to base fee when price is 0
  assertEquals(tempoCostInFeeToken(50_000n, 0n), 1000n);
});

const PATHUSD = getAddress("0x20c0000000000000000000000000000000000000");

Deno.test("parseTempoReimbursement decodes the transfer that pays the bundler EOA in the feeToken", () => {
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  const recipient = getAddress("0x6007462A7A3409DD8E23EED2C81Cb439cD95F4d4");
  const callData = buildBatch([
    { to: PATHUSD, data: transfer(recipient, 10_000n) }, // the user's actual send
    { to: PATHUSD, data: transfer(eoa, 1234n) }, // the gas reimbursement (feeToken)
  ]);
  assertEquals(parseTempoReimbursement(callData, eoa, PATHUSD), 1234n);
});

Deno.test("parseTempoReimbursement ignores transfers to a NON-EOA recipient", () => {
  const tokenB = getAddress("0x20c0000000000000000000000000000000000002");
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  assertEquals(
    parseTempoReimbursement(buildBatch([{ to: PATHUSD, data: transfer(tokenB, 9999n) }]), eoa, PATHUSD),
    0n,
  );
});

Deno.test("parseTempoReimbursement SECURITY: ignores reimbursement paid in a non-feeToken (anti fake-token drain)", () => {
  const fakeToken = getAddress("0x20c0000000000000000000000000000000000002"); // attacker's worthless token
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  // A transfer to the EOA, but NOT in the trusted feeToken → must NOT count.
  assertEquals(
    parseTempoReimbursement(buildBatch([{ to: fakeToken, data: transfer(eoa, 9_999_999n) }]), eoa, PATHUSD),
    0n,
  );
  // Mixed batch: only the feeToken leg counts; the fake-token leg is ignored.
  const mixed = buildBatch([
    { to: fakeToken, data: transfer(eoa, 9_999_999n) },
    { to: PATHUSD, data: transfer(eoa, 1234n) },
  ]);
  assertEquals(parseTempoReimbursement(mixed, eoa, PATHUSD), 1234n);
});

Deno.test("parseTempoReimbursement matches a LOWERCASE recipient (bundler passes eoa.address lowercased)", () => {
  const eoa = getAddress("0xd2d4245d0444653adefaa8b12eae1a15bda0edac");
  const callData = buildBatch([{ to: PATHUSD, data: transfer(eoa, 1234n) }]);
  // the bundler passes eoa.address LOWERCASE — must still find the reimbursement
  assertEquals(parseTempoReimbursement(callData, eoa.toLowerCase() as `0x${string}`, PATHUSD), 1234n);
});

Deno.test("parseTempoReimbursement returns 0 for non-batch callData (no crash)", () => {
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  assertEquals(parseTempoReimbursement("0xdeadbeef", eoa, PATHUSD), 0n);
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

Deno.test("tempoHandleOpsGasLimit: covers a deployed op's declared limits + overhead", () => {
  // Real deployed-Safe shape from the production trace: vGL≈300k, cGL=760k, pVG≈121k.
  const op = mkOp(300_000n, 760_000n, 121_000n);
  const declared = 300_000n + 760_000n + 121_000n;
  const expected = (declared * 64n) / 63n + 50_000n + 60_000n;
  assertEquals(tempoHandleOpsGasLimit([op]), expected);
  // The bug we fixed: outer gas was BELOW the declared total, starving execution.
  assertEquals(tempoHandleOpsGasLimit([op]) > declared, true);
});

Deno.test("tempoHandleOpsGasLimit: sums every op + scales overhead per op", () => {
  const a = mkOp(300_000n, 400_000n, 100_000n);
  const b = mkOp(6_000_000n, 380_000n, 120_000n);
  const declared = 300_000n + 400_000n + 100_000n + 6_000_000n + 380_000n + 120_000n;
  const expected = (declared * 64n) / 63n + 2n * 50_000n + 60_000n;
  assertEquals(tempoHandleOpsGasLimit([a, b]), expected);
});
