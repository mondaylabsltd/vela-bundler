// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {VelaGasSettlementSplitter} from "../src/VelaGasSettlementSplitter.sol";

/// @dev Minimal re-implementation of the Arachnid deterministic-deployment proxy's
/// calldata interface: calldata = salt(32) ++ initCode; CREATE2s the initCode with that
/// salt and returns the 20-byte address; reverts on collision (create2 returns 0). We etch
/// this runtime at the real factory address so the deployed address is computed from the
/// factory — identical to production.
contract Create2Proxy {
    fallback() external payable {
        assembly {
            let salt := calldataload(0)
            let size := sub(calldatasize(), 32)
            calldatacopy(0, 32, size)
            let addr := create2(0, 0, size, salt)
            if iszero(addr) { revert(0, 0) }
            mstore(0, addr)
            return(12, 20)
        }
    }
}

/// Locks the off-chain CREATE2 derivation that the bundler and wallet both reproduce.
/// If the contract source, solc version, optimizer, or evm_version changes, the creation
/// code changes, these pins fail, and CI stops the drift BEFORE it silently misroutes the
/// beneficiary payout to a different address on one side.
contract VelaGasSettlementSplitterCreate2Test is Test {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = keccak256("vela.gas-settlement-splitter.v1");

    // Canonical creation-code hash for the pinned build (bytecode_hash="none", evm_version="paris").
    bytes32 internal constant CREATION_CODE_HASH = 0xeac7eb6ec1d5aa3a4d67982d8d969332cddd8bf0b91e02ad102742ff8e37ec4f;

    // Golden cross-repo vectors — MUST equal the addresses the bundler (shared/contracts/splitter.ts)
    // and the wallet (safe-address.ts) compute for the same treasuries.
    address internal constant TREASURY_A = 0x1111111111111111111111111111111111111111;
    address internal constant SPLITTER_A = 0x3979be163bFb74Dce66F8E0839577807C2197226;
    address internal constant TREASURY_B = 0x000000000000000000000000000000000000dEaD;
    address internal constant SPLITTER_B = 0xdC95900610B854aB0c9B57A74B0f5bB67dDDB3B4;

    function _predict(address treasury) internal pure returns (address) {
        bytes memory initCode = abi.encodePacked(type(VelaGasSettlementSplitter).creationCode, abi.encode(treasury));
        bytes32 initCodeHash = keccak256(initCode);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, SALT, initCodeHash)))));
    }

    function test_CreationCodeHash_Pinned() public pure {
        assertEq(
            keccak256(type(VelaGasSettlementSplitter).creationCode),
            CREATION_CODE_HASH,
            "creation code drifted - update the pinned constant in BOTH repos"
        );
    }

    function test_Salt_Pinned() public pure {
        assertEq(SALT, 0x650cb20978a0e7efdcf6f077240c609a59f2f02401ed16fb4a222a2b51cb9720);
    }

    function test_Create2Address_MatchesGoldenVector() public pure {
        assertEq(_predict(TREASURY_A), SPLITTER_A, "golden vector A drifted");
        assertEq(_predict(TREASURY_B), SPLITTER_B, "golden vector B drifted");
    }

    function test_DeployViaFactory_MatchesPredictionAndSetsTreasury() public {
        // Place the CREATE2 proxy runtime at the canonical factory address.
        vm.etch(FACTORY, address(new Create2Proxy()).code);

        address treasury = TREASURY_A;
        address predicted = _predict(treasury);
        assertEq(predicted, SPLITTER_A);
        assertEq(predicted.code.length, 0, "predicted address should be empty before deploy");

        bytes memory initCode = abi.encodePacked(type(VelaGasSettlementSplitter).creationCode, abi.encode(treasury));
        (bool ok, bytes memory ret) = FACTORY.call(abi.encodePacked(SALT, initCode));
        assertTrue(ok, "factory deploy failed");
        assertEq(address(uint160(bytes20(ret))), predicted, "factory returned unexpected address");

        assertGt(predicted.code.length, 0, "no code at predicted address");
        assertEq(VelaGasSettlementSplitter(payable(predicted)).treasury(), treasury, "wrong treasury baked in");
    }

    function test_DeployViaFactory_RevertsOnCollision() public {
        vm.etch(FACTORY, address(new Create2Proxy()).code);
        bytes memory initCode = abi.encodePacked(type(VelaGasSettlementSplitter).creationCode, abi.encode(TREASURY_A));
        bytes memory deployCalldata = abi.encodePacked(SALT, initCode);

        (bool ok1,) = FACTORY.call(deployCalldata);
        assertTrue(ok1, "first deploy should succeed");

        // Re-deploying the same salt+initCode collides: CREATE2 returns 0, proxy reverts.
        (bool ok2,) = FACTORY.call(deployCalldata);
        assertFalse(ok2, "second deploy must revert on collision");
    }
}
