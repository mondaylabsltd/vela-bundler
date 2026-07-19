use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard},
};

#[derive(Clone)]
pub(crate) struct RollingWindow {
    capacity: usize,
    values: Arc<Mutex<VecDeque<u128>>>,
}

impl RollingWindow {
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "rolling window capacity must be positive");

        Self {
            capacity,
            values: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
        }
    }

    pub(crate) fn record(&self, value: u128) {
        let mut values = self.values();
        if values.len() == self.capacity {
            values.pop_front();
        }
        values.push_back(value);
    }

    pub(crate) fn min_or(&self, default: u128) -> u128 {
        self.values().iter().copied().min().unwrap_or(default)
    }

    pub(crate) fn max_or(&self, default: u128) -> u128 {
        self.values().iter().copied().max().unwrap_or(default)
    }

    fn values(&self) -> MutexGuard<'_, VecDeque<u128>> {
        self.values
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::RollingWindow;

    #[test]
    fn keeps_the_most_recent_values_with_min_and_max() {
        let window = RollingWindow::new(2);
        window.record(20);
        window.record(10);
        window.record(30);

        assert_eq!(window.min_or(1), 10);
        assert_eq!(window.max_or(1), 30);
    }
}
