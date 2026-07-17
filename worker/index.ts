/**
 * Cloudflare Worker entry point — routes requests to per-chain BundlerDO instances.
 */

import type { Env, UserOpQueueMessage } from "./types.ts";
import { deriveTreasuryAddress } from "../shared/keys/derive.ts";
import { relayerIndexForSender } from "../shared/queue/routing.ts";
import {
  computeSplitterAddress,
  SPLITTER_CREATION_CODE_HASH,
  SPLITTER_FACTORY,
  SPLITTER_SALT,
} from "../shared/contracts/splitter.ts";
import { CORS_HEADERS } from "../shared/rpc/cors.ts";
import { redactError } from "../shared/reliability/log.ts";

// Re-export the Durable Objects for wrangler to discover.
export { BundlerDO } from "./bundler-do.ts";
export { RelayerDO } from "./relayer-do.ts";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Nothing in here may escape as an unhandled exception: a throw (bad OPERATOR_SECRET in
    // deriveTreasuryAddress, a stub.fetch rejection mid-deploy) would surface as an opaque
    // CF 1101 error page instead of a JSON-RPC error the wallet can handle.
    try {
      return await this.route(request, env);
    } catch (err) {
      console.error("[Worker] fetch error:", redactError(err));
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } },
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
      );
    }
  },

  async route(request: Request, env: Env): Promise<Response> {
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

    // Per-chain health: GET /health/:chainId → the chain's DO (real degraded status: locked
    // EOAs, pending receipts, circuit breaker). Read-only — does not force a chain init.
    const perChainHealth = url.pathname.match(/^\/health\/(\d+)$/);
    if (perChainHealth && request.method === "GET") {
      return routeToDO(env, request, parseInt(perChainHealth[1]!), "/health");
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

      // /v1/treasury/:chainId — per-chain treasury balance + bootstrapNeeded (Stage 2). MUST reach
      // the chain DO (rest-api.ts reads the on-chain balance there), so route it like account/sponsor.
      const treasuryChainMatch = url.pathname.match(/^\/v1\/treasury\/(\d+)$/);
      if (treasuryChainMatch && request.method === "GET") {
        return routeToDO(env, request, parseInt(treasuryChainMatch[1]!), "/rest", url.pathname);
      }

      // /v1/treasury — no chain needed, derive from OPERATOR_SECRET directly
      if (url.pathname === "/v1/treasury" && request.method === "GET") {
        const addr = await deriveTreasuryAddress(env.OPERATOR_SECRET);
        return Response.json({ address: addr }, { headers: CORS_HEADERS });
      }

      // /v1/splitter — the VelaGasSettlementSplitter address + its derivation inputs, so the
      // wallet can compute the identical address locally and cross-check its embedded copy.
      if (url.pathname === "/v1/splitter" && request.method === "GET") {
        const treasury = await deriveTreasuryAddress(env.OPERATOR_SECRET);
        return Response.json({
          address: computeSplitterAddress(treasury),
          treasury,
          factory: SPLITTER_FACTORY,
          salt: SPLITTER_SALT,
          creationCodeHash: SPLITTER_CREATION_CODE_HASH,
        }, { headers: CORS_HEADERS });
      }
    }

    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST /:chainId for JSON-RPC (e.g. POST /1)" } },
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Liveness cron (external layer of the dead-man switch). DO alarms are self-sustaining
    // in NORMAL operation — but a storage error during setAlarm or an exhausted CF alarm
    // retry budget can break the chain permanently, and a dead alarm cannot report itself.
    // Every 5 minutes, enumerate the chain-registry DO (every chain DO self-registers on
    // activation — NO manual chain list) and probe each chain's DO with a storage-only
    // check that re-arms + alerts if the alarm chain was broken. Deliberately-idle chains
    // (drained testnets) read as healthy and are left asleep.
    ctx.waitUntil(
      (async () => {
        let chainIds: number[] = [];
        try {
          const registry = env.BUNDLER.get(env.BUNDLER.idFromName("chain-registry"));
          const res = await registry.fetch("https://bundler-do/registry-list");
          const body = await res.json().catch(() => null) as { chains?: number[] } | null;
          chainIds = (body?.chains ?? []).filter((n) => Number.isFinite(n) && n > 0);
        } catch (err) {
          console.error(`[Worker] cron could not enumerate the chain registry: ${redactError(err)}`);
          return;
        }
        await Promise.allSettled(chainIds.map(async (chainId) => {
          try {
            const doId = env.BUNDLER.idFromName(`chain-${chainId}`);
            const stub = env.BUNDLER.get(doId);
            const res = await stub.fetch(new Request("https://bundler-do/ensure-alarm"));
            const body = await res.json().catch(() => null) as { rearmed?: boolean } | null;
            if (body?.rearmed) {
              console.error(`[Worker] cron re-armed a broken alarm chain for chain ${chainId}`);
            }
          } catch (err) {
            console.error(`[Worker] cron liveness probe failed for chain ${chainId}: ${redactError(err)}`);
          }
        }));
      })(),
    );
  },

  /**
   * Queue consumer (Stage 4 of docs/pool-queue-architecture.md) — ACTIVE consumption of the
   * `vela-userops` transport (not cron). Group the batch by (chainId, hash(sender)%pool), then
   * for each group POST /submit to the per-EOA RelayerDO `chain-${chainId}-eoa-${index}`. A 2xx
   * ACKs every message in the group; anything else RETRIES them (CF applies max_retries then
   * routes to the DLQ). This handler NEVER throws: a throw would retry the WHOLE batch and can
   * livelock a poison message — every failure path resolves to per-message ack/retry instead.
   */
  async queue(batch: MessageBatch<UserOpQueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      // Group by (chainId, pool index). The routing hash MUST be the identical function the
      // producer used to write the KV marker index — both import relayerIndexForSender.
      const groups = new Map<string, { chainId: number; index: number; msgs: Message<UserOpQueueMessage>[] }>();
      for (const msg of batch.messages) {
        try {
          const body = msg.body;
          const sender = String((body?.rpcUserOp as { sender?: unknown } | undefined)?.sender ?? "");
          const chainId = Number(body?.chainId);
          if (!(chainId > 0) || !sender) {
            // Malformed message → retry (DLQ after max_retries) rather than crash the batch.
            msg.retry();
            continue;
          }
          const index = relayerIndexForSender(sender);
          const key = `${chainId}-${index}`;
          let g = groups.get(key);
          if (!g) { g = { chainId, index, msgs: [] }; groups.set(key, g); }
          g.msgs.push(msg);
        } catch (err) {
          console.error(`[Worker] queue: could not route a message: ${redactError(err)}`);
          try { msg.retry(); } catch { /* already settled */ }
        }
      }

      if (!env.RELAYER) {
        // The RELAYER binding is deploy-safe and always present, but guard anyway: without it
        // we cannot route — retry so nothing is lost.
        console.error("[Worker] queue: RELAYER binding missing — retrying batch");
        for (const g of groups.values()) for (const m of g.msgs) m.retry();
        return;
      }

      await Promise.allSettled([...groups.values()].map(async (g) => {
        try {
          const stub = env.RELAYER.get(env.RELAYER.idFromName(`chain-${g.chainId}-eoa-${g.index}`));
          const res = await stub.fetch(
            `https://relayer-do/submit?chainId=${g.chainId}&index=${g.index}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ops: g.msgs.map((m) => m.body) }),
            },
          );
          if (res.ok) for (const m of g.msgs) m.ack();
          else {
            console.warn(`[Worker] queue: RelayerDO chain-${g.chainId}-eoa-${g.index} returned ${res.status} — retrying group`);
            for (const m of g.msgs) m.retry();
          }
        } catch (err) {
          console.error(`[Worker] queue: submit to chain-${g.chainId}-eoa-${g.index} failed: ${redactError(err)}`);
          for (const m of g.msgs) m.retry();
        }
      }));
    } catch (err) {
      // Last-resort guard: never let queue() throw (that retries the whole batch). Retry each
      // message individually instead.
      console.error(`[Worker] queue handler error: ${redactError(err)}`);
      for (const msg of batch.messages) {
        try { msg.retry(); } catch { /* already settled */ }
      }
    }
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
