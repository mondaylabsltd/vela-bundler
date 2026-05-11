/**
 * Per-chain service registry.
 *
 * Each chainId gets its own set of services (simulator, mempool, accountService,
 * bundler), lazily created on first request and cached for reuse.
 *
 * Chain metadata and RPC URLs are resolved from the registry on first access.
 */

import { resolveChain, type ChainInfo } from "../config/chain-registry.ts";
import { createSimulator, type Simulator } from "../simulation/index.ts";
import { Mempool } from "../mempool/index.ts";
import { AccountService } from "../account/index.ts";
import { BundlerService } from "../bundler/index.ts";
import type { KeyManager } from "../keys/types.ts";
import type { BundlerConfig } from "../config/index.ts";
import { resolveRpcUrl } from "../utils/rpc-client.ts";

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
 * Per-chain config — inherits global config but overrides chain-specific fields.
 */
function makeChainConfig(
  globalConfig: BundlerConfig,
  chainId: number,
  rpcUrl: string,
  publicRpcs: string[],
  chainInfo: ChainInfo | null,
): BundlerConfig {
  return {
    ...globalConfig,
    chainId,
    rpcUrl,
    publicRpcs,
    chainInfo,
  };
}

export class ChainRegistry {
  private chains: Map<number, ChainServices> = new Map();
  private initLocks: Map<number, Promise<ChainServices>> = new Map();

  constructor(
    private readonly globalConfig: BundlerConfig,
    private readonly keyManager: KeyManager,
  ) {}

  /**
   * Get or create services for a chainId.
   * Thread-safe: concurrent calls for the same chainId share one init.
   */
  async getChain(chainId: number, requestRpcUrl?: string): Promise<ChainServices> {
    const existing = this.chains.get(chainId);
    if (existing) return existing;

    // Prevent concurrent init for the same chainId
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
    // Resolve chain from registry
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
        // User provided their own RPC — registry failure is OK
        rpcUrl = requestRpcUrl;
        console.warn(`[ChainRegistry] Registry failed for chainId ${chainId}, using user RPC`);
      } else {
        throw err;
      }
    }

    // User RPC override takes priority
    if (requestRpcUrl) {
      rpcUrl = requestRpcUrl;
    }

    // Apply global user RPC overrides
    const effectiveRpc = resolveRpcUrl(
      { ...this.globalConfig, rpcUrl, publicRpcs } as BundlerConfig,
    );

    const chainConfig = makeChainConfig(
      this.globalConfig,
      chainId,
      effectiveRpc,
      publicRpcs,
      chainInfo,
    );

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
   * Get all currently initialized chains.
   */
  getAll(): ChainServices[] {
    return Array.from(this.chains.values());
  }

  /**
   * Check if a chain is already initialized.
   */
  has(chainId: number): boolean {
    return this.chains.has(chainId);
  }
}
