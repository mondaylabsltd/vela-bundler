/**
 * CF Worker config builder — reads from env bindings instead of Deno.env.
 */

import type { Env } from "./types.ts";
import type { BundlerConfig } from "../shared/config/types.ts";

/**
 * Build BundlerConfig from Cloudflare Worker environment bindings.
 */
export function buildConfig(env: Env, treasuryAddress: `0x${string}`): BundlerConfig {
  return {
    // Per-chain defaults — overridden when initializing the DO
    chainId: 0,
    rpcUrl: "",
    publicRpcs: [],
    chainInfo: null,

    entryPointAddress: (env.ENTRY_POINT_ADDRESS ?? "0x0000000071727De22E5E9d8BAf0edAc6f37da032") as `0x${string}`,

    port: 0,   // unused in worker
    host: "",  // unused in worker

    bundlingMode: (env.BUNDLING_MODE ?? "auto") as "auto" | "manual",
    maxBundleSize: parseInt(env.MAX_BUNDLE_SIZE ?? "10"),
    maxBundleGas: BigInt(env.MAX_BUNDLE_GAS ?? "5000000"),
    minPriorityFeePerGas: BigInt(env.MIN_PRIORITY_FEE_PER_GAS ?? "0"),

    minProfitMarginBps: parseInt(env.MIN_PROFIT_MARGIN_BPS ?? "1000"),
    maxProfitMarginBps: parseInt(env.MAX_PROFIT_MARGIN_BPS ?? "15000"),
    walletGasMarkup: 1 + parseInt(env.WALLET_GAS_MARGIN_PERCENT ?? "50") / 100,

    useEip1559: true,
    baseFeeMultiplier: parseFloat(env.BASE_FEE_MULTIPLIER ?? "1.25"),
    bundlerTipGwei: parseFloat(env.BUNDLER_TIP_GWEI ?? "0.5"),

    autoBundleIntervalMs: parseInt(env.AUTO_BUNDLE_INTERVAL_MS ?? "10000"),

    operatorSecret: env.OPERATOR_SECRET,
    oldOperatorSecrets: (env.OLD_OPERATOR_SECRETS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    treasuryAddress,
    sweepInterval: parseInt(env.SWEEP_INTERVAL ?? "30"),
    apiRateLimitPerMinute: parseInt(env.API_RATE_LIMIT_PER_MINUTE ?? "60"),
    balanceReserveMultiplier: parseFloat(env.BALANCE_RESERVE_MULTIPLIER ?? "1"),
    alchemyApiKey: env.ALCHEMY_API_KEY || null,
  };
}
