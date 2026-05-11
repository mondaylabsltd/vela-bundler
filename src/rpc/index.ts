/**
 * JSON-RPC server implementing ERC-7769 bundler API + REST API.
 *
 * Multi-chain: chainId comes per-request, services resolved lazily.
 * Supports per-request RPC override via X-Rpc-Url header.
 */

import type { BundlerConfig } from "../config/index.ts";
import type { ChainRegistry, ChainServices } from "../chain/index.ts";
import { handleRpcMethod } from "./handlers.ts";
import { handleRestApi } from "./rest-api.ts";
import type { RateLimitConfig } from "../auth/index.ts";
import {
  parseError,
  invalidRequest,
  internalError,
  type JsonRpcError,
} from "./errors.ts";

// Load homepage HTML at startup (built from README.md via `deno task build`)
let HOME_HTML = "";
try {
  HOME_HTML = await Deno.readTextFile(new URL("../index.html", import.meta.url));
} catch {
  HOME_HTML = "<html><body><h1>Vela Bundler</h1><p>Run <code>deno task build</code> to generate homepage.</p></body></html>";
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface RpcContext {
  config: BundlerConfig;
  chain: ChainServices;
}

export interface RequestContext {
  requestRpcUrl?: string;
  chainId: number;
}

/**
 * Start the multi-chain JSON-RPC + REST HTTP server.
 */
export function startRpcServer(
  config: BundlerConfig,
  chainRegistry: ChainRegistry,
): Deno.HttpServer {
  const rateLimitConfig: RateLimitConfig = {
    rateLimitPerMinute: config.apiRateLimitPerMinute,
  };

  const server = Deno.serve(
    { port: config.port, hostname: config.host },
    async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      // Homepage
      if (url.pathname === "/" && req.method === "GET") {
        return new Response(HOME_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Health / service identification
      if ((url.pathname === "/health" || url.pathname === "/api/health") && req.method === "GET") {
        return Response.json({
          service: "vela-bundler",
          status: "ok",
        }, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        });
      }

      const requestRpcUrl = req.headers.get("x-rpc-url") ?? undefined;

      // REST API (/v1/...)
      const restResponse = await handleRestApi(
        req, url, chainRegistry, config, rateLimitConfig, requestRpcUrl,
      );
      if (restResponse) return restResponse;

      // CORS headers
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Rpc-Url",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // JSON-RPC: POST /:chainId
      // Extract chainId from URL path (e.g. /1, /137, /42161)
      const pathChainId = url.pathname.match(/^\/(\d+)$/);
      if (!pathChainId || req.method !== "POST") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: invalidRequest("POST /:chainId for JSON-RPC (e.g. POST /1)") }),
          { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      const chainId = parseInt(pathChainId[1]!);

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: parseError() }, corsHeaders);
      }

      const reqCtx: RequestContext = { requestRpcUrl, chainId };

      if (Array.isArray(body)) {
        const responses = await Promise.all(
          body.map((item) => processRequest(item, config, chainRegistry, reqCtx)),
        );
        return jsonResponse(responses, corsHeaders);
      }

      const response = await processRequest(body, config, chainRegistry, reqCtx);
      return jsonResponse(response, corsHeaders);
    },
  );

  console.log(`[RPC] Server listening on ${config.host}:${config.port}`);
  console.log(`[RPC] REST API: GET /v1/account/:chainId/:safeAddress`);
  return server;
}

async function processRequest(
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
