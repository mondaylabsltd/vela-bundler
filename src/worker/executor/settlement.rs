use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::{Display, Formatter},
};

use alloy::primitives::{Address, B256, Bytes, U256, address, aliases::U512, keccak256};

const EXECUTE_USER_OP_SELECTOR: [u8; 4] = [0x7b, 0xb3, 0x74, 0x28];
const MULTISEND_SELECTOR: [u8; 4] = [0x8d, 0x80, 0xff, 0x0a];
const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
pub(crate) const LATEST_ROUND_DATA_SELECTOR: [u8; 4] = [0xfe, 0xaf, 0x96, 0x8c];
const TRUSTED_MULTISEND: Address = address!("38869bf66a61cf6bdb996a6ae40d5853fd43b526");

pub(crate) const MIN_NATIVE_FRACTION_DECIMALS: u32 = 5;
pub(crate) const MIN_STABLE_FRACTION_DECIMALS: u32 = 2;

/// Operator-owned asset policy for one chain.
///
/// Chain-registry metadata can help populate this structure, but must never be
/// accepted as the trust root for the stablecoin or contract allowlists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChainAssetConfig {
    pub(crate) native_decimals: u32,
    /// Required reimbursement ratio in basis points; 20_000 means 2x cost.
    pub(crate) settlement_markup_bps: u64,
    pub(crate) native_usd_oracle: Option<OracleConfig>,
    pub(crate) stablecoins: BTreeMap<Address, StablecoinConfig>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct OracleConfig {
    pub(crate) address: Address,
    pub(crate) decimals: u32,
    pub(crate) max_age_seconds: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StablecoinConfig {
    pub(crate) symbol: String,
    pub(crate) decimals: u32,
    pub(crate) usd_oracle: OracleConfig,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SettlementInput<'a> {
    pub(crate) call_data: &'a [u8],
    /// The exact native-token cost allocated to this operation, before markup.
    pub(crate) gas_native_cost: U256,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Reimbursement {
    pub(crate) native: U256,
    pub(crate) stablecoins: BTreeMap<Address, U256>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct OracleRound {
    pub(crate) answer: U256,
    pub(crate) updated_at: u64,
}

/// Minimal simulation-log view used to confirm that the statically parsed
/// stablecoin transfer was actually emitted by the allowlisted token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SettlementLog {
    pub(crate) address: Address,
    pub(crate) topics: Vec<B256>,
    pub(crate) data: Bytes,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SettlementRejection {
    MalformedCallData,
    ArithmeticOverflow,
    UnsupportedPaymentCombination,
    InsufficientPayment,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SettlementEvaluation {
    pub(crate) reimbursement: Reimbursement,
    pub(crate) gas_native_cost: U256,
    pub(crate) payment_asset: Option<Address>,
    pub(crate) paid_amount: U256,
    pub(crate) required_amount: U256,
    pub(crate) rejection: Option<SettlementRejection>,
}

impl SettlementEvaluation {
    pub(crate) fn accepted(&self) -> bool {
        self.rejection.is_none()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BatchSettlementEvaluation {
    pub(crate) operations: Vec<SettlementEvaluation>,
}

impl BatchSettlementEvaluation {
    pub(crate) fn all_accepted(&self) -> bool {
        self.operations.iter().all(SettlementEvaluation::accepted)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SettlementError {
    InvalidConfiguration(&'static str),
    ArithmeticOverflow,
    MissingOraclePrice(Address),
    InvalidOracleRound(Address, &'static str),
}

impl Display for SettlementError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration(message) => formatter.write_str(message),
            Self::ArithmeticOverflow => formatter.write_str("settlement arithmetic overflow"),
            Self::MissingOraclePrice(oracle) => {
                write!(formatter, "missing USD oracle price for {oracle}")
            }
            Self::InvalidOracleRound(oracle, reason) => {
                write!(formatter, "invalid USD oracle round for {oracle}: {reason}")
            }
        }
    }
}

impl std::error::Error for SettlementError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReimbursementParseError {
    MalformedCallData,
    ArithmeticOverflow,
}

/// Parse only transfers that the Safe actually executes through its canonical
/// `executeUserOp -> MultiSend(DELEGATECALL) -> CALL` path.
pub(crate) fn parse_reimbursement(
    call_data: &[u8],
    recipient: Address,
    stablecoin_allowlist: &BTreeSet<Address>,
) -> Result<Reimbursement, ReimbursementParseError> {
    let transactions = decode_multisend_transactions(call_data)
        .ok_or(ReimbursementParseError::MalformedCallData)?;
    let mut reimbursement = Reimbursement::default();
    let mut offset = 0usize;

    while offset < transactions.len() {
        let operation = *transactions
            .get(offset)
            .ok_or(ReimbursementParseError::MalformedCallData)?;
        let to = read_packed_address(transactions, offset + 1)
            .ok_or(ReimbursementParseError::MalformedCallData)?;
        let value = read_u256_word(transactions, offset + 21)
            .ok_or(ReimbursementParseError::MalformedCallData)?;
        let data_length = read_usize_word(transactions, offset + 53)
            .ok_or(ReimbursementParseError::MalformedCallData)?;
        let data_start = offset
            .checked_add(85)
            .ok_or(ReimbursementParseError::MalformedCallData)?;
        let data_end = data_start
            .checked_add(data_length)
            .ok_or(ReimbursementParseError::MalformedCallData)?;
        let data = transactions
            .get(data_start..data_end)
            .ok_or(ReimbursementParseError::MalformedCallData)?;

        // MultiSend operation 0 is CALL. A DELEGATECALL containing transfer-shaped
        // bytes is deliberately never credited as reimbursement.
        if operation == 0 {
            if to == recipient && !value.is_zero() {
                reimbursement.native = reimbursement
                    .native
                    .checked_add(value)
                    .ok_or(ReimbursementParseError::ArithmeticOverflow)?;
            }

            if stablecoin_allowlist.contains(&to)
                && let Some((transfer_recipient, amount)) = decode_erc20_transfer(data)
                && transfer_recipient == recipient
                && !amount.is_zero()
            {
                let total = reimbursement.stablecoins.entry(to).or_default();
                *total = total
                    .checked_add(amount)
                    .ok_or(ReimbursementParseError::ArithmeticOverflow)?;
            }
        }

        offset = data_end;
    }

    Ok(reimbursement)
}

/// Confirm stablecoin reimbursement against the logs from the exact final
/// `handleOps` bundle simulation. Logs from another token, sender, or recipient
/// never count. Native transfers do not have a standard log and are therefore
/// covered by successful final bundle simulation instead.
pub(crate) fn verify_stable_transfer_logs(
    reimbursement: &Reimbursement,
    sender: Address,
    recipient: Address,
    logs: &[SettlementLog],
) -> bool {
    let transfer_signature = keccak256(b"Transfer(address,address,uint256)");
    let sender_topic = B256::from(address_word(sender));
    let recipient_topic = B256::from(address_word(recipient));

    reimbursement.stablecoins.iter().all(|(token, expected)| {
        let mut actual = U256::ZERO;
        for log in logs {
            if log.address != *token
                || log.topics.len() != 3
                || log.topics[0] != transfer_signature
                || log.topics[1] != sender_topic
                || log.topics[2] != recipient_topic
                || log.data.len() != 32
            {
                continue;
            }

            let amount = U256::from_be_slice(&log.data);
            let Some(total) = actual.checked_add(amount) else {
                return false;
            };
            actual = total;
        }
        actual >= *expected
    })
}

/// Evaluate each operation independently. Surplus paid by one operation cannot
/// subsidize another operation in the same `handleOps` batch.
pub(crate) fn evaluate_batch(
    recipient: Address,
    config: &ChainAssetConfig,
    inputs: &[SettlementInput<'_>],
    oracle_prices: &BTreeMap<Address, U256>,
) -> Result<BatchSettlementEvaluation, SettlementError> {
    validate_config(config)?;
    let native_floor = minimum_amount(config.native_decimals, MIN_NATIVE_FRACTION_DECIMALS)?;
    let allowlist = config.stablecoins.keys().copied().collect::<BTreeSet<_>>();
    let mut operations = Vec::with_capacity(inputs.len());

    for input in inputs {
        let marked_cost = mul_div_ceil(
            input.gas_native_cost,
            U256::from(config.settlement_markup_bps),
            U256::from(10_000u64),
        )?;

        let reimbursement = match parse_reimbursement(input.call_data, recipient, &allowlist) {
            Ok(reimbursement) => reimbursement,
            Err(error) => {
                operations.push(rejected_parse(
                    input.gas_native_cost,
                    marked_cost,
                    native_floor,
                    error,
                ));
                continue;
            }
        };

        match evaluate_one(
            reimbursement,
            input.gas_native_cost,
            marked_cost,
            native_floor,
            config,
            oracle_prices,
        ) {
            Ok(evaluation) => operations.push(evaluation),
            Err(SettlementError::ArithmeticOverflow) => operations.push(SettlementEvaluation {
                reimbursement: Reimbursement::default(),
                gas_native_cost: input.gas_native_cost,
                payment_asset: None,
                paid_amount: U256::ZERO,
                required_amount: marked_cost.max(native_floor),
                rejection: Some(SettlementRejection::ArithmeticOverflow),
            }),
            Err(error) => return Err(error),
        }
    }

    Ok(BatchSettlementEvaluation { operations })
}

/// Returns only the operator-configured feeds needed by the stablecoins actually present in this
/// batch. Native-only settlement performs no oracle RPC.
pub(crate) fn required_oracle_feeds(
    recipient: Address,
    config: &ChainAssetConfig,
    inputs: &[SettlementInput<'_>],
) -> Result<BTreeMap<Address, OracleConfig>, SettlementError> {
    validate_config(config)?;
    let allowlist = config.stablecoins.keys().copied().collect::<BTreeSet<_>>();
    let mut used_stablecoins = BTreeSet::new();

    for input in inputs {
        if let Ok(reimbursement) = parse_reimbursement(input.call_data, recipient, &allowlist) {
            used_stablecoins.extend(reimbursement.stablecoins.keys().copied());
        }
    }

    if used_stablecoins.is_empty() {
        return Ok(BTreeMap::new());
    }

    let native_oracle = config
        .native_usd_oracle
        .ok_or(SettlementError::InvalidConfiguration(
            "native USD oracle is required for stablecoin settlement",
        ))?;
    let mut feeds = BTreeMap::new();
    insert_oracle_config(&mut feeds, native_oracle)?;

    for stablecoin in used_stablecoins {
        let asset = config
            .stablecoins
            .get(&stablecoin)
            .expect("used stablecoin came from the trusted allowlist");
        insert_oracle_config(&mut feeds, asset.usd_oracle)?;
    }

    Ok(feeds)
}

fn insert_oracle_config(
    feeds: &mut BTreeMap<Address, OracleConfig>,
    oracle: OracleConfig,
) -> Result<(), SettlementError> {
    if feeds
        .insert(oracle.address, oracle)
        .is_some_and(|existing| existing != oracle)
    {
        return Err(SettlementError::InvalidConfiguration(
            "one oracle address has conflicting metadata",
        ));
    }
    Ok(())
}

/// Strictly decodes Chainlink AggregatorV3 `latestRoundData()` and rejects incomplete, negative,
/// future, or stale rounds. Feed decimals are operator policy and are intentionally not queried.
pub(crate) fn decode_latest_round_data(
    oracle: Address,
    response: &[u8],
    now_unix_seconds: u64,
    max_age_seconds: u64,
) -> Result<OracleRound, SettlementError> {
    if response.len() != 5 * 32 {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "response is not five ABI words",
        ));
    }
    let round_id = read_uint80_word(response, 0).ok_or(SettlementError::InvalidOracleRound(
        oracle,
        "roundId is not uint80",
    ))?;
    if round_id.is_zero() {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "roundId is zero",
        ));
    }
    if response[32] & 0x80 != 0 {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "answer is negative",
        ));
    }
    let answer = read_u256_word(response, 32).expect("fixed oracle answer word");
    if answer.is_zero() {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "answer is zero",
        ));
    }
    let started_at = read_u64_word(response, 64).ok_or(SettlementError::InvalidOracleRound(
        oracle,
        "startedAt exceeds uint64",
    ))?;
    let updated_at = read_u64_word(response, 96).ok_or(SettlementError::InvalidOracleRound(
        oracle,
        "updatedAt exceeds uint64",
    ))?;
    let answered_in_round = read_uint80_word(response, 128).ok_or(
        SettlementError::InvalidOracleRound(oracle, "answeredInRound is not uint80"),
    )?;
    if started_at == 0 || updated_at < started_at {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "round timestamps are incomplete",
        ));
    }
    if answered_in_round < round_id {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "answeredInRound precedes roundId",
        ));
    }
    let round = OracleRound { answer, updated_at };
    validate_oracle_freshness(oracle, round, now_unix_seconds, max_age_seconds)?;
    Ok(round)
}

