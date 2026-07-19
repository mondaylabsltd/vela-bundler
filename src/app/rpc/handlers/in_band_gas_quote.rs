use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::http::HeaderValue;
use num_bigint::BigUint;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    app::{
        AppState,
        rpc::{
            handlers::in_band_settlement,
            types::{
                GetInBandGasQuoteParams, InBandGasQuote, InBandGasQuoteAsset, RpcError, RpcResponse,
            },
        },
    },
    utils::rpc::{self, PaymentAssets, StablecoinAsset},
};

const MULTICALL3_ADDRESS: &str = "0xcA11bde05977b3631167028862bE2a173976CA11";
const AGGREGATE3_SELECTOR: [u8; 4] = [0x82, 0xad, 0x56, 0xcb];
const GET_ETH_BALANCE_SELECTOR: [u8; 4] = [0x4d, 0x23, 0x01, 0xcc];
const ERC20_BALANCE_OF_SELECTOR: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];
const ERC20_DECIMALS_SELECTOR: [u8; 4] = [0x31, 0x3c, 0xe5, 0x67];
const BINANCE_TICKER_URL: &str = "https://api.binance.com/api/v3/ticker/price?symbol=";
const MARKET_PRICE_TTL: Duration = Duration::from_secs(60);
const MARKET_PRICE_FAILURE_TTL: Duration = Duration::from_secs(3);
const MAX_MARKET_PRICE_CACHE_ENTRIES: usize = 128;

static MARKET_PRICE_CACHE: OnceLock<Mutex<HashMap<String, CachedMarketPrice>>> = OnceLock::new();
static MARKET_DATA_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub async fn handle(
    id: Value,
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    state: &AppState,
    params: GetInBandGasQuoteParams,
) -> (RpcResponse<Value>, Option<String>) {
    match quote(chain_id, user_rpc_url, state, params.safe_address()).await {
        Ok((quotes, rpc_domain)) => (
            RpcResponse::result(
                id,
                serde_json::to_value(quotes).expect("in-band gas quotes must serialize"),
            ),
            Some(rpc_domain),
        ),
        Err(error) => (RpcResponse::error(id, error), None),
    }
}

