/**
 * Tests for RPC method handlers (shared/rpc/handlers.ts).
 *
 * Uses mock ChainServices to test handler dispatch, parameter validation,
 * and receipt/mempool lookup without RPC dependencies.
 */

import { assertEquals, assert, assertRejects } from "@std/assert";
import { handleRpcMethod } from "../shared/rpc/handlers.ts";
import { processRequest } from "../shared/rpc/process.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { ChainRegistryLike, ChainServices } from "../shared/chain/index.ts";
import type { RequestContext } from "../shared/rpc/process.ts";
import type { UserOperationReceipt, MempoolEntry, UserOperation } from "../shared/userop/types.ts";

// --- Mock helpers ---

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

function mockConfig(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: "https://rpc.example.com",
    publicRpcs: [],
    chainInfo: null,
    entryPointAddress: ENTRY_POINT,
    port: 3300,
    host: "0.0.0.0",
    bundlingMode: "auto",
    maxBundleSize: 10,
    maxBundleGas: 5000000n,
    minPriorityFeePerGas: 0n,
    minProfitMarginBps: 1000,
    maxProfitMarginBps: 15000,
    walletGasMarkup: 1.5,
    useEip1559: true,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 0.5,
    autoBundleIntervalMs: 10000,
    operatorSecret: "0x" + "ab".repeat(32),
    oldOperatorSecrets: [],
    treasuryAddress: "0x" + "cc".repeat(20) as `0x${string}`,
    sweepInterval: 30,
    apiRateLimitPerMinute: 60,
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
    ...overrides,
  } as BundlerConfig;
}

function mockReqCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { chainId: 1, ...overrides };
}

function makeFullUserOp(): UserOperation {
  return {
    sender: "0x" + "33".repeat(20) as `0x${string}`,
    nonce: 1n,
    factory: null,
    factoryData: null,
    callData: "0x" as `0x${string}`,
    callGasLimit: 100000n,
    verificationGasLimit: 100000n,
    preVerificationGas: 50000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0x" as `0x${string}`,
  };
}

/** Create a mock receipt for testing. */
function mockReceipt(userOpHash: `0x${string}`): UserOperationReceipt {
  return {
    userOpHash,
    entryPoint: ENTRY_POINT,
    sender: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    nonce: 0n,
    paymaster: null,
    actualGasCost: 100000n,
    actualGasUsed: 50000n,
    success: true,
    logs: [],
    receipt: {
      transactionHash: "0x" + "ab".repeat(32) as `0x${string}`,
      transactionIndex: 0,
      blockHash: "0x" + "cd".repeat(32) as `0x${string}`,
      blockNumber: 100n,
      from: "0x2222222222222222222222222222222222222222" as `0x${string}`,
      to: ENTRY_POINT,
      cumulativeGasUsed: 200000n,
      gasUsed: 100000n,
      effectiveGasPrice: 1000000000n,
    },
  };
}

/** Create a mock ChainServices with optional receipt and mempool state. */
function mockChainRegistry(opts?: {
  receipt?: UserOperationReceipt;
  mempoolEntry?: MempoolEntry;
  gasPrices?: { baseFee: bigint; suggestedMaxPriorityFeePerGas: bigint; chainGasPrice: bigint };
}): ChainRegistryLike {
  const chains: ChainServices[] = [{
    chainId: 1,
    chainInfo: null,
    rpcUrl: "https://rpc.example.com",
    publicRpcs: [],
    simulator: {
      getGasPrices: async () =>
        opts?.gasPrices ?? { baseFee: 0n, suggestedMaxPriorityFeePerGas: 0n, chainGasPrice: 0n },
    } as any,
    mempool: {
      get(hash: string) {
        if (opts?.mempoolEntry && opts.mempoolEntry.userOpHash === hash) {
          return opts.mempoolEntry;
        }
        return undefined;
      },
      size: opts?.mempoolEntry ? 1 : 0,
    } as any,
    accountService: {} as any,
    bundler: {
      getReceipt(hash: string) {
        if (opts?.receipt && opts.receipt.userOpHash === hash) {
          return opts.receipt;
        }
        return undefined;
      },
    } as any,
  }];

  return {
    async getChain(_chainId: number) { return chains[0]!; },
    getAll() { return chains; },
  };
}

