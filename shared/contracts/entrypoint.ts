/**
 * EntryPoint v0.7 ABI and addresses.
 */

export const ENTRYPOINT_V07_ADDRESS =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

// Minimal ABI for EntryPoint v0.7 (IEntryPoint)
export const ENTRYPOINT_V07_ABI = [
  {
    type: "function",
    name: "handleOps",
    inputs: [
      {
        name: "ops",
        type: "tuple[]",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getUserOpHash",
    inputs: [
      {
        name: "userOp",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getNonce",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "deposits",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "deposit", type: "uint256" },
      { name: "staked", type: "bool" },
      { name: "stake", type: "uint112" },
      { name: "unstakeDelaySec", type: "uint32" },
      { name: "withdrawTime", type: "uint48" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDepositInfo",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      {
        name: "info",
        type: "tuple",
        components: [
          { name: "deposit", type: "uint256" },
          { name: "staked", type: "bool" },
          { name: "stake", type: "uint112" },
          { name: "unstakeDelaySec", type: "uint32" },
          { name: "withdrawTime", type: "uint48" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "simulateValidation",
    inputs: [
      {
        name: "userOp",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {
            name: "returnInfo", type: "tuple",
            components: [
              { name: "preOpGas", type: "uint256" },
              { name: "prefund", type: "uint256" },
              { name: "accountValidationData", type: "uint256" },
              { name: "paymasterValidationData", type: "uint256" },
              { name: "paymasterContext", type: "bytes" },
            ],
          },
          {
            name: "senderInfo", type: "tuple",
            components: [
              { name: "stake", type: "uint256" },
              { name: "unstakeDelaySec", type: "uint256" },
            ],
          },
          {
            name: "factoryInfo", type: "tuple",
            components: [
              { name: "stake", type: "uint256" },
              { name: "unstakeDelaySec", type: "uint256" },
            ],
          },
          {
            name: "paymasterInfo", type: "tuple",
            components: [
              { name: "stake", type: "uint256" },
              { name: "unstakeDelaySec", type: "uint256" },
            ],
          },
          {
            name: "aggregatorInfo", type: "tuple",
            components: [
              { name: "aggregator", type: "address" },
              {
                name: "stakeInfo", type: "tuple",
                components: [
                  { name: "stake", type: "uint256" },
                  { name: "unstakeDelaySec", type: "uint256" },
                ],
              },
            ],
          },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "simulateHandleOp",
    inputs: [
      {
        name: "op",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "target", type: "address" },
      { name: "targetCallData", type: "bytes" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "preOpGas", type: "uint256" },
          { name: "paid", type: "uint256" },
          { name: "accountValidationData", type: "uint256" },
          { name: "paymasterValidationData", type: "uint256" },
          { name: "targetSuccess", type: "bool" },
          { name: "targetResult", type: "bytes" },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  // Events
  {
    type: "event",
    name: "UserOperationEvent",
    inputs: [
      { name: "userOpHash", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "paymaster", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "success", type: "bool", indexed: false },
      { name: "actualGasCost", type: "uint256", indexed: false },
      { name: "actualGasUsed", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UserOperationRevertReason",
    inputs: [
      { name: "userOpHash", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "revertReason", type: "bytes", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UserOperationPrefundTooLow",
    inputs: [
      { name: "userOpHash", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AccountDeployed",
    inputs: [
      { name: "userOpHash", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "factory", type: "address", indexed: false },
      { name: "paymaster", type: "address", indexed: false },
    ],
  },
  // Error types returned by simulateValidation
  {
    type: "error",
    name: "ValidationResult",
    inputs: [
      {
        name: "returnInfo",
        type: "tuple",
        components: [
          { name: "preOpGas", type: "uint256" },
          { name: "prefund", type: "uint256" },
          { name: "accountValidationData", type: "uint256" },
          { name: "paymasterValidationData", type: "uint256" },
          { name: "paymasterContext", type: "bytes" },
        ],
      },
      {
        name: "senderInfo",
        type: "tuple",
        components: [
          { name: "stake", type: "uint256" },
          { name: "unstakeDelaySec", type: "uint256" },
        ],
      },
      {
        name: "factoryInfo",
        type: "tuple",
        components: [
          { name: "stake", type: "uint256" },
          { name: "unstakeDelaySec", type: "uint256" },
        ],
      },
      {
        name: "paymasterInfo",
        type: "tuple",
        components: [
          { name: "stake", type: "uint256" },
          { name: "unstakeDelaySec", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "error",
    name: "ValidationResultWithAggregation",
    inputs: [
      {
        name: "returnInfo",
        type: "tuple",
        components: [
          { name: "preOpGas", type: "uint256" },
          { name: "prefund", type: "uint256" },
          { name: "accountValidationData", type: "uint256" },
          { name: "paymasterValidationData", type: "uint256" },
          { name: "paymasterContext", type: "bytes" },
        ],
      },
      {
        name: "senderInfo",
        type: "tuple",
        components: [
          { name: "stake", type: "uint256" },
          { name: "unstakeDelaySec", type: "uint256" },
        ],
      },
      {
        name: "factoryInfo",
        type: "tuple",
        components: [
          { name: "stake", type: "uint256" },
          { name: "unstakeDelaySec", type: "uint256" },
        ],
      },
      {
        name: "paymasterInfo",
        type: "tuple",
        components: [
          { name: "stake", type: "uint256" },
          { name: "unstakeDelaySec", type: "uint256" },
        ],
      },
      {
        name: "aggregatorInfo",
        type: "tuple",
        components: [
          { name: "aggregator", type: "address" },
          { name: "stakeInfo",
            type: "tuple",
            components: [
              { name: "stake", type: "uint256" },
              { name: "unstakeDelaySec", type: "uint256" },
            ],
          },
        ],
      },
    ],
  },
  {
    type: "error",
    name: "FailedOp",
    inputs: [
      { name: "opIndex", type: "uint256" },
      { name: "reason", type: "string" },
    ],
  },
  {
    type: "error",
    name: "FailedOpWithRevert",
    inputs: [
      { name: "opIndex", type: "uint256" },
      { name: "reason", type: "string" },
      { name: "inner", type: "bytes" },
    ],
  },
  {
    type: "error",
    name: "ExecutionResult",
    inputs: [
      { name: "preOpGas", type: "uint256" },
      { name: "paid", type: "uint256" },
      { name: "accountValidationData", type: "uint256" },
      { name: "paymasterValidationData", type: "uint256" },
      { name: "targetSuccess", type: "bool" },
      { name: "targetResult", type: "bytes" },
    ],
  },
] as const;

export const SIG_SIZE = 65;
export const DUMMY_SIGNATURE =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c" as `0x${string}`;

/**
 * EntryPointSimulations deployed bytecode for v0.7.
 * Used via eth_call stateOverride to inject simulateValidation into EntryPoint.
 * Compiled from: eth-infinitism/account-abstraction v0.7 EntryPointSimulations.sol
 *
 * Inlined from EntryPointSimulations_v07_bytecode.txt via generate-bytecode script.
 */
export { ENTRY_POINT_SIMULATIONS_BYTECODE } from "./entrypoint-bytecode.ts";

/**
 * Known constants for EntryPoint v0.7.
 */
export const MAX_VERIFICATION_GAS = 5_000_000n;
export const PRE_VERIFICATION_OVERHEAD_GAS = 50_000n;
export const TRANSACTION_BASE_COST = 21_000n;

/**
 * ERC-7769 / ERC-4337 bundler RPC error codes.
 */
export const RPC_ERROR_CODES = {
  INVALID_USEROPERATION: -32602,
  ENTRYPOINT_SIMULATION_REJECTED: -32500,
  PAYMASTER_REJECTED: -32501,
  OPCODE_VIOLATION: -32502,
  OUT_OF_TIME_RANGE: -32503,
  THROTTLED_OR_BANNED: -32504,
  STAKE_TOO_LOW: -32505,
  SIGNATURE_VALIDATION_FAILED: -32507,
  PAYMASTER_BALANCE_INSUFFICIENT: -32508,
  /**
   * Transient infrastructure degradation (RPC down/slow, deadline exceeded, circuit
   * open). Distinct from the business rejections above so clients can RETRY rather than
   * treat the UserOp as invalid. Carried in the JSON-RPC standard "server error" range.
   * The error `data` carries `{ retryable: true, retryAfterMs? }`.
   */
  SERVICE_DEGRADED: -32000,
} as const;
