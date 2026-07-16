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
  /** VelaGasSettlementSplitter address — the handleOps beneficiary on native chains.
   *  Derived (CREATE2) from treasuryAddress; identical on every chain. See
   *  shared/contracts/splitter.ts. */
  readonly splitterAddress: `0x${string}`;
  /** Opt a non-Tempo chain into the in-band settlement model (bundler eats gas, UserOp repays
   *  in-band; EntryPoint fee=0). Off by default; flipped per-chain as chains migrate off the
   *  legacy native-self-pay/splitter route. Tempo chains are always in-band regardless.
   *  See docs/inband-gas-settlement.md. */
  readonly inBandEnabled?: boolean;
  readonly apiRateLimitPerMinute: number;
  /** Client IPs exempt from rate limiting (comma-separated env RATE_LIMIT_ALLOWLIST) —
   *  the operator's own bot must never self-throttle its trading ops. */
  readonly rateLimitAllowlist: string[];
  readonly balanceReserveMultiplier: number;

  /** Alchemy API key. When set, Alchemy RPCs are preferred for supported chains. */
  readonly alchemyApiKey: string | null;

  // --- Monitoring / alerting (optional; all disabled when unset) ---
  /** Telegram bot token for operational alerts. Alerts are disabled when null. */
  readonly telegramBotToken: string | null;
  /** Telegram chat id that alerts are sent to. Alerts are disabled when null. */
  readonly telegramChatId: string | null;
  /** Alert when a chain's treasury native balance falls below this (wei). Default 0.02 ETH. */
  readonly treasuryAlertThresholdWei: bigint;
  /** Alert when a Tempo chain's treasury pathUSD balance falls below this (6-dec units). Default 0.5 pathUSD. */
  readonly treasuryAlertThresholdPathUsd: bigint;
}
