use std::{io, sync::Arc};

use tokio::{sync::oneshot, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{
    app::Readiness,
    worker::{
        USER_OPERATION_CONSUMER_JOB, UserOperationExecution,
        consumer::{
            ChainStream, RELAYER_LANE_COUNT, USER_OPERATION_TOPIC, UserOperationConsumer,
            UserOperationConsumerConfig,
        },
        executor::ExecutorEngine,
    },
};

use super::{JobResult, report_startup};

struct InitializedConsumer {
    consumer: UserOperationConsumer,
    streams: Vec<ChainStream>,
    executor: Arc<ExecutorEngine>,
}

pub async fn run(
    shutdown: CancellationToken,
    ready: Option<oneshot::Sender<JobResult>>,
    readiness: Readiness,
    execution: Option<UserOperationExecution>,
) {
    let Some(execution) = execution else {
        if report_startup(USER_OPERATION_CONSUMER_JOB, ready, &readiness, Ok(())) {
            tracing::info!(
                job = USER_OPERATION_CONSUMER_JOB,
                "UserOperation execution is disabled"
            );
            shutdown.cancelled().await;
        }
        return;
    };

    let initialized = match initialize(execution).await {
        Ok(initialized) => initialized,
        Err(error) => {
            report_startup(USER_OPERATION_CONSUMER_JOB, ready, &readiness, Err(error));
            return;
        }
    };
    if !report_startup(USER_OPERATION_CONSUMER_JOB, ready, &readiness, Ok(())) {
        return;
    }

    run_initialized(initialized, shutdown).await;
}

async fn initialize(
    execution: UserOperationExecution,
) -> Result<InitializedConsumer, crate::utils::AppError> {
    if execution.iggy.topic != USER_OPERATION_TOPIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Iggy executor requires topic `{USER_OPERATION_TOPIC}`, configured `{}`",
                execution.iggy.topic
            ),
        )
        .into());
    }
    if execution.executor.pool_width != usize::from(RELAYER_LANE_COUNT) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("executor relayer count must equal the {RELAYER_LANE_COUNT} Iggy lanes"),
        )
        .into());
    }

    let executor = Arc::new(ExecutorEngine::new(
        execution.executor.clone(),
        execution.store,
    )?);
    let mut consumer_config = UserOperationConsumerConfig::new(execution.iggy.consumer_url.clone());
    consumer_config.consumer_group = format!(
        "{}-user-operations",
        execution
            .executor
            .consumer_group_prefix
            .trim_end_matches('-')
    );
    consumer_config.discovery_interval = execution.executor.stream_discovery_interval;
    consumer_config.empty_poll_interval = execution.executor.idle_poll_interval;
    consumer_config.batch_size = execution.executor.poll_batch_size;

    let consumer = UserOperationConsumer::connect(consumer_config, executor.clone()).await?;
    let streams = consumer.discover_chain_streams().await?;
    let stream_names = streams
        .iter()
        .map(|stream| stream.name.as_str())
        .collect::<Vec<_>>();
    tracing::info!(
        job = USER_OPERATION_CONSUMER_JOB,
        count = stream_names.len(),
        streams = ?stream_names,
        lanes_per_stream = RELAYER_LANE_COUNT,
        treasury = %executor.treasury_address(),
        "UserOperation consumer initialized"
    );

    Ok(InitializedConsumer {
        consumer,
        streams,
        executor,
    })
}

async fn run_initialized(initialized: InitializedConsumer, shutdown: CancellationToken) {
    let job_shutdown = shutdown.child_token();
    let consumer_shutdown = job_shutdown.clone();
    let mut consumer_task = tokio::spawn(
        initialized
            .consumer
            .run_with_discovered_chain_streams(initialized.streams, consumer_shutdown),
    );
    let reconciler_shutdown = job_shutdown.clone();
    let executor = initialized.executor;
    let mut reconciler_task = tokio::spawn(async move {
        executor.run_reconciler(reconciler_shutdown).await;
    });

    tokio::select! {
        consumer_result = &mut consumer_task => {
            job_shutdown.cancel();
            await_companion(reconciler_task, "executor receipt reconciler").await;
            match consumer_result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::error!(
                    job = USER_OPERATION_CONSUMER_JOB,
                    %error,
                    "UserOperation consumer stopped"
                ),
                Err(error) => tracing::error!(
                    job = USER_OPERATION_CONSUMER_JOB,
                    ?error,
                    "UserOperation consumer task panicked"
                ),
            }
        }
        reconciler_result = &mut reconciler_task => {
            job_shutdown.cancel();
            await_companion(consumer_task, "Iggy UserOperation consumer").await;
            if !shutdown.is_cancelled() {
                match reconciler_result {
                    Ok(()) => tracing::warn!(
                        job = USER_OPERATION_CONSUMER_JOB,
                        "executor receipt reconciler stopped unexpectedly"
                    ),
                    Err(error) => tracing::error!(
                        job = USER_OPERATION_CONSUMER_JOB,
                        ?error,
                        "executor receipt reconciler panicked"
                    ),
                }
            }
        }
    }
}

async fn await_companion<T>(task: JoinHandle<T>, component: &'static str) {
    if let Err(error) = task.await {
        tracing::warn!(
            job = USER_OPERATION_CONSUMER_JOB,
            component,
            ?error,
            "UserOperation worker companion task stopped unexpectedly"
        );
    }
}
