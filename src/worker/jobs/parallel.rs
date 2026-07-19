use std::time::Duration;

use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::app::Readiness;

use super::{JobResult, report_startup};

pub async fn run(
    shutdown: CancellationToken,
    ready: Option<oneshot::Sender<JobResult>>,
    readiness: Readiness,
    concurrency: usize,
) {
    if !report_startup("parallel", ready, &readiness, initialize().await) {
        return;
    }

    let mut interval = tokio::time::interval(Duration::from_secs(60));

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = interval.tick() => run_batch(shutdown.clone(), concurrency).await,
        }
    }
}

async fn run_batch(shutdown: CancellationToken, concurrency: usize) {
    tracing::info!(
        job = "parallel",
        concurrency,
        "starting background job batch"
    );

    let mut tasks = JoinSet::new();
    for worker_id in 0..concurrency {
        tasks.spawn_blocking(move || run_once(worker_id));
    }

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                tasks.abort_all();
                return;
            }
            result = tasks.join_next() => match result {
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(error))) => {
                    tracing::error!(job = "parallel", %error, "background job worker failed");
                }
                Some(Err(error)) => {
                    tracing::error!(job = "parallel", ?error, "background job worker panicked");
                }
                None => break,
            }
        }
    }

    tracing::info!(
        job = "parallel",
        concurrency,
        "background job batch completed"
    );
}

async fn initialize() -> JobResult {
    Ok(())
}

fn run_once(worker_id: usize) -> JobResult {
    log_event("started", worker_id);

    // Add CPU-intensive or blocking work for this worker here.

    log_event("completed", worker_id);
    Ok(())
}

fn log_event(event: &'static str, worker_id: usize) {
    let thread = std::thread::current();

    tracing::info!(
        job = "parallel",
        event,
        worker_id,
        thread_id = ?thread.id(),
        thread_name = ?thread.name(),
        "background job event"
    );
}
