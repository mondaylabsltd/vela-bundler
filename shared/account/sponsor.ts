/**
 * SponsorService — auto-fund new users' gas account EOAs from the treasury.
 *
 * Eligibility:
 *   1. Relayer EOA nonce <= MAX_SPONSOR_NONCE (new user; see constant below)
 *   2. User's Safe address has a registered WebAuthn public key
 *   3. Treasury balance stays above a safety floor
 *   4. Per-transfer amount capped
 *   5. Rate-limited per Safe address
 */

import {
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "../utils/rpc-client.ts";
import { deriveTreasuryPrivateKey, RELAYER_POOL_SIZE } from "../keys/derive.ts";
import type { BundlerConfig } from "../config/types.ts";
import {
  isTempoChain,
  tempoPathUsdBalance,
  sponsorTempoPathUsd,
  TEMPO_SPONSOR_TARGET,
  TEMPO_TREASURY_FLOOR,
} from "../tempo.ts";
import { redactError } from "../reliability/log.ts";
import { createAlerter, type Alerter } from "../monitoring/telegram.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max relayer EOA nonce to qualify for sponsorship. */
const MAX_SPONSOR_NONCE = 6;

/** Gas units used to calculate the max sponsor amount per transfer.
 *  Exported: the treasury monitor derives its DYNAMIC low-balance threshold from the same
 *  numbers the sponsor gates on, so "alert" always fires before "sponsorship fails closed". */
export const MAX_SPONSOR_GAS = 5_000_000n;

/**
 * Volatility margin applied to the *server-side* funding estimate (150% = +50%).
 * Absorbs gas-price spikes between the moment we fund the gas account and the
 * moment the bundle executes. Layered on top of the existing ×2 gas-usage buffer.
 * A client-supplied hint (requiredWei) is trusted as-is and does NOT get this
 * margin — the wallet already includes its own headroom. Still bounded by
 * MAX_SPONSOR_GAS so it can never drain the treasury.
 */
const SPONSOR_VOLATILITY_BUFFER_BPS = 15_000n;

/** Minimum sponsor target balance (0.0001 ETH) — matches wallet client MIN_BALANCE_WEI. */
const MIN_SPONSOR_BALANCE = 100_000_000_000_000n;

/** Minimum treasury balance to keep (0.01 ETH). Won't sponsor below this. Exported for the
 *  treasury monitor's dynamic threshold (see MAX_SPONSOR_GAS). */
export const TREASURY_FLOOR = 10_000_000_000_000_000n;

/** Cooldown between sponsorship attempts for the same Safe address (5 min). */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

/** Short cooldown floor for a VERIFIABLY EMPTY Tempo gas float. The normal 5-min success
 *  cooldown would strand an active user whose float just drained mid-session (fix #10's
 *  refill path is useless if it's cooldown-blocked); 60s still bounds a hostile drain to
 *  ~TEMPO_SPONSOR_TARGET per minute, further capped by the treasury floor. */
const TEMPO_EMPTY_FLOAT_COOLDOWN_MS = 60 * 1000;

/** Fallback gas limit for ETH transfers (L2s like Arbitrum need more than 21k). Exported for
 *  the treasury monitor's dynamic threshold. */
export const TRANSFER_GAS_FALLBACK = 100_000n;

/** Timeout for waiting on tx confirmation. */
const CONFIRM_TIMEOUT_MS = 15_000;

/** Timeout for WebAuthn index query. */
const WEBAUTHN_QUERY_TIMEOUT_MS = 5_000;

/**
 * MUST be the same deployment the wallet registers to (vela-wallet
 * DEFAULT_SERVICE_ENDPOINTS.passkeyIndexURL). The old
 * webauthnp256-publickey-index.biubiu.tools host is a SEPARATE deployment that
 * only converges after the on-chain commit-reveal — querying it made every
 * brand-new wallet fail the passkey gate ("no_passkey_registered") until its
 * registration landed on Gnosis and synced across.
 */
const WEBAUTHN_INDEX_URL = "https://p256-index.getvela.app";

/** Denial cache TTL: identical re-asks within this window get the cached
 *  denial back without re-running RPC reads or index queries. Failed attempts
 *  used to be free to spam (the success cooldown never armed); this bounds
 *  their cost while staying shorter than the wallet's 30s auto-retry. */
const DENIAL_CACHE_MS = 20_000;

/** dryRun probe results are served from cache for this long (see lastProbe). */
const PROBE_CACHE_MS = 10_000;

/**
 * Global per-chain sponsorship circuit breaker — bounds worst-case treasury
 * drain per 24h window no matter how many distinct (sybil) Safes ask. The
 * per-Safe gates (balance ≥ 2×, nonce, passkey index) raise the per-account
 * cost of farming, but counterfactual Safe addresses are free to mint, so a
 * global ceiling is the only hard bound. In-memory is correct here: the
 * service lives in a per-chain Durable Object singleton, and an active drain
 * keeps the DO alive (eviction resets only an idle window).
 *
 * The wei ceiling is denominated in native wei (18-dec); Tempo grants are
 * 6-dec pathUSD units, so the grants ceiling is the binding one there.
 */
const SPONSOR_DAILY_MAX_GRANTS = 150;
const SPONSOR_DAILY_MAX_WEI = 2_000_000_000_000_000_000n; // 2 native units / 24h
const SPONSOR_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pool relayer top-up (Stage 2 of docs/pool-queue-architecture.md)
// ---------------------------------------------------------------------------

/** Min interval between pool top-up sweeps (per chain — the service lives in the
 *  per-chain DO). The healthLoop calls in far more often; this gate keeps the
 *  balance-read load bounded. */
const POOL_TOPUP_SWEEP_INTERVAL_MS = 60_000;

/** Pool EOAs balance-checked per sweep (round-robin cursor). 10/min ⇒ the full
 *  100-EOA pool is swept every ~10 minutes. */
const POOL_TOPUP_BATCH = 10;

/** Max top-up transfers per sweep — bounds the treasury drain rate (and the
 *  serialized nonce chain) even if many EOAs are simultaneously below water. */
const POOL_TOPUP_MAX_SENDS_PER_SWEEP = 3;

/** Rolling 24h ceiling on total pool top-ups per chain (1 native unit). A leak in
 *  the pool (or a mispriced float target) must not siphon the treasury dry. */
const POOL_TOPUP_DAILY_MAX_WEI = 1_000_000_000_000_000_000n;

/** Default float bounds — overridable via config.poolFloatMinWei/poolFloatTargetWei. */
const POOL_FLOAT_MIN_WEI_DEFAULT = 500_000_000_000_000n; // 0.0005 native
const POOL_FLOAT_TARGET_WEI_DEFAULT = 2_000_000_000_000_000n; // 0.002 native

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SponsorResult {
  sponsored: boolean;
  txHash?: string;
  amount?: string; // hex wei
  reason?: string;
  /** Set on dryRun responses: the request was an eligibility probe. */
  dryRun?: boolean;
  /** dryRun only: whether a real request would have been granted. */
  eligible?: boolean;
}

// ---------------------------------------------------------------------------
// SponsorService
// ---------------------------------------------------------------------------

export class SponsorService {
  private readonly config: BundlerConfig;

  /** Prevents concurrent sponsorship for the same EOA. */
  private readonly pending = new Set<string>();

  /** Rate limit: safeAddress (lowercase) → last attempt timestamp. */
  private readonly lastAttempt = new Map<string, number>();

  /** Recent eligibility denials: safeAddress (lowercase) → cached result.
   *  See DENIAL_CACHE_MS. */
  private readonly lastDenial = new Map<string, { at: number; result: SponsorResult }>();

  /** Recent dryRun probe results: safeAddress (lowercase) → cached result.
   *  Denials are already covered by lastDenial; this additionally caches
   *  ELIGIBLE probes so a spammer with a qualifying Safe can't burn 3-4 RPC
   *  reads per request. Short TTL — eligibility must stay fresh enough for
   *  the Continue→slide window. */
  private readonly lastProbe = new Map<string, { at: number; result: SponsorResult }>();

  /** Rolling 24h grant budget (see SPONSOR_DAILY_MAX_GRANTS). */
  private budget = { windowStart: 0, grants: 0, totalWei: 0n };

  /** Pool top-up round-robin cursor + sweep/budget state (Stage 2). Separate budget
   *  from sponsorship: a pool leak must not starve new-user onboarding or vice versa. */
  private topUpCursor = 0;
  private lastTopUpSweepAt = 0;
  private topUpBudget = { windowStart: 0, totalWei: 0n };

  /**
   * Serializes all transactions sent FROM the single treasury EOA. Without this, two
   * concurrent sponsorships of DIFFERENT safes both auto-fetch the same `pending` nonce
   * and one tx is dropped/replaced. Funds aren't lost (nonce reuse just fails one), but
   * the user sees a spurious sponsor failure. A promise-chain mutex keeps treasury sends
   * strictly sequential so each picks up the prior one's nonce.
   */
  private treasuryTxChain: Promise<unknown> = Promise.resolve();

  /** Telegram alerter for intervention-worthy sponsor failures (treasury depleted / transfer
   *  failing / passkey index down). Injectable for tests; defaults from config (no-op when
   *  Telegram is unconfigured). `quiet` — the runtime already logged the enabled/disabled state. */
  private readonly alerter: Alerter;

  /** Effective budget ceilings — constants by default, injectable for tests. */
  private readonly maxDailyGrants: number;
  private readonly maxDailyWei: bigint;

  constructor(
    config: BundlerConfig,
    alerter?: Alerter,
    budgetLimits?: { maxGrants?: number; maxWei?: bigint },
  ) {
    this.config = config;
    this.alerter = alerter ?? createAlerter(config, { quiet: true });
    this.maxDailyGrants = budgetLimits?.maxGrants ?? SPONSOR_DAILY_MAX_GRANTS;
    this.maxDailyWei = budgetLimits?.maxWei ?? SPONSOR_DAILY_MAX_WEI;
  }

  /** Run `fn` exclusively against the treasury nonce (serialized across all callers). */
  private runTreasuryExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.treasuryTxChain.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome.
    this.treasuryTxChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Roll the 24h budget window and report whether another grant fits. */
  private budgetAllows(): boolean {
    const now = Date.now();
    if (now - this.budget.windowStart > SPONSOR_BUDGET_WINDOW_MS) {
      this.budget = { windowStart: now, grants: 0, totalWei: 0n };
    }
    return this.budget.grants < this.maxDailyGrants &&
      this.budget.totalWei < this.maxDailyWei;
  }

  /** Reserve budget BEFORE submitting — checked-then-consumed around an await
   *  would let interleaved grants overshoot the ceiling. Refunded on failure. */
  private consumeBudget(amountWei: bigint): void {
    this.budget.grants += 1;
    this.budget.totalWei += amountWei;
  }

  private refundBudget(amountWei: bigint): void {
    if (this.budget.grants > 0) this.budget.grants -= 1;
    this.budget.totalWei = this.budget.totalWei > amountWei ? this.budget.totalWei - amountWei : 0n;
  }

  /** Cache an eligibility denial so immediate identical re-asks are answered
   *  without RPC/index work. Only stable eligibility outcomes are cached —
   *  transient states (in-progress, pending, transfer errors) are not. */
  private cacheDenial(safeLower: string, result: SponsorResult): SponsorResult {
    // Only per-SAFE facts are cached. Global conditions are deliberately NOT:
    // budget_exhausted is free to recompute (no RPC), and caching
    // treasury_depleted per-safe would keep denying users for the TTL after
    // the operator tops the treasury back up.
    const CACHEABLE = new Set([
      "nonce_exceeded",
      "wallet_balance_too_low",
      "no_passkey_registered",
    ]);
    if (result.reason && CACHEABLE.has(result.reason)) {
      // Crude but safe size bound — the map lives in a per-chain DO.
      if (this.lastDenial.size > 2_000) this.lastDenial.clear();
      this.lastDenial.set(safeLower, { at: Date.now(), result });
    }
    return result;
  }

  async sponsor(
    chainId: number,
    safeAddress: `0x${string}`,
    relayerAddress: `0x${string}`,
    rpcUrl: string,
    clientHintWei?: bigint,
    dryRun = false,
  ): Promise<SponsorResult> {
    const safeLower = safeAddress.toLowerCase();
    const relayerLower = relayerAddress.toLowerCase();

    // 0. Denial cache — a public, unauthenticated endpoint must not let failed
    // attempts re-trigger RPC reads and index queries for free on every call.
    const cached = this.lastDenial.get(safeLower);
    if (cached && Date.now() - cached.at < DENIAL_CACHE_MS) {
      return dryRun
        ? { sponsored: false, dryRun: true, eligible: false, reason: cached.result.reason }
        : cached.result;
    }
    // 0a. Probe cache — repeated dryRuns (incl. eligible ones) are answered
    // from cache so probing is never a free RPC-amplification vector.
    if (dryRun) {
      const probed = this.lastProbe.get(safeLower);
      if (probed && Date.now() - probed.at < PROBE_CACHE_MS) return probed.result;
    }

    // 0b. Global budget circuit breaker (see SPONSOR_DAILY_MAX_GRANTS).
    if (!this.budgetAllows()) {
      await this.alerter.send(
        `sponsor-budget-${chainId}`,
        `🚨 Vela Bundler — daily sponsorship budget EXHAUSTED on chain ${chainId} ` +
          `(${this.budget.grants} grants / ${this.budget.totalWei} wei in the current window). ` +
          `Legitimate new-user onboarding is failing closed. If this is organic growth, raise ` +
          `SPONSOR_DAILY_MAX_*; if not, someone is farming the treasury.`,
      );
      const denied: SponsorResult = { sponsored: false, reason: "budget_exhausted" };
      return dryRun ? { ...denied, dryRun: true, eligible: false } : this.cacheDenial(safeLower, denied);
    }

    // 1. Rate limit — only blocks if a previous sponsorship SUCCEEDED recently.
    // Tempo: a VERIFIABLY EMPTY float bypasses the 5-min success-cooldown (down to a 60s
    // floor) — an active user whose float drained mid-session must be refillable NOW, not
    // in five minutes (that stall is exactly a "user's money can't move" incident).
    const lastTime = this.lastAttempt.get(safeLower);
    let cooldownMs = RATE_LIMIT_COOLDOWN_MS;
    if (lastTime && isTempoChain(chainId) && Date.now() - lastTime < RATE_LIMIT_COOLDOWN_MS) {
      try {
        const floatBalance = await tempoPathUsdBalance(getPublicClient(rpcUrl), relayerAddress);
        if (floatBalance < TEMPO_SPONSOR_TARGET / 5n) cooldownMs = TEMPO_EMPTY_FLOAT_COOLDOWN_MS;
      } catch {
        // Balance read failed — keep the default cooldown (fail closed).
      }
    }
    if (lastTime && Date.now() - lastTime < cooldownMs) {
      const limited: SponsorResult = { sponsored: false, reason: "rate_limited" };
      return dryRun ? { ...limited, dryRun: true, eligible: false } : limited;
    }

    // 2. Concurrency guard
    if (this.pending.has(relayerLower)) {
      return { sponsored: false, reason: "already_in_progress" };
    }
    this.pending.add(relayerLower);

    try {
      const result = await this._doSponsor(chainId, safeLower as `0x${string}`, relayerLower as `0x${string}`, rpcUrl, clientHintWei, dryRun);
      // Only set cooldown on successful sponsorship — failed attempts can retry immediately
      if (result.sponsored) {
        this.lastAttempt.set(safeLower, Date.now());
        this.lastDenial.delete(safeLower);
      }
      if (dryRun) {
        // already_funded / amount_too_small mean the account needs no grant —
        // for a PROBE that is a green light (the send can proceed), not a
        // denial; reporting them ineligible would bounce a payable user to
        // the funding sheet.
        const needsNoGrant = result.reason === "already_funded" || result.reason === "amount_too_small";
        const probeResult: SponsorResult = result.dryRun
          ? result // already decorated (eligible)
          : { sponsored: false, dryRun: true, eligible: needsNoGrant, reason: result.reason };
        if (this.lastProbe.size > 2_000) this.lastProbe.clear();
        this.lastProbe.set(safeLower, { at: Date.now(), result: probeResult });
        return probeResult;
      }
      return result.sponsored ? result : this.cacheDenial(safeLower, result);
    } finally {
      this.pending.delete(relayerLower);
    }
  }

  private async _doSponsor(
    chainId: number,
    safeAddress: `0x${string}`,
    relayerAddress: `0x${string}`,
    rpcUrl: string,
    clientHintWei?: bigint,
    dryRun = false,
  ): Promise<SponsorResult> {
    const client = getPublicClient(rpcUrl);

    // Tempo has no native coin — the gas account is a bundler-provided pathUSD FLOAT that is
    // consumed as gas is fronted and (mostly) replenished by each tx's batched reimbursement.
    // It legitimately needs RE-funding when it drains, so it must NOT be gated by the "new user"
    // nonce heuristic below (a drained, actively-used gas account has nonce > MAX_SPONSOR_NONCE
    // and would otherwise be un-refillable → the user is silently stuck, unable to submit). Abuse
    // is bounded by the passkey gate + per-transfer cap (tops up only to TEMPO_SPONSOR_TARGET) +
    // treasury floor (in _doSponsorTempo) + the 5-min per-safe cooldown (in sponsor()).
    if (isTempoChain(chainId)) {
      const passkey = await this.checkWebAuthnRegistration(safeAddress);
      if (passkey === "unavailable") {
        return await this.passkeyIndexUnavailable(chainId);
      }
      if (passkey === "not_registered") {
        return { sponsored: false, reason: "no_passkey_registered" };
      }
      return await this._doSponsorTempo(chainId, relayerAddress, rpcUrl, dryRun);
    }

    // 3. Nonce check — only sponsor new relayers (native chains: the EOA is user-funded and
    //    self-sustaining via the settlement split, so it should not need re-sponsoring).
    const nonce = await client.getTransactionCount({ address: relayerAddress });
    if (nonce > MAX_SPONSOR_NONCE) {
      return { sponsored: false, reason: "nonce_exceeded" };
    }

    // 4. User wallet balance check — Safe must hold ≥ 2× the sponsor amount.
    //    Prevents empty wallets from draining the treasury.
    const safeBalance = await client.getBalance({ address: safeAddress });
    const gasPrice = await client.getGasPrice();
    const gasBased = MAX_SPONSOR_GAS * gasPrice;
    const maxSponsorAmount = gasBased > MIN_SPONSOR_BALANCE ? gasBased : MIN_SPONSOR_BALANCE;
    // ×2 = gas-usage buffer; ×1.5 (15_000 bps) = volatility margin for gas-price
    // spikes. The hint carries the wallet's own headroom, so it doesn't get the
    // server-side volatility margin — but the endpoint is public, so an
    // attacker-supplied requiredWei is capped at 3× our own estimate rather
    // than being trusted up to the full per-transfer cap (5M gas × gasPrice is
    // enormous on expensive chains).
    const serverEstimate = (gasPrice * 600_000n * 2n * SPONSOR_VOLATILITY_BUFFER_BPS) / 10_000n;
    const hintCap = serverEstimate * 3n;
    const boundedHint = clientHintWei && clientHintWei > hintCap ? hintCap : clientHintWei;
    let targetBalance = serverEstimate;
    if (boundedHint && boundedHint > targetBalance) targetBalance = boundedHint;
    if (targetBalance < MIN_SPONSOR_BALANCE) targetBalance = MIN_SPONSOR_BALANCE;
    const sponsorAmount = targetBalance > maxSponsorAmount ? maxSponsorAmount : targetBalance;
    if (safeBalance < sponsorAmount * 2n) {
      return { sponsored: false, reason: "wallet_balance_too_low" };
    }

    // 5. WebAuthn public key check — must be a registered Vela user
    const passkey = await this.checkWebAuthnRegistration(safeAddress);
    if (passkey === "unavailable") {
      return await this.passkeyIndexUnavailable(chainId);
    }
    if (passkey === "not_registered") {
      return { sponsored: false, reason: "no_passkey_registered" };
    }

    // 6. Treasury balance check. Failing closed here blocks ALL new-user onboarding, so it
    // must never be silent: alert with the address + computed shortfall (actionable top-up).
    const treasuryAddress = this.config.treasuryAddress;
    const treasuryBalance = await client.getBalance({ address: treasuryAddress });
    const required = TREASURY_FLOOR + maxSponsorAmount + TRANSFER_GAS_FALLBACK * gasPrice;
    if (treasuryBalance < required) {
      await this.alerter.send(
        `sponsor-depleted-${chainId}`,
        `💸 Vela Bundler — treasury DEPLETED for sponsorship on chain ${chainId}.\n` +
          `balance ${treasuryBalance} wei < required ${required} wei (shortfall ${required - treasuryBalance} wei)\n` +
          `address ${treasuryAddress}\n` +
          `New-user onboarding is failing closed — top up the treasury.`,
      );
      return { sponsored: false, reason: "treasury_depleted" };
    }

    // 7. Calculate amount — reuse targetBalance from step 4, subtract existing relayer balance.
    const relayerBalance = await client.getBalance({ address: relayerAddress });
    let amount = targetBalance > relayerBalance ? targetBalance - relayerBalance : 0n;
    if (amount <= 0n) {
      return { sponsored: false, reason: "already_funded" };
    }
    if (amount > maxSponsorAmount) amount = maxSponsorAmount;
    if (amount < 10_000n) {
      return { sponsored: false, reason: "amount_too_small" };
    }

    // Eligibility probe stops here — every gate passed, no money moves. The
    // wallet uses this to route denials to its funding sheet at Continue while
    // deferring the real grant to the confirm slide (maximum-commitment
    // moment, so grants are recouped by the settlement split within seconds).
    if (dryRun) {
      return { sponsored: false, dryRun: true, eligible: true };
    }

    // 7. Execute transfer from treasury
    const treasuryPrivateKey = await deriveTreasuryPrivateKey(this.config.operatorSecret);
    const account = privateKeyToAccount(treasuryPrivateKey);
    const walletClient = createWalletClient({
      account,
      transport: http(rpcUrl),
    });

    // Priority fee — query the chain's suggested tip instead of hardcoding
    // gasPrice/10. Chains like BSC enforce a minimum gas tip cap (e.g. 0.05 gwei);
    // a hardcoded fraction is rejected with "transaction gas price below minimum".
    let tip: bigint;
    try {
      tip = await client.estimateMaxPriorityFeePerGas();
    } catch {
      tip = gasPrice; // fallback: use the full gas price as the tip
    }
    if (tip <= 0n) tip = gasPrice;
    tip = (tip * 110n) / 100n; // 10% headroom to clear the chain minimum
    const baseFee = gasPrice; // approximate
    const maxFee = baseFee * 2n + tip;

    console.log(
      `[Sponsor] ${treasuryAddress} → ${relayerAddress} (chain ${chainId}): ${amount} wei`,
    );

    // Estimate gas — L2s like Arbitrum need more than 21k for simple transfers
    let transferGas = TRANSFER_GAS_FALLBACK;
    try {
      const estimated = await client.estimateGas({
        account: treasuryAddress,
        to: relayerAddress,
        value: amount,
      });
      transferGas = (estimated * 120n) / 100n; // 20% buffer
      if (transferGas < 21_000n) transferGas = 21_000n;
    } catch { /* use fallback */ }

    this.consumeBudget(amount);
    try {
      // Serialize the submit against the treasury nonce — concurrent sponsorships of
      // other safes must not pick the same nonce. The confirmation wait stays outside
      // the lock (it doesn't affect nonce assignment).
      const txHash = await this.runTreasuryExclusive(() => walletClient.sendTransaction({
        to: relayerAddress,
        value: amount,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
        gas: transferGas,
        chain: null,
        account,
      }));

      console.log(`[Sponsor] Submitted: ${txHash}`);

      // Wait for confirmation so wallet can proceed immediately
      try {
        await client.waitForTransactionReceipt({
          hash: txHash,
          timeout: CONFIRM_TIMEOUT_MS,
        });
        console.log(`[Sponsor] Confirmed: ${txHash}`);
      } catch {
        console.warn(`[Sponsor] Confirmation timeout for ${txHash}, tx was submitted`);
      }

      return {
        sponsored: true,
        txHash,
        amount: "0x" + amount.toString(16),
      };
    } catch (err) {
      this.refundBudget(amount);
      const msg = redactError(err);
      console.error(`[Sponsor] Transfer failed:`, msg);
      // A failing treasury transfer blocks onboarding just like depletion — page the operator.
      await this.alerter.send(
        `sponsor-transfer-failed-${chainId}`,
        `🐛 Vela Bundler — sponsorship transfer FAILED on chain ${chainId}: ${msg.slice(0, 300)}\n` +
          `New users cannot be funded until this is resolved.`,
      );
      return {
        sponsored: false,
        reason: "transfer_failed",
      };
    }
  }

  /** Shared handling for a WebAuthn-index outage: alert (it disables ALL sponsorship, which is
   *  indistinguishable from "not registered" without this) and return a DISTINCT retryable
   *  reason so the REST layer can answer 503 instead of a business rejection. */
  // The index is a GLOBAL dependency (one URL for every chain), so the dedup id is fixed.
  private async passkeyIndexUnavailable(_chainId: number): Promise<SponsorResult> {
    console.warn(`[Sponsor] WebAuthn index UNAVAILABLE — sponsorship temporarily disabled`);
    await this.alerter.send(
      "sponsor-passkey-index-down",
      `⚠️ Vela Bundler — WebAuthn passkey index (${WEBAUTHN_INDEX_URL}) is UNREACHABLE. ` +
        `ALL sponsorship (new-user onboarding + Tempo float refills) is failing closed until it recovers.`,
    );
    return { sponsored: false, reason: "passkey_index_unavailable" };
  }

  /**
   * Tempo sponsorship: top the gas account up to a fixed pathUSD float via a 0x76
   * transfer from the treasury. No native coin, so amounts are in pathUSD (6-dec);
   * the float self-replenishes from each tx's batched reimbursement.
   */
  private async _doSponsorTempo(
    chainId: number,
    relayerAddress: `0x${string}`,
    rpcUrl: string,
    dryRun = false,
  ): Promise<SponsorResult> {
    const client = getPublicClient(rpcUrl);

    const relayerBalance = await tempoPathUsdBalance(client, relayerAddress);
    if (relayerBalance >= TEMPO_SPONSOR_TARGET) {
      return { sponsored: false, reason: "already_funded" };
    }
    const amount = TEMPO_SPONSOR_TARGET - relayerBalance;

    const treasuryBalance = await tempoPathUsdBalance(client, this.config.treasuryAddress);
    if (treasuryBalance < amount + TEMPO_TREASURY_FLOOR) {
      const required = amount + TEMPO_TREASURY_FLOOR;
      await this.alerter.send(
        `sponsor-depleted-${chainId}`,
        `💸 Vela Bundler — treasury pathUSD DEPLETED for Tempo sponsorship on chain ${chainId}.\n` +
          `balance ${treasuryBalance} < required ${required} (6-dec units, shortfall ${required - treasuryBalance})\n` +
          `address ${this.config.treasuryAddress}\n` +
          `Gas-float refills are failing closed — users with drained floats are STUCK. Top up the treasury.`,
      );
      return { sponsored: false, reason: "treasury_depleted" };
    }

    // Eligibility probe stops here — gates passed, no pathUSD moves.
    if (dryRun) {
      return { sponsored: false, dryRun: true, eligible: true };
    }

    const treasuryPrivateKey = await deriveTreasuryPrivateKey(this.config.operatorSecret);
    console.log(
      `[Sponsor][Tempo] treasury → ${relayerAddress} (chain ${chainId}): ${amount} pathUSD units`,
    );
    this.consumeBudget(amount);
    try {
      // Serialized against the treasury nonce (see runTreasuryExclusive).
      const txHash = await this.runTreasuryExclusive(() => sponsorTempoPathUsd({
        chainId,
        privateKey: treasuryPrivateKey,
        rpcUrl,
        to: relayerAddress,
        amount,
      }));
      console.log(`[Sponsor][Tempo] Confirmed: ${txHash}`);
      return { sponsored: true, txHash, amount: "0x" + amount.toString(16) };
    } catch (err) {
      this.refundBudget(amount);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Pool relayer top-up (Stage 2 of docs/pool-queue-architecture.md)
  // ---------------------------------------------------------------------------

  /** Pool EOAs with a top-up broadcast still presumed in flight: address → sent-at ms.
   *  Skipped until this ages out — sweeps don't wait for confirmation, and re-reading a
   *  not-yet-landed balance next sweep would double-fund the same EOA. */
  private readonly topUpInFlight = new Map<string, number>();
  private static readonly TOPUP_INFLIGHT_TTL_MS = 10 * 60 * 1000;

  /** First time we observed an unconfirmed treasury tx (pending nonce > latest), or null. */
  private treasuryStuckSince: number | null = null;
  private static readonly TREASURY_STUCK_ALERT_MS = 5 * 60 * 1000;

  /**
   * Defer top-ups while the treasury has an unconfirmed tx. A tx wedged below the
   * current gas price would make every NEW send queue BEHIND it (viem assigns the
   * pending nonce), silently jamming all treasury sends — including sponsorship
   * grants — while each looks "sent". Deferring costs one sweep; jamming costs the
   * chain. Transient in-flight txs (a sponsorship from seconds ago) also defer,
   * which is harmless; only a PERSISTENT stall (>5 min) alerts the operator.
   */
  private async treasuryTxStuck(
    client: ReturnType<typeof getPublicClient>,
    chainId: number,
  ): Promise<boolean> {
    let latest: number, pending: number;
    try {
      [latest, pending] = await Promise.all([
        client.getTransactionCount({ address: this.config.treasuryAddress, blockTag: "latest" }),
        client.getTransactionCount({ address: this.config.treasuryAddress, blockTag: "pending" }),
      ]);
    } catch {
      return false; // blind read must not disable top-ups; floor + budget still bound spend
    }
    if (pending <= latest) {
      this.treasuryStuckSince = null;
      return false;
    }
    const now = Date.now();
    if (this.treasuryStuckSince === null) this.treasuryStuckSince = now;
    if (now - this.treasuryStuckSince >= SponsorService.TREASURY_STUCK_ALERT_MS) {
      await this.alerter.send(
        `treasury-tx-stuck-${chainId}`,
        `⛽ Vela Bundler — treasury tx UNCONFIRMED for ${Math.round((now - this.treasuryStuckSince) / 60_000)}min ` +
          `on chain ${chainId} (latest nonce ${latest}, pending ${pending}).\n` +
          `All treasury sends (top-ups, sponsorships) queue behind it — replace it at nonce ${latest} with a higher fee.`,
      );
    }
    return true;
  }

  /** Transfer gas for a treasury send: estimate +20% (L2s need more than 21k for a
   *  plain transfer — L1 data priced in L2 gas), fallback TRANSFER_GAS_FALLBACK. */
  private async estimateTransferGas(
    client: ReturnType<typeof getPublicClient>,
    to: `0x${string}`,
    amount: bigint,
  ): Promise<bigint> {
    try {
      const estimated = await client.estimateGas({
        account: this.config.treasuryAddress,
        to,
        value: amount,
      });
      const buffered = (estimated * 120n) / 100n;
      return buffered < 21_000n ? 21_000n : buffered;
    } catch {
      return TRANSFER_GAS_FALLBACK;
    }
  }

  /**
   * One round-robin sweep of the pool relayer float: check the next POOL_TOPUP_BATCH
   * pool EOAs' native balances and top the low ones up to the float target from the
   * treasury. Called from the per-chain DO healthLoop when the chain is in vault mode.
   *
   * Deliberately NOT nonce-gated (pool EOAs carry arbitrary nonces — the sponsor's
   * new-user gate does not apply) and serialized against the treasury nonce via
   * runTreasuryExclusive, same as sponsorship sends. Per-chain serialization comes from
   * the service living in the per-chain DO singleton.
   *
   * Tempo chains are skipped: their outer-gas float is pathUSD, and pool EOAs only
   * start fronting gas in Stage 3 — the native float model doesn't apply there yet.
   */
  async topUpPoolEOAs(
    chainId: number,
    rpcUrl: string,
    poolAddressAt: (index: number) => Promise<`0x${string}`>,
    poolSize: number = RELAYER_POOL_SIZE,
  ): Promise<{ checked: number; toppedUp: number; reason?: string }> {
    if (isTempoChain(chainId)) return { checked: 0, toppedUp: 0, reason: "tempo_skipped" };

    const now = Date.now();
    if (now - this.lastTopUpSweepAt < POOL_TOPUP_SWEEP_INTERVAL_MS) {
      return { checked: 0, toppedUp: 0, reason: "sweep_cooldown" };
    }
    // Stamp BEFORE the RPC work so a failing sweep also backs off a full interval.
    this.lastTopUpSweepAt = now;

    const minWei = this.config.poolFloatMinWei ?? POOL_FLOAT_MIN_WEI_DEFAULT;
    const targetWei = this.config.poolFloatTargetWei ?? POOL_FLOAT_TARGET_WEI_DEFAULT;
    const client = getPublicClient(rpcUrl);

    // Roll the 24h top-up budget window.
    if (now - this.topUpBudget.windowStart > SPONSOR_BUDGET_WINDOW_MS) {
      this.topUpBudget = { windowStart: now, totalWei: 0n };
    }

    // Age out stale in-flight markers.
    for (const [addr, at] of this.topUpInFlight) {
      if (now - at > SponsorService.TOPUP_INFLIGHT_TTL_MS) this.topUpInFlight.delete(addr);
    }

    // Round-robin balance scan.
    const low: { address: `0x${string}`; balance: bigint }[] = [];
    let checked = 0;
    const batch = Math.min(POOL_TOPUP_BATCH, poolSize);
    for (let n = 0; n < batch; n++) {
      const index = (this.topUpCursor + n) % poolSize;
      let address: `0x${string}`;
      try {
        address = await poolAddressAt(index);
      } catch (err) {
        console.warn(`[PoolTopUp] pool address derivation failed for #${index}: ${redactError(err)}`);
        continue;
      }
      if (this.topUpInFlight.has(address.toLowerCase())) continue;
      try {
        const balance = await client.getBalance({ address });
        checked++;
        if (balance < minWei) low.push({ address, balance });
      } catch {
        // RPC read failure — skip this EOA, the cursor will come back around.
      }
    }
    this.topUpCursor = (this.topUpCursor + batch) % poolSize;

    if (low.length === 0) return { checked, toppedUp: 0 };

    // Price + treasury guard once per sweep.
    const gasPrice = await client.getGasPrice();
    let tip: bigint;
    try {
      tip = await client.estimateMaxPriorityFeePerGas();
    } catch {
      tip = gasPrice;
    }
    if (tip <= 0n) tip = gasPrice;
    tip = (tip * 110n) / 100n;
    const maxFee = gasPrice * 2n + tip;

    if (await this.treasuryTxStuck(client, chainId)) {
      return { checked, toppedUp: 0, reason: "treasury_tx_stuck" };
    }

    const treasuryAddress = this.config.treasuryAddress;
    const treasuryBalance = await client.getBalance({ address: treasuryAddress });

    const treasuryPrivateKey = await deriveTreasuryPrivateKey(this.config.operatorSecret);
    const account = privateKeyToAccount(treasuryPrivateKey);
    const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

    let toppedUp = 0;
    let projectedSpend = 0n;
    for (const { address, balance } of low.slice(0, POOL_TOPUP_MAX_SENDS_PER_SWEEP)) {
      const amount = targetWei - balance;
      if (amount <= 0n) continue;

      const transferGas = await this.estimateTransferGas(client, address, amount);
      // Hard bounds: never breach the treasury floor and never exceed the 24h ceiling.
      const gasCost = transferGas * maxFee;
      if (treasuryBalance - projectedSpend < TREASURY_FLOOR + amount + gasCost) {
        await this.alerter.send(
          `pool-topup-depleted-${chainId}`,
          `💸 Vela Bundler — treasury too low for pool top-up on chain ${chainId}.\n` +
            `balance ${treasuryBalance - projectedSpend} wei, needs ${TREASURY_FLOOR + amount + gasCost} wei ` +
            `(pool EOA ${address} at ${balance} < ${minWei}).\nPool float refill is failing closed — top up the treasury.`,
        );
        break;
      }
      if (this.topUpBudget.totalWei + amount > POOL_TOPUP_DAILY_MAX_WEI) {
        console.warn(`[PoolTopUp] 24h budget exhausted on chain ${chainId} (${this.topUpBudget.totalWei} wei spent) — deferring`);
        break;
      }

      this.topUpBudget.totalWei += amount;
      projectedSpend += amount + gasCost;
      this.topUpInFlight.set(address.toLowerCase(), Date.now());
      try {
        const txHash = await this.runTreasuryExclusive(() => walletClient.sendTransaction({
          to: address,
          value: amount,
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: tip,
          gas: transferGas,
          chain: null,
          account,
        }));
        toppedUp++;
        console.log(`[PoolTopUp] treasury → ${address} (chain ${chainId}): ${amount} wei (${txHash})`);
      } catch (err) {
        this.topUpBudget.totalWei = this.topUpBudget.totalWei > amount ? this.topUpBudget.totalWei - amount : 0n;
        this.topUpInFlight.delete(address.toLowerCase());
        console.error(`[PoolTopUp] transfer to ${address} failed on chain ${chainId}: ${redactError(err)}`);
        // The money-moving step failing must reach the operator — the healthLoop only
        // sees thrown exceptions, and this loop deliberately doesn't throw per-transfer.
        await this.alerter.send(
          `pool-topup-failed-${chainId}`,
          `⛽ Vela Bundler — pool float top-up transfer FAILING on chain ${chainId}.\n` +
            `treasury → ${address} (${amount} wei): ${redactError(err)}`,
        );
      }
    }

    return { checked, toppedUp };
  }

  /**
   * Refill ONE fronting EOA's native float from the treasury (vault-mode chains only —
   * the caller gates on that). In vault mode the in-band reimbursement goes to the
   * treasury, so the EOA that fronts the outer gas is no longer self-healing; when the
   * bundle loop flags it as unable to afford the outer tx (insufficientFundsEoa), this
   * closes the treasury→EOA leg of the loop. NOT nonce-gated (any active EOA qualifies);
   * shares the pool top-up's in-flight dedup, 24h budget, and treasury floor; serialized
   * via runTreasuryExclusive.
   *
   * MUST NEVER run on legacy (deposit-model) chains: there the EOA balance is the USER's
   * prepaid custody, and an operator refill would silently gift gas money.
   */
  async topUpFloatEOA(
    chainId: number,
    rpcUrl: string,
    eoaAddress: `0x${string}`,
    /** The prefund (wei) that bounced, if known — the refill targets max(poolFloatTarget,
     *  shortfall × 1.5) so a bundle needing many× the static target actually clears. */
    shortfallWei?: bigint,
  ): Promise<{ toppedUp: boolean; reason?: string }> {
    const key = eoaAddress.toLowerCase();
    const now = Date.now();
    const inFlightAt = this.topUpInFlight.get(key);
    if (inFlightAt !== undefined && now - inFlightAt <= SponsorService.TOPUP_INFLIGHT_TTL_MS) {
      return { toppedUp: false, reason: "in_flight" };
    }
    this.topUpInFlight.delete(key);

    // Tempo: the fronting float is pathUSD, not native — refill it with a treasury
    // pathUSD transfer (0x76 envelope pays its own gas in pathUSD). This is what lets
    // Tempo join vault mode: without it the float would drain monotonically with the
    // sponsor's shared new-user budget as its only pump.
    if (isTempoChain(chainId)) {
      return await this.topUpTempoFloat(chainId, rpcUrl, eoaAddress, key, now);
    }

    if (now - this.topUpBudget.windowStart > SPONSOR_BUDGET_WINDOW_MS) {
      this.topUpBudget = { windowStart: now, totalWei: 0n };
    }

    // Target the LARGER of the static float target and the actual bounced prefund ×1.5, so a
    // pool bundle needing many× the static target is refilled enough to clear on the next pass
    // instead of bouncing forever while the refill reports "already_funded".
    const staticTarget = this.config.poolFloatTargetWei ?? POOL_FLOAT_TARGET_WEI_DEFAULT;
    const targetWei = shortfallWei !== undefined && (shortfallWei * 3n) / 2n > staticTarget
      ? (shortfallWei * 3n) / 2n
      : staticTarget;
    const client = getPublicClient(rpcUrl);

    const balance = await client.getBalance({ address: eoaAddress });
    if (balance >= targetWei) return { toppedUp: false, reason: "already_funded" };
    const amount = targetWei - balance;

    if (await this.treasuryTxStuck(client, chainId)) {
      return { toppedUp: false, reason: "treasury_tx_stuck" };
    }

    const gasPrice = await client.getGasPrice();
    let tip: bigint;
    try {
      tip = await client.estimateMaxPriorityFeePerGas();
    } catch {
      tip = gasPrice;
    }
    if (tip <= 0n) tip = gasPrice;
    tip = (tip * 110n) / 100n;
    const maxFee = gasPrice * 2n + tip;
    const transferGas = await this.estimateTransferGas(client, eoaAddress, amount);
    const gasCost = transferGas * maxFee;

    const treasuryBalance = await client.getBalance({ address: this.config.treasuryAddress });
    if (treasuryBalance < TREASURY_FLOOR + amount + gasCost) {
      await this.alerter.send(
        `float-topup-depleted-${chainId}`,
        `💸 Vela Bundler — treasury too low to refill fronting EOA on chain ${chainId}.\n` +
          `balance ${treasuryBalance} wei, needs ${TREASURY_FLOOR + amount + gasCost} wei ` +
          `(EOA ${eoaAddress} at ${balance}).\nIn-band submits are deferring — top up the treasury ` +
          `(or ask a user to bootstrap it via /v1/treasury/${chainId}).`,
      );
      return { toppedUp: false, reason: "treasury_depleted" };
    }
    if (this.topUpBudget.totalWei + amount > POOL_TOPUP_DAILY_MAX_WEI) {
      console.warn(`[FloatTopUp] 24h budget exhausted on chain ${chainId} — deferring`);
      return { toppedUp: false, reason: "budget_exhausted" };
    }

    const treasuryPrivateKey = await deriveTreasuryPrivateKey(this.config.operatorSecret);
    const account = privateKeyToAccount(treasuryPrivateKey);
    const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

    this.topUpBudget.totalWei += amount;
    this.topUpInFlight.set(key, Date.now());
    try {
      const txHash = await this.runTreasuryExclusive(() => walletClient.sendTransaction({
        to: eoaAddress,
        value: amount,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
        gas: transferGas,
        chain: null,
        account,
      }));
      console.log(`[FloatTopUp] treasury → ${eoaAddress} (chain ${chainId}): ${amount} wei (${txHash})`);
      return { toppedUp: true };
    } catch (err) {
      this.topUpBudget.totalWei = this.topUpBudget.totalWei > amount ? this.topUpBudget.totalWei - amount : 0n;
      this.topUpInFlight.delete(key);
      console.error(`[FloatTopUp] transfer to ${eoaAddress} failed on chain ${chainId}: ${redactError(err)}`);
      await this.alerter.send(
        `float-topup-failed-${chainId}`,
        `⛽ Vela Bundler — fronting-EOA float refill FAILING on chain ${chainId}.\n` +
          `treasury → ${eoaAddress} (${amount} wei): ${redactError(err)}\n` +
          `In-band submits will keep deferring until this succeeds.`,
      );
      return { toppedUp: false, reason: "transfer_failed" };
    }
  }

  /** Tempo float refill budget — pathUSD 6-dec units, separate from the wei budget. */
  private topUpBudgetPathUsd = { windowStart: 0, totalUnits: 0n };
  private static readonly TEMPO_FLOAT_MIN_UNITS = 100_000n; // 0.1 pathUSD
  private static readonly TOPUP_DAILY_MAX_PATHUSD = 50_000_000n; // 50 pathUSD / 24h

  /** Refill a Tempo fronting EOA's pathUSD float from the treasury. The transfer is a
   *  0x76 that pays its own gas in pathUSD (sponsorTempoPathUsd waits for the receipt,
   *  so the in-flight marker is cleared on success). This closes the treasury→EOA leg
   *  on Tempo and is what makes Tempo safe to include in vault mode. */
  private async topUpTempoFloat(
    chainId: number,
    rpcUrl: string,
    eoaAddress: `0x${string}`,
    key: string,
    now: number,
  ): Promise<{ toppedUp: boolean; reason?: string }> {
    if (now - this.topUpBudgetPathUsd.windowStart > SPONSOR_BUDGET_WINDOW_MS) {
      this.topUpBudgetPathUsd = { windowStart: now, totalUnits: 0n };
    }

    const client = getPublicClient(rpcUrl);
    const balance = await tempoPathUsdBalance(
      client as Parameters<typeof tempoPathUsdBalance>[0],
      eoaAddress,
    );
    if (balance >= SponsorService.TEMPO_FLOAT_MIN_UNITS) return { toppedUp: false, reason: "already_funded" };
    const amount = TEMPO_SPONSOR_TARGET - balance;
    if (amount <= 0n) return { toppedUp: false, reason: "already_funded" };

    const treasuryBal = await tempoPathUsdBalance(
      client as Parameters<typeof tempoPathUsdBalance>[0],
      this.config.treasuryAddress,
    );
    if (treasuryBal < TEMPO_TREASURY_FLOOR + amount) {
      await this.alerter.send(
        `float-topup-depleted-${chainId}`,
        `💸 Vela Bundler — treasury pathUSD too low to refill Tempo float on chain ${chainId}.\n` +
          `balance ${treasuryBal} < ${TEMPO_TREASURY_FLOOR + amount} (EOA ${eoaAddress} at ${balance}).\n` +
          `Tempo submits will defer — top up the treasury.`,
      );
      return { toppedUp: false, reason: "treasury_depleted" };
    }
    if (this.topUpBudgetPathUsd.totalUnits + amount > SponsorService.TOPUP_DAILY_MAX_PATHUSD) {
      console.warn(`[FloatTopUp][Tempo] 24h pathUSD budget exhausted on chain ${chainId} — deferring`);
      return { toppedUp: false, reason: "budget_exhausted" };
    }

    const treasuryPrivateKey = await deriveTreasuryPrivateKey(this.config.operatorSecret);
    this.topUpBudgetPathUsd.totalUnits += amount;
    this.topUpInFlight.set(key, now);
    try {
      await this.runTreasuryExclusive(() => sponsorTempoPathUsd({
        chainId,
        privateKey: treasuryPrivateKey,
        rpcUrl,
        to: eoaAddress,
        amount,
      }));
      // sendTransactionSync waited for the receipt — the balance is live now.
      this.topUpInFlight.delete(key);
      console.log(`[FloatTopUp][Tempo] treasury → ${eoaAddress} (chain ${chainId}): ${amount} pathUSD units`);
      return { toppedUp: true };
    } catch (err) {
      this.topUpBudgetPathUsd.totalUnits = this.topUpBudgetPathUsd.totalUnits > amount
        ? this.topUpBudgetPathUsd.totalUnits - amount
        : 0n;
      this.topUpInFlight.delete(key);
      console.error(`[FloatTopUp][Tempo] transfer to ${eoaAddress} failed on chain ${chainId}: ${redactError(err)}`);
      await this.alerter.send(
        `float-topup-failed-${chainId}`,
        `⛽ Vela Bundler — Tempo float refill FAILING on chain ${chainId}.\n` +
          `treasury → ${eoaAddress} (${amount} pathUSD units): ${redactError(err)}`,
      );
      return { toppedUp: false, reason: "transfer_failed" };
    }
  }

  /**
   * Check whether a Safe address has a registered WebAuthn public key.
   *
   * Three outcomes, NOT two: an index OUTAGE (5xx / network error / timeout) must be
   * distinguishable from "not registered" — conflating them silently disables all
   * sponsorship for as long as the outage lasts, with every caller told "no passkey"
   * (a business rejection the wallet won't retry). Callers map "unavailable" to a
   * retryable failure + a Telegram alert.
   */
  private async checkWebAuthnRegistration(
    safeAddress: `0x${string}`,
  ): Promise<"registered" | "not_registered" | "unavailable"> {
    // walletRef = address left-padded to bytes32
    const stripped = safeAddress.replace(/^0x/, "").toLowerCase();
    const walletRef = "0x" + stripped.padStart(64, "0");

    const url = `${WEBAUTHN_INDEX_URL}/api/query?walletRef=${encodeURIComponent(walletRef)}`;

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), WEBAUTHN_QUERY_TIMEOUT_MS);
      const res = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(timer));
      if (res.ok) return "registered";
      if (res.status === 404) return "not_registered";
      console.warn(`[Sponsor] WebAuthn index returned ${res.status} for ${safeAddress}`);
      return "unavailable"; // 5xx / unexpected status — the index is broken, not the user
    } catch {
      // Network error or timeout — the index is unreachable, not the user unregistered.
      console.warn(`[Sponsor] WebAuthn index query failed for ${safeAddress}`);
      return "unavailable";
    }
  }
}
