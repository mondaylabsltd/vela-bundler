mod cleanup;
mod parallel;
mod sync;

use std::{future::Future, time::Duration};

use tokio::{runtime::Runtime, sync::oneshot, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{app::Readiness, utils::AppError};

pub type JobResult = Result<(), AppError>;

const RESTART_DELAY: Duration = Duration::from_secs(5);

pub(super) struct JobStartup {
    pub(super) name: &'static str,
    pub(super) ready: oneshot::Receiver<JobResult>,
    pub(super) task: JoinHandle<()>,
}

pub fn start(
    runtime: &Runtime,
    shutdown: CancellationToken,
    parallel_job_concurrency: usize,
    readiness: Readiness,
) -> Vec<JobStartup> {
    let cleanup_readiness = readiness.clone();
    let parallel_readiness = readiness.clone();
    let sync_readiness = readiness.clone();

    vec![
        spawn_job(
            runtime,
            "cleanup",
            shutdown.clone(),
            readiness.clone(),
            move |shutdown, ready| cleanup::run(shutdown, ready, cleanup_readiness.clone()),
        ),
        spawn_job(
            runtime,
            "parallel",
            shutdown.clone(),
            readiness.clone(),
            move |shutdown, ready| {
                parallel::run(
                    shutdown,
                    ready,
                    parallel_readiness.clone(),
                    parallel_job_concurrency,
                )
            },
        ),
        spawn_job(
            runtime,
            "sync",
            shutdown,
            readiness.clone(),
            move |shutdown, ready| sync::run(shutdown, ready, sync_readiness.clone()),
        ),
    ]
}

pub(super) fn report_startup(
    job: &'static str,
    ready: Option<oneshot::Sender<JobResult>>,
    readiness: &Readiness,
    result: JobResult,
) -> bool {
    match result {
        Ok(()) => {
            readiness.mark_job_ready(job);
            if let Some(ready) = ready {
                let _ = ready.send(Ok(()));
            }
            true
        }
        Err(error) => {
            readiness.mark_job_unready(job);
            tracing::error!(job, %error, "background job initialization failed");
            if let Some(ready) = ready {
                let _ = ready.send(Err(error));
            }
            false
        }
    }
}

fn spawn_job<F, Fut>(
    runtime: &Runtime,
    name: &'static str,
    shutdown: CancellationToken,
    readiness: Readiness,
    run: F,
) -> JobStartup
where
    F: Fn(CancellationToken, Option<oneshot::Sender<JobResult>>) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let (ready_tx, ready) = oneshot::channel();
    let task = runtime.spawn(supervise(name, shutdown, readiness, ready_tx, run));

    JobStartup { name, ready, task }
}

async fn supervise<F, Fut>(
    name: &'static str,
    shutdown: CancellationToken,
    readiness: Readiness,
    ready: oneshot::Sender<JobResult>,
    run: F,
) where
    F: Fn(CancellationToken, Option<oneshot::Sender<JobResult>>) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let mut ready = Some(ready);

    loop {
        let task = tokio::spawn(run(shutdown.clone(), ready.take()));

        match task.await {
            Ok(()) if shutdown.is_cancelled() => {
                readiness.mark_job_unready(name);
                tracing::info!(job = name, "background job stopped");
                return;
            }
            Ok(()) => {
                readiness.mark_job_unready(name);
                tracing::warn!(job = name, "background job stopped; restarting");
            }
            Err(error) => {
                readiness.mark_job_unready(name);
                tracing::error!(job = name, ?error, "background job panicked; restarting")
            }
        }

        tokio::select! {
            _ = shutdown.cancelled() => {
                readiness.mark_job_unready(name);
                tracing::info!(job = name, "background job stopped");
                return;
            }
            _ = tokio::time::sleep(RESTART_DELAY) => {}
        }
    }
}
