/**
 * Cloudflare Worker environment bindings.
 */

export interface Env {
  /** Durable Object namespace — one BundlerDO instance per chain. */
  BUNDLER: DurableObjectNamespace;

  /** 32+ byte hex secret for deterministic key derivation. */
  OPERATOR_SECRET: string;
  /** Comma-separated old secrets for draining rotated EOAs. */
  OLD_OPERATOR_SECRETS?: string;
  /** Alchemy API key — preferred RPCs for supported chains. */
  ALCHEMY_API_KEY?: string;

  // Optional config overrides (all have defaults)
  USE_EIP1559?: string;
  ENTRY_POINT_ADDRESS?: string;
  BUNDLING_MODE?: string;
  MAX_BUNDLE_SIZE?: string;
  MAX_BUNDLE_GAS?: string;
  MIN_PRIORITY_FEE_PER_GAS?: string;
  MIN_PROFIT_MARGIN_BPS?: string;
  MAX_PROFIT_MARGIN_BPS?: string;
  WALLET_GAS_MARGIN_PERCENT?: string;
  BASE_FEE_MULTIPLIER?: string;
  BUNDLER_TIP_GWEI?: string;
  AUTO_BUNDLE_INTERVAL_MS?: string;
  API_RATE_LIMIT_PER_MINUTE?: string;
  BALANCE_RESERVE_MULTIPLIER?: string;
}
