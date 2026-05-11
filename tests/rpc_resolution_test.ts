/**
 * Tests for RPC URL resolution priority.
 */

import { assertEquals } from "@std/assert";
import { resolveRpcUrl, getAllRpcUrls } from "../src/utils/rpc-client.ts";
import type { BundlerConfig } from "../src/config/index.ts";

function makeConfig(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: "https://registry-default.example.com",
    userRpcUrls: [],
    publicRpcs: [
      "https://registry-1.example.com",
      "https://registry-2.example.com",
    ],
    chainInfo: null,
    entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    port: 3300,
    host: "0.0.0.0",
    bundlingMode: "auto",
    maxBundleSize: 10,
    maxBundleGas: 5000000n,
    minPriorityFeePerGas: 1000000000n,
    minProfitMarginBps: 2000,
    targetProfitMarginBps: 3500,
    highRiskMarginBps: 5000,
    useEip1559: true,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 1.5,
    autoBundleIntervalMs: 10000,
    operatorSecret: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    oldOperatorSecrets: [],
    apiRateLimitPerMinute: 60,
    balanceReserveMultiplier: 2,
    treasuryAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    sweepInterval: 30,
    ...overrides,
  } as BundlerConfig;
}

// --- resolveRpcUrl ---

Deno.test("resolveRpcUrl - per-request override has highest priority", () => {
  const config = makeConfig({
    userRpcUrls: ["https://user-rpc.example.com"],
    rpcUrl: "https://operator-rpc.example.com",
  });

  const result = resolveRpcUrl(config, "https://request-override.example.com");
  assertEquals(result, "https://request-override.example.com");
});

Deno.test("resolveRpcUrl - falls back to config.rpcUrl when no override", () => {
  const config = makeConfig({
    rpcUrl: "https://operator-rpc.example.com",
  });

  const result = resolveRpcUrl(config);
  assertEquals(result, "https://operator-rpc.example.com");
});

Deno.test("resolveRpcUrl - empty override string falls back to config", () => {
  const config = makeConfig({ rpcUrl: "https://default.example.com" });

  assertEquals(resolveRpcUrl(config, ""), "https://default.example.com");
  assertEquals(resolveRpcUrl(config, null), "https://default.example.com");
  assertEquals(resolveRpcUrl(config, undefined), "https://default.example.com");
});

// --- getAllRpcUrls ---

Deno.test("getAllRpcUrls - full priority order", () => {
  const config = makeConfig({
    rpcUrl: "https://operator-rpc.example.com",
    userRpcUrls: ["https://user-1.example.com", "https://user-2.example.com"],
    publicRpcs: ["https://registry-1.example.com", "https://registry-2.example.com"],
  });

  const urls = getAllRpcUrls(config, "https://per-request.example.com");
  assertEquals(urls, [
    "https://per-request.example.com",  // 1. Per-request
    "https://user-1.example.com",        // 2. User RPCs
    "https://user-2.example.com",
    "https://operator-rpc.example.com",  // 3. Operator config
    "https://registry-1.example.com",    // 4. Registry
    "https://registry-2.example.com",
  ]);
});

Deno.test("getAllRpcUrls - deduplicates across levels", () => {
  const config = makeConfig({
    rpcUrl: "https://same-rpc.example.com",
    userRpcUrls: ["https://same-rpc.example.com"],
    publicRpcs: ["https://same-rpc.example.com", "https://other.example.com"],
  });

  const urls = getAllRpcUrls(config);
  assertEquals(urls, [
    "https://same-rpc.example.com",
    "https://other.example.com",
  ]);
});

Deno.test("getAllRpcUrls - no per-request override", () => {
  const config = makeConfig({
    rpcUrl: "https://operator.example.com",
    userRpcUrls: ["https://user.example.com"],
    publicRpcs: ["https://registry.example.com"],
  });

  const urls = getAllRpcUrls(config);
  assertEquals(urls, [
    "https://user.example.com",
    "https://operator.example.com",
    "https://registry.example.com",
  ]);
});

Deno.test("getAllRpcUrls - empty user RPCs", () => {
  const config = makeConfig({
    rpcUrl: "https://registry-default.example.com",
    userRpcUrls: [],
    publicRpcs: ["https://registry-default.example.com", "https://registry-2.example.com"],
  });

  const urls = getAllRpcUrls(config);
  assertEquals(urls, [
    "https://registry-default.example.com",
    "https://registry-2.example.com",
  ]);
});