pub(crate) fn validate_oracle_freshness(
    oracle: Address,
    round: OracleRound,
    now_unix_seconds: u64,
    max_age_seconds: u64,
) -> Result<(), SettlementError> {
    if round.answer.is_zero() {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "cached answer is zero",
        ));
    }
    if round.updated_at > now_unix_seconds {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "updatedAt is in the future",
        ));
    }
    if now_unix_seconds - round.updated_at > max_age_seconds {
        return Err(SettlementError::InvalidOracleRound(
            oracle,
            "round is stale",
        ));
    }
    Ok(())
}

fn evaluate_one(
    reimbursement: Reimbursement,
    gas_native_cost: U256,
    marked_cost: U256,
    native_floor: U256,
    config: &ChainAssetConfig,
    oracle_prices: &BTreeMap<Address, U256>,
) -> Result<SettlementEvaluation, SettlementError> {
    let has_native = !reimbursement.native.is_zero();
    match (has_native, reimbursement.stablecoins.len()) {
        (true, 0) => {
            let required_amount = marked_cost.max(native_floor);
            let paid_amount = reimbursement.native;
            Ok(SettlementEvaluation {
                reimbursement,
                gas_native_cost,
                payment_asset: None,
                paid_amount,
                required_amount,
                rejection: (paid_amount < required_amount)
                    .then_some(SettlementRejection::InsufficientPayment),
            })
        }
        (false, 1) => {
            let (&token, &paid_amount) = reimbursement
                .stablecoins
                .first_key_value()
                .expect("stablecoin length is one");
            let asset =
                config
                    .stablecoins
                    .get(&token)
                    .ok_or(SettlementError::InvalidConfiguration(
                        "parsed stablecoin is not in the trusted asset policy",
                    ))?;
            let native_oracle =
                config
                    .native_usd_oracle
                    .ok_or(SettlementError::InvalidConfiguration(
                        "native USD oracle is required for stablecoin settlement",
                    ))?;
            let native_price = oracle_price(oracle_prices, native_oracle.address)?;
            let stable_price = oracle_price(oracle_prices, asset.usd_oracle.address)?;
            let converted = native_to_stable_ceil(
                marked_cost,
                config.native_decimals,
                native_oracle.decimals,
                native_price,
                asset.decimals,
                asset.usd_oracle.decimals,
                stable_price,
            )?;
            let stable_floor = minimum_amount(asset.decimals, MIN_STABLE_FRACTION_DECIMALS)?;
            let required_amount = converted.max(stable_floor);
            Ok(SettlementEvaluation {
                reimbursement,
                gas_native_cost,
                payment_asset: Some(token),
                paid_amount,
                required_amount,
                rejection: (paid_amount < required_amount)
                    .then_some(SettlementRejection::InsufficientPayment),
            })
        }
        (false, 0) => Ok(SettlementEvaluation {
            reimbursement,
            gas_native_cost,
            payment_asset: None,
            paid_amount: U256::ZERO,
            required_amount: marked_cost.max(native_floor),
            rejection: Some(SettlementRejection::InsufficientPayment),
        }),
        _ => Ok(SettlementEvaluation {
            reimbursement,
            gas_native_cost,
            payment_asset: None,
            paid_amount: U256::ZERO,
            required_amount: marked_cost.max(native_floor),
            rejection: Some(SettlementRejection::UnsupportedPaymentCombination),
        }),
    }
}

