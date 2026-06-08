/**
 * Unit tests for mempool and reputation.
 */

import { assertEquals, assert, assertThrows } from "@std/assert";
import { Mempool } from "../shared/mempool/index.ts";
import { ReputationManager } from "../shared/mempool/reputation.ts";
import { UserOpValidationError } from "../shared/userop/validate.ts";
import type { UserOperation } from "../shared/userop/types.ts";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

function makeMempoolConfig() {
  return {
    entryPointAddress: ENTRY_POINT,
    chainId: 1337,
    maxMempoolSize: 100,
    stakedSenderMaxOps: 4,
  };
}

function makeUserOp(overrides: Partial<UserOperation> = {}): UserOperation {
  return {
    sender: "0x1234567890abcdef1234567890abcdef12345678",
    nonce: 0n,
    factory: null,
    factoryData: null,
    callData: "0xdeadbeef",
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0xaabbccdd",
    ...overrides,
  };
}

// --- Mempool basic operations ---

Deno.test("Mempool - add and retrieve UserOp", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const userOp = makeUserOp();
  const hash = mempool.add(userOp);

  assert(hash.startsWith("0x"));
  assertEquals(hash.length, 66);
  assertEquals(mempool.size, 1);

  const entry = mempool.get(hash);
  assert(entry !== undefined);
  assertEquals(entry!.userOp.sender, userOp.sender);
});

Deno.test("Mempool - remove UserOp", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const hash = mempool.add(makeUserOp());
  assertEquals(mempool.size, 1);

  assert(mempool.remove(hash));
  assertEquals(mempool.size, 0);
});

Deno.test("Mempool - clear all entries", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(makeUserOp());
  assertEquals(mempool.size, 1);

  mempool.clear();
  assertEquals(mempool.size, 0);
});

// --- Sender limit ---

Deno.test("Mempool - rejects second op from same sender (different nonce)", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(makeUserOp({ nonce: 0n }));

  assertThrows(
    () => mempool.add(makeUserOp({ nonce: 1n })),
    UserOpValidationError,
    "Already have a pending UserOperation",
  );
});

// --- Replacement rules ---

Deno.test("Mempool - allows replacement with higher fees (same nonce)", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const hash1 = mempool.add(
    makeUserOp({
      maxPriorityFeePerGas: 2_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
    }),
  );

  // Replace with higher fees (>10% increase)
  const hash2 = mempool.add(
    makeUserOp({
      maxPriorityFeePerGas: 2_500_000_000n, // +25%
      maxFeePerGas: 30_500_000_000n,         // increased by at least the same delta
    }),
  );

  assertEquals(mempool.size, 1);
  assert(hash1 !== hash2);
  // Old entry should be gone
  assert(mempool.get(hash1) === undefined);
});

Deno.test("Mempool - rejects replacement with insufficient fee increase", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(
    makeUserOp({
      maxPriorityFeePerGas: 2_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
    }),
  );

  // Try to replace with only a tiny increase (< 10%)
  assertThrows(
    () =>
      mempool.add(
        makeUserOp({
          maxPriorityFeePerGas: 2_100_000_000n, // only 5% increase
          maxFeePerGas: 30_100_000_000n,
        }),
      ),
    UserOpValidationError,
    "at least 10%",
  );
});

Deno.test("Mempool - rejects replacement where maxFeePerGas delta is less than priority delta", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(
    makeUserOp({
      maxPriorityFeePerGas: 2_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
    }),
  );

  assertThrows(
    () =>
      mempool.add(
        makeUserOp({
          maxPriorityFeePerGas: 3_000_000_000n, // +1 gwei
          maxFeePerGas: 30_500_000_000n,         // only +0.5 gwei, less than priority delta
        }),
      ),
    UserOpValidationError,
    "maxFeePerGas must increase",
  );
});

// --- Paymaster deposit reservation ---

Deno.test("Mempool - tracks paymaster deposit reservation", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const pm = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

  mempool.add(
    makeUserOp({
      sender: "0x1111111111111111111111111111111111111111",
      paymaster: pm,
      paymasterVerificationGasLimit: 50_000n,
      paymasterPostOpGasLimit: 30_000n,
    }),
  );

  const reserved = mempool.getPaymasterReserved(pm);
  assert(reserved > 0n, "Paymaster should have reserved deposit");
});

// --- Reputation ---

Deno.test("ReputationManager - starts with ok status", () => {
  const rm = new ReputationManager();
  assertEquals(rm.getStatus("0x1234567890abcdef1234567890abcdef12345678", "sender"), "ok");
});

Deno.test("ReputationManager - throttles after too many seen without included", () => {
  const rm = new ReputationManager({ throttlingSlack: 5, banSlack: 20 });
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  // See 20 ops, include 0 → should be throttled (20 > 0*10 + 5 = 5)
  for (let i = 0; i < 20; i++) {
    rm.updateSeen(addr, "sender");
  }

  assertEquals(rm.getStatus(addr, "sender"), "throttled");
});

Deno.test("ReputationManager - bans after many seen without included", () => {
  const rm = new ReputationManager({ throttlingSlack: 5, banSlack: 20 });
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  for (let i = 0; i < 25; i++) {
    rm.updateSeen(addr, "sender");
  }

  assertEquals(rm.getStatus(addr, "sender"), "banned");
});

Deno.test("ReputationManager - included ops improve reputation", () => {
  const rm = new ReputationManager({ throttlingSlack: 5, banSlack: 20 });
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  // See many ops
  for (let i = 0; i < 20; i++) {
    rm.updateSeen(addr, "sender");
  }
  assertEquals(rm.getStatus(addr, "sender"), "throttled");

  // Include many ops → should improve
  for (let i = 0; i < 5; i++) {
    rm.updateIncluded(addr, "sender");
  }
  // maxSeen = 5*10 + 5 = 55, opsSeen = 20 → ok
  assertEquals(rm.getStatus(addr, "sender"), "ok");
});

Deno.test("ReputationManager - decay reduces counts", () => {
  const rm = new ReputationManager();
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  for (let i = 0; i < 100; i++) rm.updateSeen(addr, "sender");
  rm.decay();

  const entries = rm.dump();
  const entry = entries.find((e) => e.address === addr.toLowerCase());
  assertEquals(entry!.opsSeen, 50); // halved
});

Deno.test("Mempool - rejects banned sender", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const sender = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  // Force ban
  mempool.reputation.setReputation(sender, "sender", 100, 0, "banned");

  assertThrows(
    () => mempool.add(makeUserOp({ sender })),
    UserOpValidationError,
    "banned",
  );
});

Deno.test("Mempool - rejects banned paymaster", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const pm = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

  mempool.reputation.setReputation(pm, "paymaster", 100, 0, "banned");

  assertThrows(
    () =>
      mempool.add(
        makeUserOp({
          paymaster: pm,
          paymasterVerificationGasLimit: 50_000n,
          paymasterPostOpGasLimit: 30_000n,
        }),
      ),
    UserOpValidationError,
    "banned",
  );
});

Deno.test("Mempool - dump returns all entries", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(
    makeUserOp({
      sender: "0x1111111111111111111111111111111111111111",
    }),
  );
  mempool.add(
    makeUserOp({
      sender: "0x2222222222222222222222222222222222222222",
    }),
  );

  const dump = mempool.dump();
  assertEquals(dump.length, 2);
});
