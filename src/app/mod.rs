use axum::{
    Router,
    http::StatusCode,
    routing::{get, post},
};
use tower::{ServiceBuilder, limit::ConcurrencyLimitLayer};
use tower_http::{
    catch_panic::CatchPanicLayer,
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
};

mod handlers;
mod rpc;
pub mod state;

pub use state::{AppState, Readiness};

use crate::utils::config::HttpConfig;
use handlers::system;

pub fn router(config: &HttpConfig, state: AppState) -> Router {
    Router::new()
        .route("/", get(system::index))
        .route("/healthz", get(system::liveness))
        .route("/readyz", get(system::readiness))
        .route("/version", get(system::version))
        .route("/{chain_id}/rpc", post(rpc::handle))
        .layer(
            ServiceBuilder::new()
                .layer(CatchPanicLayer::new())
                .layer(
                    TraceLayer::new_for_http()
                        .make_span_with(DefaultMakeSpan::new().level(tracing::Level::INFO))
                        .on_response(DefaultOnResponse::new().level(tracing::Level::INFO)),
                )
                .layer(TimeoutLayer::with_status_code(
                    StatusCode::REQUEST_TIMEOUT,
                    config.request_timeout,
                ))
                .layer(ConcurrencyLimitLayer::new(config.max_concurrency))
                .layer(RequestBodyLimitLayer::new(config.max_body_bytes)),
        )
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::router;
    use crate::{app::AppState, utils::config::HttpConfig};

    fn http_config() -> HttpConfig {
        HttpConfig {
            request_timeout: Duration::from_secs(30),
            max_body_bytes: 1_024,
            max_concurrency: 16,
        }
    }

    #[tokio::test]
    async fn readiness_requires_every_worker_job() {
        let state = AppState::new(&["cleanup", "parallel"]);

        let response = router(&http_config(), state.clone())
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        state.readiness().mark_job_ready("cleanup");
        state.readiness().mark_job_ready("parallel");

        let response = router(&http_config(), state)
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn rejects_requests_with_oversized_content_length() {
        let state = AppState::new(&[]);
        let response = router(&http_config(), state)
            .oneshot(
                Request::get("/")
                    .header("content-length", "1025")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
