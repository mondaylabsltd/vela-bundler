// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {VelaGasSettlementSplitter} from "../src/VelaGasSettlementSplitter.sol";

/// @notice Deterministically deploy VelaGasSettlementSplitter through the canonical
/// Arachnid CREATE2 factory (0x4e59…4956C) so the deployed address equals the address
/// the bundler and wallet derive off-chain: same factory, same salt, same creation code,
/// same `treasury` constructor arg.
///
/// Usage: TREASURY=0x… forge script script/DeployVelaGasSettlementSplitter.s.sol \
///          --rpc-url <url> --private-key <key> --broadcast
contract DeployVelaGasSettlementSplitter is Script {
    /// Arachnid deterministic-deployment proxy — present on most chains, reverts on
    /// re-deploy (CREATE2 collision). MUST match SPLITTER_FACTORY in the bundler/wallet.
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// MUST match SPLITTER_SALT in the bundler/wallet.
    bytes32 internal constant SALT = keccak256("vela.gas-settlement-splitter.v1");

    function run() external {
        address treasury = vm.envAddress("TREASURY");

        bytes memory initCode = abi.encodePacked(type(VelaGasSettlementSplitter).creationCode, abi.encode(treasury));
        address predicted = _create2Address(FACTORY, SALT, keccak256(initCode));

        if (predicted.code.length != 0) {
            console.log("VelaGasSettlementSplitter already deployed at", predicted);
            return;
        }

        vm.startBroadcast();
        // Raw call to the proxy: calldata = salt(32) ++ initCode. No selector, no ABI wrapper.
        (bool ok,) = FACTORY.call(abi.encodePacked(SALT, initCode));
        require(ok, "CREATE2 deploy failed");
        vm.stopBroadcast();

        require(predicted.code.length != 0, "deploy produced no code");
        console.log("VelaGasSettlementSplitter deployed at", predicted);
        console.log("treasury", treasury);
    }

    function _create2Address(address factory, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, initCodeHash)))));
    }
}
