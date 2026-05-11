/**
 * Tests for sweep logic.
 */

import { assertEquals, assert } from "@std/assert";
import { shouldSweep } from "../src/bundler/sweep.ts";

const TREASURY = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

Deno.test("shouldSweep - triggers at nonce multiples of interval", () => {
  assert(shouldSweep(30, 30, TREASURY));
  assert(shouldSweep(60, 30, TREASURY));
  assert(shouldSweep(90, 30, TREASURY));
});

Deno.test("shouldSweep - does not trigger at non-multiples", () => {
  assert(!shouldSweep(1, 30, TREASURY));
  assert(!shouldSweep(15, 30, TREASURY));
  assert(!shouldSweep(29, 30, TREASURY));
  assert(!shouldSweep(31, 30, TREASURY));
});

Deno.test("shouldSweep - does not trigger at nonce 0", () => {
  assert(!shouldSweep(0, 30, TREASURY));
});

Deno.test("shouldSweep - disabled when no treasury address", () => {
  assert(!shouldSweep(30, 30, null));
});

Deno.test("shouldSweep - disabled when interval is 0", () => {
  assert(!shouldSweep(30, 0, TREASURY));
});

Deno.test("shouldSweep - works with interval 1 (every bundle)", () => {
  assert(shouldSweep(1, 1, TREASURY));
  assert(shouldSweep(5, 1, TREASURY));
  assert(shouldSweep(100, 1, TREASURY));
});
