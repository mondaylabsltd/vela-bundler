/**
 * Unified error classification.
 *
 * The reliability layer must NOT decide retryability from free-text alone. This
 * module classifies a failure from STRUCTURED signals first — HTTP status,
 * AbortSignal reason, OS/socket error codes, JSON-RPC error codes, viem error
 * shapes — and only falls back to a small curated substring set when no
 * structured signal is present.
 *
 * Three categories (see the audit brief):
 *   - transient : short-lived infra failure → safe to retry with backoff+deadline.
 *   - permanent : a definitive business/protocol rejection → never retry.
 *   - poison    : a contract violation / programming bug / undeserializable data →
 *                 stop retrying, isolate, alert. (Set explicitly by callers via
 *                 `poison()`; classifyError never infers poison from transport.)
 */

export type ErrorCategory = "transient" | "permanent" | "poison";

export interface ClassifiedError {
  /** Coarse bucket driving handling policy. */
  category: ErrorCategory;
  /** Whether the unified retry layer may retry this. Only ever true for `transient`. */
  retryable: boolean;
  /** HTTP status, when the failure carried one. */
  httpStatus?: number;
  /** Honoured backoff floor from a `Retry-After` header / RPC hint, in ms. */
  retryAfterMs?: number;
  /** Short, stable machine reason code (safe to log / surface in metrics). */
  reason: string;
  /** Truncated, secret-free message for logs. Never the raw provider body. */
  detail?: string;
}

/** HTTP statuses that represent a transient condition worth retrying. */
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509, 520, 521, 522, 523, 524, 525, 527, 530]);

/**
 * 4xx that are definitively permanent (do not retry). 408/425/429 are transient
 * and handled above; everything else in 4xx is a client/permission/route error.
 */
function isPermanentHttp(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return false;
  if (status === 501) return true; // Not Implemented — permanent
  return status >= 400 && status < 500;
}

/** OS / socket level error codes that indicate a transient network condition. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_RESPONSE_STATUS_CODE",
]);

/**
 * JSON-RPC error codes that are permanent (malformed request / unknown method).
 * Note: a JSON-RPC `error` returned in a 200 response is usually a BUSINESS result
 * (e.g. an EVM revert carrying data) — callers decide. This is only consulted when
 * an error is thrown/propagated as the failure itself.
 */
const PERMANENT_RPC_CODES = new Set([-32600, -32601, -32602, -32700]);

const MAX_DETAIL = 200;

function truncate(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_DETAIL ? t.slice(0, MAX_DETAIL) + "…" : t;
}

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) into ms.
 * Returns undefined when absent/unparseable. `nowMs` is injectable for tests.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = parseInt(trimmed, 10);
    return Number.isFinite(secs) ? Math.max(0, secs * 1000) : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
}

/** Build a transient classification from an HTTP status + optional Retry-After. */
export function classifyHttpStatus(status: number, retryAfter?: string | null, nowMs?: number): ClassifiedError {
  // 2xx/3xx are NOT errors — never retryable. (Callers should normally not classify a
  // success status, but guard so a 200 can never be mistaken for a transient failure.)
  if (status >= 200 && status < 400) {
    return { category: "permanent", retryable: false, httpStatus: status, reason: `http_${status}` };
  }
  if (TRANSIENT_HTTP.has(status)) {
    return {
      category: "transient",
      retryable: true,
      httpStatus: status,
      retryAfterMs: parseRetryAfter(retryAfter, nowMs),
      reason: status === 429 ? "http_429_rate_limited" : `http_${status}`,
    };
  }
  if (isPermanentHttp(status)) {
    return { category: "permanent", retryable: false, httpStatus: status, reason: `http_${status}` };
  }
  // Unknown non-2xx — treat conservatively as transient (could be an edge proxy code).
  return { category: "transient", retryable: true, httpStatus: status, reason: `http_${status}` };
}

/** True for our own deadline/timeout aborts and platform abort/timeout errors. */
function isAbortLike(name: string | undefined, msg: string): boolean {
  if (name === "AbortError" || name === "TimeoutError" || name === "DeadlineExceededError") return true;
  return /\b(timed out|timeout|aborted|deadline exceeded)\b/i.test(msg);
}

/**
 * Classify an arbitrary thrown error into a handling category from structured
 * signals first. `nowMs` is injectable for deterministic tests.
 */
