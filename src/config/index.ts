/**
 * Bundler configuration.
 *
 * Only OPERATOR_SECRET and TREASURY_ADDRESS are required.
 * Everything else has sensible defaults.
 */

import { resolveChain, type ChainInfo } from "./chain-registry.ts";

export type { ChainInfo };
export { resolveChain, fetchChainInfo, filterPublicRpcUrls } from "./chain-registry.ts";

export interface BundlerConfig {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly userRpcUrls: string[];
  readonly publicRpcs: string[];
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

export async function loadConfig(): Promise<BundlerConfig> {
  // --- Only two required env vars ---
  const operatorSecret = env("OPERATOR_SECRET");
  const treasuryAddress = envHex("TREASURY_ADDRESS");

  // --- Everything else has defaults ---
  const chainId = parseInt(env("CHAIN_ID", "1"));
  const manualRpcUrl = envOptional("RPC_URL");
  const userRpcUrls = envCsv("USER_RPC_URLS");

  // Resolve RPC from registry
  let registryRpcUrl: string | null = null;
  let publicRpcs: string[] = [];
  let chainInfo: ChainInfo | null = null;
  let registryEip1559 = false;

  const isLocalDev = manualRpcUrl?.startsWith("http://localhost") ||
    manualRpcUrl?.startsWith("http://127.0.0.1");

  if (!isLocalDev) {
    try {
      const resolved = await resolveChain(chainId);
      registryRpcUrl = resolved.rpcUrl;
      publicRpcs = resolved.publicRpcs;
      chainInfo = resolved.chain;
      registryEip1559 = resolved.supportsEip1559;
    } catch (err) {
      if (userRpcUrls.length === 0 && !manualRpcUrl) throw err;
      console.warn(`[Config] Registry lookup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  let rpcUrl: string;
  if (userRpcUrls.length > 0) {
    rpcUrl = userRpcUrls[0]!;
  } else if (manualRpcUrl) {
    rpcUrl = manualRpcUrl;
  } else if (registryRpcUrl) {
    rpcUrl = registryRpcUrl;
  } else {
    throw new Error("No RPC available: set USER_RPC_URLS, RPC_URL, or use a supported CHAIN_ID");
  }

  const eip1559Env = envOptional("USE_EIP1559");
  const useEip1559 = eip1559Env !== undefined
    ? eip1559Env === "true"
    : (chainInfo ? registryEip1559 : true);

  return {
    chainId,
    rpcUrl,
    userRpcUrls,
    publicRpcs,
    chainInfo,
    entryPointAddress: envHex("ENTRY_POINT_ADDRESS", "0x0000000071727De22E5E9d8BAf0edAc6f37da032"),

    port: parseInt(env("PORT", "3300")),
    host: env("HOST", "0.0.0.0"),

    bundlingMode: env("BUNDLING_MODE", "auto") as "auto" | "manual",
    maxBundleSize: parseInt(env("MAX_BUNDLE_SIZE", "10")),
    maxBundleGas: BigInt(env("MAX_BUNDLE_GAS", "5000000")),
    minPriorityFeePerGas: BigInt(env("MIN_PRIORITY_FEE_PER_GAS", "1000000000")),

    minProfitMarginBps: parseInt(env("MIN_PROFIT_MARGIN_BPS", "2000")),
    targetProfitMarginBps: parseInt(env("TARGET_PROFIT_MARGIN_BPS", "3500")),
    highRiskMarginBps: parseInt(env("HIGH_RISK_MARGIN_BPS", "5000")),

    useEip1559,
    baseFeeMultiplier: parseFloat(env("BASE_FEE_MULTIPLIER", "1.25")),
    bundlerTipGwei: parseFloat(env("BUNDLER_TIP_GWEI", "1.5")),

    autoBundleIntervalMs: parseInt(env("AUTO_BUNDLE_INTERVAL_MS", "10000")),

    operatorSecret,
    oldOperatorSecrets: envCsv("OLD_OPERATOR_SECRETS"),
    treasuryAddress,
    sweepInterval: parseInt(env("SWEEP_INTERVAL", "30")),
    apiRateLimitPerMinute: parseInt(env("API_RATE_LIMIT_PER_MINUTE", "60")),
    balanceReserveMultiplier: parseInt(env("BALANCE_RESERVE_MULTIPLIER", "2")),
  };
}
