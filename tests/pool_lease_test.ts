/**
 * Tests for the pool relayer lease layer (Stage 1 of docs/pool-queue-architecture.md).
 *
 * AccountService.leaseFreePoolEOA is not consumed by any runtime path yet — these
 * tests are its only caller and pin its contract before Stage 3 wires it in.
 */

import { it, expect } from "vitest";
import type { PublicClient, Transport, Chain } from "viem";
import { AccountService } from "../shared/account/index.ts";
import { LocalKeyManager } from "../shared/keys/local.ts";
import { derivePoolRelayerAddress, RELAYER_POOL_SIZE, RELAYER_ROUTING_WIDTH } from "../shared/keys/derive.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { KeyManager, KeyDerivationParams, DerivedEOA } from "../shared/keys/types.ts";

const TEST_SECRET =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`;

function mockConfig(): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: "https://rpc.example.com",
    publicRpcs: [],
    chainInfo: null,
    entryPointAddress: ENTRY_POINT,
    port: 3300,
    host: "0.0.0.0",
    bundlingMode: "auto",
    maxBundleSize: 10,
    maxBundleGas: 5000000n,
    minPriorityFeePerGas: 0n,
    minProfitMarginBps: 1000,
    maxProfitMarginBps: 15000,
    walletGasMarkup: 1.5,
    useEip1559: true,
    baseFeeMultiplier: 1.25,
    bundlerTipGwei: 0.5,
    autoBundleIntervalMs: 10000,
    operatorSecret: TEST_SECRET,
    oldOperatorSecrets: [],
    treasuryAddress: "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`,
    splitterAddress: "0x3979be163bFb74Dce66F8E0839577807C2197226" as `0x${string}`,
    apiRateLimitPerMinute: 60,
    rateLimitAllowlist: [],
    balanceReserveMultiplier: 1,
    alchemyApiKey: null,
    telegramBotToken: null,
    telegramChatId: null,
    treasuryAlertThresholdWei: 0n,
    treasuryAlertThresholdPathUsd: 0n,
  } as BundlerConfig;
}

/** Fake read client: every pool EOA reads latest == pending == 0 (fresh, ACTIVE). */
function freshNonceClient(): PublicClient<Transport, Chain> {
  return {
    getTransactionCount: () => Promise.resolve(0),
  } as unknown as PublicClient<Transport, Chain>;
}

/** Fake read client with per-address nonce scripts (default: fresh 0/0). */
function scriptedNonceClient(
  script: Record<string, { latest: number; pending: number }>,
): PublicClient<Transport, Chain> {
  return {
    getTransactionCount: ({ address, blockTag }: { address: `0x${string}`; blockTag: "latest" | "pending" }) => {
      const s = script[address.toLowerCase()] ?? { latest: 0, pending: 0 };
      return Promise.resolve(s[blockTag]);
    },
  } as unknown as PublicClient<Transport, Chain>;
}

function makeService(keyManager?: KeyManager): AccountService {
  return new AccountService({
    keyManager: keyManager ?? new LocalKeyManager({ operatorSecret: TEST_SECRET }),
    config: mockConfig(),
  });
}

it("leaseFreePoolEOA - leases pool #0 first and holds the bundle lock", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  const lease = await svc.leaseFreePoolEOA(client);
  expect(lease).not.toBeNull();
  expect(lease!.index).toEqual(0);
  expect(lease!.eoa.address).toEqual(await derivePoolRelayerAddress(TEST_SECRET, 0));

  const state = svc.lockManager.getState(lease!.eoa.address);
  expect(state?.status).toEqual("LOCKED_IN_MEMORY_PENDING");
  expect(state?.bundleLock).toBeTruthy();
});

it("leaseFreePoolEOA - second lease gets the next free index", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  const lease0 = await svc.leaseFreePoolEOA(client);
  const lease1 = await svc.leaseFreePoolEOA(client);
  expect(lease0!.index).toEqual(0);
  expect(lease1!.index).toEqual(1);
  expect(lease1!.eoa.address).not.toEqual(lease0!.eoa.address);
});

it("leaseFreePoolEOA - release frees the EOA for the next lease", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  const lease0 = await svc.leaseFreePoolEOA(client);
  lease0!.release();
  expect(svc.lockManager.getState(lease0!.eoa.address)?.status).toEqual("ACTIVE");

  const again = await svc.leaseFreePoolEOA(client);
  expect(again!.index).toEqual(0);
});

it("leaseFreePoolEOA - release is lease-scoped: a stale release cannot free the next holder's lock", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  const leaseA = await svc.leaseFreePoolEOA(client);
  leaseA!.release();
  leaseA!.release(); // double release before re-lease: no-op

  const leaseB = await svc.leaseFreePoolEOA(client);
  expect(leaseB!.index).toEqual(0);

  // The dangerous path: A's stale release AFTER #0 was re-leased to B. A by-address
  // release would clear B's lock and double-lease the EOA (nonce collision in
  // Stage 3); the lease-scoped flag must make this a no-op.
  leaseA!.release();
  const state = svc.lockManager.getState(leaseB!.eoa.address);
  expect(state?.bundleLock).toBeTruthy();
  expect(state?.status).toEqual("LOCKED_IN_MEMORY_PENDING");

  const next = await svc.leaseFreePoolEOA(client);
  expect(next!.index).toEqual(1); // #0 still exclusively B's
});

