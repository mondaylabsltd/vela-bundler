/**
 * Structured logging + lightweight in-process metrics.
 *
 * - logEvent() emits a single JSON line so Cloudflare Workers Logs / any log
 *   pipeline can filter on dependency / error_category / outcome etc. instead of
 *   grepping prose. Secrets (API keys in RPC URLs, private keys, tokens) are never
 *   logged — URLs are redacted and only a short, secret-free `detail` is included.
 * - metrics is a per-instance counter/gauge registry surfaced via /health so an
 *   operator can watch dependency degradation, retry-exhaustion, DLQ depth and
 *   queue age without a separate metrics backend.
 */

import type { ErrorCategory } from "./errors.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level?: LogLevel;
  /** Logical dependency: "rpc" | "chain-registry" | "webauthn" | "do-storage" | "internal". */
  dependency?: string;
  /** Operation name, e.g. "eth_call", "getBalance", "sendTransaction". */
  operation?: string;
  attempt?: number;
  /** From classifyError. */
  error_category?: ErrorCategory;
  retryable?: boolean;
  latency_ms?: number;
  /** Whether the failure was a timeout/deadline. */
  timeout?: boolean;
  /** "ok" | "error" | "retry" | "circuit_open" | "degraded" | "exhausted". */
  outcome?: string;
  reason?: string;
  http_status?: number;
  /** Correlation: request id, chain id, job/idempotency key. */
  correlation_id?: string;
  chain_id?: number;
  /** Redacted endpoint. */
  endpoint?: string;
  /** Short, secret-free detail. */
  detail?: string;
  [k: string]: unknown;
}

/** Redact an API key / token embedded in an RPC URL path or query for safe logging. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/[a-zA-Z0-9_-]{20,}(?=\/|$)/g, "/***");
    if (u.search) u.search = u.search.replace(/([?&][^=]*=)[a-zA-Z0-9_-]{16,}/g, "$1***");
    if (u.username || u.password) { u.username = "***"; u.password = ""; }
    return u.toString();
  } catch {
    return url.replace(/[a-zA-Z0-9_-]{20,}/g, "***");
  }
}

/** Emit one structured JSON log line. `now` injectable for tests. */
export function logEvent(ev: LogEvent, now: () => number = Date.now): void {
  const level = ev.level ?? "info";
  const line = { t: now(), lvl: level, ...ev };
  delete (line as Record<string, unknown>).level;
  const text = safeStringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(obj);
  }
}

// ---------------------------------------------------------------------------
// Metrics registry (per-instance)
// ---------------------------------------------------------------------------

class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();

  inc(name: string, by = 1, labels?: Record<string, string | number>): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: string, value: number, labels?: Record<string, string | number>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  private key(name: string, labels?: Record<string, string | number>): string {
    if (!labels) return name;
    const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
    return parts.length ? `${name}{${parts.join(",")}}` : name;
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

/** Shared per-instance metrics registry. */
export const metrics = new Metrics();
