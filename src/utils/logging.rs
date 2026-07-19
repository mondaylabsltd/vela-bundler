use tracing_subscriber::{EnvFilter, fmt};

use crate::utils::{
    AppError,
    config::{LogFormat, LoggingConfig},
};

pub fn init(config: &LoggingConfig) -> Result<(), AppError> {
    let filter = EnvFilter::try_new(&config.filter)?;

    match config.format {
        LogFormat::Pretty => fmt()
            .with_env_filter(filter)
            .with_thread_ids(true)
            .with_thread_names(true)
            .try_init()?,
        LogFormat::Json => fmt()
            .json()
            .with_current_span(true)
            .with_span_list(true)
            .with_env_filter(filter)
            .with_thread_ids(true)
            .with_thread_names(true)
            .try_init()?,
    }

    Ok(())
}
