/**
 * Tests for sweep logic.
 *
 * The decision math (interval gate + surplus-above-floor amount) lives in the pure
 * exports `isSweepNonce` / `sweepableAmount` and is unit-tested exhaustively here.
 * `executeSweep()` itself needs RPC (balance, nonce, broadcast) — only its interface
 * is smoke-tested; full on-chain behaviour requires integration tests against a node.
 */

import { assertEquals } from "@std/assert";
import {
  executeSweep,
  isSweepNonce,
  sweepableAmount,
  type SweepResult,
} from "../shared/bundler/sweep.ts";

// 1 gwei; native floor in sweep.ts is 3,000,000 gas → 3e15 wei at this price.
const GWEI = 1_000_000_000n;
const E15 = 1_000_000_000_000_000n; // 1e15
const FLOOR = 3n * E15; // SWEEP_FLOOR_GAS (3M) × 1 gwei
const DUST = 10_000n; // MIN_SWEEPABLE
const TEMPO_FLOOR = 300_000n; // TEMPO_SPONSOR_TARGET (0.3 pathUSD, 6-dec)

// ---------------------------------------------------------------------------
// isSweepNonce — interval gate
// ---------------------------------------------------------------------------

Deno.test("isSweepNonce: fires on multiples of the interval", () => {
  assertEquals(isSweepNonce(20, 20), true);
  assertEquals(isSweepNonce(40, 20), true);
  assertEquals(isSweepNonce(200, 20), true);
});

Deno.test("isSweepNonce: skips non-multiples", () => {
  assertEquals(isSweepNonce(1, 20), false);
  assertEquals(isSweepNonce(19, 20), false);
  assertEquals(isSweepNonce(21, 20), false);
  assertEquals(isSweepNonce(39, 20), false);
});

Deno.test("isSweepNonce: nonce 0 never fires (no tx yet)", () => {
  assertEquals(isSweepNonce(0, 20), false);
});

Deno.test("isSweepNonce: interval <= 0 disables the gate (always true)", () => {
  assertEquals(isSweepNonce(5, 0), true);
  assertEquals(isSweepNonce(0, 0), true);
  assertEquals(isSweepNonce(7, -1), true);
});

// ---------------------------------------------------------------------------
// sweepableAmount — native (wei, with the sweep tx's own gas cost)
// ---------------------------------------------------------------------------

Deno.test("sweepableAmount: balance at/below floor sweeps nothing (protects new relayers)", () => {
  // A freshly-sponsored relayer (~1.8e15) sits below the 3e15 floor → never swept.
  assertEquals(sweepableAmount(1_800_000_000_000_000n, FLOOR, 21_000n * GWEI), 0n);
  // Exactly at the floor → still nothing.
  assertEquals(sweepableAmount(FLOOR, FLOOR, 0n), 0n);
});

Deno.test("sweepableAmount: between floor and 2× floor, skims down to the floor", () => {
  // balance 4e15, floor 3e15 → aboveFloor 1e15 < half 2e15, so 1e15 is swept,
  // leaving exactly the floor.
  const out = sweepableAmount(4n * E15, FLOOR, 0n);
  assertEquals(out, 1n * E15);
  assertEquals(4n * E15 - out, FLOOR); // leftover == floor
});

Deno.test("sweepableAmount: far above floor, takes 50% (half wins)", () => {
  // balance 10e15, floor 3e15 → half 5e15 < aboveFloor 7e15 → sweep half.
  assertEquals(sweepableAmount(10n * E15, FLOOR, 0n), 5n * E15);
});

Deno.test("sweepableAmount: subtracts the sweep tx's own gas cost", () => {
  // half = 5e15, minus 1e14 gas → 4.9e15.
  assertEquals(sweepableAmount(10n * E15, FLOOR, 100_000_000_000_000n), 4_900_000_000_000_000n);
});

Deno.test("sweepableAmount: result at/below dust returns 0", () => {
  // capped == DUST exactly → not strictly greater → 0.
  assertEquals(sweepableAmount(FLOOR + DUST, FLOOR, 0n), 0n);
  // one wei over dust → returned.
  assertEquals(sweepableAmount(FLOOR + DUST + 1n, FLOOR, 0n), DUST + 1n);
  // gas consumes the entire cut → 0.
  assertEquals(sweepableAmount(10n * E15, FLOOR, 5n * E15), 0n);
});

Deno.test("sweepableAmount: INVARIANT — when it sweeps, leftover (incl. gas) stays >= floor", () => {
  const gas = 21_000n * GWEI;
  for (const balance of [3_500_000_000_000_000n, 4n * E15, 6n * E15, 10n * E15, 50n * E15]) {
    const swept = sweepableAmount(balance, FLOOR, gas);
    if (swept > 0n) {
      const leftover = balance - swept - gas; // both the transfer and its gas leave the account
      assertEquals(leftover >= FLOOR, true, `leftover ${leftover} < floor ${FLOOR} at balance ${balance}`);
    }
  }
});

// ---------------------------------------------------------------------------
// sweepableAmount — Tempo pathUSD (6-dec, gas paid from the retained floor → gasCost 0)
// ---------------------------------------------------------------------------

Deno.test("sweepableAmount (pathUSD): far above floor takes half", () => {
  // 1.0 pathUSD, floor 0.3 → half 0.5 < aboveFloor 0.7 → sweep 0.5, leftover 0.5 >= floor.
  assertEquals(sweepableAmount(1_000_000n, TEMPO_FLOOR), 500_000n);
});

Deno.test("sweepableAmount (pathUSD): between floor and 2× floor skims to the floor", () => {
  // 0.4 pathUSD, floor 0.3 → aboveFloor 0.1 < half 0.2 → sweep 0.1, leftover == floor.
  const out = sweepableAmount(400_000n, TEMPO_FLOOR);
  assertEquals(out, 100_000n);
  assertEquals(400_000n - out, TEMPO_FLOOR);
});

Deno.test("sweepableAmount (pathUSD): at floor or dust-sized surplus sweeps nothing", () => {
  assertEquals(sweepableAmount(TEMPO_FLOOR, TEMPO_FLOOR), 0n); // exactly floor
  assertEquals(sweepableAmount(305_000n, TEMPO_FLOOR), 0n); // surplus 5k ≤ dust 10k
  assertEquals(sweepableAmount(320_000n, TEMPO_FLOOR), 20_000n); // surplus 20k > dust
});

// ---------------------------------------------------------------------------
// executeSweep — interface smoke tests (full behaviour needs a live node)
// ---------------------------------------------------------------------------

Deno.test("executeSweep - is exported and callable", () => {
  assertEquals(typeof executeSweep, "function");
});

Deno.test("SweepResult - interface shape is valid", () => {
  const result: SweepResult = { swept: false, error: "test" };
  assertEquals(result.swept, false);
  assertEquals(result.error, "test");
  assertEquals(result.txHash, undefined);
  assertEquals(result.amount, undefined);
});

Deno.test("SweepResult - successful sweep shape", () => {
  const result: SweepResult = {
    swept: true,
    txHash: "0xabc123" as `0x${string}`,
    amount: 1000n,
  };
  assertEquals(result.swept, true);
  assertEquals(result.txHash, "0xabc123");
  assertEquals(result.amount, 1000n);
});
