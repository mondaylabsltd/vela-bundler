use std::{
    collections::{BTreeMap, HashSet},
    fmt::{Display, Formatter},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::utils::{alchemy, config::ExecutorConfig};

#[derive(Clone)]
pub(super) struct TrustedRpcClient {
    http: Client,
    explicit_urls: Arc<BTreeMap<u64, Vec<String>>>,
    alchemy_api_key: Option<Arc<str>>,
    validated_urls: Arc<Mutex<HashSet<(u64, String)>>>,
    request_id: Arc<AtomicU64>,
}

#[derive(Clone, Debug)]
pub(super) struct RpcBatchCall<'a> {
    pub(super) method: &'a str,
    pub(super) params: Value,
}

#[derive(Debug)]
pub(super) enum RpcError {
    NoTrustedRpc(u64),
    WrongChain,
    Unavailable,
    Reverted,
    InvalidResponse,
}

#[derive(Debug)]
pub(super) enum BroadcastOutcome {
    Accepted(String),
    Ambiguous,
    Rejected,
}

impl Display for RpcError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoTrustedRpc(chain_id) => {
                write!(
                    formatter,
                    "no trusted executor RPC is configured for chain {chain_id}"
                )
            }
            Self::WrongChain => formatter.write_str("trusted RPC returned the wrong chain ID"),
            Self::Unavailable => formatter.write_str("trusted RPC is temporarily unavailable"),
            Self::Reverted => formatter.write_str("EVM execution reverted"),
            Self::InvalidResponse => {
                formatter.write_str("trusted RPC returned an invalid response")
            }
        }
    }
}

impl std::error::Error for RpcError {}

