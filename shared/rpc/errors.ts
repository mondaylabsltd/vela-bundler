/**
 * JSON-RPC error utilities.
 */


export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export function rpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return { code, message, data };
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
