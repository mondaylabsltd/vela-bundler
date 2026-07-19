use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

use crate::{
    app::rpc::types::{
        GetUserOperationByHashParams, GetUserOperationReceiptParams, GetUserOperationStatusParams,
        RpcError, RpcResponse, UserOperation, UserOperationByHash, UserOperationStatus,
        UserOperationStatusKind,
    },
    app::{AppState, StoredUserOperation, UserOperationEvent},
    utils::rpc,
};

const USER_OPERATION_EVENT_SIGNATURE: &str =
    "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)";
const SUBMITTED_RECEIPT_REFRESH_INTERVAL: Duration = Duration::from_secs(5);

pub async fn get_status(
    id: Value,
    state: &AppState,
    params: GetUserOperationStatusParams,
) -> RpcResponse<Value> {
    let GetUserOperationStatusParams([user_operation_hash]) = params;
    match load_and_refresh(state, &user_operation_hash).await {
        Ok(Some(operation)) => result(id, operation.rpc_status()),
        Ok(None) => result(
            id,
            UserOperationStatus {
                status: UserOperationStatusKind::NotFound,
                transaction_hash: None,
            },
        ),
        Err(error) => RpcResponse::error(id, error),
    }
}

pub async fn get_by_hash(
    id: Value,
    state: &AppState,
    params: GetUserOperationByHashParams,
) -> RpcResponse<Value> {
    let GetUserOperationByHashParams([user_operation_hash]) = params;
    match load_and_refresh(state, &user_operation_hash).await {
        Ok(Some(operation)) => result(
            id,
            UserOperationByHash {
                user_operation: operation.user_operation,
                entry_point: operation.entry_point,
                block_number: operation.block_number,
                block_hash: operation.block_hash,
                transaction_hash: operation.transaction_hash,
            },
        ),
        Ok(None) => RpcResponse::result(id, Value::Null),
        Err(error) => RpcResponse::error(id, error),
    }
}

pub async fn get_receipt(
    id: Value,
    state: &AppState,
    params: GetUserOperationReceiptParams,
) -> RpcResponse<Value> {
    let GetUserOperationReceiptParams([user_operation_hash]) = params;
    match load_and_refresh(state, &user_operation_hash).await {
        Ok(Some(operation)) => RpcResponse::result(
            id,
            receipt_response(&user_operation_hash, &operation).unwrap_or(Value::Null),
        ),
        Ok(None) => RpcResponse::result(id, Value::Null),
        Err(error) => RpcResponse::error(id, error),
    }
}

async fn load_and_refresh(
    state: &AppState,
    user_operation_hash: &str,
) -> Result<Option<StoredUserOperation>, RpcError> {
    let store = state
        .user_operation_status_store()
        .ok_or_else(RpcError::user_operation_status_store_unavailable)?;
    let Some(operation) = store.get(user_operation_hash).await.map_err(|error| {
        tracing::warn!(%error, "could not read UserOperation status from Redis");
        RpcError::user_operation_status_store_unavailable()
    })?
    else {
        return Ok(None);
    };

    if operation.status != UserOperationStatusKind::Submitted {
        return Ok(Some(operation));
    }
    let Some(transaction_hash) = operation.transaction_hash.as_deref() else {
        return Ok(Some(operation));
    };

    let now_ms = unix_timestamp_ms();
    let next_check_at_ms = now_ms.saturating_add(
        SUBMITTED_RECEIPT_REFRESH_INTERVAL
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    );
    let claimed = store
        .claim_submitted_receipt_check(user_operation_hash, now_ms, next_check_at_ms)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "could not claim UserOperation receipt refresh in Redis");
            RpcError::user_operation_status_store_unavailable()
        })?;
    if !claimed {
        return store.get(user_operation_hash).await.map_err(|error| {
            tracing::warn!(%error, "could not reload UserOperation status from Redis");
            RpcError::user_operation_status_store_unavailable()
        });
    }

    // Only submitted operations hit the chain RPC. Queued, rejected, included, and failed
    // states are answered entirely from Redis, preventing status polling from amplifying RPC
    // traffic for operations that are not yet on-chain candidates.
    let receipt = match rpc::call(
        operation.chain_id,
        None,
        "eth_getTransactionReceipt",
        json!([transaction_hash]),
    )
    .await
    {
        Ok(result) => result.value,
        Err(()) => {
            tracing::warn!(
                chain_id = operation.chain_id,
                transaction_hash,
                "could not refresh submitted UserOperation transaction receipt"
            );
            return Ok(Some(operation));
        }
    };
    if receipt.is_null() {
        return Ok(Some(operation));
    }

    let update = if receipt_status_is_failed(&receipt) {
        store
            .mark_bundle_failed(operation.chain_id, transaction_hash, receipt)
            .await
    } else {
        let events = user_operation_events(&receipt);
        store
            .mark_bundle_confirmed(operation.chain_id, transaction_hash, receipt, &events)
            .await
    };
    update.map_err(|error| {
        tracing::warn!(
            chain_id = operation.chain_id,
            transaction_hash,
            %error,
            "could not persist confirmed UserOperation statuses in Redis"
        );
        RpcError::user_operation_status_store_unavailable()
    })?;

    store.get(user_operation_hash).await.map_err(|error| {
        tracing::warn!(%error, "could not reload UserOperation status from Redis");
        RpcError::user_operation_status_store_unavailable()
    })
}

