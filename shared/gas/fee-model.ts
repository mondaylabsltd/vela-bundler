/**
 * Fee model — the single source of truth for the bundler's pricing math.
 *
 * Economic model (private prepaid bundler):
 *   networkPrice = max(baseFee + tip, eth_gasPrice)        // real on-chain cost / gas
 *   userPrice    = networkPrice × markup                   // what the user is quoted & signs
 *   The wallet signs maxFeePerGas == maxPriorityFeePerGas == userPrice, so the EntryPoint
 *   charges the account EXACTLY `userPrice` per gas for ANY base fee
 *   (min(maxFee, baseFee + maxPriority) == userPrice). The bundler EOA is the beneficiary,
 *   so REVENUE per gas == userPrice — a constant, independent of base-fee volatility.
 *
 * The bundler then submits the outer `handleOps` tx. Its COST per gas is
 * `min(outerMaxFee, baseFee_at_inclusion + outerPriority)`. Two invariants must hold:
 *
 *   (I1 — never a guaranteed loss) outerMaxFee ≤ userPrice. Then even if the base fee
 *        spikes all the way to outerMaxFee by inclusion, cost ≤ userPrice == revenue, i.e.
 *        worst case break-even. The bundler can never be forced to pay more than it earns.
 *
 *   (I2 — reliable inclusion) outerMaxFee must sit ABOVE the current base fee by a real
 *        margin, because base fee can rise up to 12.5% per block. With only `tip` of
 *        headroom (the previous behaviour) a bundle gets stuck after ~1 block of rising
 *        gas. We give explicit head-room (default 2×) — bounded by I1.
 *
 * Together: outerMaxFee = clamp(baseFee × headroom + priority, [baseFee + priority, userPrice]).
 * During an extreme spike the worst outcome is break-even (tx still lands), never a loss
 * and never a stranded user tx — strictly better than the old "strand it" behaviour.
 *
 * All math is bigint + integer-only and rounds in the bundler's favour where it matters
 * (see ceilDiv). Pure and fully unit-tested in tests/fee_model_test.ts.
 */

/** Markup is expressed in basis points (10000 = 1.0×). Keep ONE scale everywhere. */
export const MARKUP_BPS_SCALE = 10_000n;

/** Convert a float markup (e.g. 2.0) to integer bps (20000). */
export function markupToBps(markup: number): bigint {
  return BigInt(Math.round(markup * 10_000));
}

/**
 * userPrice = floor(networkPrice × markupBps / 10000).
 * Rounded DOWN so the user is never overcharged by sub-wei rounding.
 */
export function applyMarkup(networkPrice: bigint, markupBps: bigint): bigint {
  if (markupBps <= 0n) return networkPrice;
  return (networkPrice * markupBps) / MARKUP_BPS_SCALE;
}

/**
 * Inverse of applyMarkup: networkPrice ≈ floor(userPrice × 10000 / markupBps).
 * Rounded DOWN so the derived target outer price is conservative (the bundler aims to pay
 * a hair less tip, never more). The hard no-loss guarantee does NOT rely on this — it
 * relies on the exact signed `userPrice` cap (see computeOuterGas.revenueCapPerGas).
 */
export function reverseMarkup(userPrice: bigint, markupBps: bigint): bigint {
  if (markupBps <= 0n) return userPrice;
  return (userPrice * MARKUP_BPS_SCALE) / markupBps;
}

