/**
 * Unified outbound dependency call wrapper.
 *
 * Every raw outbound HTTP/RPC call should go through here so that timeout,
 * circuit-breaking, bounded retry (transient only), Retry-After, error
 * classification, metrics and structured logging are applied uniformly — instead
 * of each call site re-implementing (or forgetting) them.
 *
 * Layering per call:
 *   withRetry( breaker.guard( fetch-with-timeout ) )
 *
 * - fetch-with-timeout: a single attempt, hard-cancelled by an AbortController.
 * - breaker.guard: fast-fails when the endpoint host is known-degraded; records
 *   success/failure to drive open/half-open/closed transitions.
 * - withRetry: retries ONLY transient failures, with backoff+jitter, under a
 *   total deadline budget.
 *
 * JSON-RPC note: a 200 response whose body carries `{ error: { … } }` is a
 * BUSINESS result (e.g. an EVM revert with data), NOT a transport failure — it is
 * returned to the caller verbatim and never retried here. Only transport-level
 * failures (network error, timeout, transient HTTP status) drive retry/breaker.
 */

import { CircuitBreaker } from "./breaker.ts";
import { classifyHttpStatus, type ClassifiedError } from "./errors.ts";
import { withRetry, createDeadline, type Deadline } from "./retry.ts";
import { logEvent, metrics, redactUrl } from "./log.ts";

/** Default per-attempt timeout. */
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/** Shared per-instance breaker for all outbound calls, keyed by endpoint host. */
export const outboundBreaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 1,
});

export interface ReliableFetchOptions {
  /** Per-attempt timeout (connect+read). Default DEFAULT_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Max attempts incl. first. Default 3. */
  maxAttempts?: number;
  /** Total time budget across attempts+backoff. Default = timeoutMs × maxAttempts. */
  deadlineMs?: number;
  /** Pre-built deadline (propagated from an upstream request budget). */
  deadline?: Deadline;
  /** Logical dependency label for logs/metrics. Default "rpc". */
  dependency?: string;
  /** Operation name for logs/metrics. */
  operation?: string;
  /** Correlation id (request/job id) for tracing. */
  correlationId?: string;
  chainId?: number;
  /** Override the breaker (tests). */
  breaker?: CircuitBreaker;
  /** Disable the breaker for this call. */
  noBreaker?: boolean;
  /** Injectables for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rng?: () => number;
  fetchImpl?: typeof fetch;
}

export interface TextResponse {
  status: number;
  headers: Headers;
  text: string;
}

class HttpStatusError extends Error {
  readonly classified: ClassifiedError;
  readonly status: number;
  constructor(classified: ClassifiedError, status: number, detail?: string) {
    super(`http ${status}: ${classified.reason}${detail ? ` — ${detail}` : ""}`);
    this.name = "HttpStatusError";
    this.classified = classified;
    this.status = status;
  }
}

function breakerKeyFor(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Perform a transport-reliable fetch returning the full text body.
 *
 * Throws (classified) on network error, timeout, or a TRANSIENT HTTP status
 * (so retry/breaker engage). RETURNS for 2xx and for PERMANENT non-2xx statuses
 * (e.g. 404) — the caller inspects `.status` and decides the business meaning.
 */
export async function reliableTextFetch(
  url: string,
  init: RequestInit,
  opts: ReliableFetchOptions = {},
): Promise<TextResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? 3;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const breaker = opts.noBreaker ? undefined : (opts.breaker ?? outboundBreaker);
  const key = breakerKeyFor(url);
  const dependency = opts.dependency ?? "rpc";
  const endpoint = redactUrl(url);
  const deadline =
    opts.deadline ?? createDeadline(opts.deadlineMs ?? timeoutMs * maxAttempts, now);

  const oneAttempt = async (): Promise<TextResponse> => {
    const controller = new AbortController();
    // Bound this attempt by min(per-attempt timeout, remaining deadline).
    const budget = Math.max(1, Math.min(timeoutMs, deadline.remainingMs()));
    const timer = setTimeout(() => controller.abort(makeTimeout(budget)), budget);
    (timer as unknown as { unref?: () => void })?.unref?.();
    // Also abort if the propagated deadline signal fires.
    const onDeadline = () => controller.abort(makeTimeout(budget));
    deadline.signal?.addEventListener?.("abort", onDeadline, { once: true });
    try {
      // redirect:"manual" — never auto-follow a redirect: a user-allowed public RPC host
      // must not be able to 302 us to an internal/metadata IP (SSRF). A redirecting RPC is
      // rejected (not retried — it's not a transient condition).
      const res = await doFetch(url, { ...init, signal: controller.signal, redirect: "manual" });
      // Cast res.type to string: @cloudflare/workers-types narrows Response.type to
      // "default" | "error" (workerd never surfaces "opaqueredirect"), but this guard also
      // runs under Node/undici where "opaqueredirect" IS a possible value. The status-range
      // check below is the belt-and-suspenders that catches redirects on either runtime.
      if ((res.type as string) === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        const e = new Error(`refusing to follow redirect from ${redactUrl(url)}`);
        (e as { classified?: ClassifiedError }).classified = { category: "permanent", retryable: false, reason: "redirect_blocked" };
        throw e;
      }
      const text = await res.text();
      // Only non-2xx/3xx statuses are candidates for transient classification.
      if (res.status >= 400) {
        const cls = classifyHttpStatus(res.status, res.headers.get("retry-after"), now());
        if (cls.category === "transient") {
          // Transient HTTP status → throw so retry/breaker engage.
          throw new HttpStatusError(cls, res.status, truncate(text));
        }
      }
      return { status: res.status, headers: res.headers, text };
    } finally {
      clearTimeout(timer);
      deadline.signal?.removeEventListener?.("abort", onDeadline);
    }
  };

