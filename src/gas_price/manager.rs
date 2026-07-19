use std::{
    error::Error,
    fmt::{Display, Formatter},
    future::Future,
    time::Duration,
};

use axum::http::HeaderValue;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::utils::rpc;

use super::{
    cache::{CacheRequest, GasPriceCache},
    chains::{ArbitrumManager, CitreaManager, MantleManager, OptimismManager},
};

const FEE_HISTORY_BLOCK_COUNT: &str = "0x5";
const FEE_HISTORY_PERCENTILES: [u8; 3] = [25, 50, 75];
const DEFAULT_HISTORY_SIZE: usize = 32;
const RESPONSE_BUDGET: Duration = Duration::from_millis(2_800);
const PRICE_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct GasPriceManager {
    policy: GasPricePolicy,
    cache: GasPriceCache,
    #[expect(
        dead_code,
        reason = "Arbitrum fee tracking is consumed by future pre-verification gas calculators."
    )]
    pub arbitrum: ArbitrumManager,
    #[expect(
        dead_code,
        reason = "Citrea fee tracking is consumed by future pre-verification gas calculators."
    )]
    pub citrea: CitreaManager,
    #[expect(
        dead_code,
        reason = "Mantle fee tracking is consumed by future pre-verification gas calculators."
    )]
    pub mantle: MantleManager,
    #[expect(
        dead_code,
        reason = "Optimism fee tracking is consumed by future pre-verification gas calculators."
    )]
    pub optimism: OptimismManager,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GasPricePolicy {
    pub base_fee_multiplier: u128,
    pub slow_multiplier: u128,
    pub standard_multiplier: u128,
    pub fast_multiplier: u128,
    pub priority_fee_divisor: u128,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GasPrice {
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GasPriceTiers {
    pub slow: GasPrice,
    pub standard: GasPrice,
    pub fast: GasPrice,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GasPriceQuote {
    pub tiers: GasPriceTiers,
    pub rpc_domain: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GasPriceError {
    NoPriceAvailable,
    InvalidUpstreamResponse,
    ArithmeticOverflow,
    ResponseDeadlineExceeded,
}

impl Display for GasPriceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoPriceAvailable => formatter.write_str("no gas price is available"),
            Self::InvalidUpstreamResponse => {
                formatter.write_str("upstream RPC returned an invalid gas price response")
            }
            Self::ArithmeticOverflow => formatter.write_str("gas price calculation overflowed"),
            Self::ResponseDeadlineExceeded => {
                formatter.write_str("the gas price response deadline was exceeded")
            }
        }
    }
}

impl Error for GasPriceError {}

impl Default for GasPricePolicy {
    fn default() -> Self {
        Self {
            base_fee_multiplier: 120,
            slow_multiplier: 100,
            standard_multiplier: 110,
            fast_multiplier: 120,
            priority_fee_divisor: 200,
        }
    }
}

impl Default for GasPriceManager {
    fn default() -> Self {
        Self::new(GasPricePolicy::default(), DEFAULT_HISTORY_SIZE)
    }
}

impl GasPriceManager {
    pub fn new(policy: GasPricePolicy, history_size: usize) -> Self {
        Self {
            policy,
            cache: GasPriceCache::new(PRICE_CACHE_TTL),
            arbitrum: ArbitrumManager::new(history_size),
            citrea: CitreaManager::new(history_size),
            mantle: MantleManager::new(history_size),
            optimism: OptimismManager::new(history_size),
        }
    }

    pub async fn user_operation_gas_prices(
        &self,
        chain_id: u64,
        user_rpc_url: Option<&HeaderValue>,
    ) -> Result<GasPriceQuote, GasPriceError> {
        match self.cache.request(chain_id, user_rpc_url) {
            CacheRequest::Hit(quote) => {
                tracing::debug!(chain_id, rpc_domain = %quote.rpc_domain, "gas price cache hit");
                Ok(quote)
            }
            CacheRequest::Follower(waiter) => wait_for_cached_quote(waiter).await,
            CacheRequest::Leader(leader) => {
                let result = self
                    .fetch_user_operation_gas_prices(chain_id, user_rpc_url)
                    .await;
                leader.complete(result.clone());
                result
            }
        }
    }

    async fn fetch_user_operation_gas_prices(
        &self,
        chain_id: u64,
        user_rpc_url: Option<&HeaderValue>,
    ) -> Result<GasPriceQuote, GasPriceError> {
        with_response_budget(async {
            let (network_price, rpc_domain) =
                self.network_gas_price(chain_id, user_rpc_url).await?;
            Ok(GasPriceQuote {
                tiers: self.tiers(network_price)?,
                rpc_domain,
            })
        })
        .await
    }

    pub async fn network_gas_price(
        &self,
        chain_id: u64,
        user_rpc_url: Option<&HeaderValue>,
    ) -> Result<(GasPrice, String), GasPriceError> {
        if let Ok(response) = rpc::call(
            chain_id,
            user_rpc_url,
            "eth_feeHistory",
            json!([FEE_HISTORY_BLOCK_COUNT, "latest", FEE_HISTORY_PERCENTILES]),
        )
        .await
        {
            match self
                .eip1559_price(response.value, chain_id, user_rpc_url)
                .await
            {
                Ok(price) => return Ok((price, response.domain)),
                Err(error) => tracing::warn!(?error, "could not calculate EIP-1559 gas price"),
            }
        }

        self.legacy_gas_price(chain_id, user_rpc_url).await
    }

    pub fn tiers(&self, network_price: GasPrice) -> Result<GasPriceTiers, GasPriceError> {
        Ok(GasPriceTiers {
            slow: self.scale(network_price, self.policy.slow_multiplier)?,
            standard: self.scale(network_price, self.policy.standard_multiplier)?,
            fast: self.scale(network_price, self.policy.fast_multiplier)?,
        })
    }

    async fn eip1559_price(
        &self,
        result: Value,
        chain_id: u64,
        user_rpc_url: Option<&HeaderValue>,
    ) -> Result<GasPrice, GasPriceError> {
        let fee_history = serde_json::from_value::<FeeHistory>(result)
            .map_err(|_| GasPriceError::InvalidUpstreamResponse)?;
        let base_fee = fee_history
            .base_fee_per_gas
            .last()
            .ok_or(GasPriceError::InvalidUpstreamResponse)
            .and_then(|value| parse_quantity(value))?;

        let priority_fee = match median_priority_fee(&fee_history.reward) {
            Some(priority_fee) if priority_fee > 0 => priority_fee,
            _ => self.priority_fee(chain_id, user_rpc_url, base_fee).await?,
        };

        self.price_from_fee_history(&fee_history, priority_fee)
    }

    fn price_from_fee_history(
        &self,
        fee_history: &FeeHistory,
        priority_fee: u128,
    ) -> Result<GasPrice, GasPriceError> {
        let base_fee = fee_history
            .base_fee_per_gas
            .last()
            .ok_or(GasPriceError::InvalidUpstreamResponse)
            .and_then(|value| parse_quantity(value))?;
        let max_fee_per_gas = scale(base_fee, self.policy.base_fee_multiplier)?
            .checked_add(priority_fee)
            .ok_or(GasPriceError::ArithmeticOverflow)?;

        Ok(GasPrice {
            max_fee_per_gas: max_fee_per_gas.max(priority_fee),
            max_priority_fee_per_gas: priority_fee,
        })
    }

    async fn priority_fee(
        &self,
        chain_id: u64,
        user_rpc_url: Option<&HeaderValue>,
        base_fee: u128,
    ) -> Result<u128, GasPriceError> {
        if let Ok(response) = rpc::call(
            chain_id,
            user_rpc_url,
            "eth_maxPriorityFeePerGas",
            Value::Array(Vec::new()),
        )
        .await
            && let Some(value) = response.value.as_str()
            && let Ok(priority_fee) = parse_quantity(value)
            && priority_fee > 0
        {
            return Ok(priority_fee);
        }

        Ok(base_fee.div_ceil(self.policy.priority_fee_divisor).max(1))
    }

    async fn legacy_gas_price(
        &self,
        chain_id: u64,
        user_rpc_url: Option<&HeaderValue>,
    ) -> Result<(GasPrice, String), GasPriceError> {
        let response = rpc::call(
            chain_id,
            user_rpc_url,
            "eth_gasPrice",
            Value::Array(Vec::new()),
        )
        .await
        .map_err(|()| GasPriceError::NoPriceAvailable)?;
        Ok((legacy_price_from_result(response.value)?, response.domain))
    }

    fn scale(&self, price: GasPrice, multiplier: u128) -> Result<GasPrice, GasPriceError> {
        let max_priority_fee_per_gas = scale(price.max_priority_fee_per_gas, multiplier)?;
        let max_fee_per_gas =
            scale(price.max_fee_per_gas, multiplier)?.max(max_priority_fee_per_gas);

        Ok(GasPrice {
            max_fee_per_gas,
            max_priority_fee_per_gas,
        })
    }
}

async fn wait_for_cached_quote(
    waiter: oneshot::Receiver<Result<GasPriceQuote, GasPriceError>>,
) -> Result<GasPriceQuote, GasPriceError> {
    tokio::time::timeout(RESPONSE_BUDGET, waiter)
        .await
        .map_err(|_| GasPriceError::ResponseDeadlineExceeded)?
        .unwrap_or(Err(GasPriceError::NoPriceAvailable))
}

async fn with_response_budget<T>(
    operation: impl Future<Output = Result<T, GasPriceError>>,
) -> Result<T, GasPriceError> {
    tokio::time::timeout(RESPONSE_BUDGET, operation)
        .await
        .map_err(|_| GasPriceError::ResponseDeadlineExceeded)?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeeHistory {
    base_fee_per_gas: Vec<String>,
    #[serde(default)]
    reward: Vec<Vec<String>>,
}

fn median_priority_fee(rewards: &[Vec<String>]) -> Option<u128> {
    let mut values = rewards
        .iter()
        .filter_map(|reward| reward.get(reward.len() / 2))
        .filter_map(|value| parse_quantity(value).ok())
        .collect::<Vec<_>>();

    if values.is_empty() {
        return None;
    }

    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        Some(values[middle - 1].saturating_add(values[middle]) / 2)
    } else {
        Some(values[middle])
    }
}

fn parse_quantity(value: &str) -> Result<u128, GasPriceError> {
    let value = value
        .strip_prefix("0x")
        .ok_or(GasPriceError::InvalidUpstreamResponse)?;

    if value.is_empty() {
        return Err(GasPriceError::InvalidUpstreamResponse);
    }

    u128::from_str_radix(value, 16).map_err(|_| GasPriceError::InvalidUpstreamResponse)
}

fn legacy_price_from_result(result: Value) -> Result<GasPrice, GasPriceError> {
    let value = result
        .as_str()
        .ok_or(GasPriceError::InvalidUpstreamResponse)
        .and_then(parse_quantity)?;

    Ok(GasPrice {
        max_fee_per_gas: value,
        max_priority_fee_per_gas: value,
    })
}

fn scale(value: u128, multiplier: u128) -> Result<u128, GasPriceError> {
    value
        .checked_mul(multiplier)
        .ok_or(GasPriceError::ArithmeticOverflow)
        .map(|value| value.div_ceil(100))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::{
        FeeHistory, GasPrice, GasPriceError, GasPriceManager, GasPricePolicy, RESPONSE_BUDGET,
        legacy_price_from_result, median_priority_fee, parse_quantity, with_response_budget,
    };

    #[test]
    fn calculates_an_eip1559_price_from_fee_history() {
        let manager = GasPriceManager::new(GasPricePolicy::default(), 2);
        let fee_history: FeeHistory = serde_json::from_value(json!({
            "baseFeePerGas": ["0x50", "0x64"],
            "reward": [["0x1", "0xa", "0x14"]]
        }))
        .unwrap();

        assert_eq!(
            manager.price_from_fee_history(&fee_history, 10).unwrap(),
            GasPrice {
                max_fee_per_gas: 130,
                max_priority_fee_per_gas: 10,
            }
        );
    }

    #[test]
    fn calculates_eip1559_tiers_with_independent_fee_caps() {
        let manager = GasPriceManager::new(GasPricePolicy::default(), 2);
        let tiers = manager
            .tiers(GasPrice {
                max_fee_per_gas: 130,
                max_priority_fee_per_gas: 10,
            })
            .unwrap();

        assert_eq!(tiers.slow.max_fee_per_gas, 130);
        assert_eq!(tiers.slow.max_priority_fee_per_gas, 10);
        assert_eq!(tiers.standard.max_fee_per_gas, 143);
        assert_eq!(tiers.standard.max_priority_fee_per_gas, 11);
        assert_eq!(tiers.fast.max_fee_per_gas, 156);
        assert_eq!(tiers.fast.max_priority_fee_per_gas, 12);
    }

    #[test]
    fn uses_the_median_priority_fee_from_fee_history_rewards() {
        let rewards: Vec<Vec<String>> = serde_json::from_value(json!([
            ["0x1", "0x4", "0x9"],
            ["0x1", "0x6", "0x9"],
            ["0x1", "0x8", "0x9"]
        ]))
        .unwrap();

        assert_eq!(median_priority_fee(&rewards), Some(6));
    }

    #[test]
    fn rejects_invalid_quantities() {
        assert!(parse_quantity("100").is_err());
        assert!(parse_quantity("0x").is_err());
        assert!(parse_quantity("0xnope").is_err());
    }

    #[test]
    fn falls_back_to_legacy_gas_price_response() {
        assert_eq!(
            legacy_price_from_result(json!("0x64")).unwrap(),
            GasPrice {
                max_fee_per_gas: 100,
                max_priority_fee_per_gas: 100,
            }
        );
        assert!(legacy_price_from_result(json!({ "gasPrice": "0x64" })).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn enforces_the_total_response_budget() {
        let result = with_response_budget(async {
            tokio::time::sleep(RESPONSE_BUDGET + Duration::from_millis(1)).await;
            Ok::<(), GasPriceError>(())
        })
        .await;

        assert_eq!(result, Err(GasPriceError::ResponseDeadlineExceeded));
    }
}
