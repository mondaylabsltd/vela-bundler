/**
 * Stage 2 vault-mode tests (docs/pool-queue-architecture.md):
 *  - settlementVaultEnabledFor per-chain canary semantics
 *  - the three recipient sites move together (quote RPC + /v1/account REST; the
 *    bundle-gate beneficiary shares the same helper)
 *  - dual-accept: reimbursement legs to the OLD per-safe EOA still count in vault mode
 *  - SponsorService.topUpPoolEOAs: float refill, cooldown, caps, treasury floor,
 *    in-flight dedup, round-robin cursor, Tempo skip
 */

import { it, expect } from "vitest";
import { getAddress, parseAbi, concat, encodePacked, encodeFunctionData, type Hex } from "viem";
import { settlementVaultEnabledFor } from "../shared/config/vault.ts";
import { parseTempoReimbursement, parseInBandReimbursement, vaultActiveForChain, inBandActiveForChain } from "../shared/tempo.ts";
import { handleRpcMethod } from "../shared/rpc/handlers.ts";
import { handleRestApi } from "../shared/rpc/rest-api.ts";
import { SponsorService } from "../shared/account/sponsor.ts";
import type { BundlerConfig } from "../shared/config/types.ts";
import type { ChainRegistryLike } from "../shared/chain/index.ts";
import type { Alerter } from "../shared/monitoring/telegram.ts";

const TREASURY = getAddress("0x" + "cc".repeat(20));
const EOA = getAddress("0x1111111111111111111111111111111111111111");
const PATHUSD = getAddress("0x20c0000000000000000000000000000000000000");

// --- settlementVaultEnabledFor -----------------------------------------------

it("settlementVaultEnabledFor - off by default, on for 'true'/'all', per-chain for id lists", () => {
  expect(settlementVaultEnabledFor(undefined, 1)).toEqual(false);
  expect(settlementVaultEnabledFor("", 1)).toEqual(false);
  expect(settlementVaultEnabledFor("false", 1)).toEqual(false);

  expect(settlementVaultEnabledFor("true", 1)).toEqual(true);
  expect(settlementVaultEnabledFor("TRUE", 4217)).toEqual(true);
  expect(settlementVaultEnabledFor("all", 8453)).toEqual(true);

  expect(settlementVaultEnabledFor("4217,8453", 4217)).toEqual(true);
  expect(settlementVaultEnabledFor("4217, 8453", 8453)).toEqual(true);
  expect(settlementVaultEnabledFor("4217,8453", 1)).toEqual(false);
  expect(settlementVaultEnabledFor("4217", 42170)).toEqual(false); // no prefix match

  // Garbage never enables anything.
  expect(settlementVaultEnabledFor("yes", 1)).toEqual(false);
  expect(settlementVaultEnabledFor("8453x", 8453)).toEqual(false);
  expect(settlementVaultEnabledFor(",,", 0)).toEqual(false);
});

it("vaultActiveForChain - follows the spec, Tempo INCLUDED (pathUSD float refill exists)", () => {
  expect(vaultActiveForChain("true", 4217)).toEqual(true);
  expect(vaultActiveForChain("all", 42431)).toEqual(true);
  expect(vaultActiveForChain("4217", 4217)).toEqual(true);
  expect(vaultActiveForChain("true", 8453)).toEqual(true);
  expect(vaultActiveForChain("8453", 8453)).toEqual(true);
  expect(vaultActiveForChain("", 8453)).toEqual(false);
  expect(vaultActiveForChain("", 4217)).toEqual(false);
});

it("inBandActiveForChain - combines Tempo, the config boolean, and the INBAND_ENABLED spec", () => {
  // Tempo: always in-band, regardless of any spec.
  expect(inBandActiveForChain({}, 4217)).toEqual(true);
  expect(inBandActiveForChain({ inBandChains: "false" }, 4217)).toEqual(true);
  // Generic chains: off with no enable source…
  expect(inBandActiveForChain({}, 42161)).toEqual(false);
  // …on via the per-chain config boolean (tests / registry-driven configs)…
  expect(inBandActiveForChain({ inBandEnabled: true }, 42161)).toEqual(true);
  // …and on via the env spec — "all" is the production default (all chains in-band).
  expect(inBandActiveForChain({ inBandChains: "all" }, 42161)).toEqual(true);
  expect(inBandActiveForChain({ inBandChains: "42161" }, 42161)).toEqual(true);
  expect(inBandActiveForChain({ inBandChains: "8453" }, 42161)).toEqual(false);
  expect(inBandActiveForChain({ inBandChains: "false" }, 42161)).toEqual(false);
});

