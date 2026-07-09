/**
 * Tests for chain registry — resolving RPC endpoints from chainId.
 */

import { assertEquals, assert, assertRejects } from "@std/assert";
import {
  fetchChainInfo,
  filterPublicRpcUrls,
  chainSupportsEip1559,
  pickBestRpc,
} from "../shared/config/chain-registry.ts";

// --- filterPublicRpcUrls ---

Deno.test("filterPublicRpcUrls - keeps only HTTPS, no WSS", () => {
  const input = [
    "https://rpc.example.com",
    "wss://ws.example.com",
    "http://insecure.example.com",
    "https://another.example.com",
  ];
  const result = filterPublicRpcUrls(input);
  assertEquals(result, [
    "https://rpc.example.com",
    "https://another.example.com",
  ]);
});

Deno.test("filterPublicRpcUrls - excludes template variable URLs", () => {
  const input = [
    "https://mainnet.infura.io/v3/${INFURA_API_KEY}",
    "https://cloudflare-eth.com",
    "https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}",
    "https://rpc.ankr.com/eth",
  ];
  const result = filterPublicRpcUrls(input);
  assertEquals(result, [
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ]);
});

Deno.test("filterPublicRpcUrls - empty input returns empty", () => {
  assertEquals(filterPublicRpcUrls([]), []);
});

// --- chainSupportsEip1559 ---

Deno.test("chainSupportsEip1559 - true when EIP1559 in features", () => {
  assert(
    chainSupportsEip1559({
      features: [{ name: "EIP155" }, { name: "EIP1559" }],
    } as Parameters<typeof chainSupportsEip1559>[0]),
  );
});

Deno.test("chainSupportsEip1559 - false when no EIP1559 feature", () => {
  assert(
    !chainSupportsEip1559({
      features: [{ name: "EIP155" }],
    } as Parameters<typeof chainSupportsEip1559>[0]),
  );
});

Deno.test("chainSupportsEip1559 - false when no features field", () => {
  assert(
    !chainSupportsEip1559({} as Parameters<typeof chainSupportsEip1559>[0]),
  );
});

// --- fetchChainInfo (live network calls) ---

Deno.test("fetchChainInfo - fetches Ethereum mainnet (chainId 1)", async () => {
  const info = await fetchChainInfo(1);
  assertEquals(info.chainId, 1);
  assertEquals(info.name, "Ethereum Mainnet");
  assert(info.rpc.length > 0, "Should have RPC endpoints");
  assertEquals(info.nativeCurrency.symbol, "ETH");
});

Deno.test("fetchChainInfo - fetches Polygon (chainId 137)", async () => {
  const info = await fetchChainInfo(137);
  assertEquals(info.chainId, 137);
  assert(info.name.includes("Polygon"));
  assert(info.rpc.length > 0);
});

Deno.test("fetchChainInfo - fetches Arbitrum One (chainId 42161)", async () => {
  const info = await fetchChainInfo(42161);
  assertEquals(info.chainId, 42161);
  assert(info.rpc.length > 0);
});

Deno.test("fetchChainInfo - fetches Base (chainId 8453)", async () => {
  const info = await fetchChainInfo(8453);
  assertEquals(info.chainId, 8453);
  assert(info.rpc.length > 0);
});

Deno.test("fetchChainInfo - rejects unsupported chainId", async () => {
  await assertRejects(
    () => fetchChainInfo(99999999),
    Error,
    "not supported",
  );
});

// --- Integration: filter real chain RPCs ---

Deno.test("Ethereum mainnet has usable public RPCs after filtering", async () => {
  const info = await fetchChainInfo(1);
  const publicRpcs = filterPublicRpcUrls(info.rpc);
  assert(publicRpcs.length > 0, `Expected public RPCs, got: ${publicRpcs}`);
  // All should be HTTPS
  for (const url of publicRpcs) {
    assert(url.startsWith("https://"), `Expected HTTPS: ${url}`);
    assert(!url.includes("${"), `Should not contain template vars: ${url}`);
  }
});

// --- pickBestRpc ---

Deno.test("pickBestRpc - returns a working RPC for Ethereum mainnet", async () => {
  const info = await fetchChainInfo(1);
  const publicRpcs = filterPublicRpcUrls(info.rpc);
  const best = await pickBestRpc(publicRpcs, 1);
  assert(best.startsWith("https://"));
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
    telegramBotToken: null, telegramChatId: null, treasuryAlertThresholdWei: 0n, treasuryAlertThresholdPathUsd: 0n,
  };
}

Deno.test("ChainRegistry.dispose - clears the health timer without leaking (idempotent)", () => {
  // The Deno test resource sanitizer fails this test if the 30s health interval leaks —
  // so a passing test proves dispose() released it. Also assert double-dispose is safe.
  const config = fullConfig();
  const keyManager = new LocalKeyManager({ operatorSecret: config.operatorSecret });
  const registry = new ChainRegistry(config, keyManager);
  registry.dispose();
  registry.dispose();
});
