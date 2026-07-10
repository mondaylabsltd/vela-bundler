/**
 * REST API endpoints for the private prepaid bundler.
 *
 * GET /v1/account/:chainId/:safeAddress
 *   — Multi-chain: chainId in the URL path.
 *   — Supports X-Rpc-Url header for per-request RPC override.
 */

import type { ChainRegistryLike } from "../chain/index.ts";
import type { BundlerConfig } from "../config/types.ts";
import { SPLITTER_CREATION_CODE_HASH, SPLITTER_FACTORY, SPLITTER_SALT } from "../contracts/splitter.ts";
import { rateLimitGuard, type RateLimitConfig } from "../auth/index.ts";
import { blacklistRpc, isRpcBlacklisted, hasFallback } from "../utils/rpc-blacklist.ts";
import { redactUrl } from "../reliability/log.ts";
import { CORS_HEADERS } from "./cors.ts";
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
  peerAddr?: string,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/")) return null;

  const corsHeaders = CORS_HEADERS;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const limited = rateLimitGuard(req, rateLimitConfig, peerAddr);
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

  // GET /v1/splitter — VelaGasSettlementSplitter address + derivation inputs (same on all chains).
  // Lets the wallet compute the identical address locally and cross-check its embedded constants.
  if (url.pathname === "/v1/splitter" && req.method === "GET") {
    return jsonResponse({
      address: config.splitterAddress,
      treasury: config.treasuryAddress,
      factory: SPLITTER_FACTORY,
      salt: SPLITTER_SALT,
      creationCodeHash: SPLITTER_CREATION_CODE_HASH,
    }, 200, corsHeaders);
  }

  // POST /v1/sponsor/:chainId/:safeAddress
  const sponsorMatch = url.pathname.match(
    /^\/v1\/sponsor\/(\d+)\/(0x[0-9a-fA-F]{40})$/,
  );
  if (sponsorMatch && req.method === "POST" && sponsorService) {
    // Parse optional requiredWei + dryRun from request body. dryRun runs the
    // eligibility gates without moving money — the wallet probes at Continue
    // and defers the real grant to the confirm slide.
    let requiredWei: bigint | undefined;
    let dryRun = false;
    try {
      const body = await req.json() as { requiredWei?: string; dryRun?: boolean };
      if (body.requiredWei) requiredWei = BigInt(body.requiredWei);
      dryRun = body.dryRun === true;
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
      dryRun,
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
      console.warn(`[REST] Skipping blacklisted user RPC ${redactUrl(requestRpcUrl)}, using chain default ${redactUrl(chain.rpcUrl)}`);
      effectiveRpc = chain.rpcUrl;
    }

    let info;
    try {
      info = await chain.accountService.getAccountInfo(safeAddress, effectiveRpc);
    } catch (err) {
      // User RPC failed — blacklist + retry with chain default if alternative exists
      if (requestRpcUrl && effectiveRpc === requestRpcUrl && hasFallback(requestRpcUrl, chain.rpcUrl)) {
        console.warn(`[REST] User RPC ${redactUrl(requestRpcUrl)} failed, blacklisting and retrying with chain default (${redactUrl(chain.rpcUrl)})`);
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
        rpcUsed: redactUrl(effectiveRpc),
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
  dryRun = false,
): Promise<Response> {
  if (!/^0x[0-9a-f]{40}$/.test(safeAddress)) {
    return jsonResponse({ error: "Invalid safeAddress" }, 400, corsHeaders);
  }

  try {
    const chain = await chainRegistry.getChain(chainId, requestRpcUrl);

    // SECURITY: sponsorship reads the treasury/relayer balances AND signs+broadcasts a
    // TREASURY transfer (a shared operator asset). It must NEVER use the attacker-supplied
    // X-Rpc-Url for those — a malicious RPC could feed fake balances/gas-price into the
    // fund-moving math or capture the signed treasury tx. Always use the trusted,
    // registry-resolved chain default RPC here. (`requestRpcUrl` is ignored for sponsor.)
    const trustedRpc = chain.rpcUrl;

    // Derive the relayer EOA address for this Safe
    const eoa = await chain.accountService.deriveEOA(safeAddress);

    const result = await sponsorService.sponsor(
      chainId,
      safeAddress,
      eoa.address,
      trustedRpc,
      requiredWei,
      dryRun,
    );

    // An index/dependency OUTAGE is infrastructure, not a business rejection: answer 503 so
    // generic clients (and the wallet) retry instead of treating the user as unregistered.
    const status = result.reason === "passkey_index_unavailable" ? 503 : 200;
    return jsonResponse(result, status, corsHeaders);
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
