use axum::http::HeaderValue;
use serde_json::{Map, Value, json};

use crate::{
    app::rpc::{
        handlers::{in_band_settlement, supported_entry_points},
        types::{
            EstimatableUserOperation, EstimatableUserOperationV0_7, EstimateUserOperationGasParams,
            RpcError, RpcResponse, StateOverrideSet, UserOperationGasEstimate,
        },
    },
    utils::rpc::{self, RpcRevert, RpcSimulationError},
};

const SIMULATE_VALIDATION_SELECTOR: [u8; 4] = [0xc3, 0xbc, 0xe0, 0x09];
const SIMULATION_VERIFICATION_GAS_LIMIT: u128 = 500_000;
const TEMPO_SIMULATION_VERIFICATION_GAS_LIMIT: u128 = 8_000_000;
const SIMULATION_CALL_GAS_LIMIT: u128 = 1_000_000;
const DEFAULT_CALL_GAS_LIMIT: u128 = 200_000;
const MIN_CALL_GAS_LIMIT: u128 = 50_000;
const MIN_VERIFICATION_GAS_LIMIT: u128 = 100_000;
const MIN_PAYMASTER_GAS_LIMIT: u128 = 100_000;
const SIMULATION_SENDER_BALANCE: &str = "0x56bc75e2d63100000";

const ENTRY_POINT_SIMULATIONS_BYTECODE: &str =
    include_str!("entry_point_simulations_v07_bytecode.txt");

pub async fn handle(
    id: Value,
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    params: EstimateUserOperationGasParams,
) -> (RpcResponse<Value>, Option<String>) {
    let EstimateUserOperationGasParams(user_operation, entry_point, state_overrides) = params;
    let result = estimate(
        chain_id,
        user_rpc_url,
        user_operation,
        entry_point,
        state_overrides,
    )
    .await;

    match result {
        Ok((estimate, rpc_domain)) => (
            RpcResponse::result(
                id,
                serde_json::to_value(estimate).expect("gas estimate response must serialize"),
            ),
            Some(rpc_domain),
        ),
        Err(error) => (RpcResponse::error(id, error), None),
    }
}

async fn estimate(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    user_operation: EstimatableUserOperation,
    entry_point: String,
    state_overrides: Option<StateOverrideSet>,
) -> Result<(UserOperationGasEstimate, String), RpcError> {
    // Estimation simulates the UserOperation only. In-band reimbursement admission checks belong
    // exclusively to eth_sendUserOperation, after the caller has accepted the quoted gas.
    if !supported_entry_points::is_supported(&entry_point) {
        return Err(RpcError::invalid_params("unsupported EntryPoint"));
    }

    let operation = SimulationUserOperation::try_from((chain_id, user_operation))?;
    let simulation_call_data = operation.simulate_validation_calldata()?;
    let simulation_overrides =
        state_overrides_for_simulation(state_overrides.as_ref(), &operation.sender, &entry_point);
    let validation = rpc::call_simulation(
        chain_id,
        user_rpc_url,
        "eth_call",
        json!([
            { "to": entry_point, "data": bytes_to_hex(&simulation_call_data) },
            "latest",
            simulation_overrides,
        ]),
    )
    .await
    .map_err(simulation_error)?;
    let pre_op_gas = parse_validation_pre_op_gas(&validation.value)?;

    let call_gas_limit = estimate_call_gas_limit(
        chain_id,
        user_rpc_url,
        &operation,
        &entry_point,
        state_overrides.as_ref(),
    )
    .await?;
    let verification_gas_limit =
        with_percent_buffer(pre_op_gas, 150).max(MIN_VERIFICATION_GAS_LIMIT);
    let (paymaster_verification_gas_limit, paymaster_post_op_gas_limit) = if operation.has_paymaster
    {
        (
            (verification_gas_limit / 2).max(MIN_PAYMASTER_GAS_LIMIT),
            MIN_PAYMASTER_GAS_LIMIT,
        )
    } else {
        (0, 0)
    };

    let pre_verification_gas = operation.pre_verification_gas(&simulation_call_data);
    Ok((
        UserOperationGasEstimate {
            pre_verification_gas: quantity(pre_verification_gas),
            verification_gas_limit: quantity(verification_gas_limit),
            call_gas_limit: quantity(call_gas_limit),
            paymaster_verification_gas_limit: quantity(paymaster_verification_gas_limit),
            paymaster_post_op_gas_limit: quantity(paymaster_post_op_gas_limit),
        },
        validation.domain,
    ))
}

