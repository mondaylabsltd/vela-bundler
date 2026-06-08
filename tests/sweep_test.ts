/**
 * Tests for sweep logic.
 *
 * The sweep module's only export is executeSweep(), which requires RPC.
 * These tests verify the sweep module can be imported and the interface
 * is correct. Full sweep testing requires integration tests with a live node.
 */

import { assertEquals, assertExists } from "@std/assert";
import { executeSweep, type SweepResult } from "../shared/bundler/sweep.ts";

Deno.test("executeSweep - is exported and callable", () => {
  assertExists(executeSweep);
  assertEquals(typeof executeSweep, "function");
});

Deno.test("SweepResult - interface shape is valid", () => {
  // Verify the SweepResult type works as expected
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
