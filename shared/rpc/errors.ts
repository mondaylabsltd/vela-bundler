/**
 * JSON-RPC error utilities.
 */


export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Marker distinguishing errors DELIBERATELY built for the client (via these factories)
 *  from arbitrary upstream objects that merely duck-type {code,message} — forwarding the
 *  latter verbatim can leak provider internals (an Alchemy URL embeds the API key). */
export const RPC_ERROR_MARKER = Symbol.for("vela.rpcError");

export function isDeliberateRpcError(err: unknown): err is JsonRpcError {
  return typeof err === "object" && err !== null &&
    (err as Record<PropertyKey, unknown>)[RPC_ERROR_MARKER] === true;
}

export function rpcError(code: number, message: string, data?: unknown): JsonRpcError {
  const err: JsonRpcError = { code, message, data };
  Object.defineProperty(err, RPC_ERROR_MARKER, { value: true, enumerable: false });
  return err;
}

export function invalidRequest(message: string): JsonRpcError {
  return rpcError(-32600, message);
}

export function methodNotFound(method: string): JsonRpcError {
  return rpcError(-32601, `Method not found: ${method}`);
}

export function invalidParams(message: string): JsonRpcError {
  return rpcError(-32602, message);
}

export function internalError(message: string): JsonRpcError {
  return rpcError(-32603, message);
}

export function parseError(): JsonRpcError {
  return rpcError(-32700, "Parse error");
}

export function bundlerError(code: number, message: string, data?: unknown): JsonRpcError {
  return rpcError(code, message, data);
}

/**
 * Transient-degradation error (SERVICE_DEGRADED, -32000). Use for upstream-dependency
 * instability (RPC down/slow, deadline exceeded, circuit open) so the client gets a
 * STABLE, retryable signal instead of a business-rejection code. Never leaks the raw
 * provider message — only a stable reason and an optional Retry-After hint.
 */
export function serviceDegraded(message: string, opts?: { retryAfterMs?: number; reason?: string }): JsonRpcError {
  return rpcError(-32000, message, {
    retryable: true,
    ...(opts?.retryAfterMs != null ? { retryAfterMs: opts.retryAfterMs } : {}),
    ...(opts?.reason ? { reason: opts.reason } : {}),
  });
}
