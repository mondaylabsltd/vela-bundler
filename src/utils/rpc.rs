use std::{
    collections::HashMap,
    env,
    net::IpAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::http::HeaderValue;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};

pub const USER_RPC_URL_HEADER: &str = "x-vela-rpc-url";

const ALCHEMY_API_KEY_ENV: &str = "ALCHEMY_API_KEY";
const RPC_LIST_URL: &str = "https://ethereum-data.awesometools.dev/chains/eip155-";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(1);
const FAILED_RPC_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_FAILED_RPC_ENTRIES: usize = 1_024;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static FAILED_RPCS: OnceLock<FailedRpcCache> = OnceLock::new();

#[derive(Debug, PartialEq)]
pub struct RpcCallResult {
    pub value: Value,
    pub domain: String,
}

pub async fn call(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    method: &str,
    params: Value,
) -> Result<RpcCallResult, ()> {
    let client = http_client();

    if let Some(url) = alchemy_rpc_url(chain_id)
        && let Some(result) =
            first_result(client, chain_id, "alchemy", &[url], method, &params).await
    {
        return Ok(result);
    }

    if let Some(url) = user_rpc_url.and_then(parse_user_rpc_url) {
        if let Some(result) =
            first_result(client, chain_id, "request_header", &[url], method, &params).await
        {
            return Ok(result);
        }
    } else if user_rpc_url.is_some() {
        tracing::warn!("ignored invalid user RPC URL header");
    }

    let fallback_urls = match fetch_fallback_rpc_urls(client, chain_id).await {
        Ok(urls) => urls,
        Err(error) => {
            tracing::warn!(%error, "could not fetch fallback RPC URLs");
            return Err(());
        }
    };

    first_result(
        client,
        chain_id,
        "awesometools",
        &fallback_urls,
        method,
        &params,
    )
    .await
    .ok_or(())
}

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("HTTP client configuration must be valid")
    })
}

fn failed_rpcs() -> &'static FailedRpcCache {
    FAILED_RPCS.get_or_init(|| FailedRpcCache::new(FAILED_RPC_COOLDOWN, MAX_FAILED_RPC_ENTRIES))
}

fn alchemy_rpc_url(chain_id: u64) -> Option<String> {
    if chain_id != 1 {
        return None;
    }

    let api_key = env::var(ALCHEMY_API_KEY_ENV).ok()?;
    let api_key = api_key.trim();

    (!api_key.is_empty()).then(|| format!("https://eth-mainnet.g.alchemy.com/v2/{api_key}"))
}

fn parse_user_rpc_url(value: &HeaderValue) -> Option<String> {
    let value = value.to_str().ok()?.trim();
    parse_rpc_url(value)
}

async fn fetch_fallback_rpc_urls(client: &Client, chain_id: u64) -> Result<Vec<String>, String> {
    let url = format!("{RPC_LIST_URL}{chain_id}.json");
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("metadata request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("metadata request failed: {error}"))?
        .json::<ChainMetadata>()
        .await
        .map_err(|error| format!("invalid chain metadata: {error}"))?;

    Ok(response
        .rpc
        .into_iter()
        .filter_map(|url| parse_rpc_url(&url))
        .collect())
}

fn parse_rpc_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?;

    (url.scheme() == "https" && !is_local_host(host)).then(|| url.into())
}

fn is_local_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }

    host.parse::<IpAddr>().is_ok_and(|address| match address {
        IpAddr::V4(address) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        IpAddr::V6(address) => address.is_loopback() || address.is_unspecified(),
    })
}

async fn first_result(
    client: &Client,
    chain_id: u64,
    source: &str,
    urls: &[String],
    method: &str,
    params: &Value,
) -> Option<RpcCallResult> {
    for url in urls {
        if let Some(retry_after) = failed_rpcs().retry_after(chain_id, url, method) {
            tracing::debug!(
                source,
                chain_id,
                method,
                rpc_url = %redacted_rpc_url(url),
                retry_after_ms = retry_after.as_millis(),
                "skipped RPC during failure cooldown"
            );
            continue;
        }

        match fetch_result(client, url, method, params).await {
            Ok(result) => {
                tracing::info!(
                    source,
                    method,
                    rpc_url = %redacted_rpc_url(url),
                    "upstream JSON-RPC source selected"
                );
                return Some(RpcCallResult {
                    value: result,
                    domain: rpc_domain(url),
                });
            }
            Err(error) => {
                failed_rpcs().freeze(chain_id, url, method);
                tracing::warn!(
                    source,
                    chain_id,
                    method,
                    rpc_url = %redacted_rpc_url(url),
                    %error,
                    "upstream JSON-RPC source failed"
                );
            }
        }
    }

    None
}

async fn fetch_result(
    client: &Client,
    url: &str,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let response = client
        .post(url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }))
        .send()
        .await
        .map_err(request_error)?
        .error_for_status()
        .map_err(response_error)?
        .json::<UpstreamRpcResponse>()
        .await
        .map_err(|_| "invalid JSON-RPC response".to_owned())?;

    if response.error.is_some() {
        return Err("upstream returned a JSON-RPC error".into());
    }

    response
        .result
        .ok_or_else(|| "upstream JSON-RPC response has no result".to_owned())
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "upstream request timed out".into()
    } else if error.is_connect() {
        "could not connect to upstream RPC".into()
    } else {
        "upstream request failed".into()
    }
}

fn response_error(error: reqwest::Error) -> String {
    match error.status() {
        Some(status) => format!("upstream returned HTTP status {status}"),
        None => "upstream returned an invalid HTTP response".into(),
    }
}

