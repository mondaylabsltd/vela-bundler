/**
 * Operational-health monitor — the "a user's money is stuck / a developer must intervene" alerter.
 *
 * The treasury monitor (treasury.ts) covers the "needs funding" half. THIS covers the other half:
 * every state where a user's transfer cannot complete because of the bundler and a human should
 * look. Each condition fires a de-duplicated Telegram alert (once per cooldown per chain per
 * condition) that says WHAT is stuck, WHERE, for HOW LONG, and the likely cause — so the operator
 * is never blindsided by a stuck user.
 *
 * Conditions:
 *   - a UserOp accepted into the mempool but not getting bundled (oldestMempoolAgeMs)
 *   - a bundle broadcast on-chain but not confirming/reconciling (oldestPendingReceiptAgeMs)
 *   - a dedicated EOA stuck LOCKED_PENDING_UNKNOWN (oldestLockedAgeMs) — can't submit new bundles
 *   - the RPC circuit breaker degraded (circuitDegraded) — the chain may be unreachable
 *   - bundle BROADCAST failing repeatedly (submitFailureStreak) — ops are deleted on submit
 *     failure so no age-based alert can see this; the streak is the only signal
 *   - a dedicated EOA that cannot afford the outer tx (insufficientFundsEoa) — "needs top-up"
 *
 * Money-stuck conditions use a SHORTER dedup cooldown (STUCK_COOLDOWN_MS) than informational
 * ones: while a user's transfer is blocked, one message per 30 minutes is too quiet.
 */

import type { Alerter } from "./telegram.ts";

export interface OperationalThresholds {
  /** A UserOp sitting in the mempool longer than this is "stuck" (not being submitted). */
  mempoolAgeMs: number;
  /** A submitted bundle unconfirmed longer than this is "stuck" (broadcast, not mined). */
  pendingReceiptAgeMs: number;
  /** An EOA LOCKED_PENDING_UNKNOWN longer than this is "stuck" (can't submit new bundles). */
  lockedEoaAgeMs: number;
}

export const DEFAULT_OPERATIONAL_THRESHOLDS: OperationalThresholds = {
  mempoolAgeMs: 120_000, // 2 min — well beyond the ~10s auto-bundle cadence
  pendingReceiptAgeMs: 300_000, // 5 min — a tx not mined by now is a real problem on most chains
  lockedEoaAgeMs: 180_000, // 3 min — many failed health-loop recovery attempts
};

/** Dedup cooldown for MONEY-STUCK conditions (user transfer blocked right now): re-fire every
 *  10 minutes instead of the Alerter's default 30 — with the reminder-count escalation this
 *  reads as an ongoing incident. Informational conditions keep the default cooldown. */
export const STUCK_COOLDOWN_MS = 10 * 60 * 1000;

/** Consecutive broadcast failures before the submit-failing alert fires. Below this it is
 *  treated as transient RPC noise (bounded retries + the next cycle usually clear it). */
export const SUBMIT_FAILURE_ALERT_STREAK = 3;

export interface OperationalSnapshot {
  chainId: number;
  chainName: string | null;
  oldestMempoolAgeMs: number;
  lockedEoaCount: number;
  oldestLockedAgeMs: number;
  pendingReceiptCount: number;
  oldestPendingReceiptAgeMs: number;
  /** reliabilityHealth().circuit.degraded — count of degraded RPC endpoints (global signal). */
  circuitDegraded: number;
  /** Count of sender Safes in a penalized reputation status — i.e. a user whose ops keep failing
   *  re-validation. Senders are NOT hard-blocked, but this signals repeated failures to look at. */
  reputationBannedSenders: number;
  /** Consecutive bundle-broadcast failures (BundlerService.submitFailureStreak). Submit failures
   *  DELETE the ops from the mempool, so no age-based alert can ever observe them — this streak
   *  is the only signal that broadcasts themselves are failing. 0 = healthy. */
  submitFailureStreak: number;
  /** redactError'd message of the last broadcast failure (null when the last submit succeeded). */
  lastSubmitError: string | null;
  /** The dedicated EOA whose last broadcast failed with an insufficient-funds class error —
   *  i.e. a "needs top-up" state the operator (or user) must act on. null when none. */
  insufficientFundsEoa: `0x${string}` | null;
}

