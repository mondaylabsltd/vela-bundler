/**
 * Repeated-exception escalation — the "code is broken, a developer must look" alerter.
 *
 * Transient RPC noise must NOT page, but the SAME phase failing N times IN A ROW is either a
 * code bug or a persistently broken dependency — both are developer-intervention states the
 * operator demanded reach Telegram. Every periodic-cycle catch (bundle cycle, receipt
 * reconciliation, EOA recovery, monitors, DO alarm) reports here instead of only console.error:
 *   - `note(phase, chainId, err)` on failure — at `threshold` consecutive failures it fires a
 *     deduped Telegram alert carrying the redacted error (the Alerter cooldown paces repeats).
 *   - `ok(phase, chainId)` on success — resets that phase's streak, so intermittent errors
 *     never accumulate into a page.
 *
 * Counters are in-memory (per process / per DO isolate). An eviction resets them — acceptable:
 * a real recurring bug re-reaches the threshold within a few cycles.
 */

import type { Alerter } from "./telegram.ts";
import { redactError } from "../reliability/log.ts";

/** Consecutive failures of one phase before it is treated as a code/dependency bug. */
const DEFAULT_ESCALATION_THRESHOLD = 3;

export class RepeatedErrorEscalator {
  private readonly streaks = new Map<string, number>();

  constructor(
    private readonly alerter: Alerter,
    private readonly threshold: number = DEFAULT_ESCALATION_THRESHOLD,
  ) {}

  /** Record a failure of `phase`. Fires a deduped alert once the consecutive streak reaches
   *  the threshold. Never throws (alerter.send never throws). */
  async note(phase: string, chainId: number, err: unknown): Promise<void> {
    const key = `${phase}:${chainId}`;
    const streak = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, streak);
    if (streak < this.threshold) return;
    await this.alerter.send(
      `code-error-${phase}-${chainId}`,
      `🐛 Vela Bundler — recurring exception in ${phase} on chain ${chainId} ` +
        `(${streak} consecutive cycles):\n${redactError(err).slice(0, 500)}\n` +
        `This is a code bug or a persistently broken dependency — developer attention needed.`,
    );
  }

  /** Record a success of `phase` — resets its consecutive-failure streak. */
  ok(phase: string, chainId: number): void {
    this.streaks.delete(`${phase}:${chainId}`);
  }

  /** Current streak (for /health surfacing and tests). */
  streak(phase: string, chainId: number): number {
    return this.streaks.get(`${phase}:${chainId}`) ?? 0;
  }
}
