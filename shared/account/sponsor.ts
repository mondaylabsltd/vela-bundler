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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max relayer EOA nonce to qualify for sponsorship. */
const MAX_SPONSOR_NONCE = 6;

/** Gas units used to calculate the max sponsor amount per transfer. */
const MAX_SPONSOR_GAS = 5_000_000n;

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

/** Minimum treasury balance to keep (0.01 ETH). Won't sponsor below this. */
const TREASURY_FLOOR = 10_000_000_000_000_000n;

/** Cooldown between sponsorship attempts for the same Safe address (5 min). */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

/** Fallback gas limit for ETH transfers (L2s like Arbitrum need more than 21k). */
const TRANSFER_GAS_FALLBACK = 100_000n;

/** Timeout for waiting on tx confirmation. */
const CONFIRM_TIMEOUT_MS = 15_000;

/** Timeout for WebAuthn index query. */
const WEBAUTHN_QUERY_TIMEOUT_MS = 5_000;

const WEBAUTHN_INDEX_URL = "https://webauthnp256-publickey-index.biubiu.tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SponsorResult {
  sponsored: boolean;
  txHash?: string;
  amount?: string; // hex wei
  reason?: string;
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

  /**
   * Serializes all transactions sent FROM the single treasury EOA. Without this, two
   * concurrent sponsorships of DIFFERENT safes both auto-fetch the same `pending` nonce
   * and one tx is dropped/replaced. Funds aren't lost (nonce reuse just fails one), but
   * the user sees a spurious sponsor failure. A promise-chain mutex keeps treasury sends
   * strictly sequential so each picks up the prior one's nonce.
   */
  private treasuryTxChain: Promise<unknown> = Promise.resolve();

  constructor(config: BundlerConfig) {
    this.config = config;
  }

  /** Run `fn` exclusively against the treasury nonce (serialized across all callers). */
  private runTreasuryExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.treasuryTxChain.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome.
    this.treasuryTxChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async sponsor(
    chainId: number,
    safeAddress: `0x${string}`,
    relayerAddress: `0x${string}`,
    rpcUrl: string,
    clientHintWei?: bigint,
  ): Promise<SponsorResult> {
    const safeLower = safeAddress.toLowerCase();
    const relayerLower = relayerAddress.toLowerCase();

    // 1. Rate limit — only blocks if a previous sponsorship SUCCEEDED recently
    const lastTime = this.lastAttempt.get(safeLower);
    if (lastTime && Date.now() - lastTime < RATE_LIMIT_COOLDOWN_MS) {
      return { sponsored: false, reason: "rate_limited" };
    }

    // 2. Concurrency guard
    if (this.pending.has(relayerLower)) {
      return { sponsored: false, reason: "already_in_progress" };
    }
    this.pending.add(relayerLower);

    try {
      const result = await this._doSponsor(chainId, safeLower as `0x${string}`, relayerLower as `0x${string}`, rpcUrl, clientHintWei);
      // Only set cooldown on successful sponsorship — failed attempts can retry immediately
      if (result.sponsored) {
        this.lastAttempt.set(safeLower, Date.now());
      }
      return result;
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
      const hasPasskey = await this.checkWebAuthnRegistration(safeAddress);
      if (!hasPasskey) {
        return { sponsored: false, reason: "no_passkey_registered" };
      }
      return await this._doSponsorTempo(chainId, relayerAddress, rpcUrl);
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
    // spikes. The hint is compared raw and used as-is when it wins — it carries
    // the wallet's own headroom, so it doesn't get the server-side volatility margin.
    const serverEstimate = (gasPrice * 600_000n * 2n * SPONSOR_VOLATILITY_BUFFER_BPS) / 10_000n;
    let targetBalance = serverEstimate;
    if (clientHintWei && clientHintWei > targetBalance) targetBalance = clientHintWei;
    if (targetBalance < MIN_SPONSOR_BALANCE) targetBalance = MIN_SPONSOR_BALANCE;
    const sponsorAmount = targetBalance > maxSponsorAmount ? maxSponsorAmount : targetBalance;
    if (safeBalance < sponsorAmount * 2n) {
      return { sponsored: false, reason: "wallet_balance_too_low" };
    }

    // 5. WebAuthn public key check — must be a registered Vela user
    const hasPasskey = await this.checkWebAuthnRegistration(safeAddress);
    if (!hasPasskey) {
      return { sponsored: false, reason: "no_passkey_registered" };
    }

    // 6. Treasury balance check
    const treasuryAddress = this.config.treasuryAddress;
    const treasuryBalance = await client.getBalance({ address: treasuryAddress });
    if (treasuryBalance < TREASURY_FLOOR + maxSponsorAmount + TRANSFER_GAS_FALLBACK * gasPrice) {
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
      console.error(`[Sponsor] Transfer failed:`, redactError(err));
      return {
        sponsored: false,
        reason: "transfer_failed",
      };
    }
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
  ): Promise<SponsorResult> {
    const client = getPublicClient(rpcUrl);

    const relayerBalance = await tempoPathUsdBalance(client, relayerAddress);
    if (relayerBalance >= TEMPO_SPONSOR_TARGET) {
      return { sponsored: false, reason: "already_funded" };
    }
    const amount = TEMPO_SPONSOR_TARGET - relayerBalance;

    const treasuryBalance = await tempoPathUsdBalance(client, this.config.treasuryAddress);
    if (treasuryBalance < amount + TEMPO_TREASURY_FLOOR) {
      return { sponsored: false, reason: "treasury_depleted" };
    }

    const treasuryPrivateKey = await deriveTreasuryPrivateKey(this.config.operatorSecret);
    console.log(
      `[Sponsor][Tempo] treasury → ${relayerAddress} (chain ${chainId}): ${amount} pathUSD units`,
    );
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
  }

  /**
   * Check if a Safe address has a registered WebAuthn public key.
   */
  private async checkWebAuthnRegistration(safeAddress: `0x${string}`): Promise<boolean> {
    // walletRef = address left-padded to bytes32
    const stripped = safeAddress.replace(/^0x/, "").toLowerCase();
    const walletRef = "0x" + stripped.padStart(64, "0");

    const url = `${WEBAUTHN_INDEX_URL}/api/query?walletRef=${encodeURIComponent(walletRef)}`;

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), WEBAUTHN_QUERY_TIMEOUT_MS);
      const res = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(timer));
      return res.ok; // 200 = registered, 404 = not found
    } catch {
      // Network error or timeout — deny sponsorship
      console.warn(`[Sponsor] WebAuthn index query failed for ${safeAddress}`);
      return false;
    }
  }
}
