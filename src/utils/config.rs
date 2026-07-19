use std::{
    env,
    fmt::{Display, Formatter},
    io::ErrorKind,
    net::SocketAddr,
    str::FromStr,
    thread,
    time::Duration,
};

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub logging: LoggingConfig,
    pub http: HttpConfig,
    pub runtime: RuntimeConfig,
    pub worker: WorkerConfig,
}

#[derive(Clone, Debug)]
pub struct LoggingConfig {
    pub filter: String,
    pub format: LogFormat,
}

#[derive(Clone, Copy, Debug)]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Clone, Debug)]
pub struct HttpConfig {
    pub request_timeout: Duration,
    pub max_body_bytes: usize,
    pub max_concurrency: usize,
}

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub http_worker_threads: usize,
    pub http_max_blocking_threads: usize,
}

#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub runtime_threads: usize,
    pub max_blocking_threads: usize,
    pub parallel_job_concurrency: usize,
}

#[derive(Debug)]
pub struct ConfigError(String);

impl Display for ConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        load_dotenv()?;

        let available_cores = thread::available_parallelism()
            .map(|cores| cores.get())
            .unwrap_or(1);
        let parallel_job_concurrency = usize_value("VELA_RELAY_PARALLEL_JOB_CONCURRENCY", 10)?;
        let worker_max_blocking_threads =
            usize_value("VELA_RELAY_WORKER_MAX_BLOCKING_THREADS", 10)?;

        if parallel_job_concurrency > worker_max_blocking_threads {
            return Err(ConfigError(format!(
                "VELA_RELAY_PARALLEL_JOB_CONCURRENCY ({parallel_job_concurrency}) cannot exceed VELA_RELAY_WORKER_MAX_BLOCKING_THREADS ({worker_max_blocking_threads})"
            )));
        }

        Ok(Self {
            listen_addr: value_or("VELA_RELAY_LISTEN_ADDR", "0.0.0.0:4567")?
                .parse()
                .map_err(|error| ConfigError(format!("invalid VELA_RELAY_LISTEN_ADDR: {error}")))?,
            logging: LoggingConfig {
                filter: value_or("RUST_LOG", "vela_relay=info,tower_http=info")?,
                format: value_or("VELA_RELAY_LOG_FORMAT", "pretty")?.parse()?,
            },
            http: HttpConfig {
                request_timeout: Duration::from_secs(u64_value(
                    "VELA_RELAY_HTTP_REQUEST_TIMEOUT_SECS",
                    30,
                )?),
                max_body_bytes: usize_value("VELA_RELAY_HTTP_MAX_BODY_BYTES", 1_048_576)?,
                max_concurrency: usize_value("VELA_RELAY_HTTP_MAX_CONCURRENCY", 256)?,
            },
            runtime: RuntimeConfig {
                http_worker_threads: usize_value(
                    "VELA_RELAY_HTTP_WORKER_THREADS",
                    available_cores,
                )?,
                http_max_blocking_threads: usize_value("VELA_RELAY_HTTP_MAX_BLOCKING_THREADS", 16)?,
            },
            worker: WorkerConfig {
                runtime_threads: usize_value("VELA_RELAY_WORKER_THREADS", 1)?,
                max_blocking_threads: worker_max_blocking_threads,
                parallel_job_concurrency,
            },
        })
    }
}

fn load_dotenv() -> Result<(), ConfigError> {
    match dotenvy::dotenv() {
        Ok(_) => Ok(()),
        Err(dotenvy::Error::Io(error)) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConfigError(format!("could not load .env: {error}"))),
    }
}

impl FromStr for LogFormat {
    type Err = ConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pretty" => Ok(Self::Pretty),
            "json" => Ok(Self::Json),
            _ => Err(ConfigError(format!(
                "invalid VELA_RELAY_LOG_FORMAT `{value}`; expected `pretty` or `json`"
            ))),
        }
    }
}

fn value_or(name: &str, default: &str) -> Result<String, ConfigError> {
    match env::var(name) {
        Ok(value) if value.trim().is_empty() => Err(ConfigError(format!(
            "environment variable {name} cannot be empty"
        ))),
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.into()),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError(format!(
            "environment variable {name} must be valid Unicode"
        ))),
    }
}

fn usize_value(name: &str, default: usize) -> Result<usize, ConfigError> {
    let value = value_or(name, &default.to_string())?;
    let parsed = value
        .parse::<usize>()
        .map_err(|error| ConfigError(format!("invalid {name}: {error}")))?;

    if parsed == 0 {
        return Err(ConfigError(format!(
            "environment variable {name} must be greater than zero"
        )));
    }

    Ok(parsed)
}

fn u64_value(name: &str, default: u64) -> Result<u64, ConfigError> {
    let value = value_or(name, &default.to_string())?;
    let parsed = value
        .parse::<u64>()
        .map_err(|error| ConfigError(format!("invalid {name}: {error}")))?;

    if parsed == 0 {
        return Err(ConfigError(format!(
            "environment variable {name} must be greater than zero"
        )));
    }

    Ok(parsed)
}
