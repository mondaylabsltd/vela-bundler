use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{app::AppState, utils::rpc};

const NATIVE_TREASURY_FLOOR: &str = "0x2386f26fc10000";

#[derive(Serialize)]
struct TreasuryAddress {
    address: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreasuryStatus {
    chain_id: u64,
    address: String,
    asset: TreasuryAsset,
    balance: String,
    floor: &'static str,
    bootstrap_needed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum TreasuryAsset {
    Native,
}

pub async fn address(State(state): State<AppState>) -> Response {
    let Some(address) = state.settlement_recipient() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "settlement recipient is not configured",
        );
    };

    (
        StatusCode::OK,
        Json(TreasuryAddress {
            address: address.into(),
        }),
    )
        .into_response()
}

pub async fn status(
    State(state): State<AppState>,
    Path(chain_id): Path<u64>,
    headers: HeaderMap,
) -> Response {
    let Some(address) = state.settlement_recipient() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "settlement recipient is not configured",
        );
    };

    let balance = match rpc::call(
        chain_id,
        headers.get(rpc::USER_RPC_URL_HEADER),
        "eth_getBalance",
        json!([address, "latest"]),
    )
    .await
    {
        Ok(result) => result,
        Err(()) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "treasury RPC is unavailable",
            );
        }
    };
    let balance = match parse_quantity(&balance.value) {
        Ok(balance) => balance,
        Err(()) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "treasury RPC returned an invalid balance",
            );
        }
    };

    (
        StatusCode::OK,
        Json(TreasuryStatus {
            chain_id,
            address: address.into(),
            asset: TreasuryAsset::Native,
            bootstrap_needed: quantity_is_below(&balance, NATIVE_TREASURY_FLOOR),
            balance,
            floor: NATIVE_TREASURY_FLOOR,
        }),
    )
        .into_response()
}

fn parse_quantity(value: &Value) -> Result<String, ()> {
    let value = value.as_str().ok_or(())?;
    let digits = value.strip_prefix("0x").ok_or(())?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("0x{}", digits.to_ascii_lowercase()))
        .ok_or(())
}

fn quantity_is_below(value: &str, floor: &str) -> bool {
    let value = value[2..].trim_start_matches('0');
    let floor = floor[2..].trim_start_matches('0');

    value.len() < floor.len() || (value.len() == floor.len() && value < floor)
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{NATIVE_TREASURY_FLOOR, parse_quantity, quantity_is_below};

    #[test]
    fn validates_and_normalizes_rpc_quantities() {
        assert_eq!(parse_quantity(&json!("0x000F")), Ok("0x000f".into()));
        assert!(parse_quantity(&json!("0x")).is_err());
        assert!(parse_quantity(&json!("15")).is_err());
    }

    #[test]
    fn compares_arbitrary_size_hex_balances_against_the_floor() {
        assert!(quantity_is_below("0x0", NATIVE_TREASURY_FLOOR));
        assert!(quantity_is_below("0x2386f26fc0ffff", NATIVE_TREASURY_FLOOR));
        assert!(!quantity_is_below(
            "0x2386f26fc10000",
            NATIVE_TREASURY_FLOOR
        ));
        assert!(!quantity_is_below(
            "0x10000000000000000",
            NATIVE_TREASURY_FLOOR
        ));
    }
}