async fn quote(
    chain_id: u64,
    user_rpc_url: Option<&HeaderValue>,
    state: &AppState,
    safe_address: String,
) -> Result<(Vec<InBandGasQuote>, String), RpcError> {
    let safe_address = parse_address(&safe_address, "safeAddress")?;
    let recipient = state
        .settlement_recipient()
        .ok_or_else(RpcError::backend_unavailable)?
        .to_owned();
    let assets = rpc::payment_assets(chain_id).await.map_err(|_| {
        tracing::error!(chain_id, "could not load in-band gas quote chain metadata");
        RpcError::in_band_gas_quote_unavailable()
    })?;
    let native_price = native_usd_price(&assets.native.symbol).await;
    let stablecoins = if native_price.is_some() {
        assets
            .stablecoins
            .iter()
            .filter(|stablecoin| is_usd_stablecoin(&stablecoin.symbol))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let calls = multicall_requests(safe_address, &stablecoins);
    let result = rpc::call(
        chain_id,
        user_rpc_url,
        "eth_call",
        json!([
            {
                "to": MULTICALL3_ADDRESS,
                "data": bytes_to_hex(&encode_aggregate3(&calls)),
            },
            "latest",
        ]),
    )
    .await
    .map_err(|_| {
        tracing::warn!(chain_id, "in-band gas quote Multicall request failed");
        RpcError::in_band_gas_quote_unavailable()
    })?;
    let values = result
        .value
        .as_str()
        .ok_or_else(|| {
            tracing::warn!(
                chain_id,
                "in-band gas quote Multicall returned a non-hex result"
            );
            RpcError::in_band_gas_quote_unavailable()
        })
        .and_then(|value| {
            decode_aggregate3(value).map_err(|_| {
                tracing::warn!(
                    chain_id,
                    "could not decode in-band gas quote Multicall result"
                );
                RpcError::in_band_gas_quote_unavailable()
            })
        })?;

    quotes_from_multicall(&assets, &recipient, native_price, &stablecoins, values)
        .map(|quotes| (quotes, result.domain))
        .map_err(|error| {
            tracing::warn!(
                chain_id,
                ?error,
                "in-band gas quote Multicall result is incomplete"
            );
            error
        })
}

fn multicall_requests(
    safe_address: [u8; 20],
    stablecoins: &[StablecoinAsset],
) -> Vec<MulticallCall> {
    let mut calls = Vec::with_capacity(1 + stablecoins.len() * 2);
    calls.push(MulticallCall {
        target: address(MULTICALL3_ADDRESS).expect("Multicall3 address is valid"),
        call_data: [
            GET_ETH_BALANCE_SELECTOR.to_vec(),
            address_word(safe_address).to_vec(),
        ]
        .concat(),
    });

    for stablecoin in stablecoins {
        let target = address(&stablecoin.contract).expect("metadata stablecoin address is valid");
        calls.push(MulticallCall {
            target,
            call_data: ERC20_DECIMALS_SELECTOR.to_vec(),
        });
        calls.push(MulticallCall {
            target,
            call_data: [
                ERC20_BALANCE_OF_SELECTOR.to_vec(),
                address_word(safe_address).to_vec(),
            ]
            .concat(),
        });
    }

    calls
}

fn quotes_from_multicall(
    assets: &PaymentAssets,
    recipient: &str,
    native_price: Option<String>,
    stablecoins: &[StablecoinAsset],
    values: Vec<MulticallResult>,
) -> Result<Vec<InBandGasQuote>, RpcError> {
    let native = values
        .first()
        .filter(|result| result.success)
        .and_then(|result| bytes32_quantity(&result.return_data))
        .ok_or_else(RpcError::in_band_gas_quote_unavailable)?;
    in_band_settlement::minimum_native_amount(assets.native.decimals)
        .ok_or_else(RpcError::in_band_gas_quote_unavailable)?;
    let native_usd_balance =
        usd_balance_from_values(&native, assets.native.decimals, native_price.as_deref());
    let mut quotes = vec![InBandGasQuote {
        recipient: recipient.into(),
        asset: InBandGasQuoteAsset::Native,
        fee_token: None,
        decimals: assets.native.decimals,
        symbol: assets.native.symbol.clone(),
        balance: native,
        usd_price: native_price.clone(),
        usd_balance: native_usd_balance,
    }];

    for (index, stablecoin) in stablecoins.iter().enumerate() {
        let decimals_result = values.get(1 + index * 2);
        let balance_result = values.get(2 + index * 2);
        let Some(decimals) = decimals_result
            .filter(|result| result.success)
            .and_then(|result| bytes32_u32(&result.return_data))
        else {
            continue;
        };
        let Some(balance) = balance_result
            .filter(|result| result.success)
            .and_then(|result| bytes32_quantity(&result.return_data))
        else {
            continue;
        };
        if in_band_settlement::minimum_stablecoin_amount(decimals).is_none() {
            continue;
        }
        let usd_balance = usd_balance_from_values(&balance, decimals, Some("1"));

        quotes.push(InBandGasQuote {
            recipient: recipient.into(),
            asset: InBandGasQuoteAsset::Erc20,
            fee_token: Some(stablecoin.contract.clone()),
            decimals,
            symbol: stablecoin.symbol.clone(),
            balance,
            usd_price: Some("1".into()),
            usd_balance,
        });
    }

    quotes.sort_by(compare_usd_balance_descending);
    Ok(quotes)
}

/// Orders quotes by the Safe's USD-denominated balance without converting large on-chain values
/// through floating point. Quotes without a USD price are placed last.
fn compare_usd_balance_descending(
    left: &InBandGasQuote,
    right: &InBandGasQuote,
) -> std::cmp::Ordering {
    match (usd_balance_key(left), usd_balance_key(right)) {
        (Some(left_usd), Some(right_usd)) => right_usd
            .cmp(&left_usd)
            .then_with(|| quote_key(left).cmp(&quote_key(right))),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => quote_key(left).cmp(&quote_key(right)),
    }
}

fn quote_key(quote: &InBandGasQuote) -> (&str, &str) {
    (
        quote.symbol.as_str(),
        quote.fee_token.as_deref().unwrap_or_default(),
    )
}

struct UsdBalance {
    numerator: BigUint,
    scale: u32,
}

impl Ord for UsdBalance {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.scale.cmp(&other.scale) {
            std::cmp::Ordering::Equal => self.numerator.cmp(&other.numerator),
            std::cmp::Ordering::Greater => self
                .numerator
                .cmp(&(other.numerator.clone() * power_of_ten(self.scale - other.scale))),
            std::cmp::Ordering::Less => (self.numerator.clone()
                * power_of_ten(other.scale - self.scale))
            .cmp(&other.numerator),
        }
    }
}

