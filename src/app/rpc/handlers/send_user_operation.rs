use axum::http::HeaderValue;
use serde_json::Value;

use crate::{
    app::{
        AppState,
        rpc::{
            handlers::in_band_settlement,
            types::{RpcError, RpcResponse, SendUserOperationParams, UserOperation},
        },
    },
    utils::rpc,
};

pub async fn handle(
    id: Value,
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    state: &AppState,
    params: SendUserOperationParams,
) -> RpcResponse<Value> {
    let SendUserOperationParams(user_operation, _) = params;

    if in_band_settlement::is_tempo_chain(chain_id)
        && let Err(error) =
            validate_tempo_submission(chain_id, user_rpc_url, state, user_operation).await
    {
        return RpcResponse::error(id, error);
    }

    RpcResponse::error(id, RpcError::backend_unavailable())
}

async fn validate_tempo_submission(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    state: &AppState,
    user_operation: UserOperation,
) -> Result<(), RpcError> {
    let (call_data, max_fee_per_gas, max_priority_fee_per_gas) = match user_operation {
        UserOperation::V0_7(operation) => (
            operation.call_data,
            operation.max_fee_per_gas,
            operation.max_priority_fee_per_gas,
        ),
        UserOperation::V0_6(operation) => (
            operation.call_data,
            operation.max_fee_per_gas,
            operation.max_priority_fee_per_gas,
        ),
    };
    if quantity(&max_fee_per_gas)? != 0 || quantity(&max_priority_fee_per_gas)? != 0 {
        return Err(RpcError::invalid_params(
            "Tempo UserOperations must set maxFeePerGas and maxPriorityFeePerGas to 0x0",
        ));
    }

    let recipient = state
        .settlement_recipient()
        .ok_or_else(RpcError::backend_unavailable)?;
    let assets = rpc::settlement_assets(chain_id)
        .await
        .map_err(|_| RpcError::estimation_unavailable())?;
    let reimbursement =
        in_band_settlement::parse_reimbursement(&call_data, recipient, assets.stablecoins.clone());

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
        "Tempo UserOperation must reimburse the settlement recipient with at least 0.00001 native coin or 0.01 of an allowlisted stablecoin",
    ))
}

fn quantity(value: &str) -> Result<u128, RpcError> {
    let value = value
        .strip_prefix("0x")
        .ok_or_else(|| RpcError::invalid_params("gas fee fields must be 0x-prefixed quantities"))?;
    u128::from_str_radix(value, 16)
        .map_err(|_| RpcError::invalid_params("invalid gas fee quantity"))
}

#[cfg(test)]
mod tests {
    use super::quantity;

    #[test]
    fn accepts_zero_fee_quantities_with_or_without_leading_zeroes() {
        assert_eq!(quantity("0x0").unwrap(), 0);
        assert_eq!(quantity("0x000").unwrap(), 0);
    }
}
