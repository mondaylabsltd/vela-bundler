use std::{collections::HashSet, str::FromStr};

use alloy::primitives::{Address, B256, U256, keccak256};
use serde_json::Value;

use crate::app::UserOperationEvent;

pub(super) fn receipt_succeeded(receipt: &Value) -> Option<bool> {
    let status = receipt.get("status")?.as_str()?;
    let status = parse_u256(status)?;
    if status > U256::from(1) {
        return None;
    }
    Some(status == U256::from(1))
}

/// Parses only EntryPoint logs that belong to the persisted bundle. A malicious contract can emit
/// a byte-identical event signature, so checking both emitter and membership is mandatory.
pub(super) fn user_operation_events(
    receipt: &Value,
    entry_point: Address,
    membership: &[String],
) -> Vec<UserOperationEvent> {
    let membership = membership
        .iter()
        .filter_map(|hash| B256::from_str(hash).ok())
        .collect::<HashSet<_>>();
    let signature =
        keccak256(b"UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    receipt
        .get("logs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|log| {
            let address = Address::from_str(log.get("address")?.as_str()?).ok()?;
            if address != entry_point {
                return None;
            }
            let topics = log.get("topics")?.as_array()?;
            if B256::from_str(topics.first()?.as_str()?).ok()? != signature {
                return None;
            }
            let hash = B256::from_str(topics.get(1)?.as_str()?).ok()?;
            if !membership.contains(&hash) {
                return None;
            }
            let data = parse_bytes(log.get("data")?.as_str()?)?;
            let success = parse_word(&data, 1)?;
            if success > U256::from(1) {
                return None;
            }
            Some(UserOperationEvent {
                user_operation_hash: hash.to_string(),
                success: success == U256::from(1),
                actual_gas_cost: quantity(parse_word(&data, 2)?),
                actual_gas_used: quantity(parse_word(&data, 3)?),
            })
        })
        .collect()
}

fn quantity(value: U256) -> String {
    format!("0x{value:x}")
}

fn parse_word(data: &[u8], index: usize) -> Option<U256> {
    let start = index.checked_mul(32)?;
    let word: [u8; 32] = data.get(start..start + 32)?.try_into().ok()?;
    Some(U256::from_be_bytes(word))
}

fn parse_u256(value: &str) -> Option<U256> {
    U256::from_str_radix(value.strip_prefix("0x")?, 16).ok()
}

fn parse_bytes(value: &str) -> Option<Vec<u8>> {
    let value = value.strip_prefix("0x")?;
    if !value.len().is_multiple_of(2) {
        return None;
    }
    hex::decode(value).ok()
}

#[cfg(test)]
mod tests {
    use alloy::primitives::{address, b256, keccak256};
    use serde_json::json;

    use super::user_operation_events;

    #[test]
    fn filters_event_emitter_and_persisted_membership() {
        let entry_point = address!("1111111111111111111111111111111111111111");
        let included = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let outsider = b256!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let signature =
            keccak256(b"UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
        let data = format!("0x{:064x}{:064x}{:064x}{:064x}", 0, 1, 20, 10);
        let receipt = json!({
            "logs": [
                {"address": entry_point, "topics": [signature, included], "data": data},
                {"address": "0x2222222222222222222222222222222222222222", "topics": [signature, included], "data": data},
                {"address": entry_point, "topics": [signature, outsider], "data": data}
            ]
        });

        let events = user_operation_events(&receipt, entry_point, &[included.to_string()]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user_operation_hash, included.to_string());
    }
}
