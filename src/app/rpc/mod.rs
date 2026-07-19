use axum::{Json, body::Bytes, extract::Path};
use serde::de::DeserializeOwned;
use serde_json::Value;

mod handlers;
pub mod types;

use types::{
    EstimateUserOperationGasParams, GetUserOperationByHashParams, GetUserOperationReceiptParams,
    GetUserOperationStatusParams, RpcError, RpcMethod, RpcRequest, RpcResponse,
    SendUserOperationParams,
};

pub async fn handle(Path(chain_id): Path<u64>, body: Bytes) -> Json<RpcResponse<Value>> {
    let request = match serde_json::from_slice::<RpcRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            return Json(RpcResponse::error(
                Value::Null,
                RpcError::parse_error(error.to_string()),
            ));
        }
    };

    if request.jsonrpc != "2.0" {
        return Json(RpcResponse::error(
            request.id,
            RpcError::invalid_request("`jsonrpc` must be \"2.0\""),
        ));
    }

    let method = match validate_call(&request.method, request.params) {
        Ok(method) => method,
        Err(error) => return Json(RpcResponse::error(request.id, error)),
    };

    tracing::info!(
        chain_id,
        method = method.as_str(),
        "bundler RPC request received"
    );

    match method {
        RpcMethod::SupportedEntryPoints => {
            Json(handlers::supported_entry_points::handle(request.id))
        }
        _ => Json(RpcResponse::error(
            request.id,
            RpcError::backend_unavailable(),
        )),
    }
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

    use super::{handle, validate_call};

    fn router() -> Router {
        Router::new().route("/{chain_id}/rpc", post(handle))
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
