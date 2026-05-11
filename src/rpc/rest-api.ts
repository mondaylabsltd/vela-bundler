/**
 * REST API endpoints for the private prepaid bundler.
 *
 * GET /v1/account/:chainId/:safeAddress
 *   — Multi-chain: chainId in the URL path.
 *   — Supports X-Rpc-Url header for per-request RPC override.
 */

import type { ChainRegistry } from "../chain/index.ts";
import type { BundlerConfig } from "../config/index.ts";
import { rateLimitGuard, type RateLimitConfig } from "../auth/index.ts";
import { resolveRpcUrl } from "../utils/rpc-client.ts";

/**
 * Handle REST API routes. Returns a Response if matched, null otherwise.
 */
export async function handleRestApi(
  req: Request,
  url: URL,
  chainRegistry: ChainRegistry,
  config: BundlerConfig,
  rateLimitConfig: RateLimitConfig,
  requestRpcUrl?: string,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/")) return null;

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Rpc-Url, X-Chain-Id",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const limited = rateLimitGuard(req, rateLimitConfig);
  if (limited) return limited;

  // GET /v1/account/:chainId/:safeAddress
  const accountMatch = url.pathname.match(
    /^\/v1\/account\/(\d+)\/(0x[0-9a-fA-F]{40})$/,
  );
  if (accountMatch && req.method === "GET") {
    return await handleGetAccount(
      parseInt(accountMatch[1]!),
      accountMatch[2]!.toLowerCase() as `0x${string}`,
      chainRegistry,
      config,
      corsHeaders,
      requestRpcUrl,
    );
  }

  return new Response(
    JSON.stringify({ error: "Not found" }),
    { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
}

async function handleGetAccount(
  chainId: number,
  safeAddress: `0x${string}`,
  chainRegistry: ChainRegistry,
  config: BundlerConfig,
  corsHeaders: Record<string, string>,
  requestRpcUrl?: string,
): Promise<Response> {
  if (!/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    return jsonResponse({ error: "Invalid safeAddress" }, 400, corsHeaders);
  }

  try {
    const chain = await chainRegistry.getChain(chainId, requestRpcUrl);
    const effectiveRpc = requestRpcUrl ?? chain.rpcUrl;
    const info = await chain.accountService.getAccountInfo(safeAddress, effectiveRpc);

    return jsonResponse(
      {
        chainId: info.chainId,
        entryPoint: info.entryPoint,
        safeAddress: info.safeAddress,
        activeDepositAddress: info.activeDepositAddress,
        oldDepositAddresses: info.oldDepositAddresses,
        onchainBalance: "0x" + info.onchainBalance.toString(16),
        reservedBalance: "0x" + info.reservedBalance.toString(16),
        spendableBalance: "0x" + info.spendableBalance.toString(16),
        latestNonce: info.latestNonce,
        pendingNonce: info.pendingNonce,
        status: info.status,
        rpcUsed: effectiveRpc,
      },
      200,
      corsHeaders,
    );
  } catch (err) {
    console.error(`[REST] Error for chain ${chainId} / ${safeAddress}:`, err);
    const message = err instanceof Error ? err.message : "Internal error";
    return jsonResponse({ error: message }, 500, corsHeaders);
  }
}

function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
