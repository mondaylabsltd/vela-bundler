use serde_json::Value;

use crate::app::rpc::types::RpcResponse;

pub const SUPPORTED_ENTRY_POINTS: &[&str] = &["0x0000000071727De22E5E9d8BAf0edAc6f37da032"];

pub fn is_supported(entry_point: &str) -> bool {
    SUPPORTED_ENTRY_POINTS
        .iter()
        .any(|supported| supported.eq_ignore_ascii_case(entry_point))
}

pub fn handle(id: Value) -> RpcResponse<Value> {
    RpcResponse::result(
        id,
        Value::Array(
            SUPPORTED_ENTRY_POINTS
                .iter()
                .map(|entry_point| Value::String((*entry_point).into()))
                .collect(),
        ),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::handle;

    #[test]
    fn returns_the_preferred_entry_point_first() {
        let response: Value = serde_json::to_value(handle(json!(1))).unwrap();

        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 1);
        assert_eq!(
            response["result"],
            json!(["0x0000000071727De22E5E9d8BAf0edAc6f37da032"])
        );
        assert!(response.get("error").is_none());
    }
}