impl PartialOrd for UsdBalance {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Eq for UsdBalance {}

impl PartialEq for UsdBalance {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl UsdBalance {
    fn to_decimal_string(&self) -> String {
        let mut digits = self.numerator.to_str_radix(10);
        if self.scale == 0 {
            return digits;
        }

        let scale = self.scale as usize;
        if digits.len() <= scale {
            digits = format!("{digits:0>width$}", width = scale + 1);
        }
        let decimal_position = digits.len() - scale;
        digits.insert(decimal_position, '.');
        digits
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    }
}

fn usd_balance_from_values(
    balance: &str,
    decimals: u32,
    usd_price: Option<&str>,
) -> Option<String> {
    let balance = BigUint::parse_bytes(balance.strip_prefix("0x")?.as_bytes(), 16)?;
    let (price, price_scale) = decimal_price(usd_price?)?;
    let scale = decimals.checked_add(price_scale)?;

    Some(UsdBalance {
        numerator: balance * price,
        scale,
    })
    .map(|balance| balance.to_decimal_string())
}

fn usd_balance_key(quote: &InBandGasQuote) -> Option<UsdBalance> {
    let (numerator, scale) = decimal_price(quote.usd_balance.as_deref()?)?;

    Some(UsdBalance { numerator, scale })
}

fn decimal_price(value: &str) -> Option<(BigUint, u32)> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    let digits = format!("{whole}{fraction}");
    let price = BigUint::parse_bytes(digits.as_bytes(), 10)?;
    let scale = u32::try_from(fraction.len()).ok()?;

    Some((price, scale))
}

fn power_of_ten(exponent: u32) -> BigUint {
    BigUint::from(10_u8).pow(exponent)
}

async fn native_usd_price(symbol: &str) -> Option<String> {
    let symbol = symbol.trim().to_ascii_uppercase();
    if symbol.is_empty() || !symbol.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }

    let now = Instant::now();
    if let Some(price) = cached_market_price(&symbol, now) {
        return price;
    }

    let url = format!("{BINANCE_TICKER_URL}{symbol}USDT");
    let price = match market_data_client().get(url).send().await {
        Ok(response) => match response.error_for_status() {
            Ok(response) => response
                .json::<BinanceTicker>()
                .await
                .ok()
                .and_then(|ticker| normalize_usd_price(&ticker.price)),
            Err(_) => None,
        },
        Err(_) => None,
    };
    store_market_price(symbol, price.clone(), now);
    price
}

fn is_usd_stablecoin(symbol: &str) -> bool {
    let symbol = symbol
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();

    symbol.starts_with("USD")
        || symbol.ends_with("USD")
        || matches!(
            symbol.as_str(),
            "DAI" | "FRAX" | "GHO" | "LUSD" | "MIM" | "DOLA" | "CRVUSD" | "USDE" | "USDS"
        )
}

fn normalize_usd_price(value: &str) -> Option<String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && value.bytes().filter(|byte| *byte == b'.').count() <= 1
        && value
            .bytes()
            .any(|byte| byte.is_ascii_digit() && byte != b'0');
    valid.then(|| value.into())
}

fn cached_market_price(symbol: &str, now: Instant) -> Option<Option<String>> {
    let mut cache = market_price_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.retain(|_, entry| entry.expires_at > now);
    cache.get(symbol).map(|entry| entry.price.clone())
}

fn store_market_price(symbol: String, price: Option<String>, now: Instant) {
    let mut cache = market_price_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.retain(|_, entry| entry.expires_at > now);
    if !cache.contains_key(&symbol) && cache.len() >= MAX_MARKET_PRICE_CACHE_ENTRIES {
        tracing::warn!(
            max_entries = MAX_MARKET_PRICE_CACHE_ENTRIES,
            "market price cache is full; skipped cache entry"
        );
        return;
    }

    cache.insert(
        symbol,
        CachedMarketPrice {
            expires_at: now
                + if price.is_some() {
                    MARKET_PRICE_TTL
                } else {
                    MARKET_PRICE_FAILURE_TTL
                },
            price,
        },
    );
}

