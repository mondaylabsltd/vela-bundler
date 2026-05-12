/**
 * Unit tests for Alchemy RPC support.
 */

import { assertEquals, assert, assertNotEquals } from "@std/assert";
import {
  isAlchemySupported,
  buildAlchemyRpcUrl,
  getAlchemySupportedChainIds,
} from "../src/config/alchemy.ts";

// ---- isAlchemySupported ----

Deno.test("isAlchemySupported - Ethereum mainnet", () => {
  assert(isAlchemySupported(1));
});

Deno.test("isAlchemySupported - BSC mainnet", () => {
  assert(isAlchemySupported(56));
});

Deno.test("isAlchemySupported - Polygon mainnet", () => {
  assert(isAlchemySupported(137));
});

Deno.test("isAlchemySupported - Arbitrum mainnet", () => {
  assert(isAlchemySupported(42161));
});

Deno.test("isAlchemySupported - Base mainnet", () => {
  assert(isAlchemySupported(8453));
});

Deno.test("isAlchemySupported - Optimism mainnet", () => {
  assert(isAlchemySupported(10));
});

Deno.test("isAlchemySupported - unsupported local/dev chain", () => {
  assert(!isAlchemySupported(1337));
  assert(!isAlchemySupported(31337));
});

Deno.test("isAlchemySupported - unsupported random chainId", () => {
  assert(!isAlchemySupported(99999999));
});

// ---- buildAlchemyRpcUrl ----

Deno.test("buildAlchemyRpcUrl - Ethereum mainnet URL format", () => {
  const url = buildAlchemyRpcUrl(1, "test-key-123");
  assertEquals(url, "https://eth-mainnet.g.alchemy.com/v2/test-key-123");
});

Deno.test("buildAlchemyRpcUrl - BSC mainnet URL format", () => {
  const url = buildAlchemyRpcUrl(56, "my-api-key");
  assertEquals(url, "https://bnb-mainnet.g.alchemy.com/v2/my-api-key");
});

Deno.test("buildAlchemyRpcUrl - Polygon mainnet URL format", () => {
  const url = buildAlchemyRpcUrl(137, "key");
  assertEquals(url, "https://polygon-mainnet.g.alchemy.com/v2/key");
});

Deno.test("buildAlchemyRpcUrl - Base Sepolia URL format", () => {
  const url = buildAlchemyRpcUrl(84532, "key");
  assertEquals(url, "https://base-sepolia.g.alchemy.com/v2/key");
});

Deno.test("buildAlchemyRpcUrl - returns null for unsupported chain", () => {
  const url = buildAlchemyRpcUrl(1337, "key");
  assertEquals(url, null);
});

Deno.test("buildAlchemyRpcUrl - all testnets have correct slug", () => {
  // Verify a few testnet URLs
  assertEquals(
    buildAlchemyRpcUrl(11155111, "k"),
    "https://eth-sepolia.g.alchemy.com/v2/k",
  );
  assertEquals(
    buildAlchemyRpcUrl(421614, "k"),
    "https://arb-sepolia.g.alchemy.com/v2/k",
  );
  assertEquals(
    buildAlchemyRpcUrl(97, "k"),
    "https://bnb-testnet.g.alchemy.com/v2/k",
  );
});

// ---- getAlchemySupportedChainIds ----

Deno.test("getAlchemySupportedChainIds - returns non-empty array", () => {
  const ids = getAlchemySupportedChainIds();
  assert(ids.length > 80, `Expected >80 supported chains, got ${ids.length}`);
});

Deno.test("getAlchemySupportedChainIds - all IDs are positive numbers", () => {
  const ids = getAlchemySupportedChainIds();
  for (const id of ids) {
    assert(id > 0, `Invalid chainId: ${id}`);
    assert(Number.isInteger(id), `Non-integer chainId: ${id}`);
  }
});

Deno.test("getAlchemySupportedChainIds - major chains included", () => {
  const ids = getAlchemySupportedChainIds();
  const major = [1, 10, 56, 137, 8453, 42161, 43114, 324, 534352, 59144];
  for (const chainId of major) {
    assert(ids.includes(chainId), `Major chain ${chainId} missing from Alchemy support`);
  }
});

// ---- Coverage of all chains from Alchemy docs ----

Deno.test("Alchemy chains - covers all major L2s", () => {
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
    assert(isAlchemySupported(chainId), `L2 ${name} (${chainId}) not in Alchemy support`);
  }
});

Deno.test("Alchemy chains - covers newly added chains from 2026 docs", () => {
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
    assert(isAlchemySupported(chainId), `${name} (${chainId}) not in Alchemy support`);
    const url = buildAlchemyRpcUrl(chainId, "test");
    assert(url !== null, `${name} (${chainId}) returned null URL`);
  }
});

Deno.test("Alchemy chains - each chainId maps to a unique slug", () => {
  const ids = getAlchemySupportedChainIds();
  const urls = new Set<string>();
  for (const id of ids) {
    const url = buildAlchemyRpcUrl(id, "test");
    assert(url !== null);
    assert(!urls.has(url!), `Duplicate URL for chainId ${id}: ${url}`);
    urls.add(url!);
  }
});
