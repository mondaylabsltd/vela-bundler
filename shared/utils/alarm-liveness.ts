/**
 * Liveness test for a Durable Object alarm timestamp, shared by every "arm if missing" guard.
 *
 * `getAlarm() !== null` is NOT proof the alarm chain is alive: a persisted alarm whose scheduled
 * time is already in the past can be a ZOMBIE — armed but never delivered (local workerd does not
 * deliver overdue alarms from a previous dev process after a hot reload; in production a wedged
 * in-flight alarm invocation leaves the same signature). Both alarm bodies re-arm as their FIRST
 * statement, so a healthy loop keeps the scheduled time in the future at all times — a scheduled
 * time more than a grace window in the past therefore means the loop is dead, and every guard that
 * would "skip re-arm because an alarm exists" must re-arm instead.
 *
 * Two grace tiers, chosen by what a false positive costs at the call site:
 *  - TIGHT (admission //_init): work is being admitted and a cycle is wanted soon anyway, and the
 *    alarm bodies are idempotent (first-line re-arm, kickBundle latch, reconcile is a no-op when
 *    idle) — so re-arming a nearly-due alarm is harmless, while TRUSTING a zombie strands the op
 *    (in dev there is no cron layer to ever catch it). Only a genuinely-imminent delivery
 *    (kick-now, or a schedule missed by mere seconds) is left alone.
 *  - LENIENT (cron liveness probe): a false positive fires an operator ZOMBIE alert, so tolerate
 *    realistic platform delivery lag. Capped well below the 5-min mempool TTL so a real zombie is
 *    still caught (and its ops TTL-evicted to a terminal receipt) before money-path state strands.
 */

/** Tight tier: past-due by more than this at admission/_init time → treat as dead. Real deliveries
 *  land within single-digit seconds of schedule; a dev-orphaned zombie is older at any human-scale
 *  next touch. Worst case of a wrong call is one duplicate (latched, idempotent) cycle. */
export const ALARM_TIGHT_GRACE_MS = 5_000;

/** Lenient tier floor: how far past schedule an armed alarm may be before the cron probe calls it
 *  dead. Generous against platform delivery lag (re-arming would only postpone by one interval —
 *  never lose work — but the probe also ALERTS, and false pages train operators to ignore them). */
export const ALARM_OVERDUE_GRACE_MS = 60_000;

/** Lenient tier ceiling: the grace also scales with 2× the configured re-arm interval, but is
 *  capped here so an operator-configured AUTO_BUNDLE_INTERVAL_MS can never push the grace past the
 *  5-min mempool TTL (which would re-enable exactly the stranded-op regression this file exists to
 *  prevent). 120s keeps a real zombie catchable by the very next 5-min cron pass. */
export const ALARM_GRACE_CAP_MS = 120_000;

/** How long an alarm invocation may be observed in flight (in-memory `alarmInFlightSince`) before
 *  the liveness probe treats it as WEDGED rather than merely slow. Matches the 5-min mempool TTL:
 *  a body that has not completed within a full TTL has already let ops strand. */
export const ALARM_IN_FLIGHT_WEDGE_MS = 300_000;

/**
 * True when an armed alarm can still be trusted to fire: it is scheduled in the future, or past
 * by no more than `graceMs` (default: the lenient tier, min(max(60s, 2× interval), 120s)).
 * `null`/`undefined` (no alarm) is never live. Pass `graceMs: ALARM_TIGHT_GRACE_MS` at
 * admission//_init sites (see the tier rationale above).
 */
export function alarmIsLive(
  alarmAt: number | null | undefined,
  intervalMs: number,
  now: number = Date.now(),
  graceMs?: number,
): boolean {
  if (alarmAt === null || alarmAt === undefined) return false;
  const grace = graceMs ?? Math.min(Math.max(ALARM_OVERDUE_GRACE_MS, 2 * intervalMs), ALARM_GRACE_CAP_MS);
  return now - alarmAt <= grace;
}
