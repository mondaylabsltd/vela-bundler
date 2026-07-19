use std::collections::{BTreeMap, BTreeSet};

const EXECUTE_USER_OP_SELECTOR: [u8; 4] = [0x7b, 0xb3, 0x74, 0x28];
const MULTISEND_SELECTOR: [u8; 4] = [0x8d, 0x80, 0xff, 0x0a];
const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const TRUSTED_MULTISEND: &str = "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526";

pub const MIN_NATIVE_FRACTION_DECIMALS: u32 = 5;
pub const MIN_STABLE_FRACTION_DECIMALS: u32 = 2;

#[derive(Debug, PartialEq, Eq)]
pub struct InBandReimbursement {
    pub native: u128,
    pub stablecoins: BTreeMap<String, u128>,
}

/// Decode reimbursement legs from Safe `executeUserOp` calldata.
///
/// A transfer counts only when it is inside a `DELEGATECALL` to the canonical Safe
/// MultiSend contract. This prevents a caller from presenting transfer-shaped bytes
/// that do not actually execute against the Safe's balance.
pub fn parse_reimbursement(
    call_data: &str,
    recipient: &str,
    stablecoin_allowlist: impl IntoIterator<Item = String>,
) -> InBandReimbursement {
    let empty = InBandReimbursement {
        native: 0,
        stablecoins: BTreeMap::new(),
    };

    let Ok(recipient) = parse_address(recipient) else {
        return empty;
    };
    let trusted_multisend = parse_address(TRUSTED_MULTISEND).expect("trusted MultiSend is valid");
    let stablecoin_allowlist = stablecoin_allowlist
        .into_iter()
        .filter_map(|address| parse_address(&address).ok())
        .collect::<BTreeSet<_>>();
    let Ok(call_data) = decode_hex(call_data) else {
        return empty;
    };
    let Some(entries) = decode_multisend_entries(&call_data, trusted_multisend) else {
        return empty;
    };

    let mut reimbursement = empty;
    for entry in entries {
        if entry.operation != 0 {
            continue;
        }

        if entry.to == recipient && entry.value > 0 {
            reimbursement.native = reimbursement.native.saturating_add(entry.value);
        }

        if !stablecoin_allowlist.contains(&entry.to) {
            continue;
        }

        let Some((transfer_recipient, amount)) = decode_erc20_transfer(&entry.data) else {
            continue;
        };
        if transfer_recipient != recipient {
            continue;
        }

        let address = format_address(entry.to);
        let total = reimbursement.stablecoins.entry(address).or_default();
        *total = total.saturating_add(amount);
    }

    reimbursement
}

pub fn minimum_native_amount(native_decimals: u32) -> Option<u128> {
    native_decimals
        .checked_sub(MIN_NATIVE_FRACTION_DECIMALS)
        .and_then(pow10)
}

pub fn minimum_stablecoin_amount(token_decimals: u32) -> Option<u128> {
    token_decimals
        .checked_sub(MIN_STABLE_FRACTION_DECIMALS)
        .and_then(pow10)
}

pub fn is_tempo_chain(chain_id: u64) -> bool {
    matches!(chain_id, 4_217 | 42_431)
}

pub fn parse_address(value: &str) -> Result<[u8; 20], ()> {
    let value = value.strip_prefix("0x").ok_or(())?;
    if value.len() != 40 {
        return Err(());
    }

    let bytes = hex::decode(value).map_err(|_| ())?;
    bytes.try_into().map_err(|_| ())
}

pub fn decode_hex(value: &str) -> Result<Vec<u8>, ()> {
    let value = value.strip_prefix("0x").ok_or(())?;
    if value.len() % 2 != 0 {
        return Err(());
    }

    hex::decode(value).map_err(|_| ())
}

