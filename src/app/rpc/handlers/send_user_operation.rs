use axum::http::HeaderValue;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

use crate::{
    app::rpc::{
        handlers::{in_band_settlement, supported_entry_points},
        types::{RpcError, RpcResponse, SendUserOperationParams, UserOperation, UserOperationV0_7},
    },
    app::{AppState, state::PendingUserOperationInsert},
    utils::rpc,
};

const ZERO_GAS_FEE: u128 = 0;

pub async fn handle(
    id: Value,
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    state: &AppState,
    params: SendUserOperationParams,
) -> RpcResponse<Value> {
    let SendUserOperationParams(user_operation, entry_point) = params;
    let result = accept(chain_id, user_rpc_url, state, user_operation, entry_point).await;

    match result {
        Ok(user_operation_hash) => RpcResponse::result(id, Value::String(user_operation_hash)),
        Err(error) => RpcResponse::error(id, error),
    }
}

async fn accept(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    state: &AppState,
    user_operation: UserOperation,
    entry_point: String,
) -> Result<String, RpcError> {
    if !supported_entry_points::is_supported(&entry_point) {
        return Err(RpcError::invalid_params("unsupported EntryPoint"));
    }

    let prepared = PreparedUserOperation::try_from(user_operation)?;
    validate_in_band_submission(chain_id, user_rpc_url, state, &prepared.operation).await?;

    let entry_point_address = address(&entry_point, "entryPoint")?;
    let user_operation_hash = prepared.user_operation_hash(entry_point_address, chain_id);
    let entry = json!({
        "chainId": chain_id,
        "entryPoint": entry_point,
        "userOperation": prepared.operation,
    });

    match state
        .pending_user_operations()
        .insert(user_operation_hash.clone(), entry)
    {
        Ok(PendingUserOperationInsert::Inserted) => tracing::info!(
            chain_id,
            entry_point = %entry_point,
            sender = %prepared.sender_hex(),
            user_operation_hash = %user_operation_hash,
            settlement = "in_band",
            "UserOperation accepted into the local mempool"
        ),
        Ok(PendingUserOperationInsert::AlreadyPresent) => tracing::info!(
            chain_id,
            user_operation_hash = %user_operation_hash,
            "UserOperation already exists in the local mempool"
        ),
        Err(()) => return Err(RpcError::mempool_full()),
    }

    Ok(user_operation_hash)
}

async fn validate_in_band_submission(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    state: &AppState,
    user_operation: &UserOperation,
) -> Result<(), RpcError> {
    let (call_data, max_fee_per_gas, max_priority_fee_per_gas) = match user_operation {
        UserOperation::V0_7(operation) => (
            operation.call_data.as_str(),
            operation.max_fee_per_gas.as_str(),
            operation.max_priority_fee_per_gas.as_str(),
        ),
        UserOperation::V0_6(_) => {
            return Err(RpcError::invalid_params(
                "the configured EntryPoint requires an unpacked v0.7 UserOperation",
            ));
        }
    };

    if quantity(max_fee_per_gas, "maxFeePerGas")? != ZERO_GAS_FEE
        || quantity(max_priority_fee_per_gas, "maxPriorityFeePerGas")? != ZERO_GAS_FEE
    {
        return Err(RpcError::invalid_params(
            "in-band UserOperations must set maxFeePerGas and maxPriorityFeePerGas to 0x0",
        ));
    }

    let recipient = state
        .settlement_recipient()
        .ok_or_else(RpcError::backend_unavailable)?;
    let assets = rpc::settlement_assets(chain_id)
        .await
        .map_err(|_| RpcError::estimation_unavailable())?;
    let reimbursement =
        in_band_settlement::parse_reimbursement(call_data, recipient, assets.stablecoins.clone());

    let native_minimum = in_band_settlement::minimum_native_amount(assets.native_decimals)
        .ok_or_else(RpcError::estimation_unavailable)?;
    if reimbursement.native >= native_minimum {
        return Ok(());
    }

    for (token, amount) in reimbursement.stablecoins {
        let decimals = rpc::erc20_decimals(chain_id, user_rpc_url, &token)
            .await
            .map_err(|_| RpcError::estimation_unavailable())?;
        let minimum = in_band_settlement::minimum_stablecoin_amount(decimals)
            .ok_or_else(RpcError::estimation_unavailable)?;
        if amount >= minimum {
            return Ok(());
        }
    }

    Err(RpcError::user_operation_rejected(
        "in-band UserOperation must reimburse the settlement recipient with at least 0.00001 native coin or 0.01 of an allowlisted stablecoin",
    ))
}