fn oracle_price(
    prices: &BTreeMap<Address, U256>,
    oracle: Address,
) -> Result<U256, SettlementError> {
    prices
        .get(&oracle)
        .copied()
        .filter(|price| !price.is_zero())
        .ok_or(SettlementError::MissingOraclePrice(oracle))
}

pub(crate) fn native_to_stable_ceil(
    native_amount: U256,
    native_decimals: u32,
    native_oracle_decimals: u32,
    native_usd_price: U256,
    stable_decimals: u32,
    stable_oracle_decimals: u32,
    stable_usd_price: U256,
) -> Result<U256, SettlementError> {
    if native_usd_price.is_zero() || stable_usd_price.is_zero() {
        return Err(SettlementError::ArithmeticOverflow);
    }
    let numerator_exponent = stable_decimals
        .checked_add(stable_oracle_decimals)
        .ok_or(SettlementError::ArithmeticOverflow)?;
    let denominator_exponent = native_decimals
        .checked_add(native_oracle_decimals)
        .ok_or(SettlementError::ArithmeticOverflow)?;
    let common_exponent = numerator_exponent.min(denominator_exponent);
    let numerator_scale = checked_pow10_u512(numerator_exponent - common_exponent)
        .ok_or(SettlementError::ArithmeticOverflow)?;
    let denominator_scale = checked_pow10_u512(denominator_exponent - common_exponent)
        .ok_or(SettlementError::ArithmeticOverflow)?;
    let numerator = widen_u256(native_amount)
        .checked_mul(widen_u256(native_usd_price))
        .and_then(|value| value.checked_mul(numerator_scale))
        .ok_or(SettlementError::ArithmeticOverflow)?;
    let denominator = widen_u256(stable_usd_price)
        .checked_mul(denominator_scale)
        .ok_or(SettlementError::ArithmeticOverflow)?;
    if denominator.is_zero() {
        return Err(SettlementError::ArithmeticOverflow);
    }
    let quotient = numerator / denominator;
    let rounded = if numerator % denominator == U512::ZERO {
        quotient
    } else {
        quotient
            .checked_add(U512::ONE)
            .ok_or(SettlementError::ArithmeticOverflow)?
    };
    narrow_u512(rounded)
}

