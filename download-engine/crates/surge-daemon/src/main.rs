//! surge-daemon —— orig-hub 下载内核的 Rust sidecar（HTTP REST + SSE）。
//!
//! 对齐 orig-hub `internal/core/api.go` 的真实契约，复刻 Go 守护进程行为；
//! 下载内核用 libsurge（BlockMap + Source 调度），HTTP 源走 reqwest。

mod config;
mod routes;
mod state;
mod status;

use std::sync::Arc;

use axum::Router;
use libsurge::registry::Registry;
use surge_protocol_http::HttpProtocol;
use surge_protocol_virtual::VirtualProtocol;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = Config::load();

    let registry = Registry::new();
    // 虚拟协议（默认，零网络自检）+ 真实 HTTP 协议（reqwest Range 下载）。
    registry.register(Arc::new(VirtualProtocol::new()));
    registry.register(Arc::new(HttpProtocol::new()));

    let (events_tx, _rx) = tokio::sync::broadcast::channel(1024);
    let state = Arc::new(AppState::new(registry, events_tx, config.clone()));

    let app: Router = routes::router(state);

    let port = config.port;
    let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    eprintln!("surge-daemon listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
