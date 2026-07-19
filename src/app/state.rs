use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct AppState {
    readiness: Readiness,
}

#[derive(Clone)]
pub struct Readiness {
    expected_jobs: Arc<[&'static str]>,
    ready_jobs: Arc<Mutex<HashSet<&'static str>>>,
}

impl AppState {
    pub fn new(expected_jobs: &[&'static str]) -> Self {
        Self {
            readiness: Readiness {
                expected_jobs: Arc::from(expected_jobs),
                ready_jobs: Arc::new(Mutex::new(HashSet::new())),
            },
        }
    }

    pub fn readiness(&self) -> Readiness {
        self.readiness.clone()
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
