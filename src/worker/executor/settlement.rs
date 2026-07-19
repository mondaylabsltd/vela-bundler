use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::{Display, Formatter},
};

use alloy::primitives::{Address, B256, Bytes, U256, address, aliases::U512, keccak256};

const EXECUTE_USER_OP_SELECTOR: [u8; 4] = [0x7b, 0xb3, 0x74, 0x28];
const MULTISEND_SELECTOR: [u8; 4] = [0x8d, 0x80, 0xff, 0x0a];
const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const TRUSTED_MULTISEND: Address = address!("38869bf66a61cf6bdb996a6ae40d5853fd43b526");

pub(crate) const MIN_NATIVE_FRACTION_DECIMALS: u32 = 5;
pub(crate) const MIN_STABLE_FRACTION_DECIMALS: u32 = 2;
pub(crate) const USD_PRICE_DECIMALS: u32 = 8;

/// Settlement assets loaded from the controlled chain directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChainAssetConfig {
    pub(crate) native_decimals: u32,
    /// Required reimbursement ratio in basis points; 20_000 means 2x cost.
    pub(crate) settlement_markup_bps: u64,
    pub(crate) stablecoins: BTreeMap<Address, StablecoinConfig>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StablecoinConfig {
    pub(crate) symbol: String,
    pub(crate) decimals: u32,
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
    MissingNativeUsdPrice,
}

impl Display for SettlementError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration(message) => formatter.write_str(message),
            Self::ArithmeticOverflow => formatter.write_str("settlement arithmetic overflow"),
            Self::MissingNativeUsdPrice => formatter.write_str("missing Binance native USD price"),
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
    native_usd_price: Option<U256>,
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
            native_usd_price,
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

fn evaluate_one(
    reimbursement: Reimbursement,
    gas_native_cost: U256,
    marked_cost: U256,
    native_floor: U256,
    config: &ChainAssetConfig,
    native_usd_price: Option<U256>,
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
            let converted = native_to_usd_stable_ceil(
                marked_cost,
                config.native_decimals,
                native_usd_price.ok_or(SettlementError::MissingNativeUsdPrice)?,
                asset.decimals,
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

pub(crate) fn native_to_usd_stable_ceil(
    native_amount: U256,
    native_decimals: u32,
    native_usd_price: U256,
    stable_decimals: u32,
) -> Result<U256, SettlementError> {
    if native_usd_price.is_zero() {
        return Err(SettlementError::ArithmeticOverflow);
    }
    let denominator_exponent = native_decimals
        .checked_add(USD_PRICE_DECIMALS)
        .ok_or(SettlementError::ArithmeticOverflow)?;
    let numerator_scale =
        checked_pow10_u512(stable_decimals).ok_or(SettlementError::ArithmeticOverflow)?;
    let denominator_scale =
        checked_pow10_u512(denominator_exponent).ok_or(SettlementError::ArithmeticOverflow)?;
    let numerator = widen_u256(native_amount)
        .checked_mul(widen_u256(native_usd_price))
        .and_then(|value| value.checked_mul(numerator_scale))
        .ok_or(SettlementError::ArithmeticOverflow)?;
    let denominator = denominator_scale;
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
    for asset in config.stablecoins.values() {
        minimum_amount(asset.decimals, MIN_STABLE_FRACTION_DECIMALS)?;
        if asset.symbol.trim().is_empty() {
            return Err(SettlementError::InvalidConfiguration(
                "stablecoin symbol cannot be empty",
            ));
        }
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
        ChainAssetConfig, ReimbursementParseError, SettlementInput, SettlementLog,
        SettlementRejection, StablecoinConfig, evaluate_batch, native_to_usd_stable_ceil,
        parse_reimbursement, verify_stable_transfer_logs,
    };

    const RECIPIENT: Address = address!("1111111111111111111111111111111111111111");
    const STABLECOIN: Address = address!("2222222222222222222222222222222222222222");
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
            None,
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
            None,
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
            None,
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
            Some(U256::from(2_000_00000000u64)),
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
            native_to_usd_stable_ceil(
                U256::from(1_000_000_000_000_000u64),
                18,
                U256::from(2_000_00000000u64),
                6,
            )
            .unwrap(),
            U256::from(2_000_000u64)
        );

        // The exact rational result is one billionth of a base unit and must round up.
        assert_eq!(
            native_to_usd_stable_ceil(U256::ONE, 0, U256::ONE, 0).unwrap(),
            U256::ONE
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
            None,
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
            stablecoins: BTreeMap::new(),
        }
    }

    fn config_with_stable(native_decimals: u32, stable_decimals: u32) -> ChainAssetConfig {
        ChainAssetConfig {
            native_decimals,
            settlement_markup_bps: 20_000,
            stablecoins: BTreeMap::from([(
                STABLECOIN,
                StablecoinConfig {
                    symbol: "USDC".into(),
                    decimals: stable_decimals,
                },
            )]),
        }
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
