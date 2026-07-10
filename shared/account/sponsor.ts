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
import { deriveTreasuryPrivateKey } from "../keys/derive.ts";
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
