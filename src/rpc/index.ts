/**
 * JSON-RPC server implementing ERC-7769 bundler API + private REST API.
 *
 * Supports per-request RPC override via X-Rpc-Url header.
 * Priority: X-Rpc-Url > USER_RPC_URLS > RPC_URL > registry.
 */

import type { BundlerConfig } from "../config/index.ts";
import type { Simulator } from "../simulation/index.ts";
import { Mempool } from "../mempool/index.ts";
import { BundlerService } from "../bundler/index.ts";
import type { AccountService } from "../account/index.ts";
import { handleRpcMethod } from "./handlers.ts";
import { handleRestApi } from "./rest-api.ts";
import type { AuthConfig } from "../auth/index.ts";
import {
  parseError,
  invalidRequest,
  internalError,
  type JsonRpcError,
} from "./errors.ts";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface RpcContext {
  config: BundlerConfig;
  mempool: Mempool;
  simulator: Simulator;
  bundler: BundlerService;
  accountService: AccountService;
}

/**
 * Per-request context carrying the optional RPC override.
 */
export interface RequestContext {
  /** Per-request RPC URL override from X-Rpc-Url header (highest priority). */
  requestRpcUrl?: string;
}

/**
 * Start the JSON-RPC + REST HTTP server.
 */
export function startRpcServer(ctx: RpcContext): Deno.HttpServer {
  const { config } = ctx;
  const authConfig: AuthConfig = {
    apiToken: config.apiToken,
    rateLimitPerMinute: config.apiRateLimitPerMinute,
  };

  const server = Deno.serve(
    { port: config.port, hostname: config.host },
    async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      // Extract per-request RPC override
      const requestRpcUrl = req.headers.get("x-rpc-url") ?? undefined;

      // Route REST API requests (/v1/...)
      const restResponse = await handleRestApi(
        req, url, ctx.accountService, authConfig, requestRpcUrl,
      );
      if (restResponse) return restResponse;

      // CORS headers for JSON-RPC
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Rpc-Url",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (req.method !== "POST") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: invalidRequest("Only POST allowed for JSON-RPC") }),
          { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: parseError() }, corsHeaders);
      }

      const reqCtx: RequestContext = { requestRpcUrl };

      // Handle batch requests
      if (Array.isArray(body)) {
        const responses = await Promise.all(
          body.map((item) => processRequest(item, ctx, reqCtx)),
        );
        return jsonResponse(responses, corsHeaders);
      }

      const response = await processRequest(body, ctx, reqCtx);
      return jsonResponse(response, corsHeaders);
    },
  );

  console.log(`[RPC] Server listening on ${config.host}:${config.port}`);
  console.log(`[RPC] REST API: GET /v1/account/:chainId/:safeAddress`);
  console.log(`[RPC] Per-request RPC override: X-Rpc-Url header`);
  return server;
}

async function processRequest(
  body: unknown,
  ctx: RpcContext,
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
    const result = await handleRpcMethod(req.method, params, ctx, reqCtx);
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      return { jsonrpc: "2.0", id, error: err as JsonRpcError };
    }
    console.error(`[RPC] Error handling ${req.method}:`, err);
    return {
      jsonrpc: "2.0",
      id,
      error: internalError(
        err instanceof Error ? err.message : "Internal error",
      ),
    };
  }
}

function jsonResponse(data: unknown, extraHeaders: Record<string, string> = {}): Response {
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
