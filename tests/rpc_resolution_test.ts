/**
 * Tests for RPC URL resolution.
 */

import { it, expect } from "vitest";
import { resolveRpcUrl } from "../shared/utils/rpc-client.ts";

it("resolveRpcUrl - per-request override has highest priority", () => {
  const result = resolveRpcUrl(
    { rpcUrl: "https://default.example.com" },
    "https://override.example.com",
  );
  expect(result).toEqual("https://override.example.com");
});

it("resolveRpcUrl - falls back to config rpcUrl when no override", () => {
  const result = resolveRpcUrl({ rpcUrl: "https://default.example.com" });
  expect(result).toEqual("https://default.example.com");
});

it("resolveRpcUrl - empty override falls back to config", () => {
  expect(resolveRpcUrl({ rpcUrl: "https://d.com" }, "")).toEqual("https://d.com");
  expect(resolveRpcUrl({ rpcUrl: "https://d.com" }, null)).toEqual("https://d.com");
  expect(resolveRpcUrl({ rpcUrl: "https://d.com" }, undefined)).toEqual("https://d.com");
});
