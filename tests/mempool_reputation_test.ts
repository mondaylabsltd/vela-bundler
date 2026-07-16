/**
 * Regression tests for the custodial reputation policy (audit finding #1): a sender Safe must
 * NEVER be hard-banned out of moving its money — reputation for senders is a rate limit, not a
 * block. (Factory/paymaster — shared entities — remain bannable; covered elsewhere.)
 */

import { it, expect } from "vitest";
import { Mempool } from "../shared/mempool/index.ts";
import { UserOpValidationError } from "../shared/userop/validate.ts";
import type { UserOperation } from "../shared/userop/types.ts";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;
const SENDER = "0x1111111111111111111111111111111111111111" as `0x${string}`;

function makeOp(overrides: Partial<UserOperation> = {}): UserOperation {
  return {
    sender: SENDER, nonce: 0n, factory: null, factoryData: null,
    callData: "0xdeadbeef", callGasLimit: 100_000n, verificationGasLimit: 200_000n,
    preVerificationGas: 60_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
    paymaster: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, paymasterData: null,
    signature: ("0x" + "ab".repeat(65)) as `0x${string}`,
    ...overrides,
  };
}

function newMempool(): Mempool {
  return new Mempool({ entryPointAddress: ENTRY_POINT, chainId: 1, maxMempoolSize: 100, stakedSenderMaxOps: 4 });
}

it("mempool - a BANNED sender is NOT rejected (custodial: reputation is a rate limit, not a block)", () => {
  const mp = newMempool();
  // Force the sender into a banned reputation status.
  mp.reputation.setReputation(SENDER, "sender", 1000, 0, "banned");
  expect(mp.reputation.isBanned(SENDER, "sender")).toEqual(true);
  // The op must still be accepted — the user can move their money.
  const hash = mp.add(makeOp());
  expect(typeof hash).toEqual("string");
  expect(mp.size).toEqual(1);
});

it("mempool - a penalized sender is rate-limited to 1 pending op (not blocked)", () => {
  const mp = newMempool();
  mp.reputation.setReputation(SENDER, "sender", 1000, 0, "banned");
  mp.add(makeOp({ nonce: 0n })); // first op accepted
  // A SECOND concurrent op while one is pending is rate-limited (throttle), not a permanent block.
  expect(() => mp.add(makeOp({ nonce: 1n }))).toThrow("rate-limited");
  expect(() => mp.add(makeOp({ nonce: 1n }))).toThrow(UserOpValidationError);
  // Once the first clears, the sender can submit again.
  mp.remove(mp.dump()[0]!.userOpHash);
  const hash = mp.add(makeOp({ nonce: 1n }));
  expect(typeof hash).toEqual("string");
});

it("mempool - a TTL-evicted op fires the eviction hook (feeds a terminal failed receipt)", () => {
  const mp = newMempool();
  const evicted: string[] = [];
  mp.setTtlEvictionHook((e) => evicted.push(e.userOpHash));
  const hash = mp.add(makeOp());
  // Backdate the entry past the 5-min TTL (entries are live objects in the map).
  // The TTL keys off firstSeenAt (age survives fee-bump replacements — open issue #3).
  const entry = mp.dump()[0]!;
  (entry as { addedAt: number }).addedAt = Date.now() - 10 * 60 * 1000;
  (entry as { firstSeenAt: number }).firstSeenAt = Date.now() - 10 * 60 * 1000;
  mp.getAll(); // triggers TTL eviction + hook
  expect(mp.size).toEqual(0);
  expect(evicted).toEqual([hash]);
});

it("reputation.countPenalized - counts banned/throttled senders for the alert", () => {
  const mp = newMempool();
  mp.reputation.setReputation("0x" + "a1".repeat(20) as `0x${string}`, "sender", 1000, 0, "banned");
  mp.reputation.setReputation("0x" + "b2".repeat(20) as `0x${string}`, "sender", 30, 0, "throttled");
  mp.reputation.setReputation("0x" + "c3".repeat(20) as `0x${string}`, "sender", 1, 0, "ok");
  const c = mp.reputation.countPenalized("sender");
  expect(c.banned).toEqual(1);
  expect(c.throttled).toEqual(1);
});
