use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue},
};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::app::AppState;

mod handlers;
pub mod types;

use types::{
    EstimateUserOperationGasParams, GetUserOperationByHashParams, GetUserOperationReceiptParams,
    GetUserOperationStatusParams, RpcError, RpcMethod, RpcRequest, RpcResponse,
    SendUserOperationParams,
};

pub const RPC_DOMAIN_RESPONSE_HEADER: &str = "x-vela-rpc-domain";

type RpcHttpResponse = (HeaderMap, Json<RpcResponse<Value>>);

pub async fn handle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chain_id): Path<u64>,
    body: Bytes,
) -> RpcHttpResponse {
    let request = match serde_json::from_slice::<RpcRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            return response(RpcResponse::error(
                Value::Null,
                RpcError::parse_error(error.to_string()),
            ));
        }
    };

    if request.jsonrpc != "2.0" {
        return response(RpcResponse::error(
            request.id,
            RpcError::invalid_request("`jsonrpc` must be \"2.0\""),
        ));
    }

    let method = match validate_call(&request.method, request.params.clone()) {
        Ok(method) => method,
        Err(error) => return response(RpcResponse::error(request.id, error)),
    };

    tracing::info!(
        chain_id,
        method = method.as_str(),
        "bundler RPC request received"
    );

    let gas_price = state.gas_price();

    match method {
        RpcMethod::SupportedEntryPoints => {
            response(handlers::supported_entry_points::handle(request.id))
        }
        RpcMethod::GetUserOperationGasPrice => {
            let (response_body, rpc_domain) = handlers::user_operation_gas_price::handle(
                request.id,
                chain_id,
                headers.get(crate::utils::rpc::USER_RPC_URL_HEADER),
                gas_price,
            )
            .await;
            response_with_rpc_domain(response_body, rpc_domain)
        }
        RpcMethod::EstimateUserOperationGas => {
            let params =
                match serde_json::from_value::<EstimateUserOperationGasParams>(request.params) {
                    Ok(params) => params,
                    Err(error) => {
                        return response(RpcResponse::error(
                            request.id,
                            RpcError::invalid_params(error.to_string()),
                        ));
                    }
                };
            let (response_body, rpc_domain) = handlers::estimate_user_operation_gas::handle(
                request.id,
                chain_id,
                headers.get(crate::utils::rpc::USER_RPC_URL_HEADER),
                params,
            )
            .await;
            response_with_rpc_domain(response_body, rpc_domain)
        }
        RpcMethod::SendUserOperation => {
            let params = match serde_json::from_value::<SendUserOperationParams>(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return response(RpcResponse::error(
                        request.id,
                        RpcError::invalid_params(error.to_string()),
                    ));
                }
            };
            response(
                handlers::send_user_operation::handle(
                    request.id,
                    chain_id,
                    headers.get(crate::utils::rpc::USER_RPC_URL_HEADER),
                    &state,
                    params,
                )
                .await,
            )
        }
        _ => response(RpcResponse::error(
            request.id,
            RpcError::backend_unavailable(),
        )),
    }
}

fn response(response: RpcResponse<Value>) -> RpcHttpResponse {
    (HeaderMap::new(), Json(response))
}

fn response_with_rpc_domain(
    response_body: RpcResponse<Value>,
    rpc_domain: Option<String>,
) -> RpcHttpResponse {
    let mut headers = HeaderMap::new();

    if let Some(rpc_domain) = rpc_domain {
        match HeaderValue::try_from(rpc_domain.as_str()) {
            Ok(value) => {
                headers.insert(HeaderName::from_static(RPC_DOMAIN_RESPONSE_HEADER), value);
            }
            Err(error) => tracing::warn!(?error, "could not add RPC domain response header"),
        }
    }

    (headers, Json(response_body))
}

fn validate_call(method: &str, params: Value) -> Result<RpcMethod, RpcError> {
    let method = RpcMethod::parse(method)?;

    match method {
        RpcMethod::SendUserOperation => parse_params::<SendUserOperationParams>(params)?,
        RpcMethod::EstimateUserOperationGas => {
            parse_params::<EstimateUserOperationGasParams>(params)?;
        }
        RpcMethod::GetUserOperationReceipt => {
            parse_params::<GetUserOperationReceiptParams>(params)?;
        }
        RpcMethod::GetUserOperationByHash => {
            parse_params::<GetUserOperationByHashParams>(params)?;
        }
        RpcMethod::SupportedEntryPoints | RpcMethod::GetUserOperationGasPrice => {
            validate_empty_params(params)?;
        }
        RpcMethod::GetUserOperationStatus => {
            parse_params::<GetUserOperationStatusParams>(params)?;
        }
    }

    Ok(method)
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<(), RpcError> {
    serde_json::from_value::<T>(params)
        .map(|_| ())
        .map_err(|error| RpcError::invalid_params(error.to_string()))
}

fn validate_empty_params(params: Value) -> Result<(), RpcError> {
    match params {
        Value::Array(values) if values.is_empty() => Ok(()),
        _ => Err(RpcError::invalid_params("expected an empty parameter list")),
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        Router,
        body::Body,
        http::{Request, StatusCode},
        routing::post,
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::{
        RPC_DOMAIN_RESPONSE_HEADER, RpcResponse, handle, response_with_rpc_domain, validate_call,
    };
    use crate::app::AppState;

    fn router() -> Router {
        Router::new()
            .route("/{chain_id}/rpc", post(handle))
            .with_state(AppState::with_settlement_recipient(&[], None))
    }

    #[tokio::test]
    async fn returns_supported_entry_points() {
        let response = router()
            .oneshot(
                Request::post("/1/rpc")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 7,
                            "method": "eth_supportedEntryPoints",
                            "params": [],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let response: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(
            response["result"],
            json!(["0x0000000071727De22E5E9d8BAf0edAc6f37da032"])
        );
    }

    #[tokio::test]
    async fn rejects_invalid_method_parameters_with_a_json_rpc_error() {
        let response = router()
            .oneshot(
                Request::post("/1/rpc")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": "request-1",
                            "method": "eth_getUserOperationReceipt",
                            "params": [],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let response: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(response["id"], "request-1");
        assert_eq!(response["error"]["code"], -32602);
    }

    #[test]
    fn adds_the_selected_rpc_domain_to_the_response_header() {
        let (headers, _) = response_with_rpc_domain(
            RpcResponse::result(Value::Null, Value::Null),
            Some("rpc.example.com".into()),
        );

        assert_eq!(headers[RPC_DOMAIN_RESPONSE_HEADER], "rpc.example.com");
    }

    #[test]
    fn parses_a_v0_7_user_operation_for_submission() {
        let method = validate_call(
            "eth_sendUserOperation",
            json!([
                {
                    "sender": "0x1111111111111111111111111111111111111111",
                    "nonce": "0x0",
                    "callData": "0x",
                    "callGasLimit": "0x5208",
                    "verificationGasLimit": "0x10000",
                    "preVerificationGas": "0x1000",
                    "maxFeePerGas": "0x3b9aca00",
                    "maxPriorityFeePerGas": "0x3b9aca00",
                    "signature": "0x"
                },
                "0x2222222222222222222222222222222222222222"
            ]),
        )
        .unwrap();

        assert_eq!(method.as_str(), "eth_sendUserOperation");
    }
}
