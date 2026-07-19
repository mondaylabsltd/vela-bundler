use axum::{Json, http::StatusCode};
use serde::Serialize;

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

pub async fn index() -> Json<ServiceInfo> {
    Json(ServiceInfo {
        name: env!("CARGO_PKG_NAME"),
        status: "ok",
    })
}

pub async fn liveness() -> StatusCode {
    StatusCode::NO_CONTENT
}

pub async fn readiness() -> StatusCode {
    StatusCode::NO_CONTENT
}

pub async fn version() -> Json<VersionInfo> {
    Json(VersionInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}