fn decode_multisend_entries(
    call_data: &[u8],
    trusted_multisend: [u8; 20],
) -> Option<Vec<MultiSendEntry>> {
    let args = call_data.get(4..)?;
    if call_data.get(..4)? != EXECUTE_USER_OP_SELECTOR {
        return None;
    }

    let target = read_address_word(args, 0)?;
    let data_offset = read_usize_word(args, 64)?;
    let operation = read_u128_word(args, 96)?;
    if target != trusted_multisend || operation != 1 {
        return None;
    }

    let inner_data = read_dynamic_bytes(args, data_offset)?;
    if inner_data.get(..4)? != MULTISEND_SELECTOR {
        return None;
    }

    let inner_args = inner_data.get(4..)?;
    let transaction_offset = read_usize_word(inner_args, 0)?;
    let transactions = read_dynamic_bytes(inner_args, transaction_offset)?;

    let mut entries = Vec::new();
    let mut offset = 0;
    while offset < transactions.len() {
        let operation = *transactions.get(offset)?;
        let to = transactions.get(offset + 1..offset + 21)?.try_into().ok()?;
        let value = read_u128_word(transactions, offset + 21)?;
        let data_length = read_usize_word(transactions, offset + 53)?;
        let data_start = offset.checked_add(85)?;
        let data_end = data_start.checked_add(data_length)?;
        let data = transactions.get(data_start..data_end)?.to_vec();
        entries.push(MultiSendEntry {
            operation,
            to,
            value,
            data,
        });
        offset = data_end;
    }

    Some(entries)
}

fn decode_erc20_transfer(data: &[u8]) -> Option<([u8; 20], u128)> {
    if data.len() != 68 || data.get(..4)? != ERC20_TRANSFER_SELECTOR {
        return None;
    }

    Some((read_address_word(data, 4)?, read_u128_word(data, 36)?))
}

fn read_dynamic_bytes(data: &[u8], offset: usize) -> Option<&[u8]> {
    let length = read_usize_word(data, offset)?;
    let start = offset.checked_add(32)?;
    let end = start.checked_add(length)?;
    data.get(start..end)
}

fn read_address_word(data: &[u8], offset: usize) -> Option<[u8; 20]> {
    data.get(offset + 12..offset + 32)?.try_into().ok()
}

fn read_u128_word(data: &[u8], offset: usize) -> Option<u128> {
    let word = data.get(offset..offset + 32)?;
    let upper = word.get(..16)?;
    if upper.iter().any(|byte| *byte != 0) {
        return Some(u128::MAX);
    }

    Some(u128::from_be_bytes(word.get(16..32)?.try_into().ok()?))
}

fn read_usize_word(data: &[u8], offset: usize) -> Option<usize> {
    let word = data.get(offset..offset + 32)?;
    if word.get(..24)?.iter().any(|byte| *byte != 0) {
        return None;
    }

    let value = u64::from_be_bytes(word.get(24..32)?.try_into().ok()?);
    value.try_into().ok()
}

fn format_address(address: [u8; 20]) -> String {
    format!("0x{}", hex::encode(address))
}

fn pow10(exponent: u32) -> Option<u128> {
    10u128.checked_pow(exponent)
}

struct MultiSendEntry {
    operation: u8,
    to: [u8; 20],
    value: u128,
    data: Vec<u8>,
}

mod hex {
    pub fn decode(value: &str) -> Result<Vec<u8>, ()> {
        let mut bytes = Vec::with_capacity(value.len() / 2);
        let mut chars = value.as_bytes().chunks_exact(2);
        for pair in &mut chars {
            let high = value_of(pair[0]).ok_or(())?;
            let low = value_of(pair[1]).ok_or(())?;
            bytes.push((high << 4) | low);
        }
        if !chars.remainder().is_empty() {
            return Err(());
        }
        Ok(bytes)
    }

    pub fn encode(value: [u8; 20]) -> String {
        const TABLE: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(40);
        for byte in value {
            output.push(TABLE[(byte >> 4) as usize] as char);
            output.push(TABLE[(byte & 0x0f) as usize] as char);
        }
        output
    }

    fn value_of(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        TRUSTED_MULTISEND, minimum_native_amount, minimum_stablecoin_amount, parse_reimbursement,
    };

    const RECIPIENT: &str = "0x1111111111111111111111111111111111111111";
    const STABLECOIN: &str = "0x2222222222222222222222222222222222222222";