#[derive(Debug)]
struct PreparedUserOperation {
    operation: UserOperation,
    sender: [u8; 20],
    nonce: [u8; 32],
    init_code: Vec<u8>,
    call_data: Vec<u8>,
    account_gas_limits: [u8; 32],
    pre_verification_gas: [u8; 32],
    gas_fees: [u8; 32],
    paymaster_and_data: Vec<u8>,
}

impl TryFrom<UserOperation> for PreparedUserOperation {
    type Error = RpcError;

    fn try_from(operation: UserOperation) -> Result<Self, Self::Error> {
        let UserOperation::V0_7(operation) = operation else {
            return Err(RpcError::invalid_params(
                "the configured EntryPoint requires an unpacked v0.7 UserOperation",
            ));
        };

        Self::from_v0_7(operation)
    }
}

impl PreparedUserOperation {
    fn from_v0_7(operation: Box<UserOperationV0_7>) -> Result<Self, RpcError> {
        if operation.eip7702_auth.is_some() {
            return Err(RpcError::invalid_params(
                "eip7702Auth is not enabled for in-band UserOperations",
            ));
        }

        let sender = address(&operation.sender, "sender")?;
        let nonce = uint256(&operation.nonce, "nonce")?;
        let call_data = bytes(&operation.call_data, "callData")?;
        let signature = bytes(&operation.signature, "signature")?;
        if signature.is_empty() {
            return Err(RpcError::invalid_params("signature is required"));
        }

        let init_code = match (
            operation.factory.as_deref(),
            operation.factory_data.as_deref(),
        ) {
            (Some(factory), factory_data) => {
                let mut init_code = address(factory, "factory")?.to_vec();
                init_code.extend(bytes(factory_data.unwrap_or("0x"), "factoryData")?);
                init_code
            }
            (None, Some(factory_data)) if factory_data != "0x" => {
                return Err(RpcError::invalid_params("factoryData requires factory"));
            }
            (None, _) => Vec::new(),
        };

        let call_gas_limit = nonzero_uint128(&operation.call_gas_limit, "callGasLimit")?;
        let verification_gas_limit =
            nonzero_uint128(&operation.verification_gas_limit, "verificationGasLimit")?;
        let pre_verification_gas =
            nonzero_uint256(&operation.pre_verification_gas, "preVerificationGas")?;
        let max_fee_per_gas = quantity(&operation.max_fee_per_gas, "maxFeePerGas")?;
        let max_priority_fee_per_gas =
            quantity(&operation.max_priority_fee_per_gas, "maxPriorityFeePerGas")?;
        if max_fee_per_gas != ZERO_GAS_FEE || max_priority_fee_per_gas != ZERO_GAS_FEE {
            return Err(RpcError::invalid_params(
                "in-band UserOperations must set maxFeePerGas and maxPriorityFeePerGas to 0x0",
            ));
        }

        let paymaster_and_data = paymaster_and_data(&operation)?;
        let account_gas_limits = packed_uint128(verification_gas_limit, call_gas_limit);
        let gas_fees = packed_uint128(max_priority_fee_per_gas, max_fee_per_gas);

        Ok(Self {
            operation: UserOperation::V0_7(operation),
            sender,
            nonce,
            init_code,
            call_data,
            account_gas_limits,
            pre_verification_gas,
            gas_fees,
            paymaster_and_data,
        })
    }

