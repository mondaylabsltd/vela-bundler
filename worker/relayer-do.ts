/**
 * RelayerDO — a per-EOA Durable Object (Stage 4 of docs/pool-queue-architecture.md).
 *
 * One instance per (chainId, pool index i), addressed as `chain-${chainId}-eoa-${i}`. It
 * mirrors BundlerDO's shape (a hosted BundlerService + a self-rearming alarm + durable
 * persistence of the mempool / pending receipts / terminal receipts) but is PINNED to pool
 * EOA #i: its BundlerService runs with `fixedPoolIndex: i`, so every bundle is signed by that
 * one pool EOA. The DO's input gate is the per-EOA lock — /submit calls serialize, giving a
 * correct nonce with no cross-isolate race.
 *
 * The queue consumer (worker/index.ts) routes each op by hash(sender)%RELAYER_POOL_SIZE to the
 * matching instance and POSTs `/submit`. Assembly (multi-sender drop-resim-reassemble, per-op
 * attribution, receipt reconciliation) is UNCHANGED — it reuses BundlerService verbatim.
 *
 * The pool EOAs' native float is kept topped up by the chain BundlerDO's health loop
 * (topUpPoolEOAs from the treasury, serialized on the treasury nonce), so this DO does no
 * funding of its own.
 */

import type { Env, UserOpQueueMessage } from "./types.ts";
import { buildConfig } from "./config.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import { resolveChain } from "../shared/config/chain-registry.ts";
import { createSimulator } from "../shared/simulation/index.ts";
import {
  Mempool,
  serializeMempoolEntry,
  deserializeMempoolEntry,
  isMempoolFullError,
  type SerializedMempoolEntry,
} from "../shared/mempool/index.ts";
import type { SerializedReceipt } from "../shared/bundler/index.ts";
import { AccountService } from "../shared/account/index.ts";
import { BundlerService } from "../shared/bundler/index.ts";
import { LocalKeyManager } from "../shared/keys/local.ts";
import { RELAYER_POOL_SIZE } from "../shared/keys/derive.ts";
import { deriveTreasuryAddress } from "../shared/keys/derive.ts";
import type { ChainServices } from "../shared/chain/index.ts";
import { resolveRpcUrl, getPublicClient } from "../shared/utils/rpc-client.ts";
import { metrics, logEvent, redactError } from "../shared/reliability/log.ts";
import { normalizeUserOp } from "../shared/userop/normalize.ts";
import { createAlerter, type Alerter } from "../shared/monitoring/telegram.ts";
import { RepeatedErrorEscalator } from "../shared/monitoring/escalation.ts";
import { checkOperationalHealth, DEFAULT_OPERATIONAL_THRESHOLDS } from "../shared/monitoring/operational.ts";
import { reliabilityHealth } from "../shared/reliability/rpc-fetch.ts";

/** Fallback alarm interval before config loads; honours AUTO_BUNDLE_INTERVAL_MS once inited. */
const DEFAULT_ALARM_INTERVAL_MS = 10_000;

/** DO storage keys (mirrors BundlerDO; `index` is this DO's pinned pool index). */
const STORAGE_KEY_CHAIN_ID = "chainId";
const STORAGE_KEY_POOL_INDEX = "poolIndex";
const STORAGE_KEY_PENDING_RECEIPTS = "pendingReceipts";
const STORAGE_KEY_SEEN = "seen";
const STORAGE_KEY_ALARM_IDLE = "alarmIdle";
const MEMPOOL_KEY_PREFIX = "mp:";
const RECEIPT_KEY_PREFIX = "rc:";

/** Consecutive fully-idle alarm cycles before the alarm stops re-arming (~5 min @ 10s). A
 *  /submit re-arms instantly via the kick hook, so an idle stop can never strand an op. */
const IDLE_STOP_CYCLES = 30;

/** Bound on the persisted dedup seen-set (FIFO). Queues are at-least-once but redelivery
 *  windows are short; this only guards against re-submitting an op whose in-flight/terminal
 *  state has already aged out of the pending list + receipt store. */
const SEEN_MAX = 8192;

/** Terminal-receipt KV TTL — 24h, matching the in-memory receipt TTL, so the chain endpoint
 *  can answer a wallet poll for that long without fanning out to 100 DOs. */
const STATUS_RECEIPT_TTL_SECONDS = 24 * 60 * 60;
/** Accepted/pending status marker TTL (no receipt yet). */
const STATUS_PENDING_TTL_SECONDS = 900;

