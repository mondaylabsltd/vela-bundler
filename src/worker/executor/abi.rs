use std::{fmt::Display, str::FromStr};

use alloy::{
    primitives::{Address, B256, Bytes, U256, keccak256},
    sol,
    sol_types::{SolCall, SolValue},
};

use crate::app::rpc::types::{UserOperation, UserOperationV0_7};

sol! {
    #[derive(Debug)]
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    interface IEntryPoint {
        function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary);
        function simulateValidation(PackedUserOperation calldata userOp);
        function getNonce(address sender, uint192 key) external view returns (uint256 nonce);
        event UserOperationEvent(
            bytes32 indexed userOpHash,
            address indexed sender,
            address indexed paymaster,
            uint256 nonce,
            bool success,
            uint256 actualGasCost,
            uint256 actualGasUsed
        );
    }

    interface IQuoterV2 {
        struct QuoteExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint256 amountIn;
            uint24 fee;
            uint160 sqrtPriceLimitX96;
        }

        function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
            returns (uint256 amountOut, uint160 sqrtPriceX96After,
                     uint32 initializedTicksCrossed, uint256 gasEstimate);
    }
}

#[derive(Clone, Debug)]
pub(super) struct PackedOperation {
    pub(super) packed: PackedUserOperation,
    pub(super) sender: Address,
    pub(super) call_data: Bytes,
    pub(super) has_eip7702_authorization: bool,
}

