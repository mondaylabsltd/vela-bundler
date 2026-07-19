use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
};
use serde::Serialize;

use crate::app::AppState;

#[derive(Serialize)]
pub struct ServiceInfo {
    name: &'static str,
    status: &'static str,
}

#[derive(Serialize)]
pub struct VersionInfo {
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
pub struct HealthInfo {
    service: &'static str,
    runtime: &'static str,
    status: &'static str,
}

pub async fn index() -> Json<ServiceInfo> {
    Json(ServiceInfo {
        name: env!("CARGO_PKG_NAME"),
        status: "ok",
    })
}

pub async fn liveness() -> StatusCode {
    StatusCode::NO_CONTENT
}

pub async fn health() -> ([(header::HeaderName, &'static str); 1], Json<HealthInfo>) {
    (
        [(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")],
        Json(HealthInfo {
            service: "vela-bundler",
            runtime: "tokio",
            status: "ok",
        }),
    )
}

pub async fn readiness(State(state): State<AppState>) -> StatusCode {
    if state.readiness().is_ready() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

pub async fn version() -> Json<VersionInfo> {
    Json(VersionInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}
