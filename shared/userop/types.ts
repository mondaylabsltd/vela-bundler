/**
 * ERC-4337 v0.7 UserOperation types.
 */

/**
 * The user-facing UserOperation struct as submitted via RPC.
 */
export interface UserOperation {
  sender: `0x${string}`;
  nonce: bigint;
  factory: `0x${string}` | null;
  factoryData: `0x${string}` | null;
  callData: `0x${string}`;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster: `0x${string}` | null;
  paymasterVerificationGasLimit: bigint | null;
  paymasterPostOpGasLimit: bigint | null;
  paymasterData: `0x${string}` | null;
  signature: `0x${string}`;
  // EIP-7702 authorization list if present
  eip7702Auth?: Eip7702Authorization[];
  /**
   * Tempo only (Vela extension): the USD stablecoin the bundler charges for the outer
   * 0x76 transaction gas. Not part of the PackedUserOperation — see shared/tempo.ts.
   */
  feeToken?: `0x${string}` | null;
}

export interface Eip7702Authorization {
  chainId: bigint;
  address: `0x${string}`;
  nonce: bigint;
  yParity: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

/**
 * PackedUserOperation as consumed by EntryPoint v0.7 handleOps.
 */
export interface PackedUserOperation {
  sender: `0x${string}`;
  nonce: bigint;
  initCode: `0x${string}`;
  callData: `0x${string}`;
  accountGasLimits: `0x${string}`; // bytes32: verificationGasLimit (16) | callGasLimit (16)
  preVerificationGas: bigint;
  gasFees: `0x${string}`; // bytes32: maxPriorityFeePerGas (16) | maxFeePerGas (16)
  paymasterAndData: `0x${string}`;
  signature: `0x${string}`;
}

/**
 * UserOperation receipt stored after inclusion.
 */
export interface UserOperationReceipt {
  userOpHash: `0x${string}`;
  entryPoint: `0x${string}`;
  sender: `0x${string}`;
  nonce: bigint;
  paymaster: `0x${string}` | null;
  actualGasCost: bigint;
  actualGasUsed: bigint;
  success: boolean;
  logs: readonly UserOperationLog[];
  receipt: TransactionReceiptInfo;
}

export interface UserOperationLog {
  logIndex: number;
  address: `0x${string}`;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
}

export interface TransactionReceiptInfo {
  transactionHash: `0x${string}`;
  transactionIndex: number;
  blockHash: `0x${string}`;
  blockNumber: bigint;
  from: `0x${string}`;
  to: `0x${string}`;
  cumulativeGasUsed: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

/**
 * Validation result parsed from simulateValidation revert.
 */
export interface ValidationResultInfo {
  preOpGas: bigint;
  prefund: bigint;
  accountValidationData: bigint;
  paymasterValidationData: bigint;
  paymasterContext: `0x${string}`;
  senderStake: bigint;
  senderUnstakeDelaySec: bigint;
  factoryStake: bigint;
  factoryUnstakeDelaySec: bigint;
  paymasterStake: bigint;
  paymasterUnstakeDelaySec: bigint;
}

/**
 * Parsed validationData fields.
 */
export interface ParsedValidationData {
  aggregator: `0x${string}`;
  validAfter: number;
  validUntil: number;
}

/**
 * Mempool entry wrapping a UserOperation.
 */
export interface MempoolEntry {
  userOp: UserOperation;
  packed: PackedUserOperation;
  userOpHash: `0x${string}`;
  prefund: bigint;
  addedAt: number;
  validationResult?: ValidationResultInfo;
  /** User-provided RPC URL to use for simulation/submission of this op. */
  rpcUrlOverride?: string;
}
