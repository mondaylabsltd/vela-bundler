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
 * Strict numeric env parsing — FAIL FAST at startup on a malformed value.
 * parseInt/parseFloat silently truncate trailing garbage ("10%" → 10, "1,25" → 1) and
 * NaN flows through half the config unnoticed until bundling silently misbehaves at
 * runtime; a fund-custody process must refuse to start instead.
 */
function envInt(key: string, def: string, opts?: { min?: number; max?: number }): number {
  return envNumeric(key, def, opts, true);
}

function envFloat(key: string, def: string, opts?: { min?: number; max?: number }): number {
  return envNumeric(key, def, opts, false);
}

function envNumeric(key: string, def: string, opts: { min?: number; max?: number } | undefined, integer: boolean): number {
  const raw = env(key, def);
  if (raw.trim() === "") throw new Error(`${key} is empty — set a ${integer ? "integer" : "number"} or unset it for the default (${def})`);
  const n = Number(raw); // Number() rejects trailing garbage that parseInt/parseFloat truncate
  if (!Number.isFinite(n)) throw new Error(`${key}="${raw}" is not a valid number`);
  if (integer && !Number.isInteger(n)) throw new Error(`${key}="${raw}" must be an integer`);
  if (opts?.min !== undefined && n < opts.min) throw new Error(`${key}=${n} is below the minimum ${opts.min}`);
  if (opts?.max !== undefined && n > opts.max) throw new Error(`${key}=${n} is above the maximum ${opts.max}`);
  return n;
}

function envBigInt(key: string, def: string): bigint {
  const raw = env(key, def);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${key}="${raw}" is not a valid integer (wei/units)`);
  }
}

/**
 * Load global bundler configuration.
 * No chain-specific resolution at startup — that happens lazily per-request.
 */
export function loadConfig(treasuryAddress: `0x${string}`): BundlerConfig {
  const operatorSecret = env("OPERATOR_SECRET");

  const eip1559Env = envOptional("USE_EIP1559");
  const useEip1559 = eip1559Env !== undefined ? eip1559Env === "true" : true;

  const config = {
    // Per-chain defaults — overridden by ChainRegistry at runtime
    chainId: 0,
    rpcUrl: "",
    publicRpcs: [],
    chainInfo: null,

    entryPointAddress: envHex("ENTRY_POINT_ADDRESS", "0x0000000071727De22E5E9d8BAf0edAc6f37da032"),

    port: envInt("PORT", "3300", { min: 1, max: 65535 }),
    host: env("HOST", "0.0.0.0"),

    bundlingMode: env("BUNDLING_MODE", "auto") as "auto" | "manual",
    maxBundleSize: envInt("MAX_BUNDLE_SIZE", "10", { min: 1 }),
    maxBundleGas: envBigInt("MAX_BUNDLE_GAS", "5000000"),
    minPriorityFeePerGas: envBigInt("MIN_PRIORITY_FEE_PER_GAS", "0"),

    minProfitMarginBps: envInt("MIN_PROFIT_MARGIN_BPS", "1000", { min: 0, max: 100_000 }),
    maxProfitMarginBps: envInt("MAX_PROFIT_MARGIN_BPS", "15000", { min: 0, max: 100_000 }),
    // Relayer fee = walletGasMarkup × on-chain cost. Default 100% → user pays ~2×
    // the network fee (one part to the chain, one to the relayer). Single source of
    // truth for the price; quoted via pimlico_getUserOperationGasPrice.
    walletGasMarkup: 1 + envInt("WALLET_GAS_MARGIN_PERCENT", "100", { min: 0, max: 10_000 }) / 100,

    useEip1559,
    baseFeeMultiplier: envFloat("BASE_FEE_MULTIPLIER", "1.25", { min: 1 }),
    bundlerTipGwei: envFloat("BUNDLER_TIP_GWEI", "0.5", { min: 0 }),

    autoBundleIntervalMs: envInt("AUTO_BUNDLE_INTERVAL_MS", "10000", { min: 1000 }),

    operatorSecret,
    oldOperatorSecrets: envCsv("OLD_OPERATOR_SECRETS"),
    treasuryAddress,
    splitterAddress: computeSplitterAddress(treasuryAddress),
    apiRateLimitPerMinute: envInt("API_RATE_LIMIT_PER_MINUTE", "60", { min: 1 }),
    rateLimitAllowlist: envCsv("RATE_LIMIT_ALLOWLIST"),
    balanceReserveMultiplier: envFloat("BALANCE_RESERVE_MULTIPLIER", "1", { min: 1 }),
    alchemyApiKey: envOptional("ALCHEMY_API_KEY") ?? null,

    telegramBotToken: envOptional("TELEGRAM_BOT_TOKEN") ?? null,
    telegramChatId: envOptional("TELEGRAM_CHAT_ID") ?? null,
    treasuryAlertThresholdWei: envBigInt("TREASURY_ALERT_THRESHOLD_WEI", "20000000000000000"), // 0.02 ETH
    treasuryAlertThresholdPathUsd: envBigInt("TREASURY_ALERT_THRESHOLD_PATHUSD", "500000"), // 0.5 pathUSD (6-dec)
  };
  if (config.minProfitMarginBps > config.maxProfitMarginBps) {
    throw new Error(
      `MIN_PROFIT_MARGIN_BPS (${config.minProfitMarginBps}) > MAX_PROFIT_MARGIN_BPS (${config.maxProfitMarginBps}) — every bundle would be rejected`,
    );
  }
  if (config.bundlingMode !== "auto" && config.bundlingMode !== "manual") {
    throw new Error(`BUNDLING_MODE="${config.bundlingMode}" must be "auto" or "manual"`);
  }
  return config;
}
