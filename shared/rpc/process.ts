/**
 * Platform-agnostic JSON-RPC request processing.
 *
 * Extracted from the Deno-specific server so both Deno and CF Worker
 * can reuse the same request handling logic.
 */

import type { BundlerConfig } from "../config/types.ts";
import type { ChainRegistry } from "../chain/index.ts";
import { handleRpcMethod } from "./handlers.ts";
import {
  parseError,
  invalidRequest,
  internalError,
  type JsonRpcError,
} from "./errors.ts";

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface RpcContext {
  config: BundlerConfig;
  chain: import("../chain/index.ts").ChainServices;
}

export interface RequestContext {
  requestRpcUrl?: string;
  chainId: number;
}

/**
 * Process a single JSON-RPC request body.
 */
export async function processRequest(
  body: unknown,
  config: BundlerConfig,
  chainRegistry: ChainRegistry,
  reqCtx: RequestContext,
): Promise<JsonRpcResponse> {
  if (!body || typeof body !== "object") {
    return { jsonrpc: "2.0", id: null, error: invalidRequest("Invalid request") };
  }

  const req = body as Record<string, unknown>;

  if (req.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: (req.id as number | string) ?? null,
      error: invalidRequest("jsonrpc must be '2.0'"),
    };
  }

  if (typeof req.method !== "string") {
    return {
      jsonrpc: "2.0",
      id: (req.id as number | string) ?? null,
      error: invalidRequest("method must be a string"),
    };
  }

  const id = (req.id as number | string) ?? null;
  const params = Array.isArray(req.params) ? req.params : [];

  try {
    const result = await handleRpcMethod(req.method, params, config, chainRegistry, reqCtx);
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      return { jsonrpc: "2.0", id, error: err as JsonRpcError };
    }
    console.error(`[RPC] Error handling ${req.method}:`, err);
    return {
      jsonrpc: "2.0",
      id,
      error: internalError("Internal error"),
    };
  }
}

/**
 * Serialize response to JSON, handling bigint values.
 */
export function jsonResponse(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify(data, (_key, value) =>
      typeof value === "bigint" ? "0x" + value.toString(16) : value,
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    },
  );
}
