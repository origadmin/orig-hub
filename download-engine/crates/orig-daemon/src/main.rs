#![windows_subsystem = "windows"]

//! orig-daemon —— orig-hub 下载内核的 Rust sidecar（HTTP REST + SSE）。
//!
//! 对齐 orig-hub `internal/core/api.go` 的真实契约，复刻 Go 守护进程行为；
//! 下载内核用 orig-core（BlockMap + Source 调度），HTTP 源走 reqwest。

mod activity;
mod config;
mod files;
mod fsbrowse;
mod routes;
mod state;
mod status;
mod task_store;

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
async fn bind_with_fallback(host: &str, preferred: u16) -> (tokio::net::TcpListener, u16) {
    match tokio::net::TcpListener::bind((host, preferred)).await {
        Ok(l) => (l, preferred),
        Err(e) => {
            eprintln!(
                "[daemon] bind {host}:{preferred} failed ({e}); scanning for a bindable port"
            );
            match select_bindable_port(preferred).await {
                Some(p) => match tokio::net::TcpListener::bind((host, p)).await {
                    Ok(l) => (l, p),
                    Err(e) => panic!("bind {host}:{p} failed after scan: {e}"),
                },
                None => panic!("no bindable port found starting from {preferred}"),
            }
        }
    }
}

/// 是否绑定到非回环地址（对外暴露）。`0.0.0.0`/具体网卡 IP 都算。
fn is_non_loopback(host: &str) -> bool {
    host != "127.0.0.1" && host != "localhost" && host != "::1" && host != "0:0:0:0:0:0:0:1"
}

/// 构造 CORS 层：未显式配置源时回退桌面端默认白名单（vite/tauri）；远程部署用
/// `ORIG_CORS_ORIGINS` 显式放行管理端源。始终放行 `content-type` 与 `authorization`。
fn build_cors(cfg: &Config) -> tower_http::cors::CorsLayer {
    use axum::http::{HeaderValue, Method};
    let base = tower_http::cors::CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::HeaderName::from_static("content-type"),
            axum::http::header::HeaderName::from_static("authorization"),
        ])
        .max_age(std::time::Duration::from_secs(3600));
    if cfg.cors_origins.is_empty() {
        let origins: Vec<HeaderValue> = vec![
            "http://localhost:5180".parse().unwrap(),
            "http://127.0.0.1:5180".parse().unwrap(),
            "http://localhost:1420".parse().unwrap(),
            "http://127.0.0.1:1420".parse().unwrap(),
            "tauri://localhost".parse().unwrap(),
            "http://tauri.localhost".parse().unwrap(),
            "https://tauri.localhost".parse().unwrap(),
        ];
        base.allow_origin(origins)
    } else {
        let origins: Vec<HeaderValue> = cfg
            .cors_origins
            .iter()
            .filter_map(|o| HeaderValue::from_str(o).ok())
            .collect();
        if origins.is_empty() {
            base
        } else {
            base.allow_origin(origins)
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = Config::load();

    // 绑定到非回环地址（容器/远程部署常见）时，若未配置 token 仅告警不阻断：
    // 本地 docker / 私网部署通常不需要鉴权，强制 token 反而阻碍启动。
    // 若要公网暴露，请设置 SURGE_TOKEN（或 ORIG_DAEMON_TOKEN）。
    if is_non_loopback(&config.host) && config.token.is_none() {
        eprintln!(
            "[daemon] WARNING: binding {} without a token; anyone on the network can manage \
             downloads. Set SURGE_TOKEN to require Bearer auth.",
            config.host
        );
    }

    let registry = Registry::new();
    // 虚拟协议（默认，零网络自检）+ 真实 HTTP 协议（reqwest Range 下载）。
    registry.register(Arc::new(VirtualProtocol::new()));
    registry.register(Arc::new(HttpProtocol::new()));

    let (events_tx, _rx) = tokio::sync::broadcast::channel(1024);
    // 先定端口再建 state：端口是 state 的字段，`/api/config` 与端点文件都从它取，
    // 不允许出现「配置文件写 9876、实际监听 9878」的两套真源。
    let (listener, port) = bind_with_fallback(&config.host, config.port).await;
    eprintln!(
        "orig-daemon listening on http://127.0.0.1:{port}{}",
        if port == config.port {
            String::new()
        } else {
            format!(" (configured {} was unavailable)", config.port)
        }
    );
    write_daemon_endpoint(port);
    // BUG-319：引擎任务的记录真源。打开失败只降级（下载照跑、记录会丢），
    // 绝不阻断启动 —— 与「日志不影响主流程」同一口径。
    let store = crate::task_store::TaskStore::open(&crate::state::tg_data_dir()).await;
    if store.is_none() {
        eprintln!(
            "[daemon] engine task store unavailable; download records will NOT survive a restart"
        );
    }
    let state = Arc::new(AppState::new(
        port,
        registry,
        events_tx,
        config.clone(),
        store.map(Arc::new),
    ));

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

    // BUG-319 启动恢复：把上次进程留下的未完成行重新入队；入队失败的行以
    // 「已中断」的真相留在列表里（记录不丢、也不假装还在跑）。
    //
    // 走 spawn 而非直接 await：恢复要对每个 URL 做一次探测（网络往返），
    // 卡在启动路径上会让整个 daemon 的就绪时间被源站响应时间决定。
    {
        let st = state.clone();
        tokio::spawn(async move { routes::recover_engine_tasks(&st).await });
    }

    // CORS：桌面端用内置白名单；远程/容器部署经 ORIG_CORS_ORIGINS 显式放行管理端源。
    // 注意：`router` 消费 `Arc<AppState>`，这里传 clone，保留 `state` 给下方优雅停机闭包。
    let app: Router = routes::router(state.clone()).layer(build_cors(&config));

    // 生命周期提示（daemon 是 windows_subsystem，无控制台 —— 落文件 + 控制台双写）：
    // 明确告诉用户「启动了什么、归谁管、怎么停、怎么更新」，对应「启动内容要有明确提示」。
    let pid = std::process::id();
    let banner = format!(
        "[orig-daemon] pid={pid} listening on http://127.0.0.1:{port} \
         | TG plugin auto-managed (orig-tg child is auto-restarted if it exits) \
         | shutdown: kill this process (orig-tg child stops with it) \
         | update orig-tg: write redeploy signals via dev_services.py (do NOT kill this process)"
    );
    eprintln!("{banner}");
    crate::state::daemon_log(&format!(
        "daemon started pid={pid} listening on 127.0.0.1:{port}; TG plugin auto-managed; \
         for updates write redeploy signals (see dev_services.py); to stop, kill this process"
    ));
    // 启动即清理上次可能遗留的握手信号，避免 AI 崩溃导致一开机就停 tg 卡死。
    crate::state::clear_stale_redeploy_signals();

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        eprintln!("[orig-daemon] shutdown signal received — stopping orig-tg child and exiting");
        crate::state::daemon_log("daemon shutting down — stopping orig-tg child");
        state.tg_stop().await;
    };
    tokio::select! {
        _ = axum::serve(listener, app) => {}
        _ = shutdown => {}
    }
}
