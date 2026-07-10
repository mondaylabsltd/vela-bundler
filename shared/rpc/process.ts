/**
 * Platform-agnostic JSON-RPC request processing.
 *
 * Extracted from the Deno-specific server so both Deno and CF Worker
 * can reuse the same request handling logic.
 */

import type { BundlerConfig } from "../config/types.ts";
import type { ChainRegistryLike } from "../chain/index.ts";
import { handleRpcMethod } from "./handlers.ts";
import {
  invalidRequest,
  internalError,
  isDeliberateRpcError,
  type JsonRpcError,
} from "./errors.ts";
import { redactError } from "../reliability/log.ts";

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
  chainRegistry: ChainRegistryLike,
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
    // ONLY errors deliberately built via the errors.ts factories are forwarded to the
    // client. A {code,message} duck-type check would forward arbitrary upstream objects
    // verbatim — a viem/provider error can embed the RPC URL (Alchemy key) in its message.
    if (isDeliberateRpcError(err)) {
      return { jsonrpc: "2.0", id, error: err };
    }
    // Redacted: the raw error may carry an RPC URL with an embedded API key.
    console.error(`[RPC] Internal error handling ${req.method}: ${redactError(err)}`);
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