// --- Tests ---

Deno.test("pimlico_getUserOperationGasPrice - quotes 3 tiers at markup× cost with split", async () => {
  const config = mockConfig({ walletGasMarkup: 2.0 }); // relayer fee = network fee (~2×)
  const registry = mockChainRegistry({
    gasPrices: {
      baseFee: 10_000_000_000n, // 10 gwei
      suggestedMaxPriorityFeePerGas: 1_000_000_000n, // 1 gwei tip
      chainGasPrice: 11_000_000_000n, // 11 gwei floor
    },
  });

  const result = (await handleRpcMethod(
    "pimlico_getUserOperationGasPrice", [], config, registry, mockReqCtx(),
  )) as Record<string, Record<string, string>>;

  // standard: tip×1.5 = 1.5 gwei → networkPrice = max(11.5, 11) = 11.5 gwei
  //           userPrice = 11.5 × 2 = 23 gwei
  assertEquals(BigInt(result.standard!.networkFeePerGas), 11_500_000_000n);
  assertEquals(BigInt(result.standard!.maxFeePerGas), 23_000_000_000n);
  // maxPriorityFeePerGas == maxFeePerGas so the EntryPoint charges exactly userPrice
  assertEquals(result.standard!.maxPriorityFeePerGas, result.standard!.maxFeePerGas);
  // network + relayer == total (relayer fee ≈ network fee at 2×)
  assertEquals(
    BigInt(result.standard!.networkFeePerGas) + BigInt(result.standard!.relayerFeePerGas),
    BigInt(result.standard!.maxFeePerGas),
  );

  // Tiers strictly increase by speed: fast > standard > slow.
  assert(BigInt(result.fast!.maxFeePerGas) > BigInt(result.standard!.maxFeePerGas));
  assert(BigInt(result.standard!.maxFeePerGas) > BigInt(result.slow!.maxFeePerGas));
});

Deno.test("handleRpcMethod - eth_supportedEntryPoints returns config entry point", async () => {
  const config = mockConfig();
  const result = await handleRpcMethod(
    "eth_supportedEntryPoints", [], config, mockChainRegistry(), mockReqCtx(),
  );
  assertEquals(result, [ENTRY_POINT]);
});

Deno.test("handleRpcMethod - eth_chainId returns hex chainId from reqCtx", async () => {
  const config = mockConfig();
  const result = await handleRpcMethod(
    "eth_chainId", [], config, mockChainRegistry(), mockReqCtx({ chainId: 137 }),
  );
  assertEquals(result, "0x89");
});

Deno.test("handleRpcMethod - eth_chainId for chain 1", async () => {
  const config = mockConfig();
  const result = await handleRpcMethod(
    "eth_chainId", [], config, mockChainRegistry(), mockReqCtx({ chainId: 1 }),
  );
  assertEquals(result, "0x1");
});

// RPC handlers throw plain {code, message} objects, not Error instances.
// Use processRequest to capture errors as JSON-RPC error responses.

Deno.test("processRequest - unknown method returns methodNotFound error", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_unknownMethod", params: [] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32601); // methodNotFound
});

Deno.test("processRequest - eth_sendUserOperation with missing params returns error", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32602); // invalidParams
});

Deno.test("processRequest - eth_sendUserOperation with wrong entryPoint returns error", async () => {
  const config = mockConfig();
  const fakeUserOp = { sender: "0x" + "11".repeat(20) };
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [fakeUserOp, "0x0000000000000000000000000000000000000001"] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32602); // invalidParams
});

Deno.test("processRequest - eth_estimateUserOperationGas with missing params returns error", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_estimateUserOperationGas", params: [] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32602); // invalidParams
});

Deno.test("processRequest - eth_getUserOperationByHash with non-hex hash returns error", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_getUserOperationByHash", params: ["not-hex"] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32602);
});

Deno.test("processRequest - eth_getUserOperationReceipt with non-hex hash returns error", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: ["not-hex"] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32602);
});

