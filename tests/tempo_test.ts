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
  TEMPO_DEFAULT_FEE_TOKEN,
} from "../shared/tempo.ts";

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

Deno.test("parseTempoReimbursement decodes the transfer that pays the bundler EOA", () => {
  const sentToken = getAddress("0x20c0000000000000000000000000000000000001"); // e.g. USDC.e
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  const recipient = getAddress("0x6007462A7A3409DD8E23EED2C81Cb439cD95F4d4");
  const callData = buildBatch([
    { to: sentToken, data: transfer(recipient, 10_000n) }, // the user's actual send
    { to: sentToken, data: transfer(eoa, 1234n) }, // the gas reimbursement (sent token)
  ]);
  assertEquals(parseTempoReimbursement(callData, eoa), 1234n);
});

Deno.test("parseTempoReimbursement counts reimbursement in ANY token, ignores other recipients", () => {
  const tokenA = getAddress("0x20c0000000000000000000000000000000000001");
  const tokenB = getAddress("0x20c0000000000000000000000000000000000002");
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  // reimbursement in a different stablecoin → STILL counted (all ≈ $1)
  assertEquals(
    parseTempoReimbursement(buildBatch([{ to: tokenB, data: transfer(eoa, 9999n) }]), eoa),
    9999n,
  );
  // transfer to a NON-EOA recipient → not counted
  assertEquals(
    parseTempoReimbursement(buildBatch([{ to: tokenA, data: transfer(tokenB, 9999n) }]), eoa),
    0n,
  );
});

Deno.test("parseTempoReimbursement matches a LOWERCASE recipient (bundler passes eoa.address lowercased)", () => {
  const sentToken = getAddress("0x20c0000000000000000000000000000000000001");
  const eoa = getAddress("0xd2d4245d0444653adefaa8b12eae1a15bda0edac");
  const callData = buildBatch([{ to: sentToken, data: transfer(eoa, 1234n) }]);
  // the bundler passes eoa.address LOWERCASE — must still find the reimbursement
  assertEquals(parseTempoReimbursement(callData, eoa.toLowerCase() as `0x${string}`), 1234n);
});

Deno.test("parseTempoReimbursement returns 0 for non-batch callData (no crash)", () => {
  const eoa = getAddress("0x1111111111111111111111111111111111111111");
  assertEquals(parseTempoReimbursement("0xdeadbeef", eoa), 0n);
});
