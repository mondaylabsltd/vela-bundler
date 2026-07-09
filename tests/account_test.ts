/**
 * Tests for account service, EOA lock manager, and binding rules.
 */

import { assertEquals, assert, assertNotEquals } from "@std/assert";
import { EOALockManager } from "../shared/account/eoa-lock.ts";
import { isTempoChain } from "../shared/tempo.ts";
import { computeSplitterAddress } from "../shared/contracts/splitter.ts";

const EOA_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

// --- EOA Lock Manager ---

Deno.test("EOALockManager - acquireBundleLock and release", () => {
  const lm = new EOALockManager();

  // Manually set state
  lm["states"].set(EOA_A.toLowerCase(), {
    address: EOA_A,
    status: "ACTIVE",
    latestNonce: 0,
    pendingNonce: 0,
    reservedBalance: 0n,
    bundleLock: false,
  });

  assert(lm.isAvailable(EOA_A));
  assert(lm.acquireBundleLock(EOA_A));
  assert(!lm.isAvailable(EOA_A), "Should not be available while locked");
  assert(!lm.acquireBundleLock(EOA_A), "Double lock should fail");

  lm.releaseBundleLock(EOA_A);
  assert(lm.isAvailable(EOA_A), "Should be available after release");
});

Deno.test("EOALockManager - bundle lock sets status to LOCKED_IN_MEMORY_PENDING", () => {
  const lm = new EOALockManager();
  lm["states"].set(EOA_A.toLowerCase(), {
    address: EOA_A,
    status: "ACTIVE",
    latestNonce: 5,
    pendingNonce: 5,
    reservedBalance: 0n,
    bundleLock: false,
  });

  lm.acquireBundleLock(EOA_A);
  assertEquals(lm.getState(EOA_A)?.status, "LOCKED_IN_MEMORY_PENDING");

  lm.releaseBundleLock(EOA_A);
  assertEquals(lm.getState(EOA_A)?.status, "ACTIVE");
});

Deno.test("EOALockManager - cannot acquire lock on LOCKED_PENDING_UNKNOWN", () => {
  const lm = new EOALockManager();
  lm["states"].set(EOA_A.toLowerCase(), {
    address: EOA_A,
    status: "LOCKED_PENDING_UNKNOWN",
    latestNonce: 5,
    pendingNonce: 6, // pending > latest
    reservedBalance: 0n,
    bundleLock: true,
  });

  assert(!lm.isAvailable(EOA_A));
  assert(!lm.acquireBundleLock(EOA_A));
});

Deno.test("EOALockManager - reservation tracking", () => {
  const lm = new EOALockManager();
  lm["states"].set(EOA_A.toLowerCase(), {
    address: EOA_A,
    status: "ACTIVE",
    latestNonce: 0,
    pendingNonce: 0,
    reservedBalance: 0n,
    bundleLock: false,
  });

  assertEquals(lm.getReservedBalance(EOA_A), 0n);

  lm.addReservation(EOA_A, 1000n);
  assertEquals(lm.getReservedBalance(EOA_A), 1000n);

  lm.addReservation(EOA_A, 500n);
  assertEquals(lm.getReservedBalance(EOA_A), 1500n);

  lm.releaseReservation(EOA_A, 1000n);
  assertEquals(lm.getReservedBalance(EOA_A), 500n);

  lm.releaseReservation(EOA_A, 9999n); // More than reserved
  assertEquals(lm.getReservedBalance(EOA_A), 0n);
});

Deno.test("EOALockManager - lockEOA forces lock", () => {
  const lm = new EOALockManager();
  lm["states"].set(EOA_A.toLowerCase(), {
    address: EOA_A,
    status: "ACTIVE",
    latestNonce: 5,
    pendingNonce: 5,
    reservedBalance: 0n,
    bundleLock: false,
  });

  lm.lockEOA(EOA_A, "LOCKED_PENDING_UNKNOWN");
  assertEquals(lm.getState(EOA_A)?.status, "LOCKED_PENDING_UNKNOWN");
  assert(!lm.isAvailable(EOA_A));
});

