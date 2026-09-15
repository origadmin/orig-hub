#![windows_subsystem = "windows"]

//! orig-tg 可执行入口。

use std::sync::Arc;

use orig_tg::config::Config;
use orig_tg::routes;
use orig_tg::state::AppState;

// 骨架阶段：内存客户端（Dummy）。接入 grammers 后由 grammers 客户端替换。
mod dummy;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = Config::load();
    let client = Arc::new(dummy::DummyClient::default());

    let state = Arc::new(AppState::new(client, config.clone()));

    let app = routes::router(state).layer(
        tower_http::cors::CorsLayer::new()
            .allow_origin([
                "http://localhost:5180".parse().unwrap(),
                "http://127.0.0.1:5180".parse().unwrap(),
                "tauri://localhost".parse().unwrap(),
                "http://tauri.localhost".parse().unwrap(),
            ])
            .allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::OPTIONS])
            .allow_headers([
                axum::http::header::HeaderName::from_static("content-type"),
                axum::http::header::HeaderName::from_static("authorization"),
            ])
            .max_age(std::time::Duration::from_secs(3600)),
    );

    let addr: std::net::SocketAddr = format!("{}:{}", config.bind, config.port).parse().unwrap();
    eprintln!("orig-tg listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}