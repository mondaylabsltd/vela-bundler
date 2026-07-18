// deno-lint-ignore-file no-explicit-any -- partial `as any` mocks of ChainServices/Simulator/etc.
/**
 * External API CONTRACT tests — the pin for docs/api-contract.md.
 *
 * These lock the shape of the interfaces the bundler exposes to wallets / the operator, so a
 * refactor of any handler's *implementation* that silently changes the wire contract fails here.
 * Complements the per-handler suites (handlers_test, rest_api_test, receipt_format_test,
 * rpc_errors_test, cors_test) — this file targets the gaps: the full method SET, the two Vela
 * extension methods, the estimate-gas success shape, the error-code taxonomy, and the REST
 * sponsor status mapping.
 */

import { it, expect } from "vitest";
import { encodeAbiParameters, getAddress } from "viem";
import { handleRpcMethod, EXPOSED_RPC_METHODS } from "../shared/rpc/handlers.ts";
import { processRequest, type RequestContext } from "../shared/rpc/process.ts";
import { handleRestApi } from "../shared/rpc/rest-api.ts";
import { serviceDegraded, rpcError, isDeliberateRpcError } from "../shared/rpc/errors.ts";
import { RPC_ERROR_CODES, ENTRYPOINT_V07_ADDRESS } from "../shared/contracts/entrypoint.ts";
import { IN_BAND_MARKUP_X } from "../shared/tempo.ts";
import { requiredStableCharge } from "../shared/gas/stable-rate.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { ChainRegistryLike, ChainServices } from "../shared/chain/index.ts";
import type { RateLimitConfig } from "../shared/auth/index.ts";
import type { UserOperation } from "../shared/userop/types.ts";

const ENTRY_POINT = ENTRYPOINT_V07_ADDRESS;
const TREASURY = ("0x" + "cc".repeat(20)) as `0x${string}`;
const EOA = ("0x" + "d1".repeat(20)) as `0x${string}`;
const SAFE = ("0x" + "33".repeat(20)) as `0x${string}`;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const STABLE = getAddress("0x" + "a1".repeat(20));
const QUOTER = getAddress("0x" + "b2".repeat(20));
const WNATIVE = getAddress("0x" + "c3".repeat(20));

/** Install a global.fetch stub that answers JSON-RPC calls via `answer(method, params, to)`; a
 *  thrown answer becomes a JSON-RPC error (viem then rejects — used to drive the degraded paths).
 *  Mirrors the pattern in stage2_vault_test.ts. Always restore() in a finally. */
function stubFetch(answer: (method: string, params: any[], to?: string) => unknown): { restore: () => void } {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const bodyP = input instanceof Request ? input.text() : Promise.resolve(String(init?.body ?? ""));
    return bodyP.then((raw: string) => {
      const body = JSON.parse(raw);
      const one = (r: { id: number; method: string; params?: any[] }) => {
        try {
          const to = r.method === "eth_call" ? r.params?.[0]?.to : undefined;
          return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params ?? [], to) };
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } };
        }
      };
      const payload = Array.isArray(body) ? body.map(one) : one(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; } };
}

function mockConfig(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
  return {
    chainId: 1, rpcUrl: "https://rpc.example.com", publicRpcs: [], chainInfo: null,
    entryPointAddress: ENTRY_POINT, port: 0, host: "", bundlingMode: "auto",
    maxBundleSize: 10, maxBundleGas: 5000000n, minPriorityFeePerGas: 0n,
    minProfitMarginBps: 1000, maxProfitMarginBps: 15000, walletGasMarkup: 2.0,
    useEip1559: true, baseFeeMultiplier: 1.25, bundlerTipGwei: 0.5, autoBundleIntervalMs: 10000,
    operatorSecret: "0x" + "ab".repeat(32), oldOperatorSecrets: [], treasuryAddress: TREASURY,
    splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    apiRateLimitPerMinute: 60, rateLimitAllowlist: [], balanceReserveMultiplier: 1, alchemyApiKey: null,
    telegramBotToken: null, telegramChatId: null, treasuryAlertThresholdWei: 0n, treasuryAlertThresholdPathUsd: 0n,
    ...overrides,
  } as BundlerConfig;
}

function mockReqCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { chainId: 1, ...overrides };
}

function fullUserOp(): UserOperation {
  return {
    sender: SAFE, nonce: 1n, factory: null, factoryData: null, callData: "0x",
    callGasLimit: 100000n, verificationGasLimit: 100000n, preVerificationGas: 50000n,
    maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 100000000n,
    paymaster: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null,
    paymasterData: null, signature: "0x",
  };
}

/** A registry whose single chain answers every no-RPC dependency the dispatch table touches. */
function mockRegistry(chain: Partial<ChainServices> = {}): ChainRegistryLike {
  const services = {
    chainId: 1, chainInfo: null, rpcUrl: "https://rpc.example.com", publicRpcs: [],
    simulator: {
      getGasPrices: async () => ({ baseFee: 10_000_000_000n, suggestedMaxPriorityFeePerGas: 1_000_000_000n, chainGasPrice: 11_000_000_000n }),
    },
    mempool: { get: () => undefined, size: 0 },
    accountService: { deriveEOA: async () => ({ address: EOA }) },
    bundler: { getReceipt: () => undefined },
    ...chain,
  } as any as ChainServices;
  return {
    async getChain() { return services; },
    getAll() { return [services]; },
  };
}

// ---------------------------------------------------------------------------
// 1. The method SET is exactly these 8 — renaming/dropping one must break a test.
// ---------------------------------------------------------------------------

// The methods the CONTRACT (docs/api-contract.md §1) promises. The implementation's dispatch
// table (EXPOSED_RPC_METHODS) must equal this set EXACTLY — adding/removing/renaming a handler
// grows or shrinks the table and breaks the set-equality assertion, forcing a deliberate doc update.
const DOCUMENTED_METHODS = [
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
  "eth_supportedEntryPoints",
  "eth_chainId",
  "pimlico_getUserOperationGasPrice",
  "vela_getInBandGasQuote",
] as const;

it("method set — the dispatch table is EXACTLY the documented 8 (pins surface growth AND shrink)", () => {
  expect(new Set(EXPOSED_RPC_METHODS)).toEqual(new Set(DOCUMENTED_METHODS));
  expect(EXPOSED_RPC_METHODS.length).toEqual(8);
  expect(DOCUMENTED_METHODS.length).toEqual(8);
});

it.each(EXPOSED_RPC_METHODS)("method set — %s is dispatched (not -32601 method-not-found)", async (method) => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method, params: [] },
    mockConfig(), mockRegistry(), mockReqCtx(),
  );
  // Routed methods either succeed or fail with a DIFFERENT code (bad params, not-enabled, etc.).
  // The one thing they must never be is "method not found".
  expect(result.error?.code).not.toEqual(-32601);
});

it("method set — an unknown method IS -32601", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_definitelyNotAMethod", params: [] },
    mockConfig(), mockRegistry(), mockReqCtx(),
  );
  expect(result.error?.code).toEqual(-32601);
});

// ---------------------------------------------------------------------------
// 2. eth_estimateUserOperationGas — success shape (all fields hex; paymaster field conditional).
// ---------------------------------------------------------------------------

function estimatingRegistry(paymasterVGL: bigint | null): ChainRegistryLike {
  return mockRegistry({
    simulator: {
      estimateUserOpGas: async () => ({
        preVerificationGas: 50_000n, verificationGasLimit: 100_000n, callGasLimit: 80_000n,
        paymasterVerificationGasLimit: paymasterVGL,
      }),
    } as any,
  });
}

it("eth_estimateUserOperationGas — hex-encodes the three limits, omits paymaster field when null", async () => {
  const result = await handleRpcMethod(
    "eth_estimateUserOperationGas", [fullUserOp(), ENTRY_POINT],
    mockConfig(), estimatingRegistry(null), mockReqCtx(),
  ) as Record<string, string>;
  expect(result.preVerificationGas).toEqual("0x" + (50_000n).toString(16));
  expect(result.verificationGasLimit).toEqual("0x" + (100_000n).toString(16));
  expect(result.callGasLimit).toEqual("0x" + (80_000n).toString(16));
  expect("paymasterVerificationGasLimit" in result).toBe(false);
});