export function classifyError(err: unknown, nowMs: number = Date.now()): ClassifiedError {
  // Walk the cause chain collecting structured signals; viem/undici nest the real
  // cause several levels deep.
  let status: number | undefined;
  let retryAfter: string | null | undefined;
  let code: string | number | undefined;
  let name: string | undefined;
  const messages: string[] = [];

  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    const o = cur as Record<string, unknown>;
    if (status === undefined && typeof o.status === "number") status = o.status;
    if (status === undefined && typeof o.statusCode === "number") status = o.statusCode as number;
    if (name === undefined && typeof o.name === "string") name = o.name;
    if (code === undefined && (typeof o.code === "string" || typeof o.code === "number")) code = o.code as string | number;
    if (typeof o.shortMessage === "string") messages.push(o.shortMessage);
    if (typeof o.message === "string") messages.push(o.message);
    // viem HttpRequestError carries a Headers object
    const headers = o.headers as { get?: (k: string) => string | null } | undefined;
    if (retryAfter == null && headers && typeof headers.get === "function") {
      retryAfter = headers.get("retry-after");
    }
    cur = o.cause;
  }

  const msg = messages.join(" | ");

  // 1. Abort / timeout (our deadline cancellation or platform timeout) → transient.
  if (isAbortLike(name, msg)) {
    return { category: "transient", retryable: true, reason: "timeout", detail: truncate(msg) };
  }

  // 2. HTTP status present.
  if (typeof status === "number" && status > 0) {
    const c = classifyHttpStatus(status, retryAfter, nowMs);
    return { ...c, detail: truncate(msg) };
  }

  // 3. JSON-RPC numeric code.
  if (typeof code === "number") {
    if (PERMANENT_RPC_CODES.has(code)) {
      return { category: "permanent", retryable: false, reason: `rpc_${code}`, detail: truncate(msg) };
    }
    // -32000..-32099 are server-defined; usually transient overload/timeout.
    if (code <= -32000 && code >= -32099) {
      return { category: "transient", retryable: true, reason: `rpc_${code}`, detail: truncate(msg) };
    }
  }

  // 4. OS/socket error code.
  if (typeof code === "string") {
    if (TRANSIENT_CODES.has(code)) {
      return { category: "transient", retryable: true, reason: code.toLowerCase(), detail: truncate(msg) };
    }
    if (code === "ENOTFOUND" || code === "EAI_FAIL") {
      // DNS resolution failure — could be misconfig (permanent) but is frequently a
      // transient resolver blip. Bounded retry is the safer default.
      return { category: "transient", retryable: true, reason: "dns_failure", detail: truncate(msg) };
    }
  }

  // 5. Fallback: a small curated substring set — LAST resort only.
  const low = msg.toLowerCase();
  if (/(fetch failed|network|socket hang up|connection (closed|reset|refused)|econn|etimedout|temporarily|temporary|too many requests|rate.?limit|503|502|504|overloaded|try again)/.test(low)) {
    return { category: "transient", retryable: true, reason: "transient_text_match", detail: truncate(msg) };
  }

  // Default: do NOT retry an unrecognised error. Surfacing it stable is safer than
  // hammering an upstream on an error we don't understand.
  return { category: "permanent", retryable: false, reason: "unclassified", detail: truncate(msg) };
}

/** Sentinel error type for explicit poison / contract-violation cases. */
export class PoisonError extends Error {
  readonly classified: ClassifiedError;
  constructor(reason: string, detail?: string) {
    super(`poison: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "PoisonError";
    this.classified = { category: "poison", retryable: false, reason, detail: detail ? truncate(detail) : undefined };
  }
}

/** Error thrown by a circuit breaker when the circuit is open (fast-fail). */
export class CircuitOpenError extends Error {
  readonly classified: ClassifiedError;
  constructor(key: string) {
    super(`circuit open for ${key}`);
    this.name = "CircuitOpenError";
    // Open circuit = the dependency is known-degraded. Transient (it will recover)
    // but NOT retryable in-line — the whole point is to fast-fail and shed load.
    this.classified = { category: "transient", retryable: false, reason: "circuit_open" };
  }
}

/** Error thrown when a total deadline budget is exhausted. */
export class DeadlineExceededError extends Error {
  readonly classified: ClassifiedError;
  constructor(label = "operation") {
    super(`deadline exceeded: ${label}`);
    this.name = "DeadlineExceededError";
    this.classified = { category: "transient", retryable: false, reason: "deadline_exceeded" };
  }
}

/** Extract an already-attached classification (PoisonError/CircuitOpenError/…) or classify fresh. */
export function getClassification(err: unknown, nowMs?: number): ClassifiedError {
  if (err && typeof err === "object" && "classified" in err) {
    const c = (err as { classified?: ClassifiedError }).classified;
    if (c && typeof c === "object" && "category" in c) return c;
  }
  return classifyError(err, nowMs);
}
