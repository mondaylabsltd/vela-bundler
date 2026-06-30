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
import { reliabilityHealth } from "../shared/reliability/rpc-fetch.ts";
import {
  processRequest,
  jsonResponse,
  type JsonRpcResponse,
  type RequestContext,
} from "../shared/rpc/process.ts";

/** Max request body size. Enforced by streaming so a chunked (no Content-Length) body
 *  can't bypass the cap and exhaust memory on this directly-bound server. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Read a request body as text, aborting once `maxBytes` is exceeded. Returns null if the
 * body is too large (caller responds 413). Does not trust Content-Length.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

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
    async (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
      const url = new URL(req.url);
      // Real TCP peer address — the only trustworthy rate-limit key on a directly-bound
      // server (client-supplied X-Forwarded-For is spoofable and must not be trusted).
      const peerAddr = (info?.remoteAddr as Deno.NetAddr | undefined)?.hostname;

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
        let oldestMempoolAgeMs = 0;
        let totalPendingReceipts = 0;
        for (const chain of chains) {
          totalMempoolSize += chain.mempool.size;
          totalLockedEOAs += chain.accountService.lockManager.getLockedEOAs().length;
          oldestMempoolAgeMs = Math.max(oldestMempoolAgeMs, chain.mempool.oldestEntryAgeMs());
          totalPendingReceipts += chain.bundler.pendingReceiptCount;
        }
        const rel = reliabilityHealth();
        return Response.json({
          service: "vela-bundler",
          status: totalLockedEOAs > 0 || rel.circuit.degraded > 0 ? "degraded" : "ok",
          activeChains: chains.length,
          mempoolSize: totalMempoolSize,
          oldestMempoolAgeMs,
          lockedEOAs: totalLockedEOAs,
          pendingReceipts: totalPendingReceipts,
          entryPoint: config.entryPointAddress,
          reliability: rel,
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
        req, url, chainRegistry, config, rateLimitConfig, requestRpcUrl, sponsorService, peerAddr,
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
      const limited = rateLimitGuard(req, rateLimitConfig, peerAddr);
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

      // Enforce a 256KB body cap by STREAMING — never trust Content-Length (a chunked
      // request omits it, bypassing a header-only check and letting an attacker buffer an
      // unbounded body → OOM on this directly-bound server).
      const bodyText = await readBodyCapped(req, MAX_BODY_BYTES);
      if (bodyText === null) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: invalidRequest("Request body too large (max 256KB)") }),
          { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
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
