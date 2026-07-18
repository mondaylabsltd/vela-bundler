/**
 * BundlerDO — Durable Object that encapsulates all per-chain bundler state.
 *
 * One instance per chain, accessed via env.BUNDLER.idFromName(`chain-${chainId}`).
 * Replaces ChainRegistry + setInterval with DO alarm-based scheduling.
 *
 * Key design decisions:
 * - chainId is persisted in DO storage so alarms can re-initialize after eviction
 * - in-flight receipt reconciliation is durable: pending receipts persist to DO storage and are
 *   polled by the alarm (checkPendingReceipts) — no fire-and-forget
 * - ensureInitialized guards against cached rejections and chain mismatch
 */

import type { Env } from "./types.ts";
import { buildConfig } from "./config.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import { vaultActiveForChain } from "../shared/tempo.ts";
import { chainSpecEnables } from "../shared/config/vault.ts";
import { resolveChain } from "../shared/config/chain-registry.ts";
import { createSimulator } from "../shared/simulation/index.ts";
import {
  Mempool,
  serializeMempoolEntry,
  deserializeMempoolEntry,
  type SerializedMempoolEntry,
} from "../shared/mempool/index.ts";
import { deserializeReceipt, type SerializedReceipt } from "../shared/bundler/index.ts";
import { makeEnqueueHook } from "./producer.ts";
import { receiptToRpc, receiptToByHashRpc } from "../shared/rpc/receipt-format.ts";
import { redactError } from "../shared/reliability/log.ts";
import { RepeatedErrorEscalator } from "../shared/monitoring/escalation.ts";
import { maybeSendAliveHeartbeat } from "../shared/monitoring/operational.ts";
import { AccountService } from "../shared/account/index.ts";
import { BundlerService } from "../shared/bundler/index.ts";
import { SponsorService } from "../shared/account/sponsor.ts";
import { LocalKeyManager } from "../shared/keys/local.ts";
import { deriveTreasuryAddress, RELAYER_POOL_SIZE } from "../shared/keys/derive.ts";
import type { ChainServices, ChainRegistryLike } from "../shared/chain/index.ts";
import { resolveRpcUrl, getPublicClient } from "../shared/utils/rpc-client.ts";
import { reliabilityHealth } from "../shared/reliability/rpc-fetch.ts";
import { metrics, logEvent } from "../shared/reliability/log.ts";
import { rateLimitGuard, type RateLimitConfig } from "../shared/auth/index.ts";
import { handleRestApi } from "../shared/rpc/rest-api.ts";
import { CORS_HEADERS } from "../shared/rpc/cors.ts";
import {
  processRequest,
  jsonResponse,
  type RequestContext,
  type JsonRpcResponse,
} from "../shared/rpc/process.ts";
import {
  parseError,
  invalidRequest,
  invalidParams,
  internalError,
} from "../shared/rpc/errors.ts";
import { validateRpcUrl } from "../shared/utils/rpc-client.ts";
import { createAlerter, type Alerter } from "../shared/monitoring/telegram.ts";
import { checkTreasuryBalance } from "../shared/monitoring/treasury.ts";
import { checkOperationalHealth, DEFAULT_OPERATIONAL_THRESHOLDS } from "../shared/monitoring/operational.ts";

/** Fallback auto-bundle alarm interval (10s) — used only before config is loaded; once
 *  initialized the DO honours AUTO_BUNDLE_INTERVAL_MS (floored at 2s). */
const DEFAULT_ALARM_INTERVAL_MS = 10_000;

/** Consecutive chain-init failures before alerting (each retry is one alarm interval). */
const INIT_FAILURE_ALERT_STREAK = 3;

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

/** DO storage key for persisting in-flight pending receipts across evictions. */
const STORAGE_KEY_PENDING_RECEIPTS = "pendingReceipts";

/** DO storage key for the last alive-heartbeat timestamp (persisted so evictions neither
 *  spam nor gap the heartbeat cadence). */
const STORAGE_KEY_LAST_HEARTBEAT = "lastHeartbeatAt";

/** Per-hash DO storage key prefixes: accepted-unbundled mempool ops and terminal receipts.
 *  Per-hash (not one list key) so 4096 entries can't blow the 128KB per-value limit and
 *  each write stays O(1). */
const MEMPOOL_KEY_PREFIX = "mp:";
const RECEIPT_KEY_PREFIX = "rc:";
/** Dead-man watch registry (B6): a RelayerDO registers `rwatch:<index>` while it holds stranded
 *  money-path state; the cron liveness probe fans out to each registered index's /ensure-alarm. */
const RELAYER_WATCH_PREFIX = "rwatch:";

/** DO storage flag: the alarm was stopped DELIBERATELY (chain fully idle / abandoned) —
 *  distinguishes "healthy idle" from "alarm chain broken" for the cron liveness probe. */
const STORAGE_KEY_ALARM_IDLE = "alarmIdle";

/** Consecutive fully-idle alarm cycles (no mempool ops, no pending receipts, no locked
 *  EOAs) before the alarm stops re-arming. ~5 min at the 10s interval. The ingress kick
 *  re-arms instantly on the next accepted op, so an idle stop can never strand an op —
 *  and abandoned user-RPC testnet chains stop burning re-init cycles (and init-failure
 *  alerts) forever. */
const IDLE_STOP_CYCLES = 30;

/** Consecutive failed alarm re-inits (evicted DO whose chain no longer resolves — e.g. a
 *  dead user-supplied testnet) before the alarm gives up, PROVIDED nothing is in flight.
 *  With in-flight state the alarm never gives up (money is at stake; keep paging). */
const REINIT_GIVEUP_STREAK = 30;

/** Registry-instance storage key prefix: one key per chain ever activated. The well-known
 *  "chain-registry" DO instance serves ONLY /registry-* paths and never initializes chain
 *  services — it lets the liveness cron enumerate real chains with zero manual config. */
