/**
 * VelaGasSettlementSplitter — deterministic CREATE2 derivation.
 *
 * The splitter is the on-chain beneficiary of `handleOps` on NATIVE chains: the EntryPoint
 * pays it the collected gas fees, and its `receive()` splits msg.value 50/50 between the
 * bundler EOA (tx.origin) and the treasury. It is deployed once per chain through the
 * Arachnid deterministic-deployment factory, so its address is identical on every chain and
 * a pure function of (factory, salt, creationCode, treasury).
 *
 * CRITICAL: the wallet (vela-wallet/src/services/safe-address.ts) derives the SAME address
 * from byte-identical constants. If SPLITTER_CREATION_CODE, SPLITTER_SALT, or SPLITTER_FACTORY
 * drift between the two repos, the bundler pays a beneficiary the wallet never deploys and the
 * split silently breaks. The creation code below is the pinned, metadata-light, PUSH0-free
 * build (foundry.toml: bytecode_hash="none", evm_version="paris"); regenerate it ONLY via
 * `forge inspect VelaGasSettlementSplitter bytecode` from evm_contracts and update BOTH repos
 * plus the golden vectors in the tests.
 */

import { concat, encodeAbiParameters, getCreate2Address, keccak256 } from "viem";

/** Arachnid deterministic-deployment proxy. Present on most chains; reverts on re-deploy. */
export const SPLITTER_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

/** keccak256("vela.gas-settlement-splitter.v1"). Versioned for a clean address bump. */
export const SPLITTER_SALT =
  "0x650cb20978a0e7efdcf6f077240c609a59f2f02401ed16fb4a222a2b51cb9720" as const;

/** Compiled creation code of VelaGasSettlementSplitter (constructor args appended separately). */
export const SPLITTER_CREATION_CODE =
  "0x60a060405234801561001057600080fd5b506040516105f13803806105f183398181016040528101906100329190610135565b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1603610098576040517fd92e233d00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8073ffffffffffffffffffffffffffffffffffffffff1660808173ffffffffffffffffffffffffffffffffffffffff168152505050610162565b600080fd5b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000610102826100d7565b9050919050565b610112816100f7565b811461011d57600080fd5b50565b60008151905061012f81610109565b92915050565b60006020828403121561014b5761014a6100d2565b5b600061015984828501610120565b91505092915050565b60805161045f6101926000396000818161010a01528181610199015281816101fa01526102b5015261045f6000f3fe6080604052600436106100225760003560e01c806361d027b31461028857610283565b36610283576000329050600060023461003b9190610310565b905060008111156100f85760008273ffffffffffffffffffffffffffffffffffffffff168260405161006c90610372565b60006040518083038185875af1925050503d80600081146100a9576040519150601f19603f3d011682016040523d82523d6000602084013e6100ae565b606091505b50509050806100f65782826040517f1c43b9760000000000000000000000000000000000000000000000000000000081526004016100ed9291906103d7565b60405180910390fd5b505b600047905060008111156101f85760007f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff168260405161014c90610372565b60006040518083038185875af1925050503d8060008114610189576040519150601f19603f3d011682016040523d82523d6000602084013e61018e565b606091505b50509050806101f6577f0000000000000000000000000000000000000000000000000000000000000000826040517f1c43b9760000000000000000000000000000000000000000000000000000000081526004016101ed9291906103d7565b60405180910390fd5b505b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff167fa4e98e523c3e239a66755f9f6a3d3559544e2da7102a26ec45994c3a29599d4234858560405161027993929190610400565b60405180910390a3005b600080fd5b34801561029457600080fd5b5061029d6102b3565b6040516102aa9190610437565b60405180910390f35b7f000000000000000000000000000000000000000000000000000000000000000081565b6000819050919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601260045260246000fd5b600061031b826102d7565b9150610326836102d7565b925082610336576103356102e1565b5b828204905092915050565b600081905092915050565b50565b600061035c600083610341565b91506103678261034c565b600082019050919050565b600061037d8261034f565b9150819050919050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b60006103b282610387565b9050919050565b6103c2816103a7565b82525050565b6103d1816102d7565b82525050565b60006040820190506103ec60008301856103b9565b6103f960208301846103c8565b9392505050565b600060608201905061041560008301866103c8565b61042260208301856103c8565b61042f60408301846103c8565b949350505050565b600060208201905061044c60008301846103b9565b9291505056fea164736f6c634300081c000a" as `0x${string}`;

/** keccak256(SPLITTER_CREATION_CODE) — pins the exact build; asserted in splitter_test.ts. */
export const SPLITTER_CREATION_CODE_HASH =
  "0xeac7eb6ec1d5aa3a4d67982d8d969332cddd8bf0b91e02ad102742ff8e37ec4f" as const;

/** Full CREATE2 init code = creationCode ++ abi.encode(address treasury). */
export function splitterInitCode(treasury: `0x${string}`): `0x${string}` {
  return concat([SPLITTER_CREATION_CODE, encodeAbiParameters([{ type: "address" }], [treasury])]);
}

/**
 * Deterministic splitter address for a given treasury.
 * = keccak256(0xff ++ factory ++ salt ++ keccak256(creationCode ++ abi.encode(treasury)))[12:]
 * Returns an EIP-55 checksummed address.
 */
export function computeSplitterAddress(treasury: `0x${string}`): `0x${string}` {
  return getCreate2Address({
    from: SPLITTER_FACTORY,
    salt: SPLITTER_SALT,
    bytecodeHash: keccak256(splitterInitCode(treasury)),
  });
}

/**
 * Raw calldata for a deploy through the Arachnid factory: salt(32) ++ initCode.
 * The wallet prepends `{ to: SPLITTER_FACTORY, value: 0, data: this }` into its MultiSend
 * batch when the splitter is not yet deployed. Exposed here for the /v1/splitter endpoint
 * and for cross-repo test parity.
 */
export function splitterDeployCalldata(treasury: `0x${string}`): `0x${string}` {
  return concat([SPLITTER_SALT, splitterInitCode(treasury)]);
}
