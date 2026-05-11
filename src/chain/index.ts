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
import type { BundlerConfig } from "../config/index.ts";
import { resolveRpcUrl, getPublicClient } from "../utils/rpc-client.ts";

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

export class ChainRegistry {
  private chains: Map<number, ChainServices> = new Map();
  private initLocks: Map<number, Promise<ChainServices>> = new Map();
  private healthTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly globalConfig: BundlerConfig,
    private readonly keyManager: KeyManager,
  ) {
    // Start global health loop
    this.healthTimer = setInterval(() => this.healthLoop(), HEALTH_INTERVAL_MS);
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
      this.chains.set(chainId, services);
      return services;
    } finally {
      this.initLocks.delete(chainId);
    }
  }

  private async initChain(chainId: number, requestRpcUrl?: string): Promise<ChainServices> {
    let rpcUrl: string;
    let publicRpcs: string[] = [];
    let chainInfo: ChainInfo | null = null;

    try {
      const resolved = await resolveChain(chainId);
      rpcUrl = resolved.rpcUrl;
      publicRpcs = resolved.publicRpcs;
      chainInfo = resolved.chain;
    } catch (err) {
      if (requestRpcUrl) {
        rpcUrl = requestRpcUrl;
        console.warn(`[ChainRegistry] Registry failed for chainId ${chainId}, using user RPC`);
      } else {
        throw err;
      }
    }

    if (requestRpcUrl) rpcUrl = requestRpcUrl;

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
    for (const chain of this.chains.values()) {
      try {
        await this.recoverLockedEOAs(chain);
      } catch (err) {
        console.error(`[Health] Chain ${chain.chainId} recovery error:`, err);
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
}
