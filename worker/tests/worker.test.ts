/**
 * Executable coverage for the Cloudflare Worker runtime (vitest + @cloudflare/vitest-pool-workers).
 *
 * These are the FIRST real tests for the worker/ layer — previously vitest.config.ts pointed at
 * this (nonexistent) directory and `npm run test:worker` exited 1 with "No test files found".
 *
 * Scope: the network-free surfaces of the entry handler (worker/index.ts) and the config builder
 * (worker/config.ts). Paths that dispatch into a BundlerDO trigger a real chain resolution
 * (resolveChain → external HTTP), so they are intentionally NOT exercised here to keep the suite
 * hermetic; DO-internal logic (locks, reservations, pending-receipt restore) is covered by the
 * Deno suite (tests/bundler_pending_persistence_test.ts, tests/account_test.ts, …).
 */

import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { buildConfig } from "../config.ts";
import type { Env } from "../types.ts";
import { computeSplitterAddress } from "../../shared/contracts/splitter.ts";

const TREASURY = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

function mkEnv(overrides: Partial<Env> = {}): Env {
  return { OPERATOR_SECRET: "0x" + "ab".repeat(32), ...overrides } as Env;
}

describe("worker/config.ts buildConfig", () => {
  it("applies documented defaults with a minimal env", () => {
    const cfg = buildConfig(mkEnv(), TREASURY);
    expect(cfg.entryPointAddress).toBe("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
    expect(cfg.bundlingMode).toBe("auto");
    expect(cfg.maxBundleSize).toBe(10);
    expect(cfg.maxBundleGas).toBe(5_000_000n);
    expect(cfg.minProfitMarginBps).toBe(1000);
    expect(cfg.maxProfitMarginBps).toBe(15000);
    expect(cfg.walletGasMarkup).toBe(2); // 1 + 100/100
    expect(cfg.useEip1559).toBe(true);
    expect(cfg.apiRateLimitPerMinute).toBe(60);
    expect(cfg.balanceReserveMultiplier).toBe(1);
    expect(cfg.alchemyApiKey).toBeNull();
    expect(cfg.treasuryAddress).toBe(TREASURY);
    expect(cfg.splitterAddress).toBe(computeSplitterAddress(TREASURY));
  });

  it("parses overrides from env strings", () => {
    const cfg = buildConfig(mkEnv({
      USE_EIP1559: "false",
      MAX_BUNDLE_SIZE: "5",
      WALLET_GAS_MARGIN_PERCENT: "50",
      API_RATE_LIMIT_PER_MINUTE: "120",
      OLD_OPERATOR_SECRETS: "0xaa, 0xbb ,",
      ALCHEMY_API_KEY: "key123",
    }), TREASURY);
    expect(cfg.useEip1559).toBe(false);
    expect(cfg.maxBundleSize).toBe(5);
    expect(cfg.walletGasMarkup).toBe(1.5);
    expect(cfg.apiRateLimitPerMinute).toBe(120);
    expect(cfg.oldOperatorSecrets).toEqual(["0xaa", "0xbb"]);
    expect(cfg.alchemyApiKey).toBe("key123");
  });
});

describe("worker/index.ts entry routing (network-free paths)", () => {
  it("answers CORS preflight with 204", async () => {
    const res = await SELF.fetch("https://bundler.example/1", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves the homepage", async () => {
    const res = await SELF.fetch("https://bundler.example/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("Vela Bundler");
  });

  it("returns global health ok", async () => {
    const res = await SELF.fetch("https://bundler.example/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { service: string; status: string; runtime: string };
    expect(body.service).toBe("vela-bundler");
    expect(body.status).toBe("ok");
    expect(body.runtime).toBe("cloudflare-workers");
  });

  it("derives the treasury address from OPERATOR_SECRET at /v1/treasury", async () => {
    const res = await SELF.fetch("https://bundler.example/v1/treasury");
    expect(res.status).toBe(200);
    const body = await res.json() as { address: string };
    expect(body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("exposes the splitter derivation inputs at /v1/splitter, consistent with the treasury", async () => {
    const treasuryRes = await SELF.fetch("https://bundler.example/v1/treasury");
    const { address: treasury } = await treasuryRes.json() as { address: `0x${string}` };
    const res = await SELF.fetch("https://bundler.example/v1/splitter");
    expect(res.status).toBe(200);
    const body = await res.json() as { address: string; treasury: string; factory: string; salt: string };
    expect(body.treasury.toLowerCase()).toBe(treasury.toLowerCase());
    expect(body.address).toBe(computeSplitterAddress(treasury));
    expect(body.factory).toBe("0x4e59b44847b379578588920cA78FbF26c0B4956C");
  });

  it("rejects an unroutable request with 405", async () => {
    const res = await SELF.fetch("https://bundler.example/not-a-chain", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("routes GET /health/:chainId to the DO without forcing a chain init (read-only)", async () => {
    // O-3: per-chain health must be reachable. On a cold DO (never used) it reports
    // "uninitialized" — critically, it does NOT do a network resolveChain / create a live
    // chain, so this stays hermetic.
    const res = await SELF.fetch("https://bundler.example/health/8453");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; chainId: number };
    // Cold DO → uninitialized (a warm one would report ok/degraded with real fields).
    expect(["uninitialized", "ok", "degraded"]).toContain(body.status);
    // Must echo the REQUESTED chain id, not 0 (regression for the review finding).
    expect(body.chainId).toBe(8453);
  });

  it("has a valid OPERATOR_SECRET binding in the test env", () => {
    // Guards against a miniflare binding regression that would make every derivation throw.
    expect(env.OPERATOR_SECRET).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});

describe("chain-registry DO + storage-only liveness probe", () => {
  it("registry-add is idempotent and registry-list enumerates activated chains", async () => {
    const bundler = (env as unknown as Env).BUNDLER;
    const registry = bundler.get(bundler.idFromName("chain-registry"));
    await registry.fetch("https://bundler-do/registry-add?chain=137", { method: "POST" });
    await registry.fetch("https://bundler-do/registry-add?chain=1", { method: "POST" });
    await registry.fetch("https://bundler-do/registry-add?chain=137", { method: "POST" }); // replay
    await registry.fetch("https://bundler-do/registry-add?chain=0", { method: "POST" });   // invalid → ignored
    const res = await registry.fetch("https://bundler-do/registry-list");
    const body = await res.json() as { chains: number[] };
    expect(body.chains.sort((a, b) => a - b)).toEqual([1, 137]);
  });

  it("ensure-alarm on a never-activated DO reports unknown WITHOUT initializing the chain", async () => {
    // The probe must be storage-only: force-initializing here would resurrect every
    // abandoned user-RPC testnet on each cron pass (resolveChain fetches + alert noise).
    const bundler = (env as unknown as Env).BUNDLER;
    const stub = bundler.get(bundler.idFromName("chain-999999"));
    const res = await stub.fetch("https://bundler-do/ensure-alarm");
    const body = await res.json() as { rearmed: boolean; unknown?: boolean };
    expect(body.rearmed).toBe(false);
    expect(body.unknown).toBe(true);
  });
});
