use axum::{Router, routing::get};

use crate::handlers::system;

pub fn router() -> Router {
    Router::new()
        .route("/", get(system::index))
        .route("/healthz", get(system::liveness))
        .route("/readyz", get(system::readiness))
        .route("/version", get(system::version))
}
