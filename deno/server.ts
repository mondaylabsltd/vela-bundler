/**
 * Deno-specific HTTP server using Deno.serve.
 *
 * Routes JSON-RPC and REST requests, delegates processing to shared modules.
 */

import type { BundlerConfig } from "../shared/config/types.ts";
import type { ChainRegistry } from "../shared/chain/index.ts";
import { handleRestApi } from "../shared/rpc/rest-api.ts";
import type { SponsorService } from "../shared/account/sponsor.ts";
import { rateLimitGuard, type RateLimitConfig } from "../shared/auth/index.ts";
import {
  parseError,
  invalidRequest,
  internalError,
} from "../shared/rpc/errors.ts";
import { validateRpcUrl } from "../shared/utils/rpc-client.ts";
import {
  processRequest,
  jsonResponse,
  type JsonRpcResponse,
  type RequestContext,
} from "../shared/rpc/process.ts";

// Load homepage HTML at startup (built from README.md via `deno task build`)
let HOME_HTML = "";
try {
  HOME_HTML = await Deno.readTextFile(new URL("./index.html", import.meta.url));
} catch {
  HOME_HTML = "<html><body><h1>Vela Bundler</h1><p>Run <code>deno task build</code> to generate homepage.</p></body></html>";
}

/**
 * Start the multi-chain JSON-RPC + REST HTTP server.
 */
export function startRpcServer(
  config: BundlerConfig,
  chainRegistry: ChainRegistry,
  sponsorService?: SponsorService,
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
        const chains = chainRegistry.getAll();
        let totalMempoolSize = 0;
        let totalLockedEOAs = 0;
        for (const chain of chains) {
          totalMempoolSize += chain.mempool.size;
          totalLockedEOAs += chain.accountService.lockManager.getLockedEOAs().length;
        }
        return Response.json({
          service: "vela-bundler",
          status: totalLockedEOAs > 0 ? "degraded" : "ok",
          activeChains: chains.length,
          mempoolSize: totalMempoolSize,
          lockedEOAs: totalLockedEOAs,
          entryPoint: config.entryPointAddress,
        }, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        });
      }

      const rawRpcUrl = req.headers.get("x-rpc-url") ?? undefined;
      let requestRpcUrl: string | undefined;
      if (rawRpcUrl) {
        const validationError = validateRpcUrl(rawRpcUrl);
        if (validationError) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: null, error: invalidRequest(`Invalid X-Rpc-Url: ${validationError}`) }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        requestRpcUrl = rawRpcUrl;
      }

      // REST API (/v1/...)
      const restResponse = await handleRestApi(
        req, url, chainRegistry, config, rateLimitConfig, requestRpcUrl, sponsorService,
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

      // Rate limit JSON-RPC requests (same limiter as REST API)
      const limited = rateLimitGuard(req, rateLimitConfig);
      if (limited) return limited;

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
      if (isNaN(chainId) || chainId <= 0) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: invalidRequest("Invalid chainId") }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      let body: unknown;
      try {
        // Enforce 256KB body size limit to prevent OOM from oversized payloads
        const contentLength = req.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > 256 * 1024) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: null, error: invalidRequest("Request body too large (max 256KB)") }),
            { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }
        body = await req.json();
      } catch {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: parseError() }, corsHeaders);
      }

      const reqCtx: RequestContext = { requestRpcUrl, chainId };

      if (Array.isArray(body)) {
        if (body.length > 20) {
          return Response.json(
            { jsonrpc: "2.0", id: null, error: invalidRequest("Batch too large (max 20)") },
            { status: 400, headers: corsHeaders },
          );
        }
        const results = await Promise.allSettled(
          body.map((item) => processRequest(item, config, chainRegistry, reqCtx)),
        );
        const responses = results.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : { jsonrpc: "2.0" as const, id: (body[i]?.id as number | string) ?? null, error: internalError("Internal error") },
        );
        return jsonResponse(responses, corsHeaders);
      }

      const response = await processRequest(body, config, chainRegistry, reqCtx);
      return jsonResponse(response, corsHeaders);
    },
  );

  console.log(`[RPC] Server listening on ${config.host}:${config.port}`);
  console.log(`[RPC] REST API: GET /v1/account/:chainId/:safeAddress`);
  if (sponsorService) {
    console.log(`[RPC] REST API: POST /v1/sponsor/:chainId/:safeAddress`);
  }
  return server;
}
