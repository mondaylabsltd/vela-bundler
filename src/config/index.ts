/**
 * Bundler configuration loaded from environment variables.
 *
 * Chain RPC is auto-resolved from https://ethereum-data.awesometools.dev/
 * based on CHAIN_ID. Only networks listed in that registry are supported.
 * RPC_URL can still be set manually to override (e.g. for local dev nodes).
 */

import { resolveChain, type ChainInfo } from "./chain-registry.ts";

export type { ChainInfo };
export { resolveChain, fetchChainInfo, filterPublicRpcUrls } from "./chain-registry.ts";

export interface BundlerConfig {
  readonly chainId: number;
  /**
   * Active RPC URL — resolved by priority:
   *   1. USER_RPC_URLS (user-provided, comma-separated)
   *   2. RPC_URL (operator-configured manual override)
   *   3. Registry auto-resolved (https://ethereum-data.awesometools.dev/)
   */
  readonly rpcUrl: string;
  /** User-provided RPC URLs (highest priority, from USER_RPC_URLS env). */
  readonly userRpcUrls: string[];
  /** All available public RPCs from registry. */
  readonly publicRpcs: string[];
  /** Chain metadata from registry (null if local-only dev mode). */
  readonly chainInfo: ChainInfo | null;

  readonly entryPointAddress: `0x${string}`;

  /**
   * Legacy beneficiary — in private mode, each bundle uses the dedicated EOA
   * as beneficiary. This field is kept for non-private / testing fallback.
   */
  readonly beneficiaryAddress: `0x${string}`;

  /**
   * Legacy signer key — in private mode, each bundle uses the derived EOA key.
   * This field is kept for non-private / testing fallback.
   */
  readonly privateKey: `0x${string}`;

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

  readonly mode: "production" | "testing";
  readonly autoBundleIntervalMs: number;

  // --- Private prepaid bundler config ---

  /** Operator secret for deterministic key derivation. Never log or expose. */
  readonly operatorSecret: string;
  /** Active key version for new deposit addresses. */
  readonly activeKeyVersion: string;
  /** Old key versions that are draining (no new ops accepted). */
  readonly drainingKeyVersions: string[];
  /** API authentication token for private endpoints. */
  readonly apiToken: string;
  /** Rate limit for API requests per minute per IP. */
  readonly apiRateLimitPerMinute: number;
  /** Balance reserve multiplier (default 2). */
  readonly balanceReserveMultiplier: number;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = Deno.env.get(key) ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvHex(key: string, defaultValue?: string): `0x${string}` {
  const v = getEnv(key, defaultValue);
  if (!v.startsWith("0x")) throw new Error(`${key} must be a hex string starting with 0x`);
  return v as `0x${string}`;
}

function getEnvOptional(key: string): string | undefined {
  return Deno.env.get(key);
}

/**
 * Load bundler configuration.
 */
export async function loadConfig(): Promise<BundlerConfig> {
  const chainId = parseInt(getEnv("CHAIN_ID"));
  const manualRpcUrl = getEnvOptional("RPC_URL");

  // Parse user-provided RPC URLs (comma-separated, highest priority)
  const userRpcRaw = getEnvOptional("USER_RPC_URLS");
  const userRpcUrls = userRpcRaw
    ? userRpcRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  let registryRpcUrl: string | null = null;
  let publicRpcs: string[] = [];
  let chainInfo: ChainInfo | null = null;
  let registryEip1559 = false;

  // Always resolve from registry to validate chain is supported + get metadata,
  // unless RPC_URL is set AND it's a local dev node (skip registry for local dev).
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
      // If user provided their own RPCs, registry failure is non-fatal
      if (userRpcUrls.length === 0 && !manualRpcUrl) {
        throw err;
      }
      console.warn(`[Config] Registry lookup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // RPC priority: userRpcUrls[0] > RPC_URL > registry
  let rpcUrl: string;
  if (userRpcUrls.length > 0) {
    rpcUrl = userRpcUrls[0]!;
    console.log(`[Config] Using user-provided RPC (highest priority): ${rpcUrl}`);
    if (userRpcUrls.length > 1) {
      console.log(`[Config] ${userRpcUrls.length - 1} additional user RPCs available as fallback`);
    }
  } else if (manualRpcUrl) {
    rpcUrl = manualRpcUrl;
    console.log(`[Config] Using operator RPC_URL: ${rpcUrl}`);
  } else if (registryRpcUrl) {
    rpcUrl = registryRpcUrl;
  } else {
    throw new Error("No RPC available: set USER_RPC_URLS, RPC_URL, or use a supported CHAIN_ID");
  }

  const eip1559Env = getEnvOptional("USE_EIP1559");
  const useEip1559 = eip1559Env !== undefined
    ? eip1559Env === "true"
    : (chainInfo ? registryEip1559 : true);

  // Parse draining key versions (comma-separated)
  const drainingRaw = getEnvOptional("DRAINING_KEY_VERSIONS");
  const drainingKeyVersions = drainingRaw
    ? drainingRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    chainId,
    rpcUrl,
    userRpcUrls,
    publicRpcs,
    chainInfo,

    entryPointAddress: getEnvHex(
      "ENTRY_POINT_ADDRESS",
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    ),
    beneficiaryAddress: getEnvHex(
      "BENEFICIARY_ADDRESS",
      "0x0000000000000000000000000000000000000001",
    ),
    privateKey: getEnvHex(
      "PRIVATE_KEY",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ),

    port: parseInt(getEnv("PORT", "3300")),
    host: getEnv("HOST", "0.0.0.0"),

    bundlingMode: getEnv("BUNDLING_MODE", "auto") as "auto" | "manual",
    maxBundleSize: parseInt(getEnv("MAX_BUNDLE_SIZE", "10")),
    maxBundleGas: BigInt(getEnv("MAX_BUNDLE_GAS", "5000000")),
    minPriorityFeePerGas: BigInt(getEnv("MIN_PRIORITY_FEE_PER_GAS", "1000000000")),

    minProfitMarginBps: parseInt(getEnv("MIN_PROFIT_MARGIN_BPS", "2000")),
    targetProfitMarginBps: parseInt(getEnv("TARGET_PROFIT_MARGIN_BPS", "3500")),
    highRiskMarginBps: parseInt(getEnv("HIGH_RISK_MARGIN_BPS", "5000")),

    useEip1559,
    baseFeeMultiplier: parseFloat(getEnv("BASE_FEE_MULTIPLIER", "1.25")),
    bundlerTipGwei: parseFloat(getEnv("BUNDLER_TIP_GWEI", "1.5")),

    mode: getEnv("MODE", "production") as "production" | "testing",
    autoBundleIntervalMs: parseInt(getEnv("AUTO_BUNDLE_INTERVAL_MS", "10000")),

    // Private bundler config
    operatorSecret: getEnv("OPERATOR_SECRET"),
    activeKeyVersion: getEnv("ACTIVE_KEY_VERSION", "1"),
    drainingKeyVersions,
    apiToken: getEnv("API_TOKEN"),
    apiRateLimitPerMinute: parseInt(getEnv("API_RATE_LIMIT_PER_MINUTE", "60")),
    balanceReserveMultiplier: parseInt(getEnv("BALANCE_RESERVE_MULTIPLIER", "2")),
  };
}
