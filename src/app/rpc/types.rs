#![expect(
    dead_code,
    reason = "This module declares the RPC contract before the bundler backend is implemented."
)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Address = String;
pub type BlockHash = String;
pub type HexData = String;
pub type Quantity = String;
pub type TransactionHash = String;
pub type UserOperationHash = String;

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Value,
    pub method: String,
    #[serde(default = "empty_params")]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse<T> {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl<T> RpcResponse<T> {
    pub fn error(id: Value, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn parse_error(details: String) -> Self {
        Self::new(-32700, "parse error", Some(Value::String(details)))
    }

    pub fn invalid_request(details: impl Into<String>) -> Self {
        Self::new(
            -32600,
            "invalid request",
            Some(Value::String(details.into())),
        )
    }

    pub fn method_not_found(method: impl Into<String>) -> Self {
        Self::new(
            -32601,
            "method not found",
            Some(Value::String(method.into())),
        )
    }

    pub fn invalid_params(details: impl Into<String>) -> Self {
        Self::new(
            -32602,
            "invalid params",
            Some(Value::String(details.into())),
        )
    }

    pub fn backend_unavailable() -> Self {
        Self::new(-32000, "bundler backend is not configured", None)
    }

    fn new(code: i32, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code,
            message: message.into(),
            data,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum RpcMethod {
    SendUserOperation,
    EstimateUserOperationGas,
    GetUserOperationReceipt,
    GetUserOperationByHash,
    SupportedEntryPoints,
    GetUserOperationGasPrice,
    GetUserOperationStatus,
}

impl RpcMethod {
    pub fn parse(value: &str) -> Result<Self, RpcError> {
        match value {
            "eth_sendUserOperation" => Ok(Self::SendUserOperation),
            "eth_estimateUserOperationGas" => Ok(Self::EstimateUserOperationGas),
            "eth_getUserOperationReceipt" => Ok(Self::GetUserOperationReceipt),
            "eth_getUserOperationByHash" => Ok(Self::GetUserOperationByHash),
            "eth_supportedEntryPoints" => Ok(Self::SupportedEntryPoints),
            "pimlico_getUserOperationGasPrice" => Ok(Self::GetUserOperationGasPrice),
            "pimlico_getUserOperationStatus" => Ok(Self::GetUserOperationStatus),
            _ => Err(RpcError::method_not_found(value)),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SendUserOperation => "eth_sendUserOperation",
            Self::EstimateUserOperationGas => "eth_estimateUserOperationGas",
            Self::GetUserOperationReceipt => "eth_getUserOperationReceipt",
            Self::GetUserOperationByHash => "eth_getUserOperationByHash",
            Self::SupportedEntryPoints => "eth_supportedEntryPoints",
            Self::GetUserOperationGasPrice => "pimlico_getUserOperationGasPrice",
            Self::GetUserOperationStatus => "pimlico_getUserOperationStatus",
        }
    }
}

pub trait RpcMethodSpec {
    type Params;
    type Result;

    const METHOD: &'static str;
}

pub struct SendUserOperation;

impl RpcMethodSpec for SendUserOperation {
    type Params = SendUserOperationParams;
    type Result = UserOperationHash;

    const METHOD: &'static str = "eth_sendUserOperation";
}

pub struct EstimateUserOperationGas;

impl RpcMethodSpec for EstimateUserOperationGas {
    type Params = EstimateUserOperationGasParams;
    type Result = UserOperationGasEstimate;

    const METHOD: &'static str = "eth_estimateUserOperationGas";
}

pub struct GetUserOperationReceipt;

impl RpcMethodSpec for GetUserOperationReceipt {
    type Params = GetUserOperationReceiptParams;
    type Result = Option<UserOperationReceipt>;

    const METHOD: &'static str = "eth_getUserOperationReceipt";
}

pub struct GetUserOperationByHash;

impl RpcMethodSpec for GetUserOperationByHash {
    type Params = GetUserOperationByHashParams;
    type Result = Option<UserOperationByHash>;

    const METHOD: &'static str = "eth_getUserOperationByHash";
}

pub struct SupportedEntryPoints;

impl RpcMethodSpec for SupportedEntryPoints {
    type Params = NoParams;
    type Result = Vec<Address>;

    const METHOD: &'static str = "eth_supportedEntryPoints";
}

pub struct GetUserOperationGasPrice;

impl RpcMethodSpec for GetUserOperationGasPrice {
    type Params = NoParams;
    type Result = UserOperationGasPrice;

    const METHOD: &'static str = "pimlico_getUserOperationGasPrice";
}

pub struct GetUserOperationStatus;

impl RpcMethodSpec for GetUserOperationStatus {
    type Params = GetUserOperationStatusParams;
    type Result = UserOperationStatus;

    const METHOD: &'static str = "pimlico_getUserOperationStatus";
}

pub struct NoParams;

#[derive(Debug, Deserialize)]
pub struct SendUserOperationParams(pub UserOperation, pub Address);

#[derive(Debug, Deserialize)]
pub struct EstimateUserOperationGasParams(
    pub EstimatableUserOperation,
    pub Address,
    #[serde(default)] pub Option<StateOverrideSet>,
);

#[derive(Debug, Deserialize)]
pub struct GetUserOperationReceiptParams(pub UserOperationHash);

#[derive(Debug, Deserialize)]
pub struct GetUserOperationByHashParams(pub UserOperationHash);

#[derive(Debug, Deserialize)]
pub struct GetUserOperationStatusParams(pub UserOperationHash);

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserOperation {
    V0_7(Box<UserOperationV0_7>),
    V0_6(Box<UserOperationV0_6>),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserOperationV0_7 {
    pub sender: Address,
    pub nonce: Quantity,
    pub factory: Option<Address>,
    pub factory_data: Option<HexData>,
    pub call_data: HexData,
    pub call_gas_limit: Quantity,
    pub verification_gas_limit: Quantity,
    pub pre_verification_gas: Quantity,
    pub max_fee_per_gas: Quantity,
    pub max_priority_fee_per_gas: Quantity,
    pub paymaster: Option<Address>,
    pub paymaster_verification_gas_limit: Option<Quantity>,
    pub paymaster_post_op_gas_limit: Option<Quantity>,
    pub paymaster_data: Option<HexData>,
    pub signature: HexData,
    pub eip7702_auth: Option<Eip7702Authorization>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserOperationV0_6 {
    pub sender: Address,
    pub nonce: Quantity,
    pub init_code: HexData,
    pub call_data: HexData,
    pub call_gas_limit: Quantity,
    pub verification_gas_limit: Quantity,
    pub pre_verification_gas: Quantity,
    pub max_fee_per_gas: Quantity,
    pub max_priority_fee_per_gas: Quantity,
    pub paymaster_and_data: HexData,
    pub signature: HexData,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum EstimatableUserOperation {
    V0_7(Box<EstimatableUserOperationV0_7>),
    V0_6(Box<EstimatableUserOperationV0_6>),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EstimatableUserOperationV0_7 {
    pub sender: Address,
    pub nonce: Quantity,
    pub factory: Option<Address>,
    pub factory_data: Option<HexData>,
    pub call_data: HexData,
    pub call_gas_limit: Option<Quantity>,
    pub verification_gas_limit: Option<Quantity>,
    pub pre_verification_gas: Option<Quantity>,
    pub max_fee_per_gas: Option<Quantity>,
    pub max_priority_fee_per_gas: Option<Quantity>,
    pub paymaster: Option<Address>,
    pub paymaster_verification_gas_limit: Option<Quantity>,
    pub paymaster_post_op_gas_limit: Option<Quantity>,
    pub paymaster_data: Option<HexData>,
    pub signature: Option<HexData>,
    pub eip7702_auth: Option<Eip7702Authorization>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EstimatableUserOperationV0_6 {
    pub sender: Address,
    pub nonce: Quantity,
    pub init_code: HexData,
    pub call_data: HexData,
    pub call_gas_limit: Option<Quantity>,
    pub verification_gas_limit: Option<Quantity>,
    pub pre_verification_gas: Option<Quantity>,
    pub max_fee_per_gas: Option<Quantity>,
    pub max_priority_fee_per_gas: Option<Quantity>,
    pub paymaster_and_data: Option<HexData>,
    pub signature: Option<HexData>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Eip7702Authorization {
    pub chain_id: Quantity,
    pub address: Address,
    pub nonce: Quantity,
    pub y_parity: Quantity,
    pub r: Quantity,
    pub s: Quantity,
}

pub type StateOverrideSet = BTreeMap<Address, StateOverride>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateOverride {
    pub balance: Option<Quantity>,
    pub nonce: Option<Quantity>,
    pub code: Option<HexData>,
    pub state: Option<BTreeMap<HexData, HexData>>,
    pub state_diff: Option<BTreeMap<HexData, HexData>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOperationGasEstimate {
    pub pre_verification_gas: Quantity,
    pub verification_gas_limit: Quantity,
    pub call_gas_limit: Quantity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paymaster_verification_gas_limit: Option<Quantity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOperationByHash {
    pub user_operation: UserOperation,
    pub entry_point: Address,
    pub block_number: Option<Quantity>,
    pub block_hash: Option<BlockHash>,
    pub transaction_hash: Option<TransactionHash>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOperationReceipt {
    pub user_op_hash: UserOperationHash,
    pub entry_point: Address,
    pub sender: Address,
    pub nonce: Quantity,
    pub paymaster: Option<Address>,
    pub actual_gas_cost: Quantity,
    pub actual_gas_used: Quantity,
    pub success: bool,
    pub reason: HexData,
    pub logs: Vec<Log>,
    pub receipt: TransactionReceipt,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    pub address: Address,
    pub topics: Vec<HexData>,
    pub data: HexData,
    pub block_number: Option<Quantity>,
    pub transaction_hash: Option<TransactionHash>,
    pub transaction_index: Option<Quantity>,
    pub block_hash: Option<BlockHash>,
    pub log_index: Option<Quantity>,
    pub removed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionReceipt {
    pub transaction_hash: TransactionHash,
    pub transaction_index: Quantity,
    pub block_hash: Option<BlockHash>,
    pub block_number: Option<Quantity>,
    pub from: Address,
    pub to: Option<Address>,
    pub cumulative_gas_used: Quantity,
    pub gas_used: Quantity,
    pub contract_address: Option<Address>,
    pub logs: Vec<Log>,
    pub logs_bloom: HexData,
    pub status: Option<Quantity>,
    pub effective_gas_price: Option<Quantity>,
    #[serde(rename = "type")]
    pub transaction_type: Option<Quantity>,
}

#[derive(Debug, Serialize)]
pub struct UserOperationGasPrice {
    pub slow: GasPriceTier,
    pub standard: GasPriceTier,
    pub fast: GasPriceTier,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GasPriceTier {
    pub max_fee_per_gas: Quantity,
    pub max_priority_fee_per_gas: Quantity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UserOperationStatusKind {
    NotFound,
    NotSubmitted,
    Submitted,
    Rejected,
    Reverted,
    Included,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct UserOperationStatus {
    pub status: UserOperationStatusKind,
    #[serde(rename = "transactionHash")]
    pub transaction_hash: Option<TransactionHash>,
}

fn empty_params() -> Value {
    Value::Array(Vec::new())
}
