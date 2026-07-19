use tokio::runtime::Builder;

use crate::utils::{AppError, config::RuntimeConfig};

pub fn build(config: &RuntimeConfig) -> Result<tokio::runtime::Runtime, AppError> {
    Builder::new_multi_thread()
        .thread_name("vela-http")
        .worker_threads(config.http_worker_threads)
        .max_blocking_threads(config.http_max_blocking_threads)
        .enable_all()
        .build()
        .map_err(Into::into)
}
