// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VelaGasPaymaster} from "../src/VelaGasPaymaster.sol";

/// @notice Deterministically deploy VelaGasPaymaster through the canonical Arachnid CREATE2
/// factory (0x4e59…4956C) so the deployed address is identical on every chain and equals the
/// address the bundler/wallet derive off-chain: same factory, same salt, same creation code,
/// same `owner` (the treasury) constructor arg.
///
/// Usage: OWNER=0x<treasury> forge script script/DeployVelaGasPaymaster.s.sol \
///          --rpc-url <url> --private-key <key> --broadcast
///
/// After deploy, the owner must: (1) `setGasToken(token)` — the ERC-20 users pay gas in;
/// (2) `setPrice(tokenPerNative, markupBps)` — the native->token price (a keeper refreshes it);
/// (3) fund the paymaster's EntryPoint deposit via `deposit()` (or a plain transfer). The paymaster
/// is permissionless (no relayer gate): solvency is enforced on-chain by transferFrom in postOp,
/// so anyone may route ops through it but can only ever have their own tokens pulled for their own
/// gas. Use a same-address gasToken on every chain to keep per-chain setup to just these calls.
contract DeployVelaGasPaymaster is Script {
    /// Arachnid deterministic-deployment proxy — present on most chains, reverts on re-deploy.
    /// MUST match SPLITTER_FACTORY / the paymaster factory constant in the bundler & wallet.
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// Versioned salt for a clean address bump. MUST match the bundler/wallet constant.
    bytes32 internal constant SALT = keccak256("vela.gas-paymaster.v1");

    function run() external {
        address owner = vm.envAddress("OWNER");

        bytes memory initCode = abi.encodePacked(type(VelaGasPaymaster).creationCode, abi.encode(owner));
        address predicted = _create2Address(FACTORY, SALT, keccak256(initCode));

        if (predicted.code.length != 0) {
            console.log("VelaGasPaymaster already deployed at", predicted);
            return;
        }

        vm.startBroadcast();
        // Raw call to the proxy: calldata = salt(32) ++ initCode. No selector, no ABI wrapper.
        (bool ok,) = FACTORY.call(abi.encodePacked(SALT, initCode));
        require(ok, "CREATE2 deploy failed");
        vm.stopBroadcast();

        require(predicted.code.length != 0, "deploy produced no code");
        console.log("VelaGasPaymaster deployed at", predicted);
        console.log("owner", owner);
    }

    function _create2Address(address factory, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, initCodeHash)))));
    }
}
