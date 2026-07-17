/**
 * Cloudflare Worker environment bindings.
 */

/**
 * Message shape for the `vela-userops` queue. Produced by eth_sendUserOperation
 * after validate+simulate; consumed by the queue() handler which routes each op
 * by hash(sender)%RELAYER_POOL_SIZE to a per-EOA DO. Not consumed yet — Stage 0
 * of docs/pool-queue-architecture.md (transport activates in Stage 4).
 */
export interface UserOpQueueMessage {
  chainId: number;
  entryPoint: `0x${string}`;
  rpcUserOp: Record<string, unknown>;
  rpcUrlOverride?: string;
  userOpHash: `0x${string}`;
  prefund: string;
}

export interface Env {
  /** Durable Object namespace — one BundlerDO instance per chain. */
  BUNDLER: DurableObjectNamespace;

  /** Per-EOA relayer DO namespace (Stage 4 of docs/pool-queue-architecture.md) — one instance
   *  per (chainId, pool index 0..99), addressed as `chain-${chainId}-eoa-${i}`. Bound and LIVE
   *  even before QUEUE_TRANSPORT_ENABLED (a plain DO binding is deploy-safe); the queue consumer
   *  routes ops to it once the flag + queue bindings are enabled. */
  RELAYER: DurableObjectNamespace;

  /** UserOp transport queue — unused until QUEUE_TRANSPORT_ENABLED (Stage 4 of
   *  docs/pool-queue-architecture.md). Optional: the binding is not yet declared
   *  in wrangler.jsonc (declaring a producer for a queue that doesn't exist fails
   *  deploy), so it is absent at runtime today. */
  USEROP_QUEUE?: Queue<UserOpQueueMessage>;
  /** Accepted-op status markers so wallet polls resolve before the op reaches a
   *  per-EOA DO. Status only — NEVER nonce or lock state (KV is not atomic).
   *  Unused until Stage 4; absent at runtime today. */
  USEROP_STATUS?: KVNamespace;

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

  // Monitoring / alerting (optional)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TREASURY_ALERT_THRESHOLD_WEI?: string;
  TREASURY_ALERT_THRESHOLD_PATHUSD?: string;
  /** Comma-separated client IPs exempt from rate limiting (the operator's own bot). */
  RATE_LIMIT_ALLOWLIST?: string;

  /** In-band settlement enablement: UNSET → "all" (every chain settles in-band —
   *  the default since 2026-07-17). "false" disables non-Tempo chains; a
   *  comma-separated chainId list narrows to those chains (rollback lever). */
  INBAND_ENABLED?: string;
  /** Treasury-as-vault settlement canary (Stage 2 of docs/pool-queue-architecture.md):
   *  "" (off, default) | "true"/"all" (every chain) | comma-separated chainIds.
   *  Resolved per-chain via settlementVaultEnabledFor(). */
  SETTLEMENT_VAULT_ENABLED?: string;
  /** Stage 3 pool relayers per-chain spec: "" (off, default) | "true"/"all" | chainId CSV.
   *  Gates the pool top-up loop + (when it lands) multi-sender pool bundling. */
  POOL_EOA_ENABLED?: string;
  /** Stage 4 queue transport per-chain spec: "" (off, default) | "true"/"all" | chainId CSV.
   *  When on, the producer enqueues validated ops and the queue consumer routes them to
   *  per-EOA RelayerDOs. Requires POOL_EOA_ENABLED + vault on the same chain. */
  QUEUE_TRANSPORT_ENABLED?: string;
  /** Pool relayer float low-water mark in wei (top up below this). Default 0.0005 native. */
  POOL_FLOAT_MIN_WEI?: string;
  /** Pool relayer float top-up target in wei. Default 0.002 native. */
  POOL_FLOAT_TARGET_WEI?: string;
}
