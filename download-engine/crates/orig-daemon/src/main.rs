#![windows_subsystem = "windows"]

//! orig-daemon —— orig-hub 下载内核的 Rust sidecar（HTTP REST + SSE）。
//!
//! 对齐 orig-hub `internal/core/api.go` 的真实契约，复刻 Go 守护进程行为；
//! 下载内核用 orig-core（BlockMap + Source 调度），HTTP 源走 reqwest。

mod activity;
mod config;
mod routes;
mod state;
mod status;

use std::sync::Arc;

use axum::Router;
use orig_core::registry::Registry;
use orig_protocol_http::HttpProtocol;
use orig_protocol_virtual::VirtualProtocol;

use crate::config::Config;
use crate::state::{select_bindable_port, write_daemon_endpoint, AppState};

/// 绑定监听端口：首选配置端口，**绑不上就顺延**（BUG-178）。
///
/// 为什么不能 `bind(addr).unwrap()`：本机 9876 可能落在 Windows 动态保留区
/// （`netsh int ipv4 show excludedportrange tcp`），bind 恒 `WSAEACCES` 10013。
/// 旧实现直接 panic 退出 → daemon 起不来 → 整个 APP 没有后端；而用户看到的是
/// 「TG 不显示 / 数据没了」，根因被埋在 panic 里。顺延后把实际端口写进端点文件
/// 并经 `/api/config` 下发，壳与前端都读真源。
async fn bind_with_fallback(preferred: u16) -> (tokio::net::TcpListener, u16) {
    match tokio::net::TcpListener::bind(("127.0.0.1", preferred)).await {
        Ok(l) => (l, preferred),
        Err(e) => {
            eprintln!(
                "[daemon] bind 127.0.0.1:{preferred} failed ({e}); scanning for a bindable port"
            );
            match select_bindable_port(preferred).await {
                Some(p) => match tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
                    Ok(l) => (l, p),
                    Err(e) => panic!("bind 127.0.0.1:{p} failed after scan: {e}"),
                },
                None => panic!("no bindable port found starting from {preferred}"),
            }
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = Config::load();

    let registry = Registry::new();
    // 虚拟协议（默认，零网络自检）+ 真实 HTTP 协议（reqwest Range 下载）。
    registry.register(Arc::new(VirtualProtocol::new()));
    registry.register(Arc::new(HttpProtocol::new()));

    let (events_tx, _rx) = tokio::sync::broadcast::channel(1024);
    // 先定端口再建 state：端口是 state 的字段，`/api/config` 与端点文件都从它取，
    // 不允许出现「配置文件写 9876、实际监听 9878」的两套真源。
    let (listener, port) = bind_with_fallback(config.port).await;
    eprintln!(
        "orig-daemon listening on http://127.0.0.1:{port}{}",
        if port == config.port {
            String::new()
        } else {
            format!(" (configured {} was unavailable)", config.port)
        }
    );
    write_daemon_endpoint(port);
    let state = Arc::new(AppState::new(port, registry, events_tx, config.clone()));

    // TG 可选插件：启动时按配置拉起 orig-tg 子进程（注入主配置代理）。
    if config.tg_enabled {
        match state.tg_start().await {
            Ok(_) => eprintln!("orig-tg plugin started"),
            // BUG-177：拉起失败必须**留痕**（原因已进 `tg_last_error`，设置页可见）。
            // 这里不退出进程：下载内核与 daemon 本身仍然可用，只是 TG 模块不显示。
            Err(e) => eprintln!("failed to start orig-tg plugin: {e}"),
        }
    }
    // TG 托管巡检：daemon 是 orig-tg 的唯一所有者，开启却没在服务要自愈。
    // 与上面这一次性拉起互补 —— 后者覆盖启动瞬间，前者覆盖运行期崩溃/退出。
    {
        let st = state.clone();
        tokio::spawn(async move { st.tg_supervise().await });
    }

    let app: Router = routes::router(state).layer(
        // CORS：允许 Tauri WebView（dev vite 5180 / 生产 tauri://localhost）跨域访问
        tower_http::cors::CorsLayer::new()
            .allow_origin([
                "http://localhost:5180".parse().unwrap(),
                "http://127.0.0.1:5180".parse().unwrap(),
                "http://localhost:1420".parse().unwrap(),
                "http://127.0.0.1:1420".parse().unwrap(),
                "tauri://localhost".parse().unwrap(),
                "http://tauri.localhost".parse().unwrap(),
                "https://tauri.localhost".parse().unwrap(),
            ])
            .allow_methods([
                axum::http::Method::GET,
                axum::http::Method::POST,
                axum::http::Method::PUT,
                axum::http::Method::DELETE,
                axum::http::Method::OPTIONS,
            ])
            .allow_headers([
                axum::http::header::HeaderName::from_static("content-type"),
                axum::http::header::HeaderName::from_static("authorization"),
            ])
            .max_age(std::time::Duration::from_secs(3600)),
    );

    axum::serve(listener, app).await.unwrap();
}
