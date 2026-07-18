/**
 * Settlement-vault flag resolution (Stage 2 of docs/pool-queue-architecture.md).
 *
 * `SETTLEMENT_VAULT_ENABLED` is a per-chain canary spec, not a global switch:
 *   ""                → disabled everywhere (default)
 *   "true" | "all"    → enabled on every chain
 *   "4217,8453"       → enabled only on the listed chainIds
 *
 * Resolved by this pure helper at each consumer site (bundle gate, quote
 * endpoint, /v1/account, top-up loop) from the RAW spec string, because the CF
 * worker hands some consumers the global config and others a per-chain one —
 * a pre-resolved boolean would silently mean different things in each.
 */
export function chainSpecEnables(
  spec: string | undefined,
  chainId: number,
): boolean {
  const s = (spec ?? "").trim().toLowerCase();
  if (!s || s === "false") return false;
  if (s === "true" || s === "all") return true;
  return s
    .split(",")
    .map((part) => part.trim())
    .some((part) => part !== "" && /^\d+$/.test(part) && Number(part) === chainId);
}

/** The vault canary's spec resolution — same grammar, kept as a named alias so
 *  call sites read as what they gate. INBAND_ENABLED reuses chainSpecEnables. */
export const settlementVaultEnabledFor = chainSpecEnables;