async fn estimate_call_gas_limit(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    operation: &SimulationUserOperation,
    entry_point: &str,
    state_overrides: Option<&StateOverrideSet>,
) -> Result<u128, RpcError> {
    if operation.call_data.is_empty() {
        return Ok(0);
    }

    let execution_overrides = state_overrides_for_execution(state_overrides, &operation.sender);
    let request = json!([
        {
            "from": entry_point,
            "to": format_address(operation.sender),
            "data": bytes_to_hex(&operation.call_data),
        },
        "latest",
        execution_overrides,
    ]);

    match rpc::call_simulation(chain_id, user_rpc_url, "eth_estimateGas", request).await {
        Ok(result) => parse_quantity(
            result
                .value
                .as_str()
                .ok_or_else(RpcError::estimation_unavailable)?,
            "eth_estimateGas result",
        )
        .map(|gas| with_percent_buffer(gas, 150).max(MIN_CALL_GAS_LIMIT)),
        Err(RpcSimulationError::Reverted(error)) => Err(simulation_revert_error(error)),
        Err(RpcSimulationError::Unavailable) => {
            let fallback = operation.call_gas_limit.unwrap_or(DEFAULT_CALL_GAS_LIMIT);
            tracing::warn!(
                chain_id,
                fallback_call_gas_limit = fallback,
                "could not estimate UserOperation call gas; returning the conservative fallback"
            );
            Ok(fallback.max(MIN_CALL_GAS_LIMIT))
        }
    }
}

fn state_overrides_for_simulation(
    user_overrides: Option<&StateOverrideSet>,
    sender: &[u8; 20],
    entry_point: &str,
) -> Value {
    let mut overrides = serialized_overrides(user_overrides);
    let object = overrides
        .as_object_mut()
        .expect("state overrides must serialize as an object");

    let mut sender_override = take_address_override(object, sender);
    sender_override.insert(
        "balance".into(),
        Value::String(SIMULATION_SENDER_BALANCE.into()),
    );
    object.insert(format_address(*sender), Value::Object(sender_override));

    let entry_point = entry_point.to_ascii_lowercase();
    let mut entry_point_override = take_string_address_override(object, &entry_point);
    entry_point_override.insert(
        "code".into(),
        Value::String(ENTRY_POINT_SIMULATIONS_BYTECODE.trim().into()),
    );
    object.insert(entry_point, Value::Object(entry_point_override));
    overrides
}

fn state_overrides_for_execution(
    user_overrides: Option<&StateOverrideSet>,
    sender: &[u8; 20],
) -> Value {
    let mut overrides = serialized_overrides(user_overrides);
    let object = overrides
        .as_object_mut()
        .expect("state overrides must serialize as an object");
    let mut sender_override = take_address_override(object, sender);
    sender_override.insert(
        "balance".into(),
        Value::String(SIMULATION_SENDER_BALANCE.into()),
    );
    object.insert(format_address(*sender), Value::Object(sender_override));
    overrides
}