fn rejected_parse(
    gas_native_cost: U256,
    marked_cost: U256,
    native_floor: U256,
    error: ReimbursementParseError,
) -> SettlementEvaluation {
    SettlementEvaluation {
        reimbursement: Reimbursement::default(),
        gas_native_cost,
        payment_asset: None,
        paid_amount: U256::ZERO,
        required_amount: marked_cost.max(native_floor),
        rejection: Some(match error {
            ReimbursementParseError::MalformedCallData => SettlementRejection::MalformedCallData,
            ReimbursementParseError::ArithmeticOverflow => SettlementRejection::ArithmeticOverflow,
        }),
    }
}

fn validate_config(config: &ChainAssetConfig) -> Result<(), SettlementError> {
    if config.settlement_markup_bps < 10_000 {
        return Err(SettlementError::InvalidConfiguration(
            "settlement markup cannot be below 10_000 bps",
        ));
    }
    minimum_amount(config.native_decimals, MIN_NATIVE_FRACTION_DECIMALS)?;
    if !config.stablecoins.is_empty() && config.native_usd_oracle.is_none() {
        return Err(SettlementError::InvalidConfiguration(
            "native USD oracle is required when stablecoins are enabled",
        ));
    }
    let mut oracle_configs = BTreeMap::new();
    if let Some(oracle) = config.native_usd_oracle {
        validate_oracle_config(oracle)?;
        insert_oracle_config(&mut oracle_configs, oracle)?;
    }
    for asset in config.stablecoins.values() {
        minimum_amount(asset.decimals, MIN_STABLE_FRACTION_DECIMALS)?;
        if asset.symbol.trim().is_empty() {
            return Err(SettlementError::InvalidConfiguration(
                "stablecoin symbol cannot be empty",
            ));
        }
        validate_oracle_config(asset.usd_oracle)?;
        insert_oracle_config(&mut oracle_configs, asset.usd_oracle)?;
    }
    Ok(())
}

fn validate_oracle_config(oracle: OracleConfig) -> Result<(), SettlementError> {
    if oracle.decimals > 38 || oracle.max_age_seconds == 0 {
        return Err(SettlementError::InvalidConfiguration(
            "oracle decimals must not exceed 38 and max age must be non-zero",
        ));
    }
    Ok(())
}

