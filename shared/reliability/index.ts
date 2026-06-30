/**
 * Reliability layer — unified error classification, retry+deadline, circuit
 * breaking, structured logging/metrics, and a single outbound-call wrapper.
 *
 * Use this instead of bare `fetch` / ad-hoc try-catch-retry at call sites.
 */

export {
  classifyError,
  classifyHttpStatus,
  getClassification,
  parseRetryAfter,
  PoisonError,
  CircuitOpenError,
  DeadlineExceededError,
  type ClassifiedError,
  type ErrorCategory,
} from "./errors.ts";

export {
  withRetry,
  createDeadline,
  type Deadline,
  type RetryOptions,
  type RetryAttemptInfo,
} from "./retry.ts";

export {
  CircuitBreaker,
  type CircuitState,
  type BreakerOptions,
} from "./breaker.ts";

export {
  logEvent,
  metrics,
  redactUrl,
  type LogEvent,
  type LogLevel,
} from "./log.ts";

export {
  reliableTextFetch,
  rpcCall,
  outboundBreaker,
  DEFAULT_FETCH_TIMEOUT_MS,
  type ReliableFetchOptions,
  type RpcEnvelope,
  type TextResponse,
} from "./rpc-fetch.ts";
