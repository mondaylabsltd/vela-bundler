/**
 * BundlerDO — Durable Object that encapsulates all per-chain bundler state.
 *
 * One instance per chain, accessed via env.BUNDLER.idFromName(`chain-${chainId}`).
 * Replaces ChainRegistry + setInterval with DO alarm-based scheduling.
 *
 * Key design decisions:
 * - chainId is persisted in DO storage so alarms can re-initialize after eviction
 * - processReceipt fire-and-forget is kept alive via state.waitUntil (not ctx.waitUntil)
 * - ensureInitialized guards against cached rejections and chain mismatch
 */

import type { Env } from "./types.ts";
import { buildConfig } from "./config.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import { resolveChain, type ChainInfo } from "../shared/config/chain-registry.ts";
import { createSimulator } from "../shared/simulation/index.ts";
import { Mempool } from "../shared/mempool/index.ts";
import { AccountService } from "../shared/account/index.ts";
import { BundlerService } from "../shared/bundler/index.ts";
import { SponsorService } from "../shared/account/sponsor.ts";
import { LocalKeyManager } from "../shared/keys/local.ts";
import { deriveTreasuryAddress } from "../shared/keys/derive.ts";
import type { ChainServices, ChainRegistryLike } from "../shared/chain/index.ts";
import { resolveRpcUrl, getPublicClient } from "../shared/utils/rpc-client.ts";
import { rateLimitGuard, type RateLimitConfig } from "../shared/auth/index.ts";
import { handleRestApi } from "../shared/rpc/rest-api.ts";
import {
  processRequest,
  jsonResponse,
  type RequestContext,
} from "../shared/rpc/process.ts";
import {
  parseError,
  invalidRequest,
  internalError,
} from "../shared/rpc/errors.ts";
import { validateRpcUrl } from "../shared/utils/rpc-client.ts";

/** Auto-bundle alarm interval — 10 seconds. */
const ALARM_INTERVAL_MS = 10_000;

/** Reputation decay interval — 1 hour (in ms). */
const REPUTATION_DECAY_INTERVAL_MS = 60 * 60 * 1000;

/** Maximum batch RPC request size to prevent abuse. */
const MAX_BATCH_SIZE = 20;

/** Maximum request body size in bytes (256 KB). */
const MAX_BODY_SIZE = 256 * 1024;

/** DO storage key for persisting chainId across evictions. */
const STORAGE_KEY_CHAIN_ID = "chainId";

/** DO storage key for persisting lastDecayAt across evictions. */
const STORAGE_KEY_LAST_DECAY = "lastDecayAt";

/** Redact API keys from RPC URLs for safe logging. */
function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/[a-zA-Z0-9_-]{20,}$/, "/***");
    return u.toString();
  } catch {
    return url.replace(/[a-zA-Z0-9_-]{20,}/g, "***");
  }
}

/**
 * Minimal ChainRegistry-compatible adapter for a single chain's services.
 * Satisfies ChainRegistryLike used by shared/rpc/handlers.ts and rest-api.ts.
 */
class SingleChainAdapter implements ChainRegistryLike {
  constructor(private services: ChainServices) {}

  async getChain(chainId: number, _requestRpcUrl?: string): Promise<ChainServices> {
    if (chainId !== this.services.chainId) {
      throw { code: -32602, message: `Chain ${chainId} not handled by this DO (handles ${this.services.chainId})` };
    }
    return this.services;
  }

  getAll(): ChainServices[] {
    return [this.services];
  }
}