impl TrustedRpcClient {
    pub(super) fn new(config: &ExecutorConfig) -> Result<Self, RpcError> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(config.rpc_timeout)
            .build()
            .map_err(|_| RpcError::Unavailable)?;
        Ok(Self {
            http,
            explicit_urls: Arc::new(config.trusted_rpc_urls.clone()),
            alchemy_api_key: config
                .alchemy_api_key
                .as_ref()
                .map(|key| Arc::from(key.expose())),
            validated_urls: Arc::new(Mutex::new(HashSet::new())),
            request_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub(super) fn supports_chain(&self, chain_id: u64) -> bool {
        !self.urls(chain_id).is_empty()
    }

    pub(super) async fn call(
        &self,
        chain_id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let urls = self.urls_or_error(chain_id)?;
        for url in urls {
            if self.validate_chain(chain_id, &url).await.is_err() {
                continue;
            }
            match self.request(&url, method, params.clone()).await {
                Ok(response) => match response.into_result_and_error() {
                    (Some(result), None) => return Ok(result),
                    _ => continue,
                },
                Err(_) => continue,
            }
        }
        Err(RpcError::Unavailable)
    }

    pub(super) async fn simulate(
        &self,
        chain_id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let urls = self.urls_or_error(chain_id)?;
        for url in urls {
            if self.validate_chain(chain_id, &url).await.is_err() {
                continue;
            }
            match self.request(&url, method, params.clone()).await {
                Ok(response) => match response.into_result_and_error() {
                    (Some(result), None) => return Ok(result),
                    (None, Some(error)) if error.is_execution_revert() => {
                        return Err(RpcError::Reverted);
                    }
                    _ => continue,
                },
                Err(_) => continue,
            }
        }
        Err(RpcError::Unavailable)
    }

    /// Executes a JSON-RPC batch with item-level failover across trusted endpoints. A successful
    /// item or an explicit EVM revert is final; malformed, omitted, or unsupported-method items
    /// are retried on the next endpoint without repeating already resolved calls.
    pub(super) async fn batch(
        &self,
        chain_id: u64,
        calls: &[RpcBatchCall<'_>],
    ) -> Result<Vec<Result<Value, RpcError>>, RpcError> {
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let urls = self.urls_or_error(chain_id)?;
        let first_id = self
            .request_id
            .fetch_add(calls.len() as u64, Ordering::Relaxed);
        let mut results = (0..calls.len()).map(|_| None).collect::<Vec<_>>();
        let mut unresolved = (0..calls.len()).collect::<Vec<_>>();
        let mut saw_batch_response = false;

        for url in urls {
            if self.validate_chain(chain_id, &url).await.is_err() {
                continue;
            }
            let payload = unresolved
                .iter()
                .map(|index| {
                    let call = &calls[*index];
                    json!({
                        "jsonrpc": "2.0",
                        "id": first_id + *index as u64,
                        "method": call.method,
                        "params": call.params,
                    })
                })
                .collect::<Vec<_>>();
            let response = match self.http.post(&url).json(&payload).send().await {
                Ok(response) => response,
                Err(_) => continue,
            };
            let mut responses = match response.error_for_status() {
                Ok(response) => match response.json::<Vec<UpstreamResponse>>().await {
                    Ok(responses) => responses,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            saw_batch_response = true;

            let unresolved_set = unresolved.iter().copied().collect::<HashSet<_>>();
            let mut response_by_index = BTreeMap::new();
            let mut duplicate_indices = HashSet::new();
            for response in responses.drain(..) {
                let Some(index) = response
                    .id
                    .checked_sub(first_id)
                    .and_then(|offset| usize::try_from(offset).ok())
                    .filter(|index| unresolved_set.contains(index))
                else {
                    continue;
                };
                if response_by_index.insert(index, response).is_some() {
                    duplicate_indices.insert(index);
                }
            }

            let mut retry = Vec::new();
            for index in unresolved {
                if duplicate_indices.contains(&index) {
                    retry.push(index);
                    continue;
                }
                match response_by_index
                    .remove(&index)
                    .and_then(definitive_batch_result)
                {
                    Some(result) => results[index] = Some(result),
                    None => retry.push(index),
                }
            }
            unresolved = retry;
            if unresolved.is_empty() {
                break;
            }
        }

        if !saw_batch_response {
            return Err(RpcError::Unavailable);
        }
        for index in unresolved {
            results[index] = Some(Err(RpcError::InvalidResponse));
        }
        Ok(results
            .into_iter()
            .map(|result| result.expect("every batch item is resolved or marked invalid"))
            .collect())
    }

    pub(super) async fn broadcast_raw_transaction(
        &self,
        chain_id: u64,
        raw_transaction: &[u8],
    ) -> Result<BroadcastOutcome, RpcError> {
        let urls = self.urls_or_error(chain_id)?;
        let raw_transaction = format!("0x{}", hex::encode(raw_transaction));
        let mut saw_ambiguous = false;
        let mut saw_rejection = false;

        for url in urls {
            if self.validate_chain(chain_id, &url).await.is_err() {
                continue;
            }
            match self
                .request(
                    &url,
                    "eth_sendRawTransaction",
                    json!([raw_transaction.clone()]),
                )
                .await
            {
                Ok(response) => match response.into_result_and_error() {
                    (Some(Value::String(hash)), None) => {
                        return Ok(BroadcastOutcome::Accepted(hash));
                    }
                    (None, Some(error))
                        if error.is_already_known() || error.is_nonce_ambiguous() =>
                    {
                        saw_ambiguous = true;
                    }
                    (None, Some(error)) if error.is_definitive_broadcast_rejection() => {
                        saw_rejection = true;
                    }
                    _ => saw_ambiguous = true,
                },
                Err(_) => saw_ambiguous = true,
            }
        }

        Ok(if saw_ambiguous || !saw_rejection {
            BroadcastOutcome::Ambiguous
        } else {
            BroadcastOutcome::Rejected
        })
    }

    async fn validate_chain(&self, chain_id: u64, url: &str) -> Result<(), RpcError> {
        let key = (chain_id, url.to_owned());
        if self.validated_urls.lock().await.contains(&key) {
            return Ok(());
        }
        let response = self.request(url, "eth_chainId", json!([])).await?;
        let (result, error) = response.into_result_and_error();
        if error.is_some() {
            return Err(RpcError::InvalidResponse);
        }
        let returned = result
            .and_then(|value| value.as_str().map(str::to_owned))
            .and_then(|value| u64::from_str_radix(value.trim_start_matches("0x"), 16).ok())
            .ok_or(RpcError::InvalidResponse)?;
        if returned != chain_id {
            return Err(RpcError::WrongChain);
        }
        self.validated_urls.lock().await.insert(key);
        Ok(())
    }

    async fn request(
        &self,
        url: &str,
        method: &str,
        params: Value,
    ) -> Result<UpstreamResponse, RpcError> {
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);
        self.http
            .post(url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }))
            .send()
            .await
            .map_err(|_| RpcError::Unavailable)?
            .error_for_status()
            .map_err(|_| RpcError::Unavailable)?
            .json::<UpstreamResponse>()
            .await
            .map_err(|_| RpcError::InvalidResponse)
    }

    fn urls_or_error(&self, chain_id: u64) -> Result<Vec<String>, RpcError> {
        let urls = self.urls(chain_id);
        if urls.is_empty() {
            Err(RpcError::NoTrustedRpc(chain_id))
        } else {
            Ok(urls)
        }
    }

    fn urls(&self, chain_id: u64) -> Vec<String> {
        let mut urls = self
            .explicit_urls
            .get(&chain_id)
            .cloned()
            .unwrap_or_default();
        if let Some(api_key) = &self.alchemy_api_key
            && let Some(url) = alchemy::rpc_url(chain_id, api_key)
            && !urls.contains(&url)
        {
            urls.push(url);
        }
        urls
    }
}

#[derive(Debug, Deserialize)]
struct UpstreamResponse {
    #[serde(default)]
    id: u64,
    #[serde(flatten)]
    fields: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
struct UpstreamError {
    code: Option<i64>,
    message: Option<String>,
}

impl UpstreamError {
    fn normalized_message(&self) -> String {
        self.message
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase()
    }

    fn is_execution_revert(&self) -> bool {
        let message = self.normalized_message();
        self.code == Some(3)
            || message.contains("execution reverted")
            || message.contains("failedop")
    }

    fn is_already_known(&self) -> bool {
        let message = self.normalized_message();
        message.contains("already known")
            || message.contains("known transaction")
            || message.contains("already imported")
    }

    fn is_nonce_ambiguous(&self) -> bool {
        let message = self.normalized_message();
        message.contains("nonce too low") || message.contains("replacement transaction underpriced")
    }

    fn is_definitive_broadcast_rejection(&self) -> bool {
        let message = self.normalized_message();
        message.contains("insufficient funds")
            || message.contains("intrinsic gas")
            || message.contains("fee cap")
            || message.contains("max fee per gas")
            || message.contains("transaction type not supported")
    }
}

impl UpstreamResponse {
    fn into_result_and_error(mut self) -> (Option<Value>, Option<UpstreamError>) {
        let result = self.fields.remove("result");
        let error = self
            .fields
            .remove("error")
            .and_then(|value| serde_json::from_value(value).ok());
        (result, error)
    }
}

fn definitive_batch_result(response: UpstreamResponse) -> Option<Result<Value, RpcError>> {
    match response.into_result_and_error() {
        (Some(result), None) => Some(Ok(result)),
        (None, Some(error)) if error.is_execution_revert() => Some(Err(RpcError::Reverted)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::UpstreamError;

    #[test]
    fn distinguishes_ambiguous_and_definitive_broadcast_errors() {
        let ambiguous = UpstreamError {
            code: Some(-32000),
            message: Some("nonce too low".into()),
        };
        let definitive = UpstreamError {
            code: Some(-32000),
            message: Some("insufficient funds for gas * price + value".into()),
        };

        assert!(ambiguous.is_nonce_ambiguous());
        assert!(!ambiguous.is_definitive_broadcast_rejection());
        assert!(definitive.is_definitive_broadcast_rejection());
    }
}