/** Extra times a terminal receipt is re-published to USEROP_STATUS KV on later alarms. The
 *  initial write is one fire-and-forget put, and the chain DO's queue-mode poll reads ONLY this
 *  KV (never fans out to 100 DOs) — so a single dropped put would strand a confirmed op with the
 *  wallet polling null forever. Re-asserting a couple more times makes that vanishingly unlikely. */
const KV_RECEIPT_REASSERT_ATTEMPTS = 2;
/** Bound on the pending re-assert set (backpressure; the alarm drains it within a few cycles). */
const KV_REASSERT_MAX = 512;

/** How often a stranded RelayerDO re-asserts its dead-man registration with the chain DO. Much
 *  shorter than the 5-min cron so a registration is always fresh when the cron reads it, but far
 *  longer than the ~10s alarm so 100 relayers don't hammer the chain DO. */
const WATCH_REG_REFRESH_MS = 90_000;

/**
 * Dedup + enqueue a batch of queued ops into a per-EOA RelayerDO's mempool, then kick a
 * bundle pass. Exported for direct unit testing (the DO wraps it with its persisted seen-set
 * + KV status hook). Queues are AT-LEAST-ONCE, so each op is deduped by userOpHash against the
 * persisted seen-set, the mempool, in-flight pending receipts and terminal receipts; a
 * duplicate is still ACKed (returned in `accepted`) so redelivery does not retry forever.
 */
/** Shape of the chain-DO /fund-eoa response body (SponsorService.topUpFloatEOA result). */
export interface FundEoaResult { toppedUp?: boolean; reason?: string }

/**
 * Whether a /fund-eoa response means funding is UNDER WAY, so the RelayerDO should fast-retry
 * (~4s, expecting the L2 funding tx to mine) rather than back off to the normal alarm cadence.
 * Non-actionable reasons (treasury_depleted / treasury_tx_stuck / budget_exhausted / transfer_
 * failed / not-a-vault chain / a non-2xx) return false — fast-retrying those just hammers an
 * already-unhealthy RPC endpoint (100 relayers × ~4s × ~7 reads) and can prolong the outage.
 */
export function fundingUnderway(ok: boolean, body: FundEoaResult | null): boolean {
  return ok && (body?.toppedUp === true || body?.reason === "in_flight" || body?.reason === "already_funded");
}

export async function relayerSubmit(params: {
  ops: UserOpQueueMessage[];
  mempool: Mempool;
  bundler: BundlerService;
  seen: Set<string>;
  /** Best-effort per-op status update (RelayerDO → USEROP_STATUS KV). */
  markStatus?: (userOpHash: `0x${string}`, status: "submitted" | "pending") => void;
}): Promise<{ accepted: `0x${string}`[]; added: number }> {
  const { ops, mempool, bundler, seen } = params;
  // A hash is added to `accepted` ONLY when the delivery is fully handled (admitted, already
  // known, unparseable, or DEFINITIVELY rejected). A TRANSIENT rejection (mempool full) is left
  // OUT so the consumer retries that message once the backlog drains — see the catch below.
  const accepted: `0x${string}`[] = [];
  let added = 0;
  for (const op of ops) {
    const hash = op.userOpHash;
    if (seen.has(hash) || mempool.get(hash) || bundler.getReceipt(hash) || bundler.hasPending(hash)) {
      accepted.push(hash); // already known → idempotent ack
      continue;
    }
    let userOp;
    try {
      userOp = normalizeUserOp(op.rpcUserOp);
    } catch (err) {
      console.warn(`[RelayerDO] dropping unparseable queued op ${hash}: ${redactError(err)}`);
      seen.add(hash);
      accepted.push(hash); // a retry can't fix a malformed op — ack (don't loop to the DLQ pointlessly)
      continue;
    }
    try {
      mempool.add(userOp, BigInt(op.prefund || "0"), op.rpcUrlOverride);
      seen.add(hash);
      added++;
      params.markStatus?.(hash, "pending");
      accepted.push(hash); // admitted → ack
    } catch (err) {
      if (isMempoolFullError(err)) {
        // TRANSIENT capacity condition (a load spike saturating this pool index). It CLEARS as
        // bundles land, so this op just needs to wait — do NOT seen.add and do NOT store a
        // terminal failed receipt (which would permanently kill a valid op and lie to the
        // polling wallet). Leave it OUT of `accepted` so the consumer redelivers it; a SUSTAINED
        // overload eventually routes it to the DLQ (max_retries), which the DLQ consumer handles.
        console.warn(`[RelayerDO] mempool full — deferring queued op ${hash} for redelivery`);
        continue;
      }
      // Definitive admission rejection (one-op-per-sender guard, reputation ban). The wallet was
      // told SUCCESS at ingress and is polling this hash — store a TERMINAL failed receipt (fires
      // the KV persist hook) so the poll resolves, then ACK (a retry would re-hit the same reject).
      console.warn(`[RelayerDO] mempool rejected queued op ${hash}: ${redactError(err)}`);
      seen.add(hash);
      try {
        bundler.rejectAccepted(hash, userOp.sender, userOp.nonce, redactError(err));
      } catch (e) {
        console.warn(`[RelayerDO] failed to store terminal receipt for ${hash}: ${redactError(e)}`);
      }
      accepted.push(hash);
    }
  }
  if (added > 0) await bundler.kickBundle();
  return { accepted, added };
}