fn decode_multisend_transactions(call_data: &[u8]) -> Option<&[u8]> {
    if call_data.get(..4)? != EXECUTE_USER_OP_SELECTOR {
        return None;
    }
    let args = call_data.get(4..)?;
    let target = read_address_word(args, 0)?;
    let data_offset = read_usize_word(args, 64)?;
    let operation = read_u256_word(args, 96)?;
    if target != TRUSTED_MULTISEND || operation != U256::from(1u8) {
        return None;
    }

    let inner_data = read_dynamic_bytes(args, data_offset)?;
    if inner_data.get(..4)? != MULTISEND_SELECTOR {
        return None;
    }
    let inner_args = inner_data.get(4..)?;
    let transaction_offset = read_usize_word(inner_args, 0)?;
    read_dynamic_bytes(inner_args, transaction_offset)
}

fn decode_erc20_transfer(data: &[u8]) -> Option<(Address, U256)> {
    if data.len() != 68 || data.get(..4)? != ERC20_TRANSFER_SELECTOR {
        return None;
    }
    Some((read_address_word(data, 4)?, read_u256_word(data, 36)?))
}

fn read_dynamic_bytes(data: &[u8], offset: usize) -> Option<&[u8]> {
    if offset % 32 != 0 {
        return None;
    }
    let length = read_usize_word(data, offset)?;
    let start = offset.checked_add(32)?;
    let end = start.checked_add(length)?;
    data.get(start..end)
}

fn read_address_word(data: &[u8], offset: usize) -> Option<Address> {
    let word = data.get(offset..offset.checked_add(32)?)?;
    if word[..12].iter().any(|byte| *byte != 0) {
        return None;
    }
    Some(Address::from_slice(&word[12..]))
}

fn read_packed_address(data: &[u8], offset: usize) -> Option<Address> {
    Some(Address::from_slice(
        data.get(offset..offset.checked_add(20)?)?,
    ))
}

fn read_u256_word(data: &[u8], offset: usize) -> Option<U256> {
    Some(U256::from_be_slice(
        data.get(offset..offset.checked_add(32)?)?,
    ))
}

fn read_uint80_word(data: &[u8], offset: usize) -> Option<U256> {
    let word = data.get(offset..offset.checked_add(32)?)?;
    if word[..22].iter().any(|byte| *byte != 0) {
        return None;
    }
    Some(U256::from_be_slice(word))
}

fn read_u64_word(data: &[u8], offset: usize) -> Option<u64> {
    let value = read_u256_word(data, offset)?;
    u64::try_from(value).ok()
}

fn read_usize_word(data: &[u8], offset: usize) -> Option<usize> {
    let value = read_u256_word(data, offset)?;
    if value > U256::from(usize::MAX) {
        return None;
    }
    Some(value.to::<usize>())
}

fn address_word(address: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address.as_slice());
    word
}

fn minimum_amount(decimals: u32, fraction_decimals: u32) -> Result<U256, SettlementError> {
    let exponent =
        decimals
            .checked_sub(fraction_decimals)
            .ok_or(SettlementError::InvalidConfiguration(
                "asset decimals are below the settlement floor",
            ))?;
    checked_pow10(exponent).ok_or(SettlementError::InvalidConfiguration(
        "asset decimals exceed U256 settlement arithmetic",
    ))
}

fn checked_pow10(exponent: u32) -> Option<U256> {
    let mut value = U256::ONE;
    for _ in 0..exponent {
        value = value.checked_mul(U256::from(10u8))?;
    }
    Some(value)
}

fn checked_pow10_u512(exponent: u32) -> Option<U512> {
    let mut value = U512::ONE;
    for _ in 0..exponent {
        value = value.checked_mul(U512::from(10u8))?;
    }
    Some(value)
}

fn mul_div_ceil(left: U256, right: U256, denominator: U256) -> Result<U256, SettlementError> {
    if denominator.is_zero() {
        return Err(SettlementError::ArithmeticOverflow);
    }
    let denominator = widen_u256(denominator);
    let product = widen_u256(left) * widen_u256(right);
    let quotient = product / denominator;
    let rounded = if product % denominator == U512::ZERO {
        quotient
    } else {
        quotient
            .checked_add(U512::ONE)
            .ok_or(SettlementError::ArithmeticOverflow)?
    };
    narrow_u512(rounded)
}

fn widen_u256(value: U256) -> U512 {
    let limbs = value.into_limbs();
    U512::from_limbs([limbs[0], limbs[1], limbs[2], limbs[3], 0, 0, 0, 0])
}

