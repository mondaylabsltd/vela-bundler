/**
 * Unified retry + deadline.
 *
 * One place that owns "retry this transient operation". Every retried call path
 * goes through here so the policy (which errors are retryable, backoff shape,
 * jitter, Retry-After, total budget) is consistent and testable — not
 * re-implemented per call site.
 *
 * Guarantees:
 *   - Bounded attempts (default 3) AND bounded total time (deadline budget).
 *   - Exponential backoff with FULL jitter (random in [0, cap]) to avoid
 *     synchronised retry storms.
 *   - Honours `Retry-After` as a floor on the next delay.
 *   - NEVER retries a non-retryable (permanent/poison/circuit-open) error.
 *   - The clock, sleep and RNG are injectable so tests run with a fake clock and
 *     zero real wall-time.
 *
 * IMPORTANT: only wrap IDEMPOTENT operations (reads, or writes guarded by an
 * idempotency key / on-chain nonce). Never wrap a raw tx broadcast with this.
 */

import { classifyError, getClassification, DeadlineExceededError, type ClassifiedError } from "./errors.ts";

export interface Deadline {
  /** Milliseconds left in the budget (never negative). */
  remainingMs(): number;
  /** True once the budget is exhausted. */
  expired(): boolean;
  /** Optional signal that aborts when the deadline passes (for fetch/abortable work). */
  readonly signal?: AbortSignal;
}

/**
 * Create a deadline budget of `totalMs`. `now` is injectable for tests.
 * When `withSignal` is true, returns a deadline whose `signal` aborts at expiry.
 */
export function createDeadline(totalMs: number, now: () => number = Date.now, withSignal = false): Deadline {
  const start = now();
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (withSignal && typeof AbortController !== "undefined") {
    controller = new AbortController();
    timer = setTimeout(() => controller!.abort(new DeadlineExceededError()), Math.max(0, totalMs));
    // Best-effort: don't keep the process alive solely for this timer (Deno/Node).
    (timer as unknown as { unref?: () => void })?.unref?.();
  }
  return {
    remainingMs: () => Math.max(0, totalMs - (now() - start)),
    expired: () => now() - start >= totalMs,
    signal: controller?.signal,
  };
}

export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  classified: ClassifiedError;
  elapsedMs: number;
}

export interface RetryOptions {
  /** Max total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (attempt 1 → [0, base], attempt 2 → [0, 2·base], …). Default 200. */
  baseDelayMs?: number;
  /** Cap on a single backoff delay. Default 4000. */
  maxDelayMs?: number;
  /** Total wall-time budget across ALL attempts+sleeps. Default Infinity (attempt-bounded only). */
  deadlineMs?: number;
  /** Pre-built deadline (takes precedence over deadlineMs). */
  deadline?: Deadline;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Honour Retry-After as a floor on the next delay. Default true. */
  respectRetryAfter?: boolean;
  /** Override the retryable predicate. Default: classified.retryable. */
  isRetryable?: (c: ClassifiedError) => boolean;
  /** Structured hook fired before each backoff sleep. */
  onRetry?: (info: RetryAttemptInfo) => void;
  /** Label for errors/logs. */
  label?: string;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
  /** Injectable sleep. Default real setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable RNG in [0,1). Default Math.random. */
  rng?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signalReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    (t as unknown as { unref?: () => void })?.unref?.();
    function onAbort() {
      clearTimeout(t);
      reject(signalReason(signal!));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function signalReason(signal: AbortSignal): Error {
  const r = (signal as { reason?: unknown }).reason;
  if (r instanceof Error) return r;
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Run `fn` with unified retry. `fn` receives the 1-based attempt number.
 * Rethrows the LAST error (with its classification reachable via getClassification)
 * once retries/budget are exhausted or the error is non-retryable.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 200;
  const maxDelay = opts.maxDelayMs ?? 4000;
  const respectRetryAfter = opts.respectRetryAfter ?? true;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;
  const isRetryable = opts.isRetryable ?? ((c: ClassifiedError) => c.retryable);
  const deadline = opts.deadline ?? (opts.deadlineMs != null ? createDeadline(opts.deadlineMs, now) : undefined);
  const start = now();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw signalReason(opts.signal);
    if (deadline?.expired()) throw new DeadlineExceededError(opts.label);
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const classified = getClassification(err, now());
      const lastAttempt = attempt >= maxAttempts;
      if (lastAttempt || !isRetryable(classified)) throw err;

      // Full jitter: random point in [0, cap], cap = min(maxDelay, base·2^(attempt-1)).
      const cap = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      let delay = Math.floor(rng() * cap);
      if (respectRetryAfter && classified.retryAfterMs != null) {
        delay = Math.max(delay, classified.retryAfterMs);
      }

      // Don't sleep past the deadline budget — fail now rather than overrun.
      if (deadline) {
        const remaining = deadline.remainingMs();
        if (remaining <= 0) throw new DeadlineExceededError(opts.label);
        if (delay >= remaining) throw new DeadlineExceededError(opts.label);
      }

      opts.onRetry?.({ attempt, delayMs: delay, classified, elapsedMs: now() - start });
      if (delay > 0) await sleep(delay, opts.signal ?? deadline?.signal);
    }
  }
  // Unreachable in practice (loop either returns or throws), but satisfies the type.
  throw lastErr ?? classifyAsError(opts.label);
}

function classifyAsError(label?: string): Error {
  const e = new Error(`retry exhausted${label ? `: ${label}` : ""}`);
  return e;
}

/** Convenience: classify without importing errors.ts at the call site. */
export { classifyError };