it("eth_estimateUserOperationGas — includes paymasterVerificationGasLimit (hex) when present", async () => {
  const result = await handleRpcMethod(
    "eth_estimateUserOperationGas", [fullUserOp(), ENTRY_POINT],
    mockConfig(), estimatingRegistry(20_000n), mockReqCtx(),
  ) as Record<string, string>;
  expect(result.paymasterVerificationGasLimit).toEqual("0x" + (20_000n).toString(16));
});

// ---------------------------------------------------------------------------
// 3. pimlico_getUserOperationGasPrice — every tier carries all four fields.
// ---------------------------------------------------------------------------

it("pimlico_getUserOperationGasPrice — 3 tiers, each with the 4-field network/relayer split", async () => {
  const result = await handleRpcMethod(
    "pimlico_getUserOperationGasPrice", [], mockConfig({ walletGasMarkup: 2.0 }), mockRegistry(), mockReqCtx(),
  ) as Record<string, Record<string, string>>;
  for (const tier of ["slow", "standard", "fast"] as const) {
    const q = result[tier]!;
    for (const field of ["maxFeePerGas", "maxPriorityFeePerGas", "networkFeePerGas", "relayerFeePerGas"]) {
      expect(typeof q[field]).toEqual("string");
      expect(q[field]!.startsWith("0x")).toBeTruthy();
    }
    // maxPriorityFeePerGas == maxFeePerGas (EntryPoint charges exactly maxFeePerGas).
    expect(q.maxPriorityFeePerGas).toEqual(q.maxFeePerGas);
    // At walletGasMarkup 2.0 the relayer margin equals the network cost — a markup-SENSITIVE
    // check (unlike `network + relayer == max`, which is a subtraction identity for any markup≥1).
    expect(BigInt(q.relayerFeePerGas!)).toEqual(BigInt(q.networkFeePerGas!));
  }
});

// ---------------------------------------------------------------------------
// 4. vela_getInBandGasQuote — validation + native quote shape (+ vault recipient redirect).
// ---------------------------------------------------------------------------

const INBAND_CONFIG = () => mockConfig({ inBandChains: "all" }); // in-band active on chain 1

it("vela_getInBandGasQuote — rejected with -32602 when in-band is not enabled on the chain", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "vela_getInBandGasQuote", params: [{ safeAddress: SAFE, nativeCost: "0x1" }] },
    mockConfig(), mockRegistry(), mockReqCtx(), // inBandChains unset → off
  );
  expect(result.error?.code).toEqual(RPC_ERROR_CODES.INVALID_USEROPERATION); // -32602
});

it("vela_getInBandGasQuote — missing/invalid safeAddress → -32602", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "vela_getInBandGasQuote", params: [{ nativeCost: "0x1" }] },
    INBAND_CONFIG(), mockRegistry(), mockReqCtx(),
  );
  expect(result.error?.code).toEqual(-32602);
});

it("vela_getInBandGasQuote — non-numeric nativeCost → -32602", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "vela_getInBandGasQuote", params: [{ safeAddress: SAFE, nativeCost: "not-a-number" }] },
    INBAND_CONFIG(), mockRegistry(), mockReqCtx(),
  );
  expect(result.error?.code).toEqual(-32602);
});

it("vela_getInBandGasQuote — nativeCost <= 0 → -32602", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "vela_getInBandGasQuote", params: [{ safeAddress: SAFE, nativeCost: "0x0" }] },
    INBAND_CONFIG(), mockRegistry(), mockReqCtx(),
  );
  expect(result.error?.code).toEqual(-32602);
});

it("vela_getInBandGasQuote — the in-band markup constant IS the documented 3× (api-contract.md §1)", () => {
  expect(IN_BAND_MARKUP_X).toEqual(3n); // flipping the constant must break a test that names the value
});

