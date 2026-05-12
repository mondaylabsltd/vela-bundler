/**
 * Bundler configuration.
 *
 * Only OPERATOR_SECRET and TREASURY_ADDRESS are required.
 * Multi-chain: chainId comes per-request, not from config.
 * Per-chain services (RPC, mempool, simulator) are lazily created.
 */

import type { ChainInfo } from "./chain-registry.ts";

export type { ChainInfo };
export { resolveChain, fetchChainInfo, filterPublicRpcUrls } from "./chain-registry.ts";

/**
 * Global config — chain-independent settings.
 * Per-chain fields (chainId, rpcUrl, etc.) are set by ChainRegistry at runtime.
 */
export interface BundlerConfig {
  /** Set per-chain at runtime by ChainRegistry. */
  readonly chainId: number;
  /** Set per-chain at runtime by ChainRegistry. */
  readonly rpcUrl: string;
  /** Set per-chain at runtime by ChainRegistry. */
  readonly publicRpcs: string[];
  /** Set per-chain at runtime by ChainRegistry. */
  readonly chainInfo: ChainInfo | null;

  readonly entryPointAddress: `0x${string}`;

  readonly port: number;
  readonly host: string;

  readonly bundlingMode: "auto" | "manual";
  readonly maxBundleSize: number;
  readonly maxBundleGas: bigint;
  readonly minPriorityFeePerGas: bigint;

  readonly minProfitMarginBps: number;
  readonly targetProfitMarginBps: number;
  readonly highRiskMarginBps: number;

  readonly useEip1559: boolean;
  readonly baseFeeMultiplier: number;
  readonly bundlerTipGwei: number;

  readonly autoBundleIntervalMs: number;

  readonly operatorSecret: string;
  readonly oldOperatorSecrets: string[];
  readonly treasuryAddress: `0x${string}`;
  readonly sweepInterval: number;
  readonly apiRateLimitPerMinute: number;
  readonly balanceReserveMultiplier: number;

  /** Alchemy API key. When set, Alchemy RPCs are preferred for supported chains. */
  readonly alchemyApiKey: string | null;
}

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
export function loadConfig(): BundlerConfig {
  const operatorSecret = env("OPERATOR_SECRET");
  const treasuryAddress = envHex("TREASURY_ADDRESS");

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
    minPriorityFeePerGas: BigInt(env("MIN_PRIORITY_FEE_PER_GAS", "1000000")),

    minProfitMarginBps: parseInt(env("MIN_PROFIT_MARGIN_BPS", "1000")),
    targetProfitMarginBps: parseInt(env("TARGET_PROFIT_MARGIN_BPS", "2000")),
    highRiskMarginBps: parseInt(env("HIGH_RISK_MARGIN_BPS", "3000")),

    useEip1559,
    baseFeeMultiplier: parseFloat(env("BASE_FEE_MULTIPLIER", "1.25")),
    bundlerTipGwei: parseFloat(env("BUNDLER_TIP_GWEI", "0.5")),

    autoBundleIntervalMs: parseInt(env("AUTO_BUNDLE_INTERVAL_MS", "10000")),

    operatorSecret,
    oldOperatorSecrets: envCsv("OLD_OPERATOR_SECRETS"),
    treasuryAddress,
    sweepInterval: parseInt(env("SWEEP_INTERVAL", "30")),
    apiRateLimitPerMinute: parseInt(env("API_RATE_LIMIT_PER_MINUTE", "60")),
    balanceReserveMultiplier: parseInt(env("BALANCE_RESERVE_MULTIPLIER", "2")),
    alchemyApiKey: envOptional("ALCHEMY_API_KEY") ?? null,
  };
}
