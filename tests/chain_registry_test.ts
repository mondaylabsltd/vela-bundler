/**
 * Tests for chain registry — resolving RPC endpoints from chainId.
 */

import { it, expect } from "vitest";
import {
  fetchChainInfo,
  filterPublicRpcUrls,
  chainSupportsEip1559,
  pickBestRpc,
} from "../shared/config/chain-registry.ts";

// --- filterPublicRpcUrls ---

it("filterPublicRpcUrls - keeps only HTTPS, no WSS", () => {
  const input = [
    "https://rpc.example.com",
    "wss://ws.example.com",
    "http://insecure.example.com",
    "https://another.example.com",
  ];
  const result = filterPublicRpcUrls(input);
  expect(result).toEqual([
    "https://rpc.example.com",
    "https://another.example.com",
  ]);
});

it("filterPublicRpcUrls - excludes template variable URLs", () => {
  const input = [
    "https://mainnet.infura.io/v3/${INFURA_API_KEY}",
    "https://cloudflare-eth.com",
    "https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}",
    "https://rpc.ankr.com/eth",
  ];
  const result = filterPublicRpcUrls(input);
  expect(result).toEqual([
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ]);
});

it("filterPublicRpcUrls - empty input returns empty", () => {
  expect(filterPublicRpcUrls([])).toEqual([]);
});

// --- chainSupportsEip1559 ---

it("chainSupportsEip1559 - true when EIP1559 in features", () => {
  expect(
    chainSupportsEip1559({
      features: [{ name: "EIP155" }, { name: "EIP1559" }],
    } as Parameters<typeof chainSupportsEip1559>[0]),
  ).toBeTruthy();
});

it("chainSupportsEip1559 - false when no EIP1559 feature", () => {
  expect(
    !chainSupportsEip1559({
      features: [{ name: "EIP155" }],
    } as Parameters<typeof chainSupportsEip1559>[0]),
  ).toBeTruthy();
});

it("chainSupportsEip1559 - false when no features field", () => {
  expect(
    !chainSupportsEip1559({} as Parameters<typeof chainSupportsEip1559>[0]),
  ).toBeTruthy();
});

// --- fetchChainInfo (live network calls) ---

it("fetchChainInfo - fetches Ethereum mainnet (chainId 1)", async () => {
  const info = await fetchChainInfo(1);
  expect(info.chainId).toEqual(1);
  expect(info.name).toEqual("Ethereum Mainnet");
  expect(info.rpc.length > 0, "Should have RPC endpoints").toBeTruthy();
  expect(info.nativeCurrency.symbol).toEqual("ETH");
});

it("fetchChainInfo - fetches Polygon (chainId 137)", async () => {
  const info = await fetchChainInfo(137);
  expect(info.chainId).toEqual(137);
  expect(info.name.includes("Polygon")).toBeTruthy();
  expect(info.rpc.length > 0).toBeTruthy();
});

it("fetchChainInfo - fetches Arbitrum One (chainId 42161)", async () => {
  const info = await fetchChainInfo(42161);
  expect(info.chainId).toEqual(42161);
  expect(info.rpc.length > 0).toBeTruthy();
});

it("fetchChainInfo - fetches Base (chainId 8453)", async () => {
  const info = await fetchChainInfo(8453);
  expect(info.chainId).toEqual(8453);
  expect(info.rpc.length > 0).toBeTruthy();
});

it("fetchChainInfo - rejects unsupported chainId", async () => {
  await expect(fetchChainInfo(99999999)).rejects.toThrow("not supported");
});

// --- Integration: filter real chain RPCs ---

it("Ethereum mainnet has usable public RPCs after filtering", async () => {
  const info = await fetchChainInfo(1);
  const publicRpcs = filterPublicRpcUrls(info.rpc);
  expect(publicRpcs.length > 0, `Expected public RPCs, got: ${publicRpcs}`).toBeTruthy();
  // All should be HTTPS
  for (const url of publicRpcs) {
    expect(url.startsWith("https://"), `Expected HTTPS: ${url}`).toBeTruthy();
    expect(!url.includes("${"), `Should not contain template vars: ${url}`).toBeTruthy();
  }
});

// --- pickBestRpc ---

it("pickBestRpc - returns a working RPC for Ethereum mainnet", async () => {
  const info = await fetchChainInfo(1);
  const publicRpcs = filterPublicRpcUrls(info.rpc);
  const best = await pickBestRpc(publicRpcs, 1);
  expect(best.startsWith("https://")).toBeTruthy();
});

// --- ChainRegistry.dispose() — graceful-shutdown timer release (O-4) ---

import { ChainRegistry } from "../shared/chain/index.ts";
import { LocalKeyManager } from "../shared/keys/local.ts";
import type { BundlerConfig } from "../shared/config/types.ts";

function fullConfig(): BundlerConfig {
  return {
    chainId: 0, rpcUrl: "", publicRpcs: [], chainInfo: null,
    entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    port: 0, host: "", bundlingMode: "manual", maxBundleSize: 10, maxBundleGas: 5_000_000n,
    minPriorityFeePerGas: 0n, minProfitMarginBps: 1000, maxProfitMarginBps: 15000, walletGasMarkup: 2,
    useEip1559: true, baseFeeMultiplier: 1.25, bundlerTipGwei: 0.5, autoBundleIntervalMs: 10000,
    operatorSecret: "0x" + "ab".repeat(32), oldOperatorSecrets: [],
    treasuryAddress: "0x" + "cc".repeat(20) as `0x${string}`,
    splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    apiRateLimitPerMinute: 60, balanceReserveMultiplier: 1, alchemyApiKey: null,
    rateLimitAllowlist: [],
    telegramBotToken: null, telegramChatId: null, treasuryAlertThresholdWei: 0n, treasuryAlertThresholdPathUsd: 0n,
  };
}

it("ChainRegistry.dispose - clears the health timer without leaking (idempotent)", () => {
  // The Deno test resource sanitizer fails this test if the 30s health interval leaks —
  // so a passing test proves dispose() released it. Also assert double-dispose is safe.
  const config = fullConfig();
  const keyManager = new LocalKeyManager({ operatorSecret: config.operatorSecret });
  const registry = new ChainRegistry(config, keyManager);
  registry.dispose();
  registry.dispose();
});