  const guarded = breaker ? () => breaker.guard(key, oneAttempt) : oneAttempt;

  const startedAt = now();
  try {
    const res = await withRetry(guarded, {
      maxAttempts,
      deadline,
      now: opts.now,
      sleep: opts.sleep,
      rng: opts.rng,
      label: `${dependency}:${opts.operation ?? "fetch"}`,
      onRetry: (info) => {
        metrics.inc("dependency_retry_total", 1, { dependency });
        logEvent({
          level: "warn", dependency, operation: opts.operation, endpoint, chain_id: opts.chainId,
          correlation_id: opts.correlationId, attempt: info.attempt, outcome: "retry",
          error_category: info.classified.category, retryable: true, reason: info.classified.reason,
          http_status: info.classified.httpStatus, detail: info.classified.detail, delay_ms: info.delayMs,
        }, now);
      },
    });
    metrics.inc("dependency_request_total", 1, { dependency, outcome: "ok" });
    logEvent({
      level: "debug", dependency, operation: opts.operation, endpoint, chain_id: opts.chainId,
      correlation_id: opts.correlationId, outcome: "ok", http_status: res.status,
      latency_ms: now() - startedAt,
    }, now);
    return res;
  } catch (err) {
    const cls = (err as { classified?: ClassifiedError }).classified;
    const reason = cls?.reason ?? "error";
    const category = cls?.category;
    metrics.inc("dependency_request_total", 1, { dependency, outcome: "error" });
    if (reason === "circuit_open") metrics.inc("dependency_circuit_open_total", 1, { dependency });
    if (reason === "deadline_exceeded" || reason === "timeout") metrics.inc("dependency_timeout_total", 1, { dependency });
    if (category === "transient") metrics.inc("dependency_retry_exhausted_total", 1, { dependency });
    logEvent({
      level: "warn", dependency, operation: opts.operation, endpoint, chain_id: opts.chainId,
      correlation_id: opts.correlationId, outcome: reason === "circuit_open" ? "circuit_open" : "error",
      error_category: category, retryable: false, reason, http_status: cls?.httpStatus,
      timeout: reason === "timeout" || reason === "deadline_exceeded", latency_ms: now() - startedAt,
      detail: cls?.detail,
    }, now);
    throw err;
  }
}

export interface RpcEnvelope {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Reliable JSON-RPC POST. Returns the parsed envelope (`{ result }` or
 * `{ error }`) — the caller interprets `error` (it may carry revert data).
 *
 * Transport failures (network/timeout/transient status) are retried + breaker'd.
 * A 2xx body that fails to parse is treated as a transient degraded-RPC failure.
 */
export async function rpcCall(
  url: string,
  jsonRpcBody: unknown,
  opts: ReliableFetchOptions = {},
): Promise<RpcEnvelope> {
  const res = await reliableTextFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof jsonRpcBody === "string" ? jsonRpcBody : JSON.stringify(jsonRpcBody),
    },
    { dependency: "rpc", ...opts },
  );
  try {
    return JSON.parse(res.text) as RpcEnvelope;
  } catch {
    // 2xx but unparseable (HTML error page from a degraded node, truncated body).
    // Surface as transient so the caller's fallback / retry path engages.
    const e = new Error(`non-JSON RPC response (status ${res.status})`);
    (e as { classified?: ClassifiedError }).classified = {
      category: "transient", retryable: true, reason: "non_json_response", httpStatus: res.status,
    };
    throw e;
  }
}

/**
 * Observability snapshot for /health: circuit-breaker states (endpoints redacted) +
 * per-instance counters/gauges. No secrets — keys are origins, further redacted.
 */
export function reliabilityHealth(): {
  circuit: { degraded: number; endpoints: Array<{ endpoint: string; state: string; failures: number }> };
  metrics: { counters: Record<string, number>; gauges: Record<string, number> };
} {
  const endpoints = outboundBreaker.snapshot().map((b) => ({
    endpoint: redactUrl(b.key),
    state: b.state,
    failures: b.consecutiveFailures,
  }));
  return {
    circuit: { degraded: outboundBreaker.degradedCount(), endpoints },
    metrics: metrics.snapshot(),
  };
}

function makeTimeout(ms: number): Error {
  const e = new Error(`request timed out after ${ms}ms`);
  e.name = "TimeoutError";
  return e;
}

function truncate(s: string): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 160) + "…" : t;
}
