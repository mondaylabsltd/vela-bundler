/**
 * Unit tests for the shared alarm-liveness check (shared/utils/alarm-liveness.ts).
 *
 * Regression: a RelayerDO mempool op sat past its 5-min TTL because a persisted alarm orphaned
 * by a dev-server reload was scheduled in the PAST yet non-null, and every "arm if missing"
 * guard (handleSubmit / _init / handleEnsureAlarm) read `getAlarm() !== null` as alive.
 */

import { it, expect } from "vitest";
import {
  alarmIsLive,
  ALARM_TIGHT_GRACE_MS,
  ALARM_OVERDUE_GRACE_MS,
  ALARM_GRACE_CAP_MS,
} from "../shared/utils/alarm-liveness.ts";

const NOW = 1_784_345_600_000;
const INTERVAL = 10_000;

it("alarmIsLive - no alarm (null/undefined) is not live", () => {
  expect(alarmIsLive(null, INTERVAL, NOW)).toBe(false);
  expect(alarmIsLive(undefined, INTERVAL, NOW)).toBe(false);
});

it("alarmIsLive - a future alarm is live", () => {
  expect(alarmIsLive(NOW + 1, INTERVAL, NOW)).toBe(true);
  expect(alarmIsLive(NOW + INTERVAL, INTERVAL, NOW)).toBe(true);
});

it("alarmIsLive - lenient tier: a briefly-overdue alarm (delivery delayed) is still trusted", () => {
  expect(alarmIsLive(NOW - 1_000, INTERVAL, NOW)).toBe(true);
  expect(alarmIsLive(NOW - ALARM_OVERDUE_GRACE_MS, INTERVAL, NOW)).toBe(true);
});

it("alarmIsLive - a past-due alarm beyond the grace window is DEAD (the zombie-alarm regression)", () => {
  expect(alarmIsLive(NOW - ALARM_OVERDUE_GRACE_MS - 1, INTERVAL, NOW)).toBe(false);
  // The incident signature: alarm frozen ~7 minutes in the past when the op was admitted.
  expect(alarmIsLive(NOW - 7 * 60_000, INTERVAL, NOW)).toBe(false);
});

it("alarmIsLive - lenient grace scales with a long configured interval (2x interval when > 60s)", () => {
  const longInterval = 45_000; // 2x = 90s > 60s flat grace
  expect(alarmIsLive(NOW - 89_000, longInterval, NOW)).toBe(true);
  expect(alarmIsLive(NOW - 90_001, longInterval, NOW)).toBe(false);
});

it("alarmIsLive - lenient grace is CAPPED so a huge configured interval cannot outlive the mempool TTL", () => {
  // Uncapped, 2x 240s = 480s grace would exceed the 300s TTL and re-enable the stranded-op
  // regression; the cap (120s) must keep a zombie detectable well before the TTL.
  const hugeInterval = 240_000;
  expect(ALARM_GRACE_CAP_MS).toBeLessThan(300_000);
  expect(alarmIsLive(NOW - ALARM_GRACE_CAP_MS - 1, hugeInterval, NOW)).toBe(false);
  expect(alarmIsLive(NOW - ALARM_GRACE_CAP_MS, hugeInterval, NOW)).toBe(true);
});

it("alarmIsLive - tight tier (admission/_init): only a genuinely-imminent delivery is trusted", () => {
  // A kick-now alarm read moments later stays untouched...
  expect(alarmIsLive(NOW - 1_000, INTERVAL, NOW, ALARM_TIGHT_GRACE_MS)).toBe(true);
  // ...but a zombie only seconds old is already re-armed — in dev there is no cron layer, so
  // an admission that trusts a young zombie (lenient tier would) strands the op it just accepted.
  expect(alarmIsLive(NOW - ALARM_TIGHT_GRACE_MS - 1, INTERVAL, NOW, ALARM_TIGHT_GRACE_MS)).toBe(false);
  expect(alarmIsLive(NOW - 30_000, INTERVAL, NOW, ALARM_TIGHT_GRACE_MS)).toBe(false);
});
