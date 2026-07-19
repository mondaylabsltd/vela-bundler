use std::{
    collections::{BTreeMap, HashMap, HashSet},
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

use crate::utils::{alchemy, config::ExecutorConfig, rpc as chain_directory};

#[derive(Clone)]
pub(super) struct TrustedRpcClient {
    http: Client,
    explicit_urls: Arc<BTreeMap<u64, Vec<String>>>,
    alchemy_api_key: Option<Arc<str>>,
    directory_urls: Arc<Mutex<HashMap<u64, Vec<String>>>>,
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
    Reverted {
        message: String,
        data: Option<String>,
    },
    InvalidResponse,
}

#[derive(Debug)]
pub(super) enum BroadcastOutcome {
    Accepted(String),
    Ambiguous(String),
    Rejected(String),
}

impl Display for RpcError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoTrustedRpc(chain_id) => {
                write!(
                    formatter,
                    "no trusted executor RPC is available for chain {chain_id}"
                )
            }
            Self::WrongChain => formatter.write_str("trusted RPC returned the wrong chain ID"),
            Self::Unavailable => formatter.write_str("trusted RPC is temporarily unavailable"),
            Self::Reverted { .. } => formatter.write_str("EVM execution reverted"),
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
            directory_urls: Arc::new(Mutex::new(HashMap::new())),
            validated_urls: Arc::new(Mutex::new(HashSet::new())),
            request_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub(super) async fn supports_chain(&self, chain_id: u64) -> bool {
        !self.urls(chain_id).await.is_empty()
    }

    pub(super) async fn call(
        &self,
        chain_id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let urls = self.urls_or_error(chain_id).await?;
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
        let urls = self.urls_or_error(chain_id).await?;
        for url in urls {
            if self.validate_chain(chain_id, &url).await.is_err() {
                continue;
            }
            match self.request(&url, method, params.clone()).await {
                Ok(response) => match response.into_result_and_error() {
                    (Some(result), None) => return Ok(result),
                    (None, Some(error)) if error.is_execution_revert() => {
                        return Err(error.into_revert());
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
        let urls = self.urls_or_error(chain_id).await?;
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
        let urls = self.urls_or_error(chain_id).await?;
        let raw_transaction = format!("0x{}", hex::encode(raw_transaction));
        let mut ambiguous_diagnostics = Vec::new();
        let mut rejection_diagnostics = Vec::new();

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
                        ambiguous_diagnostics.push(error.diagnostic());
                    }
                    (None, Some(error)) if error.is_definitive_broadcast_rejection() => {
                        rejection_diagnostics.push(error.diagnostic());
                    }
                    (None, Some(error)) => ambiguous_diagnostics.push(error.diagnostic()),
                    _ => ambiguous_diagnostics.push("malformed RPC broadcast response".into()),
                },
                Err(error) => ambiguous_diagnostics.push(error.to_string()),
            }
        }

        Ok(
            if !ambiguous_diagnostics.is_empty() || rejection_diagnostics.is_empty() {
                BroadcastOutcome::Ambiguous(join_broadcast_diagnostics(ambiguous_diagnostics))
            } else {
                BroadcastOutcome::Rejected(join_broadcast_diagnostics(rejection_diagnostics))
            },
        )
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

    async fn urls_or_error(&self, chain_id: u64) -> Result<Vec<String>, RpcError> {
        let urls = self.urls(chain_id).await;
        if urls.is_empty() {
            Err(RpcError::NoTrustedRpc(chain_id))
        } else {
            Ok(urls)
        }
    }

    async fn urls(&self, chain_id: u64) -> Vec<String> {
        let mut urls = self
            .explicit_urls
            .get(&chain_id)
            .cloned()
            .unwrap_or_default();
        if let Some(api_key) = &self.alchemy_api_key
            && let Some(url) = alchemy::rpc_url(chain_id, api_key)
        {
            append_unique_urls(&mut urls, [url]);
        }

        let directory_urls =
            if let Some(urls) = self.directory_urls.lock().await.get(&chain_id).cloned() {
                urls
            } else {
                let (urls, cacheable) = match chain_directory::directory_rpc_urls(chain_id).await {
                    Ok(urls) => (urls, true),
                    // Do not cache an outage: a subsequent queued batch should be able to retry
                    // the controlled directory after its built-in request retries are exhausted.
                    Err(()) => (Vec::new(), false),
                };
                if cacheable {
                    self.directory_urls
                        .lock()
                        .await
                        .insert(chain_id, urls.clone());
                }
                urls
            };
        append_unique_urls(&mut urls, directory_urls);
        urls
    }
}

fn append_unique_urls(urls: &mut Vec<String>, candidates: impl IntoIterator<Item = String>) {
    for url in candidates {
        if !urls.contains(&url) {
            urls.push(url);
        }
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
    data: Option<Value>,
}

impl UpstreamError {
    fn diagnostic(&self) -> String {
        let code = self
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".into());
        let message = self.message.as_deref().unwrap_or("upstream error");
        format!("RPC code {code}: {}", truncate_diagnostic(message, 256))
    }

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

    fn into_revert(self) -> RpcError {
        RpcError::Reverted {
            message: self.message.unwrap_or_default(),
            data: revert_data(&self.data),
        }
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

fn join_broadcast_diagnostics(diagnostics: Vec<String>) -> String {
    let mut unique = Vec::new();
    for diagnostic in diagnostics {
        if !unique.contains(&diagnostic) {
            unique.push(diagnostic);
        }
    }
    truncate_diagnostic(&unique.join("; "), 512)
}

fn truncate_diagnostic(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
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
        (None, Some(error)) if error.is_execution_revert() => Some(Err(error.into_revert())),
        _ => None,
    }
}

fn revert_data(value: &Option<Value>) -> Option<String> {
    match value.as_ref()? {
        Value::String(value) => Some(value.clone()),
        Value::Object(object) => ["data", "result", "returnData"]
            .into_iter()
            .find_map(|key| object.get(key).and_then(Value::as_str).map(str::to_owned)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{UpstreamError, append_unique_urls};

    #[test]
    fn distinguishes_ambiguous_and_definitive_broadcast_errors() {
        let ambiguous = UpstreamError {
            code: Some(-32000),
            message: Some("nonce too low".into()),
            data: None,
        };
        let definitive = UpstreamError {
            code: Some(-32000),
            message: Some("insufficient funds for gas * price + value".into()),
            data: None,
        };

        assert!(ambiguous.is_nonce_ambiguous());
        assert!(!ambiguous.is_definitive_broadcast_rejection());
        assert!(definitive.is_definitive_broadcast_rejection());
    }

    #[test]
    fn appends_each_executor_rpc_url_once() {
        let mut urls = vec!["https://first.example".into()];
        append_unique_urls(
            &mut urls,
            [
                "https://first.example".into(),
                "https://second.example".into(),
                "https://second.example".into(),
            ],
        );

        assert_eq!(
            urls,
            vec![
                "https://first.example".to_owned(),
                "https://second.example".to_owned(),
            ]
        );
    }
}
