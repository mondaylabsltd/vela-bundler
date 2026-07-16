/**
 * Unit tests for Alchemy RPC support.
 */

import { it, expect } from "vitest";
import {
  isAlchemySupported,
  buildAlchemyRpcUrl,
  getAlchemySupportedChainIds,
} from "../shared/config/alchemy.ts";

// ---- isAlchemySupported ----

it("isAlchemySupported - Ethereum mainnet", () => {
  expect(isAlchemySupported(1)).toBeTruthy();
});

it("isAlchemySupported - BSC mainnet", () => {
  expect(isAlchemySupported(56)).toBeTruthy();
});

it("isAlchemySupported - Polygon mainnet", () => {
  expect(isAlchemySupported(137)).toBeTruthy();
});

it("isAlchemySupported - Arbitrum mainnet", () => {
  expect(isAlchemySupported(42161)).toBeTruthy();
});

it("isAlchemySupported - Base mainnet", () => {
  expect(isAlchemySupported(8453)).toBeTruthy();
});

it("isAlchemySupported - Optimism mainnet", () => {
  expect(isAlchemySupported(10)).toBeTruthy();
});

it("isAlchemySupported - unsupported local/dev chain", () => {
  expect(!isAlchemySupported(1337)).toBeTruthy();
  expect(!isAlchemySupported(31337)).toBeTruthy();
});

it("isAlchemySupported - unsupported random chainId", () => {
  expect(!isAlchemySupported(99999999)).toBeTruthy();
});

// ---- buildAlchemyRpcUrl ----

it("buildAlchemyRpcUrl - Ethereum mainnet URL format", () => {
  const url = buildAlchemyRpcUrl(1, "test-key-123");
  expect(url).toEqual("https://eth-mainnet.g.alchemy.com/v2/test-key-123");
});

it("buildAlchemyRpcUrl - BSC mainnet URL format", () => {
  const url = buildAlchemyRpcUrl(56, "my-api-key");
  expect(url).toEqual("https://bnb-mainnet.g.alchemy.com/v2/my-api-key");
});

it("buildAlchemyRpcUrl - Polygon mainnet URL format", () => {
  const url = buildAlchemyRpcUrl(137, "key");
  expect(url).toEqual("https://polygon-mainnet.g.alchemy.com/v2/key");
});

it("buildAlchemyRpcUrl - Base Sepolia URL format", () => {
  const url = buildAlchemyRpcUrl(84532, "key");
  expect(url).toEqual("https://base-sepolia.g.alchemy.com/v2/key");
});

it("buildAlchemyRpcUrl - returns null for unsupported chain", () => {
  const url = buildAlchemyRpcUrl(1337, "key");
  expect(url).toEqual(null);
});

it("buildAlchemyRpcUrl - all testnets have correct slug", () => {
  // Verify a few testnet URLs
  expect(
    buildAlchemyRpcUrl(11155111, "k"),
  ).toEqual("https://eth-sepolia.g.alchemy.com/v2/k");
  expect(
    buildAlchemyRpcUrl(421614, "k"),
  ).toEqual("https://arb-sepolia.g.alchemy.com/v2/k");
  expect(
    buildAlchemyRpcUrl(97, "k"),
  ).toEqual("https://bnb-testnet.g.alchemy.com/v2/k");
});

// ---- getAlchemySupportedChainIds ----

it("getAlchemySupportedChainIds - returns non-empty array", () => {
  const ids = getAlchemySupportedChainIds();
  expect(ids.length > 80, `Expected >80 supported chains, got ${ids.length}`).toBeTruthy();
});

it("getAlchemySupportedChainIds - all IDs are positive numbers", () => {
  const ids = getAlchemySupportedChainIds();
  for (const id of ids) {
    expect(id > 0, `Invalid chainId: ${id}`).toBeTruthy();
    expect(Number.isInteger(id), `Non-integer chainId: ${id}`).toBeTruthy();
  }
});

it("getAlchemySupportedChainIds - major chains included", () => {
  const ids = getAlchemySupportedChainIds();
  const major = [1, 10, 56, 137, 8453, 42161, 43114, 324, 534352, 59144];
  for (const chainId of major) {
    expect(ids.includes(chainId), `Major chain ${chainId} missing from Alchemy support`).toBeTruthy();
  }
});

// ---- Coverage of all chains from Alchemy docs ----

it("Alchemy chains - covers all major L2s", () => {
  // L2s that should be supported
  const l2s: Record<string, number> = {
    "Optimism": 10,
    "Arbitrum": 42161,
    "Base": 8453,
    "zkSync": 324,
    "Scroll": 534352,
    "Linea": 59144,
    "Blast": 81457,
    "Mantle": 5000,
    "Mode": 34443,
    "Zora": 7777777,
    "opBNB": 204,
    "Ink": 57073,
    "Unichain": 130,
  };
  for (const [name, chainId] of Object.entries(l2s)) {
    expect(isAlchemySupported(chainId), `L2 ${name} (${chainId}) not in Alchemy support`).toBeTruthy();
  }
});

it("Alchemy chains - covers newly added chains from 2026 docs", () => {
  const newChains: Record<string, number> = {
    "BOB": 60808,
    "MegaETH": 4326,
    "Monad": 143,
    "RISE": 4153,
    "RACE": 6805,
    "Citrea": 4114,
    "Galactica": 613419,
    "Humanity": 6985385,
    "Plasma": 9745,
    "Unite": 88899,
    "Tempo": 4217,
    "Mythos": 201804,
    "Stable": 988,
    "Settlus": 5371,
    "Edge": 3343,
    "Ethereum Hoodi": 560048,
    "Sonic Blaze": 57054,
    "Frax Hoodi": 2523,
  };
  for (const [name, chainId] of Object.entries(newChains)) {
    expect(isAlchemySupported(chainId), `${name} (${chainId}) not in Alchemy support`).toBeTruthy();
    const url = buildAlchemyRpcUrl(chainId, "test");
    expect(url !== null, `${name} (${chainId}) returned null URL`).toBeTruthy();
  }
});

it("Alchemy chains - each chainId maps to a unique slug", () => {
  const ids = getAlchemySupportedChainIds();
  const urls = new Set<string>();
  for (const id of ids) {
    const url = buildAlchemyRpcUrl(id, "test");
    expect(url !== null).toBeTruthy();
    expect(!urls.has(url!), `Duplicate URL for chainId ${id}: ${url}`).toBeTruthy();
    urls.add(url!);
  }
});
