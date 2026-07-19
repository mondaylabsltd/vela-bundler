use std::time::Duration;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::app::Readiness;

use super::{JobResult, report_startup};

pub async fn run(
    shutdown: CancellationToken,
    ready: Option<oneshot::Sender<JobResult>>,
    readiness: Readiness,
) {
    if !report_startup("cleanup", ready, &readiness, initialize().await) {
        return;
    }

    let mut interval = tokio::time::interval(Duration::from_secs(300));

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = interval.tick() => {
                log_event("started");
                match run_once().await {
                    Ok(()) => log_event("completed"),
                    Err(error) => tracing::error!(job = "cleanup", %error, "background job failed"),
                }
            }
        }
    }
}

async fn initialize() -> JobResult {
    Ok(())
}

async fn run_once() -> JobResult {
    // Add periodic cleanup work here.
    Ok(())
}

fn log_event(event: &'static str) {
    let thread = std::thread::current();

    tracing::info!(
        job = "cleanup",
        event,
        thread_id = ?thread.id(),
        thread_name = ?thread.name(),
        "background job event"
    );
}