/** Ceiling division for non-negative bigints — round a COST/requirement UP. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) return a;
  return (a + b - 1n) / b;
}

export interface OuterGasInput {
  /**
   * Per-gas revenue cap == the price the EntryPoint refunds the bundler == the (minimum,
   * across the bundle) signed userPrice. outerMaxFee is clamped at or below this so the
   * bundler can never be forced into a loss (invariant I1).
   */
  revenueCapPerGas: bigint;
  /** Fresh base fee at submission time. */
  baseFee: bigint;
  /**
   * Target outer price derived from the user's signed price (reverseMarkup(userPrice)).
   * Used as a lower bound on maxFee so a healthy margin is preserved in the calm case.
   */
  intendedGasPrice: bigint;
  /** Chain-suggested priority tip (eth_maxPriorityFeePerGas); a floor on outer priority. */
  chainTip: bigint;
  /** Operator-configured minimum priority (wei). */
  minPriorityFee?: bigint;
  /** Base-fee head-room numerator/denominator (default 2/1 ⇒ tolerate base fee doubling). */
  headroomNum?: bigint;
  headroomDen?: bigint;
}

export interface OuterGas {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Expected cost basis for the profitability gate = baseFee + priority. */
  effectiveGasPrice: bigint;
}

/** Default base-fee head-room: 2× ⇒ a bundle survives the base fee roughly doubling. */
export const DEFAULT_HEADROOM_NUM = 2n;
export const DEFAULT_HEADROOM_DEN = 1n;

/**
 * Compute the outer (handleOps) tx gas pricing with provable invariants I1 (no loss) and
 * I2 (inclusion head-room). See module docs.
 *
 * - priority = max(intendedGasPrice − baseFee, chainTip, minPriorityFee)  (≥ 0)
 * - effective (expected cost) = baseFee + priority
 * - maxFee = clamp(baseFee × headroom + priority, lower = baseFee + priority,
 *                  upper = revenueCapPerGas)
 *
 * If the op is profitable (effective ≤ revenueCap) then maxFee ∈ [effective, revenueCap]
 * — includable now AND head-room up to break-even. If effective > revenueCap the op is
 * unprofitable; maxFee is pinned at revenueCap and the CALLER's profitability gate rejects
 * it (this function never decides profitability — it only prices safely).
 */
export function computeOuterGas(input: OuterGasInput): OuterGas {
  const {
    revenueCapPerGas, baseFee, intendedGasPrice, chainTip,
    minPriorityFee = 0n,
    headroomNum = DEFAULT_HEADROOM_NUM,
    headroomDen = DEFAULT_HEADROOM_DEN,
  } = input;

  // Priority tip: enough to express the user's intended speed, but never below the chain's
  // suggested tip or the configured minimum (so nodes don't reject for too-low gas price).
  let priority = intendedGasPrice > baseFee ? intendedGasPrice - baseFee : 0n;
  if (priority < chainTip) priority = chainTip;
  if (priority < minPriorityFee) priority = minPriorityFee;

  // Expected cost basis for the profitability gate — uses the INTENDED priority (incl.
  // chain/min floors) even if that exceeds revenue, so the gate correctly sees an
  // unprofitable op and rejects it.
  const effectiveGasPrice = baseFee + priority;

  // Desired cap with base-fee head-room for inclusion when base fee rises post-submit.
  let maxFeePerGas = (baseFee * headroomNum) / headroomDen + priority;
  // Lower bound: must at least cover the current base fee + our priority to include now.
  if (maxFeePerGas < effectiveGasPrice) maxFeePerGas = effectiveGasPrice;
  // Upper bound (I1): never exceed break-even, so a base-fee spike to maxFee is at worst
  // a break-even tx, never a loss.
  if (maxFeePerGas > revenueCapPerGas) maxFeePerGas = revenueCapPerGas;

  // EIP-1559 validity: maxPriorityFeePerGas must be ≤ maxFeePerGas. This can only bind in
  // the pathological case where a chain/min priority floor pushes priority above the
  // break-even cap — those ops are unprofitable and rejected by the caller's gate, but we
  // clamp here so computeOuterGas ALWAYS returns a structurally valid fee pair (defense in
  // depth — tx validity must not depend on a distant gate).
  const maxPriorityFeePerGas = priority > maxFeePerGas ? maxFeePerGas : priority;

  return { maxFeePerGas, maxPriorityFeePerGas, effectiveGasPrice };
}
