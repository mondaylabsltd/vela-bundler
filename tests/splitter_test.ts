/**
 * Tests for the VelaGasSettlementSplitter CREATE2 derivation.
 *
 * The golden vectors below are shared with the Foundry test
 * (evm_contracts/test/VelaGasSettlementSplitterCreate2.t.sol) and the wallet
 * (vela-wallet/src/__tests__/services/safe-address.test.ts). All three MUST agree, or the
 * bundler pays a beneficiary the wallet never deploys.
 */

import { assertEquals } from "@std/assert";
import { keccak256 } from "viem";
import {
  computeSplitterAddress,
  SPLITTER_CREATION_CODE,
  SPLITTER_CREATION_CODE_HASH,
  SPLITTER_FACTORY,
  SPLITTER_SALT,
  splitterDeployCalldata,
  splitterInitCode,
} from "../shared/contracts/splitter.ts";

// Golden cross-repo vectors (see the Foundry + wallet tests for the identical values).
const TREASURY_A = "0x1111111111111111111111111111111111111111" as const;
const SPLITTER_A = "0x3979be163bFb74Dce66F8E0839577807C2197226" as const;
const TREASURY_B = "0x000000000000000000000000000000000000dEaD" as const;
const SPLITTER_B = "0xdC95900610B854aB0c9B57A74B0f5bB67dDDB3B4" as const;

Deno.test("splitter - creation code hash is pinned to the deployed build", () => {
  assertEquals(keccak256(SPLITTER_CREATION_CODE), SPLITTER_CREATION_CODE_HASH);
});

Deno.test("splitter - salt is keccak256('vela.gas-settlement-splitter.v1')", () => {
  assertEquals(SPLITTER_SALT, "0x650cb20978a0e7efdcf6f077240c609a59f2f02401ed16fb4a222a2b51cb9720");
});

Deno.test("splitter - factory is the Arachnid deterministic-deployment proxy", () => {
  assertEquals(SPLITTER_FACTORY, "0x4e59b44847b379578588920cA78FbF26c0B4956C");
});

Deno.test("splitter - computeSplitterAddress matches the golden cross-repo vectors", () => {
  assertEquals(computeSplitterAddress(TREASURY_A), SPLITTER_A);
  assertEquals(computeSplitterAddress(TREASURY_B), SPLITTER_B);
});

Deno.test("splitter - address is treasury-dependent (constructor arg is part of the address)", () => {
  const a = computeSplitterAddress(TREASURY_A);
  const b = computeSplitterAddress(TREASURY_B);
  assertEquals(a === b, false);
});

Deno.test("splitter - address is deterministic (case-insensitive on treasury input)", () => {
  const lower = computeSplitterAddress(TREASURY_A.toLowerCase() as `0x${string}`);
  const mixed = computeSplitterAddress(TREASURY_A);
  assertEquals(lower, mixed);
});

Deno.test("splitter - initCode = creationCode ++ abi.encode(treasury)", () => {
  const initCode = splitterInitCode(TREASURY_A);
  // creationCode (unchanged prefix) + 32-byte left-padded treasury.
  assertEquals(initCode.startsWith(SPLITTER_CREATION_CODE), true);
  const tail = initCode.slice(SPLITTER_CREATION_CODE.length);
  assertEquals(tail, "000000000000000000000000" + TREASURY_A.slice(2));
});

Deno.test("splitter - deploy calldata = salt(32) ++ initCode (Arachnid raw form)", () => {
  const data = splitterDeployCalldata(TREASURY_A);
  assertEquals(data.startsWith(SPLITTER_SALT), true);
  assertEquals(data.slice(SPLITTER_SALT.length), splitterInitCode(TREASURY_A).slice(2));
});
