use alloy::{
    primitives::{Address, U256, address},
    sol,
    sol_types::SolCall,
};

/// Tempo mainnet and its Moderato testnet use native account-abstraction (`0x76`) transactions.
pub const fn is_tempo_chain(chain_id: u64) -> bool {
    matches!(chain_id, 4_217 | 42_431)
}

/// Tempo's protocol-default USD fee token. Amounts are micro-pathUSD (six decimals).
pub const PATH_USD: Address = address!("20c0000000000000000000000000000000000000");
pub const PATH_USD_DECIMALS: u32 = 6;
pub const PATH_USD_SYMBOL: &str = "pathUSD";
pub const TEMPO_BASE_FEE_ATTO: u128 = 20_000_000_000;
pub const TEMPO_COST_BUFFER_GAS: u64 = 80_000;
pub const TEMPO_FLOAT_MIN: u128 = 100_000;
pub const TEMPO_FLOAT_TARGET: u128 = 300_000;
pub const TEMPO_TREASURY_FLOOR: u128 = 200_000;
pub const TEMPO_TOP_UP_DAILY_MAX: u128 = 50_000_000;

sol! {
    interface IERC20Tempo {
        function balanceOf(address account) external view returns (uint256);
        function transfer(address to, uint256 amount) external returns (bool);
    }
}

pub fn path_usd_balance_calldata(account: Address) -> alloy::primitives::Bytes {
    IERC20Tempo::balanceOfCall { account }.abi_encode().into()
}

pub fn path_usd_transfer_calldata(to: Address, amount: U256) -> alloy::primitives::Bytes {
    IERC20Tempo::transferCall { to, amount }.abi_encode().into()
}