// --- Dual-accept: both recipients' legs count (BOTH directions) ---------------
// The gate credits beneficiary + the OTHER operator recipient: the EOA while vault
// is on (lagging wallets), the treasury while it is off (canary rollback — ops
// signed for the treasury must not strand until TTL). The sums below pin exactly
// what the gate adds up in each direction.

const erc20 = parseAbi(["function transfer(address to, uint256 amount)"]);
const multiSend = parseAbi(["function multiSend(bytes transactions)"]);
const execUserOp = parseAbi([
  "function executeUserOp(address to, uint256 value, bytes data, uint8 operation)",
]);
const MULTI_SEND = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526" as const;

function packTx(to: Hex, value: bigint, data: Hex): Hex {
  const len = BigInt((data.length - 2) / 2);
  return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, value, len, data]);
}
function buildBatch(calls: { to: Hex; value?: bigint; data: Hex }[]): Hex {
  const packed = concat(calls.map((c) => packTx(c.to, c.value ?? 0n, c.data)));
  const msData = encodeFunctionData({ abi: multiSend, functionName: "multiSend", args: [packed] });
  return encodeFunctionData({ abi: execUserOp, functionName: "executeUserOp", args: [MULTI_SEND, 0n, msData, 1] });
}
const transfer = (to: Hex, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] });

it("dual-accept (Tempo): treasury leg + old-EOA leg sum exactly as the vault gate sums them", () => {
  // Old-wallet shape: EOA cost-floor leg + treasury surplus leg in one batch.
  const callData = buildBatch([
    { to: PATHUSD, data: transfer(EOA, 700n) },
    { to: PATHUSD, data: transfer(TREASURY, 500n) },
  ]);
  // Vault gate: parse(beneficiary=treasury) + parse(dualAcceptEOA=eoa).
  const credited = parseTempoReimbursement(callData, TREASURY, PATHUSD) +
    parseTempoReimbursement(callData, EOA, PATHUSD);
  expect(credited).toEqual(1200n);
  // Pre-vault gate saw only the EOA leg.
  expect(parseTempoReimbursement(callData, EOA, PATHUSD)).toEqual(700n);
});

it("dual-accept (generic in-band): native + allowlisted-stable legs to either recipient merge", () => {
  const callData = buildBatch([
    { to: EOA, value: 900n, data: "0x" }, // old wallet: native to the EOA
    { to: PATHUSD, data: transfer(TREASURY, 300n) }, // new wallet: stable to the treasury
  ]);
  const toTreasury = parseInBandReimbursement(callData, TREASURY, [PATHUSD]);
  const toEOA = parseInBandReimbursement(callData, EOA, [PATHUSD]);
  expect(toTreasury.native + toEOA.native).toEqual(900n);
  expect((toTreasury.byToken[PATHUSD.toLowerCase()] ?? 0n) + (toEOA.byToken[PATHUSD.toLowerCase()] ?? 0n)).toEqual(300n);
});

// --- Quote RPC + REST recipient move together --------------------------------

function quoteConfig(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
  return {
    chainId: 0,
    rpcUrl: "",
    chainInfo: null,
    entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    treasuryAddress: TREASURY,
    inBandEnabled: true,
    operatorSecret: "0x" + "ab".repeat(32),
    ...overrides,
  } as unknown as BundlerConfig;
}

