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
}

const DEFAULT_REPUTATION_CONFIG: ReputationConfig = {
  minInclusionDenominator: 10,
  throttlingSlack: 10,
  banSlack: 50,
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
      this.entries.set(k, entry);
    }
    return entry;
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

  /**
   * Clear all reputation data.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Hourly decay: reduce opsSeen by half to allow entities to recover.
   */
  decay(): void {
    for (const entry of this.entries.values()) {
      entry.opsSeen = Math.floor(entry.opsSeen / 2);
      entry.opsIncluded = Math.floor(entry.opsIncluded / 2);
      this.updateStatus(entry);
    }
  }
}
