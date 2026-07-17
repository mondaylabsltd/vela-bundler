/**
 * receiptToRpc / receiptToByHashRpc (shared/rpc/receipt-format.ts).
 *
 * These formatters were extracted from handlers.ts so the in-DO receipt lookup and the CF
 * Worker queue-mode KV fallback (worker/bundler-do.ts, RelayerDO-written receipts) return a
 * byte-identical shape. These tests PIN that exact JSON-RPC shape — every bigint hex-encoded,
 * the nested receipt + logs, the null-paymaster default — so a future edit can't silently
 * drift the wallet-facing response.
 */

import { it, expect } from "vitest";
import { receiptToRpc, receiptToByHashRpc } from "../shared/rpc/receipt-format.ts";
import type { UserOperationReceipt } from "../shared/userop/types.ts";

const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;
const SENDER = ("0x" + "aa".repeat(20)) as `0x${string}`;
const TX = ("0x" + "11".repeat(32)) as `0x${string}`;
const BLOCK = ("0x" + "22".repeat(32)) as `0x${string}`;

function receipt(overrides: Partial<UserOperationReceipt> = {}): UserOperationReceipt {
  return {
    userOpHash: ("0x" + "99".repeat(32)) as `0x${string}`,
    entryPoint: EP,
    sender: SENDER,
    nonce: 42n,
    paymaster: null,
    actualGasCost: 123_456n,
    actualGasUsed: 78_900n,
    success: true,
    logs: [{
      logIndex: 3,
      address: EP,
      topics: [("0x" + "ab".repeat(32)) as `0x${string}`],
      data: "0xdeadbeef",
      blockNumber: 256n,
      blockHash: BLOCK,
      transactionHash: TX,
    }],
    receipt: {
      transactionHash: TX,
      transactionIndex: 1,
      blockHash: BLOCK,
      blockNumber: 256n,
      from: ("0x" + "ee".repeat(20)) as `0x${string}`,
      to: EP,
      cumulativeGasUsed: 500_000n,
      gasUsed: 90_000n,
      effectiveGasPrice: 2_000_000_000n,
    },
    ...overrides,
  };
}

it("receiptToRpc - hex-encodes every bigint and preserves the nested receipt + logs", () => {
  const r = receiptToRpc(receipt());
  expect(r.userOpHash).toEqual("0x" + "99".repeat(32));
  expect(r.entryPoint).toEqual(EP);
  expect(r.sender).toEqual(SENDER);
  expect(r.nonce).toEqual("0x2a"); // 42
  expect(r.actualGasCost).toEqual("0x" + (123_456n).toString(16));
  expect(r.actualGasUsed).toEqual("0x" + (78_900n).toString(16));
  expect(r.success).toEqual(true);

  const logs = r.logs as Array<Record<string, unknown>>;
  expect(logs).toHaveLength(1);
  expect(logs[0]!.logIndex).toEqual("0x3");
  expect(logs[0]!.blockNumber).toEqual("0x100"); // 256
  expect(logs[0]!.data).toEqual("0xdeadbeef");
  expect(logs[0]!.transactionHash).toEqual(TX);

  const inner = r.receipt as Record<string, unknown>;
  expect(inner.transactionHash).toEqual(TX);
  expect(inner.transactionIndex).toEqual("0x1");
  expect(inner.blockNumber).toEqual("0x100");
  expect(inner.cumulativeGasUsed).toEqual("0x" + (500_000n).toString(16));
  expect(inner.gasUsed).toEqual("0x" + (90_000n).toString(16));
  expect(inner.effectiveGasPrice).toEqual("0x" + (2_000_000_000n).toString(16));
});

it("receiptToRpc - a null paymaster becomes the zero address; success=false passes through", () => {
  const r = receiptToRpc(receipt({ paymaster: null, success: false }));
  expect(r.paymaster).toEqual("0x0000000000000000000000000000000000000000");
  expect(r.success).toEqual(false);
});

it("receiptToRpc - a non-null paymaster passes through verbatim", () => {
  const pm = ("0x" + "bc".repeat(20)) as `0x${string}`;
  const r = receiptToRpc(receipt({ paymaster: pm }));
  expect(r.paymaster).toEqual(pm);
});

it("receiptToRpc - zero nonce encodes as 0x0 (not empty)", () => {
  const r = receiptToRpc(receipt({ nonce: 0n }));
  expect(r.nonce).toEqual("0x0");
});

it("receiptToByHashRpc - returns the by-hash shape (userOperation + entryPoint + block/tx)", () => {
  const r = receiptToByHashRpc(receipt());
  expect(r.userOperation).toEqual({ sender: SENDER, nonce: "0x2a" });
  expect(r.entryPoint).toEqual(EP);
  expect(r.blockNumber).toEqual("0x100");
  expect(r.blockHash).toEqual(BLOCK);
  expect(r.transactionHash).toEqual(TX);
});

it("both formatters are pure JSON (no bigint leaks that would break JSON.stringify)", () => {
  // The KV fallback JSON.stringify's these — a leaked bigint would throw at runtime.
  expect(() => JSON.stringify(receiptToRpc(receipt()))).not.toThrow();
  expect(() => JSON.stringify(receiptToByHashRpc(receipt()))).not.toThrow();
});