it("vela_getInBandGasQuote — native quote: recipient=EOA, exactly 3× amount, markupX=3", async () => {
  const nativeCost = 1_000_000_000_000_000n; // 1e15 wei (well above the 1e-5 floor → markup binds)
  const result = await handleRpcMethod(
    "vela_getInBandGasQuote",
    [{ safeAddress: SAFE, nativeCost: "0x" + nativeCost.toString(16) }],
    INBAND_CONFIG(), mockRegistry(), mockReqCtx(),
  ) as Record<string, unknown>;

  expect(result.asset).toEqual("native");
  expect(result.feeToken).toEqual(null);
  expect((result.recipient as string).toLowerCase()).toEqual(EOA); // per-safe EOA (vault off)
  expect(result.markupX).toEqual(3); // literal — not Number(IN_BAND_MARKUP_X)
  // requiredAmount = exactly 3× cost (literal factor, independent of the impl's constant).
  expect(result.requiredAmount).toEqual("0x" + (nativeCost * 3n).toString(16));
});

it("vela_getInBandGasQuote — native floor applies to a tiny cost", async () => {
  const result = await handleRpcMethod(
    "vela_getInBandGasQuote", [{ safeAddress: SAFE, nativeCost: "0x1" }],
    INBAND_CONFIG(), mockRegistry(), mockReqCtx(),
  ) as Record<string, unknown>;
  // 3 × 1 wei is below the 1e-5-coin floor → charge is the floor (1e18/100_000 = 1e13 wei),
  // pinned as an independent literal so a floor removal in the shared helper is caught here too.
  expect(result.requiredAmount).toEqual("0x" + (10n ** 18n / 100_000n).toString(16));
});

it("vela_getInBandGasQuote — vault mode redirects the recipient to the treasury", async () => {
  const result = await handleRpcMethod(
    "vela_getInBandGasQuote", [{ safeAddress: SAFE, nativeCost: "0x38d7ea4c68000" }],
    mockConfig({ inBandChains: "all", settlementVaultChains: "all" }), mockRegistry(), mockReqCtx(),
  ) as Record<string, unknown>;
  expect((result.recipient as string).toLowerCase()).toEqual(TREASURY.toLowerCase());
});

// ---------------------------------------------------------------------------
// 4b. vela_getInBandGasQuote — the stablecoin (erc20) branch.
// ---------------------------------------------------------------------------

function erc20ChainInfo(withQuoter: boolean): unknown {
  return {
    nativeCurrency: { decimals: 18 },
    stables: [{ contract: STABLE }],
    wrappedNativeToken: WNATIVE,
    dex: withQuoter ? { contracts: { quoterV2: QUOTER } } : undefined,
  };
}

it("vela_getInBandGasQuote (erc20) — a non-whitelisted feeToken → -32602", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "vela_getInBandGasQuote",
      params: [{ safeAddress: SAFE, nativeCost: "0x1", feeToken: STABLE }] },
    INBAND_CONFIG(), mockRegistry(), mockReqCtx({ chainId: 8453 }), // chainInfo null → no whitelist
  );
  expect(result.error?.code).toEqual(RPC_ERROR_CODES.INVALID_USEROPERATION); // -32602
});

it("vela_getInBandGasQuote (erc20) — a whitelisted token but no DEX quoter → -32602", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "vela_getInBandGasQuote",
      params: [{ safeAddress: SAFE, nativeCost: "0x1", feeToken: STABLE }] },
    INBAND_CONFIG(), mockRegistry({ chainInfo: erc20ChainInfo(false) as any }), mockReqCtx({ chainId: 8453 }),
  );
  expect(result.error?.code).toEqual(-32602);
});