/** Human duration for an alert. */
export function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/**
 * Inspect a chain's operational snapshot and fire de-duplicated Telegram alerts for any
 * stuck condition. Never throws (alerter.send never throws; this only reads the snapshot).
 */
export async function checkOperationalHealth(
  snap: OperationalSnapshot,
  thresholds: OperationalThresholds,
  alerter: Alerter,
): Promise<void> {
  const label = snap.chainName ? `${snap.chainName} (${snap.chainId})` : `chain ${snap.chainId}`;

  if (snap.oldestMempoolAgeMs > thresholds.mempoolAgeMs) {
    await alerter.send(
      `stuck-mempool-${snap.chainId}`,
      `🚨 Vela Bundler — UserOp STUCK in mempool on ${label} for ${fmtDuration(snap.oldestMempoolAgeMs)}.\n` +
        `A user's tx was accepted but is not being submitted. Likely: RPC unavailable, pricing gate ` +
        `(unprofitable / margin), or the dedicated EOA lacks balance. Developer/ops attention needed.`,
      { cooldownMs: STUCK_COOLDOWN_MS },
    );
  }

  if (snap.oldestPendingReceiptAgeMs > thresholds.pendingReceiptAgeMs) {
    await alerter.send(
      `stuck-pending-${snap.chainId}`,
      `🚨 Vela Bundler — submitted bundle UNCONFIRMED on ${label} for ${fmtDuration(snap.oldestPendingReceiptAgeMs)} ` +
        `(${snap.pendingReceiptCount} pending). Broadcast but not mined/reconciled — likely underpriced or ` +
        `dropped. The user's tx status is unresolved. Check gas pricing / RPC.`,
      { cooldownMs: STUCK_COOLDOWN_MS },
    );
  }

  if (snap.lockedEoaCount > 0 && snap.oldestLockedAgeMs > thresholds.lockedEoaAgeMs) {
    await alerter.send(
      `stuck-eoa-${snap.chainId}`,
      `🚨 Vela Bundler — ${snap.lockedEoaCount} dedicated EOA(s) STUCK (LOCKED_PENDING_UNKNOWN) on ${label}, ` +
        `oldest ${fmtDuration(snap.oldestLockedAgeMs)}. The health loop can't confirm the in-flight nonce, so ` +
        `that user's EOA can't submit new bundles — money can't move. Often an RPC without reliable "pending" ` +
        `nonce support. Check RPC health; a manual resubmit may be required.`,
      { cooldownMs: STUCK_COOLDOWN_MS },
    );
  }

  // Broadcast itself failing repeatedly. Submit failures DELETE the ops (with failed receipts),
  // so mempool age resets each cycle and none of the age-based alerts above can see this state —
  // without this alert the operator is blind to "every broadcast bounces" (method-level RPC
  // throttle, txpool policy, chronic underfunding). The streak resets on any successful submit.
  if (snap.submitFailureStreak >= SUBMIT_FAILURE_ALERT_STREAK) {
    await alerter.send(
      `submit-failing-${snap.chainId}`,
      `🚨 Vela Bundler — bundle BROADCAST failing on ${label} (${snap.submitFailureStreak} consecutive ` +
        `failures). Users' ops are being rejected at the RPC and returned as failed receipts.\n` +
        `Last error: ${snap.lastSubmitError ?? "unknown"}\n` +
        `Check the trusted RPC (sendRawTransaction path) and the dedicated EOA balances.`,
      { cooldownMs: STUCK_COOLDOWN_MS },
    );
  }

  // "Needs top-up": the outer handleOps tx bounced with an insufficient-funds class error.
  // This is exactly the operator's second intervention category — say WHICH address to fund.
  if (snap.insufficientFundsEoa) {
    await alerter.send(
      `eoa-underfunded-${snap.chainId}-${snap.insufficientFundsEoa}`,
      `💸 Vela Bundler — fronting EOA ${snap.insufficientFundsEoa} on ${label} cannot afford its ` +
        `bundle (insufficient funds at broadcast). Ops keep failing until it is topped up or gas ` +
        `falls. On in-band/vault chains this is an OPERATOR float — raise poolFloatTargetWei / fund ` +
        `the treasury (the refill loop sizes to the shortfall); on legacy chains it is the user's ` +
        `deposit.\nLast error: ${snap.lastSubmitError ?? "unknown"}`,
      { cooldownMs: STUCK_COOLDOWN_MS },
    );
  }

  if (snap.reputationBannedSenders > 0) {
    await alerter.send(
      `reputation-blocked-${snap.chainId}`,
      `⚠️ Vela Bundler — ${snap.reputationBannedSenders} sender Safe(s) on ${label} are in a penalized ` +
        `reputation status (their ops keep failing re-validation). They are NOT blocked from submitting, ` +
        `but repeated failures usually mean the op reverts on-chain (e.g. market moved) or a config issue. ` +
        `Worth investigating why that user's tx keeps failing.`,
    );
  }

  // Circuit-degraded is a PROCESS-GLOBAL signal (reliabilityHealth() is a singleton), so it uses a
  // fixed dedup key — otherwise the Deno registry loop, which calls this once per cached chain,
  // would fire N copies of the same alert. (On CF Workers each chain is a separate DO/isolate with
  // its own alerter, so it necessarily alerts once per active chain there — unavoidable and fine.)
  if (snap.circuitDegraded > 0) {
    await alerter.send(
      `circuit-degraded`,
      `⚠️ Vela Bundler — RPC circuit DEGRADED (${snap.circuitDegraded} endpoint(s)). ` +
        `Submissions and reads may fail until the upstream RPC recovers. Check Alchemy / public RPC health.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Alive heartbeat (dead-man switch, in-process layer)
// ---------------------------------------------------------------------------

/** Default heartbeat period — 6 hours. Silence past this = assume the bundler is DEAD and
 *  investigate (the runbook documents this contract). Alerts are emitted FROM the process being
 *  monitored, so a periodic "alive" is the only in-process way to make death observable. */
export const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Send a periodic "alive" heartbeat if `lastSentAt` is older than `intervalMs`.
 * Returns the new last-sent timestamp (callers persist it: Deno keeps it in the registry,
 * the Worker DO persists it to storage so evictions neither spam nor gap the cadence).
 * `stats` is a short free-form status line (chains / mempool / locked / pending counts).
 */
export async function maybeSendAliveHeartbeat(params: {
  alerter: Alerter;
  lastSentAt: number;
  stats: string;
  runtime: string;
  intervalMs?: number;
  now?: number;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const interval = params.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  if (now - params.lastSentAt < interval) return params.lastSentAt;
  // cooldownMs 0: the periodicity is owned by lastSentAt (persisted by the caller), not the
  // Alerter's in-memory dedup map (which an eviction would reset). noEscalation: heartbeats
  // repeat by design — never dress them as an ongoing incident.
  const delivered = await params.alerter.send(
    `heartbeat-${params.runtime}`,
    `✅ Vela Bundler alive (${params.runtime}) — ${params.stats}`,
    { cooldownMs: 0, noEscalation: true },
  );
  // Advance the stamp ONLY on delivery: a transiently failed send retries next cycle
  // (seconds away) instead of silently opening a 2× interval gap on a channel whose
  // documented contract is "silence = dead".
  return delivered ? now : params.lastSentAt;
}
