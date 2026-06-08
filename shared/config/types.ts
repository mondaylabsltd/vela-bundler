/**
 * Bundler configuration types.
 *
 * Only types and re-exports — no runtime environment access.
 * Runtime-specific `loadConfig()` lives in deno/config.ts or worker/config.ts.
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
  /** Maximum allowed margin. Rejects UserOps that overpay beyond this, protecting users. */
  readonly maxProfitMarginBps: number;

  /** Wallet's gas margin percentage. Bundler derives outerGasPrice = userOpGasPrice / (1 + margin/100).
   *  Must match BUNDLER_MARGIN_PERCENT on the wallet side. E.g. 50 → 1.5x markup → 50% margin. */
  readonly walletGasMarkup: number;

  readonly useEip1559: boolean;
  readonly baseFeeMultiplier: number;
  readonly bundlerTipGwei: number;

  readonly autoBundleIntervalMs: number;

  readonly operatorSecret: string;
  readonly oldOperatorSecrets: string[];
  readonly treasuryAddress: `0x${string}`;
  /** @deprecated Use treasuryAddress (derived from OPERATOR_SECRET). */
  readonly sweepInterval: number;
  readonly apiRateLimitPerMinute: number;
  readonly balanceReserveMultiplier: number;

  /** Alchemy API key. When set, Alchemy RPCs are preferred for supported chains. */
  readonly alchemyApiKey: string | null;
}