fn serialized_overrides(overrides: Option<&StateOverrideSet>) -> Value {
    overrides
        .map(|overrides| serde_json::to_value(overrides).expect("state overrides must serialize"))
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn take_address_override(
    object: &mut Map<String, Value>,
    address: &[u8; 20],
) -> Map<String, Value> {
    take_string_address_override(object, &format_address(*address))
}

fn take_string_address_override(
    object: &mut Map<String, Value>,
    address: &str,
) -> Map<String, Value> {
    let key = object
        .keys()
        .find(|key| key.eq_ignore_ascii_case(address))
        .cloned();
    key.and_then(|key| object.remove(&key))
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn parse_validation_pre_op_gas(value: &Value) -> Result<u128, RpcError> {
    let encoded = value
        .as_str()
        .ok_or_else(RpcError::estimation_unavailable)?;
    let encoded =
        in_band_settlement::decode_hex(encoded).map_err(|_| RpcError::estimation_unavailable())?;
    let return_info_offset =
        read_usize_word(&encoded, 0).ok_or_else(RpcError::estimation_unavailable)?;
    read_u128_word(&encoded, return_info_offset).ok_or_else(RpcError::estimation_unavailable)
}

fn simulation_error(error: RpcSimulationError) -> RpcError {
    match error {
        RpcSimulationError::Reverted(error) => simulation_revert_error(error),
        RpcSimulationError::Unavailable => RpcError::estimation_unavailable(),
    }
}

fn simulation_revert_error(error: RpcRevert) -> RpcError {
    let reason = revert_reason(&error).unwrap_or_else(|| {
        let code = error
            .code
            .map(|code| format!(" (RPC code {code})"))
            .unwrap_or_default();
        format!("UserOperation validation reverted{code}: {}", error.message)
    });
    RpcError::user_operation_rejected(reason)
}

/// Extract revert bytes from the error shapes used by common EVM RPC providers.
///
/// Geth usually places them in `error.data`, while gateway providers commonly nest them or
/// append them to `error.message`. The data is contract output, not a URL or credential.
fn revert_reason(error: &RpcRevert) -> Option<String> {
    let data = error
        .data
        .as_ref()
        .and_then(|data| find_revert_data(data, 0))
        .or_else(|| find_revert_data_in_message(&error.message))?;
    let bytes = in_band_settlement::decode_hex(&data).ok()?;

    decode_revert_bytes(&bytes).or_else(|| {
        let selector = bytes
            .get(..4)
            .map(bytes_to_hex)
            .unwrap_or_else(|| "0x".into());
        Some(format!(
            "Unknown EVM custom error {selector} ({} bytes of revert data)",
            bytes.len()
        ))
    })
}

fn find_revert_data(value: &Value, depth: usize) -> Option<String> {
    if depth > 4 {
        return None;
    }

    match value {
        Value::String(value) => valid_revert_data(value),
        Value::Array(values) => values
            .iter()
            .find_map(|value| find_revert_data(value, depth + 1)),
        Value::Object(values) => ["data", "revertData", "originalError", "error"]
            .into_iter()
            .filter_map(|key| values.get(key))
            .find_map(|value| find_revert_data(value, depth + 1)),
        _ => None,
    }
}

fn find_revert_data_in_message(message: &str) -> Option<String> {
    message
        .match_indices("0x")
        .filter_map(|(index, _)| {
            let hex = message[index + 2..]
                .bytes()
                .take_while(u8::is_ascii_hexdigit)
                .count();
            valid_revert_data(&message[index..index + 2 + hex])
        })
        .max_by_key(|data| data.len())
}

fn valid_revert_data(value: &str) -> Option<String> {
    let value = value.strip_prefix("0x")?;
    (value.len() >= 8
        && value.len().is_multiple_of(2)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then(|| format!("0x{value}"))
}

fn decode_revert_bytes(bytes: &[u8]) -> Option<String> {
    const ERROR_STRING_SELECTOR: [u8; 4] = [0x08, 0xc3, 0x79, 0xa0];
    const PANIC_SELECTOR: [u8; 4] = [0x4e, 0x48, 0x7b, 0x71];
    const FAILED_OP_SELECTOR: [u8; 4] = [0x22, 0x02, 0x66, 0xb6];
    const FAILED_OP_WITH_REVERT_SELECTOR: [u8; 4] = [0x65, 0xc8, 0xfd, 0x4d];
    const CALL_PHASE_REVERTED_SELECTOR: [u8; 4] = [0x46, 0x2c, 0x71, 0xb2];
    const SAFE_EXECUTION_FAILED_SELECTOR: [u8; 4] = [0xac, 0xfd, 0xb4, 0x44];

    let selector = bytes.get(..4)?;
    if selector == ERROR_STRING_SELECTOR {
        return abi_string(bytes, 4, 4);
    }
    if selector == PANIC_SELECTOR {
        return read_u128_word(bytes, 4).map(panic_reason);
    }
    if selector == FAILED_OP_SELECTOR {
        let operation_index = read_u128_word(bytes, 4)?;
        let reason = abi_string(bytes, 4, 36)?;
        return Some(format!("FailedOp({operation_index}): {reason}"));
    }
    if selector == FAILED_OP_WITH_REVERT_SELECTOR {
        let operation_index = read_u128_word(bytes, 4)?;
        let reason = abi_string(bytes, 4, 36)?;
        let inner = abi_bytes(bytes, 4, 68)
            .and_then(decode_revert_bytes)
            .unwrap_or_else(|| "inner call reverted".into());
        return Some(format!(
            "FailedOpWithRevert({operation_index}): {reason}; {inner}"
        ));
    }
    if selector == CALL_PHASE_REVERTED_SELECTOR {
        return abi_bytes(bytes, 4, 4)
            .and_then(decode_revert_bytes)
            .map(|reason| format!("CallPhaseReverted: {reason}"));
    }
    if selector == SAFE_EXECUTION_FAILED_SELECTOR {
        return Some("Safe execution failed: the target call in executeUserOp reverted".into());
    }

    None
}

fn abi_string(bytes: &[u8], arguments_start: usize, offset_position: usize) -> Option<String> {
    String::from_utf8(abi_bytes(bytes, arguments_start, offset_position)?.to_vec()).ok()
}

fn abi_bytes(bytes: &[u8], arguments_start: usize, offset_position: usize) -> Option<&[u8]> {
    let offset = read_usize_word(bytes, offset_position)?;
    let start = arguments_start.checked_add(offset)?;
    let length = read_usize_word(bytes, start)?;
    bytes.get(start.checked_add(32)?..start.checked_add(32)?.checked_add(length)?)
}

fn panic_reason(code: u128) -> String {
    let description = match code {
        0x01 => "assertion failed",
        0x11 => "arithmetic overflow or underflow",
        0x12 => "division or modulo by zero",
        0x21 => "invalid enum conversion",
        0x22 => "invalid storage byte array",
        0x31 => "empty array pop",
        0x32 => "array index out of bounds",
        0x41 => "memory allocation overflow",
        0x51 => "invalid internal function",
        _ => return format!("Solidity panic 0x{code:x}"),
    };
    format!("Solidity panic 0x{code:x}: {description}")
}

#[derive(Debug)]
struct SimulationUserOperation {
    sender: [u8; 20],
    nonce: [u8; 32],
    init_code: Vec<u8>,
    call_data: Vec<u8>,
    call_gas_limit: Option<u128>,
    verification_gas_limit: u128,
    has_paymaster: bool,
    paymaster_and_data: Vec<u8>,
    signature: Vec<u8>,
    has_eip7702_auth: bool,
}

impl TryFrom<(u64, EstimatableUserOperation)> for SimulationUserOperation {
    type Error = RpcError;

    fn try_from(value: (u64, EstimatableUserOperation)) -> Result<Self, Self::Error> {
        let (chain_id, operation) = value;
        match operation {
            EstimatableUserOperation::V0_7(operation) => Self::from_v0_7(chain_id, operation),
            EstimatableUserOperation::V0_6(_) => Err(RpcError::invalid_params(
                "the configured EntryPoint requires an unpacked v0.7 UserOperation",
            )),
        }
    }
}

impl SimulationUserOperation {
    fn from_v0_7(
        chain_id: u64,
        operation: Box<EstimatableUserOperationV0_7>,
    ) -> Result<Self, RpcError> {
        let sender = address(&operation.sender, "sender")?;
        let nonce = quantity_word(&operation.nonce, "nonce")?;
        let call_data = bytes(&operation.call_data, "callData")?;
        let signature = bytes(
            operation
                .signature
                .as_deref()
                .ok_or_else(|| RpcError::invalid_params("signature is required for estimation"))?,
            "signature",
        )?;

        let init_code = match (operation.factory, operation.factory_data) {
            (Some(factory), factory_data) => {
                let mut init_code = address(&factory, "factory")?.to_vec();
                init_code.extend(bytes(
                    factory_data.as_deref().unwrap_or("0x"),
                    "factoryData",
                )?);
                init_code
            }
            (None, Some(factory_data)) if factory_data != "0x" => {
                return Err(RpcError::invalid_params("factoryData requires factory"));
            }
            (None, _) => Vec::new(),
        };

        let call_gas_limit =
            optional_quantity(operation.call_gas_limit.as_deref(), "callGasLimit")?;
        let default_verification_gas = if in_band_settlement::is_tempo_chain(chain_id) {
            TEMPO_SIMULATION_VERIFICATION_GAS_LIMIT
        } else {
            SIMULATION_VERIFICATION_GAS_LIMIT
        };
        let verification_gas_limit = optional_quantity(
            operation.verification_gas_limit.as_deref(),
            "verificationGasLimit",
        )?
        .filter(|gas| *gas > 0)
        .unwrap_or(default_verification_gas);
        let max_fee_per_gas =
            optional_quantity(operation.max_fee_per_gas.as_deref(), "maxFeePerGas")?.unwrap_or(0);
        let max_priority_fee_per_gas = optional_quantity(
            operation.max_priority_fee_per_gas.as_deref(),
            "maxPriorityFeePerGas",
        )?
        .unwrap_or(0);
        if max_fee_per_gas != 0 || max_priority_fee_per_gas != 0 {
            return Err(RpcError::invalid_params(
                "maxFeePerGas and maxPriorityFeePerGas must both be 0x0",
            ));
        }

        let (has_paymaster, paymaster_and_data) = match operation.paymaster {
            Some(paymaster) => {
                let mut value = address(&paymaster, "paymaster")?.to_vec();
                value.extend(uint128_word(
                    optional_quantity(
                        operation.paymaster_verification_gas_limit.as_deref(),
                        "paymasterVerificationGasLimit",
                    )?
                    .unwrap_or(0),
                ));
                value.extend(uint128_word(
                    optional_quantity(
                        operation.paymaster_post_op_gas_limit.as_deref(),
                        "paymasterPostOpGasLimit",
                    )?
                    .unwrap_or(0),
                ));
                value.extend(bytes(
                    operation.paymaster_data.as_deref().unwrap_or("0x"),
                    "paymasterData",
                )?);
                (true, value)
            }
            None => (false, Vec::new()),
        };

        Ok(Self {
            sender,
            nonce,
            init_code,
            call_data,
            call_gas_limit,
            verification_gas_limit,
            has_paymaster,
            paymaster_and_data,
            signature,
            has_eip7702_auth: operation.eip7702_auth.is_some(),
        })
    }

    fn simulate_validation_calldata(&self) -> Result<Vec<u8>, RpcError> {
        let call_gas_limit = self
            .call_gas_limit
            .filter(|gas| *gas > 0)
            .unwrap_or(SIMULATION_CALL_GAS_LIMIT);
        let account_gas_limits = [
            uint128_word(self.verification_gas_limit),
            uint128_word(call_gas_limit),
        ]
        .concat();
        // All supported chains settle bundler fees in-band. The EntryPoint native-prefund
        // fields are signed and must remain zero for both estimation and submission.
        let gas_fees = [uint128_word(0), uint128_word(0)].concat();
        let mut output = SIMULATE_VALIDATION_SELECTOR.to_vec();
        output.extend(usize_word(32));
        output.extend(self.encode_user_operation_tuple(&account_gas_limits, &gas_fees));
        Ok(output)
    }

    fn encode_user_operation_tuple(&self, account_gas_limits: &[u8], gas_fees: &[u8]) -> Vec<u8> {
        const HEAD_SIZE: usize = 9 * 32;
        let mut tail = Vec::new();
        let mut offsets = [0usize; 4];
        for (index, value) in [
            self.init_code.as_slice(),
            self.call_data.as_slice(),
            self.paymaster_and_data.as_slice(),
            self.signature.as_slice(),
        ]
        .into_iter()
        .enumerate()
        {
            offsets[index] = HEAD_SIZE + tail.len();
            tail.extend(dynamic_bytes(value));
        }

        let mut head = Vec::with_capacity(HEAD_SIZE);
        head.extend(address_word(self.sender));
        head.extend(self.nonce);
        head.extend(usize_word(offsets[0]));
        head.extend(usize_word(offsets[1]));
        head.extend(account_gas_limits);
        head.extend(uint256_word(0));
        head.extend(gas_fees);
        head.extend(usize_word(offsets[2]));
        head.extend(usize_word(offsets[3]));
        head.extend(tail);
        head
    }

    fn pre_verification_gas(&self, simulation_call_data: &[u8]) -> u128 {
        let calldata_gas = simulation_call_data
            .iter()
            .fold(0u128, |total, byte| total + if *byte == 0 { 4 } else { 16 });
        let auth_gas = if self.has_eip7702_auth { 25_000 } else { 0 };
        let base = 21_000 + 50_000 + 10_000 + 3_000 + calldata_gas + auth_gas;
        base + (base / 10).max(5_000)
    }
}

fn dynamic_bytes(value: &[u8]) -> Vec<u8> {
    let mut encoded = usize_word(value.len()).to_vec();
    encoded.extend(value);
    let padding = (32 - value.len() % 32) % 32;
    encoded.extend(std::iter::repeat_n(0, padding));
    encoded
}

fn address(value: &str, field: &str) -> Result<[u8; 20], RpcError> {
    in_band_settlement::parse_address(value)
        .map_err(|_| RpcError::invalid_params(format!("{field} must be a 20-byte address")))
}

fn bytes(value: &str, field: &str) -> Result<Vec<u8>, RpcError> {
    in_band_settlement::decode_hex(value)
        .map_err(|_| RpcError::invalid_params(format!("{field} must be 0x-prefixed hex data")))
}

fn optional_quantity(value: Option<&str>, field: &str) -> Result<Option<u128>, RpcError> {
    value.map(|value| parse_quantity(value, field)).transpose()
}

fn parse_quantity(value: &str, field: &str) -> Result<u128, RpcError> {
    let value = value.strip_prefix("0x").ok_or_else(|| {
        RpcError::invalid_params(format!("{field} must be a 0x-prefixed quantity"))
    })?;
    if value.is_empty() || value.len() > 32 {
        return Err(RpcError::invalid_params(format!("invalid {field}")));
    }
    u128::from_str_radix(value, 16)
        .map_err(|_| RpcError::invalid_params(format!("invalid {field}")))
}

fn quantity_word(value: &str, field: &str) -> Result<[u8; 32], RpcError> {
    let value = value.strip_prefix("0x").ok_or_else(|| {
        RpcError::invalid_params(format!("{field} must be a 0x-prefixed quantity"))
    })?;
    if value.is_empty() || value.len() > 64 {
        return Err(RpcError::invalid_params(format!("invalid {field}")));
    }
    let mut value = if value.len() % 2 == 0 {
        value.to_owned()
    } else {
        format!("0{value}")
    };
    let bytes = in_band_settlement::decode_hex(&format!("0x{value}"))
        .map_err(|_| RpcError::invalid_params(format!("invalid {field}")))?;
    value.clear();
    let mut word = [0; 32];
    let offset = word.len() - bytes.len();
    word[offset..].copy_from_slice(&bytes);
    Ok(word)
}

fn address_word(address: [u8; 20]) -> [u8; 32] {
    let mut word = [0; 32];
    word[12..].copy_from_slice(&address);
    word
}

fn uint128_word(value: u128) -> [u8; 16] {
    value.to_be_bytes()
}

fn uint256_word(value: u128) -> [u8; 32] {
    let mut word = [0; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

fn usize_word(value: usize) -> [u8; 32] {
    let mut word = [0; 32];
    word[24..].copy_from_slice(&(value as u64).to_be_bytes());
    word
}

fn read_u128_word(data: &[u8], offset: usize) -> Option<u128> {
    let word = data.get(offset..offset.checked_add(32)?)?;
    if word.get(..16)?.iter().any(|byte| *byte != 0) {
        return None;
    }
    Some(u128::from_be_bytes(word.get(16..)?.try_into().ok()?))
}

fn read_usize_word(data: &[u8], offset: usize) -> Option<usize> {
    let word = data.get(offset..offset.checked_add(32)?)?;
    if word.get(..24)?.iter().any(|byte| *byte != 0) {
        return None;
    }
    let value = u64::from_be_bytes(word.get(24..)?.try_into().ok()?);
    value.try_into().ok()
}

fn format_address(address: [u8; 20]) -> String {
    format!(
        "0x{}",
        address
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn quantity(value: u128) -> String {
    format!("0x{value:x}")
}

fn with_percent_buffer(value: u128, percentage: u128) -> u128 {
    value.saturating_mul(percentage).saturating_add(99) / 100
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        SimulationUserOperation, parse_validation_pre_op_gas, quantity_word, revert_reason,
        with_percent_buffer,
    };
    use crate::{
        app::rpc::types::{EstimatableUserOperation, EstimatableUserOperationV0_7},
        utils::rpc::RpcRevert,
    };

    #[test]
    fn rejects_nonzero_fee_fields() {
        let operation = EstimatableUserOperation::V0_7(Box::new(EstimatableUserOperationV0_7 {
            sender: "0x1111111111111111111111111111111111111111".into(),
            nonce: "0x0".into(),
            factory: None,
            factory_data: None,
            call_data: "0x".into(),
            call_gas_limit: Some("0x0".into()),
            verification_gas_limit: Some("0x0".into()),
            pre_verification_gas: Some("0x0".into()),
            max_fee_per_gas: Some("0x1234".into()),
            max_priority_fee_per_gas: Some("0x56".into()),
            paymaster: None,
            paymaster_verification_gas_limit: None,
            paymaster_post_op_gas_limit: None,
            paymaster_data: None,
            signature: Some("0x1234".into()),
            eip7702_auth: None,
        }));

        let error = SimulationUserOperation::try_from((1, operation)).unwrap_err();

        assert_eq!(error.code, -32602);
        assert_eq!(
            error.data,
            Some(json!(
                "maxFeePerGas and maxPriorityFeePerGas must both be 0x0"
            ))
        );
    }

    #[test]
    fn preserves_zero_fee_fields_on_every_chain() {
        let operation = EstimatableUserOperation::V0_7(Box::new(EstimatableUserOperationV0_7 {
            sender: "0x1111111111111111111111111111111111111111".into(),
            nonce: "0x0".into(),
            factory: None,
            factory_data: None,
            call_data: "0x".into(),
            call_gas_limit: Some("0x0".into()),
            verification_gas_limit: Some("0x0".into()),
            pre_verification_gas: Some("0x0".into()),
            max_fee_per_gas: None,
            max_priority_fee_per_gas: None,
            paymaster: None,
            paymaster_verification_gas_limit: None,
            paymaster_post_op_gas_limit: None,
            paymaster_data: None,
            signature: Some("0x1234".into()),
            eip7702_auth: None,
        }));

        let calldata = SimulationUserOperation::try_from((1, operation))
            .unwrap()
            .simulate_validation_calldata()
            .unwrap();
        let tuple_start = 4 + 32;
        let gas_fees_start = tuple_start + 6 * 32;

        assert_eq!(&calldata[gas_fees_start..gas_fees_start + 32], &[0; 32]);
    }

    #[test]
    fn estimation_does_not_require_an_in_band_reimbursement() {
        let operation = EstimatableUserOperation::V0_7(Box::new(EstimatableUserOperationV0_7 {
            sender: "0x1111111111111111111111111111111111111111".into(),
            nonce: "0x0".into(),
            factory: None,
            factory_data: None,
            call_data: "0x".into(),
            call_gas_limit: None,
            verification_gas_limit: None,
            pre_verification_gas: None,
            max_fee_per_gas: Some("0x0".into()),
            max_priority_fee_per_gas: Some("0x0".into()),
            paymaster: None,
            paymaster_verification_gas_limit: None,
            paymaster_post_op_gas_limit: None,
            paymaster_data: None,
            signature: Some("0x1234".into()),
            eip7702_auth: None,
        }));

        assert!(SimulationUserOperation::try_from((1, operation)).is_ok());
    }

    #[test]
    fn decodes_pre_op_gas_from_validation_return_data() {
        let mut data = vec![0; 32 * 15];
        data[31] = 0x40;
        data[64 + 31] = 0x7b;
        let result = json!(format!(
            "0x{}",
            data.iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ));

        assert_eq!(parse_validation_pre_op_gas(&result).unwrap(), 123);
    }

    #[test]
    fn decodes_entry_point_failed_op_reasons() {
        let error = RpcRevert {
            code: Some(3),
            message: "execution reverted".into(),
            data: Some(json!({
                "originalError": {
                    "data": "0x220266b600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000001a4141323520696e76616c6964206163636f756e74206e6f6e6365000000000000"
                }
            })),
        };

        assert_eq!(
            revert_reason(&error),
            Some("FailedOp(0): AA25 invalid account nonce".into())
        );
    }

    #[test]
    fn extracts_revert_data_embedded_in_the_rpc_error_message() {
        let error = RpcRevert {
            code: Some(3),
            message: "execution reverted: 0x4e487b710000000000000000000000000000000000000000000000000000000000000011".into(),
            data: None,
        };

        assert_eq!(
            revert_reason(&error),
            Some("Solidity panic 0x11: arithmetic overflow or underflow".into())
        );
    }

    #[test]
    fn identifies_safe_execution_failed() {
        let error = RpcRevert {
            code: Some(3),
            message: "execution reverted".into(),
            data: Some(json!("0xacfdb444")),
        };

        assert_eq!(
            revert_reason(&error),
            Some("Safe execution failed: the target call in executeUserOp reverted".into())
        );
    }

    #[test]
    fn pads_gas_limits_upward() {
        assert_eq!(with_percent_buffer(101, 150), 152);
        assert_eq!(
            quantity_word("0x1234", "nonce").unwrap()[30..],
            [0x12, 0x34]
        );
    }
}
