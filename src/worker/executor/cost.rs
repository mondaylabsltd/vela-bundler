use alloy::primitives::U256;

/// Allocates the complete outer transaction gas across its UserOperations without allowing one
/// sender to free-ride on another. Direct EntryPoint gas is charged to that op; shared outer and
/// safety-buffer gas is split deterministically, including the integer remainder.
pub(super) fn allocate_bundle_gas(
    simulated_outer_gas: U256,
    estimated_outer_gas: U256,
    per_operation_gas: &[U256],
    buffer_bps: u64,
    fixed_buffer: u64,
) -> Option<Vec<U256>> {
    if per_operation_gas.is_empty() {
        return Some(Vec::new());
    }
    let direct = per_operation_gas
        .iter()
        .try_fold(U256::ZERO, |sum, gas| sum.checked_add(*gas))?;
    let metered = simulated_outer_gas.max(estimated_outer_gas).max(direct);
    let proportional_buffer = ceil_div(
        metered.checked_mul(U256::from(buffer_bps))?,
        U256::from(10_000),
    )?;
    let total = metered
        .checked_add(proportional_buffer)?
        .checked_add(U256::from(fixed_buffer))?;
    let shared = total.checked_sub(direct)?;
    let count = U256::from(per_operation_gas.len());
    let per_operation_shared = shared / count;
    let remainder = shared % count;

    per_operation_gas
        .iter()
        .enumerate()
        .map(|(index, gas)| {
            gas.checked_add(per_operation_shared)?
                .checked_add(U256::from(u8::from(U256::from(index) < remainder)))
        })
        .collect()
}

pub(super) fn native_cost(gas: U256, max_fee_per_gas: u128) -> Option<U256> {
    gas.checked_mul(U256::from(max_fee_per_gas))
}

fn ceil_div(value: U256, divisor: U256) -> Option<U256> {
    if divisor.is_zero() {
        return None;
    }
    let quotient = value / divisor;
    let remainder = value % divisor;
    quotient.checked_add(U256::from(u8::from(!remainder.is_zero())))
}

#[cfg(test)]
mod tests {
    use alloy::primitives::U256;

    use super::allocate_bundle_gas;

    #[test]
    fn allocation_is_exact_and_assigns_remainder_deterministically() {
        let allocation = allocate_bundle_gas(
            U256::from(100),
            U256::from(120),
            &[U256::from(40), U256::from(30), U256::from(20)],
            1_000,
            2,
        )
        .unwrap();

        // total = max(100,120,90) + 10% + 2 = 134
        assert_eq!(allocation, [U256::from(55), U256::from(45), U256::from(34)]);
        assert_eq!(allocation.into_iter().sum::<U256>(), U256::from(134));
    }

    #[test]
    fn never_allocates_less_than_an_events_direct_gas() {
        let allocation = allocate_bundle_gas(
            U256::from(1),
            U256::from(1),
            &[U256::from(100), U256::from(200)],
            1_500,
            30,
        )
        .unwrap();

        assert!(allocation[0] >= U256::from(100));
        assert!(allocation[1] >= U256::from(200));
    }
}
