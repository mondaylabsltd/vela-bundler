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
    );
  }

  if (snap.oldestPendingReceiptAgeMs > thresholds.pendingReceiptAgeMs) {
    await alerter.send(
      `stuck-pending-${snap.chainId}`,
      `🚨 Vela Bundler — submitted bundle UNCONFIRMED on ${label} for ${fmtDuration(snap.oldestPendingReceiptAgeMs)} ` +
        `(${snap.pendingReceiptCount} pending). Broadcast but not mined/reconciled — likely underpriced or ` +
        `dropped. The user's tx status is unresolved. Check gas pricing / RPC.`,
    );
  }

  if (snap.lockedEoaCount > 0 && snap.oldestLockedAgeMs > thresholds.lockedEoaAgeMs) {
    await alerter.send(
      `stuck-eoa-${snap.chainId}`,
      `🚨 Vela Bundler — ${snap.lockedEoaCount} dedicated EOA(s) STUCK (LOCKED_PENDING_UNKNOWN) on ${label}, ` +
        `oldest ${fmtDuration(snap.oldestLockedAgeMs)}. The health loop can't confirm the in-flight nonce, so ` +
        `that user's EOA can't submit new bundles — money can't move. Often an RPC without reliable "pending" ` +
        `nonce support. Check RPC health; a manual resubmit may be required.`,
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