fn redacted_rpc_url(value: &str) -> String {
    let Ok(url) = reqwest::Url::parse(value) else {
        return "<invalid>".into();
    };
    let Some(host) = url.host_str() else {
        return "<invalid>".into();
    };

    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    format!("{}://{host}{port}/…", url.scheme())
}

fn rpc_domain(value: &str) -> String {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| "<unknown>".into())
}

#[derive(Eq, Hash, PartialEq)]
struct FailedRpcKey {
    chain_id: u64,
    url: String,
    method: String,
}

struct FailedRpcCache {
    cooldown: Duration,
    max_entries: usize,
    entries: Mutex<HashMap<FailedRpcKey, Instant>>,
}

impl FailedRpcCache {
    fn new(cooldown: Duration, max_entries: usize) -> Self {
        Self {
            cooldown,
            max_entries,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn retry_after(&self, chain_id: u64, url: &str, method: &str) -> Option<Duration> {
        let now = Instant::now();
        let mut entries = self.lock_entries();
        entries.retain(|_, deadline| *deadline > now);
        entries
            .get(&FailedRpcKey::new(chain_id, url, method))
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    fn freeze(&self, chain_id: u64, url: &str, method: &str) {
        let now = Instant::now();
        let mut entries = self.lock_entries();
        entries.retain(|_, deadline| *deadline > now);

        if entries.len() >= self.max_entries {
            tracing::warn!(
                max_entries = self.max_entries,
                "RPC failure cache is full; skipped cooldown entry"
            );
            return;
        }

        entries.insert(
            FailedRpcKey::new(chain_id, url, method),
            now + self.cooldown,
        );
    }

    fn lock_entries(&self) -> std::sync::MutexGuard<'_, HashMap<FailedRpcKey, Instant>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl FailedRpcKey {
    fn new(chain_id: u64, url: &str, method: &str) -> Self {
        Self {
            chain_id,
            url: url.into(),
            method: method.into(),
        }
    }
}

#[derive(Deserialize)]
struct ChainMetadata {
    rpc: Vec<String>,
}

#[derive(Deserialize)]
struct UpstreamRpcResponse {
    result: Option<Value>,
    error: Option<Value>,
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    use axum::{Json, Router, http::StatusCode, routing::post};
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::{
        FailedRpcCache, fetch_result, first_result, parse_rpc_url, redacted_rpc_url, rpc_domain,
    };

    #[test]
    fn keeps_only_safe_https_fallback_urls() {
        assert_eq!(
            parse_rpc_url("https://eth.example.com"),
            Some("https://eth.example.com/".into())
        );
        assert!(parse_rpc_url("http://eth.example.com").is_none());
        assert!(parse_rpc_url("https://127.0.0.1").is_none());
    }

    #[test]
    fn redacts_rpc_url_paths_and_query_parameters_from_logs() {
        assert_eq!(
            redacted_rpc_url("https://eth-mainnet.g.alchemy.com/v2/secret?another=secret"),
            "https://eth-mainnet.g.alchemy.com/…"
        );
    }

    #[test]
    fn extracts_only_the_rpc_domain() {
        assert_eq!(
            rpc_domain("https://eth-mainnet.g.alchemy.com/v2/secret?another=secret"),
            "eth-mainnet.g.alchemy.com"
        );
    }

    #[test]
    fn cooldown_is_scoped_to_the_chain_url_and_method() {
        let cache = FailedRpcCache::new(Duration::from_secs(30), 2);
        cache.freeze(1, "https://rpc.example.com", "eth_feeHistory");

        assert!(
            cache
                .retry_after(1, "https://rpc.example.com", "eth_feeHistory")
                .is_some()
        );
        assert!(
            cache
                .retry_after(2, "https://rpc.example.com", "eth_feeHistory")
                .is_none()
        );
        assert!(
            cache
                .retry_after(1, "https://rpc.example.com", "eth_gasPrice")
                .is_none()
        );
    }

    #[tokio::test]
    async fn fails_over_immediately_after_a_rate_limited_rpc_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let limited_calls = Arc::new(AtomicUsize::new(0));
        let limited_calls_for_server = Arc::clone(&limited_calls);
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/limited",
                        post(move || {
                            let limited_calls = Arc::clone(&limited_calls_for_server);
                            async move {
                                limited_calls.fetch_add(1, Ordering::Relaxed);
                                StatusCode::TOO_MANY_REQUESTS
                            }
                        }),
                    )
                    .route(
                        "/",
                        post(|| async {
                            Json(json!({ "jsonrpc": "2.0", "id": 1, "result": "0x64" }))
                        }),
                    ),
            )
            .await
            .unwrap();
        });

        tokio::time::sleep(Duration::from_millis(10)).await;

        let urls = vec![
            format!("http://{address}/limited"),
            format!("http://{address}"),
        ];
        let client = reqwest::Client::new();
        assert_eq!(
            fetch_result(&client, &urls[1], "eth_gasPrice", &json!([])).await,
            Ok(json!("0x64"))
        );
        let started = Instant::now();

        let result = first_result(&client, 1, "test", &urls, "eth_gasPrice", &json!([]))
            .await
            .unwrap();
        assert_eq!(result.value, json!("0x64"));
        assert_eq!(result.domain, "127.0.0.1");
        assert!(started.elapsed() < Duration::from_secs(1));
        let second_result = first_result(&client, 1, "test", &urls, "eth_gasPrice", &json!([]))
            .await
            .unwrap();
        assert_eq!(second_result.value, json!("0x64"));
        assert_eq!(limited_calls.load(Ordering::Relaxed), 1);
        server.abort();
    }
}
