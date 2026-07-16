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

import { it, expect } from "vitest";
import { validateRpcUrl } from "../shared/utils/rpc-client.ts";
import { blacklistRpc, isRpcBlacklisted } from "../shared/utils/rpc-blacklist.ts";

// --- SSRF Protection Tests ---

it("validateRpcUrl - accepts valid HTTPS RPC URL", () => {
  expect(validateRpcUrl("https://mainnet.infura.io/v3/abc123")).toEqual(null);
});

it("validateRpcUrl - accepts valid Alchemy URL", () => {
  expect(validateRpcUrl("https://eth-mainnet.g.alchemy.com/v2/key123")).toEqual(null);
});

it("validateRpcUrl - rejects HTTP (non-HTTPS)", () => {
  expect(validateRpcUrl("http://mainnet.infura.io/v3/abc123") !== null).toBeTruthy();
});

it("validateRpcUrl - rejects invalid URL format", () => {
  expect(validateRpcUrl("not-a-url") !== null).toBeTruthy();
});

// Loopback blocking
it("validateRpcUrl - blocks localhost", () => {
  expect(validateRpcUrl("https://localhost:8545/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks 127.0.0.1", () => {
  expect(validateRpcUrl("https://127.0.0.1:8545/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks 127.x.x.x range", () => {
  expect(validateRpcUrl("https://127.0.0.2:8545/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks ::1 IPv6 loopback", () => {
  expect(validateRpcUrl("https://[::1]:8545/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks 0.0.0.0", () => {
  expect(validateRpcUrl("https://0.0.0.0:8545/") !== null).toBeTruthy();
});

// Private network blocking (RFC1918)
it("validateRpcUrl - blocks 10.x.x.x (RFC1918)", () => {
  expect(validateRpcUrl("https://10.0.0.1:8545/") !== null).toBeTruthy();
  expect(validateRpcUrl("https://10.255.255.255:8545/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks 172.16-31.x.x (RFC1918)", () => {
  expect(validateRpcUrl("https://172.16.0.1:8545/") !== null).toBeTruthy();
  expect(validateRpcUrl("https://172.31.255.255:8545/") !== null).toBeTruthy();
});

it("validateRpcUrl - allows 172.15.x.x (not RFC1918)", () => {
  expect(validateRpcUrl("https://172.15.0.1:8545/")).toEqual(null);
});

it("validateRpcUrl - allows 172.32.x.x (not RFC1918)", () => {
  expect(validateRpcUrl("https://172.32.0.1:8545/")).toEqual(null);
});

it("validateRpcUrl - blocks 192.168.x.x (RFC1918)", () => {
  expect(validateRpcUrl("https://192.168.1.1:8545/") !== null).toBeTruthy();
  expect(validateRpcUrl("https://192.168.0.1:8545/") !== null).toBeTruthy();
});

// Link-local / metadata
it("validateRpcUrl - blocks 169.254.x.x (link-local)", () => {
  expect(validateRpcUrl("https://169.254.169.254/") !== null).toBeTruthy();
  expect(validateRpcUrl("https://169.254.0.1/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks AWS metadata endpoint", () => {
  expect(validateRpcUrl("https://169.254.169.254/latest/meta-data/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks GCP metadata endpoint", () => {
  expect(validateRpcUrl("https://metadata.google.internal/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks Azure IMDS", () => {
  expect(validateRpcUrl("https://168.63.129.16/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks .internal domains", () => {
  expect(validateRpcUrl("https://something.internal/") !== null).toBeTruthy();
});

// Credential blocking
it("validateRpcUrl - blocks URLs with credentials", () => {
  expect(validateRpcUrl("https://user:pass@evil.com/rpc") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks URLs with username only", () => {
  expect(validateRpcUrl("https://admin@evil.com/rpc") !== null).toBeTruthy();
});

// --- Blacklist Tests ---

it("blacklistRpc - blacklisted URL is detected", () => {
  blacklistRpc("https://test-blacklist-detect.example.com");
  expect(isRpcBlacklisted("https://test-blacklist-detect.example.com")).toBeTruthy();
});

it("isRpcBlacklisted - returns false for unknown URL", () => {
  expect(isRpcBlacklisted("https://never-blacklisted.example.com")).toEqual(false);
});

// --- SSRF bypass regression tests (these MUST stay blocked) ---

it("validateRpcUrl - blocks IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]", () => {
  expect(validateRpcUrl("https://[::ffff:127.0.0.1]/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks IPv4-mapped IPv6 cloud metadata [::ffff:169.254.169.254]", () => {
  // The headline SSRF: AWS/GCP IMDS via IPv4-mapped IPv6 must be blocked.
  expect(validateRpcUrl("https://[::ffff:169.254.169.254]/latest/meta-data/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks fully-expanded mapped metadata [0:0:0:0:0:ffff:a9fe:a9fe]", () => {
  expect(validateRpcUrl("https://[0:0:0:0:0:ffff:a9fe:a9fe]/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks expanded IPv6 loopback [0:0:0:0:0:0:0:1]", () => {
  expect(validateRpcUrl("https://[0:0:0:0:0:0:0:1]/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks IPv6 unspecified [::]", () => {
  expect(validateRpcUrl("https://[::]/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks IPv6 ULA fc00::/7 (fc/fd)", () => {
  expect(validateRpcUrl("https://[fd00::1]/") !== null).toBeTruthy();
  expect(validateRpcUrl("https://[fc00::1]/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks IPv6 link-local fe80::/10", () => {
  expect(validateRpcUrl("https://[fe80::1]/") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks trailing-dot FQDN metadata.google.internal.", () => {
  expect(validateRpcUrl("https://metadata.google.internal./") !== null).toBeTruthy();
});

it("validateRpcUrl - blocks 0.0.0.0/8 and Azure IMDS", () => {
  expect(validateRpcUrl("https://0.1.2.3/") !== null).toBeTruthy();
  expect(validateRpcUrl("https://168.63.129.16/") !== null).toBeTruthy();
});

it("validateRpcUrl - still allows legit global-unicast IPv6 RPC", () => {
  expect(validateRpcUrl("https://[2001:4860:4860::8888]/")).toEqual(null);
});

// --- redactUrl secret-masking regression (INFO-2) ---
import { redactUrl } from "../shared/reliability/log.ts";

it("redactUrl - masks query-string keys (any length) and short path keys, keeps host", () => {
  const cases = [
    "https://eth.llamarpc.com/rpc?apikey=sk_live_0123456789abcdef",
    "https://nd-1.p2pify.com/abcd1234",                 // 8-char path key
    "https://x.example/v2/SECRETKEY1234567890",
    "https://x.example/path?token=ab.cd.ef&x=1",        // key with dots
  ];
  for (const u of cases) {
    const r = redactUrl(u);
    expect(!r.includes("sk_live_0123456789abcdef"), `leak: ${r}`).toBeTruthy();
    expect(!r.includes("abcd1234"), `leak: ${r}`).toBeTruthy();
    expect(!r.includes("SECRETKEY1234567890"), `leak: ${r}`).toBeTruthy();
    expect(!r.includes("ab.cd.ef"), `leak: ${r}`).toBeTruthy();
  }
  // Host must remain for debuggability.
  expect(redactUrl("https://eth.llamarpc.com/rpc?apikey=secret").includes("llamarpc.com")).toBeTruthy();
});
