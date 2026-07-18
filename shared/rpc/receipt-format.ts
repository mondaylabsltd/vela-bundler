/**
 * ERC-7769 receipt / by-hash RPC serialization.
 *
 * The single formatter for a stored UserOperationReceipt into its JSON-RPC response shape,
 * shared by shared/rpc/handlers.ts (the in-DO lookup) AND the CF Worker queue-mode fallback
 * (worker/bundler-do.ts reads a terminal receipt from USEROP_STATUS KV — written by a
 * RelayerDO — and must return it byte-identically to the in-DO path). Kept here so the two
 * sites can never diverge.
 */

import type { UserOperationReceipt } from "../userop/types.ts";

/** eth_getUserOperationReceipt response body for a stored receipt. */
export function receiptToRpc(receipt: UserOperationReceipt): Record<string, unknown> {
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

/** eth_getUserOperationByHash response body derived from a stored (mined) receipt. */
export function receiptToByHashRpc(receipt: UserOperationReceipt): Record<string, unknown> {
  return {
    userOperation: { sender: receipt.sender, nonce: "0x" + receipt.nonce.toString(16) },
    entryPoint: receipt.entryPoint,
    blockNumber: "0x" + receipt.receipt.blockNumber.toString(16),
    blockHash: receipt.receipt.blockHash,
    transactionHash: receipt.receipt.transactionHash,
  };
}
