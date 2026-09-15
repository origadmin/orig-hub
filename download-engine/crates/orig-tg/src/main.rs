#![windows_subsystem = "windows"]

//! orig-tg 可执行入口。

use std::sync::Arc;

use orig_tg::config::Config;
use orig_tg::grammers::GrammersClient;
use orig_tg::login::Client;
use orig_tg::routes;
use orig_tg::state::AppState;

// 骨架阶段：内存客户端（Dummy）。未配置 Telegram api_id/hash 时用于契约自洽。
mod dummy;

/// 选择底层 MTProto 客户端：配置了 api_id/api_hash 用真实 grammers，否则退回内存占位。
/// 返回 `(客户端, api_mode)`；api_mode=`real`|`dummy` 供 `/api/tg/diag` 展示。
async fn build_client(config: &Config) -> (Arc<dyn Client>, &'static str) {
    if config.api_id.is_some() && config.api_hash.is_some() {
        match GrammersClient::connect(config).await {
            Ok(c) => return (Arc::new(c), "real"),
            Err(e) => eprintln!("[warn] grammers connect failed ({e}); falling back to dummy client"),
        }
    } else {
        eprintln!("[warn] ORIG_TG_API_ID/ORIG_TG_API_HASH not set; using in-memory dummy client");
    }
    (Arc::new(dummy::DummyClient::default()), "dummy")
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = Config::load();
    let (client, api_mode) = build_client(&config).await;

    let state = Arc::new(AppState::new(client, config.clone(), api_mode));
    state.push_log(format!(
        "orig-tg start api_mode={api_mode} proxy={:?}",
        config.proxy
    ));

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