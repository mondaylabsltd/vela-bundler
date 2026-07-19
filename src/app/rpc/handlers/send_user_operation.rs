use axum::http::HeaderValue;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

use crate::{
    app::rpc::{
        handlers::{in_band_settlement, supported_entry_points},
        types::{RpcError, RpcResponse, SendUserOperationParams, UserOperation, UserOperationV0_7},
    },
    app::{AppState, QueuedUserOperation, StoredUserOperation},
    utils::{rpc, tempo},
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

    let status_store = state
        .user_operation_status_store()
        .ok_or_else(RpcError::user_operation_status_store_unavailable)?;
    let queue = state
        .user_operation_queue()
        .ok_or_else(RpcError::user_operation_queue_unavailable)?;
    let created = status_store
        .create_queued(QueuedUserOperation {
            user_operation_hash: user_operation_hash.clone(),
            chain_id,
            entry_point: entry_point.clone(),
            user_operation: prepared.operation.clone(),
        })
        .await
        .map_err(|error| {
            tracing::warn!(
                chain_id,
                user_operation_hash = %user_operation_hash,
                %error,
                "could not create queued UserOperation status in Redis"
            );
            RpcError::user_operation_status_store_unavailable()
        })?;

    if !created {
        let existing = status_store
            .get(&user_operation_hash)
            .await
            .map_err(|error| {
                tracing::warn!(
                    chain_id,
                    user_operation_hash = %user_operation_hash,
                    %error,
                    "could not read existing UserOperation status from Redis"
                );
                RpcError::user_operation_status_store_unavailable()
            })?;
        let Some(existing) = existing else {
            // The one-hour admission record expired between SET NX and GET. A later request can
            // create it again, but this request no longer owns a record it can safely finalize.
            return Err(RpcError::user_operation_status_store_unavailable());
        };
        match existing_admission_action(&existing, chain_id, &entry_point, &prepared.operation) {
            ExistingAdmissionAction::Conflict => {
                tracing::error!(
                    chain_id,
                    user_operation_hash = %user_operation_hash,
                    existing_chain_id = existing.chain_id,
                    existing_entry_point = %existing.entry_point,
                    submitted_entry_point = %entry_point,
                    "existing Redis admission does not match the submitted UserOperation"
                );
                return Err(RpcError::invalid_params(
                    "this UserOperation hash is already queued with a different signed payload; resubmit the exact original operation or wait for the existing record to reach a durable outcome",
                ));
            }
            ExistingAdmissionAction::AlreadyAdmitted => {
                tracing::info!(
                    chain_id,
                    user_operation_hash = %user_operation_hash,
                    "UserOperation already exists in the durable queue"
                );
                return Ok(user_operation_hash);
            }
            ExistingAdmissionAction::RetryAppend => {}
        }

        // The first producer may have lost Iggy's acknowledgement or crashed before setting the
        // admission marker. Re-appending is the only safe recovery: Iggy and the consumer provide
        // at-least-once delivery, while the Redis hash makes execution idempotent.
        tracing::info!(
            chain_id,
            user_operation_hash = %user_operation_hash,
            "retrying an incomplete UserOperation queue admission"
        );
    }

    let entry = json!({
        "schemaVersion": 1,
        "userOperationHash": user_operation_hash,
        "chainId": chain_id,
        "entryPoint": entry_point,
        "userOperation": prepared.operation,
    });

    if let Err(error) = queue.enqueue(chain_id, &entry).await {
        tracing::warn!(
            chain_id,
            user_operation_hash = %user_operation_hash,
            %error,
            "could not confirm UserOperation append to Iggy; preserving Redis admission for recovery"
        );

        // A timeout or transport error can happen after Iggy durably appended the message but
        // before its acknowledgement reached us. Deleting the Redis half here would create an
        // executable orphan. Keep the unadmitted record for one hour: a matching queue message
        // proves delivery and marks it admitted, while an idempotent client retry may append it
        // again. Duplicate messages are harmless because execution is keyed by userOpHash.
        return Err(RpcError::user_operation_queue_unavailable());
    }

    if !status_store
        .mark_admitted(&user_operation_hash)
        .await
        .map_err(|error| {
            tracing::error!(
                chain_id,
                user_operation_hash = %user_operation_hash,
                %error,
                "Iggy accepted UserOperation but Redis could not finalize admission"
            );
            RpcError::user_operation_status_store_unavailable()
        })?
    {
        return Err(RpcError::user_operation_status_store_unavailable());
    }

    tracing::info!(
        chain_id,
        entry_point = %entry_point,
        sender = %prepared.sender_hex(),
        user_operation_hash = %user_operation_hash,
        settlement = "in_band",
        "UserOperation accepted into Redis and the durable Iggy queue"
    );

    Ok(user_operation_hash)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExistingAdmissionAction {
    AlreadyAdmitted,
    RetryAppend,
    Conflict,
}

fn existing_admission_action(
    existing: &StoredUserOperation,
    chain_id: u64,
    entry_point: &str,
    user_operation: &UserOperation,
) -> ExistingAdmissionAction {
    // The EntryPoint hash is calculated from binary fields, whereas JSON-RPC permits harmless
    // spelling changes such as `0x01` versus `0x1`. Compare the parsed field representation so
    // an idempotent retry is not rejected merely because a wallet normalized hex differently.
    // Signature is included even though ERC-4337 excludes it from userOpHash: it changes account
    // validation and therefore must not silently replace an operation already in the queue.
    let operation_matches = admission_fingerprint(&existing.user_operation)
        .zip(admission_fingerprint(user_operation))
        .is_some_and(|(existing, submitted)| existing == submitted);
    let matches = existing.chain_id == chain_id
        && existing.entry_point.eq_ignore_ascii_case(entry_point)
        && operation_matches;
    match (matches, existing.admitted) {
        (true, true) => ExistingAdmissionAction::AlreadyAdmitted,
        (true, false) => ExistingAdmissionAction::RetryAppend,
        (false, _) => ExistingAdmissionAction::Conflict,
    }
}

#[derive(Eq, PartialEq)]
struct AdmissionFingerprint {
    sender: [u8; 20],
    nonce: [u8; 32],
    init_code: Vec<u8>,
    call_data: Vec<u8>,
    account_gas_limits: [u8; 32],
    pre_verification_gas: [u8; 32],
    gas_fees: [u8; 32],
    paymaster_and_data: Vec<u8>,
    signature: Vec<u8>,
    fee_token: Option<[u8; 20]>,
}

fn admission_fingerprint(operation: &UserOperation) -> Option<AdmissionFingerprint> {
    let UserOperation::V0_7(operation) = operation else {
        return None;
    };
    let prepared = PreparedUserOperation::try_from(UserOperation::V0_7(operation.clone())).ok()?;
    let signature = bytes(&operation.signature, "signature").ok()?;
    let fee_token = operation
        .fee_token
        .as_deref()
        .map(|fee_token| address(fee_token, "feeToken"))
        .transpose()
        .ok()?;
    Some(AdmissionFingerprint {
        sender: prepared.sender,
        nonce: prepared.nonce,
        init_code: prepared.init_code,
        call_data: prepared.call_data,
        account_gas_limits: prepared.account_gas_limits,
        pre_verification_gas: prepared.pre_verification_gas,
        gas_fees: prepared.gas_fees,
        paymaster_and_data: prepared.paymaster_and_data,
        signature,
        fee_token,
    })
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
    if tempo::is_tempo_chain(chain_id) {
        // `parse_reimbursement` normalizes token-map keys to lowercase while Alloy renders this
        // all-numeric address with an EIP-55 uppercase character. Use one canonical form for
        // both the allowlist and lookup so a valid pathUSD payment is not read as zero.
        let path_usd = canonical_tempo_path_usd();
        let fee_token = match user_operation {
            UserOperation::V0_7(operation) => operation.fee_token.as_deref(),
            UserOperation::V0_6(_) => None,
        };
        if fee_token.is_some_and(|token| !token.eq_ignore_ascii_case(&path_usd)) {
            return Err(RpcError::invalid_params(
                "Tempo currently accepts pathUSD as the feeToken",
            ));
        }
        let reimbursement =
            in_band_settlement::parse_reimbursement(call_data, recipient, [path_usd.clone()]);
        let paid = reimbursement
            .stablecoins
            .get(&path_usd)
            .copied()
            .unwrap_or_default();
        let minimum = 10u128.pow(tempo::PATH_USD_DECIMALS - 2);
        return (paid >= minimum).then_some(()).ok_or_else(|| {
            RpcError::user_operation_rejected(
                "Tempo UserOperation must reimburse the settlement recipient with at least 0.01 pathUSD",
            )
        });
    }
    let has_minimum_payment =
        fallback_has_minimum_payment(chain_id, user_rpc_url, call_data, recipient).await?;

    if has_minimum_payment {
        return Ok(());
    }

    Err(RpcError::user_operation_rejected(
        "in-band UserOperation must reimburse the settlement recipient with at least 0.00001 native coin or 0.01 of an allowlisted stablecoin",
    ))
}

fn canonical_tempo_path_usd() -> String {
    tempo::PATH_USD.to_string().to_ascii_lowercase()
}

async fn fallback_has_minimum_payment(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    call_data: &str,
    recipient: &str,
) -> Result<bool, RpcError> {
    let assets = rpc::settlement_assets(chain_id)
        .await
        .map_err(|_| RpcError::estimation_unavailable())?;
    let reimbursement =
        in_band_settlement::parse_reimbursement(call_data, recipient, assets.stablecoins.clone());

    let native_minimum = in_band_settlement::minimum_native_amount(assets.native_decimals)
        .ok_or_else(RpcError::estimation_unavailable)?;
    if reimbursement.native >= native_minimum {
        return Ok(true);
    }

    for (token, amount) in reimbursement.stablecoins {
        let decimals = rpc::erc20_decimals(chain_id, user_rpc_url, &token)
            .await
            .map_err(|_| RpcError::estimation_unavailable())?;
        let minimum = in_band_settlement::minimum_stablecoin_amount(decimals)
            .ok_or_else(RpcError::estimation_unavailable)?;
        if amount >= minimum {
            return Ok(true);
        }
    }

    Ok(false)
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

    use super::{
        ExistingAdmissionAction, PreparedUserOperation, canonical_tempo_path_usd,
        existing_admission_action, quantity,
    };
    use crate::app::{
        StoredUserOperation,
        rpc::types::{UserOperation, UserOperationStatusKind, UserOperationV0_7},
    };

    const ENTRY_POINT: &str = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
    const LOCAL_POLICY_CHAIN: u64 = 9_999_999_991;

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
            fee_token: None,
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

    #[test]
    fn canonicalizes_path_usd_for_reimbursement_lookup() {
        assert_eq!(
            canonical_tempo_path_usd(),
            "0x20c0000000000000000000000000000000000000"
        );
    }

    #[test]
    fn retries_only_an_exact_unadmitted_redis_record() {
        let operation = user_operation();
        let mut stored = stored_admission(operation.clone(), false);

        assert_eq!(
            existing_admission_action(
                &stored,
                LOCAL_POLICY_CHAIN,
                &ENTRY_POINT.to_ascii_lowercase(),
                &operation,
            ),
            ExistingAdmissionAction::RetryAppend
        );

        stored.admitted = true;
        assert_eq!(
            existing_admission_action(&stored, LOCAL_POLICY_CHAIN, ENTRY_POINT, &operation),
            ExistingAdmissionAction::AlreadyAdmitted
        );

        stored.admitted = false;
        assert_eq!(
            existing_admission_action(
                &stored,
                LOCAL_POLICY_CHAIN,
                "0x1111111111111111111111111111111111111111",
                &operation,
            ),
            ExistingAdmissionAction::Conflict
        );

        stored.chain_id += 1;
        assert_eq!(
            existing_admission_action(&stored, LOCAL_POLICY_CHAIN, ENTRY_POINT, &operation),
            ExistingAdmissionAction::Conflict
        );

        stored.chain_id = LOCAL_POLICY_CHAIN;
        let mut different_operation = match operation {
            UserOperation::V0_7(operation) => operation,
            UserOperation::V0_6(_) => unreachable!(),
        };
        different_operation.nonce = "0x1".into();
        assert_eq!(
            existing_admission_action(
                &stored,
                LOCAL_POLICY_CHAIN,
                ENTRY_POINT,
                &UserOperation::V0_7(different_operation),
            ),
            ExistingAdmissionAction::Conflict
        );
    }

    #[test]
    fn retries_a_semantically_identical_user_operation_with_normalized_hex() {
        let operation = user_operation();
        let stored = stored_admission(operation.clone(), true);
        let mut normalized = match operation {
            UserOperation::V0_7(operation) => operation,
            UserOperation::V0_6(_) => unreachable!(),
        };
        normalized.nonce = "0x00".into();
        normalized.call_gas_limit = "0x05208".into();
        normalized.verification_gas_limit = "0x010000".into();
        normalized.pre_verification_gas = "0x01000".into();
        normalized.max_fee_per_gas = "0x000".into();
        normalized.max_priority_fee_per_gas = "0x0000".into();

        assert_eq!(
            existing_admission_action(
                &stored,
                LOCAL_POLICY_CHAIN,
                ENTRY_POINT,
                &UserOperation::V0_7(normalized),
            ),
            ExistingAdmissionAction::AlreadyAdmitted
        );
    }

    fn stored_admission(user_operation: UserOperation, admitted: bool) -> StoredUserOperation {
        StoredUserOperation {
            status: UserOperationStatusKind::Queued,
            transaction_hash: None,
            chain_id: LOCAL_POLICY_CHAIN,
            chain_id_text: LOCAL_POLICY_CHAIN.to_string(),
            entry_point: ENTRY_POINT.into(),
            user_operation,
            admitted,
            next_receipt_check_at_ms: 0,
            block_hash: None,
            block_number: None,
            receipt: None,
            event: None,
            last_executor_stage: None,
            last_executor_error: None,
            last_executor_attempt_at_ms: None,
        }
    }
}