    #[test]
    fn counts_only_native_and_allowlisted_stablecoin_legs_to_the_recipient() {
        let call_data = encode_safe_multisend(&[
            Entry::native(RECIPIENT, 10_000_000_000_000),
            Entry::erc20(STABLECOIN, RECIPIENT, 10_000),
            Entry::erc20(
                "0x3333333333333333333333333333333333333333",
                RECIPIENT,
                99_999,
            ),
        ]);

        let reimbursement = parse_reimbursement(&call_data, RECIPIENT, [STABLECOIN.into()]);

        assert_eq!(reimbursement.native, 10_000_000_000_000);
        assert_eq!(reimbursement.stablecoins[STABLECOIN], 10_000);
        assert_eq!(reimbursement.stablecoins.len(), 1);
    }

    #[test]
    fn rejects_transfer_shaped_data_without_a_delegatecall_to_trusted_multisend() {
        let call_data = encode_safe_multisend(&[Entry::erc20(STABLECOIN, RECIPIENT, 10_000)]);
        let tampered = call_data.replacen("01", "00", 1);

        let reimbursement = parse_reimbursement(&tampered, RECIPIENT, [STABLECOIN.into()]);

        assert_eq!(reimbursement.native, 0);
        assert!(reimbursement.stablecoins.is_empty());
    }

    #[test]
    fn calculates_minimum_amounts_in_smallest_units() {
        assert_eq!(minimum_native_amount(18), Some(10_000_000_000_000));
        assert_eq!(minimum_stablecoin_amount(6), Some(10_000));
        assert_eq!(minimum_stablecoin_amount(18), Some(10_000_000_000_000_000));
    }

    struct Entry {
        to: &'static str,
        value: u128,
        data: Vec<u8>,
    }

    impl Entry {
        fn native(to: &'static str, value: u128) -> Self {
            Self {
                to,
                value,
                data: Vec::new(),
            }
        }

        fn erc20(token: &'static str, recipient: &'static str, amount: u128) -> Self {
            let mut data = vec![0xa9, 0x05, 0x9c, 0xbb];
            data.extend(word_address(recipient));
            data.extend(word_u128(amount));
            Self {
                to: token,
                value: 0,
                data,
            }
        }
    }

    fn encode_safe_multisend(entries: &[Entry]) -> String {
        let mut packed = Vec::new();
        for entry in entries {
            packed.push(0);
            packed.extend(address(entry.to));
            packed.extend(word_u128(entry.value));
            packed.extend(word_u128(entry.data.len() as u128));
            packed.extend(&entry.data);
        }

        let mut multisend = vec![0x8d, 0x80, 0xff, 0x0a];
        multisend.extend(word_u128(32));
        multisend.extend(word_u128(packed.len() as u128));
        multisend.extend(packed);
        pad_to_word(&mut multisend);

        let mut call_data = vec![0x7b, 0xb3, 0x74, 0x28];
        call_data.extend(word_address(TRUSTED_MULTISEND));
        call_data.extend(word_u128(0));
        call_data.extend(word_u128(128));
        call_data.extend(word_u128(1));
        call_data.extend(word_u128(multisend.len() as u128));
        call_data.extend(multisend);
        pad_to_word(&mut call_data[4..]);

        format!("0x{}", encode_hex(&call_data))
    }

    fn address(value: &str) -> Vec<u8> {
        decode_hex(value).unwrap()
    }

    fn word_address(value: &str) -> Vec<u8> {
        let mut word = vec![0; 12];
        word.extend(address(value));
        word
    }

    fn word_u128(value: u128) -> Vec<u8> {
        let mut word = vec![0; 16];
        word.extend(value.to_be_bytes());
        word
    }

    fn pad_to_word(data: &mut [u8]) {
        let _ = data;
    }

    fn decode_hex(value: &str) -> Result<Vec<u8>, ()> {
        super::decode_hex(value)
    }

    fn encode_hex(value: &[u8]) -> String {
        const TABLE: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(value.len() * 2);
        for byte in value {
            output.push(TABLE[(byte >> 4) as usize] as char);
            output.push(TABLE[(byte & 0x0f) as usize] as char);
        }
        output
    }
}
