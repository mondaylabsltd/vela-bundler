// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * VelaGasPaymaster — a minimal ERC-4337 v0.7 *prepaid* paymaster.
 *
 * WHY THIS EXISTS
 * ---------------
 * The legacy money-path funded a *dedicated EOA per Safe* (`activeDepositAddress`): every user
 * had to top up a different, opaque address. That is fragmented and alarming to non-technical
 * users ("why am I sending funds to a random address?"). This contract replaces that with ONE
 * friendly, *same-address-on-every-chain* destination.
 *
 * MODEL — prepaid, not sponsored
 * ------------------------------
 * Users deposit native coin here, credited to their own Safe (`gasBalance[safe]`). The deposit
 * is forwarded straight into the EntryPoint so this paymaster can always front the gas. For each
 * UserOp:
 *   - validatePaymasterUserOp: require gasBalance[sender] >= maxCost, then RESERVE maxCost.
 *   - postOp:                  charge the REAL gas, refund the unused reservation.
 * The EntryPoint pays the bundler (the `handleOps` beneficiary) out of this paymaster's EntryPoint
 * deposit automatically — that is the "send the bundler the gas it actually paid" step.
 *
 * A user can only ever spend what they themselves deposited, so — unlike a sponsoring/verifying
 * paymaster — this is NOT drainable and needs NO off-chain signer or allow-listing.
 *
 * DETERMINISTIC CROSS-CHAIN ADDRESS
 * ---------------------------------
 * Deploy through the Arachnid CREATE2 factory (0x4e59…4956C) — the SAME machinery the splitter
 * uses. The address is a pure function of (factory, salt, creationCode, constructor args). The
 * EntryPoint is a hardcoded constant (identical on every chain), and `owner` is the treasury
 * (identical on every chain), so the deployed address is byte-for-byte identical everywhere.
 * Build inputs are pinned in foundry.toml (solc 0.8.28, optimizer off, bytecode_hash none,
 * evm_version paris) exactly like the splitter, so the creation code is reproducible.
 *
 * PRIVATE BUNDLER NOTE
 * --------------------
 * Vela runs its own bundler, so the ERC-7562 public-mempool paymaster staking/storage rules do
 * not gate inclusion. Reading/writing `gasBalance[userOp.sender]` in validation is sender-
 * associated storage anyway (allowed even under the public rules). `addStake` is provided only
 * for the optional case of submitting through third-party bundlers.
 */

/// @dev EntryPoint v0.7 packed UserOperation (only the fields we read).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @dev EntryPoint v0.7 postOp mode. `postOpReverted` is never passed to the paymaster.
enum PostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

/// @dev Subset of the EntryPoint v0.7 StakeManager / deposit API this paymaster calls.
interface IEntryPoint {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
}

