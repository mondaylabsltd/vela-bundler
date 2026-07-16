import { it, expect } from "vitest";
import {
  stableFloorUnits,
  requiredStableCharge,
  DEFAULT_FEE_TIER,
} from "../shared/gas/stable-rate.ts";

it("stableFloorUnits: $0.01 in a token's base units", () => {
  expect(stableFloorUnits(6)).toEqual(10_000n); // USDC/USDT (6-dec): 0.01 * 1e6
  expect(stableFloorUnits(18)).toEqual(10_000_000_000_000_000n); // DAI (18-dec): 0.01 * 1e18
  expect(stableFloorUnits(2)).toEqual(1n); // 0.01 * 1e2
  expect(stableFloorUnits(0)).toEqual(0n); // no sub-unit precision
});

it("requiredStableCharge: max($0.01 floor, markup × cost)", () => {
  // Tiny op: 3× cost is below $0.01 → the floor binds.
  expect(requiredStableCharge(1_000n, 6, 3n)).toEqual(10_000n); // 3*1000=3000 < 10000 floor
  // Normal op: 3× cost exceeds the floor → the markup binds.
  expect(requiredStableCharge(100_000n, 6, 3n)).toEqual(300_000n); // 3*100000 > floor
  // Exactly at the floor boundary.
  expect(requiredStableCharge(10_000n / 3n, 6, 3n)).toEqual(10_000n); // 3*3333=9999 < floor → floor
  // 18-dec token.
  expect(requiredStableCharge(5n * 10n ** 16n, 18, 3n)).toEqual(15n * 10n ** 16n); // markup binds
});

it("DEFAULT_FEE_TIER is the 0.05% Uniswap-v3 tier", () => {
  expect(DEFAULT_FEE_TIER).toEqual(500);
});