function fakeRegistry(): ChainRegistryLike {
  const chain = {
    chainId: 8453,
    chainInfo: null,
    rpcUrl: "http://chain-rpc.invalid",
    publicRpcs: [],
    accountService: {
      deriveEOA: async () => ({ address: EOA.toLowerCase() as `0x${string}` }),
      getAccountInfo: async () => ({
        chainId: 8453,
        entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`,
        safeAddress: "0x" + "aa".repeat(20) as `0x${string}`,
        activeDepositAddress: EOA.toLowerCase() as `0x${string}`,
        oldDepositAddresses: [],
        onchainBalance: 0n,
        reservedBalance: 0n,
        spendableBalance: 0n,
        latestNonce: 0,
        pendingNonce: 0,
        status: "ACTIVE",
      }),
    },
  };
  return {
    getChain: async () => chain,
    getAll: () => [chain],
  } as unknown as ChainRegistryLike;
}

it("vela_getInBandGasQuote - recipient is the EOA normally, the treasury in vault mode", async () => {
  const params = [{ safeAddress: "0x" + "aa".repeat(20), nativeCost: "1000" }];

  const off = await handleRpcMethod(
    "vela_getInBandGasQuote", params, quoteConfig(), fakeRegistry(), { chainId: 8453 },
  ) as { recipient: string; requiredAmount: string };
  expect(off.recipient.toLowerCase()).toEqual(EOA.toLowerCase());
  // Tiny nativeCost=1000: 3× markup (3000 wei) is far below the 1e-5-native floor (1e13 wei on an
  // 18-dec chain), so the floor binds. Recipient routing — the point of this test — is unaffected.
  expect(BigInt(off.requiredAmount)).toEqual(10_000_000_000_000n);

  const on = await handleRpcMethod(
    "vela_getInBandGasQuote", params, quoteConfig({ settlementVaultChains: "8453" }), fakeRegistry(), { chainId: 8453 },
  ) as { recipient: string };
  expect(on.recipient.toLowerCase()).toEqual(TREASURY.toLowerCase());

  // Vault on for a DIFFERENT chain — this chain keeps the EOA.
  const other = await handleRpcMethod(
    "vela_getInBandGasQuote", params, quoteConfig({ settlementVaultChains: "4217" }), fakeRegistry(), { chainId: 8453 },
  ) as { recipient: string };
  expect(other.recipient.toLowerCase()).toEqual(EOA.toLowerCase());
});

it("GET /v1/account - settlementRecipient follows the vault flag, activeDepositAddress never moves", async () => {
  const url = new URL(`https://x/v1/account/8453/${"0x" + "aa".repeat(20)}`);
  const req = new Request(url, { method: "GET" });
  const rl = { rateLimitPerMinute: 1000 };

  const off = await handleRestApi(req, url, fakeRegistry(), quoteConfig(), rl);
  const offBody = await off!.json() as { activeDepositAddress: string; settlementRecipient: string };
  expect(offBody.settlementRecipient.toLowerCase()).toEqual(EOA.toLowerCase());
  expect(offBody.activeDepositAddress.toLowerCase()).toEqual(EOA.toLowerCase());

  const on = await handleRestApi(req, url, fakeRegistry(), quoteConfig({ settlementVaultChains: "true" }), rl);
  const onBody = await on!.json() as { activeDepositAddress: string; settlementRecipient: string };
  expect(onBody.settlementRecipient.toLowerCase()).toEqual(TREASURY.toLowerCase());
  // The deposit/funding address is a DIFFERENT concern and must not move with the flag.
  expect(onBody.activeDepositAddress.toLowerCase()).toEqual(EOA.toLowerCase());
});

it("GET /v1/treasury/:chainId - balance + bootstrapNeeded signal", async () => {
  const url = new URL("https://x/v1/treasury/8453");
  const req = new Request(url, { method: "GET" });
  const rl = { rateLimitPerMinute: 1000 };

  // Depleted treasury (below the 0.01-native floor) → bootstrapNeeded.
  const stubLow = stubRpc({ balances: {}, treasuryBalance: 10n ** 15n });
  try {
    const res = await handleRestApi(req, url, fakeRegistry(), quoteConfig(), rl);
    const body = await res!.json() as { address: string; asset: string; balance: string; bootstrapNeeded: boolean };
    expect(body.address.toLowerCase()).toEqual(TREASURY.toLowerCase());
    expect(body.asset).toEqual("native");
    expect(BigInt(body.balance)).toEqual(10n ** 15n);
    expect(body.bootstrapNeeded).toEqual(true);
  } finally {
    stubLow.restore();
  }

  // Healthy treasury → no bootstrap.
  const stubOk = stubRpc({ balances: {}, treasuryBalance: 10n ** 18n });
  try {
    const res = await handleRestApi(req, url, fakeRegistry(), quoteConfig(), rl);
    const body = await res!.json() as { bootstrapNeeded: boolean };
    expect(body.bootstrapNeeded).toEqual(false);
  } finally {
    stubOk.restore();
  }
});

// --- topUpPoolEOAs ------------------------------------------------------------

const GAS_PRICE = 1_000_000_000n; // 1 gwei

function topUpConfig(overrides: Partial<BundlerConfig> = {}): BundlerConfig {
  return {
    chainId: 1,
    rpcUrl: "http://pool-topup.invalid",
    operatorSecret: "0x" + "ab".repeat(32),
    treasuryAddress: TREASURY,
    telegramBotToken: null,
    telegramChatId: null,
    ...overrides,
  } as unknown as BundlerConfig;
}

function fakeAlerter(): { alerter: Alerter; ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    alerter: { send: (id: string) => { ids.push(id); return Promise.resolve(true); } } as unknown as Alerter,
  };
}

/** Pool address for index i: 0x00..0<i+1> style fake (never derived). */
const poolAddr = (i: number): `0x${string}` =>
  ("0x" + (i + 1).toString(16).padStart(40, "0")) as `0x${string}`;

function stubRpc(opts: {
  balances: Record<string, bigint>;
  treasuryBalance?: bigint;
}): { sends: { to: string; value: bigint }[]; indices: () => void; restore: () => void } {
  const real = globalThis.fetch;
  const sends: { to: string; value: bigint }[] = [];

  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "eth_chainId": return "0x1";
      case "eth_blockNumber": return "0x1";
      case "eth_getTransactionCount": return "0x0";
      case "eth_gasPrice": return "0x" + GAS_PRICE.toString(16);
      case "eth_maxPriorityFeePerGas": return "0x" + GAS_PRICE.toString(16);
      case "eth_getBalance": {
        const addr = String((params as string[])[0]).toLowerCase();
        if (addr === TREASURY.toLowerCase()) {
          return "0x" + (opts.treasuryBalance ?? 10n ** 18n).toString(16);
        }
        return "0x" + (opts.balances[addr] ?? 0n).toString(16);
      }
      case "eth_sendRawTransaction": {
        // We can't trivially decode the raw tx; record the call. Value/recipient are
        // asserted indirectly via counts + in-flight behavior.
        sends.push({ to: "raw", value: 0n });
        return "0x" + "12".repeat(32);
      }
      default: throw new Error(`unstubbed RPC method: ${method}`);
    }
  };

  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const bodyP = input instanceof Request ? input.text() : Promise.resolve(String(init?.body ?? ""));
    return bodyP.then((raw) => {
      const body = JSON.parse(raw);
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params) };
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } };
        }
      };
      const payload = Array.isArray(body) ? body.map(one) : one(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }) as typeof fetch;

  return { sends, indices: () => {}, restore: () => { globalThis.fetch = real; } };
}