contract VelaGasPaymaster {
    /// Canonical ERC-4337 v0.7 EntryPoint — identical on every chain. Hardcoded (not a
    /// constructor arg) so it never perturbs the deterministic CREATE2 address.
    address internal constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    /// Operator/owner (stake + surplus withdrawals). Set to the treasury, which is the same
    /// address on every chain, so the deployed paymaster address stays identical cross-chain.
    address public owner;

    /// Per-Safe prepaid gas balance (native wei). A Safe can only ever spend its own balance.
    mapping(address => uint256) public gasBalance;

    /// Sum of all `gasBalance` entries. Invariant: EntryPoint.balanceOf(this) >= totalGasBalance.
    /// The excess (EntryPoint deposit − totalGasBalance) is operator surplus/buffer, and is the
    /// ONLY amount the owner may withdraw — user funds are never touchable by the operator.
    uint256 public totalGasBalance;

    /// Minimal non-reentrancy guard for the withdraw paths (which call out to the EntryPoint,
    /// which sends native coin to the recipient).
    uint256 private _locked = 1;

    event GasDeposited(address indexed account, address indexed from, uint256 amount);
    event GasWithdrawn(address indexed account, uint256 amount);
    event GasCharged(address indexed account, uint256 charged, uint256 refunded, bool opReverted);
    event OperatorSurplusWithdrawn(address indexed to, uint256 amount);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    error NotEntryPoint();
    error NotOwner();
    error ZeroAddress();
    error InsufficientGasBalance(address account, uint256 have, uint256 need);
    error InsufficientSurplus(uint256 available, uint256 requested);
    error Reentrancy();

    modifier onlyEntryPoint() {
        if (msg.sender != ENTRY_POINT) revert NotEntryPoint();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnerChanged(address(0), _owner);
    }

    // ------------------------------------------------------------------------
    // Deposits (the user-facing "top up gas" path)
    // ------------------------------------------------------------------------

    /// Credit `account`'s prepaid gas balance and forward the funds into the EntryPoint deposit
    /// so this paymaster can front the gas. Callable by anyone (the wallet, a relayer, the
    /// treasury sponsoring a new user) — you can only ever ADD to someone's balance.
    function depositTo(address account) public payable {
        if (account == address(0)) revert ZeroAddress();
        gasBalance[account] += msg.value;
        totalGasBalance += msg.value;
        IEntryPoint(ENTRY_POINT).depositTo{value: msg.value}(address(this));
        emit GasDeposited(account, msg.sender, msg.value);
    }

    /// Convenience: a plain transfer credits the sender's own balance.
    receive() external payable {
        depositTo(msg.sender);
    }

    // ------------------------------------------------------------------------
    // Withdrawals (users pull back their own unused balance)
    // ------------------------------------------------------------------------

    /// Withdraw part of the caller's own unused prepaid balance. Reserved-but-uncharged amounts
    /// are already deducted (in validation), so in-flight gas can never be withdrawn.
    function withdraw(uint256 amount) external nonReentrant {
        uint256 bal = gasBalance[msg.sender];
        if (bal < amount) revert InsufficientGasBalance(msg.sender, bal, amount);
        // Effects before interaction.
        gasBalance[msg.sender] = bal - amount;
        totalGasBalance -= amount;
        IEntryPoint(ENTRY_POINT).withdrawTo(payable(msg.sender), amount);
        emit GasWithdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------------
    // ERC-4337 paymaster hooks (EntryPoint-only)
    // ------------------------------------------------------------------------

    /// Validation: the Safe must have prepaid at least `maxCost`. Reserve it up front so two ops
    /// from the same Safe in one bundle can't both pass on the same funds (all validations run
    /// before any execution in v0.7). Reverting here cleanly rejects an underfunded op.
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32, /* userOpHash */
        uint256 maxCost
    ) external onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        address account = userOp.sender;
        uint256 bal = gasBalance[account];
        if (bal < maxCost) revert InsufficientGasBalance(account, bal, maxCost);
        gasBalance[account] = bal - maxCost; // reserve
        totalGasBalance -= maxCost;
        // context carries who to settle and how much was reserved. validationData = 0 => valid,
        // no time bounds, no aggregator.
        return (abi.encode(account, maxCost), 0);
    }

    /// Settlement: charge the REAL gas the EntryPoint just paid the bundler, refund the rest of
    /// the reservation. No markup — the user pays exactly the gas the bundler spent. (To take a
    /// margin, scale `charge` up here; the extra accrues as owner-withdrawable surplus.)
    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) external onlyEntryPoint {
        (address account, uint256 reserved) = abi.decode(context, (address, uint256));
        uint256 charge = actualGasCost;
        if (charge > reserved) charge = reserved; // never charge beyond what was reserved
        uint256 refund = reserved - charge;
        if (refund != 0) {
            gasBalance[account] += refund;
            totalGasBalance += refund;
        }
        emit GasCharged(account, charge, refund, mode == PostOpMode.opReverted);
    }

    // ------------------------------------------------------------------------
    // Operator (owner-only) — stake + surplus. Cannot touch user balances.
    // ------------------------------------------------------------------------

    /// Withdraw operator surplus only: EntryPoint deposit above the sum of user balances. This is
    /// the accrued buffer/markup; user funds (totalGasBalance) are never withdrawable this way.
    function withdrawOperatorSurplus(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 deposit = IEntryPoint(ENTRY_POINT).balanceOf(address(this));
        uint256 surplus = deposit > totalGasBalance ? deposit - totalGasBalance : 0;
        if (amount > surplus) revert InsufficientSurplus(surplus, amount);
        IEntryPoint(ENTRY_POINT).withdrawTo(to, amount);
        emit OperatorSurplusWithdrawn(to, amount);
    }

    /// Add an operator buffer to the EntryPoint deposit WITHOUT crediting any user (headroom for
    /// gas-price volatility / markup). Withdrawable later via withdrawOperatorSurplus.
    function addOperatorDeposit() external payable onlyOwner {
        IEntryPoint(ENTRY_POINT).depositTo{value: msg.value}(address(this));
    }

    /// Optional: stake so third-party (public-mempool) bundlers will include ops sponsored by
    /// this paymaster. Not required for Vela's own bundler.
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        IEntryPoint(ENTRY_POINT).addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        IEntryPoint(ENTRY_POINT).unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IEntryPoint(ENTRY_POINT).withdrawStake(to);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------

    /// The paymaster's total deposit held in the EntryPoint (backs all user balances + surplus).
    function entryPointDeposit() external view returns (uint256) {
        return IEntryPoint(ENTRY_POINT).balanceOf(address(this));
    }

    function entryPoint() external pure returns (address) {
        return ENTRY_POINT;
    }
}
