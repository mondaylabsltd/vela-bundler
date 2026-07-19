#![allow(
    dead_code,
    reason = "Chain fee trackers are consumed by future pre-verification gas calculators."
)]

use super::window::RollingWindow;

const DEFAULT_MIN_FEE: u128 = 1;

#[derive(Clone)]
pub struct ArbitrumManager {
    l1_base_fee: RollingWindow,
    l2_base_fee: RollingWindow,
}

impl ArbitrumManager {
    pub fn new(history_size: usize) -> Self {
        Self {
            l1_base_fee: RollingWindow::new(history_size),
            l2_base_fee: RollingWindow::new(history_size),
        }
    }

    pub fn record_l1_base_fee(&self, value: u128) {
        self.l1_base_fee.record(value);
    }

    pub fn record_l2_base_fee(&self, value: u128) {
        self.l2_base_fee.record(value);
    }

    pub fn min_l1_base_fee(&self) -> u128 {
        self.l1_base_fee.min_or(DEFAULT_MIN_FEE)
    }

    pub fn max_l1_base_fee(&self) -> u128 {
        self.l1_base_fee.max_or(u128::MAX)
    }

    pub fn min_l2_base_fee(&self) -> u128 {
        self.l2_base_fee.min_or(DEFAULT_MIN_FEE)
    }

    pub fn max_l2_base_fee(&self) -> u128 {
        self.l2_base_fee.max_or(u128::MAX)
    }
}

#[derive(Clone)]
pub struct CitreaManager {
    l1_fee_rate: RollingWindow,
}

impl CitreaManager {
    pub fn new(history_size: usize) -> Self {
        Self {
            l1_fee_rate: RollingWindow::new(history_size),
        }
    }

    pub fn record_l1_fee_rate(&self, value: u128) {
        self.l1_fee_rate.record(value);
    }

    pub fn min_l1_fee_rate(&self) -> u128 {
        self.l1_fee_rate.min_or(DEFAULT_MIN_FEE)
    }
}

#[derive(Clone)]
pub struct MantleManager {
    token_ratio: RollingWindow,
    scalar: RollingWindow,
    rollup_data_gas_and_overhead: RollingWindow,
    l1_gas_price: RollingWindow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MantleOracleValues {
    pub token_ratio: u128,
    pub scalar: u128,
    pub rollup_data_gas_and_overhead: u128,
    pub l1_gas_price: u128,
}

impl MantleManager {
    pub fn new(history_size: usize) -> Self {
        Self {
            token_ratio: RollingWindow::new(history_size),
            scalar: RollingWindow::new(history_size),
            rollup_data_gas_and_overhead: RollingWindow::new(history_size),
            l1_gas_price: RollingWindow::new(history_size),
        }
    }

    pub fn record_oracle_values(&self, values: MantleOracleValues) {
        self.token_ratio.record(values.token_ratio);
        self.scalar.record(values.scalar);
        self.rollup_data_gas_and_overhead
            .record(values.rollup_data_gas_and_overhead);
        self.l1_gas_price.record(values.l1_gas_price);
    }

    pub fn min_oracle_values(&self) -> MantleOracleValues {
        MantleOracleValues {
            token_ratio: self.token_ratio.min_or(DEFAULT_MIN_FEE),
            scalar: self.scalar.min_or(DEFAULT_MIN_FEE),
            rollup_data_gas_and_overhead: self.rollup_data_gas_and_overhead.min_or(DEFAULT_MIN_FEE),
            l1_gas_price: self.l1_gas_price.min_or(DEFAULT_MIN_FEE),
        }
    }
}

#[derive(Clone)]
pub struct OptimismManager {
    l1_fee: RollingWindow,
}

impl OptimismManager {
    pub fn new(history_size: usize) -> Self {
        Self {
            l1_fee: RollingWindow::new(history_size),
        }
    }

    pub fn record_l1_fee(&self, value: u128) {
        self.l1_fee.record(value);
    }

    pub fn min_l1_fee(&self) -> u128 {
        self.l1_fee.min_or(DEFAULT_MIN_FEE)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ArbitrumManager, CitreaManager, MantleManager, MantleOracleValues, OptimismManager,
    };

    #[test]
    fn arbitrum_tracks_l1_and_l2_fee_ranges() {
        let manager = ArbitrumManager::new(2);
        manager.record_l1_base_fee(10);
        manager.record_l1_base_fee(30);
        manager.record_l2_base_fee(20);

        assert_eq!(manager.min_l1_base_fee(), 10);
        assert_eq!(manager.max_l1_base_fee(), 30);
        assert_eq!(manager.min_l2_base_fee(), 20);
        assert_eq!(manager.max_l2_base_fee(), 20);
    }

    #[test]
    fn chain_fee_trackers_keep_safe_defaults_and_minimums() {
        let citrea = CitreaManager::new(2);
        let mantle = MantleManager::new(2);
        let optimism = OptimismManager::new(2);

        assert_eq!(citrea.min_l1_fee_rate(), 1);
        assert_eq!(optimism.min_l1_fee(), 1);

        citrea.record_l1_fee_rate(7);
        optimism.record_l1_fee(9);
        mantle.record_oracle_values(MantleOracleValues {
            token_ratio: 2,
            scalar: 3,
            rollup_data_gas_and_overhead: 4,
            l1_gas_price: 5,
        });

        assert_eq!(citrea.min_l1_fee_rate(), 7);
        assert_eq!(optimism.min_l1_fee(), 9);
        assert_eq!(
            mantle.min_oracle_values(),
            MantleOracleValues {
                token_ratio: 2,
                scalar: 3,
                rollup_data_gas_and_overhead: 4,
                l1_gas_price: 5,
            }
        );
    }
}