it("vela_getInBandGasQuote (erc20) — DEX quote unavailable → retryable -32000", async () => {
  const stub = stubFetch((method) => {
    if (method === "eth_call") throw new Error("execution reverted"); // every fee tier fails → null
    if (method === "eth_chainId") return "0x2716"; // 10010, unused chain id
    return "0x0";
  });
  try {
    const result = await processRequest(
      { jsonrpc: "2.0", id: 1, method: "vela_getInBandGasQuote",
        params: [{ safeAddress: SAFE, nativeCost: "0x38d7ea4c68000", feeToken: STABLE }] },
      INBAND_CONFIG(), mockRegistry({ chainInfo: erc20ChainInfo(true) as any, rpcUrl: "http://erc20-null.invalid" }),
      mockReqCtx({ chainId: 10 }), // fresh (chain,stable) rate-cache key
    );
    expect(result.error?.code).toEqual(RPC_ERROR_CODES.SERVICE_DEGRADED); // -32000
  } finally { stub.restore(); }
});

it("vela_getInBandGasQuote (erc20) — success: {asset:'erc20', feeToken, decimals, requiredAmount, markupX:3}", async () => {
  const costStable = 5_000n; // DEX says 1e15 wei ≈ 5000 base units (6-dec → $0.005)
  const decimals = 6;
  const stub = stubFetch((method, _params, to) => {
    if (method === "eth_chainId") return "0x210d"; // 8461, unused
    if (method !== "eth_call") return "0x0";
    if (to?.toLowerCase() === QUOTER.toLowerCase()) {
      // quoteExactInputSingle → (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
      return encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }],
        [costStable, 0n, 0, 0n],
      );
    }
    if (to?.toLowerCase() === STABLE.toLowerCase()) {
      return encodeAbiParameters([{ type: "uint8" }], [decimals]); // decimals()
    }
    return "0x0";
  });
  try {
    const result = await handleRpcMethod(
      "vela_getInBandGasQuote",
      [{ safeAddress: SAFE, nativeCost: "0x38d7ea4c68000", feeToken: STABLE }],
      INBAND_CONFIG(), mockRegistry({ chainInfo: erc20ChainInfo(true) as any, rpcUrl: "http://erc20-ok.invalid" }),
      mockReqCtx({ chainId: 8453 }),
    ) as Record<string, unknown>;

    expect(result.asset).toEqual("erc20");
    expect(result.feeToken).toEqual(STABLE);          // echoed, checksummed
    expect(result.decimals).toEqual(decimals);        // present + numeric
    expect(result.markupX).toEqual(3);
    expect((result.recipient as string).toLowerCase()).toEqual(EOA); // vault off
    // 3× the DEX cost, $0.01-floored, in the stable's base units.
    expect(result.requiredAmount).toEqual("0x" + requiredStableCharge(costStable, decimals, 3n).toString(16));
  } finally { stub.restore(); }
});

// ---------------------------------------------------------------------------
// 4c. eth_sendUserOperation — the success contract + the -32508 treasury gate (behavioral).
// ---------------------------------------------------------------------------

function sendableUserOp(): UserOperation {
  return { ...fullUserOp(), signature: ("0x" + "11".repeat(65)) as `0x${string}`, preVerificationGas: 1_000_000n };
}

/** A registry whose chain passes validation + both simulations and accepts into the transport. */
function sendRegistry(): ChainRegistryLike {
  return mockRegistry({
    rpcUrl: "http://send-rpc.invalid",
    simulator: {
      getGasPrices: async () => ({ baseFee: 10_000_000_000n, suggestedMaxPriorityFeePerGas: 1_000_000_000n, chainGasPrice: 11_000_000_000n }),
      simulateValidation: async () => ({ valid: true, validationResult: { prefund: 0n } }),
      simulateExecution: async () => ({ success: true }),
    } as any,
    accountService: {
      deriveEOA: async () => ({ address: EOA }),
      lockManager: { getState: () => undefined, initEOA: async () => ({ status: "ACTIVE" }) },
      getClient: () => ({}),
      checkBalance: async () => ({ sufficient: true, spendableBalance: 10n ** 18n, requiredBalance: 0n }),
    } as any,
    bundler: { acceptUserOp: async () => HASH, getReceipt: () => undefined } as any,
  });
}

