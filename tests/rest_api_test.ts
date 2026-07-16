/**
 * Tests for REST API handlers (shared/rpc/rest-api.ts).
 *
 * Uses mock ChainServices to test routing, parameter validation, and response
 * formatting without RPC dependencies.
 */

import { it, expect } from "vitest";
import { handleRestApi } from "../shared/rpc/rest-api.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { ChainRegistryLike } from "../shared/chain/index.ts";
import type { RateLimitConfig } from "../shared/auth/index.ts";

// --- Mock helpers ---

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;
const TREASURY = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

function mockConfig(): BundlerConfig {
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
    treasuryAddress: TREASURY,
    splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    apiRateLimitPerMinute: 60,
    rateLimitAllowlist: [],
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
    telegramBotToken: null,
    telegramChatId: null,
    treasuryAlertThresholdWei: 0n,
    treasuryAlertThresholdPathUsd: 0n,
  } as BundlerConfig;
}

function mockRateLimitConfig(): RateLimitConfig {
  return { rateLimitPerMinute: 1000 };
}

function mockChainRegistry(): ChainRegistryLike {
  return {
    async getChain() { throw new Error("chain not available"); },
    getAll() { return []; },
  };
}

// --- Tests ---

it("handleRestApi - returns null for non-v1 paths", async () => {
  const req = new Request("http://localhost/health", { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result).toEqual(null);
});

it("handleRestApi - returns null for root path", async () => {
  const req = new Request("http://localhost/", { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result).toEqual(null);
});

it("handleRestApi - CORS preflight returns 204", async () => {
  const req = new Request("http://localhost/v1/treasury", { method: "OPTIONS" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  expect(result!.status).toEqual(204);
  expect(result!.headers.get("Access-Control-Allow-Origin")).toEqual("*");
});

it("handleRestApi - GET /v1/treasury returns treasury address", async () => {
  const req = new Request("http://localhost/v1/treasury", { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  expect(result!.status).toEqual(200);
  const body = await result!.json();
  expect(body.address).toEqual(TREASURY);
});

it("handleRestApi - GET /v1/splitter returns address + derivation inputs", async () => {
  const req = new Request("http://localhost/v1/splitter", { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  expect(result!.status).toEqual(200);
  const body = await result!.json();
  expect(body.address).toEqual("0x3979be163bFb74Dce66F8E0839577807C2197226");
  expect(body.treasury).toEqual(TREASURY);
  expect(body.factory).toEqual("0x4e59b44847b379578588920cA78FbF26c0B4956C");
  expect(body.salt).toEqual("0x650cb20978a0e7efdcf6f077240c609a59f2f02401ed16fb4a222a2b51cb9720");
});

it("handleRestApi - returns 404 for unknown v1 path", async () => {
  const req = new Request("http://localhost/v1/unknown", { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  expect(result!.status).toEqual(404);
  const body = await result!.json();
  expect(body.error).toEqual("Not found");
});

it("handleRestApi - GET /v1/account with invalid address pattern returns 404", async () => {
  // Address must be exactly 40 hex chars
  const req = new Request("http://localhost/v1/account/1/0xinvalid", { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  // The regex won't match, so it falls through to 404
  expect(result!.status).toEqual(404);
});

it("handleRestApi - GET /v1/account with chain resolution failure returns 500", async () => {
  const safeAddr = "0x" + "11".repeat(20);
  const req = new Request(`http://localhost/v1/account/1/${safeAddr}`, { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  expect(result!.status).toEqual(500);
  const body = await result!.json();
  expect(body.error).toEqual("Internal error");
});

it("handleRestApi - POST /v1/sponsor without sponsorService returns 404", async () => {
  const safeAddr = "0x" + "11".repeat(20);
  const req = new Request(`http://localhost/v1/sponsor/1/${safeAddr}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const url = new URL(req.url);
  // No sponsorService passed → falls through to 404
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  expect(result!.status).toEqual(404);
});

it("handleRestApi - CORS headers present on all v1 responses", async () => {
  const req = new Request("http://localhost/v1/treasury", { method: "GET" });
  const url = new URL(req.url);
  const result = await handleRestApi(req, url, mockChainRegistry(), mockConfig(), mockRateLimitConfig());
  expect(result !== null).toBeTruthy();
  expect(result!.headers.get("Access-Control-Allow-Origin")).toEqual("*");
  expect(result!.headers.get("Access-Control-Allow-Methods")!.includes("GET")).toBeTruthy();
  expect(result!.headers.get("Access-Control-Allow-Methods")!.includes("POST")).toBeTruthy();
});

it("handleRestApi - POST /v1/sponsor parses dryRun + requiredWei and passes them through", async () => {
  const safeAddr = "0x" + "22".repeat(20);
  const captured: { args?: unknown[] } = {};
  const stubSponsor = {
    sponsor(...args: unknown[]) {
      captured.args = args;
      return Promise.resolve({ sponsored: false, dryRun: true, eligible: true });
    },
  };
  const registry: ChainRegistryLike = {
    getChain() {
      return Promise.resolve({
        rpcUrl: "https://trusted.example.com",
        accountService: {
          deriveEOA: () => Promise.resolve({ address: "0x" + "33".repeat(20) }),
        },
      } as never);
    },
  } as unknown as ChainRegistryLike;

  const req = new Request(`http://localhost/v1/sponsor/1/${safeAddr}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requiredWei: "0x3e8", dryRun: true }),
  });
  const url = new URL(req.url);
  const result = await handleRestApi(
    req,
    url,
    registry,
    mockConfig(),
    mockRateLimitConfig(),
    undefined,
    stubSponsor as never,
  );
  expect(result !== null).toBeTruthy();
  expect(result!.status).toEqual(200);
  const body = await result!.json();
  expect(body).toEqual({ sponsored: false, dryRun: true, eligible: true });
  // sponsor(chainId, safe, relayer, trustedRpc, requiredWei, dryRun)
  expect(captured.args![0]).toEqual(1);
  expect(captured.args![1]).toEqual(safeAddr.toLowerCase());
  expect(captured.args![3]).toEqual("https://trusted.example.com");
  expect(captured.args![4]).toEqual(1000n);
  expect(captured.args![5]).toEqual(true);
});
