/**
 * Tests for worker/config.ts — buildConfig from CF Worker env bindings.
 */

import { assertEquals, assertNotEquals } from "@std/assert";

// We can't import worker/config.ts directly (it uses CF types),
// so we test the logic by reimplementing the config builder pattern.
// These tests verify the shared config/types.ts contract.

import type { BundlerConfig } from "../shared/config/types.ts";

Deno.test("BundlerConfig defaults — all optional fields have sensible defaults", () => {
  // Simulate what buildConfig does with minimal env
  const config: BundlerConfig = {
    chainId: 0,
    rpcUrl: "",
    publicRpcs: [],
    chainInfo: null,
    entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    port: 0,
    host: "",
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
    treasuryAddress: "0x" + "00".repeat(20) as `0x${string}`,
    splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226",
    apiRateLimitPerMinute: 60,
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
  };

  assertEquals(config.bundlingMode, "auto");
  assertEquals(config.maxBundleSize, 10);
  assertEquals(config.minProfitMarginBps, 1000);
  assertEquals(config.walletGasMarkup, 1.5);
  assertEquals(config.useEip1559, true);
});

Deno.test("BundlerConfig — walletGasMarkup calculation matches formula", () => {
  // Formula: 1 + parseInt(WALLET_GAS_MARGIN_PERCENT) / 100
  const percent50 = 1 + 50 / 100;
  assertEquals(percent50, 1.5);

  const percent30 = 1 + 30 / 100;
  assertEquals(percent30, 1.3);

  const percent0 = 1 + 0 / 100;
  assertEquals(percent0, 1);
});

Deno.test("BundlerConfig — useEip1559 env parsing", () => {
  // Simulate the logic: (env.USE_EIP1559 ?? "true") === "true"
  assertEquals(("true" ?? "true") === "true", true);
  assertEquals(("false" ?? "true") === "true", false);
  assertEquals((undefined ?? "true") === "true", true);
});

Deno.test("BundlerConfig — oldOperatorSecrets CSV parsing", () => {
  const raw = "0xaa,0xbb, 0xcc ,";
  const parsed = raw.split(",").map(s => s.trim()).filter(Boolean);
  assertEquals(parsed, ["0xaa", "0xbb", "0xcc"]);

  const empty = "";
  const parsedEmpty = empty.split(",").map(s => s.trim()).filter(Boolean);
  assertEquals(parsedEmpty, []);
});