it("eth_sendUserOperation — success returns the userOpHash (in-band chain, vault off)", async () => {
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [sendableUserOp(), ENTRY_POINT] },
    mockConfig({ inBandChains: "all", settlementVaultChains: "" }), sendRegistry(), mockReqCtx({ chainId: 8453 }),
  );
  expect(result.error).toBeUndefined();
  expect(result.result).toEqual(HASH);
  expect(String(result.result)).toMatch(/^0x[0-9a-f]{64}$/);
});

it("eth_sendUserOperation — vault chain with a treasury BELOW its bootstrap floor → -32508", async () => {
  const stub = stubFetch((method, params) => {
    if (method === "eth_getBalance") return "0x" + (10n ** 15n).toString(16); // 0.001 < 1e16 floor
    if (method === "eth_chainId") return "0x210d";
    return "0x0";
  });
  try {
    const result = await processRequest(
      { jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [sendableUserOp(), ENTRY_POINT] },
      mockConfig({ inBandChains: "all", settlementVaultChains: "all" }), sendRegistry(), mockReqCtx({ chainId: 8453 }),
    );
    expect(result.error?.code).toEqual(RPC_ERROR_CODES.PAYMASTER_BALANCE_INSUFFICIENT); // -32508
  } finally { stub.restore(); }
});