Deno.test("EOALockManager - clear resets all state", () => {
  const lm = new EOALockManager();
  lm["states"].set(EOA_A.toLowerCase(), {
    address: EOA_A,
    status: "ACTIVE",
    latestNonce: 0,
    pendingNonce: 0,
    reservedBalance: 100n,
    bundleLock: false,
  });

  lm.clear();
  assertEquals(lm.getState(EOA_A), undefined);
  assertEquals(lm.getReservedBalance(EOA_A), 0n);
});

// --- spendableBalance logic ---

Deno.test("spendableBalance = onchainBalance - reservedBalance", () => {
  // This is a pure logic test — no chain calls
  const onchainBalance = 10_000_000_000_000_000n; // 0.01 ETH
  const reservedBalance = 3_000_000_000_000_000n;  // 0.003 ETH
  const spendable = onchainBalance > reservedBalance
    ? onchainBalance - reservedBalance
    : 0n;
  assertEquals(spendable, 7_000_000_000_000_000n);
});

Deno.test("spendableBalance floors at zero", () => {
  const onchainBalance = 1000n;
  const reservedBalance = 5000n;
  const spendable = onchainBalance > reservedBalance
    ? onchainBalance - reservedBalance
    : 0n;
  assertEquals(spendable, 0n);
});

// --- Binding rules (pure logic) ---

Deno.test("Bundle only contains ops from the bound safeAddress", () => {
  const safeAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ops = [
    { sender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { sender: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, // Wrong sender
    { sender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  ];

  const validOps = ops.filter(
    (op) => op.sender.toLowerCase() === safeAddress.toLowerCase(),
  );
  assertEquals(validOps.length, 2);
});

Deno.test("handleOps beneficiary: splitter on native chains, EOA on Tempo", () => {
  const eoaAddress = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
  const treasury = "0x1111111111111111111111111111111111111111" as `0x${string}`;
  const splitter = computeSplitterAddress(treasury);

  // The exact rule from shared/bundler/index.ts: `tempo ? eoa.address : splitterAddress`.
  const beneficiaryFor = (chainId: number) => (isTempoChain(chainId) ? eoaAddress : splitter);

  // Native chain (mainnet=1): the EntryPoint pays the splitter, NOT the EOA.
  assertEquals(beneficiaryFor(1), splitter);
  assertNotEquals(beneficiaryFor(1), eoaAddress);

  // Tempo (4217): repaid in-band to the EOA, so the beneficiary stays the EOA.
  assertEquals(beneficiaryFor(4217), eoaAddress);
});

// --- Restart recovery logic ---

Deno.test("pendingNonce > latestNonce means LOCKED_PENDING_UNKNOWN", () => {
  const latestNonce = 5;
  const pendingNonce = 6;
  const status = pendingNonce > latestNonce
    ? "LOCKED_PENDING_UNKNOWN"
    : "ACTIVE";
  assertEquals(status, "LOCKED_PENDING_UNKNOWN");
});

Deno.test("pendingNonce == latestNonce means ACTIVE", () => {
  const latestNonce = 5;
  const pendingNonce = 5;
  const status = pendingNonce > latestNonce
    ? "LOCKED_PENDING_UNKNOWN"
    : "ACTIVE";
  assertEquals(status, "ACTIVE");
});

// --- Secret rotation ---

Deno.test("old secrets produce different EOAs than current secret", async () => {
  const { deriveEOAAddress } = await import("../shared/keys/derive.ts");
  const secret1 = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const secret2 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ep = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
  const safe = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

  const addr1 = await deriveEOAAddress(secret1, 1, ep, safe);
  const addr2 = await deriveEOAAddress(secret2, 1, ep, safe);
  assert(addr1 !== addr2, "Different secrets must produce different EOAs");
});
