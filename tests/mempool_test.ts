/**
 * Unit tests for mempool and reputation.
 */

import { it, expect } from "vitest";
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

it("Mempool - add and retrieve UserOp", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const userOp = makeUserOp();
  const hash = mempool.add(userOp);

  expect(hash.startsWith("0x")).toBeTruthy();
  expect(hash.length).toEqual(66);
  expect(mempool.size).toEqual(1);

  const entry = mempool.get(hash);
  expect(entry !== undefined).toBeTruthy();
  expect(entry!.userOp.sender).toEqual(userOp.sender);
});

it("Mempool - remove UserOp", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const hash = mempool.add(makeUserOp());
  expect(mempool.size).toEqual(1);

  expect(mempool.remove(hash)).toBeTruthy();
  expect(mempool.size).toEqual(0);
});

it("Mempool - clear all entries", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(makeUserOp());
  expect(mempool.size).toEqual(1);

  mempool.clear();
  expect(mempool.size).toEqual(0);
});

// --- Sender limit ---

it("Mempool - rejects second op from same sender (different nonce)", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(makeUserOp({ nonce: 0n }));

  expect(() => mempool.add(makeUserOp({ nonce: 1n }))).toThrow("Already have a pending UserOperation");
  expect(() => mempool.add(makeUserOp({ nonce: 1n }))).toThrow(UserOpValidationError);
});

// --- Replacement rules ---

it("Mempool - allows replacement with higher fees (same nonce)", () => {
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

  expect(mempool.size).toEqual(1);
  expect(hash1 !== hash2).toBeTruthy();
  // Old entry should be gone
  expect(mempool.get(hash1) === undefined).toBeTruthy();
});

it("Mempool - rejects replacement with insufficient fee increase", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(
    makeUserOp({
      maxPriorityFeePerGas: 2_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
    }),
  );

  // Try to replace with only a tiny increase (< 10%)
  expect(
    () =>
      mempool.add(
        makeUserOp({
          maxPriorityFeePerGas: 2_100_000_000n, // only 5% increase
          maxFeePerGas: 30_100_000_000n,
        }),
      ),
  ).toThrow("at least 10%");
  expect(
    () =>
      mempool.add(
        makeUserOp({
          maxPriorityFeePerGas: 2_100_000_000n, // only 5% increase
          maxFeePerGas: 30_100_000_000n,
        }),
      ),
  ).toThrow(UserOpValidationError);
});

it("Mempool - rejects replacement where maxFeePerGas delta is less than priority delta", () => {
  const mempool = new Mempool(makeMempoolConfig());
  mempool.add(
    makeUserOp({
      maxPriorityFeePerGas: 2_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
    }),
  );

  expect(
    () =>
      mempool.add(
        makeUserOp({
          maxPriorityFeePerGas: 3_000_000_000n, // +1 gwei
          maxFeePerGas: 30_500_000_000n,         // only +0.5 gwei, less than priority delta
        }),
      ),
  ).toThrow("maxFeePerGas must increase");
  expect(
    () =>
      mempool.add(
        makeUserOp({
          maxPriorityFeePerGas: 3_000_000_000n, // +1 gwei
          maxFeePerGas: 30_500_000_000n,         // only +0.5 gwei, less than priority delta
        }),
      ),
  ).toThrow(UserOpValidationError);
});

// --- Paymaster deposit reservation ---

it("Mempool - tracks paymaster deposit reservation", () => {
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
  expect(reserved > 0n, "Paymaster should have reserved deposit").toBeTruthy();
});

// --- Reputation ---

it("ReputationManager - starts with ok status", () => {
  const rm = new ReputationManager();
  expect(rm.getStatus("0x1234567890abcdef1234567890abcdef12345678", "sender")).toEqual("ok");
});

it("ReputationManager - throttles after too many seen without included", () => {
  const rm = new ReputationManager({ throttlingSlack: 5, banSlack: 20 });
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  // See 20 ops, include 0 → should be throttled (20 > 0*10 + 5 = 5)
  for (let i = 0; i < 20; i++) {
    rm.updateSeen(addr, "sender");
  }

  expect(rm.getStatus(addr, "sender")).toEqual("throttled");
});

it("ReputationManager - bans after many seen without included", () => {
  const rm = new ReputationManager({ throttlingSlack: 5, banSlack: 20 });
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  for (let i = 0; i < 25; i++) {
    rm.updateSeen(addr, "sender");
  }

  expect(rm.getStatus(addr, "sender")).toEqual("banned");
});

it("ReputationManager - included ops improve reputation", () => {
  const rm = new ReputationManager({ throttlingSlack: 5, banSlack: 20 });
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  // See many ops
  for (let i = 0; i < 20; i++) {
    rm.updateSeen(addr, "sender");
  }
  expect(rm.getStatus(addr, "sender")).toEqual("throttled");

  // Include many ops → should improve
  for (let i = 0; i < 5; i++) {
    rm.updateIncluded(addr, "sender");
  }
  // maxSeen = 5*10 + 5 = 55, opsSeen = 20 → ok
  expect(rm.getStatus(addr, "sender")).toEqual("ok");
});

it("ReputationManager - decay reduces counts", () => {
  const rm = new ReputationManager();
  const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  for (let i = 0; i < 100; i++) rm.updateSeen(addr, "sender");
  rm.decay();

  const entries = rm.dump();
  const entry = entries.find((e) => e.address === addr.toLowerCase());
  expect(entry!.opsSeen).toEqual(50); // halved
});

it("Mempool - does NOT reject a banned sender (custodial: reputation is a rate limit, not a block)", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const sender = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;

  // Force "banned" reputation. In this per-Safe custodial model the sender must still be able to
  // move its money — a banned sender is rate-limited (1 pending op), never hard-blocked.
  mempool.reputation.setReputation(sender, "sender", 100, 0, "banned");

  const hash = mempool.add(makeUserOp({ sender }));
  expect(typeof hash).toEqual("string");
  expect(mempool.size).toEqual(1);
});

it("Mempool - rejects banned paymaster", () => {
  const mempool = new Mempool(makeMempoolConfig());
  const pm = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

  mempool.reputation.setReputation(pm, "paymaster", 100, 0, "banned");

  expect(
    () =>
      mempool.add(
        makeUserOp({
          paymaster: pm,
          paymasterVerificationGasLimit: 50_000n,
          paymasterPostOpGasLimit: 30_000n,
        }),
      ),
  ).toThrow("banned");
  expect(
    () =>
      mempool.add(
        makeUserOp({
          paymaster: pm,
          paymasterVerificationGasLimit: 50_000n,
          paymasterPostOpGasLimit: 30_000n,
        }),
      ),
  ).toThrow(UserOpValidationError);
});

it("Mempool - dump returns all entries", () => {
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
  expect(dump.length).toEqual(2);
});
