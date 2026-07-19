use tokio::net::TcpListener;

mod app;
mod handlers;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let app = app::router();
    let listener = TcpListener::bind("0.0.0.0:4567").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