export class RelayerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  private chainServices: ChainServices | null = null;
  private config: BundlerConfig | null = null;
  private chainId = 0;
  private poolIndex = -1;
  private initPromise: Promise<void> | null = null;
  private readonly alerter: Alerter;
  private readonly escalator: RepeatedErrorEscalator;
  /** In-memory mirror of the persisted dedup seen-set (loaded in _init). */
  private seen = new Set<string>();
  private idleCycles = 0;
  /** Terminal receipts whose KV publication is re-asserted on the next few alarms (see
   *  KV_RECEIPT_REASSERT_ATTEMPTS): hash → { serialized receipt, remaining re-asserts }. */
  private readonly kvReassert = new Map<string, { receipt: SerializedReceipt; remaining: number }>();
  /** Chain-DO dead-man registration state (see updateChainWatch): whether this index is currently
   *  registered as stranded, and when it was last (re)asserted. */
  private watchRegistered = false;
  private lastWatchRegAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.alerter = createAlerter({
      telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
      telegramChatId: env.TELEGRAM_CHAT_ID || null,
    }, { quiet: true });
    this.escalator = new RepeatedErrorEscalator(this.alerter);
  }

  private alarmIntervalMs(): number {
    const configured = this.config?.autoBundleIntervalMs;
    return configured && Number.isFinite(configured) ? Math.max(2_000, configured) : DEFAULT_ALARM_INTERVAL_MS;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/submit" && request.method === "POST") {
      const chainId = parseInt(url.searchParams.get("chainId") ?? "0");
      const index = parseInt(url.searchParams.get("index") ?? "-1");
      if (!(chainId > 0) || !(index >= 0 && index < RELAYER_POOL_SIZE)) {
        return Response.json({ error: "bad chainId/index" }, { status: 400 });
      }
      try {
        await this.ensureInitialized(chainId, index);
      } catch (err) {
        console.error(`[RelayerDO:${chainId}#${index}] init failed:`, redactError(err));
        // 503 → the consumer retries the whole group (goes to DLQ after max_retries).
        return Response.json({ error: "init failed" }, { status: 503 });
      }
      return await this.handleSubmit(request);
    }

    if (url.pathname === "/health") {
      return this.handleHealth();
    }

    if (url.pathname === "/ensure-alarm") {
      return await this.handleEnsureAlarm();
    }

    if (url.pathname === "/inspect" && request.method === "GET") {
      const hash = (url.searchParams.get("hash") ?? "").trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return Response.json({ error: "bad hash" }, { status: 400 });
      // A hibernated DO loses in-memory chainServices, but the op's state is durable (mp:/rc: keys).
      // The inspect fan-out does NOT carry chainId/index, so rehydrate from the persisted pair the
      // same way the alarm does — otherwise inspect after an idle-stop spuriously reports "not
      // initialized" for an op that's actually sitting in the persisted mempool.
      if (!this.chainServices) {
        const chainId = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
        const index = await this.state.storage.get<number>(STORAGE_KEY_POOL_INDEX);
        if (chainId === undefined || index === undefined) {
          return Response.json({ op: { hash, stage: "unknown", detail: "RelayerDO never initialized (no persisted state)" } });
        }
        try {
          await this.ensureInitialized(chainId, index);
        } catch (err) {
          console.warn(`[RelayerDO:${chainId}#${index}] inspect rehydrate failed: ${redactError(err)}`);
          return Response.json({ op: { hash, stage: "unknown", detail: "RelayerDO rehydrate failed during inspect" } });
        }
      }
      return Response.json({ op: this.chainServices!.bundler.inspectOp(hash), poolIndex: this.poolIndex });
    }

    return new Response("not found", { status: 404 });
  }

  private async handleSubmit(request: Request): Promise<Response> {
    if (!this.chainServices) {
      return Response.json({ error: "not initialized" }, { status: 503 });
    }
    let body: { ops?: UserOpQueueMessage[] };
    try {
      body = await request.json() as { ops?: UserOpQueueMessage[] };
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }
    const ops = Array.isArray(body.ops) ? body.ops : [];
    const kv = this.env.USEROP_STATUS;
    const { accepted, added } = await relayerSubmit({
      ops,
      mempool: this.chainServices.mempool,
      bundler: this.chainServices.bundler,
      seen: this.seen,
      markStatus: kv
        ? (hash, status) => {
            // Keep the pool index in the pending marker (like the producer's accepted marker) so
            // the /debug inspector can fan out to THIS RelayerDO for the op's in-flight detail.
            void kv.put(hash, JSON.stringify({ status, index: this.poolIndex }), { expirationTtl: STATUS_PENDING_TTL_SECONDS })
              .catch((err: unknown) => console.warn(`[RelayerDO] status marker failed for ${hash}: ${redactError(err)}`));
          }
        : undefined,
    });
    // Persist the dedup seen-set (bounded, fire-and-forget) so redelivery after an eviction
    // still dedups.
    this.persistSeen();

    // CRITICAL: re-arm the alarm after accepting work. relayerSubmit's inline kickBundle can
    // create a pending receipt + lock the pool EOA, but it does NOT re-arm the alarm (it calls
    // kickBundle directly, not the kick hook). On a WARM DO that has idle-stopped (deleteAlarm),
    // nothing would then run checkPendingReceipts — the receipt would never be captured (wallet
    // polls null) and the pinned pool EOA would stay LOCKED_PENDING_UNKNOWN forever, bricking
    // this relayer index. Ensure an alarm is armed whenever there is now anything to reconcile.
    if (added > 0 || this.chainServices.bundler.pendingReceiptCount > 0 || this.chainServices.mempool.size > 0) {
      this.idleCycles = 0;
      await this.state.storage.delete(STORAGE_KEY_ALARM_IDLE);
      if ((await this.state.storage.getAlarm()) === null) {
        await this.state.storage.setAlarm(Date.now() + this.alarmIntervalMs());
      }
    }
    return Response.json({ accepted });
  }

  /**
   * Cron-driven liveness probe (dead-man switch, layer 2), STORAGE-ONLY. The RelayerDO alarm
   * self-re-arms (layer 1), but a storage error during setAlarm or an exhausted CF alarm-retry
   * budget can kill it permanently — and in queue mode this DO holds the money-path state
   * (persisted mempool ops / pending receipts / locked pool EOA), so a dead alarm silently stops
   * reconciliation for that pool index. The chain BundlerDO's cron fan-out probes this (only for
   * indices registered as stranded), re-arming + alerting if the alarm chain broke.
   */
  private async handleEnsureAlarm(): Promise<Response> {
    const alarmAt = await this.state.storage.getAlarm();
    if (alarmAt !== null) return Response.json({ rearmed: false, healthy: true, nextAlarm: alarmAt });
    const chainId = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
    const index = await this.state.storage.get<number>(STORAGE_KEY_POOL_INDEX);
    if (chainId === undefined || index === undefined) return Response.json({ rearmed: false, unknown: true });
    const idle = await this.state.storage.get<boolean>(STORAGE_KEY_ALARM_IDLE);
    const hasInFlight = await this.hasPersistedInFlightState();
    if (idle && !hasInFlight) return Response.json({ rearmed: false, idle: true, index });
    await this.state.storage.delete(STORAGE_KEY_ALARM_IDLE);
    await this.state.storage.setAlarm(Date.now() + this.alarmIntervalMs());
    console.error(`[RelayerDO:${chainId}#${index}] alarm chain was BROKEN — re-armed by cron liveness check`);
    await this.alerter.send(
      `relayer-alarm-rearmed-${chainId}-${index}`,
      `🚑 Vela Bundler — RelayerDO chain ${chainId} pool EOA #${index}'s alarm chain was BROKEN` +
        `${hasInFlight ? " WITH in-flight money state" : ""} and was re-armed by the cron liveness check. ` +
        `Reconciliation for that pool index had stopped — investigate why the alarm died (logs around now).`,
    );
    return Response.json({ rearmed: true, chainId, index });
  }

  /** True when durable storage holds money-path state reconciliation must finish (persisted
   *  pending receipts or accepted-unbundled mempool ops). Readable without a full init. */
  private async hasPersistedInFlightState(): Promise<boolean> {
    const pending = await this.state.storage.get(STORAGE_KEY_PENDING_RECEIPTS);
    if (pending !== undefined && Array.isArray(pending) && pending.length > 0) return true;
    const ops = await this.state.storage.list({ prefix: MEMPOOL_KEY_PREFIX, limit: 1 });
    return ops.size > 0;
  }

  private handleHealth(): Response {
    if (!this.chainServices) {
      return Response.json({ status: "uninitialized", chainId: this.chainId, poolIndex: this.poolIndex });
    }
    const cs = this.chainServices;
    return Response.json({
      service: "vela-relayer",
      chainId: this.chainId,
      poolIndex: this.poolIndex,
      mempoolSize: cs.mempool.size,
      pendingReceipts: cs.bundler.pendingReceiptCount,
      lockedEOAs: cs.accountService.lockManager.getLockedEOAs().length,
    });
  }

  async alarm(): Promise<void> {
    // Re-arm FIRST — the reschedule must never depend on the body completing (an escaped
    // exception past the setAlarm could exhaust CF's bounded alarm-retry budget and end
    // reconciliation for this EOA forever). A /submit kick may overwrite this with an earlier
    // time — fine, every run re-arms again.
    await this.state.storage.setAlarm(Date.now() + this.alarmIntervalMs());

    try {
      if (!this.chainServices) {
        const chainId = await this.state.storage.get<number>(STORAGE_KEY_CHAIN_ID);
        const index = await this.state.storage.get<number>(STORAGE_KEY_POOL_INDEX);
        if (chainId && index !== undefined) {
          try {
            await this.ensureInitialized(chainId, index);
          } catch (err) {
            console.error(`[RelayerDO] alarm re-init failed for chain ${chainId}#${index}:`, redactError(err));
          }
        }
        if (!this.chainServices) return; // re-armed above; retry next cycle
      }

      const cs = this.chainServices;

      // Reconcile in-flight bundles (capture receipts, release reservations, recover the EOA).
      try {
        await cs.bundler.checkPendingReceipts();
        this.escalator.ok("reconcile", this.chainId);
      } catch (err) {
        console.error(`[RelayerDO:${this.chainId}#${this.poolIndex}] reconcile error:`, err);
        await this.escalator.note("reconcile", this.chainId, err);
      }

      // Bundle anything queued-but-unbundled (e.g. a prior cycle deferred on a busy EOA).
      try {
        await cs.bundler.kickBundle();
        this.escalator.ok("auto-bundle", this.chainId);
      } catch (err) {
        console.error(`[RelayerDO:${this.chainId}#${this.poolIndex}] auto-bundle error:`, err);
        await this.escalator.note("auto-bundle", this.chainId, err);
      }

      // Recover this EOA if a confirmed/dropped tx left it LOCKED_PENDING_UNKNOWN.
      try {
        const locked = cs.accountService.lockManager.getLockedEOAs();
        if (locked.length > 0) {
          const client = getPublicClient(cs.rpcUrl);
          for (const eoa of locked) {
            try { await cs.accountService.lockManager.tryRecoverEOA(eoa.address, client); } catch { /* next cycle */ }
          }
        }
      } catch (err) {
        console.error(`[RelayerDO:${this.chainId}#${this.poolIndex}] recovery error:`, err);
      }

      cs.bundler.cleanExpiredReceipts();

      // Re-assert recent terminal-receipt KV writes (belt-and-suspenders for a dropped put; the
      // chain DO's queue-mode poll reads ONLY this KV).
      this.drainKvReassert();

      const mempoolSize = cs.mempool.size;
      const pendingReceipts = cs.bundler.pendingReceiptCount;
      const lockedEOAs = cs.accountService.lockManager.getLockedEOAs().length;
      const labels = { chain: this.chainId, relayer: this.poolIndex };
      metrics.gauge("relayer_mempool_size", mempoolSize, labels);
      metrics.gauge("relayer_pending_receipts", pendingReceipts, labels);
      metrics.gauge("relayer_locked_eoas", lockedEOAs, labels);
      logEvent({
        level: lockedEOAs > 0 ? "warn" : "debug",
        dependency: "internal", operation: "relayer_alarm", chain_id: this.chainId, outcome: "ok",
        relayer_index: this.poolIndex, mempool_size: mempoolSize, pending_receipts: pendingReceipts,
        locked_eoas: lockedEOAs,
      });

      // Operational-health monitor (B6). In queue transport mode the money-path state (stuck
      // mempool op, unconfirmed bundle, LOCKED_PENDING_UNKNOWN pool EOA, broadcast-failure streak,
      // underfunded EOA) lives HERE, not in the chain BundlerDO — whose own monitor reads all-zero
      // in queue mode. Without this a stuck pool EOA / backlog on a RelayerDO is invisible to the
      // operator. Index-namespaced dedup keys (poolIndex) keep the 100 relayers' alerts distinct.
      try {
        await checkOperationalHealth({
          chainId: this.chainId,
          chainName: cs.chainInfo?.name ?? null,
          poolIndex: this.poolIndex,
          oldestMempoolAgeMs: cs.mempool.oldestEntryAgeMs(),
          lockedEoaCount: lockedEOAs,
          oldestLockedAgeMs: cs.accountService.lockManager.oldestLockedAgeMs(),
          pendingReceiptCount: pendingReceipts,
          oldestPendingReceiptAgeMs: cs.bundler.oldestPendingReceiptAgeMs(),
          circuitDegraded: reliabilityHealth().circuit.degraded,
          reputationBannedSenders: cs.mempool.reputation.countPenalized("sender").banned,
          submitFailureStreak: cs.bundler.submitFailureStreak,
          lastSubmitError: cs.bundler.lastSubmitError,
          insufficientFundsEoa: cs.bundler.insufficientFundsEoa,
        }, DEFAULT_OPERATIONAL_THRESHOLDS, this.alerter);
        this.escalator.ok("relayer-operational", this.chainId);
      } catch (err) {
        console.error(`[RelayerDO:${this.chainId}#${this.poolIndex}] operational monitor error:`, err);
        await this.escalator.note("relayer-operational", this.chainId, err);
      }

      // Register with the chain DO's dead-man watch list while we hold stranded money-path state,
      // so the 5-min cron fan-out can re-arm this alarm if it dies; deregister once drained.
      this.updateChainWatch(mempoolSize > 0 || pendingReceipts > 0 || lockedEOAs > 0);

      // Idle stop: nothing queued, nothing in flight, EOA free, no KV re-asserts pending → stop
      // the alarm (flagged deliberate). A /submit re-arms instantly via the kick hook, so no op is
      // ever stranded; the kvReassert guard keeps the alarm alive until receipts are re-published.
      if (mempoolSize === 0 && pendingReceipts === 0 && lockedEOAs === 0 && this.kvReassert.size === 0) {
        this.idleCycles++;
        if (this.idleCycles >= IDLE_STOP_CYCLES) {
          const live = this.chainServices;
          const stillIdle = live !== null &&
            live.mempool.size === 0 &&
            live.bundler.pendingReceiptCount === 0 &&
            live.accountService.lockManager.getLockedEOAs().length === 0 &&
            this.kvReassert.size === 0;
          if (stillIdle) {
            this.idleCycles = 0;
            await this.state.storage.put(STORAGE_KEY_ALARM_IDLE, true);
            await this.state.storage.deleteAlarm();
          }
        }
      } else {
        this.idleCycles = 0;
      }
    } catch (err) {
      console.error(`[RelayerDO:${this.chainId}#${this.poolIndex}] alarm cycle error:`, err);
    }
  }

  private async ensureInitialized(chainId: number, index: number): Promise<void> {
    if (this.chainServices && this.chainId === chainId && this.poolIndex === index) return;
    if (this.chainServices && (this.chainId !== chainId || this.poolIndex !== index)) {
      throw new Error(`RelayerDO already initialized for ${this.chainId}#${this.poolIndex}, cannot serve ${chainId}#${index}`);
    }
    if (this.initPromise) {
      await this.initPromise;
      if (this.chainId !== chainId || this.poolIndex !== index) {
        throw new Error(`Mismatch after init: expected ${chainId}#${index}, got ${this.chainId}#${this.poolIndex}`);
      }
      return;
    }
    this.chainId = chainId;
    this.poolIndex = index;
    this.initPromise = this._init(chainId, index).catch((err) => {
      this.initPromise = null;
      this.chainId = 0;
      this.poolIndex = -1;
      throw err;
    });
    await this.initPromise;
  }

  private async _init(chainId: number, index: number): Promise<void> {
    const treasuryAddress = await deriveTreasuryAddress(this.env.OPERATOR_SECRET);
    this.config = buildConfig(this.env, treasuryAddress);

    const keyManager = new LocalKeyManager({
      operatorSecret: this.config.operatorSecret,
      oldOperatorSecrets: this.config.oldOperatorSecrets,
    });

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

    // fixedPoolIndex pins every bundle to POOL EOA #index; disableTimers → the DO alarm drives
    // reconciliation + cleanup.
    const bundler = new BundlerService(chainConfig, mempool, simulator, accountService, {
      disableTimers: true,
      fixedPoolIndex: index,
    });

    // Durable pending-receipt reconciliation (survives eviction) — identical to BundlerDO.
    bundler.setPersistPendingHook(async (persisted) => {
      if (persisted.length === 0) await this.state.storage.delete(STORAGE_KEY_PENDING_RECEIPTS);
      else await this.state.storage.put(STORAGE_KEY_PENDING_RECEIPTS, persisted);
    });
    const savedPending = await this.state.storage.get(STORAGE_KEY_PENDING_RECEIPTS);
    if (savedPending) bundler.importPendingState(savedPending as Parameters<typeof bundler.importPendingState>[0]);

    // /submit kick: an accepted op fires the alarm NOW (the alarm serializes with any run).
    bundler.setKickHook(() => this.state.storage.setAlarm(Date.now()));

    // Pool EOA can't afford its bundle → ask the CHAIN DO to fund it. This DO must NOT send
    // treasury txs itself: 100 RelayerDOs racing the treasury nonce would drop/replace each
    // other's sends, so ALL treasury top-ups funnel through the single chain-DO SponsorService
    // (runTreasuryExclusive) via /fund-eoa. Fire-and-forget; re-arm our alarm so the op
    // re-bundles once the funding tx mines. Without this, a fresh pool EOA in queue mode would
    // defer forever (the chain DO's sweep idle-stops when its own mempool is empty).
    bundler.setInsufficientFundsHook((eoa, shortfallWei) => {
      const stub = this.env.BUNDLER.get(this.env.BUNDLER.idFromName(`chain-${this.chainId}`));
      const u = `https://bundler-do/fund-eoa?chainId=${this.chainId}&address=${eoa}&shortfall=${shortfallWei.toString()}`;
      void stub.fetch(new Request(u, { method: "POST" }))
        .then(async (res) => {
          // Only fast-retry (~4s, expecting an L2 funding tx to mine) when funding is actually
          // under way. On a NON-actionable reason (treasury depleted / stuck nonce / budget
          // exhausted / not-a-vault chain), re-firing /fund-eoa every 4s just piles RPC load on an
          // already-unhealthy endpoint (100 relayers × 4s × ~7 reads) and can prolong the outage —
          // fall back to the normal alarm cadence (the alarm self-re-arms; a /submit kicks sooner).
          const body = await res.json().catch(() => null) as FundEoaResult | null;
          if (fundingUnderway(res.ok, body)) await this.state.storage.setAlarm(Date.now() + 4_000);
        })
        .catch((err: unknown) => console.warn(`[RelayerDO:${this.chainId}#${this.poolIndex}] fund-eoa request failed: ${redactError(err)}`));
    });

    // Durably persist accepted-unbundled ops (a deploy/eviction must not vanish them).
    mempool.setPersistenceHooks({
      put: (entry) => {
        void this.state.storage.put(MEMPOOL_KEY_PREFIX + entry.userOpHash, serializeMempoolEntry(entry))
          .catch((err: unknown) => console.warn(`[RelayerDO] mempool persist failed: ${redactError(err)}`));
      },
      delete: (userOpHash) => {
        void this.state.storage.delete(MEMPOOL_KEY_PREFIX + userOpHash)
          .catch((err: unknown) => console.warn(`[RelayerDO] mempool unpersist failed: ${redactError(err)}`));
      },
    });
    const savedOps = await this.state.storage.list<SerializedMempoolEntry>({ prefix: MEMPOOL_KEY_PREFIX });
    for (const [key, saved] of savedOps) {
      try {
        const entry = deserializeMempoolEntry(saved, chainConfig.entryPointAddress, chainId);
        if (!mempool.restoreEntry(entry)) await this.state.storage.delete(key);
      } catch {
        await this.state.storage.delete(key);
      }
    }

    // Durably persist terminal receipts AND publish them to USEROP_STATUS KV so the chain
    // endpoint can answer polls without fanning out to 100 DOs. The put hook is the single
    // terminal-receipt signal (confirmed, failed, TTL-evicted) — write both sinks here.
    bundler.setReceiptPersistHooks({
      put: (userOpHash, receipt, expiresAt) => {
        void this.state.storage.put(RECEIPT_KEY_PREFIX + userOpHash, { userOpHash, receipt, expiresAt })
          .catch((err: unknown) => console.warn(`[RelayerDO] receipt persist failed: ${redactError(err)}`));
        this.writeReceiptKv(userOpHash, receipt);
        // Re-assert the KV publication on the next few alarms — a single dropped put would
        // otherwise strand a confirmed op (the chain DO's poll reads only this KV).
        if (this.kvReassert.size < KV_REASSERT_MAX) {
          this.kvReassert.set(userOpHash, { receipt, remaining: KV_RECEIPT_REASSERT_ATTEMPTS });
        }
      },
      delete: (userOpHash) => {
        void this.state.storage.delete(RECEIPT_KEY_PREFIX + userOpHash)
          .catch((err: unknown) => console.warn(`[RelayerDO] receipt unpersist failed: ${redactError(err)}`));
      },
    });
    const savedReceipts = await this.state.storage.list<{ userOpHash: string; receipt: SerializedReceipt; expiresAt: number }>({ prefix: RECEIPT_KEY_PREFIX });
    if (savedReceipts.size > 0) {
      const now = Date.now();
      const expired = [...savedReceipts.entries()].filter(([, v]) => v.expiresAt <= now).map(([k]) => k);
      for (const k of expired) await this.state.storage.delete(k);
      bundler.importReceipts([...savedReceipts.values()]);
    }

    // Restore the dedup seen-set.
    const savedSeen = await this.state.storage.get<string[]>(STORAGE_KEY_SEEN);
    this.seen = new Set(Array.isArray(savedSeen) ? savedSeen : []);

    this.chainServices = { chainId, chainInfo: resolved.chain, rpcUrl: effectiveRpc, publicRpcs: resolved.publicRpcs, simulator, mempool, accountService, bundler };

    await this.state.storage.put(STORAGE_KEY_CHAIN_ID, chainId);
    await this.state.storage.put(STORAGE_KEY_POOL_INDEX, index);
    await this.state.storage.delete(STORAGE_KEY_ALARM_IDLE);
    const existing = await this.state.storage.getAlarm();
    if (!existing) await this.state.storage.setAlarm(Date.now() + this.alarmIntervalMs());

    console.log(`[RelayerDO] Initialized chain ${chainId} pool EOA #${index} (${resolved.chain?.name ?? "unknown"})`);
  }

  /** Publish (or re-publish) a terminal receipt to USEROP_STATUS KV. Fire-and-forget; the
   *  alarm re-asserts it a couple more times (kvReassert) to survive a dropped put. */
  private writeReceiptKv(userOpHash: string, receipt: SerializedReceipt): void {
    const kv = this.env.USEROP_STATUS;
    if (!kv) return;
    const status = receipt.success ? "submitted" : "failed";
    void kv.put(userOpHash, JSON.stringify({ status, receipt }), { expirationTtl: STATUS_RECEIPT_TTL_SECONDS })
      .catch((err: unknown) => console.warn(`[RelayerDO] status receipt write failed for ${userOpHash}: ${redactError(err)}`));
  }

  /** Re-assert the recent terminal-receipt KV writes (one per scheduled attempt), then drop
   *  each entry once its attempts are exhausted. Called from the alarm. */
  private drainKvReassert(): void {
    if (this.kvReassert.size === 0) return;
    for (const [hash, entry] of this.kvReassert) {
      this.writeReceiptKv(hash, entry.receipt);
      if (--entry.remaining <= 0) this.kvReassert.delete(hash);
    }
  }

  /** Register (or deregister) this pool index with the chain DO's dead-man watch list. Registered
   *  when it holds stranded money-path state so the cron fan-out probes it; deregistered when idle.
   *  Edge-triggered, with a throttled re-assert so a lost registration self-heals. */
  private updateChainWatch(stranded: boolean): void {
    const now = Date.now();
    if (stranded) {
      if (this.watchRegistered && now - this.lastWatchRegAt < WATCH_REG_REFRESH_MS) return;
      this.watchRegistered = true;
      this.lastWatchRegAt = now;
      this.chainWatchFetch("PUT");
    } else if (this.watchRegistered) {
      this.watchRegistered = false;
      this.lastWatchRegAt = 0;
      this.chainWatchFetch("DELETE");
    }
  }

  private chainWatchFetch(method: "PUT" | "DELETE"): void {
    const stub = this.env.BUNDLER.get(this.env.BUNDLER.idFromName(`chain-${this.chainId}`));
    const u = `https://bundler-do/relayer-watch?index=${this.poolIndex}`;
    void stub.fetch(new Request(u, { method }))
      .then((res) => {
        // A failed PUT means we are NOT actually registered — reset so the very next alarm re-PUTs
        // immediately instead of waiting out the 90s throttle (which would leave a stranded index
        // with no layer-2 dead-man coverage if the alarm then died).
        if (method === "PUT" && !res.ok) { this.watchRegistered = false; this.lastWatchRegAt = 0; }
      })
      .catch((err: unknown) => {
        if (method === "PUT") { this.watchRegistered = false; this.lastWatchRegAt = 0; }
        console.warn(`[RelayerDO:${this.chainId}#${this.poolIndex}] watch ${method} failed: ${redactError(err)}`);
      });
  }

  /** Persist the seen-set (bounded FIFO) — fire-and-forget. */
  private persistSeen(): void {
    let arr = [...this.seen];
    if (arr.length > SEEN_MAX) {
      arr = arr.slice(arr.length - SEEN_MAX);
      this.seen = new Set(arr);
    }
    void this.state.storage.put(STORAGE_KEY_SEEN, arr)
      .catch((err: unknown) => console.warn(`[RelayerDO] seen persist failed: ${redactError(err)}`));
  }
}
