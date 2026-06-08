/**
 * RPC URL blacklist with auto-expiry.
 *
 * When a user-provided RPC (X-Rpc-Url) fails with a non-transient error
 * (e.g. 429 rate-limited), it is blacklisted for a cooldown period.
 * On subsequent requests the blacklisted URL is skipped in favour of
 * the chain's own RPC (Alchemy / public) — but ONLY when the chain
 * actually has an alternative.  For dev networks where the client URL
 * is the only RPC, the blacklist is ignored.
 */

const BLACKLIST_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const BLACKLIST_MAX_SIZE = 200;

/** url → expiry timestamp (ms) */
const blacklist = new Map<string, number>();

/**
 * Add a URL to the blacklist for 10 minutes.
 */
export function blacklistRpc(url: string): void {
  // Evict expired entries if at capacity to prevent unbounded growth
  if (blacklist.size >= BLACKLIST_MAX_SIZE) {
    const now = Date.now();
    for (const [key, expiry] of blacklist) {
      if (now > expiry) blacklist.delete(key);
    }
    // If still at capacity after pruning, evict oldest
    if (blacklist.size >= BLACKLIST_MAX_SIZE) {
      const oldest = blacklist.keys().next().value;
      if (oldest !== undefined) blacklist.delete(oldest);
    }
  }
  blacklist.set(url, Date.now() + BLACKLIST_DURATION_MS);
  console.warn(`[RPC Blacklist] Blacklisted ${url} for 10 minutes`);
}

/**
 * Check if a URL is currently blacklisted.
 */
export function isRpcBlacklisted(url: string): boolean {
  const expiry = blacklist.get(url);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    blacklist.delete(url);
    return false;
  }
  return true;
}

/**
 * Determine whether a user-provided rpcOverride has a viable fallback.
 * Returns true when the chain's own RPC is different from the override,
 * meaning we can safely blacklist the override and retry with the chain default.
 */
export function hasFallback(rpcOverride: string, chainDefaultRpc: string): boolean {
  return chainDefaultRpc !== rpcOverride;
}
