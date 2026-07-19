use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde_json::Value;

use crate::gas_price::GasPriceManager;

const MAX_PENDING_USER_OPERATIONS: usize = 10_000;

#[derive(Clone)]
pub struct AppState {
    gas_price: GasPriceManager,
    readiness: Readiness,
    settlement_recipient: Option<String>,
    pending_user_operations: PendingUserOperations,
}

#[derive(Clone)]
pub struct Readiness {
    expected_jobs: Arc<[&'static str]>,
    ready_jobs: Arc<Mutex<HashSet<&'static str>>>,
}

/// Process-local queue for UserOperations that passed the synchronous RPC admission checks.
///
/// The bundling worker will consume these entries in a later integration. Keeping the queue in
/// application state makes accepting a UserOperation truthful today without adding persistence
/// or a second process.
#[derive(Clone, Default)]
pub struct PendingUserOperations {
    operations: Arc<Mutex<HashMap<String, Value>>>,
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
            pending_user_operations: PendingUserOperations::default(),
        }
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

    pub fn pending_user_operations(&self) -> PendingUserOperations {
        self.pending_user_operations.clone()
    }
}

impl PendingUserOperations {
    pub fn insert(
        &self,
        user_operation_hash: String,
        user_operation: Value,
    ) -> Result<PendingUserOperationInsert, ()> {
        let mut operations = self.operations();

        if operations.contains_key(&user_operation_hash) {
            return Ok(PendingUserOperationInsert::AlreadyPresent);
        }
        if operations.len() >= MAX_PENDING_USER_OPERATIONS {
            return Err(());
        }

        operations.insert(user_operation_hash, user_operation);
        Ok(PendingUserOperationInsert::Inserted)
    }

    fn operations(&self) -> std::sync::MutexGuard<'_, HashMap<String, Value>> {
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
    use serde_json::json;

    use super::{AppState, PendingUserOperationInsert};

    #[test]
    fn retains_an_accepted_user_operation_and_makes_retries_idempotent() {
        let pending = AppState::with_settlement_recipient(&[], None).pending_user_operations();

        assert_eq!(
            pending.insert("0xabc".into(), json!({ "sender": "0x1" })),
            Ok(PendingUserOperationInsert::Inserted)
        );
        assert_eq!(
            pending.insert("0xabc".into(), json!({ "sender": "0x2" })),
            Ok(PendingUserOperationInsert::AlreadyPresent)
        );
    }
}
