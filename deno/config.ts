/**
 * Deno-specific configuration loader.
 *
 * Reads environment variables via Deno.env and returns a BundlerConfig.
 */

import type { BundlerConfig } from "../shared/config/types.ts";
import { computeSplitterAddress } from "../shared/contracts/splitter.ts";

function env(key: string, defaultValue?: string): string {
  const value = Deno.env.get(key) ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envHex(key: string, defaultValue?: string): `0x${string}` {
  const v = env(key, defaultValue);
  if (!v.startsWith("0x")) throw new Error(`${key} must start with 0x`);
  return v as `0x${string}`;
}

function envOptional(key: string): string | undefined {
  return Deno.env.get(key);
}

function envCsv(key: string): string[] {
  const raw = envOptional(key);
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Load global bundler configuration.
 * No chain-specific resolution at startup — that happens lazily per-request.
 */
export function loadConfig(treasuryAddress: `0x${string}`): BundlerConfig {
  const operatorSecret = env("OPERATOR_SECRET");

  const eip1559Env = envOptional("USE_EIP1559");
  const useEip1559 = eip1559Env !== undefined ? eip1559Env === "true" : true;

  return {
    // Per-chain defaults — overridden by ChainRegistry at runtime
    chainId: 0,
    rpcUrl: "",
    publicRpcs: [],
    chainInfo: null,

    entryPointAddress: envHex("ENTRY_POINT_ADDRESS", "0x0000000071727De22E5E9d8BAf0edAc6f37da032"),

    port: parseInt(env("PORT", "3300")),
    host: env("HOST", "0.0.0.0"),

    bundlingMode: env("BUNDLING_MODE", "auto") as "auto" | "manual",
    maxBundleSize: parseInt(env("MAX_BUNDLE_SIZE", "10")),
    maxBundleGas: BigInt(env("MAX_BUNDLE_GAS", "5000000")),
    minPriorityFeePerGas: BigInt(env("MIN_PRIORITY_FEE_PER_GAS", "0")),

    minProfitMarginBps: parseInt(env("MIN_PROFIT_MARGIN_BPS", "1000")),
    maxProfitMarginBps: parseInt(env("MAX_PROFIT_MARGIN_BPS", "15000")),
    // Relayer fee = walletGasMarkup × on-chain cost. Default 100% → user pays ~2×
    // the network fee (one part to the chain, one to the relayer). Single source of
    // truth for the price; quoted via pimlico_getUserOperationGasPrice.
    walletGasMarkup: 1 + parseInt(env("WALLET_GAS_MARGIN_PERCENT", "100")) / 100,

    useEip1559,
    baseFeeMultiplier: parseFloat(env("BASE_FEE_MULTIPLIER", "1.25")),
    bundlerTipGwei: parseFloat(env("BUNDLER_TIP_GWEI", "0.5")),

    autoBundleIntervalMs: parseInt(env("AUTO_BUNDLE_INTERVAL_MS", "10000")),

    operatorSecret,
    oldOperatorSecrets: envCsv("OLD_OPERATOR_SECRETS"),
    treasuryAddress,
    splitterAddress: computeSplitterAddress(treasuryAddress),
    apiRateLimitPerMinute: parseInt(env("API_RATE_LIMIT_PER_MINUTE", "60")),
    balanceReserveMultiplier: parseFloat(env("BALANCE_RESERVE_MULTIPLIER", "1")),
    alchemyApiKey: envOptional("ALCHEMY_API_KEY") ?? null,
  };
}