export class BundlerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // Lazily initialized per-chain services
  private chainServices: ChainServices | null = null;
  private config: BundlerConfig | null = null;
  private chainAdapter: SingleChainAdapter | null = null;
  private sponsorService: SponsorService | null = null;
  private chainId: number = 0;
  private initPromise: Promise<void> | null = null;

  // Health loop state
  private lastDecayAt: number = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const chainId = parseInt(url.searchParams.get("chainId") ?? "0");

    // Ensure services are initialized for this chain
    if (chainId > 0) {
      try {
        await this.ensureInitialized(chainId);
      } catch (err) {
        console.error(`[BundlerDO] Init failed for chain ${chainId}:`, err);
        return Response.json(
          { jsonrpc: "2.0", id: null, error: internalError("Chain initialization failed") },
          { status: 503 },
        );
      }
    }

    try {
      if (url.pathname === "/rpc" && request.method === "POST") {
        return await this.handleRpc(request, chainId);
      }

      if (url.pathname === "/rest") {
        return await this.handleRest(request, url, chainId);
      }

      if (url.pathname === "/health") {
        return this.handleHealth();
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(`[BundlerDO:${this.chainId}] Error:`, err);
      return Response.json(
        { jsonrpc: "2.0", id: null, error: internalError("Internal error") },
        { status: 500 },
      );
    }
  }

  async alarm(): Promise<void> {
    // If chainServices is null (DO was evicted), try to re-initialize from stored chainId
    if (!this.chainServices) {
      const storedChainId = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
      if (storedChainId) {
        try {
          await this.ensureInitialized(storedChainId);
        } catch (err) {
          console.error(`[BundlerDO] Alarm re-init failed for chain ${storedChainId}:`, err);
        }
      }
      // Re-schedule even if init failed — retry next cycle
      if (!this.chainServices) {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
        return;
      }
    }

    // Auto-bundle
    try {
      if (this.chainServices.mempool.size > 0) {
        await this.chainServices.bundler.tryBundle();
      }
    } catch (err) {
      console.error(`[BundlerDO:${this.chainId}] Auto-bundle error:`, err);
    }

    // Health loop: recover locked EOAs + reputation decay
    await this.healthLoop();

    // Receipt cleanup
    this.chainServices.bundler.cleanExpiredReceipts();

    // Re-schedule alarm
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  private async ensureInitialized(chainId: number): Promise<void> {
    // Already initialized for this chain
    if (this.chainServices && this.chainId === chainId) return;

    // Already initialized for a DIFFERENT chain — reject (should never happen with correct routing)
    if (this.chainServices && this.chainId !== chainId) {
      throw new Error(`DO already initialized for chain ${this.chainId}, cannot serve chain ${chainId}`);
    }

    // Another request is already initializing — wait for it
    if (this.initPromise) {
      await this.initPromise;
      // Verify the completed init was for the right chain
      if (this.chainId !== chainId) {
        throw new Error(`Chain mismatch after init: expected ${chainId}, got ${this.chainId}`);
      }
      return;
    }

    // Start initialization — clear on failure so next request retries
    this.chainId = chainId;
    this.initPromise = this._init(chainId).catch((err) => {
      this.initPromise = null;
      this.chainId = 0;
      throw err;
    });
    await this.initPromise;
  }

  private async _init(chainId: number): Promise<void> {
    // Derive treasury from OPERATOR_SECRET
    const treasuryAddress = await deriveTreasuryAddress(this.env.OPERATOR_SECRET);
    this.config = buildConfig(this.env, treasuryAddress);

    const keyManager = new LocalKeyManager({
      operatorSecret: this.config.operatorSecret,
      oldOperatorSecrets: this.config.oldOperatorSecrets,
    });

    this.sponsorService = new SponsorService(this.config);

    // Resolve chain RPC + metadata (mirrors ChainRegistry.initChain)
    const resolved = await resolveChain(chainId, this.config.alchemyApiKey);
    const effectiveRpc = resolveRpcUrl({ rpcUrl: resolved.rpcUrl });

    const chainConfig: BundlerConfig = {
      ...this.config,
      chainId,
      rpcUrl: effectiveRpc,
      publicRpcs: resolved.publicRpcs,
      chainInfo: resolved.chain,
    };

    const simulator = createSimulator(chainConfig);
    const mempool = new Mempool({
      entryPointAddress: chainConfig.entryPointAddress,
      chainId,
      maxMempoolSize: 4096,
      stakedSenderMaxOps: 4,
    });

    const accountService = new AccountService({
      keyManager,
      config: chainConfig,
      balanceReserveMultiplier: chainConfig.balanceReserveMultiplier,
    });

    // disableTimers: true — DO alarm handles auto-bundling and cleanup
    const bundler = new BundlerService(chainConfig, mempool, simulator, accountService, {
      disableTimers: true,
    });

    this.chainServices = {
      chainId,
      chainInfo: resolved.chain,
      rpcUrl: effectiveRpc,
      publicRpcs: resolved.publicRpcs,
      simulator,
      mempool,
      accountService,
      bundler,
    };
    this.chainAdapter = new SingleChainAdapter(this.chainServices);

    // Persist chainId so alarm can re-init after eviction
    await this.state.storage.put(STORAGE_KEY_CHAIN_ID, chainId);

    // Restore lastDecayAt from storage (survives eviction)
    const storedDecay = await this.state.storage.get<number>(STORAGE_KEY_LAST_DECAY);
    this.lastDecayAt = storedDecay ?? Date.now();

    console.log(
      `[BundlerDO] Initialized chain ${chainId} (${resolved.chain?.name ?? "unknown"}) — RPC: ${redactRpcUrl(effectiveRpc)}`,
    );

    // Schedule first alarm if none exists
    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Request handling
  // ---------------------------------------------------------------------------

  private async handleRpc(request: Request, chainId: number): Promise<Response> {
    if (!this.chainAdapter || !this.config) {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: internalError("DO not initialized") },
        { status: 500 },
      );
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Rpc-Url",
    };

    // Rate limit using CF-Connecting-IP (cannot be spoofed by clients)
    const rateLimitConfig: RateLimitConfig = {
      rateLimitPerMinute: this.config.apiRateLimitPerMinute,
    };
    const limited = rateLimitGuard(request, rateLimitConfig);
    if (limited) return limited;

    // Read body as text first to enforce size limit (Content-Length can be spoofed/omitted)
    const bodyText = await request.text();
    if (bodyText.length > MAX_BODY_SIZE) {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: invalidRequest("Request body too large") },
        { status: 413, headers: corsHeaders },
      );
    }

    const rawRpcUrl = request.headers.get("x-rpc-url") ?? undefined;
    let requestRpcUrl: string | undefined;
    if (rawRpcUrl) {
      const validationError = validateRpcUrl(rawRpcUrl);
      if (validationError) {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: invalidRequest(`Invalid X-Rpc-Url: ${validationError}`) },
          { status: 400 },
        );
      }
      requestRpcUrl = rawRpcUrl;
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ jsonrpc: "2.0", id: null, error: parseError() }, corsHeaders);
    }

    const reqCtx: RequestContext = { requestRpcUrl, chainId };

    if (Array.isArray(body)) {
      if (body.length > MAX_BATCH_SIZE) {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: invalidRequest(`Batch too large (max ${MAX_BATCH_SIZE})`) },
          { status: 400, headers: corsHeaders },
        );
      }
      const results = await Promise.allSettled(
        body.map((item) => processRequest(item, this.config!, this.chainAdapter!, reqCtx)),
      );
      const responses = results.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : { jsonrpc: "2.0" as const, id: (body[i]?.id as number | string) ?? null, error: internalError("Internal error") },
      );
      return jsonResponse(responses, corsHeaders);
    }

    const response = await processRequest(body, this.config, this.chainAdapter, reqCtx);
    return jsonResponse(response, corsHeaders);
  }

  private async handleRest(request: Request, doUrl: URL, chainId: number): Promise<Response> {
    if (!this.chainAdapter || !this.config) {
      return Response.json({ error: "DO not initialized" }, { status: 500 });
    }

    // Reconstruct the original URL for the REST handler
    const originalPath = doUrl.searchParams.get("originalPath") ?? doUrl.pathname;
    const fakeUrl = new URL(request.url);
    fakeUrl.pathname = originalPath;

    const rawRpcUrl = request.headers.get("x-rpc-url") ?? undefined;
    let requestRpcUrl: string | undefined;
    if (rawRpcUrl) {
      const validationError = validateRpcUrl(rawRpcUrl);
      if (!validationError) requestRpcUrl = rawRpcUrl;
    }

    const rateLimitConfig: RateLimitConfig = {
      rateLimitPerMinute: this.config.apiRateLimitPerMinute,
    };

    const response = await handleRestApi(
      request,
      fakeUrl,
      this.chainAdapter,
      this.config,
      rateLimitConfig,
      requestRpcUrl,
      this.sponsorService ?? undefined,
    );

    return response ?? new Response("not found", { status: 404 });
  }

  private handleHealth(): Response {
    if (!this.chainServices) {
      return Response.json({ status: "uninitialized", chainId: this.chainId });
    }

    return Response.json({
      service: "vela-bundler",
      runtime: "cloudflare-workers",
      chainId: this.chainId,
      chainName: this.chainServices.chainInfo?.name ?? "unknown",
      status: this.chainServices.accountService.lockManager.getLockedEOAs().length > 0
        ? "degraded"
        : "ok",
      mempoolSize: this.chainServices.mempool.size,
      lockedEOAs: this.chainServices.accountService.lockManager.getLockedEOAs().length,
    }, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Health loop
  // ---------------------------------------------------------------------------

  private async healthLoop(): Promise<void> {
    if (!this.chainServices) return;

    const now = Date.now();
    const shouldDecay = now - this.lastDecayAt >= REPUTATION_DECAY_INTERVAL_MS;

    // Recover locked EOAs
    try {
      const locked = this.chainServices.accountService.lockManager.getLockedEOAs();
      if (locked.length > 0) {
        const client = getPublicClient(this.chainServices.rpcUrl);
        let recovered = 0;
        for (const eoa of locked) {
          try {
            const ok = await this.chainServices.accountService.lockManager.tryRecoverEOA(eoa.address, client);
            if (ok) {
              recovered++;
              console.log(`[BundlerDO:${this.chainId}] Recovered EOA ${eoa.address}`);
            }
          } catch {
            // RPC error — skip, try again next cycle
          }
        }
        if (recovered < locked.length) {
          console.log(
            `[BundlerDO:${this.chainId}] ${recovered}/${locked.length} locked EOAs recovered`,
          );
        }
      }
    } catch (err) {
      console.error(`[BundlerDO:${this.chainId}] Health recovery error:`, err);
    }

    // Hourly reputation decay
    if (shouldDecay) {
      try {
        this.chainServices.mempool.reputation.decay();
      } catch (err) {
        console.error(`[BundlerDO:${this.chainId}] Reputation decay error:`, err);
      }
      this.lastDecayAt = now;
      // Persist so decay timing survives eviction
      await this.state.storage.put(STORAGE_KEY_LAST_DECAY, now);
    }
  }
}
