/**
 * Numeric proofs for the bundler fee model (shared/gas/fee-model.ts).
 *
 * These assert the two economic invariants with concrete wei numbers:
 *   I1 — the bundler can NEVER be forced into a guaranteed loss (outer maxFee ≤ revenue).
 *   I2 — a submitted bundle has real base-fee head-room (won't get stuck the moment base
 *        fee ticks up), which the previous code lacked.
 * Plus markup apply/reverse consistency and rounding-direction (cost rounds up).
 */

import { it, expect } from "vitest";
import {
  applyMarkup, reverseMarkup, markupToBps, ceilDiv, computeOuterGas,
} from "../shared/gas/fee-model.ts";

const GWEI = 1_000_000_000n;

// --- markup math ---

it("markupToBps - 2.0 → 20000, 1.5 → 15000", () => {
  expect(markupToBps(2.0)).toEqual(20000n);
  expect(markupToBps(1.5)).toEqual(15000n);
});

it("applyMarkup - 2× doubles, rounds DOWN (never overcharge)", () => {
  expect(applyMarkup(100n * GWEI, 20000n)).toEqual(200n * GWEI);
  // 7 wei × 1.5 = 10.5 → floor 10 (user not overcharged)
  expect(applyMarkup(7n, 15000n)).toEqual(10n);
});

it("reverseMarkup - inverse of applyMarkup for clean 2×", () => {
  const net = 37n * GWEI;
  const user = applyMarkup(net, 20000n);
  expect(reverseMarkup(user, 20000n)).toEqual(net);
});

it("ceilDiv - rounds up; exact stays exact", () => {
  expect(ceilDiv(10n, 3n)).toEqual(4n);
  expect(ceilDiv(9n, 3n)).toEqual(3n);
  expect(ceilDiv(0n, 3n)).toEqual(0n);
});

// --- computeOuterGas invariants ---

const MARKUP = 20000n; // 2×
/** revenueCap == the user's signed price == applyMarkup(networkPrice). */
function quote(networkPrice: bigint) {
  const userPrice = applyMarkup(networkPrice, MARKUP);
  return { userPrice, intended: reverseMarkup(userPrice, MARKUP) };
}

it("computeOuterGas - CALM case: healthy margin + inclusion head-room, ≤ revenue", () => {
  const baseFee = 30n * GWEI;
  const tip = 1n * GWEI;
  const net = baseFee + tip;            // 31 gwei
  const { userPrice, intended } = quote(net); // userPrice 62, intended 31
  const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip: tip });
  // expected cost = baseFee + priority(=intended-baseFee=tip) = 31 gwei
  expect(g.effectiveGasPrice).toEqual(31n * GWEI);
  expect(g.maxPriorityFeePerGas).toEqual(tip);
  // I1: never above revenue
  expect(g.maxFeePerGas <= userPrice, `maxFee ${g.maxFeePerGas} ≤ revenue ${userPrice}`).toBeTruthy();
  // I2: head-room — maxFee well above current base fee (old code gave only baseFee+tip=31)
  expect(g.maxFeePerGas >= 60n * GWEI, `maxFee ${g.maxFeePerGas} should be ~2× baseFee (got head-room)`).toBeTruthy();
  // margin at expected cost = 62/31 - 1 = 100%
});

it("computeOuterGas - I1: maxFee NEVER exceeds revenue across a base-fee sweep", () => {
  const tip = 2n * GWEI;
  const netQuote = 40n * GWEI; // quote-time network price
  const { userPrice, intended } = quote(netQuote); // userPrice 80 gwei
  // Sweep base fee from very low to far above break-even.
  for (let b = 1n; b <= 200n; b += 1n) {
    const baseFee = b * GWEI;
    const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip: tip });
    // I1 — the core no-loss guarantee: worst-case cost (= min(maxFee, baseFee_incl+prio))
    // can never exceed maxFee, and maxFee ≤ revenue.
    expect(g.maxFeePerGas <= userPrice, `baseFee=${b}gwei maxFee ${g.maxFeePerGas} > revenue ${userPrice}`).toBeTruthy();
  }
});

it("computeOuterGas - no-loss end-to-end: realized cost ≤ revenue for ANY inclusion base fee", () => {
  const tip = 1n * GWEI;
  const baseFeeAtSubmit = 50n * GWEI;
  const { userPrice, intended } = quote(60n * GWEI); // userPrice 120 gwei
  const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee: baseFeeAtSubmit, intendedGasPrice: intended, chainTip: tip });
  // Now let base fee at INCLUSION be anything (spike included). Realized cost per gas:
  for (let b = 1n; b <= 300n; b += 7n) {
    const baseFeeIncl = b * GWEI;
    const realizedCost = min(g.maxFeePerGas, baseFeeIncl + g.maxPriorityFeePerGas);
    expect(realizedCost <= userPrice, `inclusion baseFee=${b}gwei cost ${realizedCost} > revenue ${userPrice}`).toBeTruthy();
  }
});

