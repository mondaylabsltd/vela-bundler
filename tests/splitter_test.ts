/**
 * Tests for the VelaGasSettlementSplitter CREATE2 derivation.
 *
 * The golden vectors below are shared with the Foundry test
 * (evm_contracts/test/VelaGasSettlementSplitterCreate2.t.sol) and the wallet
 * (vela-wallet/src/__tests__/services/safe-address.test.ts). All three MUST agree, or the
 * bundler pays a beneficiary the wallet never deploys.
 */

import { it, expect } from "vitest";
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

it("splitter - creation code hash is pinned to the deployed build", () => {
  expect(keccak256(SPLITTER_CREATION_CODE)).toEqual(SPLITTER_CREATION_CODE_HASH);
});

it("splitter - salt is keccak256('vela.gas-settlement-splitter.v1')", () => {
  expect(SPLITTER_SALT).toEqual("0x650cb20978a0e7efdcf6f077240c609a59f2f02401ed16fb4a222a2b51cb9720");
});

it("splitter - factory is the Arachnid deterministic-deployment proxy", () => {
  expect(SPLITTER_FACTORY).toEqual("0x4e59b44847b379578588920cA78FbF26c0B4956C");
});

it("splitter - computeSplitterAddress matches the golden cross-repo vectors", () => {
  expect(computeSplitterAddress(TREASURY_A)).toEqual(SPLITTER_A);
  expect(computeSplitterAddress(TREASURY_B)).toEqual(SPLITTER_B);
});

it("splitter - address is treasury-dependent (constructor arg is part of the address)", () => {
  const a = computeSplitterAddress(TREASURY_A);
  const b = computeSplitterAddress(TREASURY_B);
  expect(a === b).toEqual(false);
});

it("splitter - address is deterministic (case-insensitive on treasury input)", () => {
  const lower = computeSplitterAddress(TREASURY_A.toLowerCase() as `0x${string}`);
  const mixed = computeSplitterAddress(TREASURY_A);
  expect(lower).toEqual(mixed);
});

it("splitter - initCode = creationCode ++ abi.encode(treasury)", () => {
  const initCode = splitterInitCode(TREASURY_A);
  // creationCode (unchanged prefix) + 32-byte left-padded treasury.
  expect(initCode.startsWith(SPLITTER_CREATION_CODE)).toEqual(true);
  const tail = initCode.slice(SPLITTER_CREATION_CODE.length);
  expect(tail).toEqual("000000000000000000000000" + TREASURY_A.slice(2));
});

it("splitter - deploy calldata = salt(32) ++ initCode (Arachnid raw form)", () => {
  const data = splitterDeployCalldata(TREASURY_A);
  expect(data.startsWith(SPLITTER_SALT)).toEqual(true);
  expect(data.slice(SPLITTER_SALT.length)).toEqual(splitterInitCode(TREASURY_A).slice(2));
});
