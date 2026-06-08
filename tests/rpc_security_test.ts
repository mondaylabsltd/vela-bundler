/**
 * Security tests for RPC URL validation and blacklist.
 *
 * Verifies that SSRF protections block:
 * - Private network addresses (RFC1918)
 * - Link-local addresses (RFC3927)
 * - Cloud metadata endpoints
 * - Loopback addresses (all forms)
 * - URLs with embedded credentials
 */

import { assertEquals, assert } from "@std/assert";
import { validateRpcUrl } from "../shared/utils/rpc-client.ts";
import { blacklistRpc, isRpcBlacklisted } from "../shared/utils/rpc-blacklist.ts";

// --- SSRF Protection Tests ---

Deno.test("validateRpcUrl - accepts valid HTTPS RPC URL", () => {
  assertEquals(validateRpcUrl("https://mainnet.infura.io/v3/abc123"), null);
});

Deno.test("validateRpcUrl - accepts valid Alchemy URL", () => {
  assertEquals(validateRpcUrl("https://eth-mainnet.g.alchemy.com/v2/key123"), null);
});

Deno.test("validateRpcUrl - rejects HTTP (non-HTTPS)", () => {
  assert(validateRpcUrl("http://mainnet.infura.io/v3/abc123") !== null);
});

Deno.test("validateRpcUrl - rejects invalid URL format", () => {
  assert(validateRpcUrl("not-a-url") !== null);
});

// Loopback blocking
Deno.test("validateRpcUrl - blocks localhost", () => {
  assert(validateRpcUrl("https://localhost:8545/") !== null);
});

Deno.test("validateRpcUrl - blocks 127.0.0.1", () => {
  assert(validateRpcUrl("https://127.0.0.1:8545/") !== null);
});

Deno.test("validateRpcUrl - blocks 127.x.x.x range", () => {
  assert(validateRpcUrl("https://127.0.0.2:8545/") !== null);
});

Deno.test("validateRpcUrl - blocks ::1 IPv6 loopback", () => {
  assert(validateRpcUrl("https://[::1]:8545/") !== null);
});

Deno.test("validateRpcUrl - blocks 0.0.0.0", () => {
  assert(validateRpcUrl("https://0.0.0.0:8545/") !== null);
});

// Private network blocking (RFC1918)
Deno.test("validateRpcUrl - blocks 10.x.x.x (RFC1918)", () => {
  assert(validateRpcUrl("https://10.0.0.1:8545/") !== null);
  assert(validateRpcUrl("https://10.255.255.255:8545/") !== null);
});

Deno.test("validateRpcUrl - blocks 172.16-31.x.x (RFC1918)", () => {
  assert(validateRpcUrl("https://172.16.0.1:8545/") !== null);
  assert(validateRpcUrl("https://172.31.255.255:8545/") !== null);
});

Deno.test("validateRpcUrl - allows 172.15.x.x (not RFC1918)", () => {
  assertEquals(validateRpcUrl("https://172.15.0.1:8545/"), null);
});

Deno.test("validateRpcUrl - allows 172.32.x.x (not RFC1918)", () => {
  assertEquals(validateRpcUrl("https://172.32.0.1:8545/"), null);
});

Deno.test("validateRpcUrl - blocks 192.168.x.x (RFC1918)", () => {
  assert(validateRpcUrl("https://192.168.1.1:8545/") !== null);
  assert(validateRpcUrl("https://192.168.0.1:8545/") !== null);
});

// Link-local / metadata
Deno.test("validateRpcUrl - blocks 169.254.x.x (link-local)", () => {
  assert(validateRpcUrl("https://169.254.169.254/") !== null);
  assert(validateRpcUrl("https://169.254.0.1/") !== null);
});

Deno.test("validateRpcUrl - blocks AWS metadata endpoint", () => {
  assert(validateRpcUrl("https://169.254.169.254/latest/meta-data/") !== null);
});

Deno.test("validateRpcUrl - blocks GCP metadata endpoint", () => {
  assert(validateRpcUrl("https://metadata.google.internal/") !== null);
});

Deno.test("validateRpcUrl - blocks Azure IMDS", () => {
  assert(validateRpcUrl("https://168.63.129.16/") !== null);
});

Deno.test("validateRpcUrl - blocks .internal domains", () => {
  assert(validateRpcUrl("https://something.internal/") !== null);
});

// Credential blocking
Deno.test("validateRpcUrl - blocks URLs with credentials", () => {
  assert(validateRpcUrl("https://user:pass@evil.com/rpc") !== null);
});

Deno.test("validateRpcUrl - blocks URLs with username only", () => {
  assert(validateRpcUrl("https://admin@evil.com/rpc") !== null);
});

// --- Blacklist Tests ---

Deno.test("blacklistRpc - blacklisted URL is detected", () => {
  blacklistRpc("https://test-blacklist-detect.example.com");
  assert(isRpcBlacklisted("https://test-blacklist-detect.example.com"));
});

Deno.test("isRpcBlacklisted - returns false for unknown URL", () => {
  assertEquals(isRpcBlacklisted("https://never-blacklisted.example.com"), false);
});