fn market_price_cache() -> &'static Mutex<HashMap<String, CachedMarketPrice>> {
    MARKET_PRICE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn market_data_client() -> &'static reqwest::Client {
    MARKET_DATA_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(500))
            .timeout(Duration::from_secs(1))
            .build()
            .expect("market data HTTP client configuration must be valid")
    })
}

fn encode_aggregate3(calls: &[MulticallCall]) -> Vec<u8> {
    let encoded_calls = calls.iter().map(encode_aggregate3_call).collect::<Vec<_>>();
    let mut output = AGGREGATE3_SELECTOR.to_vec();
    output.extend(usize_word(32));
    output.extend(usize_word(calls.len()));

    let mut offset = calls.len() * 32;
    for call in &encoded_calls {
        output.extend(usize_word(offset));
        offset += call.len();
    }
    for call in encoded_calls {
        output.extend(call);
    }
    output
}

fn encode_aggregate3_call(call: &MulticallCall) -> Vec<u8> {
    let mut output = Vec::new();
    output.extend(address_word(call.target));
    output.extend(bool_word(true));
    output.extend(usize_word(96));
    output.extend(dynamic_bytes(&call.call_data));
    output
}

fn decode_aggregate3(value: &str) -> Result<Vec<MulticallResult>, ()> {
    let decoded = || -> Option<Vec<MulticallResult>> {
        let bytes = in_band_settlement::decode_hex(value).ok()?;
        let array_start = read_usize_word(&bytes, 0)?;
        let length = read_usize_word(&bytes, array_start)?;
        let offsets_start = array_start.checked_add(32)?;
        let mut results = Vec::with_capacity(length);

        for index in 0..length {
            let offset_position = offsets_start.checked_add(index.checked_mul(32)?)?;
            let offset = read_usize_word(&bytes, offset_position)?;
            let tuple_start = offsets_start.checked_add(offset)?;
            let success = read_bool_word(&bytes, tuple_start)?;
            let data_offset = read_usize_word(&bytes, tuple_start.checked_add(32)?)?;
            let data_start = tuple_start.checked_add(data_offset)?;
            let length = read_usize_word(&bytes, data_start)?;
            let return_data_start = data_start.checked_add(32)?;
            let return_data = bytes
                .get(return_data_start..return_data_start.checked_add(length)?)?
                .to_vec();
            results.push(MulticallResult {
                success,
                return_data,
            });
        }

        Some(results)
    };

    decoded().ok_or(())
}

fn bytes32_quantity(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 32 {
        return None;
    }
    let digits = hex::encode(bytes).trim_start_matches('0').to_owned();
    Some(if digits.is_empty() {
        "0x0".into()
    } else {
        format!("0x{digits}")
    })
}

fn bytes32_u32(bytes: &[u8]) -> Option<u32> {
    let value = bytes32_quantity(bytes)?;
    u32::from_str_radix(&value[2..], 16).ok()
}

fn parse_address(value: &str, field: &str) -> Result<[u8; 20], RpcError> {
    address(value)
        .ok_or_else(|| RpcError::invalid_params(format!("{field} must be a 20-byte address")))
}

fn address(value: &str) -> Option<[u8; 20]> {
    let value = value.strip_prefix("0x")?;
    (value.len() == 40)
        .then(|| hex::decode(value).ok())
        .flatten()
        .and_then(|value| value.try_into().ok())
}

fn address_word(value: [u8; 20]) -> [u8; 32] {
    let mut word = [0; 32];
    word[12..].copy_from_slice(&value);
    word
}

fn bool_word(value: bool) -> [u8; 32] {
    let mut word = [0; 32];
    word[31] = u8::from(value);
    word
}

fn usize_word(value: usize) -> [u8; 32] {
    let mut word = [0; 32];
    word[24..].copy_from_slice(&(value as u64).to_be_bytes());
    word
}

fn dynamic_bytes(value: &[u8]) -> Vec<u8> {
    let mut output = usize_word(value.len()).to_vec();
    output.extend(value);
    output.resize(output.len() + (32 - value.len() % 32) % 32, 0);
    output
}