    fn user_operation_hash(&self, entry_point: [u8; 20], chain_id: u64) -> String {
        let mut packed = Vec::with_capacity(8 * 32);
        packed.extend(address_word(self.sender));
        packed.extend(self.nonce);
        packed.extend(keccak256(&self.init_code));
        packed.extend(keccak256(&self.call_data));
        packed.extend(self.account_gas_limits);
        packed.extend(self.pre_verification_gas);
        packed.extend(self.gas_fees);
        packed.extend(keccak256(&self.paymaster_and_data));

        let mut envelope = Vec::with_capacity(3 * 32);
        envelope.extend(keccak256(&packed));
        envelope.extend(address_word(entry_point));
        envelope.extend(uint256_from_u64(chain_id));
        format!("0x{}", hex::encode(keccak256(&envelope)))
    }

    fn sender_hex(&self) -> String {
        format!("0x{}", hex::encode(self.sender))
    }
}

fn paymaster_and_data(operation: &UserOperationV0_7) -> Result<Vec<u8>, RpcError> {
    let Some(paymaster) = operation.paymaster.as_deref() else {
        if operation.paymaster_verification_gas_limit.is_some()
            || operation.paymaster_post_op_gas_limit.is_some()
            || operation
                .paymaster_data
                .as_deref()
                .is_some_and(|data| data != "0x")
        {
            return Err(RpcError::invalid_params(
                "paymaster fields require paymaster",
            ));
        }
        return Ok(Vec::new());
    };

    let verification_gas_limit = operation
        .paymaster_verification_gas_limit
        .as_deref()
        .ok_or_else(|| {
            RpcError::invalid_params(
                "paymasterVerificationGasLimit is required when paymaster is set",
            )
        })?;
    let verification_gas_limit = quantity(verification_gas_limit, "paymasterVerificationGasLimit")?;
    let post_op_gas_limit = operation
        .paymaster_post_op_gas_limit
        .as_deref()
        .map(|value| quantity(value, "paymasterPostOpGasLimit"))
        .transpose()?
        .unwrap_or_default();

    let mut value = address(paymaster, "paymaster")?.to_vec();
    value.extend(verification_gas_limit.to_be_bytes());
    value.extend(post_op_gas_limit.to_be_bytes());
    value.extend(bytes(
        operation.paymaster_data.as_deref().unwrap_or("0x"),
        "paymasterData",
    )?);
    Ok(value)
}

fn address(value: &str, field: &str) -> Result<[u8; 20], RpcError> {
    in_band_settlement::parse_address(value)
        .map_err(|_| RpcError::invalid_params(format!("{field} must be a 20-byte address")))
}

fn bytes(value: &str, field: &str) -> Result<Vec<u8>, RpcError> {
    in_band_settlement::decode_hex(value)
        .map_err(|_| RpcError::invalid_params(format!("{field} must be 0x-prefixed hex data")))
}

fn quantity(value: &str, field: &str) -> Result<u128, RpcError> {
    let value = value.strip_prefix("0x").ok_or_else(|| {
        RpcError::invalid_params(format!("{field} must be a 0x-prefixed quantity"))
    })?;
    if value.is_empty() || value.len() > 32 {
        return Err(RpcError::invalid_params(format!("invalid {field}")));
    }
    u128::from_str_radix(value, 16)
        .map_err(|_| RpcError::invalid_params(format!("invalid {field}")))
}

fn nonzero_uint128(value: &str, field: &str) -> Result<u128, RpcError> {
    let value = quantity(value, field)?;
    (value != 0)
        .then_some(value)
        .ok_or_else(|| RpcError::invalid_params(format!("{field} must be greater than zero")))
}

