/**
 * Entity reputation tracking for the mempool.
 * Tracks sender, factory, and paymaster reputation to enforce throttle/ban rules.
 */

export type EntityType = "sender" | "factory" | "paymaster";

export type EntityStatus = "ok" | "throttled" | "banned";

export interface ReputationEntry {
  address: `0x${string}`;
  entityType: EntityType;
  opsSeen: number;
  opsIncluded: number;
  status: EntityStatus;
  lastUpdated: number;
}

export interface ReputationConfig {
  minInclusionDenominator: number; // default 10
  throttlingSlack: number;         // default 10
  banSlack: number;                // default 50
  /**
   * Hard cap on tracked entities. `decay()` only prunes fully-decayed, >24h-stale entries
   * hourly, so a flood of distinct sender addresses (opsSeen accrues on every mempool add, not
   * just on-chain inclusion) could otherwise grow the map without bound between decays. At the
   * cap we PREFER to evict the oldest **ok** entry (no penalty to lose); only when every entry
   * is penalized do we evict the oldest overall, so the cap is always a hard bound.
   */
  maxEntries: number;              // default 50_000
}

const DEFAULT_REPUTATION_CONFIG: ReputationConfig = {
  minInclusionDenominator: 10,
  throttlingSlack: 10,
  banSlack: 50,
  maxEntries: 50_000,
};

export class ReputationManager {
  private entries: Map<string, ReputationEntry> = new Map();
  private config: ReputationConfig;

  constructor(config: Partial<ReputationConfig> = {}) {
    this.config = { ...DEFAULT_REPUTATION_CONFIG, ...config };
  }

  private key(address: `0x${string}`, entityType: EntityType): string {
    return `${entityType}:${address.toLowerCase()}`;
  }

  private getOrCreate(address: `0x${string}`, entityType: EntityType): ReputationEntry {
    const k = this.key(address, entityType);
    let entry = this.entries.get(k);
    if (!entry) {
      entry = {
        address: address.toLowerCase() as `0x${string}`,
        entityType,
        opsSeen: 0,
        opsIncluded: 0,
        status: "ok",
        lastUpdated: Date.now(),
      };
      this.evictIfNeeded();
      this.entries.set(k, entry);
    }
    return entry;
  }

  /** At capacity, evict one entry so size can never exceed maxEntries (a HARD cap). Prefer the
   *  oldest "ok" entry — it carries no penalty to lose. Only if EVERY entry is penalized (an
   *  attack flood of distinct throttled/banned senders) do we evict the oldest overall, trading
   *  one stale penalty reset for a guaranteed memory bound. */
  private evictIfNeeded(): void {
    if (this.entries.size < this.config.maxEntries) return;
    let oldestOkKey: string | undefined;
    let oldestOkTime = Infinity;
    let oldestAnyKey: string | undefined;
    let oldestAnyTime = Infinity;
    for (const [key, e] of this.entries) {
      if (e.lastUpdated < oldestAnyTime) {
        oldestAnyTime = e.lastUpdated;
        oldestAnyKey = key;
      }
      if (e.status === "ok" && e.lastUpdated < oldestOkTime) {
        oldestOkTime = e.lastUpdated;
        oldestOkKey = key;
      }
    }
    const victim = oldestOkKey ?? oldestAnyKey;
    if (victim !== undefined) this.entries.delete(victim);
  }

  /**
   * Record that a UserOp from this entity was seen (added to mempool).
   */
  updateSeen(address: `0x${string}`, entityType: EntityType): void {
    const entry = this.getOrCreate(address, entityType);
    entry.opsSeen++;
    entry.lastUpdated = Date.now();
    this.updateStatus(entry);
  }

  /**
   * Record that a UserOp from this entity was included on-chain.
   */
  updateIncluded(address: `0x${string}`, entityType: EntityType): void {
    const entry = this.getOrCreate(address, entityType);
    entry.opsIncluded++;
    entry.lastUpdated = Date.now();
    this.updateStatus(entry);
  }

  /**
   * Penalize entity (e.g., failed simulation after mempool).
   */
  penalize(address: `0x${string}`, entityType: EntityType): void {
    const entry = this.getOrCreate(address, entityType);
    entry.opsSeen += 10;
    entry.lastUpdated = Date.now();
    this.updateStatus(entry);
  }

  /**
   * Get entity status.
   */
  getStatus(address: `0x${string}`, entityType: EntityType): EntityStatus {
    const entry = this.getOrCreate(address, entityType);
    return entry.status;
  }

  /**
   * Check if entity is allowed (not banned or throttled).
   */
  isAllowed(address: `0x${string}`, entityType: EntityType): boolean {
    return this.getStatus(address, entityType) === "ok";
  }

  /**
   * Check if entity is throttled (may have limited operations in mempool).
   */
  isThrottled(address: `0x${string}`, entityType: EntityType): boolean {
    return this.getStatus(address, entityType) === "throttled";
  }

  /**
   * Check if entity is banned.
   */
  isBanned(address: `0x${string}`, entityType: EntityType): boolean {
    return this.getStatus(address, entityType) === "banned";
  }

  private updateStatus(entry: ReputationEntry): void {
    const maxSeen = entry.opsIncluded * this.config.minInclusionDenominator +
      this.config.throttlingSlack;
    const maxSeenBan = entry.opsIncluded * this.config.minInclusionDenominator +
      this.config.banSlack;

    if (entry.opsSeen > maxSeenBan) {
      entry.status = "banned";
    } else if (entry.opsSeen > maxSeen) {
      entry.status = "throttled";
    } else {
      entry.status = "ok";
    }
  }

  /**
   * Force-set reputation for an entity (debug RPC).
   */
  setReputation(
    address: `0x${string}`,
    entityType: EntityType,
    opsSeen: number,
    opsIncluded: number,
    status?: EntityStatus,
  ): void {
    const entry = this.getOrCreate(address, entityType);
    entry.opsSeen = opsSeen;
    entry.opsIncluded = opsIncluded;
    entry.lastUpdated = Date.now();
    if (status) {
      entry.status = status;
    } else {
      this.updateStatus(entry);
    }
  }

  /**
   * Dump all reputation entries.
   */
  dump(): ReputationEntry[] {
    return Array.from(this.entries.values());
  }

  /** Count entities of `entityType` currently in a penalized status. Feeds the operational
   *  monitor's "a user's ops keep failing" alert (senders are no longer hard-banned, but a
   *  banned/throttled sender still signals repeated failures worth an operator's attention). */
  countPenalized(entityType: EntityType): { throttled: number; banned: number } {
    let throttled = 0;
    let banned = 0;
    for (const e of this.entries.values()) {
      if (e.entityType !== entityType) continue;
      if (e.status === "banned") banned++;
      else if (e.status === "throttled") throttled++;
    }
    return { throttled, banned };
  }

  /**
   * Clear all reputation data.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Hourly decay: reduce opsSeen by half to allow entities to recover.
   * Also prunes entries that have decayed to zero and are stale (>24h).
   */
  decay(): void {
    const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, entry] of this.entries) {
      entry.opsSeen = Math.floor(entry.opsSeen / 2);
      entry.opsIncluded = Math.floor(entry.opsIncluded / 2);
      this.updateStatus(entry);
      // Remove fully-decayed, stale entries to prevent unbounded growth
      if (entry.opsSeen === 0 && entry.opsIncluded === 0 && entry.lastUpdated < staleThreshold) {
        this.entries.delete(key);
      }
    }
  }
}
