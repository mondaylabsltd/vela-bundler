/**
 * Per-chain service registry with auto-recovery.
 *
 * Each chainId gets its own services, lazily created on first request.
 * Includes periodic health loop that:
 * - Recovers LOCKED_PENDING_UNKNOWN EOAs by re-checking nonce state
 * - Runs reputation decay
 */

import { resolveChain, type ChainInfo } from "../config/chain-registry.ts";
import { createSimulator, type Simulator } from "../simulation/index.ts";
import { Mempool } from "../mempool/index.ts";
import { AccountService } from "../account/index.ts";
import { BundlerService } from "../bundler/index.ts";
import type { KeyManager } from "../keys/types.ts";
import type { BundlerConfig } from "../config/types.ts";
import { resolveRpcUrl, getPublicClient } from "../utils/rpc-client.ts";
import { withTimeout } from "../utils/timeout.ts";
import { createAlerter, type Alerter } from "../monitoring/telegram.ts";
import { checkTreasuryBalance } from "../monitoring/treasury.ts";
import {
  checkOperationalHealth,
  DEFAULT_OPERATIONAL_THRESHOLDS,
  maybeSendAliveHeartbeat,
} from "../monitoring/operational.ts";
import { RepeatedErrorEscalator } from "../monitoring/escalation.ts";
import { reliabilityHealth } from "../reliability/rpc-fetch.ts";

export interface ChainServices {
  chainId: number;
  chainInfo: ChainInfo | null;
  rpcUrl: string;
  publicRpcs: string[];
  simulator: Simulator;
  mempool: Mempool;
  accountService: AccountService;
  bundler: BundlerService;
}

/**
 * Minimal interface for chain service resolution.
 * Both ChainRegistry (Deno) and SingleChainAdapter (CF Worker) implement this.
 */
export interface ChainRegistryLike {
  getChain(chainId: number, requestRpcUrl?: string): Promise<ChainServices>;
  getAll(): ChainServices[];
}

function makeChainConfig(
  globalConfig: BundlerConfig,
  chainId: number,
  rpcUrl: string,
  publicRpcs: string[],
  chainInfo: ChainInfo | null,
): BundlerConfig {
  return { ...globalConfig, chainId, rpcUrl, publicRpcs, chainInfo };
}

/** Health loop interval — 30 seconds. */
const HEALTH_INTERVAL_MS = 30_000;