fn result<T: serde::Serialize>(id: Value, value: T) -> RpcResponse<Value> {
    match serde_json::to_value(value) {
        Ok(value) => RpcResponse::result(id, value),
        Err(_) => RpcResponse::error(id, RpcError::backend_unavailable()),
    }
}

fn receipt_response(user_operation_hash: &str, operation: &StoredUserOperation) -> Option<Value> {
    if operation.status != UserOperationStatusKind::Included {
        return None;
    }
    let event = operation.event.as_ref()?;
    let receipt = operation.receipt.as_ref()?;
    let (sender, nonce, paymaster) = match &operation.user_operation {
        UserOperation::V0_7(user_operation) => (
            user_operation.sender.clone(),
            user_operation.nonce.clone(),
            user_operation.paymaster.clone(),
        ),
        UserOperation::V0_6(user_operation) => (
            user_operation.sender.clone(),
            user_operation.nonce.clone(),
            paymaster_from_v06(&user_operation.paymaster_and_data),
        ),
    };

    Some(json!({
        "userOpHash": user_operation_hash,
        "entryPoint": operation.entry_point,
        "sender": sender,
        "nonce": nonce,
        "paymaster": paymaster,
        "actualGasCost": event.actual_gas_cost,
        "actualGasUsed": event.actual_gas_used,
        "success": event.success,
        "reason": "0x",
        "logs": [],
        "receipt": receipt,
    }))
}

fn paymaster_from_v06(paymaster_and_data: &str) -> Option<String> {
    let value = paymaster_and_data.strip_prefix("0x")?;
    (value.len() >= 40).then(|| format!("0x{}", &value[..40]))
}

fn receipt_status_is_failed(receipt: &Value) -> bool {
    matches!(
        receipt.get("status").and_then(Value::as_str),
        Some("0x0") | Some("0x00")
    )
}

fn user_operation_events(receipt: &Value) -> Vec<UserOperationEvent> {
    let signature = format!(
        "0x{}",
        hex::encode(Keccak256::digest(USER_OPERATION_EVENT_SIGNATURE))
    );
    receipt
        .get("logs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|log| parse_user_operation_event(log, &signature))
        .collect()
}

fn parse_user_operation_event(log: &Value, signature: &str) -> Option<UserOperationEvent> {
    let topics = log.get("topics")?.as_array()?;
    let event_signature = topics.first()?.as_str()?;
    if !event_signature.eq_ignore_ascii_case(signature) {
        return None;
    }
    let user_operation_hash = topics.get(1)?.as_str()?.to_ascii_lowercase();
    let data = hex::decode(log.get("data")?.as_str()?.strip_prefix("0x")?).ok()?;
    if data.len() < 32 * 4 {
        return None;
    }
    let success = data[63] == 1;
    Some(UserOperationEvent {
        user_operation_hash,
        success,
        actual_gas_cost: quantity_word(&data[64..96]),
        actual_gas_used: quantity_word(&data[96..128]),
    })
}

fn quantity_word(value: &[u8]) -> String {
    let encoded = hex::encode(value);
    let trimmed = encoded.trim_start_matches('0');
    if trimmed.is_empty() {
        "0x0".into()
    } else {
        format!("0x{trimmed}")
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        USER_OPERATION_EVENT_SIGNATURE, parse_user_operation_event, user_operation_events,
    };
    use sha3::{Digest, Keccak256};

    #[test]
    fn extracts_user_operation_event_outcomes_from_a_transaction_receipt() {
        let signature = format!(
            "0x{}",
            hex::encode(Keccak256::digest(USER_OPERATION_EVENT_SIGNATURE))
        );
        let user_operation_hash = format!("0x{:064x}", 42);
        let mut data = vec![0_u8; 128];
        data[63] = 1;
        data[95] = 5;
        data[127] = 6;
        let receipt = json!({
            "logs": [{
                "topics": [signature.clone(), user_operation_hash.clone()],
                "data": format!("0x{}", hex::encode(data)),
            }]
        });

        let events = user_operation_events(&receipt);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].user_operation_hash, user_operation_hash);
        assert!(events[0].success);
        assert_eq!(events[0].actual_gas_cost, "0x5");
        assert_eq!(events[0].actual_gas_used, "0x6");
        assert!(parse_user_operation_event(&json!({}), &signature).is_none());
    }
}
