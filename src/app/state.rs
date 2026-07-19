use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
};

use crate::gas_price::GasPriceManager;

use super::queue::UserOperationQueue;

const MAX_PENDING_USER_OPERATIONS: usize = 10_000;

#[derive(Clone)]
pub struct AppState {
    gas_price: GasPriceManager,
    readiness: Readiness,
    settlement_recipient: Option<String>,
    user_operation_queue: Option<UserOperationQueue>,
    pending_user_operations: PendingUserOperations,
}

#[derive(Clone)]
pub struct Readiness {
    expected_jobs: Arc<[&'static str]>,
    ready_jobs: Arc<Mutex<HashSet<&'static str>>>,
}

/// Process-local retry cache for UserOperations that have already reached the durable queue.
///
/// Iggy is the source of truth. This bounded cache saves a repeated same-process JSON-RPC retry
/// from appending a duplicate message, but it must never be treated as durable storage.
#[derive(Clone, Default)]
pub struct PendingUserOperations {
    operations: Arc<Mutex<PendingUserOperationsState>>,
}

#[derive(Default)]
struct PendingUserOperationsState {
    entries: HashSet<String>,
    insertion_order: VecDeque<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingUserOperationInsert {
    Inserted,
    AlreadyPresent,
}

impl AppState {
    pub fn with_settlement_recipient(
        expected_jobs: &[&'static str],
        settlement_recipient: Option<String>,
    ) -> Self {
        Self {
            gas_price: GasPriceManager::default(),
            readiness: Readiness {
                expected_jobs: Arc::from(expected_jobs),
                ready_jobs: Arc::new(Mutex::new(HashSet::new())),
            },
            settlement_recipient,
            user_operation_queue: None,
            pending_user_operations: PendingUserOperations::default(),
        }
    }

    pub fn with_user_operation_queue(mut self, user_operation_queue: UserOperationQueue) -> Self {
        self.user_operation_queue = Some(user_operation_queue);
        self
    }

    pub fn readiness(&self) -> Readiness {
        self.readiness.clone()
    }

    pub fn gas_price(&self) -> GasPriceManager {
        self.gas_price.clone()
    }

    pub fn settlement_recipient(&self) -> Option<&str> {
        self.settlement_recipient.as_deref()
    }

    pub fn user_operation_queue(&self) -> Option<UserOperationQueue> {
        self.user_operation_queue.clone()
    }

    pub fn pending_user_operations(&self) -> PendingUserOperations {
        self.pending_user_operations.clone()
    }
}

impl PendingUserOperations {
    pub fn insert(&self, user_operation_hash: String) -> PendingUserOperationInsert {
        let mut operations = self.operations();

        if operations.entries.contains(&user_operation_hash) {
            return PendingUserOperationInsert::AlreadyPresent;
        }
        if operations.entries.len() >= MAX_PENDING_USER_OPERATIONS
            && let Some(evicted) = operations.insertion_order.pop_front()
        {
            operations.entries.remove(&evicted);
        }

        operations
            .insertion_order
            .push_back(user_operation_hash.clone());
        operations.entries.insert(user_operation_hash);
        PendingUserOperationInsert::Inserted
    }

    pub fn contains(&self, user_operation_hash: &str) -> bool {
        self.operations().entries.contains(user_operation_hash)
    }

    fn operations(&self) -> std::sync::MutexGuard<'_, PendingUserOperationsState> {
        self.operations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

impl Readiness {
    pub fn mark_job_ready(&self, job: &'static str) {
        self.ready_jobs().insert(job);
    }

    pub fn mark_job_unready(&self, job: &'static str) {
        self.ready_jobs().remove(job);
    }

    pub fn clear(&self) {
        self.ready_jobs().clear();
    }

    pub fn is_ready(&self) -> bool {
        let ready_jobs = self.ready_jobs();
        self.expected_jobs
            .iter()
            .all(|job| ready_jobs.contains(job))
    }

    fn ready_jobs(&self) -> std::sync::MutexGuard<'_, HashSet<&'static str>> {
        self.ready_jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::{AppState, PendingUserOperationInsert};

    #[test]
    fn retains_an_accepted_user_operation_and_makes_retries_idempotent() {
        let pending = AppState::with_settlement_recipient(&[], None).pending_user_operations();

        assert_eq!(
            pending.insert("0xabc".into()),
            PendingUserOperationInsert::Inserted
        );
        assert_eq!(
            pending.insert("0xabc".into()),
            PendingUserOperationInsert::AlreadyPresent
        );
    }
}