/** Reputation decay interval — 1 hour (in ms). */
const REPUTATION_DECAY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Max distinct chains retained. Each cached chain holds a mempool, account service, cached
 * RPC client and TWO live setInterval timers (auto-bundle + receipt cleanup). Without a cap,
 * an unauthenticated flood of bogus `POST /<chainId>` requests carrying a syntactically valid
 * X-Rpc-Url (which resolveChain can't resolve, so it is cached under the user RPC) grows this
 * map and the process timer count without bound → memory/CPU exhaustion of the fund-custody
 * process. A real deployment serves a small, fixed set of chains, so this ceiling is generous;
 * eviction only ever drops an IDLE chain (empty mempool, no pending receipts, no locked EOAs),
 * whose state is losslessly re-derived from chain on next use.
 */
const MAX_CHAINS = 256;

export class ChainRegistry {
  private chains: Map<number, ChainServices> = new Map();
  private initLocks: Map<number, Promise<ChainServices>> = new Map();
  private healthTimer?: ReturnType<typeof setInterval>;
  private lastDecayAt: number = Date.now();
  private lastHeartbeatAt: number = Date.now();
  private readonly alerter: Alerter;
  /** Repeated-exception escalation: the SAME phase failing N consecutive cycles is a code
   *  bug / dead dependency and must reach Telegram, not just the console. */
  private readonly escalator: RepeatedErrorEscalator;

  constructor(
    private readonly globalConfig: BundlerConfig,
    private readonly keyManager: KeyManager,
    alerter?: Alerter,
  ) {
    // Telegram alerter (no-op unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are configured).
    // Injectable so the process-level alerter (deno/main.ts) shares one dedup map.
    this.alerter = alerter ?? createAlerter(globalConfig);
    this.escalator = new RepeatedErrorEscalator(this.alerter);
    // Start global health loop
    this.healthTimer = setInterval(() => this.healthLoop(), HEALTH_INTERVAL_MS);
  }

  /** Whether alerts actually deliver (surfaced in /health — see telegram.ts). */
  get alertingEnabled(): boolean {
    return this.alerter.enabled;
  }

  /**
   * Get or create services for a chainId.
   */
  async getChain(chainId: number, requestRpcUrl?: string): Promise<ChainServices> {
    const existing = this.chains.get(chainId);
    if (existing) return existing;

    const pending = this.initLocks.get(chainId);
    if (pending) return await pending;

    const initPromise = this.initChain(chainId, requestRpcUrl);
    this.initLocks.set(chainId, initPromise);
    try {
      const services = await initPromise;
      this.evictIdleChainIfNeeded(chainId);
      this.chains.set(chainId, services);
      return services;
    } finally {
      this.initLocks.delete(chainId);
    }
  }

  /** True if a chain carries no in-flight work and can be evicted without losing custody state. */
  private isChainIdle(chain: ChainServices): boolean {
    return (
      chain.mempool.size === 0 &&
      chain.bundler.pendingReceiptCount === 0 &&
      chain.accountService.lockManager.getLockedEOAs().length === 0
    );
  }

  /**
   * Before caching a new chain, if we are at capacity evict the oldest IDLE chain (Map iterates
   * in insertion order) and dispose its timers. A busy chain (pending bundle/receipt/locked EOA)
   * is never evicted — that would risk abandoning an in-flight settlement. If every chain is
   * busy we keep them all and log; this is bounded in practice because a busy chain requires
   * real on-chain activity (gas + balance) that a flood of bogus chainIds cannot manufacture.
   */
  private evictIdleChainIfNeeded(incomingChainId: number): void {
    if (this.chains.size < MAX_CHAINS || this.chains.has(incomingChainId)) return;
    for (const [id, chain] of this.chains) {
      if (this.isChainIdle(chain)) {
        chain.bundler.dispose();
        this.chains.delete(id);
        console.warn(`[ChainRegistry] Evicted idle chain ${id} at capacity (${MAX_CHAINS}).`);
        return;
      }
    }
    console.warn(
      `[ChainRegistry] At capacity (${MAX_CHAINS}) with no idle chain to evict — possible resource pressure or chainId flood.`,
    );
  }

  private async initChain(chainId: number, requestRpcUrl?: string): Promise<ChainServices> {
    let rpcUrl: string;
    let publicRpcs: string[] = [];
    let chainInfo: ChainInfo | null = null;

    // Always resolve via registry (Alchemy preferred) for the chain's default RPC.
    // The user-provided requestRpcUrl is only for per-request overrides, not for
    // the chain's permanent default — otherwise Alchemy would never be used when
    // the first request carries X-Rpc-Url.
    try {
      const resolved = await resolveChain(chainId, this.globalConfig.alchemyApiKey);
      rpcUrl = resolved.rpcUrl;
      publicRpcs = resolved.publicRpcs;
      chainInfo = resolved.chain;
    } catch (err) {
      // Registry resolution failed — if user provided an RPC, use it as last resort.
      if (requestRpcUrl) {
        rpcUrl = requestRpcUrl;
        try {
          const { fetchChainInfo } = await import("../config/chain-registry.ts");
          chainInfo = await fetchChainInfo(chainId);
        } catch {
          // Metadata fetch failed — not critical.
        }
      } else {
        throw err;
      }
    }

    const effectiveRpc = resolveRpcUrl({ rpcUrl });

    const chainConfig = makeChainConfig(this.globalConfig, chainId, effectiveRpc, publicRpcs, chainInfo);
    const simulator = createSimulator(chainConfig);

    const mempool = new Mempool({
      entryPointAddress: chainConfig.entryPointAddress,
      chainId,
      maxMempoolSize: 4096,
      stakedSenderMaxOps: 4,
    });

    const accountService = new AccountService({
      keyManager: this.keyManager,
      config: chainConfig,
      balanceReserveMultiplier: chainConfig.balanceReserveMultiplier,
    });

    const bundler = new BundlerService(chainConfig, mempool, simulator, accountService);
    bundler.startAutoBundling();

    console.log(
      `[ChainRegistry] Initialized chainId ${chainId} (${chainInfo?.name ?? "unknown"}) — RPC: ${effectiveRpc}`,
    );

    return { chainId, chainInfo, rpcUrl: effectiveRpc, publicRpcs, simulator, mempool, accountService, bundler };
  }

  /**
   * Periodic health loop — runs every 30s across all initialized chains.
   * - Recovers locked EOAs by re-checking on-chain nonce state.
   * - Decays reputation hourly.
   */
  private async healthLoop(): Promise<void> {
    // Overlap guard: the loop is driven by setInterval, which does NOT wait for the async callback.
    // Under RPC degradation one cycle (reconcile + recover + monitors, each with 5s RPC timeouts,
    // across many chains) can exceed the interval; without this guard a second cycle would start and
    // stack concurrent RPC work + risk racing the per-chain reconciler. Skip if one is still running.
    if (this._healthRunning) return;
    this._healthRunning = true;
    try {
      await this._healthLoopBody();
    } finally {
      this._healthRunning = false;
    }
  }
  private _healthRunning = false;

  private async _healthLoopBody(): Promise<void> {
    const now = Date.now();
    const shouldDecay = now - this.lastDecayAt >= REPUTATION_DECAY_INTERVAL_MS;

    // Chains run CONCURRENTLY with a generous per-chain wall cap: one degraded chain's RPC
    // stalls must not delay other chains' reconciliation, EOA recovery, or ALERTS (the old
    // serialized loop made the alerting system itself non-live under a single bad chain).
    // Inner awaits are individually 5–15.5s bounded, so 60s only trips on pathology; the
    // per-chain sections keep their own try/catch and the reconciler its reentrancy guard.
    await Promise.allSettled(
      [...this.chains.values()].map((chain) =>
        withTimeout(this.perChainHealth(chain, shouldDecay), 60_000, `health-chain-${chain.chainId}`)
          .catch((err) => console.error(`[Health] Chain ${chain.chainId} cycle error:`, err)),
      ),
    );

    if (shouldDecay) {
      this.lastDecayAt = now;
    }

    // Alive heartbeat (dead-man switch, in-process layer): periodic "alive" so SILENCE on
    // the Telegram channel means the bundler is down. Runs after the chain work so the
    // stats reflect this cycle.
    try {
      let mempoolSize = 0, locked = 0, pending = 0;
      for (const c of this.chains.values()) {
        mempoolSize += c.mempool.size;
        locked += c.accountService.lockManager.getLockedEOAs().length;
        pending += c.bundler.pendingReceiptCount;
      }
      this.lastHeartbeatAt = await maybeSendAliveHeartbeat({
        alerter: this.alerter,
        lastSentAt: this.lastHeartbeatAt,
        runtime: "deno",
        stats: `${this.chains.size} chain(s), mempool ${mempoolSize}, locked EOAs ${locked}, pending receipts ${pending}`,
      });
    } catch (err) {
      console.error(`[Health] heartbeat error:`, err);
    }
  }

  /** One chain's health-cycle work. Every section reports to the escalator: transient noise
   *  stays in the console, but the SAME section failing 3 consecutive cycles pages via
   *  Telegram (a code bug or a dead dependency — developer intervention by definition). */
  private async perChainHealth(chain: ChainServices, shouldDecay: boolean): Promise<void> {
    // Durable reconciliation of in-flight bundles (unified with the Worker DO alarm): poll
    // pending receipts, capture them, release reservations, and recover the EOA. Runs BEFORE
    // recoverLockedEOAs so a just-confirmed bundle unlocks its EOA here rather than being chased
    // by the nonce-based recovery.
    try {
      await chain.bundler.checkPendingReceipts();
      this.escalator.ok("reconcile", chain.chainId);
    } catch (err) {
      console.error(`[Health] Chain ${chain.chainId} pending-receipt reconcile error:`, err);
      await this.escalator.note("reconcile", chain.chainId, err);
    }

    try {
      await this.recoverLockedEOAs(chain);
      this.escalator.ok("eoa-recovery", chain.chainId);
    } catch (err) {
      console.error(`[Health] Chain ${chain.chainId} recovery error:`, err);
      await this.escalator.note("eoa-recovery", chain.chainId, err);
    }

    // Treasury-balance monitor (deduped Telegram alert when low). No-op alerter if unconfigured.
    try {
      await checkTreasuryBalance({
        chainId: chain.chainId,
        chainName: chain.chainInfo?.name ?? null,
        treasuryAddress: this.globalConfig.treasuryAddress,
        client: getPublicClient(chain.rpcUrl),
        thresholdWei: this.globalConfig.treasuryAlertThresholdWei,
        thresholdPathUsd: this.globalConfig.treasuryAlertThresholdPathUsd,
        alerter: this.alerter,
      });
      this.escalator.ok("treasury-monitor", chain.chainId);
    } catch (err) {
      console.error(`[Health] Chain ${chain.chainId} treasury monitor error:`, err);
      await this.escalator.note("treasury-monitor", chain.chainId, err);
    }

    // Operational-health monitor: alert on any STUCK condition where a user's money can't move
    // (stuck mempool op / unconfirmed bundle / locked EOA / repeated broadcast failure /
    // underfunded EOA / degraded RPC). No-op if unconfigured.
    try {
      await checkOperationalHealth({
        chainId: chain.chainId,
        chainName: chain.chainInfo?.name ?? null,
        oldestMempoolAgeMs: chain.mempool.oldestEntryAgeMs(),
        lockedEoaCount: chain.accountService.lockManager.getLockedEOAs().length,
        oldestLockedAgeMs: chain.accountService.lockManager.oldestLockedAgeMs(),
        pendingReceiptCount: chain.bundler.pendingReceiptCount,
        oldestPendingReceiptAgeMs: chain.bundler.oldestPendingReceiptAgeMs(),
        circuitDegraded: reliabilityHealth().circuit.degraded,
        reputationBannedSenders: chain.mempool.reputation.countPenalized("sender").banned,
        submitFailureStreak: chain.bundler.submitFailureStreak,
        lastSubmitError: chain.bundler.lastSubmitError,
        insufficientFundsEoa: chain.bundler.insufficientFundsEoa,
      }, DEFAULT_OPERATIONAL_THRESHOLDS, this.alerter);
      this.escalator.ok("operational-monitor", chain.chainId);
    } catch (err) {
      console.error(`[Health] Chain ${chain.chainId} operational monitor error:`, err);
      await this.escalator.note("operational-monitor", chain.chainId, err);
    }

    // Hourly reputation decay
    if (shouldDecay) {
      try {
        chain.mempool.reputation.decay();
      } catch (err) {
        console.error(`[Health] Chain ${chain.chainId} reputation decay error:`, err);
      }
    }
  }

  /**
   * Try to recover all LOCKED_PENDING_UNKNOWN EOAs for a chain.
   */
  private async recoverLockedEOAs(chain: ChainServices): Promise<void> {
    const locked = chain.accountService.lockManager.getLockedEOAs();
    if (locked.length === 0) return;

    const client = getPublicClient(chain.rpcUrl);
    let recovered = 0;

    for (const eoa of locked) {
      try {
        const ok = await chain.accountService.lockManager.tryRecoverEOA(eoa.address, client);
        if (ok) {
          recovered++;
          console.log(`[Health] Recovered EOA ${eoa.address} on chain ${chain.chainId}`);
        }
      } catch {
        // RPC error — skip this EOA, try again next cycle
      }
    }

    if (locked.length > 0 && recovered < locked.length) {
      console.log(
        `[Health] Chain ${chain.chainId}: ${recovered}/${locked.length} locked EOAs recovered`,
      );
    }
  }

  getAll(): ChainServices[] {
    return Array.from(this.chains.values());
  }

  has(chainId: number): boolean {
    return this.chains.has(chainId);
  }

  /**
   * Release all timers: the global health loop and every chain's bundler timers (auto-bundle
   * + receipt cleanup). Called on graceful shutdown so no new bundle is started while the
   * process is draining. In-flight on-chain txs are unaffected (recovered from chain nonce on
   * the next start — see the "conservative restart" invariant). Safe to call more than once.
   */
  dispose(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    for (const chain of this.chains.values()) {
      chain.bundler.dispose();
    }
  }
}