fn uint256(value: &str, field: &str) -> Result<[u8; 32], RpcError> {
    let value = value.strip_prefix("0x").ok_or_else(|| {
        RpcError::invalid_params(format!("{field} must be a 0x-prefixed quantity"))
    })?;
    if value.is_empty() || value.len() > 64 {
        return Err(RpcError::invalid_params(format!("invalid {field}")));
    }

    let padded = if value.len() % 2 == 0 {
        value.to_owned()
    } else {
        format!("0{value}")
    };
    let bytes = in_band_settlement::decode_hex(&format!("0x{padded}"))
        .map_err(|_| RpcError::invalid_params(format!("invalid {field}")))?;
    let mut word = [0; 32];
    word[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(word)
}

fn nonzero_uint256(value: &str, field: &str) -> Result<[u8; 32], RpcError> {
    let value = uint256(value, field)?;
    value
        .iter()
        .any(|byte| *byte != 0)
        .then_some(value)
        .ok_or_else(|| RpcError::invalid_params(format!("{field} must be greater than zero")))
}

fn packed_uint128(high: u128, low: u128) -> [u8; 32] {
    let mut value = [0; 32];
    value[..16].copy_from_slice(&high.to_be_bytes());
    value[16..].copy_from_slice(&low.to_be_bytes());
    value
}

fn address_word(value: [u8; 20]) -> [u8; 32] {
    let mut word = [0; 32];
    word[12..].copy_from_slice(&value);
    word
}

fn uint256_from_u64(value: u64) -> [u8; 32] {
    let mut word = [0; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn keccak256(value: &[u8]) -> [u8; 32] {
    Keccak256::digest(value).into()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{PreparedUserOperation, quantity};
    use crate::app::rpc::types::{UserOperation, UserOperationV0_7};

    fn user_operation() -> UserOperation {
        UserOperation::V0_7(Box::new(UserOperationV0_7 {
            sender: "0x1111111111111111111111111111111111111111".into(),
            nonce: "0x0".into(),
            factory: None,
            factory_data: None,
            call_data: "0x1234".into(),
            call_gas_limit: "0x5208".into(),
            verification_gas_limit: "0x10000".into(),
            pre_verification_gas: "0x1000".into(),
            max_fee_per_gas: "0x0".into(),
            max_priority_fee_per_gas: "0x0".into(),
            paymaster: None,
            paymaster_verification_gas_limit: None,
            paymaster_post_op_gas_limit: None,
            paymaster_data: None,
            signature: "0x1234".into(),
            eip7702_auth: None,
        }))
    }

    #[test]
    fn calculates_the_entry_point_v07_user_operation_hash() {
        let prepared = PreparedUserOperation::try_from(user_operation()).unwrap();
        let entry_point =
            super::address("0x0000000071727De22E5E9d8BAf0edAc6f37da032", "entryPoint").unwrap();

        assert_eq!(
            prepared.user_operation_hash(entry_point, 1),
            "0xdd4a4e34a55b5ea9cd7bfbbe15c570fe6fd8893c2c809e72ac2077de91e1e257"
        );
    }

    #[test]
    fn rejects_native_prefund_fee_fields() {
        let mut operation = match user_operation() {
            UserOperation::V0_7(operation) => operation,
            UserOperation::V0_6(_) => unreachable!(),
        };
        operation.max_fee_per_gas = "0x1".into();

        let error = PreparedUserOperation::try_from(UserOperation::V0_7(operation)).unwrap_err();
        assert_eq!(error.code, -32602);
        assert_eq!(error.message, "invalid params");
        assert_eq!(
            error.data,
            Some(json!(
                "in-band UserOperations must set maxFeePerGas and maxPriorityFeePerGas to 0x0"
            ))
        );
    }

    #[test]
    fn validates_gas_quantities_and_zero_fee_forms() {
        assert_eq!(quantity("0x000", "maxFeePerGas").unwrap(), 0);
        assert!(quantity("0x", "maxFeePerGas").is_err());
    }
}