#[derive(Debug)]
pub(super) struct PackError(&'static str);

impl Display for PackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for PackError {}

impl TryFrom<&UserOperation> for PackedOperation {
    type Error = PackError;

    fn try_from(operation: &UserOperation) -> Result<Self, Self::Error> {
        let UserOperation::V0_7(operation) = operation else {
            return Err(PackError(
                "only EntryPoint v0.7 UserOperations are executable",
            ));
        };
        Self::try_from(operation.as_ref())
    }
}

impl TryFrom<&UserOperationV0_7> for PackedOperation {
    type Error = PackError;

    fn try_from(operation: &UserOperationV0_7) -> Result<Self, Self::Error> {
        let sender = parse_address(&operation.sender)?;
        let init_code = match (&operation.factory, &operation.factory_data) {
            (None, None) => Bytes::new(),
            (Some(factory), factory_data) => {
                let mut value = parse_address(factory)?.to_vec();
                if let Some(factory_data) = factory_data {
                    value.extend(parse_bytes(factory_data)?);
                }
                value.into()
            }
            (None, Some(_)) => return Err(PackError("factoryData requires factory")),
        };
        let call_data: Bytes = parse_bytes(&operation.call_data)?.into();
        let verification_gas_limit = parse_u128(&operation.verification_gas_limit)?;
        let call_gas_limit = parse_u128(&operation.call_gas_limit)?;
        let max_priority_fee_per_gas = parse_u128(&operation.max_priority_fee_per_gas)?;
        let max_fee_per_gas = parse_u128(&operation.max_fee_per_gas)?;
        let account_gas_limits: [u8; 32] = [
            verification_gas_limit.to_be_bytes(),
            call_gas_limit.to_be_bytes(),
        ]
        .concat()
        .try_into()
        .expect("two uint128 values are exactly 32 bytes");
        let gas_fees: [u8; 32] = [
            max_priority_fee_per_gas.to_be_bytes(),
            max_fee_per_gas.to_be_bytes(),
        ]
        .concat()
        .try_into()
        .expect("two uint128 values are exactly 32 bytes");
        let paymaster_and_data = match &operation.paymaster {
            None => {
                if operation.paymaster_verification_gas_limit.is_some()
                    || operation.paymaster_post_op_gas_limit.is_some()
                    || operation.paymaster_data.is_some()
                {
                    return Err(PackError("paymaster gas and data require paymaster"));
                }
                Bytes::new()
            }
            Some(paymaster) => {
                let mut value = parse_address(paymaster)?.to_vec();
                value.extend(
                    parse_u128(
                        operation
                            .paymaster_verification_gas_limit
                            .as_deref()
                            .ok_or(PackError("paymasterVerificationGasLimit is required"))?,
                    )?
                    .to_be_bytes(),
                );
                value.extend(
                    parse_u128(
                        operation
                            .paymaster_post_op_gas_limit
                            .as_deref()
                            .ok_or(PackError("paymasterPostOpGasLimit is required"))?,
                    )?
                    .to_be_bytes(),
                );
                if let Some(data) = &operation.paymaster_data {
                    value.extend(parse_bytes(data)?);
                }
                value.into()
            }
        };

        Ok(Self {
            packed: PackedUserOperation {
                sender,
                nonce: parse_u256(&operation.nonce)?,
                initCode: init_code,
                callData: call_data.clone(),
                accountGasLimits: B256::from(account_gas_limits),
                preVerificationGas: parse_u256(&operation.pre_verification_gas)?,
                gasFees: B256::from(gas_fees),
                paymasterAndData: paymaster_and_data,
                signature: parse_bytes(&operation.signature)?.into(),
            },
            sender,
            call_data,
            has_eip7702_authorization: operation.eip7702_auth.is_some(),
        })
    }
}

pub(super) fn handle_ops_calldata(
    operations: &[PackedUserOperation],
    beneficiary: Address,
) -> Bytes {
    IEntryPoint::handleOpsCall {
        ops: operations.to_vec(),
        beneficiary,
    }
    .abi_encode()
    .into()
}

/// Encodes EntryPoint v0.7 `getNonce(sender, key)` for the keyed nonce carried by a UserOperation.
/// The low 64 bits are the sequence; the upper 192 bits select the nonce key.
pub(super) fn get_nonce_calldata(sender: Address, user_operation_nonce: U256) -> Bytes {
    let key: U256 = user_operation_nonce >> 64usize;
    let mut calldata = Vec::with_capacity(4 + 32 + 32);
    calldata.extend_from_slice(&IEntryPoint::getNonceCall::SELECTOR);
    calldata.extend_from_slice(&[0u8; 12]);
    calldata.extend_from_slice(sender.as_slice());
    calldata.extend_from_slice(&key.to_be_bytes::<32>());
    calldata.into()
}

/// Computes EntryPoint v0.7's canonical hash from the exact packed operation. Signature is
/// intentionally excluded by ERC-4337, so callers must separately enforce immutable payload
/// equality when accepting another envelope with the same hash.
pub(super) fn user_operation_hash(
    operation: &PackedOperation,
    entry_point: Address,
    chain_id: u64,
) -> B256 {
    let packed_hash = keccak256(
        (
            operation.packed.sender,
            operation.packed.nonce,
            keccak256(operation.packed.initCode.as_ref()),
            keccak256(operation.packed.callData.as_ref()),
            operation.packed.accountGasLimits,
            operation.packed.preVerificationGas,
            operation.packed.gasFees,
            keccak256(operation.packed.paymasterAndData.as_ref()),
        )
            .abi_encode(),
    );
    keccak256((packed_hash, entry_point, U256::from(chain_id)).abi_encode())
}

fn parse_address(value: &str) -> Result<Address, PackError> {
    Address::from_str(value).map_err(|_| PackError("invalid address in UserOperation"))
}

fn parse_bytes(value: &str) -> Result<Vec<u8>, PackError> {
    let value = value
        .strip_prefix("0x")
        .ok_or(PackError("UserOperation bytes must be 0x-prefixed"))?;
    if !value.len().is_multiple_of(2) {
        return Err(PackError("UserOperation bytes have an odd hex length"));
    }
    hex::decode(value).map_err(|_| PackError("invalid hex bytes in UserOperation"))
}

fn parse_u128(value: &str) -> Result<u128, PackError> {
    let value = value
        .strip_prefix("0x")
        .ok_or(PackError("UserOperation quantity must be 0x-prefixed"))?;
    if value.is_empty() || value.len() > 32 {
        return Err(PackError("UserOperation quantity does not fit uint128"));
    }
    u128::from_str_radix(value, 16)
        .map_err(|_| PackError("invalid uint128 quantity in UserOperation"))
}

fn parse_u256(value: &str) -> Result<U256, PackError> {
    let value = value
        .strip_prefix("0x")
        .ok_or(PackError("UserOperation quantity must be 0x-prefixed"))?;
    if value.is_empty() || value.len() > 64 {
        return Err(PackError("UserOperation quantity does not fit uint256"));
    }
    U256::from_str_radix(value, 16)
        .map_err(|_| PackError("invalid uint256 quantity in UserOperation"))
}

#[cfg(test)]
mod tests {
    use alloy::{
        primitives::{U256, address},
        sol_types::SolCall,
    };

    use super::{
        IEntryPoint, PackedOperation, get_nonce_calldata, handle_ops_calldata, user_operation_hash,
    };
    use crate::app::rpc::types::{UserOperation, UserOperationV0_7};

    fn operation() -> UserOperation {
        UserOperation::V0_7(Box::new(UserOperationV0_7 {
            sender: "0x1111111111111111111111111111111111111111".into(),
            nonce: "0x1234".into(),
            factory: Some("0x2222222222222222222222222222222222222222".into()),
            factory_data: Some("0xaabb".into()),
            call_data: "0x01020304".into(),
            call_gas_limit: "0x30".into(),
            verification_gas_limit: "0x20".into(),
            pre_verification_gas: "0x10".into(),
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
    fn computes_the_entry_point_v07_user_operation_hash() {
        let operation = UserOperation::V0_7(Box::new(UserOperationV0_7 {
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
        }));
        let packed = PackedOperation::try_from(&operation).unwrap();
        let entry_point = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
            .parse()
            .unwrap();
        assert_eq!(
            user_operation_hash(&packed, entry_point, 1).to_string(),
            "0xdd4a4e34a55b5ea9cd7bfbbe15c570fe6fd8893c2c809e72ac2077de91e1e257"
        );
    }

    #[test]
    fn packs_v07_fields_in_entry_point_order() {
        let operation = PackedOperation::try_from(&operation()).unwrap();

        assert_eq!(operation.packed.initCode.len(), 22);
        assert_eq!(&operation.packed.accountGasLimits[..15], &[0u8; 15]);
        assert_eq!(operation.packed.accountGasLimits[15], 0x20);
        assert_eq!(operation.packed.callData.as_ref(), [1, 2, 3, 4]);
    }

    #[test]
    fn encodes_the_canonical_handle_ops_selector() {
        let operation = PackedOperation::try_from(&operation()).unwrap();
        let encoded = handle_ops_calldata(
            &[operation.packed],
            address!("3333333333333333333333333333333333333333"),
        );

        assert_eq!(&encoded[..4], &IEntryPoint::handleOpsCall::SELECTOR);
        assert_eq!(hex::encode(&encoded[..4]), "765e827f");
    }

    #[test]
    fn encodes_get_nonce_with_the_high_192_bit_key() {
        let sender = address!("1111111111111111111111111111111111111111");
        let nonce = (U256::from(7u8) << 64) | U256::from(9u8);
        let encoded = get_nonce_calldata(sender, nonce);

        assert_eq!(&encoded[..4], &IEntryPoint::getNonceCall::SELECTOR);
        assert_eq!(&encoded[4..16], &[0u8; 12]);
        assert_eq!(&encoded[16..36], sender.as_slice());
        assert_eq!(U256::from_be_slice(&encoded[36..68]), U256::from(7u8));
    }
}
