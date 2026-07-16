/**
 * Manual verification script: query real L2 nodes to test DA fee estimation.
 *
 * Usage:
 *   node --experimental-strip-types scripts/test-l2-fee.ts
 */

import { estimateArbitrumL1Gas, estimateOpStackL1Gas } from "../shared/gas/l2-data-fee.ts";
import { packUserOp } from "../shared/userop/pack.ts";
import { encodeHandleOps } from "../shared/userop/encode.ts";

// Use the REAL UserOp from the user's failed Arbitrum transaction
const realUserOp = {
  sender: "0x14fB1fB21751E29F7Ec48dC450017552E3D1eA5c" as `0x${string}`,
  nonce: 1n,
  factory: null,
  factoryData: null,
  callData: "0x7bb374280000000000000000000000002c1c9470e6a6fc6340c9e24670361fec4c347c230000000000000000000000000000000000000000000000000001af0a24a59a60000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
  callGasLimit: 200_000n,  // 0x30d40
  verificationGasLimit: 300_000n, // 0x493e0
  preVerificationGas: 100_000n, // 0x186a0
  maxFeePerGas: 31_264_512n, // 0x1dc1300
  maxPriorityFeePerGas: 31_264_512n, // 0x1dc1300
  paymaster: null,
  paymasterVerificationGasLimit: null,
  paymasterPostOpGasLimit: null,
  paymasterData: null,
  signature: "0x00000000000000000000000000000000000000000000000094a4f6affbd8975951142c3999aeab7ecee555c200000000000000000000000000000000000000000000000000000000000000410000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e0352d30f9e7663274139f51ddcf92454a6b0efad4b76afce49aa9339a2929530ba6bcb1a3354d7d43a6c5bf2197695f9d1b5d470fbc0a6ea826194f47b0d23f490000000000000000000000000000000000000000000000000000000000000025a69533717b230610f14ea657c0bd8231dd6fc7b7108f1215a874fbb1d14df3491d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bf226f726967696e223a226368726f6d652d657874656e73696f6e3a2f2f6f6e616761616b62656a706a70696768656f656b6e706566666c676c6d6f6965222c2263726f73734f726967696e223a66616c73652c226f746865725f6b6579735f63616e5f62655f61646465645f68657265223a22646f206e6f7420636f6d7061726520636c69656e74446174614a534f4e20616761696e737420612074656d706c6174652e205365652068747470733a2f2f676f6f2e676c2f7961625065782200" as `0x${string}`,
  eip7702Auth: undefined,
};
const packed = packUserOp(realUserOp);
const SAMPLE_CALLDATA = encodeHandleOps([packed], "0x0000000000000000000000000000000000000001");
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;

async function main() {
  console.log("=== L2 Data Fee Estimation Test ===\n");
  console.log(`Sample calldata size: ${(SAMPLE_CALLDATA.length - 2) / 2} bytes\n`);

  // --- Arbitrum One ---
  console.log("--- Arbitrum One (42161) ---");
  const arbRpc = "https://arb1.arbitrum.io/rpc";
  const arbGas = await estimateArbitrumL1Gas(ENTRY_POINT, SAMPLE_CALLDATA, arbRpc);
  console.log(`  L1 gas estimate: ${arbGas} gas units`);
  // Use the real Arbitrum gas price from the failed tx
  const arbGasPrice = 31_264_512n; // 0x1dc1300 from the real UserOp
  const arbL1CostWei = arbGas * arbGasPrice;
  console.log(`  At gasPrice=${arbGasPrice}: L1 cost = ${arbL1CostWei} wei (${Number(arbL1CostWei) / 1e18} ETH)`);
  // Also compute the total UserOp gas to compare
  const totalUserOpGas = 200_000n + 300_000n + 100_000n; // call + verification + pvg
  const totalCostWithoutL1 = totalUserOpGas * arbGasPrice;
  const totalCostWithL1 = (totalUserOpGas + arbGas) * arbGasPrice;
  console.log(`  Without L1 fee: ${totalCostWithoutL1} wei (${Number(totalCostWithoutL1) / 1e18} ETH)`);
  console.log(`  With    L1 fee: ${totalCostWithL1} wei (${Number(totalCostWithL1) / 1e18} ETH)`);
  console.log(`  Server required: 624002400000000 wei (0.000624 ETH)`);
  console.log(`  Ratio required/withL1: ${Number(624002400000000n * 100n / totalCostWithL1)}%\n`);

  // --- Optimism ---
  console.log("--- Optimism (10) ---");
  const opRpc = "https://mainnet.optimism.io";
  // OP Stack needs a gas price to convert wei → gas units
  const opGasPrice = 50_000_000n; // ~0.05 gwei typical for OP
  const opGas = await estimateOpStackL1Gas(SAMPLE_CALLDATA, opGasPrice, opRpc);
  console.log(`  L1 gas estimate: ${opGas} gas units (at gasPrice=${opGasPrice})`);
  console.log(`  L1 fee in wei: ~${opGas * opGasPrice}\n`);

  // --- Base ---
  console.log("--- Base (8453) ---");
  const baseRpc = "https://mainnet.base.org";
  const baseGasPrice = 50_000_000n;
  const baseGas = await estimateOpStackL1Gas(SAMPLE_CALLDATA, baseGasPrice, baseRpc);
  console.log(`  L1 gas estimate: ${baseGas} gas units (at gasPrice=${baseGasPrice})`);
  console.log(`  L1 fee in wei: ~${baseGas * baseGasPrice}\n`);

  // --- Summary ---
  console.log("=== Summary ===");
  console.log(`Arbitrum L1 gas: ${arbGas}`);
  console.log(`Optimism L1 gas: ${opGas}`);
  console.log(`Base     L1 gas: ${baseGas}`);

  if (arbGas === 0n && opGas === 0n && baseGas === 0n) {
    console.error("\n⚠ All estimates returned 0 — check RPC connectivity");
    process.exit(1);
  }

  console.log("\n✓ Estimates are non-zero — oracle calls working");
}

main();
