pub mod consumer;
mod executor;
mod jobs;

use std::{io, time::Duration};

use tokio::{
    runtime::{Builder, Runtime},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::{
    app::{Readiness, UserOperationStatusStore},
    utils::{
        AppError,
        config::{ExecutorConfig, IggyConfig, WorkerConfig},
    },
};

pub const USER_OPERATION_CONSUMER_JOB: &str = "user-operation-consumer";
pub const JOB_NAMES: &[&str] = &["cleanup", "parallel", "sync", USER_OPERATION_CONSUMER_JOB];

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
// Money-path handlers deliberately finish their current durable batch after cancellation. Allow
// enough time for bounded executor RPC calls and the final Iggy offset write before aborting.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(crate) struct UserOperationExecution {
    iggy: IggyConfig,
    executor: ExecutorConfig,
    store: UserOperationStatusStore,
}

impl UserOperationExecution {
    pub(crate) fn new(
        iggy: IggyConfig,
        executor: ExecutorConfig,
        store: UserOperationStatusStore,
    ) -> Self {
        Self {
            iggy,
            executor,
            store,
        }
    }
}

pub struct BackgroundWorker {
    runtime: Option<Runtime>,
    shutdown: CancellationToken,
    tasks: Vec<JoinHandle<()>>,
    readiness: Readiness,
}

impl BackgroundWorker {
    pub(crate) async fn start_with_executor(
        config: WorkerConfig,
        readiness: Readiness,
        execution: Option<UserOperationExecution>,
    ) -> Result<Self, AppError> {
        let runtime = Builder::new_multi_thread()
            .thread_name("vela-worker")
            .worker_threads(config.runtime_threads)
            .max_blocking_threads(config.max_blocking_threads)
            .enable_all()
            .build()?;
        let shutdown = CancellationToken::new();
        let mut worker = Self {
            runtime: Some(runtime),
            shutdown: shutdown.clone(),
            tasks: Vec::new(),
            readiness: readiness.clone(),
        };

        for job in jobs::start(
            worker.runtime.as_ref().expect("worker runtime"),
            shutdown,
            config.parallel_job_concurrency,
            readiness,
            execution,
        ) {
            worker.tasks.push(job.task);

            let startup_result = match timeout(STARTUP_TIMEOUT, job.ready).await {
                Ok(Ok(Ok(()))) => {
                    tracing::info!(job = job.name, "background job ready");
                    Ok(())
                }
                Ok(Ok(Err(error))) => Err(error),
                Ok(Err(_)) => Err(io::Error::other(format!(
                    "background job `{}` stopped during startup",
                    job.name
                ))
                .into()),
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("background job `{}` did not become ready in time", job.name),
                )
                .into()),
            };

            if let Err(error) = startup_result {
                worker.shutdown().await;
                return Err(error);
            }
        }

        tracing::info!("background worker started");
        Ok(worker)
    }

    pub async fn shutdown(mut self) {
        self.shutdown.cancel();
        self.readiness.clear();

        for mut task in self.tasks.drain(..) {
            match timeout(SHUTDOWN_TIMEOUT, &mut task).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(?error, "background job supervisor stopped unexpectedly");
                }
                Err(_) => {
                    task.abort();
                    tracing::warn!("background job supervisor did not stop before timeout");
                }
            }
        }

        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

impl Drop for BackgroundWorker {
    fn drop(&mut self) {
        self.shutdown.cancel();
        self.readiness.clear();

        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BackgroundWorker, JOB_NAMES};
    use crate::{app::AppState, utils::config::WorkerConfig};

    #[tokio::test]
    async fn starts_after_jobs_report_ready() {
        let state = AppState::with_settlement_recipient(JOB_NAMES, None);
        let worker = BackgroundWorker::start_with_executor(
            WorkerConfig {
                runtime_threads: 1,
                max_blocking_threads: 10,
                parallel_job_concurrency: 10,
            },
            state.readiness(),
            None,
        )
        .await
        .expect("start background worker");

        assert!(state.readiness().is_ready());
        worker.shutdown().await;
        assert!(!state.readiness().is_ready());
    }
}
