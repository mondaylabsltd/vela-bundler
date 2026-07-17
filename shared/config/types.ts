/**
 * Bundler configuration types.
 *
 * Only types and re-exports — no runtime environment access.
 * Runtime-specific `loadConfig()` lives in deno/config.ts or worker/config.ts.
 */

import type { ChainInfo } from "./chain-registry.ts";

export type { ChainInfo };
export { resolveChain, fetchChainInfo, filterPublicRpcUrls } from "./chain-registry.ts";
export { settlementVaultEnabledFor } from "./vault.ts";

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
  /** Per-chain canary spec for enabling in-band settlement on non-Tempo chains — the
   *  raw INBAND_ENABLED value: "" | "true"/"all" | comma-separated chainIds. Resolved
   *  together with inBandEnabled via inBandActiveForChain (shared/tempo.ts); this is
   *  the ONLY way to enable in-band from the environment (the boolean has no env
   *  plumbing — it exists for per-chain configs and tests). */
  readonly inBandChains?: string;
  /** Per-chain canary spec for treasury-as-vault settlement (redirects the in-band
   *  reimbursement recipient to the treasury + enables the treasury→pool top-up loop).
   *  Raw SETTLEMENT_VAULT_ENABLED value: "" | "true"/"all" | comma-separated chainIds.
   *  Resolve with settlementVaultEnabledFor(spec, chainId) — never read directly.
   *  Stage 2 of docs/pool-queue-architecture.md. */
  readonly settlementVaultChains?: string;
  /** Per-chain spec for Stage 3 pool relayers (POOL_EOA_ENABLED env: "" | "true"/"all" |
   *  chainId CSV). Gates the pool top-up loop today (no money parked in idle pool EOAs
   *  before Stage 3 activates them) and the multi-sender pool bundling when it lands.
   *  Resolve via chainSpecEnables. */
  readonly poolEoaChains?: string;
  /** Per-chain spec for Stage 4 queue transport (QUEUE_TRANSPORT_ENABLED env: "" | "true"/"all"
   *  | chainId CSV). When active on a chain, eth_sendUserOperation enqueues the validated op to
   *  USEROP_QUEUE instead of mempool.add + kick, and the queue() consumer routes it by
   *  hash(sender)%100 to a per-EOA RelayerDO. Requires pool mode (POOL_EOA_ENABLED) + vault.
   *  Resolve via chainSpecEnables. Default off → the in-DO mempool path (Stage 3) unchanged. */
  readonly queueTransportChains?: string;
  /** Pool relayer float: top up a pool EOA when its native balance falls below this (wei).
   *  Default 0.0005 native. Stage 2 top-up loop. */
  readonly poolFloatMinWei?: bigint;
  /** Pool relayer float: top up TO this native balance (wei). Default 0.002 native. */
  readonly poolFloatTargetWei?: bigint;
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