it("leaseFreePoolEOA - skips an EOA that seeds LOCKED_PENDING_UNKNOWN (pending > latest at first sight)", async () => {
  // The seeding initEOA's own nonce comparison must keep an EOA with an unknown
  // in-flight tx (e.g. a treasury top-up or pre-restart broadcast) out of the pool.
  const svc = makeService();
  const addr0 = await derivePoolRelayerAddress(TEST_SECRET, 0);
  const client = scriptedNonceClient({ [addr0]: { latest: 5, pending: 6 } });

  const lease = await svc.leaseFreePoolEOA(client);
  expect(lease!.index).toEqual(1);

  const state0 = svc.lockManager.getState(addr0);
  expect(state0?.status).toEqual("LOCKED_PENDING_UNKNOWN");
  expect(state0?.latestNonce).toEqual(5);
  expect(state0?.pendingNonce).toEqual(6);
});

it("leaseFreePoolEOA - ignores reservations and release preserves them", async () => {
  // Layering contract: the lease is nonce/concurrency control only. Balance
  // accounting (reservedBalance) neither blocks a lease nor is touched by release —
  // balance gating is the Stage-3 caller's job.
  const svc = makeService();
  const client = freshNonceClient();

  const addr0 = await derivePoolRelayerAddress(TEST_SECRET, 0);
  await svc.lockManager.initEOA(addr0, client);
  svc.reserveBalance(addr0, 12345n);

  const lease = await svc.leaseFreePoolEOA(client);
  expect(lease!.index).toEqual(0);
  lease!.release();
  expect(svc.lockManager.getReservedBalance(addr0)).toEqual(12345n);
});

it("leaseFreePoolEOA - skips an EOA locked with an in-flight tx (LOCKED_PENDING_UNKNOWN)", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  const addr0 = await derivePoolRelayerAddress(TEST_SECRET, 0);
  await svc.lockManager.initEOA(addr0, client);
  svc.lockManager.lockEOA(addr0, "LOCKED_PENDING_UNKNOWN", 5);

  const lease = await svc.leaseFreePoolEOA(client);
  expect(lease!.index).toEqual(1);
});

it("leaseFreePoolEOA - release after a broadcast lock does NOT unlock the EOA", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  const lease = await svc.leaseFreePoolEOA(client);
  // Stage-3 broadcast path: transition to in-flight tracking while still holding the lease.
  svc.lockManager.lockEOA(lease!.eoa.address, "LOCKED_PENDING_UNKNOWN", 7);
  lease!.release();

  const state = svc.lockManager.getState(lease!.eoa.address);
  expect(state?.status).toEqual("LOCKED_PENDING_UNKNOWN");
  expect(state?.inFlightNonce).toEqual(7);

  // And the pool skips it.
  const next = await svc.leaseFreePoolEOA(client);
  expect(next!.index).toEqual(1);
});

it("leaseFreePoolEOA - returns null when the whole pool is busy, leases resume after release", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  // The lease scan covers the ACTIVE routing width (default RELAYER_ROUTING_WIDTH), NOT the full
  // key ceiling RELAYER_POOL_SIZE — new traffic only lands on [0, width-1].
  const width = RELAYER_ROUTING_WIDTH;
  expect(width).toBeLessThanOrEqual(RELAYER_POOL_SIZE);
  const leases = [];
  for (let i = 0; i < width; i++) {
    const lease = await svc.leaseFreePoolEOA(client);
    expect(lease, `lease #${i}`).not.toBeNull();
    expect(lease!.index).toEqual(i);
    leases.push(lease!);
  }

  expect(await svc.leaseFreePoolEOA(client)).toBeNull();

  const freeIdx = Math.min(4, width - 1);
  leases[freeIdx]!.release();
  const freed = await svc.leaseFreePoolEOA(client);
  expect(freed!.index).toEqual(freeIdx);
});

it("leaseFreePoolEOA - concurrent leases never hand out the same EOA", async () => {
  const svc = makeService();
  const client = freshNonceClient();

  const leases = await Promise.all(
    Array.from({ length: 10 }, () => svc.leaseFreePoolEOA(client)),
  );
  const indices = leases.map((l) => l!.index);
  expect(new Set(indices).size).toEqual(10);
  const addrs = leases.map((l) => l!.eoa.address);
  expect(new Set(addrs).size).toEqual(10);
});

it("getPoolEOA - memoizes: at most one derivation per index across repeated leases", async () => {
  const inner = new LocalKeyManager({ operatorSecret: TEST_SECRET });
  const deriveCounts = new Map<number, number>();
  const counting: KeyManager = {
    deriveEOA: (params: KeyDerivationParams) => inner.deriveEOA(params),
    derivePoolEOA: (index: number): Promise<DerivedEOA> => {
      deriveCounts.set(index, (deriveCounts.get(index) ?? 0) + 1);
      return inner.derivePoolEOA(index);
    },
    getOldSecrets: () => inner.getOldSecrets(),
  };
  const svc = makeService(counting);
  const client = freshNonceClient();

  const lease = await svc.leaseFreePoolEOA(client);
  lease!.release();
  await svc.leaseFreePoolEOA(client); // re-leases #0 — must reuse the cached derivation
  await svc.leaseFreePoolEOA(client); // leases #1

  expect(deriveCounts.get(0)).toEqual(1);
  expect(deriveCounts.get(1)).toEqual(1);
});