fn narrow_u512(value: U512) -> Result<U256, SettlementError> {
    let limbs = value.into_limbs();
    if limbs[4..].iter().any(|limb| *limb != 0) {
        return Err(SettlementError::ArithmeticOverflow);
    }
    Ok(U256::from_limbs([limbs[0], limbs[1], limbs[2], limbs[3]]))
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use alloy::primitives::{Address, B256, U256, address, keccak256};

    use super::{
        ChainAssetConfig, OracleConfig, ReimbursementParseError, SettlementInput, SettlementLog,
        SettlementRejection, StablecoinConfig, decode_latest_round_data, evaluate_batch,
        native_to_stable_ceil, parse_reimbursement, required_oracle_feeds,
        verify_stable_transfer_logs,
    };

    const RECIPIENT: Address = address!("1111111111111111111111111111111111111111");
    const STABLECOIN: Address = address!("2222222222222222222222222222222222222222");
    const NATIVE_ORACLE: Address = address!("3333333333333333333333333333333333333333");
    const STABLE_ORACLE: Address = address!("4444444444444444444444444444444444444444");
    const SENDER: Address = address!("6666666666666666666666666666666666666666");

    #[test]
    fn parses_values_above_u128_without_saturation() {
        let amount = U256::from(u128::MAX) + U256::ONE;
        let call_data = safe_multisend(&[Entry::native(RECIPIENT, amount)]);
        let parsed = parse_reimbursement(&call_data, RECIPIENT, &BTreeSet::new()).unwrap();

        assert_eq!(parsed.native, amount);
    }

    #[test]
    fn rejects_u256_sum_overflow_instead_of_wrapping_or_saturating() {
        let call_data = safe_multisend(&[
            Entry::native(RECIPIENT, U256::MAX),
            Entry::native(RECIPIENT, U256::ONE),
        ]);

        assert_eq!(
            parse_reimbursement(&call_data, RECIPIENT, &BTreeSet::new()),
            Err(ReimbursementParseError::ArithmeticOverflow)
        );
    }

    #[test]
    fn does_not_credit_malicious_transfer_shaped_calldata() {
        let mut entries = vec![Entry::erc20(STABLECOIN, RECIPIENT, U256::from(50_000u64))];
        entries[0].operation = 1;
        let call_data = safe_multisend(&entries);
        let allowlist = BTreeSet::from([STABLECOIN]);
        let parsed = parse_reimbursement(&call_data, RECIPIENT, &allowlist).unwrap();
        assert!(parsed.stablecoins.is_empty());

        let mut wrong_outer_operation = safe_multisend(&[Entry::native(RECIPIENT, U256::ONE)]);
        // executeUserOp's operation word starts at selector + 96.
        wrong_outer_operation[4 + 96 + 31] = 0;
        assert_eq!(
            parse_reimbursement(&wrong_outer_operation, RECIPIENT, &allowlist),
            Err(ReimbursementParseError::MalformedCallData)
        );

        let unknown_token = address!("5555555555555555555555555555555555555555");
        let call_data = safe_multisend(&[Entry::erc20(
            unknown_token,
            RECIPIENT,
            U256::from(50_000u64),
        )]);
        assert!(
            parse_reimbursement(&call_data, RECIPIENT, &allowlist)
                .unwrap()
                .stablecoins
                .is_empty()
        );
    }

    #[test]
    fn evaluates_each_operation_without_cross_subsidy() {
        let config = native_config(5);
        let rich = safe_multisend(&[Entry::native(RECIPIENT, U256::from(399u64))]);
        let poor = safe_multisend(&[Entry::native(RECIPIENT, U256::ONE)]);
        let evaluation = evaluate_batch(
            RECIPIENT,
            &config,
            &[
                SettlementInput {
                    call_data: &rich,
                    gas_native_cost: U256::from(100u64),
                },
                SettlementInput {
                    call_data: &poor,
                    gas_native_cost: U256::from(100u64),
                },
            ],
            &BTreeMap::new(),
        )
        .unwrap();

        assert!(evaluation.operations[0].accepted());
        assert_eq!(
            evaluation.operations[1].rejection,
            Some(SettlementRejection::InsufficientPayment)
        );
        assert!(!evaluation.all_accepted());
    }

    #[test]
    fn uses_configured_markup_with_ceiling_rounding() {
        let mut config = native_config(5);
        config.settlement_markup_bps = 15_001;
        let four = safe_multisend(&[Entry::native(RECIPIENT, U256::from(4u8))]);
        let five = safe_multisend(&[Entry::native(RECIPIENT, U256::from(5u8))]);
        let evaluation = evaluate_batch(
            RECIPIENT,
            &config,
            &[
                SettlementInput {
                    call_data: &four,
                    gas_native_cost: U256::from(3u8),
                },
                SettlementInput {
                    call_data: &five,
                    gas_native_cost: U256::from(3u8),
                },
            ],
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(evaluation.operations[0].required_amount, U256::from(5u8));
        assert!(!evaluation.operations[0].accepted());
        assert!(evaluation.operations[1].accepted());
    }

    #[test]
    fn confirms_stablecoin_payment_from_single_op_transfer_logs() {
        let call_data = safe_multisend(&[Entry::erc20(STABLECOIN, RECIPIENT, U256::from(100u8))]);
        let reimbursement =
            parse_reimbursement(&call_data, RECIPIENT, &BTreeSet::from([STABLECOIN])).unwrap();
        let logs = vec![
            transfer_log(STABLECOIN, SENDER, RECIPIENT, U256::from(40u8)),
            transfer_log(STABLECOIN, SENDER, RECIPIENT, U256::from(60u8)),
        ];
        assert!(verify_stable_transfer_logs(
            &reimbursement,
            SENDER,
            RECIPIENT,
            &logs
        ));

        let wrong_sender = address!("7777777777777777777777777777777777777777");
        assert!(!verify_stable_transfer_logs(
            &reimbursement,
            SENDER,
            RECIPIENT,
            &[transfer_log(
                STABLECOIN,
                wrong_sender,
                RECIPIENT,
                U256::from(100u8),
            )]
        ));
        assert!(!verify_stable_transfer_logs(
            &reimbursement,
            SENDER,
            RECIPIENT,
            &[
                transfer_log(STABLECOIN, SENDER, RECIPIENT, U256::MAX),
                transfer_log(STABLECOIN, SENDER, RECIPIENT, U256::ONE),
            ]
        ));
    }

    #[test]
    fn enforces_native_and_stablecoin_floors_with_bundler_favourable_rounding() {
        let native_config = native_config(18);
        let below_native = safe_multisend(&[Entry::native(
            RECIPIENT,
            U256::from(10_000_000_000_000u64 - 1),
        )]);
        let at_native =
            safe_multisend(&[Entry::native(RECIPIENT, U256::from(10_000_000_000_000u64))]);
        let native_result = evaluate_batch(
            RECIPIENT,
            &native_config,
            &[
                SettlementInput {
                    call_data: &below_native,
                    gas_native_cost: U256::ZERO,
                },
                SettlementInput {
                    call_data: &at_native,
                    gas_native_cost: U256::ZERO,
                },
            ],
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(!native_result.operations[0].accepted());
        assert!(native_result.operations[1].accepted());

        let stable_config = config_with_stable(18, 6);
        let below_floor =
            safe_multisend(&[Entry::erc20(STABLECOIN, RECIPIENT, U256::from(9_999u64))]);
        let at_floor =
            safe_multisend(&[Entry::erc20(STABLECOIN, RECIPIENT, U256::from(10_000u64))]);
        let stable_result = evaluate_batch(
            RECIPIENT,
            &stable_config,
            &[
                SettlementInput {
                    call_data: &below_floor,
                    gas_native_cost: U256::ZERO,
                },
                SettlementInput {
                    call_data: &at_floor,
                    gas_native_cost: U256::ZERO,
                },
            ],
            &oracle_prices(2_000_00000000, 1_00000000),
        )
        .unwrap();
        assert_eq!(
            stable_result.operations[0].required_amount,
            U256::from(10_000u64)
        );
        assert!(!stable_result.operations[0].accepted());
        assert!(stable_result.operations[1].accepted());
    }

    #[test]
    fn converts_native_cost_to_stable_units_with_ceiling_rounding() {
        // 0.001 ETH at $2,000/ETH costs $2, so a 6-decimal $1 stable requires 2_000_000 units.
        assert_eq!(
            native_to_stable_ceil(
                U256::from(1_000_000_000_000_000u64),
                18,
                8,
                U256::from(2_000_00000000u64),
                6,
                8,
                U256::from(1_00000000u64),
            )
            .unwrap(),
            U256::from(2_000_000u64)
        );

        // The exact rational result is 1/3 base unit and must round up in the bundler's favour.
        assert_eq!(
            native_to_stable_ceil(U256::ONE, 0, 0, U256::ONE, 0, 0, U256::from(3u8),).unwrap(),
            U256::ONE
        );
    }

    #[test]
    fn fails_closed_on_oracle_conversion_overflow() {
        assert!(native_to_stable_ceil(U256::MAX, 0, 0, U256::MAX, 38, 38, U256::ONE,).is_err());
    }

    #[test]
    fn decodes_only_positive_complete_and_fresh_oracle_rounds() {
        let now = 1_000u64;
        let valid = oracle_response(7, U256::from(2_000_00000000u64), 900, 950, 7);
        let round = decode_latest_round_data(NATIVE_ORACLE, &valid, now, 100).unwrap();
        assert_eq!(round.answer, U256::from(2_000_00000000u64));
        assert_eq!(round.updated_at, 950);

        assert!(
            decode_latest_round_data(
                NATIVE_ORACLE,
                &oracle_response(7, U256::from(2_000_00000000u64), 800, 899, 7),
                now,
                100,
            )
            .is_err()
        );
        assert!(
            decode_latest_round_data(
                NATIVE_ORACLE,
                &oracle_response(7, U256::from(2_000_00000000u64), 900, 950, 6),
                now,
                100,
            )
            .is_err()
        );
        assert!(
            decode_latest_round_data(
                NATIVE_ORACLE,
                &oracle_response(7, U256::ZERO, 900, 950, 7),
                now,
                100,
            )
            .is_err()
        );
        let mut negative = oracle_response(7, U256::ONE, 900, 950, 7);
        negative[32] = 0xff;
        assert!(decode_latest_round_data(NATIVE_ORACLE, &negative, now, 100).is_err());
    }

    #[test]
    fn fetches_oracles_only_for_stablecoin_payments() {
        let config = config_with_stable(18, 6);
        let native = safe_multisend(&[Entry::native(RECIPIENT, U256::ONE)]);
        assert!(
            required_oracle_feeds(
                RECIPIENT,
                &config,
                &[SettlementInput {
                    call_data: &native,
                    gas_native_cost: U256::ONE,
                }],
            )
            .unwrap()
            .is_empty()
        );

        let stable = safe_multisend(&[Entry::erc20(STABLECOIN, RECIPIENT, U256::ONE)]);
        let feeds = required_oracle_feeds(
            RECIPIENT,
            &config,
            &[SettlementInput {
                call_data: &stable,
                gas_native_cost: U256::ONE,
            }],
        )
        .unwrap();
        assert_eq!(
            feeds.keys().copied().collect::<Vec<_>>(),
            [NATIVE_ORACLE, STABLE_ORACLE]
        );
    }

    #[test]
    fn rejects_mixed_payment_assets() {
        let config = config_with_stable(18, 6);
        let mixed = safe_multisend(&[
            Entry::native(RECIPIENT, U256::from(10_000_000_000_000u64)),
            Entry::erc20(STABLECOIN, RECIPIENT, U256::from(10_000u64)),
        ]);
        let result = evaluate_batch(
            RECIPIENT,
            &config,
            &[SettlementInput {
                call_data: &mixed,
                gas_native_cost: U256::ZERO,
            }],
            &oracle_prices(2_000_00000000, 1_00000000),
        )
        .unwrap();
        assert_eq!(
            result.operations[0].rejection,
            Some(SettlementRejection::UnsupportedPaymentCombination)
        );
    }

    fn native_config(native_decimals: u32) -> ChainAssetConfig {
        ChainAssetConfig {
            native_decimals,
            settlement_markup_bps: 20_000,
            native_usd_oracle: None,
            stablecoins: BTreeMap::new(),
        }
    }

    fn config_with_stable(native_decimals: u32, stable_decimals: u32) -> ChainAssetConfig {
        ChainAssetConfig {
            native_decimals,
            settlement_markup_bps: 20_000,
            native_usd_oracle: Some(OracleConfig {
                address: NATIVE_ORACLE,
                decimals: 8,
                max_age_seconds: 3_600,
            }),
            stablecoins: BTreeMap::from([(
                STABLECOIN,
                StablecoinConfig {
                    symbol: "USDC".into(),
                    decimals: stable_decimals,
                    usd_oracle: OracleConfig {
                        address: STABLE_ORACLE,
                        decimals: 8,
                        max_age_seconds: 86_400,
                    },
                },
            )]),
        }
    }

    fn oracle_prices(native: u64, stable: u64) -> BTreeMap<Address, U256> {
        BTreeMap::from([
            (NATIVE_ORACLE, U256::from(native)),
            (STABLE_ORACLE, U256::from(stable)),
        ])
    }

    fn oracle_response(
        round_id: u64,
        answer: U256,
        started_at: u64,
        updated_at: u64,
        answered_in_round: u64,
    ) -> Vec<u8> {
        let mut response = Vec::with_capacity(160);
        for value in [
            U256::from(round_id),
            answer,
            U256::from(started_at),
            U256::from(updated_at),
            U256::from(answered_in_round),
        ] {
            response.extend_from_slice(&value.to_be_bytes::<32>());
        }
        response
    }

    fn transfer_log(token: Address, from: Address, to: Address, amount: U256) -> SettlementLog {
        SettlementLog {
            address: token,
            topics: vec![
                keccak256(b"Transfer(address,address,uint256)"),
                B256::from(super::address_word(from)),
                B256::from(super::address_word(to)),
            ],
            data: amount.to_be_bytes::<32>().to_vec().into(),
        }
    }

    struct Entry {
        operation: u8,
        to: Address,
        value: U256,
        data: Vec<u8>,
    }

    impl Entry {
        fn native(to: Address, value: U256) -> Self {
            Self {
                operation: 0,
                to,
                value,
                data: Vec::new(),
            }
        }

        fn erc20(token: Address, recipient: Address, amount: U256) -> Self {
            let mut data = Vec::with_capacity(68);
            data.extend_from_slice(&[0xa9, 0x05, 0x9c, 0xbb]);
            data.extend_from_slice(&super::address_word(recipient));
            data.extend_from_slice(&amount.to_be_bytes::<32>());
            Self {
                operation: 0,
                to: token,
                value: U256::ZERO,
                data,
            }
        }
    }

    fn safe_multisend(entries: &[Entry]) -> Vec<u8> {
        let mut transactions = Vec::new();
        for entry in entries {
            transactions.push(entry.operation);
            transactions.extend_from_slice(entry.to.as_slice());
            transactions.extend_from_slice(&entry.value.to_be_bytes::<32>());
            transactions.extend_from_slice(&U256::from(entry.data.len()).to_be_bytes::<32>());
            transactions.extend_from_slice(&entry.data);
        }

        let mut inner = Vec::new();
        inner.extend_from_slice(&[0x8d, 0x80, 0xff, 0x0a]);
        inner.extend_from_slice(&U256::from(32u8).to_be_bytes::<32>());
        inner.extend_from_slice(&U256::from(transactions.len()).to_be_bytes::<32>());
        inner.extend_from_slice(&transactions);
        pad_to_word(&mut inner);

        let mut outer = Vec::new();
        outer.extend_from_slice(&[0x7b, 0xb3, 0x74, 0x28]);
        outer.extend_from_slice(&super::address_word(super::TRUSTED_MULTISEND));
        outer.extend_from_slice(&[0u8; 32]);
        outer.extend_from_slice(&U256::from(128u64).to_be_bytes::<32>());
        outer.extend_from_slice(&U256::ONE.to_be_bytes::<32>());
        outer.extend_from_slice(&U256::from(inner.len()).to_be_bytes::<32>());
        outer.extend_from_slice(&inner);
        pad_to_word(&mut outer);
        outer
    }

    fn pad_to_word(bytes: &mut Vec<u8>) {
        let padding = (32 - bytes.len() % 32) % 32;
        bytes.resize(bytes.len() + padding, 0);
    }
}
