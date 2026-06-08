/**
 * Cloudflare Worker entry point — routes requests to per-chain BundlerDO instances.
 */

import type { Env } from "./types.ts";
import { deriveTreasuryAddress } from "../shared/keys/derive.ts";

// Re-export BundlerDO for wrangler to discover
export { BundlerDO } from "./bundler-do.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Rpc-Url",
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Homepage
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vela Bundler</title></head>` +
        `<body><h1>Vela Bundler</h1><p>ERC-4337 multi-chain bundler on Cloudflare Workers.</p>` +
        `<p><a href="/health">/health</a></p></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    // Global health
    if ((url.pathname === "/health" || url.pathname === "/api/health") && request.method === "GET") {
      return Response.json({
        service: "vela-bundler",
        runtime: "cloudflare-workers",
        status: "ok",
      }, { headers: { ...CORS_HEADERS, "Cache-Control": "no-cache, no-store, must-revalidate" } });
    }

    // JSON-RPC: POST /:chainId
    const pathChainId = url.pathname.match(/^\/(\d+)$/);
    if (pathChainId && request.method === "POST") {
      const chainId = parseInt(pathChainId[1]!);
      return routeToDO(env, request, chainId, "/rpc");
    }

    // REST API: /v1/account/:chainId/:safeAddress or /v1/sponsor/:chainId/:safeAddress
    if (url.pathname.startsWith("/v1/")) {
      const chainMatch = url.pathname.match(/^\/v1\/(?:account|sponsor)\/(\d+)\//);
      if (chainMatch) {
        const chainId = parseInt(chainMatch[1]!);
        return routeToDO(env, request, chainId, "/rest", url.pathname);
      }

      // /v1/treasury — no chain needed, derive from OPERATOR_SECRET directly
      if (url.pathname === "/v1/treasury" && request.method === "GET") {
        const addr = await deriveTreasuryAddress(env.OPERATOR_SECRET);
        return Response.json({ address: addr }, { headers: CORS_HEADERS });
      }
    }

    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST /:chainId for JSON-RPC (e.g. POST /1)" } },
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Backup cron trigger — DO alarms are self-sustaining once started,
    // but this ensures they recover if the runtime evicts a DO.
    // Active DOs will be woken by their own alarms; this is a no-op safety net.
  },
};

/**
 * Route a request to the BundlerDO instance for the given chain.
 */
function routeToDO(
  env: Env,
  request: Request,
  chainId: number,
  path: string,
  originalPath?: string,
): Promise<Response> {
  const doId = env.BUNDLER.idFromName(`chain-${chainId}`);
  const stub = env.BUNDLER.get(doId);

  const doUrl = new URL(request.url);
  doUrl.pathname = path;
  doUrl.searchParams.set("chainId", chainId.toString());
  if (originalPath) {
    doUrl.searchParams.set("originalPath", originalPath);
  }

  return stub.fetch(new Request(doUrl.toString(), request));
}
