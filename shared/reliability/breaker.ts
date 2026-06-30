/**
 * Per-key circuit breaker.
 *
 * Goal: when an external endpoint (an RPC URL) is persistently failing, stop
 * sending it requests that will only eat full timeouts and pile up — fast-fail
 * instead, shed load, and let it recover. This is what prevents a dead upstream
 * from amplifying into our latency / thread / connection exhaustion.
 *
 * States per key:
 *   closed    — normal; count consecutive failures.
 *   open      — reject immediately until `cooldownMs` elapses.
 *   half-open — allow a few probe calls; a success closes, a failure re-opens.
 *
 * The clock is injectable for deterministic tests.
 */

import { CircuitOpenError } from "./errors.ts";

export type CircuitState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  /** Consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before probing (ms). Default 30_000. */
  cooldownMs?: number;
  /** Concurrent probes allowed in half-open. Default 1. */
  halfOpenMaxProbes?: number;
  /** Successes in half-open required to fully close. Default 1. */
  halfOpenSuccessesToClose?: number;
  /** Injectable clock. Default Date.now. */
  now?: () => number;
  /** Max distinct keys retained (LRU-ish eviction). Default 500. */
  maxKeys?: number;
}

interface KeyState {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenProbes: number;
  halfOpenSuccesses: number;
  lastTransition: number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly halfOpenSuccessesToClose: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly keys = new Map<string, KeyState>();

  constructor(opts: BreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.halfOpenMaxProbes = opts.halfOpenMaxProbes ?? 1;
    this.halfOpenSuccessesToClose = opts.halfOpenSuccessesToClose ?? 1;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 500;
  }

  private getOrInit(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      if (this.keys.size >= this.maxKeys) {
        const oldest = this.keys.keys().next().value;
        if (oldest !== undefined) this.keys.delete(oldest);
      }
      s = { state: "closed", consecutiveFailures: 0, openedAt: 0, halfOpenProbes: 0, halfOpenSuccesses: 0, lastTransition: this.now() };
      this.keys.set(key, s);
    }
    return s;
  }

  /** Current state, transitioning open→half-open if the cooldown has elapsed. */
  state(key: string): CircuitState {
    const s = this.keys.get(key);
    if (!s) return "closed";
    if (s.state === "open" && this.now() - s.openedAt >= this.cooldownMs) {
      s.state = "half-open";
      s.halfOpenProbes = 0;
      s.halfOpenSuccesses = 0;
      s.lastTransition = this.now();
    }
    return s.state;
  }

  /**
   * Whether a request may proceed. In half-open this reserves a probe slot, so
   * each `true` MUST be paired with exactly one onSuccess/onFailure.
   */
  allow(key: string): boolean {
    const st = this.state(key);
    if (st === "closed") return true;
    if (st === "open") return false;
    // half-open: admit up to halfOpenMaxProbes concurrent probes
    const s = this.getOrInit(key);
    if (s.halfOpenProbes < this.halfOpenMaxProbes) {
      s.halfOpenProbes++;
      return true;
    }
    return false;
  }

  onSuccess(key: string): void {
    const s = this.getOrInit(key);
    if (s.state === "half-open") {
      s.halfOpenSuccesses++;
      s.halfOpenProbes = Math.max(0, s.halfOpenProbes - 1);
      if (s.halfOpenSuccesses >= this.halfOpenSuccessesToClose) {
        s.state = "closed";
        s.consecutiveFailures = 0;
        s.lastTransition = this.now();
      }
    } else {
      s.consecutiveFailures = 0;
      s.state = "closed";
    }
  }

  onFailure(key: string): void {
    const s = this.getOrInit(key);
    if (s.state === "half-open") {
      // A probe failed — re-open immediately.
      s.state = "open";
      s.openedAt = this.now();
      s.halfOpenProbes = 0;
      s.halfOpenSuccesses = 0;
      s.lastTransition = this.now();
      return;
    }
    s.consecutiveFailures++;
    if (s.consecutiveFailures >= this.failureThreshold) {
      s.state = "open";
      s.openedAt = this.now();
      s.lastTransition = this.now();
    }
  }

  /**
   * Guard `fn` with the breaker. Throws CircuitOpenError immediately when open.
   * Records success/failure for state transitions and rethrows fn's error.
   */
  async guard<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.allow(key)) throw new CircuitOpenError(key);
    try {
      const r = await fn();
      this.onSuccess(key);
      return r;
    } catch (err) {
      this.onFailure(key);
      throw err;
    }
  }

  /** Snapshot for observability (/health). Keys are caller-redacted before passing in. */
  snapshot(): Array<{ key: string; state: CircuitState; consecutiveFailures: number }> {
    const out: Array<{ key: string; state: CircuitState; consecutiveFailures: number }> = [];
    for (const [key, s] of this.keys) {
      // Refresh open→half-open lazily so the snapshot reflects reality.
      const state = this.state(key);
      out.push({ key, state, consecutiveFailures: s.consecutiveFailures });
    }
    return out;
  }

  /** Number of keys currently not closed (open or half-open). */
  degradedCount(): number {
    let n = 0;
    for (const key of this.keys.keys()) {
      if (this.state(key) !== "closed") n++;
    }
    return n;
  }

  clear(): void {
    this.keys.clear();
  }
}
