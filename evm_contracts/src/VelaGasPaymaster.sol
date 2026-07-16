// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * VelaGasPaymaster — a minimal ERC-4337 v0.7 *ERC-20 postpaid* paymaster.
 *
 * WHY THIS EXISTS
 * ---------------
 * The legacy money-path funded a *dedicated EOA per Safe*: every user topped up a different,
 * opaque address — fragmented and alarming. This replaces it with ONE paymaster (same address on
 * every chain). Users PREPAY NOTHING and touch no funding address: they pay their own gas in an
 * ERC-20 gas token, pulled from them AFTER the op runs, in the same transaction.
 *
 * MODEL — permissionless, on-chain-enforced, user-pays
 * ----------------------------------------------------
 * ERC-4337 gas is never free: the relayer EOA fronts the L1 gas and the EntryPoint reimburses the
 * `handleOps` beneficiary (the relayer) out of THIS paymaster's EntryPoint deposit (native). The
 * paymaster then recoups that gas from the USER in an ERC-20 gas token:
 *   - validatePaymasterUserOp: require the sender has approved this paymaster for >= the token
 *     value of `maxCost` and holds that balance. No state written, no funds moved yet.
 *   - postOp: `transferFrom(sender -> this, tokenValue(actualGasCost))`. If it fails, the whole op
 *     reverts (the EntryPoint rolls back execution) and no funds are stolen — the only residual is
 *     that the operator's deposit paid that op's gas, which the bundler's pre-inclusion simulation
 *     already filters out (a can't-pay op reverts in simulation and is never included).
 *
 * Because payment is enforced on-chain, NO relayer gate / allow-list / off-chain signer is needed:
 * anyone may route an op through this paymaster, but they can only ever have their OWN tokens
 * pulled for their OWN gas. The operator's native deposit is a rolling float, continuously recouped
 * in token; the operator swaps token->native to top the deposit back up.
 *
 * PER-CHAIN CONFIG (only two settings — both economic, not security)
 * ------------------------------------------------------------------
 *   1. gasToken       — the ERC-20 users pay gas in. Use a SAME-ADDRESS token on every chain (e.g.
 *                       a CREATE2-deployed stable gas token) to keep this trivial; otherwise set
 *                       each chain's token once.
 *   2. tokenPerNative — how many gasToken base units equal 1e18 wei of native (the price). A keeper
 *                       refreshes it as the market moves. `markupBps` adds headroom for price drift
 *                       and the token->native swap cost.
 * Neither is a constructor arg, so the deployed address stays byte-identical on every chain.
 *
 * DETERMINISTIC CROSS-CHAIN ADDRESS
 * ---------------------------------
 * Deploy through the Arachnid CREATE2 factory (0x4e59…4956C) — the SAME machinery the splitter
 * uses. EntryPoint is a hardcoded constant and the only constructor arg is `owner` = the treasury
 * (same on every chain), so the address is identical everywhere. Build inputs are pinned in
 * foundry.toml (solc 0.8.28, optimizer off, bytecode_hash none, evm_version paris).
 *
 * TOKEN REQUIREMENTS: gasToken must be a standard, non-rebasing, non-fee-on-transfer ERC-20. A
 * fee-on-transfer token would under-fund the paymaster (recoup less than charged); fold a margin
 * into markupBps if you must use one. The owner is trusted to set a well-behaved token.
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

interface IEntryPoint {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract VelaGasPaymaster {
    /// Canonical ERC-4337 v0.7 EntryPoint — identical on every chain. Hardcoded (not a ctor arg).
    address internal constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    /// 1e18 native-wei scaling denominator for the price and 10_000 bps denominator for markup.
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// Operator/owner: funds/reclaims the native deposit, sets token + price, sweeps collected token.
    /// Treasury (same address on every chain), so the deployed paymaster address stays identical.
    address public owner;

    /// ERC-20 users pay gas in. Zero until set — while zero, the paymaster refuses all ops.
    IERC20 public gasToken;

    /// gasToken base units equal in value to 1e18 wei of native. tokenAmount = nativeWei * rate/1e18.
    uint256 public tokenPerNative;

    /// Charge multiplier in basis points (10_000 = break-even; e.g. 10_500 = +5% headroom).
    uint256 public markupBps = BPS;

    /// Minimal non-reentrancy guard for the owner withdraw/sweep paths (native/token transfers out).
    uint256 private _locked = 1;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event GasCharged(address indexed sender, uint256 actualGasCost, uint256 tokenCharged);
    event GasTokenSet(address indexed token);
    event PriceSet(uint256 tokenPerNative, uint256 markupBps);
    event TokenSwept(address indexed to, uint256 amount);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    error NotEntryPoint();
    error NotOwner();
    error ZeroAddress();
    error Reentrancy();
    error GasTokenNotSet();
    error PriceNotSet();
    error InsufficientTokenBalance(address sender, uint256 have, uint256 need);
    error InsufficientTokenAllowance(address sender, uint256 have, uint256 need);
    error ChargeFailed(address sender, uint256 amount);

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
    // Native deposit (operator float that reimburses the bundler)
    // ------------------------------------------------------------------------

    function deposit() external payable {
        IEntryPoint(ENTRY_POINT).depositTo{value: msg.value}(address(this));
        emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        IEntryPoint(ENTRY_POINT).depositTo{value: msg.value}(address(this));
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IEntryPoint(ENTRY_POINT).withdrawTo(to, amount);
        emit Withdrawn(to, amount);
    }

    /// Rescue native force-sent to this contract itself (bypassing receive()) into the deposit.
    function rescueToDeposit() external {
        uint256 bal = address(this).balance;
        if (bal != 0) {
            IEntryPoint(ENTRY_POINT).depositTo{value: bal}(address(this));
            emit Deposited(address(this), bal);
        }
    }

    // ------------------------------------------------------------------------
    // Config (owner only) — token + price
    // ------------------------------------------------------------------------

    function setGasToken(IERC20 token) external onlyOwner {
        if (address(token) == address(0)) revert ZeroAddress();
        gasToken = token;
        emit GasTokenSet(address(token));
    }

    /// Refresh the native->token price and markup. `_tokenPerNative` = gasToken base units per 1e18
    /// wei; `_markupBps` >= 10_000. A keeper calls this as the market moves.
    function setPrice(uint256 _tokenPerNative, uint256 _markupBps) external onlyOwner {
        if (_tokenPerNative == 0) revert PriceNotSet();
        if (_markupBps < BPS) _markupBps = BPS; // never charge below cost
        tokenPerNative = _tokenPerNative;
        markupBps = _markupBps;
        emit PriceSet(_tokenPerNative, _markupBps);
    }

    /// Move collected gasToken out to the operator (e.g. to swap back into native for the deposit).
    function sweepToken(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _safeTransfer(gasToken, to, amount);
        emit TokenSwept(to, amount);
    }

    // ------------------------------------------------------------------------
    // ERC-4337 paymaster hooks (EntryPoint-only)
    // ------------------------------------------------------------------------

    /// Validation: the sender must have approved this paymaster for, and hold, at least the token
    /// value of `maxCost`. Nothing is moved here — payment happens in postOp. Returns the sender +
    /// the price snapshot as context so postOp charges at exactly the validated rate.
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32, /* userOpHash */
        uint256 maxCost
    ) external view onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        IERC20 token = gasToken;
        if (address(token) == address(0)) revert GasTokenNotSet();
        uint256 rate = tokenPerNative;
        if (rate == 0) revert PriceNotSet();
        uint256 mBps = markupBps;

        address sender = userOp.sender;
        uint256 maxToken = _toToken(maxCost, rate, mBps);

        uint256 bal = token.balanceOf(sender);
        if (bal < maxToken) revert InsufficientTokenBalance(sender, bal, maxToken);
        uint256 allow = token.allowance(sender, address(this));
        if (allow < maxToken) revert InsufficientTokenAllowance(sender, allow, maxToken);

        // Snapshot (sender, rate, markup) so postOp cannot charge at a rate the sender never had
        // checked against. validationData = 0 => valid, no time bounds, no aggregator.
        return (abi.encode(sender, rate, mBps), 0);
    }

    /// Settlement: pull the REAL gas cost (in token) from the sender. maxCost >= actualGasCost and
    /// the same rate => the amount pulled is <= the amount validated against, so the balance/allow
    /// checked in validation covers it (barring the sender mutating their own balance mid-execution,
    /// which reverts this op and steals nothing). Uses the snapshotted rate for exact consistency.
    function postOp(
        PostOpMode, /* mode — charge the same whether the op succeeded or reverted */
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) external onlyEntryPoint {
        (address sender, uint256 rate, uint256 mBps) = abi.decode(context, (address, uint256, uint256));
        uint256 tokenAmount = _toToken(actualGasCost, rate, mBps);
        if (tokenAmount != 0) {
            _safeTransferFrom(gasToken, sender, address(this), tokenAmount);
        }
        emit GasCharged(sender, actualGasCost, tokenAmount);
    }

    // ------------------------------------------------------------------------
    // Owner / views
    // ------------------------------------------------------------------------

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// Native deposit held in the EntryPoint — the rolling float. Watch it: if it hits zero, ops
    /// fail closed with "AA31 paymaster deposit too low" until the operator tops it up.
    function entryPointDeposit() external view returns (uint256) {
        return IEntryPoint(ENTRY_POINT).balanceOf(address(this));
    }

    /// Token that would be charged for a given native gas cost, at the current price.
    function quoteToken(uint256 nativeGasCost) external view returns (uint256) {
        return _toToken(nativeGasCost, tokenPerNative, markupBps);
    }

    function entryPoint() external pure returns (address) {
        return ENTRY_POINT;
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    function _toToken(uint256 nativeWei, uint256 rate, uint256 mBps) internal pure returns (uint256) {
        // tokenAmount = nativeWei * rate/1e18 * markupBps/10_000
        return (nativeWei * rate * mBps) / (WAD * BPS);
    }

    /// transferFrom that tolerates both bool-returning and no-return ERC-20s, reverting on failure.
    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ChargeFailed(from, amount);
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ChargeFailed(to, amount);
    }
}
