use axum::http::HeaderValue;
use serde_json::Value;

use crate::{
    app::rpc::types::{GasPriceTier, RpcError, RpcResponse, UserOperationGasPrice},
    gas_price::{GasPrice, GasPriceError, GasPriceManager, GasPriceQuote, GasPriceTiers},
};

pub async fn handle(
    id: Value,
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    gas_price_manager: GasPriceManager,
) -> (RpcResponse<Value>, Option<String>) {
    match gas_price_manager
        .user_operation_gas_prices(chain_id, user_rpc_url)
        .await
    {
        Ok(quote) => success_response(id, quote),
        Err(error) => {
            tracing::warn!(?error, "could not estimate user operation gas prices");
            (RpcResponse::error(id, response_error(error)), None)
        }
    }
}

fn success_response(id: Value, quote: GasPriceQuote) -> (RpcResponse<Value>, Option<String>) {
    (
        RpcResponse::result(
            id,
            serde_json::to_value(to_rpc_result(quote.tiers))
                .expect("gas price response must serialize"),
        ),
        Some(quote.rpc_domain),
    )
}

fn response_error(error: GasPriceError) -> RpcError {
    match error {
        GasPriceError::ResponseDeadlineExceeded => RpcError::gas_price_timeout(),
        _ => RpcError::gas_price_unavailable(),
    }
}

fn to_rpc_result(gas_prices: GasPriceTiers) -> UserOperationGasPrice {
    UserOperationGasPrice {
        slow: to_rpc_tier(gas_prices.slow),
        standard: to_rpc_tier(gas_prices.standard),
        fast: to_rpc_tier(gas_prices.fast),
    }
}

fn to_rpc_tier(gas_price: GasPrice) -> GasPriceTier {
    GasPriceTier {
        max_fee_per_gas: quantity(gas_price.max_fee_per_gas),
        max_priority_fee_per_gas: quantity(gas_price.max_priority_fee_per_gas),
    }
}

fn quantity(value: u128) -> String {
    format!("0x{value:x}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::gas_price::{GasPrice, GasPriceError, GasPriceTiers};

    use super::{response_error, to_rpc_result};

    #[test]
    fn converts_gas_price_tiers_to_the_pimlico_response_shape() {
        let result = to_rpc_result(GasPriceTiers {
            slow: GasPrice {
                max_fee_per_gas: 100,
                max_priority_fee_per_gas: 10,
            },
            standard: GasPrice {
                max_fee_per_gas: 110,
                max_priority_fee_per_gas: 11,
            },
            fast: GasPrice {
                max_fee_per_gas: 120,
                max_priority_fee_per_gas: 12,
            },
        });

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "slow": { "maxFeePerGas": "0x64", "maxPriorityFeePerGas": "0xa" },
                "standard": { "maxFeePerGas": "0x6e", "maxPriorityFeePerGas": "0xb" },
                "fast": { "maxFeePerGas": "0x78", "maxPriorityFeePerGas": "0xc" }
            })
        );
    }

    #[test]
    fn returns_a_specific_error_when_the_response_deadline_is_exceeded() {
        let error = response_error(GasPriceError::ResponseDeadlineExceeded);

        assert_eq!(error.code, -32000);
        assert_eq!(error.message, "gas price RPC request timed out");
    }

    #[test]
    fn keeps_the_generic_error_for_non_timeout_failures() {
        let error = response_error(GasPriceError::NoPriceAvailable);

        assert_eq!(error.code, -32000);
        assert_eq!(error.message, "all gas price RPC sources failed");
    }
}