Deno.test("handleRpcMethod - eth_getUserOperationByHash returns null for unknown hash", async () => {
  const config = mockConfig();
  const result = await handleRpcMethod(
    "eth_getUserOperationByHash",
    ["0x" + "ab".repeat(32)],
    config, mockChainRegistry(), mockReqCtx(),
  );
  assertEquals(result, null);
});

Deno.test("handleRpcMethod - eth_getUserOperationByHash returns receipt when found", async () => {
  const config = mockConfig();
  const hash = "0x" + "ab".repeat(32) as `0x${string}`;
  const receipt = mockReceipt(hash);
  const registry = mockChainRegistry({ receipt });

  const result = await handleRpcMethod(
    "eth_getUserOperationByHash", [hash], config, registry, mockReqCtx(),
  ) as Record<string, unknown>;

  assertEquals(result!.entryPoint, ENTRY_POINT);
  assertEquals(result!.transactionHash, receipt.receipt.transactionHash);
  assertEquals(result!.blockNumber, "0x" + receipt.receipt.blockNumber.toString(16));
});

Deno.test("handleRpcMethod - eth_getUserOperationReceipt returns null for unknown hash", async () => {
  const config = mockConfig();
  const result = await handleRpcMethod(
    "eth_getUserOperationReceipt",
    ["0x" + "ab".repeat(32)],
    config, mockChainRegistry(), mockReqCtx(),
  );
  assertEquals(result, null);
});

Deno.test("handleRpcMethod - eth_getUserOperationReceipt returns formatted receipt", async () => {
  const config = mockConfig();
  const hash = "0x" + "ab".repeat(32) as `0x${string}`;
  const receipt = mockReceipt(hash);
  const registry = mockChainRegistry({ receipt });

  const result = await handleRpcMethod(
    "eth_getUserOperationReceipt", [hash], config, registry, mockReqCtx(),
  ) as Record<string, unknown>;

  assertEquals(result!.userOpHash, hash);
  assertEquals(result!.sender, receipt.sender);
  assertEquals(result!.success, true);
  assertEquals(result!.actualGasCost, "0x" + receipt.actualGasCost.toString(16));
  assertEquals(result!.actualGasUsed, "0x" + receipt.actualGasUsed.toString(16));
});

Deno.test("handleRpcMethod - eth_getUserOperationByHash prefers mempool over receipt", async () => {
  const config = mockConfig();
  const hash = "0x" + "ab".repeat(32) as `0x${string}`;
  const receipt = mockReceipt(hash);
  const mempoolEntry: MempoolEntry = {
    userOpHash: hash,
    userOp: makeFullUserOp(),
    packed: {} as any,
    prefund: 0n,
    addedAt: Date.now(),
  };
  const registry = mockChainRegistry({ receipt, mempoolEntry });

  const result = await handleRpcMethod(
    "eth_getUserOperationByHash", [hash], config, registry, mockReqCtx(),
  ) as Record<string, unknown>;

  // Should find in mempool first (blockNumber null = pending)
  assertEquals(result!.blockNumber, null);
  assertEquals(result!.transactionHash, null);
});

Deno.test("processRequest - preserves request id in response", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { jsonrpc: "2.0", id: 42, method: "eth_supportedEntryPoints", params: [] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assertEquals(result.id, 42);
  assertEquals(result.jsonrpc, "2.0");
  assertEquals(result.error, undefined);
});

Deno.test("processRequest - string id preserved", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { jsonrpc: "2.0", id: "req-1", method: "eth_chainId", params: [] },
    config, mockChainRegistry(), mockReqCtx(),
  );
  assertEquals(result.id, "req-1");
});

Deno.test("processRequest - invalid body returns parse error", async () => {
  const config = mockConfig();
  const result = await processRequest(
    null, config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
});

Deno.test("processRequest - missing jsonrpc returns invalidRequest", async () => {
  const config = mockConfig();
  const result = await processRequest(
    { id: 1, method: "eth_chainId" }, config, mockChainRegistry(), mockReqCtx(),
  );
  assert(result.error !== undefined);
  assertEquals(result.error!.code, -32600);
});
