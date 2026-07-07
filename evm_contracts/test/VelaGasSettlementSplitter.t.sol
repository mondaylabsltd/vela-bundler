// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {VelaGasSettlementSplitter} from "../src/VelaGasSettlementSplitter.sol";

/// @dev Rejects any incoming ETH, used to force the splitter's transfer paths to fail.
contract RejectEther {
    error Nope();

    receive() external payable {
        revert Nope();
    }
}

contract VelaGasSettlementSplitterTest is Test {
    VelaGasSettlementSplitter internal splitter;

    address internal treasury = makeAddr("treasury");
    address internal caller = makeAddr("caller");
    address internal origin = makeAddr("origin");

    // Mirror of the contract's event so we can use vm.expectEmit.
    event GasSettlementSplit(
        address indexed origin,
        address indexed treasury,
        uint256 receivedAmount,
        uint256 originAmount,
        uint256 treasuryAmount
    );

    function setUp() public {
        splitter = new VelaGasSettlementSplitter(treasury);
    }

    /// @dev Send `amount` wei to the splitter as `caller` with `tx.origin == origin`.
    function _send(uint256 amount) internal returns (bool ok) {
        vm.deal(caller, amount);
        vm.prank(caller, origin);
        (ok,) = address(splitter).call{value: amount}("");
    }

    // --- constructor -------------------------------------------------------

    function test_Constructor_SetsTreasury() public view {
        assertEq(splitter.treasury(), treasury);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(VelaGasSettlementSplitter.ZeroAddress.selector);
        new VelaGasSettlementSplitter(address(0));
    }

    // --- happy-path splits -------------------------------------------------

    function test_Split_EvenAmount() public {
        uint256 amount = 2 ether;

        bool ok = _send(amount);

        assertTrue(ok);
        assertEq(origin.balance, amount / 2, "origin gets half");
        assertEq(treasury.balance, amount / 2, "treasury gets half");
        assertEq(address(splitter).balance, 0, "nothing retained");
    }

    function test_Split_OddAmount_TreasuryGetsRemainder() public {
        uint256 amount = 3; // originAmount = 1 (floor), treasuryAmount = 2

        bool ok = _send(amount);

        assertTrue(ok);
        assertEq(origin.balance, 1, "origin gets floor(amount/2)");
        assertEq(treasury.balance, 2, "treasury gets the larger remainder");
        assertEq(address(splitter).balance, 0);
    }

    function test_Split_OneWei_SkipsOriginTransfer() public {
        bool ok = _send(1);

        assertTrue(ok);
        assertEq(origin.balance, 0, "originAmount rounds down to 0, skipped");
        assertEq(treasury.balance, 1, "treasury receives the single wei");
        assertEq(address(splitter).balance, 0);
    }

    function test_Split_ZeroValue_NoTransfersButEmits() public {
        vm.expectEmit(true, true, false, true, address(splitter));
        emit GasSettlementSplit(origin, treasury, 0, 0, 0);

        bool ok = _send(0);

        assertTrue(ok);
        assertEq(origin.balance, 0);
        assertEq(treasury.balance, 0);
    }

    function test_Split_RefundsOriginNotSender() public {
        // Distinguishes tx.origin (refund recipient) from msg.sender (caller).
        uint256 amount = 4 ether;

        bool ok = _send(amount);

        assertTrue(ok);
        assertEq(origin.balance, amount / 2, "refund goes to tx.origin");
        assertEq(caller.balance, 0, "msg.sender receives nothing");
    }

    function test_Split_EmitsEvent() public {
        uint256 amount = 7; // originAmount = 3, treasuryAmount = 4

        vm.expectEmit(true, true, false, true, address(splitter));
        emit GasSettlementSplit(origin, treasury, amount, 3, 4);

        _send(amount);
    }

    function test_Split_SweepsPreExistingBalance() public {
        // Any stuck balance is swept to the treasury on the next receive.
        vm.deal(address(splitter), 10);

        uint256 amount = 4; // originAmount = 2; treasuryAmount = (10 + 4) - 2 = 12
        bool ok = _send(amount);

        assertTrue(ok);
        assertEq(origin.balance, 2);
        assertEq(treasury.balance, 12, "treasury sweeps stuck funds plus its share");
        assertEq(address(splitter).balance, 0, "contract never retains funds");
    }

    // --- failure paths -----------------------------------------------------

    function test_RevertWhen_OriginTransferFails() public {
        RejectEther rejector = new RejectEther();
        uint256 amount = 2; // originAmount = 1 (> 0, so the origin transfer is attempted)

        vm.deal(caller, amount);
        vm.prank(caller, address(rejector)); // tx.origin is the rejecting contract
        vm.expectRevert(abi.encodeWithSelector(VelaGasSettlementSplitter.TransferFailed.selector, address(rejector), 1));
        (bool ok,) = address(splitter).call{value: amount}("");
        ok; // silence unused-var warning; expectRevert asserts the revert
    }

    function test_RevertWhen_TreasuryTransferFails() public {
        RejectEther rejector = new RejectEther();
        VelaGasSettlementSplitter badSplitter = new VelaGasSettlementSplitter(address(rejector));

        uint256 amount = 2; // origin (EOA) gets 1; treasury (rejector) gets 1 and reverts

        vm.deal(caller, amount);
        vm.prank(caller, origin);
        vm.expectRevert(abi.encodeWithSelector(VelaGasSettlementSplitter.TransferFailed.selector, address(rejector), 1));
        (bool ok,) = address(badSplitter).call{value: amount}("");
        ok;
    }

    // --- fuzz --------------------------------------------------------------

    function testFuzz_Split(uint256 amount) public {
        amount = bound(amount, 0, 1_000_000 ether);

        uint256 expectedOrigin = amount / 2;
        uint256 expectedTreasury = amount - expectedOrigin;

        bool ok = _send(amount);

        assertTrue(ok);
        assertEq(origin.balance, expectedOrigin, "origin gets floor(amount/2)");
        assertEq(treasury.balance, expectedTreasury, "treasury gets the rest");
        assertEq(origin.balance + treasury.balance, amount, "full amount forwarded");
        assertEq(address(splitter).balance, 0, "nothing retained");
    }
}
