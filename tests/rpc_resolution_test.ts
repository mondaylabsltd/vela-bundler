/**
 * Tests for RPC URL resolution.
 */

import { assertEquals } from "@std/assert";
import { resolveRpcUrl } from "../src/utils/rpc-client.ts";

Deno.test("resolveRpcUrl - per-request override has highest priority", () => {
  const result = resolveRpcUrl(
    { rpcUrl: "https://default.example.com" },
    "https://override.example.com",
  );
  assertEquals(result, "https://override.example.com");
});

Deno.test("resolveRpcUrl - falls back to config rpcUrl when no override", () => {
  const result = resolveRpcUrl({ rpcUrl: "https://default.example.com" });
  assertEquals(result, "https://default.example.com");
});

Deno.test("resolveRpcUrl - empty override falls back to config", () => {
  assertEquals(resolveRpcUrl({ rpcUrl: "https://d.com" }, ""), "https://d.com");
  assertEquals(resolveRpcUrl({ rpcUrl: "https://d.com" }, null), "https://d.com");
  assertEquals(resolveRpcUrl({ rpcUrl: "https://d.com" }, undefined), "https://d.com");
});
