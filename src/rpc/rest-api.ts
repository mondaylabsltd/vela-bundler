/**
 * REST API endpoints for the private prepaid bundler.
 *
 * GET /v1/account/:chainId/:safeAddress
 *   — Returns deposit address, balance, and status for a safeAddress.
 *   — Idempotent: same inputs always return the same activeDepositAddress.
 *   — Requires authentication.
 *   — Supports X-Rpc-Url header for per-request RPC override (used for balance queries).
 */

import type { AccountService } from "../account/index.ts";
import { authGuard, type AuthConfig } from "../auth/index.ts";
import { resolveRpcUrl, getPublicClient } from "../utils/rpc-client.ts";

/**
 * Handle REST API routes. Returns a Response if matched, null otherwise.
 */
export async function handleRestApi(
  req: Request,
  url: URL,
  accountService: AccountService,
  authConfig: AuthConfig,
  requestRpcUrl?: string,
): Promise<Response | null> {
  // Only handle /v1/ routes
  if (!url.pathname.startsWith("/v1/")) return null;

  // CORS
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Rpc-Url",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth guard on all /v1/ endpoints
  const authResponse = authGuard(req, authConfig);
  if (authResponse) return authResponse;

  // GET /v1/account/:chainId/:safeAddress
  const accountMatch = url.pathname.match(
    /^\/v1\/account\/(\d+)\/(0x[0-9a-fA-F]{40})$/,
  );
  if (accountMatch && req.method === "GET") {
    return await handleGetAccount(
      parseInt(accountMatch[1]!),
      accountMatch[2]!.toLowerCase() as `0x${string}`,
      accountService,
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
  accountService: AccountService,
  corsHeaders: Record<string, string>,
  requestRpcUrl?: string,
): Promise<Response> {
  // Validate chainId matches this bundler's chain
  if (chainId !== accountService["config"].chainId) {
    return jsonResponse(
      { error: `This bundler serves chainId ${accountService["config"].chainId}, not ${chainId}` },
      400,
      corsHeaders,
    );
  }

  // Validate safeAddress format
  if (!/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    return jsonResponse(
      { error: "Invalid safeAddress" },
      400,
      corsHeaders,
    );
  }

  try {
    // Resolve effective RPC: X-Rpc-Url > user RPCs > config default
    const effectiveRpc = resolveRpcUrl(accountService["config"], requestRpcUrl);
    const info = await accountService.getAccountInfo(safeAddress, effectiveRpc);

    return jsonResponse(
      {
        chainId: info.chainId,
        entryPoint: info.entryPoint,
        safeAddress: info.safeAddress,
        activeDepositAddress: info.activeDepositAddress,
        oldDrainingAddresses: info.oldDrainingAddresses,
        keyVersion: info.keyVersion,
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
    console.error(`[REST] Error fetching account info for ${safeAddress}:`, err);
    return jsonResponse(
      { error: "Internal error" },
      500,
      corsHeaders,
    );
  }
}

function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    },
  );
}
