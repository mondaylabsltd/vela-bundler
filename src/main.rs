mod app;
mod gas_price;
mod utils;
mod worker;

use crate::{
    utils::{AppError, config::Config},
    worker::BackgroundWorker,
};
use tokio::net::TcpListener;

fn main() -> Result<(), AppError> {
    let config = Config::from_env()?;
    utils::logging::init(&config.logging)?;
    if let Some(address) = config.settlement_recipient.as_deref() {
        tracing::info!(vault_address = address, "settlement vault initialized");
    }
    let runtime = utils::runtime::build(&config.runtime)?;

    runtime.block_on(run(config))
}

async fn run(config: Config) -> Result<(), AppError> {
    let state = app::AppState::with_settlement_recipient(
        worker::JOB_NAMES,
        config.settlement_recipient.clone(),
    );
    let app = app::router(&config.http, state.clone());
    let listener = TcpListener::bind(config.listen_addr).await?;
    tracing::info!(listen_addr = %config.listen_addr, "HTTP server listening");

    let worker = match BackgroundWorker::start(config.worker, state.readiness()).await {
        Ok(worker) => worker,
        Err(error) => {
            tracing::error!(?error, "background worker failed to start");
            return Err(error);
        }
    };

    match axum::serve(listener, app)
        .with_graceful_shutdown(utils::shutdown::wait_for_signal())
        .await
    {
        Ok(()) => {
            worker.shutdown().await;
            Ok(())
        }
        Err(error) => {
            worker.shutdown().await;
            Err(error.into())
        }
    }
}