fn read_usize_word(bytes: &[u8], offset: usize) -> Option<usize> {
    let word = bytes.get(offset..offset.checked_add(32)?)?;
    if word.get(..24)?.iter().any(|byte| *byte != 0) {
        return None;
    }
    u64::from_be_bytes(word.get(24..)?.try_into().ok()?)
        .try_into()
        .ok()
}

fn read_bool_word(bytes: &[u8], offset: usize) -> Option<bool> {
    let word = bytes.get(offset..offset.checked_add(32)?)?;
    if word.get(..31)?.iter().any(|byte| *byte != 0) {
        return None;
    }
    match word[31] {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

#[derive(Deserialize)]
struct BinanceTicker {
    price: String,
}

struct CachedMarketPrice {
    price: Option<String>,
    expires_at: Instant,
}

struct MulticallCall {
    target: [u8; 20],
    call_data: Vec<u8>,
}

struct MulticallResult {
    success: bool,
    return_data: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use crate::app::rpc::types::{InBandGasQuote, InBandGasQuoteAsset};

    use super::{
        MulticallCall, bytes32_quantity, compare_usd_balance_descending, decode_aggregate3,
        encode_aggregate3, is_usd_stablecoin, normalize_usd_price, usd_balance_from_values,
    };

    #[test]
    fn encodes_and_decodes_multicall3_aggregate3() {
        let encoded = encode_aggregate3(&[MulticallCall {
            target: [1; 20],
            call_data: vec![0x31, 0x3c, 0xe5, 0x67],
        }]);
        assert_eq!(&encoded[..4], &[0x82, 0xad, 0x56, 0xcb]);

        let response = concat!(
            "0x",
            "0000000000000000000000000000000000000000000000000000000000000020",
            "0000000000000000000000000000000000000000000000000000000000000001",
            "0000000000000000000000000000000000000000000000000000000000000020",
            "0000000000000000000000000000000000000000000000000000000000000001",
            "0000000000000000000000000000000000000000000000000000000000000040",
            "0000000000000000000000000000000000000000000000000000000000000020",
            "0000000000000000000000000000000000000000000000000000000000000006"
        );
        let decoded = decode_aggregate3(response).unwrap();
        assert!(decoded[0].success);
        assert_eq!(
            bytes32_quantity(&decoded[0].return_data),
            Some("0x6".into())
        );
    }

    #[test]
    fn includes_only_usd_stablecoins_and_valid_market_prices() {
        assert!(is_usd_stablecoin("USDC.e"));
        assert!(is_usd_stablecoin("DAI"));
        assert!(!is_usd_stablecoin("EURC"));
        assert_eq!(normalize_usd_price("3024.12"), Some("3024.12".into()));
        assert_eq!(normalize_usd_price("0"), None);
    }

    #[test]
    fn orders_quotes_by_exact_usd_balance_with_unpriced_assets_last() {
        let mut quotes = [
            quote("ETH", "0xde0b6b3a7640000", 18, Some("2000")),
            quote("USDC", "0x6fc23ac00", 6, Some("1")),
            quote("XDAI", "0x4563918244f40000", 18, None),
        ];

        quotes.sort_by(compare_usd_balance_descending);

        assert_eq!(quotes[0].symbol, "USDC");
        assert_eq!(quotes[0].usd_balance.as_deref(), Some("30000"));
        assert_eq!(quotes[1].symbol, "ETH");
        assert_eq!(quotes[1].usd_balance.as_deref(), Some("2000"));
        assert_eq!(quotes[2].symbol, "XDAI");
        assert_eq!(quotes[2].usd_balance, None);
    }

    fn quote(
        symbol: &str,
        balance: &str,
        decimals: u32,
        usd_price: Option<&str>,
    ) -> InBandGasQuote {
        InBandGasQuote {
            recipient: "0x0000000000000000000000000000000000000001".into(),
            asset: InBandGasQuoteAsset::Native,
            fee_token: None,
            decimals,
            symbol: symbol.into(),
            balance: balance.into(),
            usd_price: usd_price.map(String::from),
            usd_balance: usd_balance_from_values(balance, decimals, usd_price),
        }
    }
}