it("topUpPoolEOAs - tops up low pool EOAs, skips funded ones", async () => {
  // Pool of 10: #0 and #3 far below min, others at target.
  const balances: Record<string, bigint> = {};
  for (let i = 0; i < 10; i++) {
    balances[poolAddr(i)] = i === 0 || i === 3 ? 10n ** 14n : 2n * 10n ** 15n;
  }
  const stub = stubRpc({ balances });
  try {
    const svc = new SponsorService(topUpConfig(), fakeAlerter().alerter);
    const res = await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    expect(res.checked).toEqual(10);
    expect(res.toppedUp).toEqual(2);
    expect(stub.sends.length).toEqual(2);
  } finally {
    stub.restore();
  }
});

it("topUpPoolEOAs - sweep cooldown: immediate second call is a no-op", async () => {
  const stub = stubRpc({ balances: { [poolAddr(0)]: 0n } });
  try {
    const svc = new SponsorService(topUpConfig(), fakeAlerter().alerter);
    await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    const second = await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    expect(second.reason).toEqual("sweep_cooldown");
    expect(second.checked).toEqual(0);
  } finally {
    stub.restore();
  }
});

it("topUpPoolEOAs - Tempo chains are skipped entirely", async () => {
  const svc = new SponsorService(topUpConfig(), fakeAlerter().alerter);
  const res = await svc.topUpPoolEOAs(4217, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
  expect(res.reason).toEqual("tempo_skipped");
});

it("topUpPoolEOAs - fails closed + alerts when the treasury would breach its floor", async () => {
  // Treasury exactly at the floor: floor + amount + gas can't fit.
  const stub = stubRpc({ balances: { [poolAddr(0)]: 0n }, treasuryBalance: 10n ** 16n });
  const { alerter, ids } = fakeAlerter();
  try {
    const svc = new SponsorService(topUpConfig(), alerter);
    const res = await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    expect(res.toppedUp).toEqual(0);
    expect(stub.sends.length).toEqual(0);
    expect(ids.some((id) => id.startsWith("pool-topup-depleted"))).toBeTruthy();
  } finally {
    stub.restore();
  }
});

it("topUpPoolEOAs - at most 3 sends per sweep even when the whole batch is dry", async () => {
  const balances: Record<string, bigint> = {};
  for (let i = 0; i < 10; i++) balances[poolAddr(i)] = 0n;
  const stub = stubRpc({ balances });
  try {
    const svc = new SponsorService(topUpConfig(), fakeAlerter().alerter);
    const res = await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    expect(res.toppedUp).toEqual(3);
    expect(stub.sends.length).toEqual(3);
  } finally {
    stub.restore();
  }
});

it("topUpPoolEOAs - a topped-up EOA is in-flight-skipped on the next sweep (no double-fund)", async () => {
  const balances: Record<string, bigint> = { [poolAddr(0)]: 0n };
  for (let i = 1; i < 10; i++) balances[poolAddr(i)] = 2n * 10n ** 15n;
  const stub = stubRpc({ balances });
  try {
    const svc = new SponsorService(topUpConfig(), fakeAlerter().alerter);
    const first = await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    expect(first.toppedUp).toEqual(1);

    // Force the cooldown open; the stub still reports #0 as empty (tx "not landed").
    (svc as unknown as { lastTopUpSweepAt: number }).lastTopUpSweepAt = 0;
    const second = await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    expect(second.toppedUp).toEqual(0);
    expect(stub.sends.length).toEqual(1);
  } finally {
    stub.restore();
  }
});

it("topUpPoolEOAs - round-robin cursor advances across sweeps", async () => {
  const seen: number[] = [];
  const balances: Record<string, bigint> = {};
  for (let i = 0; i < 20; i++) balances[poolAddr(i)] = 2n * 10n ** 15n;
  const stub = stubRpc({ balances });
  try {
    const svc = new SponsorService(topUpConfig(), fakeAlerter().alerter);
    const at = async (i: number) => { seen.push(i); return poolAddr(i); };
    await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", at, 20);
    (svc as unknown as { lastTopUpSweepAt: number }).lastTopUpSweepAt = 0;
    await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", at, 20);
    expect(seen.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seen.slice(10)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  } finally {
    stub.restore();
  }
});

it("topUpPoolEOAs - 24h budget ceiling defers oversized refills", async () => {
  // Target above the 1-native daily cap → the sweep must not send at all.
  const stub = stubRpc({ balances: { [poolAddr(0)]: 0n }, treasuryBalance: 10n ** 20n });
  try {
    const svc = new SponsorService(
      topUpConfig({ poolFloatTargetWei: 2n * 10n ** 18n, poolFloatMinWei: 10n ** 15n }),
      fakeAlerter().alerter,
    );
    const res = await svc.topUpPoolEOAs(1, "http://pool-topup.invalid", async (i) => poolAddr(i), 10);
    expect(res.toppedUp).toEqual(0);
    expect(stub.sends.length).toEqual(0);
  } finally {
    stub.restore();
  }
});