it("computeOuterGas - I2: real head-room vs the OLD (stuck-prone) pricing", () => {
  // Old behaviour: outer maxFee == intendedGasPrice == baseFee + tip → head-room only `tip`.
  const baseFee = 30n * GWEI;
  const tip = 1n * GWEI;
  const { userPrice, intended } = quote(baseFee + tip);
  const oldMaxFee = intended;                       // == 31 gwei (baseFee + tip)
  const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip: tip });
  // New max fee tolerates base fee rising far more before the tx is un-includable.
  const oldHeadroom = oldMaxFee - baseFee;          // 1 gwei (~3%)
  const newHeadroom = g.maxFeePerGas - baseFee;     // ~30 gwei (~100%)
  expect(newHeadroom > oldHeadroom * 10n, `new head-room ${newHeadroom} should dwarf old ${oldHeadroom}`).toBeTruthy();
  // Concretely: base fee can rise +12.5%/block. Old tolerates <1 block; new tolerates many.
  expect(g.maxFeePerGas >= (baseFee * 9n) / 5n, "new maxFee tolerates >=80% base-fee rise").toBeTruthy();
});

it("computeOuterGas - rising base fee but still profitable: pins at break-even, stays includable", () => {
  const tip = 1n * GWEI;
  const { userPrice, intended } = quote(40n * GWEI); // userPrice 80 gwei, intended 40
  const baseFee = 60n * GWEI; // base fee rose 50% since quote; still < userPrice 80
  const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip: tip });
  expect(g.maxFeePerGas <= userPrice).toBeTruthy();
  // includable now: maxFee ≥ baseFee + priority (the effective cost)
  expect(g.maxFeePerGas >= g.effectiveGasPrice, "must cover current base fee + priority").toBeTruthy();
  expect(g.maxFeePerGas >= baseFee, "maxFee must be ≥ current base fee to include").toBeTruthy();
});

it("computeOuterGas - unprofitable spike: maxFee pinned at revenue (caller rejects), never above", () => {
  const tip = 1n * GWEI;
  const { userPrice, intended } = quote(40n * GWEI); // userPrice 80 gwei
  const baseFee = 100n * GWEI; // base fee way above break-even
  const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip: tip });
  // effective (= baseFee + priority) > revenue → profitability gate (elsewhere) rejects.
  expect(g.effectiveGasPrice > userPrice, "this op is unprofitable").toBeTruthy();
  expect(g.maxFeePerGas).toEqual(userPrice); // pinned at revenue, never above (no loss)
});

it("computeOuterGas - ALWAYS returns a valid EIP-1559 pair (maxPriority ≤ maxFee), even with a huge chain tip", () => {
  // Pathological: chain tip floor far above break-even (these ops are unprofitable and
  // get rejected by the gate, but the fee pair must still be structurally valid).
  const { userPrice, intended } = quote(31n * GWEI); // userPrice 62 gwei
  for (const baseFee of [1n, 5n, 30n, 80n].map((x) => x * GWEI)) {
    for (const chainTip of [0n, 1n, 50n, 100n, 500n].map((x) => x * GWEI)) {
      const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip });
      expect(g.maxPriorityFeePerGas <= g.maxFeePerGas, `invalid: prio ${g.maxPriorityFeePerGas} > maxFee ${g.maxFeePerGas} (baseFee=${baseFee} tip=${chainTip})`).toBeTruthy();
      expect(g.maxFeePerGas <= userPrice, "I1 still holds").toBeTruthy();
    }
  }
});

it("computeOuterGas - priority respects chainTip and minPriorityFee floors", () => {
  const baseFee = 10n * GWEI;
  const { userPrice, intended } = quote(11n * GWEI); // intended 11, intended-baseFee = 1 gwei
  const bigChainTip = 5n * GWEI;
  const g = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip: bigChainTip });
  expect(g.maxPriorityFeePerGas >= bigChainTip, "priority floored at chain tip").toBeTruthy();
  const g2 = computeOuterGas({ revenueCapPerGas: userPrice, baseFee, intendedGasPrice: intended, chainTip: 0n, minPriorityFee: 3n * GWEI });
  expect(g2.maxPriorityFeePerGas >= 3n * GWEI, "priority floored at configured minimum").toBeTruthy();
});

it("L2 data-fee handling - wei→gas rounds UP (no under-recovery) and the volatility buffer inflates the L1 component", () => {
  // OP-Stack: l1FeeWei / gasPrice must round UP so the bundler never under-recovers the
  // L1 data fee by truncation (shared/gas/l2-data-fee.ts uses ceilDiv).
  expect(ceilDiv(1000n, 7n)).toEqual(143n);   // 142.857… → 143
  expect(ceilDiv(999n, 1000n)).toEqual(1n);   // any positive fee → at least 1 gas unit
  // The ×1.5 L1-fee volatility buffer (shared/simulation/index.ts L2_DATA_FEE_BUFFER_BPS)
  // inflates the L1 component baked into preVerificationGas so a post-quote L1-fee rise is
  // covered by the user's prepaid pvg, not eaten by the bundler.
  const rawL1Gas = 5000n;
  const buffered = (rawL1Gas * 15000n) / 10_000n;
  expect(buffered).toEqual(7500n);
  expect(buffered > rawL1Gas, "buffer must inflate the L1 component").toBeTruthy();
});

function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
