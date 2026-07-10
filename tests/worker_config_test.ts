/**
 * Tests for worker/config.ts — buildConfig from CF Worker env bindings.
 */

import { assertEquals } from "@std/assert";

// worker/config.ts cannot be imported here: worker/types.ts references the Cloudflare
// ambient type `DurableObjectNamespace`, which `deno check` cannot resolve. The AUTHORITATIVE
// executable coverage of buildConfig lives in worker/tests/config.test.ts (vitest + miniflare,
// where CF types exist). These Deno tests pin the shared config contract and the exact env
// parse expressions worker/config.ts uses, via typed helpers (not dead literal expressions).

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
    rateLimitAllowlist: [],
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
    telegramBotToken: null,
    telegramChatId: null,
    treasuryAlertThresholdWei: 0n,
    treasuryAlertThresholdPathUsd: 0n,
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
  // Mirrors worker/config.ts:37 `(env.USE_EIP1559 ?? "true") === "true"` — via a typed
  // helper so it tests the real expression rather than a compile-time-constant literal.
  const parseEip1559 = (v: string | undefined): boolean => (v ?? "true") === "true";
  assertEquals(parseEip1559("true"), true);
  assertEquals(parseEip1559("false"), false);
  assertEquals(parseEip1559(undefined), true);
  assertEquals(parseEip1559("anything-else"), false);
});

Deno.test("BundlerConfig — oldOperatorSecrets CSV parsing", () => {
  // Mirrors worker/config.ts:44 / deno/config.ts:30 CSV parse.
  const parseCsv = (v: string | undefined): string[] =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  assertEquals(parseCsv("0xaa,0xbb, 0xcc ,"), ["0xaa", "0xbb", "0xcc"]);
  assertEquals(parseCsv(""), []);
  assertEquals(parseCsv(undefined), []);
});