const REGISTRY_KEY_PREFIX = "chain:";

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
      // Via the factory so it carries the deliberate-error marker (process.ts forwards ONLY
      // marked errors to clients; unmarked ones are treated as internal and redacted).
      throw invalidParams(`Chain ${chainId} not handled by this DO (handles ${this.services.chainId})`);
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
  /** Telegram alerter — created in the CONSTRUCTOR (from env, no other dependencies) so a
   *  persistently failing chain init can still page the operator; created inside _init it
   *  would sit after the very calls (secret derivation, resolveChain) that throw. Persistent
   *  instance so the per-alert cooldown survives across alarm cycles. */
  private readonly alerter: Alerter;
  /** Repeated-exception escalation (same phase failing N consecutive cycles → Telegram). */
  private readonly escalator: RepeatedErrorEscalator;
  /** Consecutive chain-init failures (alarm re-init + fetch path share it). */
  private initFailureStreak = 0;

  // Health loop state
  private lastDecayAt: number = 0;
  /** Cached heartbeat stamp — read from storage ONCE per isolate, not once per 10s alarm
   *  (8,640 pointless storage reads/day for a value that changes 4×/day). */
  private lastHeartbeatAt: number | null = null;
  /** When the monitor half of the alarm last ran — ingress-kicked alarms skip it so a kick
   *  costs only reconcile+bundle, not a treasury/balance RPC sweep per accepted op. */
  private lastHealthLoopAt = 0;
  /** Consecutive fully-idle alarm cycles — see IDLE_STOP_CYCLES. Reset by any activity;
   *  an eviction resets it too (counting simply restarts — the safe direction). */
  private idleCycles = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.alerter = createAlerter({
      telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
      telegramChatId: env.TELEGRAM_CHAT_ID || null,
    }, { quiet: true });
    this.escalator = new RepeatedErrorEscalator(this.alerter);
  }

  /** Effective alarm interval: honours AUTO_BUNDLE_INTERVAL_MS once config is loaded
   *  (floored at 2s so a typo can't hot-loop the alarm), falls back to 10s before init. */
  private alarmIntervalMs(): number {
    const configured = this.config?.autoBundleIntervalMs;
    return configured && Number.isFinite(configured) ? Math.max(2_000, configured) : DEFAULT_ALARM_INTERVAL_MS;
  }

  /** Rate-limit allowlist as a Set, built once per isolate (requests are hot-path). */
  private _rateLimitAllowlist: Set<string> | null = null;
  private rateLimitAllowlist(): Set<string> {
    if (!this._rateLimitAllowlist) {
      this._rateLimitAllowlist = new Set(this.config?.rateLimitAllowlist ?? []);
    }
    return this._rateLimitAllowlist;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const chainId = parseInt(url.searchParams.get("chainId") ?? "0");

    // --- Chain-registry endpoints (the well-known "chain-registry" instance) ---
    // Pure storage, no chain init: chain DOs self-register on first activation and the
    // liveness cron enumerates the set — no operator-maintained chain list.
    if (url.pathname === "/registry-add" && request.method === "POST") {
      const id = parseInt(url.searchParams.get("chain") ?? "0");
      if (id > 0) await this.state.storage.put(REGISTRY_KEY_PREFIX + id, Date.now());
      return Response.json({ ok: true });
    }
    if (url.pathname === "/registry-list") {
      const listed = await this.state.storage.list({ prefix: REGISTRY_KEY_PREFIX });
      const chains = [...listed.keys()].map((k) => parseInt(k.slice(REGISTRY_KEY_PREFIX.length))).filter((n) => n > 0);
      return Response.json({ chains });
    }

    // --- Cron liveness probe: STORAGE-ONLY, never initializes the chain ---
    // Force-initializing here would resurrect every abandoned user-RPC testnet each probe
    // (resolveChain fetches + init-failure alerts, forever). setAlarm needs no init: the
    // armed alarm re-initializes the chain itself on its next firing.
    if (url.pathname === "/ensure-alarm") {
      return await this.handleEnsureAlarm();
    }

    // Dead-man watch registry (B6): a RelayerDO PUTs/DELETEs its index here while it holds
    // stranded money-path state. Storage-only, no init needed.
    if (url.pathname === "/relayer-watch") {
      return await this.handleRelayerWatch(url, request.method);
    }

    if (chainId > 0) {
      if (url.pathname === "/health") {
        // Health is READ-ONLY. Do NOT force-init a brand-new/bogus chainId just because someone
        // curled its health. But DO recover a chain this DO has served before (persisted
        // chainId) that was merely evicted from memory, so its health is accurate rather than a
        // misleading "uninitialized". Failure is non-fatal — we still report current state.
        if (!this.chainServices) {
          const known = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
          if (known === chainId) {
            try {
              await this.ensureInitialized(chainId);
            } catch {
              // leave uninitialized — handleHealth reports it with the requested chainId
            }
          }
        }
      } else {
        try {
          await this.ensureInitialized(chainId);
        } catch (err) {
          // Covers the never-successfully-initialized case too (no alarm armed yet — the
          // alarm is only scheduled at the end of a successful _init), so the operator
          // still gets paged when every user request is bouncing with 503.
          await this.noteInitFailure(chainId, err);
          return Response.json(
            { jsonrpc: "2.0", id: null, error: internalError("Chain initialization failed") },
            { status: 503 },
          );
        }
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
        return this.handleHealth(chainId);
      }

      if (url.pathname === "/inspect" && request.method === "GET") {
        return await this.handleInspect(url, chainId);
      }

      // Treasury-serialized EOA top-up. A per-EOA RelayerDO whose pool EOA can't afford its
      // outer gas calls this so ALL treasury sends go through the ONE chain DO's SponsorService
      // (runTreasuryExclusive) — 100 RelayerDOs sending treasury txs directly would race its
      // nonce. Internal (DO→DO) only. Fire-and-forget from the caller's view; returns the result.
      if (url.pathname === "/fund-eoa" && request.method === "POST") {
        return await this.handleFundEoa(url);
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
    // Re-arm FIRST — the reschedule must never depend on the body completing. Cloudflare's
    // automatic alarm retry budget is BOUNDED: an error thrown past the old end-of-body
    // setAlarm could exhaust it and end auto-bundling for this chain FOREVER, silently,
    // while the DO kept serving reads. (The ingress kick's setAlarm(now) may overwrite this
    // with an earlier time — fine, every alarm run re-arms again.)
    await this.state.storage.setAlarm(Date.now() + this.alarmIntervalMs());

    try {
      // If chainServices is null (DO was evicted), try to re-initialize from stored chainId
      if (!this.chainServices) {
        const storedChainId = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
        if (storedChainId) {
          try {
            await this.ensureInitialized(storedChainId);
          } catch (err) {
            await this.noteInitFailure(storedChainId, err);
            // A chain that no longer resolves (dead user-RPC testnet) with NOTHING in
            // flight must not burn re-init cycles + init-failure pages forever: stop the
            // alarm deliberately. A future user request re-initializes and re-arms; with
            // in-flight state we NEVER give up (money at stake — keep trying + paging).
            if (this.initFailureStreak >= REINIT_GIVEUP_STREAK && !(await this.hasPersistedInFlightState())) {
              await this.state.storage.put(STORAGE_KEY_ALARM_IDLE, true);
              await this.state.storage.deleteAlarm();
              console.warn(`[BundlerDO] chain ${storedChainId} unresolvable for ${this.initFailureStreak} cycles with nothing in flight — alarm stopped (idle)`);
              return;
            }
          }
        }
        // Alarm already re-armed — retry next cycle
        if (!this.chainServices) return;
      }

      // Check pending receipts from previous bundles (alarm-driven polling)
      try {
        await this.chainServices.bundler.checkPendingReceipts();
        this.escalator.ok("reconcile", this.chainId);
      } catch (err) {
        console.error(`[BundlerDO:${this.chainId}] Pending receipt check error:`, err);
        await this.escalator.note("reconcile", this.chainId, err);
      }

      // Auto-bundle (kickBundle collapses with any concurrent ingress kick)
      try {
        await this.chainServices.bundler.kickBundle();
        this.escalator.ok("auto-bundle", this.chainId);
      } catch (err) {
        console.error(`[BundlerDO:${this.chainId}] Auto-bundle error:`, err);
        await this.escalator.note("auto-bundle", this.chainId, err);
      }

      // Health loop: recover locked EOAs + monitors + reputation decay. Skipped when an
      // ingress kick fired this alarm within seconds of the last pass — the kick exists to
      // shave op latency, not to multiply treasury/balance RPC reads per accepted op.
      if (Date.now() - this.lastHealthLoopAt >= 5_000) {
        this.lastHealthLoopAt = Date.now();
        await this.healthLoop();
      }

      // Receipt cleanup
      this.chainServices.bundler.cleanExpiredReceipts();

      // Observability: publish per-cycle gauges + one structured heartbeat so a slow
      // backlog / stuck reconciliation is visible before in-memory state is evicted.
      const cs = this.chainServices;
      const lockedEOAs = cs.accountService.lockManager.getLockedEOAs().length;
      const mempoolSize = cs.mempool.size;
      const oldestMempoolMs = cs.mempool.oldestEntryAgeMs();
      const pendingReceipts = cs.bundler.pendingReceiptCount;
      const oldestPendingMs = cs.bundler.oldestPendingReceiptAgeMs();
      const labels = { chain: this.chainId };
      metrics.gauge("mempool_size", mempoolSize, labels);
      metrics.gauge("mempool_oldest_age_ms", oldestMempoolMs, labels);
      metrics.gauge("locked_eoas", lockedEOAs, labels);
      metrics.gauge("pending_receipts", pendingReceipts, labels);
      metrics.gauge("pending_receipt_oldest_age_ms", oldestPendingMs, labels);
      logEvent({
        level: lockedEOAs > 0 || oldestMempoolMs > 60_000 ? "warn" : "debug",
        dependency: "internal", operation: "alarm_heartbeat", chain_id: this.chainId, outcome: "ok",
        mempool_size: mempoolSize, mempool_oldest_age_ms: oldestMempoolMs, locked_eoas: lockedEOAs,
        pending_receipts: pendingReceipts, pending_receipt_oldest_age_ms: oldestPendingMs,
        circuit_degraded: reliabilityHealth().circuit.degraded,
      });

      // Idle stop: a chain with NOTHING to do for IDLE_STOP_CYCLES stops its own alarm
      // (flagged deliberate so the cron probe reads it as healthy, not broken). The ingress
      // kick re-arms instantly on the next accepted op — no op can be stranded — and
      // abandoned user-RPC testnets go permanently quiet instead of self-alarming forever.
      if (mempoolSize === 0 && pendingReceipts === 0 && lockedEOAs === 0) {
        this.idleCycles++;
        if (this.idleCycles >= IDLE_STOP_CYCLES) {
          // Re-check LIVE state synchronously right before stopping: an op accepted during
          // this alarm body (its ingress kick already armed the alarm) must not have that
          // alarm deleted from under it. No non-storage await sits between this check and
          // the deleteAlarm, so the DO input gate excludes interleaved accepts.
          const live = this.chainServices;
          const stillIdle = live !== null &&
            live.mempool.size === 0 &&
            live.bundler.pendingReceiptCount === 0 &&
            live.accountService.lockManager.getLockedEOAs().length === 0;
          if (stillIdle) {
            this.idleCycles = 0;
            await this.state.storage.put(STORAGE_KEY_ALARM_IDLE, true);
            await this.state.storage.deleteAlarm();
            console.log(`[BundlerDO:${this.chainId}] fully idle for ${IDLE_STOP_CYCLES} cycles — alarm stopped (kick re-arms on next op)`);
          }
        }
      } else {
        this.idleCycles = 0;
      }
    } catch (err) {
      // Nothing in the body may kill the alarm chain (already re-armed above) — but an
      // escaped exception here is by definition a code bug: log AND page.
      console.error(`[BundlerDO:${this.chainId}] Alarm cycle error:`, err);
      await this.alerter.send(
        `alarm-error-${this.chainId}`,
        `🐛 Vela Bundler — Worker alarm cycle threw on chain ${this.chainId}: ` +
          `${redactError(err).slice(0, 400)}\nAuto-bundling continues (alarm re-armed), but this is a code bug.`,
      );
    }
  }

  /** Shared accounting for chain-init failures (alarm re-init + fetch path): console always,
   *  Telegram once the streak shows it is persistent — a DO that cannot init serves 503 to
   *  every user request and leaves persisted pending receipts unmonitored. */
  private async noteInitFailure(chainId: number, err: unknown): Promise<void> {
    this.initFailureStreak++;
    console.error(`[BundlerDO] Init failed for chain ${chainId} (${this.initFailureStreak}x):`, err);
    if (this.initFailureStreak >= INIT_FAILURE_ALERT_STREAK) {
      await this.alerter.send(
        `init-failing-${chainId}`,
        `🚨 Vela Bundler — Worker DO for chain ${chainId} CANNOT INITIALIZE ` +
          `(${this.initFailureStreak} consecutive attempts): ${redactError(err).slice(0, 400)}\n` +
          `Every user request is failing with 503 and any in-flight receipts/locked EOAs are ` +
          `unmonitored until this is fixed. Check OPERATOR_SECRET / RPC resolution / chain registry.`,
      );
    }
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
    // Derive treasury from OPERATOR_SECRET. (The alerter already exists — constructor —
    // so a throw anywhere in here is still alertable via noteInitFailure.)
    const treasuryAddress = await deriveTreasuryAddress(this.env.OPERATOR_SECRET);
    this.config = buildConfig(this.env, treasuryAddress);

    const keyManager = new LocalKeyManager({
      operatorSecret: this.config.operatorSecret,
      oldOperatorSecrets: this.config.oldOperatorSecrets,
    });

    // Share the DO's alerter (one dedup map per chain isolate).
    this.sponsorService = new SponsorService(this.config, this.alerter);

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

    // Durably persist in-flight receipt reconciliation so a DO eviction between submit
    // and confirmation does not abandon a submitted bundle (receipt would otherwise be
    // null forever and the EOA effectively stuck). The hook fires immediately after each
    // submit and after each alarm reconciliation pass.
    bundler.setPersistPendingHook(async (state) => {
      if (state.length === 0) await this.state.storage.delete(STORAGE_KEY_PENDING_RECEIPTS);
      else await this.state.storage.put(STORAGE_KEY_PENDING_RECEIPTS, state);
    });
    // Restore any in-flight receipts from before the eviction and resume polling them.
    const savedPending = await this.state.storage.get(STORAGE_KEY_PENDING_RECEIPTS);
    if (savedPending) {
      bundler.importPendingState(savedPending as Parameters<typeof bundler.importPendingState>[0]);
      console.log(`[BundlerDO] Restored ${(savedPending as unknown[]).length} in-flight pending receipt(s) for chain ${chainId}`);
    }

    // Ingress bundle kick: an accepted op fires the alarm NOW instead of waiting out the
    // interval (the alarm serializes with any in-progress run; ~10s saved per op matters
    // for 5-minute trading windows).
    bundler.setKickHook(() => this.state.storage.setAlarm(Date.now()));

    // Immediate float refill: the INSTANT a bundle can't afford its outer gas (a fresh pool EOA
    // that the sweep hasn't funded yet, or a drained fronting EOA), request a treasury→EOA
    // top-up NOW instead of waiting for the next healthLoop tick. topUpFloatEOA is bounded +
    // in-flight-deduped, so repeated flags collapse to one send; the op stays in the mempool and
    // retries on the next alarm, by which time the funding tx has mined. Only on vault chains —
    // on a legacy deposit chain the EOA balance is the USER's, never operator-topped.
    bundler.setInsufficientFundsHook((eoa, shortfallWei) => {
      if (!this.sponsorService || !this.chainServices) return;
      if (!vaultActiveForChain(this.config?.settlementVaultChains, this.chainId)) return;
      void this.sponsorService
        .topUpFloatEOA(this.chainId, this.chainServices.rpcUrl, eoa, shortfallWei)
        .then(() => this.state.storage.setAlarm(Date.now())) // re-bundle promptly once funded
        .catch((err: unknown) => console.warn(`[BundlerDO:${this.chainId}] immediate float top-up failed: ${redactError(err)}`));
    });

    // Stage 4 producer: on chains where queue transport is active (QUEUE_TRANSPORT_ENABLED),
    // acceptUserOp hands the validated op to this hook instead of the in-DO mempool — it
    // enqueues to USEROP_QUEUE + writes the accepted-op KV marker. Wired unconditionally
    // (harmless when the flag is off: acceptUserOp gates on queueModeActive, so it is never
    // called); degrades to the mempool if USEROP_QUEUE is unbound at runtime.
    bundler.setEnqueueHook(makeEnqueueHook(this.env, { chainId, entryPoint: chainConfig.entryPointAddress }));

    // Durably persist accepted-unbundled ops: a deploy/eviction used to wipe the in-memory
    // mempool, silently vanishing accepted ops (the wallet polls null forever — worse than
    // any failure). Per-hash keys; writes are fire-and-forget (never block acceptance).
    mempool.setPersistenceHooks({
      put: (entry) => {
        void this.state.storage.put(MEMPOOL_KEY_PREFIX + entry.userOpHash, serializeMempoolEntry(entry))
          .catch((err: unknown) => console.warn(`[BundlerDO] mempool persist failed: ${redactError(err)}`));
      },
      delete: (userOpHash) => {
        void this.state.storage.delete(MEMPOOL_KEY_PREFIX + userOpHash)
          .catch((err: unknown) => console.warn(`[BundlerDO] mempool unpersist failed: ${redactError(err)}`));
      },
    });
    // Restore accepted ops from before the eviction. TTL-expired ones are dropped by the
    // next getAll() sweep, which stores the honest terminal receipt via the TTL hook.
    const savedOps = await this.state.storage.list<SerializedMempoolEntry>({ prefix: MEMPOOL_KEY_PREFIX });
    let restoredOps = 0;
    for (const [key, saved] of savedOps) {
      try {
        const entry = deserializeMempoolEntry(saved, chainConfig.entryPointAddress, chainId);
        if (mempool.restoreEntry(entry)) restoredOps++;
        else await this.state.storage.delete(key); // superseded/duplicate — drop the orphan
      } catch (err) {
        console.warn(`[BundlerDO] Skipped unrestorable mempool entry ${key}: ${redactError(err)}`);
        await this.state.storage.delete(key);
      }
    }
    if (restoredOps > 0) console.log(`[BundlerDO] Restored ${restoredOps} accepted op(s) for chain ${chainId}`);

    // Durably persist terminal receipts so an eviction cannot regress a wallet's poll from
    // "confirmed/failed" back to null. Same per-hash, fire-and-forget pattern.
    bundler.setReceiptPersistHooks({
      put: (userOpHash, receipt, expiresAt) => {
        void this.state.storage.put(RECEIPT_KEY_PREFIX + userOpHash, { userOpHash, receipt, expiresAt })
          .catch((err: unknown) => console.warn(`[BundlerDO] receipt persist failed: ${redactError(err)}`));
      },
      delete: (userOpHash) => {
        void this.state.storage.delete(RECEIPT_KEY_PREFIX + userOpHash)
          .catch((err: unknown) => console.warn(`[BundlerDO] receipt unpersist failed: ${redactError(err)}`));
      },
    });
    const savedReceipts = await this.state.storage.list<{ userOpHash: string; receipt: SerializedReceipt; expiresAt: number }>({ prefix: RECEIPT_KEY_PREFIX });
    if (savedReceipts.size > 0) {
      const now = Date.now();
      // Expired entries are deleted here (cheap, bounded by the list) — the in-memory
      // cleanExpiredReceipts can't see keys that were never restored.
      const expired = [...savedReceipts.entries()].filter(([, v]) => v.expiresAt <= now).map(([k]) => k);
      for (const k of expired) await this.state.storage.delete(k);
      bundler.importReceipts([...savedReceipts.values()]);
      console.log(`[BundlerDO] Restored ${savedReceipts.size - expired.length} receipt(s) for chain ${chainId}`);
    }

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
    this.initFailureStreak = 0;

    // Persist chainId so alarm can re-init after eviction. A FIRST-EVER activation (no
    // stored chainId) is a rare, operator-relevant event — a new chain now custodies funds.
    const priorChainId = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
    await this.state.storage.put(STORAGE_KEY_CHAIN_ID, chainId);
    if (priorChainId === undefined) {
      await this.alerter.send(
        `chain-activated-${chainId}`,
        `🆕 Vela Bundler — chain ${chainId} (${resolved.chain?.name ?? "unknown"}) activated on Workers ` +
          `(first request). Auto-bundling armed.`,
      );
    }

    // Restore lastDecayAt from storage (survives eviction)
    const storedDecay = await this.state.storage.get<number>(STORAGE_KEY_LAST_DECAY);
    this.lastDecayAt = storedDecay ?? Date.now();

    console.log(
      `[BundlerDO] Initialized chain ${chainId} (${resolved.chain?.name ?? "unknown"}) — RPC: ${redactRpcUrl(effectiveRpc)}`,
    );

    // Self-register with the chain-registry DO (fire-and-forget, idempotent) so the
    // liveness cron can enumerate every activated chain with zero manual config.
    try {
      const registry = this.env.BUNDLER.get(this.env.BUNDLER.idFromName("chain-registry"));
      void registry.fetch(new Request(`https://bundler-do/registry-add?chain=${chainId}`, { method: "POST" }))
        .catch((err: unknown) => console.warn(`[BundlerDO] chain-registry registration failed (cron probe will miss this chain until retry): ${redactError(err)}`));
    } catch (err) {
      console.warn(`[BundlerDO] chain-registry registration failed: ${redactError(err)}`);
    }

    // Schedule first alarm if none exists; an init means the chain is ACTIVE again, so any
    // deliberate-idle flag is stale.
    await this.state.storage.delete(STORAGE_KEY_ALARM_IDLE);
    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      await this.state.storage.setAlarm(Date.now() + this.alarmIntervalMs());
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

    const corsHeaders = CORS_HEADERS;

    // Rate limit using CF-Connecting-IP (cannot be spoofed by clients)
    const rateLimitConfig: RateLimitConfig = {
      rateLimitPerMinute: this.config.apiRateLimitPerMinute,
      allowlist: this.rateLimitAllowlist(),
    };
    const limited = rateLimitGuard(request, rateLimitConfig);
    if (limited) return limited;

    // Enforce the size limit on the raw BYTE length (Content-Length can be spoofed/omitted,
    // and String.length counts UTF-16 code units — a multibyte body could carry up to ~3× the
    // cap in real bytes before .length trips). Measure the ArrayBuffer, then decode.
    const bodyBuf = await request.arrayBuffer();
    if (bodyBuf.byteLength > MAX_BODY_SIZE) {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: invalidRequest("Request body too large") },
        { status: 413, headers: corsHeaders },
      );
    }
    const bodyText = new TextDecoder().decode(bodyBuf);

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
      await this.fillQueueModeReceiptLookups(body, responses);
      return jsonResponse(responses, corsHeaders);
    }

    const response = await processRequest(body, this.config, this.chainAdapter, reqCtx);
    await this.fillQueueModeReceiptLookups(body, response);
    return jsonResponse(response, corsHeaders);
  }

  /**
   * Stage 4 receipt lookup for queue-mode ops. In queue transport, a UserOp never enters this
   * chain DO's own mempool/receipts (the producer enqueued it to a RelayerDO), so the in-DO
   * eth_getUserOperationReceipt / eth_getUserOperationByHash resolve to null. A RelayerDO
   * publishes the TERMINAL receipt to USEROP_STATUS KV on confirmation; read it here and fill
   * the response so the wallet's poll resolves without fanning out to 100 DOs. Only runs when
   * queue mode is active for this chain AND the in-DO lookup already returned null — non-queue
   * chains (and any op already answered in-DO) are byte-identical to before. An accepted-but-
   * not-yet-mined op has a marker without a receipt → left null (still pending), as today.
   */
  private async fillQueueModeReceiptLookups(
    body: unknown,
    response: JsonRpcResponse | JsonRpcResponse[],
  ): Promise<void> {
    const kv = this.env.USEROP_STATUS;
    if (!kv) return;
    if (!this.chainServices || !this.chainServices.bundler.queueModeActive()) return;

    const fill = async (req: unknown, resp: JsonRpcResponse): Promise<void> => {
      if (!req || typeof req !== "object") return;
      const method = (req as { method?: unknown }).method;
      if (method !== "eth_getUserOperationReceipt" && method !== "eth_getUserOperationByHash") return;
      if (resp.result !== null) return; // in-DO lookup already answered (or it's an error)
      const params = (req as { params?: unknown }).params;
      const hash = Array.isArray(params) ? params[0] : undefined;
      if (typeof hash !== "string" || !hash.startsWith("0x")) return;
      const filled = await this.readStatusReceipt(method, hash).catch(() => undefined);
      if (filled !== undefined) resp.result = filled;
    };

    if (Array.isArray(body) && Array.isArray(response)) {
      await Promise.all(body.map((b, i) => (response[i] ? fill(b, response[i]!) : Promise.resolve())));
    } else if (!Array.isArray(body) && !Array.isArray(response)) {
      await fill(body, response);
    }
  }

  /** Read a terminal receipt from USEROP_STATUS KV and format it for the given method. Returns
   *  undefined when there is no KV entry or the op is still pending (marker without a receipt). */
  private async readStatusReceipt(method: string, userOpHash: string): Promise<unknown | undefined> {
    const kv = this.env.USEROP_STATUS;
    if (!kv) return undefined;
    const raw = await kv.get(userOpHash);
    if (!raw) return undefined;
    let record: { receipt?: SerializedReceipt } | null;
    try {
      record = JSON.parse(raw) as { receipt?: SerializedReceipt };
    } catch {
      return undefined;
    }
    if (!record?.receipt) return undefined; // accepted/pending → leave result null
    const receipt = deserializeReceipt(record.receipt);
    return method === "eth_getUserOperationReceipt"
      ? receiptToRpc(receipt)
      : receiptToByHashRpc(receipt);
  }

  private async handleRest(request: Request, doUrl: URL, _chainId: number): Promise<Response> {
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
      allowlist: this.rateLimitAllowlist(),
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

  /**
   * Cron-driven liveness probe (external layer of the dead-man switch), STORAGE-ONLY:
   *   - alarm scheduled                          → healthy (auto-bundling alive)
   *   - no alarm + deliberate-idle flag + empty  → healthy idle (kick re-arms on next op)
   *   - never activated                          → nothing to do
   *   - no alarm otherwise (or idle flag but money in flight — inconsistent) → BROKEN:
   *     re-arm + alert. The armed alarm re-initializes the chain itself when it fires.
   */
  /** Register/deregister a RelayerDO pool index in the dead-man watch list (B6). Storage-only. */
  private async handleRelayerWatch(url: URL, method: string): Promise<Response> {
    const index = parseInt(url.searchParams.get("index") ?? "-1");
    if (!(index >= 0 && index < RELAYER_POOL_SIZE)) {
      return Response.json({ error: "bad index" }, { status: 400 });
    }
    const key = RELAYER_WATCH_PREFIX + index;
    if (method === "DELETE") {
      await this.state.storage.delete(key);
      return Response.json({ watching: false, index });
    }
    await this.state.storage.put(key, Date.now());
    return Response.json({ watching: true, index });
  }

  /**
   * Cron fan-out (B6): probe every RelayerDO pool index registered as holding stranded money-path
   * state. Their own alarm is layer 1; this is the ONLY layer that catches a RelayerDO whose alarm
   * chain itself died (queue transport puts the money-path state in the 100 RelayerDOs, not here).
   * A probe that reports idle/unknown → the relayer drained (or its deregister was lost) → stop
   * watching it. Bounded to the registered set (usually small), never throws.
   */
  private async probeRegisteredRelayers(): Promise<void> {
    let watched: Map<string, number>;
    try {
      watched = await this.state.storage.list<number>({ prefix: RELAYER_WATCH_PREFIX });
    } catch { return; }
    if (watched.size === 0) return;
    const knownChain = (await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID)) ?? this.chainId;
    if (!(knownChain > 0) || !this.env.RELAYER) return;
    await Promise.allSettled([...watched.keys()].map(async (key) => {
      const index = parseInt(key.slice(RELAYER_WATCH_PREFIX.length));
      if (!(index >= 0 && index < RELAYER_POOL_SIZE)) { await this.state.storage.delete(key); return; }
      try {
        const stub = this.env.RELAYER.get(this.env.RELAYER.idFromName(`chain-${knownChain}-eoa-${index}`));
        const res = await stub.fetch(new Request("https://relayer-do/ensure-alarm"));
        const body = await res.json().catch(() => null) as { rearmed?: boolean; idle?: boolean; unknown?: boolean } | null;
        if (body?.rearmed) console.error(`[BundlerDO:${knownChain}] cron re-armed a BROKEN RelayerDO alarm for pool index ${index}`);
        if (body?.idle || body?.unknown) await this.state.storage.delete(key); // drained → stop watching
      } catch (err) {
        console.error(`[BundlerDO:${knownChain}] relayer liveness probe failed for index ${index}: ${redactError(err)}`);
      }
    }));
  }

  private async handleEnsureAlarm(): Promise<Response> {
    // Always fan out to the registered RelayerDOs first — a relayer's alarm can be dead even when
    // THIS chain DO's alarm is healthy (they are separate isolates), so this must not be gated on
    // the chain DO's own alarm status below.
    await this.probeRegisteredRelayers();

    const alarmAt = await this.state.storage.getAlarm();
    if (alarmAt !== null) {
      return Response.json({ rearmed: false, healthy: true, nextAlarm: alarmAt });
    }
    const knownChain = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
    if (knownChain === undefined) {
      return Response.json({ rearmed: false, unknown: true });
    }
    const idle = await this.state.storage.get<boolean>(STORAGE_KEY_ALARM_IDLE);
    const hasInFlight = await this.hasPersistedInFlightState();
    if (idle && !hasInFlight) {
      return Response.json({ rearmed: false, idle: true, chainId: knownChain });
    }
    await this.state.storage.delete(STORAGE_KEY_ALARM_IDLE);
    await this.state.storage.setAlarm(Date.now() + this.alarmIntervalMs());
    console.error(`[BundlerDO:${knownChain}] alarm chain was BROKEN — re-armed by cron liveness check`);
    await this.alerter.send(
      `alarm-rearmed-${knownChain}`,
      `🚑 Vela Bundler — chain ${knownChain}'s Worker alarm chain was BROKEN (auto-bundling had ` +
        `stopped${hasInFlight ? " WITH in-flight state" : ""}) and has been re-armed by the cron ` +
        `liveness check. Investigate why it died (logs around this time).`,
    );
    return Response.json({ rearmed: true, chainId: knownChain });
  }

  /** True when durable storage holds money-path state that reconciliation must finish:
   *  persisted pending receipts or accepted-unbundled mempool ops. Readable without init. */
  private async hasPersistedInFlightState(): Promise<boolean> {
    const pending = await this.state.storage.get(STORAGE_KEY_PENDING_RECEIPTS);
    if (pending !== undefined && Array.isArray(pending) && pending.length > 0) return true;
    const ops = await this.state.storage.list({ prefix: MEMPOOL_KEY_PREFIX, limit: 1 });
    return ops.size > 0;
  }

  /** Top up ONE fronting/pool EOA from the treasury, serialized on the treasury nonce (all
   *  callers funnel through this single chain-DO SponsorService). Called by a RelayerDO whose
   *  pool EOA can't afford its bundle. Vault chains only — on a legacy deposit chain the EOA
   *  balance is the USER's, never operator-topped. */
  private async handleFundEoa(url: URL): Promise<Response> {
    const address = url.searchParams.get("address");
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return Response.json({ error: "bad address" }, { status: 400 });
    }
    if (!this.sponsorService || !this.chainServices) {
      return Response.json({ error: "not initialized" }, { status: 503 });
    }
    if (!vaultActiveForChain(this.config?.settlementVaultChains, this.chainId)) {
      return Response.json({ error: "not a vault chain" }, { status: 409 });
    }
    let shortfallWei: bigint | undefined;
    const raw = url.searchParams.get("shortfall");
    if (raw) { try { shortfallWei = BigInt(raw); } catch { /* size to the static target */ } }
    try {
      const res = await this.sponsorService.topUpFloatEOA(
        this.chainId, this.chainServices.rpcUrl, address.toLowerCase() as `0x${string}`, shortfallWei,
      );
      return Response.json(res);
    } catch (err) {
      console.error(`[BundlerDO:${this.chainId}] fund-eoa error for ${address}:`, redactError(err));
      return Response.json({ toppedUp: false, reason: "internal_error" }, { status: 500 });
    }
  }

  /** Read-only per-op lifecycle inspection for the /debug UI: the op's stage + where it lives, the
   *  KV status marker, and the chain's live health/funding context. No mutation, no secrets. */
  private async handleInspect(url: URL, chainId: number): Promise<Response> {
    const hash = (url.searchParams.get("hash") ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return Response.json({ error: "bad hash (expected 0x + 64 hex chars)" }, { status: 400, headers: CORS_HEADERS });
    }
    const cs = this.chainServices;
    if (!cs) return Response.json({ error: "chain not initialized" }, { status: 503, headers: CORS_HEADERS });

    let op = cs.bundler.inspectOp(hash);

    // KV status marker (queue-mode 'accepted'/'pending' + terminal receipts). The 'accepted' and
    // 'pending' markers also carry the pool INDEX so we can fan out to the owning RelayerDO.
    let kv: { present: boolean; status?: string; hasReceipt?: boolean; index?: number } | null = null;
    let kvIndex: number | undefined;
    if (this.env.USEROP_STATUS) {
      try {
        const raw = await this.env.USEROP_STATUS.get(hash);
        if (raw) {
          const p = JSON.parse(raw) as { status?: string; receipt?: unknown; index?: number };
          kvIndex = typeof p.index === "number" ? p.index : undefined;
          kv = { present: true, status: p.status, hasReceipt: p.receipt !== undefined, index: kvIndex };
        } else {
          kv = { present: false };
        }
      } catch { kv = null; }
    }

    // Queue mode: the op body lives in a per-index RelayerDO, not here. If we didn't find it locally
    // and the KV marker names its index, fan out to that RelayerDO's /inspect for the real detail.
    if (op.stage === "unknown" && kvIndex !== undefined && this.env.RELAYER) {
      try {
        const stub = this.env.RELAYER.get(this.env.RELAYER.idFromName(`chain-${chainId}-eoa-${kvIndex}`));
        const res = await stub.fetch(new Request(`https://relayer-do/inspect?hash=${hash}`));
        const body = await res.json().catch(() => null) as { op?: typeof op } | null;
        if (body?.op) op = body.op;
      } catch (err) {
        console.warn(`[BundlerDO:${chainId}] inspect fan-out to relayer #${kvIndex} failed: ${redactError(err)}`);
      }
    }

    const chain = {
      chainId,
      mempoolSize: cs.mempool.size,
      pendingReceiptCount: cs.bundler.pendingReceiptCount,
      lockedEOAs: cs.accountService.lockManager.getLockedEOAs().map((e) => e.address),
      insufficientFundsEoa: cs.bundler.insufficientFundsEoa,
      insufficientFundsWei: cs.bundler.insufficientFundsWei?.toString() ?? null,
      lastSubmitError: cs.bundler.lastSubmitError,
      oldestMempoolAgeMs: cs.mempool.oldestEntryAgeMs(),
    };

    return Response.json({ op, kv, chain }, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  private handleHealth(requestedChainId: number = this.chainId): Response {
    if (!this.chainServices) {
      // Report the chain that was actually asked about (this.chainId is 0 when init was skipped).
      return Response.json({ status: "uninitialized", chainId: requestedChainId || this.chainId });
    }

    const cs = this.chainServices;
    const lockedEOAs = cs.accountService.lockManager.getLockedEOAs().length;
    const rel = reliabilityHealth();
    return Response.json({
      service: "vela-bundler",
      runtime: "cloudflare-workers",
      chainId: this.chainId,
      chainName: cs.chainInfo?.name ?? "unknown",
      status: lockedEOAs > 0 || rel.circuit.degraded > 0 ? "degraded" : "ok",
      // An operator who believes Telegram alerts are armed when they are not is the worst
      // blind spot — make the state checkable from outside.
      alerting: this.alerter.enabled ? "telegram" : "disabled",
      mempoolSize: cs.mempool.size,
      oldestMempoolAgeMs: cs.mempool.oldestEntryAgeMs(),
      lockedEOAs,
      pendingReceipts: cs.bundler.pendingReceiptCount,
      oldestPendingReceiptAgeMs: cs.bundler.oldestPendingReceiptAgeMs(),
      submitFailureStreak: cs.bundler.submitFailureStreak,
      reliability: rel,
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

    // Treasury-balance monitor (deduped Telegram alert when low). No-op if unconfigured.
    if (this.config) {
      try {
        await checkTreasuryBalance({
          chainId: this.chainId,
          chainName: this.chainServices.chainInfo?.name ?? null,
          treasuryAddress: this.config.treasuryAddress,
          client: getPublicClient(this.chainServices.rpcUrl),
          thresholdWei: this.config.treasuryAlertThresholdWei,
          thresholdPathUsd: this.config.treasuryAlertThresholdPathUsd,
          alerter: this.alerter,
        });
        this.escalator.ok("treasury-monitor", this.chainId);
      } catch (err) {
        console.error(`[BundlerDO:${this.chainId}] Treasury monitor error:`, err);
        await this.escalator.note("treasury-monitor", this.chainId, err);
      }

      // Pool relayer float top-up: keep the 100 pool EOAs at their float target from
      // the treasury. Gated on the STAGE-3 flag, not vault mode — with vault on
      // everywhere, funding the pool before anything uses it would just park treasury
      // money in 100 idle EOAs per chain. Internally rate-limited to one sweep per
      // minute; serialized against the treasury nonce inside the service.
      if (
        this.sponsorService &&
        vaultActiveForChain(this.config.settlementVaultChains, this.chainId)
      ) {
        if (chainSpecEnables(this.config.poolEoaChains, this.chainId)) {
        try {
          await this.sponsorService.topUpPoolEOAs(
            this.chainId,
            this.chainServices.rpcUrl,
            async (i) => (await this.chainServices!.accountService.getPoolEOA(i)).address,
          );
          this.escalator.ok("pool-topup", this.chainId);
        } catch (err) {
          console.error(`[BundlerDO:${this.chainId}] Pool top-up error:`, err);
          await this.escalator.note("pool-topup", this.chainId, err);
        }
        }

        // Fronting-EOA float refill: in vault mode the reimbursement goes to the
        // treasury, so the per-safe EOA that fronts the outer gas is no longer
        // self-healing. When the bundle loop flags one as unable to afford the outer
        // tx, refill it from the treasury (bounded + serialized inside the service).
        const lowEoa = this.chainServices.bundler.insufficientFundsEoa;
        if (lowEoa) {
          try {
            await this.sponsorService.topUpFloatEOA(
              this.chainId,
              this.chainServices.rpcUrl,
              lowEoa,
              // Size the refill to the ACTUAL prefund that bounced (×1.5 headroom), not a
              // static target — a multi-sender pool bundle can need many× poolFloatTargetWei.
              this.chainServices.bundler.insufficientFundsWei ?? undefined,
            );
            this.escalator.ok("float-topup", this.chainId);
          } catch (err) {
            console.error(`[BundlerDO:${this.chainId}] Float top-up error:`, err);
            await this.escalator.note("float-topup", this.chainId, err);
          }
        }
      }

      // Operational-health monitor: alert on any STUCK condition (mempool op / pending bundle /
      // locked EOA / repeated broadcast failure / underfunded EOA / degraded RPC) — a user's
      // money can't move and a developer must intervene.
      try {
        const cs = this.chainServices;
        await checkOperationalHealth({
          chainId: this.chainId,
          chainName: cs.chainInfo?.name ?? null,
          oldestMempoolAgeMs: cs.mempool.oldestEntryAgeMs(),
          lockedEoaCount: cs.accountService.lockManager.getLockedEOAs().length,
          oldestLockedAgeMs: cs.accountService.lockManager.oldestLockedAgeMs(),
          pendingReceiptCount: cs.bundler.pendingReceiptCount,
          oldestPendingReceiptAgeMs: cs.bundler.oldestPendingReceiptAgeMs(),
          circuitDegraded: reliabilityHealth().circuit.degraded,
          reputationBannedSenders: cs.mempool.reputation.countPenalized("sender").banned,
          submitFailureStreak: cs.bundler.submitFailureStreak,
          lastSubmitError: cs.bundler.lastSubmitError,
          insufficientFundsEoa: cs.bundler.insufficientFundsEoa,
        }, DEFAULT_OPERATIONAL_THRESHOLDS, this.alerter);
        this.escalator.ok("operational-monitor", this.chainId);
      } catch (err) {
        console.error(`[BundlerDO:${this.chainId}] Operational monitor error:`, err);
        await this.escalator.note("operational-monitor", this.chainId, err);
      }

      // Alive heartbeat (dead-man switch, in-process layer): a periodic per-chain "alive"
      // message — SILENCE past the interval means this chain's alarm loop is dead. The
      // last-sent timestamp is persisted so evictions neither spam nor gap the cadence.
      try {
        if (this.lastHeartbeatAt === null) {
          this.lastHeartbeatAt = (await this.state.storage.get<number>(STORAGE_KEY_LAST_HEARTBEAT)) ?? 0;
        }
        const last = this.lastHeartbeatAt;
        const cs = this.chainServices;
        const sent = await maybeSendAliveHeartbeat({
          alerter: this.alerter,
          lastSentAt: last,
          runtime: `workers chain ${this.chainId}`,
          stats:
            `mempool ${cs.mempool.size}, locked EOAs ${cs.accountService.lockManager.getLockedEOAs().length}, ` +
            `pending receipts ${cs.bundler.pendingReceiptCount}`,
        });
        if (sent !== last) {
          this.lastHeartbeatAt = sent;
          await this.state.storage.put(STORAGE_KEY_LAST_HEARTBEAT, sent);
        }
      } catch (err) {
        console.error(`[BundlerDO:${this.chainId}] Alive heartbeat error:`, err);
      }
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