it("eth_sendUserOperation — vault chain with a healthy treasury accepts (returns the hash)", async () => {
  const stub = stubFetch((method) => {
    if (method === "eth_getBalance") return "0x" + (10n ** 18n).toString(16); // 1.0 ≥ floor
    if (method === "eth_chainId") return "0x210d";
    return "0x0";
  });
  try {
    const result = await processRequest(
      { jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [sendableUserOp(), ENTRY_POINT] },
      mockConfig({ inBandChains: "all", settlementVaultChains: "all" }), sendRegistry(), mockReqCtx({ chainId: 8453 }),
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(HASH);
  } finally { stub.restore(); }
});

it("eth_sendUserOperation — the treasury gate FAILS OPEN on a balance-read error (send still succeeds)", async () => {
  const stub = stubFetch((method) => {
    if (method === "eth_getBalance") throw new Error("rpc down");
    if (method === "eth_chainId") return "0x210d";
    return "0x0";
  });
  try {
    const result = await processRequest(
      { jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [sendableUserOp(), ENTRY_POINT] },
      mockConfig({ inBandChains: "all", settlementVaultChains: "all" }), sendRegistry(), mockReqCtx({ chainId: 8453 }),
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(HASH);
  } finally { stub.restore(); }
});

// ---------------------------------------------------------------------------
// 5. Error taxonomy — the codes wallets branch on must not drift.
// ---------------------------------------------------------------------------

it("error taxonomy — RPC_ERROR_CODES numeric values are the documented contract", () => {
  expect(RPC_ERROR_CODES).toMatchObject({
    INVALID_USEROPERATION: -32602,
    ENTRYPOINT_SIMULATION_REJECTED: -32500,
    PAYMASTER_REJECTED: -32501,
    OPCODE_VIOLATION: -32502,
    OUT_OF_TIME_RANGE: -32503,
    THROTTLED_OR_BANNED: -32504,
    STAKE_TOO_LOW: -32505,
    SIGNATURE_VALIDATION_FAILED: -32507,
    PAYMASTER_BALANCE_INSUFFICIENT: -32508,
    SERVICE_DEGRADED: -32000,
  });
});

it("error taxonomy — serviceDegraded is a retryable -32000 carrying reason + retryAfterMs", () => {
  const err = serviceDegraded("busy", { retryAfterMs: 1500, reason: "rpc_timeout" });
  expect(err.code).toEqual(-32000);
  expect(err.data).toMatchObject({ retryable: true, retryAfterMs: 1500, reason: "rpc_timeout" });
});

it("error taxonomy — only errors built via the factories are forwarded; a look-alike is redacted", async () => {
  // isDeliberateRpcError gates process.ts forwarding: a raw {code,message} (e.g. a viem error
  // that could leak an RPC URL) must NOT reach the client verbatim.
  expect(isDeliberateRpcError({ code: -32602, message: "spoofed" })).toBe(false);
  expect(isDeliberateRpcError(rpcError(-32602, "real"))).toBe(true);

  // End to end: a handler throwing a non-deliberate error → generic -32603, not the raw error.
  const leaky: ChainRegistryLike = {
    async getChain() { return {} as any; },
    getAll() { throw new Error("postgres://user:pass@host leaked in a stack"); },
  };
  const result = await processRequest(
    { jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: ["0x" + "ab".repeat(32)] },
    mockConfig(), leaky, mockReqCtx(),
  );
  expect(result.error?.code).toEqual(-32603);
  expect(result.error?.message).toEqual("Internal error"); // redacted — no leaked connection string
});

// ---------------------------------------------------------------------------
// 6. REST — POST /v1/sponsor status mapping (200 / 503 / 500).
// ---------------------------------------------------------------------------

function sponsorRegistry(): ChainRegistryLike {
  return {
    getChain: () => Promise.resolve({
      rpcUrl: "https://trusted.example.com",
      accountService: { deriveEOA: () => Promise.resolve({ address: EOA }) },
    } as any),
    getAll: () => [],
  } as unknown as ChainRegistryLike;
}

const RL: RateLimitConfig = { rateLimitPerMinute: 1000 };

function sponsorRequest() {
  const url = new URL(`http://localhost/v1/sponsor/1/${SAFE}`);
  const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return { url, req };
}

it("POST /v1/sponsor — a normal denial/grant is 200", async () => {
  const stub = { sponsor: () => Promise.resolve({ sponsored: false, reason: "wallet_balance_too_low" }) };
  const { url, req } = sponsorRequest();
  const res = await handleRestApi(req, url, sponsorRegistry(), mockConfig(), RL, undefined, stub as any);
  expect(res!.status).toEqual(200);
  expect((await res!.json()).reason).toEqual("wallet_balance_too_low");
});

it("POST /v1/sponsor — a passkey-index OUTAGE maps to 503 (infra, retryable — not 'unregistered')", async () => {
  const stub = { sponsor: () => Promise.resolve({ sponsored: false, reason: "passkey_index_unavailable" }) };
  const { url, req } = sponsorRequest();
  const res = await handleRestApi(req, url, sponsorRegistry(), mockConfig(), RL, undefined, stub as any);
  expect(res!.status).toEqual(503);
});

it("POST /v1/sponsor — an unexpected throw maps to 500 with an internal_error reason", async () => {
  const stub = { sponsor: () => Promise.reject(new Error("boom")) };
  const { url, req } = sponsorRequest();
  const res = await handleRestApi(req, url, sponsorRegistry(), mockConfig(), RL, undefined, stub as any);
  expect(res!.status).toEqual(500);
  expect((await res!.json())).toMatchObject({ sponsored: false, reason: "internal_error" });
});

it("POST /v1/sponsor — SECURITY: the client X-Rpc-Url is ignored; the trusted registry RPC is used", async () => {
  // Sponsorship signs + broadcasts a TREASURY transfer, so it must never touch an attacker-supplied
  // RPC (fake balances / captured tx). handleSponsor pins the trusted chain.rpcUrl regardless of the
  // requestRpcUrl passed through. This is documented in docs/api-contract.md §2.
  const captured: { args?: unknown[] } = {};
  const stub = { sponsor(...args: unknown[]) { captured.args = args; return Promise.resolve({ sponsored: false }); } };
  const ATTACKER_RPC = "https://attacker.evil.com";
  const url = new URL(`http://localhost/v1/sponsor/1/${SAFE}`);
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Rpc-Url": ATTACKER_RPC },
    body: "{}",
  });
  const res = await handleRestApi(req, url, sponsorRegistry(), mockConfig(), RL, ATTACKER_RPC, stub as any);
  expect(res!.status).toEqual(200);
  // sponsor(chainId, safe, relayer, trustedRpc, requiredWei, dryRun) — arg[3] is the RPC used.
  expect(captured.args![3]).toEqual("https://trusted.example.com");
  expect(captured.args![3]).not.toEqual(ATTACKER_RPC);
});
