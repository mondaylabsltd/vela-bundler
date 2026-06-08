/**
 * REST API endpoints for the private prepaid bundler.
 *
 * GET /v1/account/:chainId/:safeAddress
 *   — Multi-chain: chainId in the URL path.
 *   — Supports X-Rpc-Url header for per-request RPC override.
 */

import type { ChainRegistryLike } from "../chain/index.ts";
import type { BundlerConfig } from "../config/types.ts";
import { rateLimitGuard, type RateLimitConfig } from "../auth/index.ts";
import { blacklistRpc, isRpcBlacklisted, hasFallback } from "../utils/rpc-blacklist.ts";
import type { SponsorService } from "../account/sponsor.ts";

/**
 * Handle REST API routes. Returns a Response if matched, null otherwise.
 */
export async function handleRestApi(
  req: Request,
  url: URL,
  chainRegistry: ChainRegistryLike,
  config: BundlerConfig,
  rateLimitConfig: RateLimitConfig,
  requestRpcUrl?: string,
  sponsorService?: SponsorService,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/")) return null;

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

  // GET /v1/treasury — return the treasury address (same on all chains)
  if (url.pathname === "/v1/treasury" && req.method === "GET") {
    return jsonResponse({ address: config.treasuryAddress }, 200, corsHeaders);
  }

  // POST /v1/sponsor/:chainId/:safeAddress
  const sponsorMatch = url.pathname.match(
    /^\/v1\/sponsor\/(\d+)\/(0x[0-9a-fA-F]{40})$/,
  );
  if (sponsorMatch && req.method === "POST" && sponsorService) {
    // Parse optional requiredWei from request body
    let requiredWei: bigint | undefined;
    try {
      const body = await req.json() as { requiredWei?: string };
      if (body.requiredWei) requiredWei = BigInt(body.requiredWei);
    } catch { /* no body or invalid JSON — use server-side calculation */ }

    return await handleSponsor(
      parseInt(sponsorMatch[1]!),
      sponsorMatch[2]!.toLowerCase() as `0x${string}`,
      chainRegistry,
      config,
      corsHeaders,
      sponsorService,
      requestRpcUrl,
      requiredWei,
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
  chainRegistry: ChainRegistryLike,
  _config: BundlerConfig,
  corsHeaders: Record<string, string>,
  requestRpcUrl?: string,
): Promise<Response> {
  if (!/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    return jsonResponse({ error: "Invalid safeAddress" }, 400, corsHeaders);
  }

  try {
    const chain = await chainRegistry.getChain(chainId, requestRpcUrl);

    // Skip blacklisted user RPC if chain has a different default (Alchemy / public).
    // For dev networks where chain.rpcUrl === requestRpcUrl, keep using it.
    let effectiveRpc = requestRpcUrl ?? chain.rpcUrl;
    if (requestRpcUrl && isRpcBlacklisted(requestRpcUrl) && hasFallback(requestRpcUrl, chain.rpcUrl)) {
      console.warn(`[REST] Skipping blacklisted user RPC ${requestRpcUrl}, using chain default ${chain.rpcUrl}`);
      effectiveRpc = chain.rpcUrl;
    }

    let info;
    try {
      info = await chain.accountService.getAccountInfo(safeAddress, effectiveRpc);
    } catch (err) {
      // User RPC failed — blacklist + retry with chain default if alternative exists
      if (requestRpcUrl && effectiveRpc === requestRpcUrl && hasFallback(requestRpcUrl, chain.rpcUrl)) {
        console.warn(`[REST] User RPC ${requestRpcUrl} failed, blacklisting and retrying with chain default (${chain.rpcUrl})`);
        blacklistRpc(requestRpcUrl);
        effectiveRpc = chain.rpcUrl;
        info = await chain.accountService.getAccountInfo(safeAddress, effectiveRpc);
      } else {
        throw err;
      }
    }

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
        rpcUsed: effectiveRpc.replace(/\/[a-zA-Z0-9_-]{20,}(\/|$)/, "/***$1"),
      },
      200,
      corsHeaders,
    );
  } catch (err) {
    console.error(`[REST] Error for chain ${chainId} / ${safeAddress}:`, err);
    return jsonResponse({ error: "Internal error" }, 500, corsHeaders);
  }
}

async function handleSponsor(
  chainId: number,
  safeAddress: `0x${string}`,
  chainRegistry: ChainRegistryLike,
  _config: BundlerConfig,
  corsHeaders: Record<string, string>,
  sponsorService: SponsorService,
  requestRpcUrl?: string,
  requiredWei?: bigint,
): Promise<Response> {
  if (!/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    return jsonResponse({ error: "Invalid safeAddress" }, 400, corsHeaders);
  }

  try {
    const chain = await chainRegistry.getChain(chainId, requestRpcUrl);

    let effectiveRpc = requestRpcUrl ?? chain.rpcUrl;
    if (requestRpcUrl && isRpcBlacklisted(requestRpcUrl) && hasFallback(requestRpcUrl, chain.rpcUrl)) {
      effectiveRpc = chain.rpcUrl;
    }

    // Derive the relayer EOA address for this Safe
    const eoa = await chain.accountService.deriveEOA(safeAddress);

    const result = await sponsorService.sponsor(
      chainId,
      safeAddress,
      eoa.address,
      effectiveRpc,
      requiredWei,
    );

    return jsonResponse(result, 200, corsHeaders);
  } catch (err) {
    console.error(`[REST] Sponsor error for chain ${chainId} / ${safeAddress}:`, err);
    return jsonResponse({ sponsored: false, reason: "internal_error" }, 500, corsHeaders);
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
