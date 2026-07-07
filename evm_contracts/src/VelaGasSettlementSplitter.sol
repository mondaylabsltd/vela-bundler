// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

contract VelaGasSettlementSplitter {
    address public immutable treasury;

    event GasSettlementSplit(
        address indexed origin,
        address indexed treasury,
        uint256 receivedAmount,
        uint256 originAmount,
        uint256 treasuryAmount
    );

    error ZeroAddress();
    error TransferFailed(address to, uint256 amount);

    constructor(address _treasury) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    receive() external payable {
        address origin = tx.origin;

        uint256 originAmount = msg.value / 2;

        if (originAmount > 0) {
            (bool okOrigin,) = payable(origin).call{value: originAmount}("");
            if (!okOrigin) revert TransferFailed(origin, originAmount);
        }

        uint256 treasuryAmount = address(this).balance;

        if (treasuryAmount > 0) {
            (bool okTreasury,) = payable(treasury).call{value: treasuryAmount}("");
            if (!okTreasury) revert TransferFailed(treasury, treasuryAmount);
        }

        emit GasSettlementSplit(origin, treasury, msg.value, originAmount, treasuryAmount);
    }
}
