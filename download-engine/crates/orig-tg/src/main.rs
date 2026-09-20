#![windows_subsystem = "windows"]

//! orig-tg 可执行入口。
//!
//! ## 可用性契约（BUG-023 后确立）
//!
//! 本服务只有两种结局，**没有第三态**：
//!
//! 1. 真实客户端就绪 → 正常提供服务；
//! 2. 不可用（凭证缺失 / MTProto 连接失败）→ 挂载
//!    [`orig_tg::unavailable::UnavailableClient`]，所有 TG 能力返回 503 + 原因。
//!
//! 曾经存在的第三态是「连不上就换一个**会说谎**的假客户端继续对外服务」：接口照常 200，
//! 前端只看到「未登录 / 发不出验证码」，一次连接故障被读成登录态丢失。已彻底移除。
//!
//! 测试 mock 被 `#[cfg(feature = "mock")]` 编译排除于生产构建之外，且需 `ORIG_TG_MOCK=1`
//! 与显式 `ORIG_TG_DB` 才会被选中 —— 失败路径永不回退到它。
//!
//! ## 调试期离线短路（非 Release 网页调试）
//!
//! 只要本地媒体库（`/api/media/*`，与 TG 客户端无关）就能驱动整页 UI 联调，
//! 此时去连 MTProto 只为换来一个 503 + 启动噪声。因此 **非 Release 构建默认跳过
//! `GrammersClient::connect`**：服务以「本地媒体库可用、TG 端点诚实 503」启动，
//! 不发起任何 Telegram 网络请求。Release 构建默认走真实连接。
//!
//! 显式开关覆盖默认值：
//! - `ORIG_TG_OFFLINE=1`：强制离线（任意 profile，CI / 纯前端联调用）。
//! - `ORIG_TG_ONLINE=1`：强制在线（debug 下想联调真实 TG 登录/授权时用）。

use std::sync::Arc;

use orig_tg::config::Config;
use orig_tg::grammers::GrammersClient;
use orig_tg::login::Client;
use orig_tg::routes;
use orig_tg::state::{AppState, Availability};
use orig_tg::unavailable::UnavailableClient;

/// 端口占用（最常见启动失败）的退出码：显式退出而非 panic，便于脚本/运维判断。
const EXIT_BIND_FAILED: i32 = 3;
/// mock 配置非法（未隔离库）退出码。
#[cfg(feature = "mock")]
const EXIT_BAD_MOCK_CONFIG: i32 = 4;
/// 存储库打开失败（schema 迁移错误 / 文件被占用）退出码。
///
/// 与 `build_client` 的「不存在静默降级」同一原则：库打不开就**不能**回落成空库假装可用。
/// 曾经的 `:memory:` 兜底会让「schema 迁移写错」与「用户数据全没了」在 UI 上长得一模一样，
/// 排查成本极高（BUG-031 即因此浪费了一轮定位）。
const EXIT_STORE_FAILED: i32 = 5;

/// 选择底层客户端。返回 `(客户端, 可用性, 是否 mock)`。
///
/// **不存在静默降级**：凭证齐全但连接失败时，不会换客户端假装正常，而是明确标记不可用
/// 并携带原因；未配置凭证同样标记不可用（并提示先绑定账号）。
async fn build_client(config: &Config) -> (Arc<dyn Client>, Availability, bool) {
    // 调试期离线短路：见文件头注释。非 Release 默认不连 MTProto，仅本地媒体库可用。
    if offline_short_circuit() {
        let reason = "offline debug mode: MTProto connect skipped (set ORIG_TG_ONLINE=1 to force real TG)".to_string();
        eprintln!("[info] {reason}; serving local media library, TG endpoints return 503");
        return (
            Arc::new(UnavailableClient::new(reason.clone())),
            Availability::Unavailable(reason),
            false,
        );
    }

    let configured = config.api_id.is_some() && config.api_hash.is_some();

    if configured {
        return match GrammersClient::connect(config).await {
            Ok(c) => (Arc::new(c), Availability::Ready, false),
            Err(e) => {
                let reason = format!("MTProto connect failed: {e}");
                eprintln!("[error] {reason}; serving TG endpoints as 503 (unavailable)");
                (
                    Arc::new(UnavailableClient::new(reason.clone())),
                    Availability::Unavailable(reason),
                    false,
                )
            }
        };
    }

    // 未配置凭证：仅测试构建（`--features mock`）可显式启用合成客户端。
    #[cfg(feature = "mock")]
    if mock_requested() {
        eprintln!("[warn] ORIG_TG_MOCK=1: using SYNTHETIC mock client (test build only)");
        return (
            Arc::new(orig_tg::mock::MockClient::default()),
            Availability::Ready,
            true,
        );
    }

    let reason = "api_id/api_hash not configured; bind a Telegram account first".to_string();
    (
        Arc::new(UnavailableClient::new(reason.clone())),
        Availability::Unavailable(reason),
        false,
    )
}

/// 是否显式请求 API mock（仅 `--features mock` 构建下编译）。
#[cfg(feature = "mock")]
fn mock_requested() -> bool {
    std::env::var("ORIG_TG_MOCK")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// 调试期离线短路判定。
///
/// - `ORIG_TG_OFFLINE=1` 强制离线（任意 profile，CI / 纯前端联调）。
/// - `ORIG_TG_ONLINE=1` 强制在线（debug 下想联调真实 TG 登录/授权）。
/// - 两者均未设时：**非 Release（`debug_assertions`）默认离线**，Release 默认在线。
///
/// 离线 = 跳过 `GrammersClient::connect`，不发起任何 Telegram 网络请求；
/// 本地媒体库照常可用，TG 端点仍诚实返回 503（BUG-023 契约不变）。
fn offline_short_circuit() -> bool {
    if std::env::var("ORIG_TG_OFFLINE")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        return true;
    }
    if std::env::var("ORIG_TG_ONLINE")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        return false;
    }
    cfg!(debug_assertions)
}

/// mock 模式强制要求显式 `ORIG_TG_DB`。
///
/// mock 会合成频道与消息并写入库中；若落在真实 `tg_store.db` 上，就会凭空多出
/// 永不存在的频道与消息（幽灵数据），且与真实会话混在一起难以清理。
/// 把「别弄脏真实库」从口头约定变成启动期硬约束。
#[cfg(feature = "mock")]
fn ensure_isolated_db() -> Result<(), String> {
    match std::env::var("ORIG_TG_DB") {
        Ok(v) if !v.trim().is_empty() => Ok(()),
        _ => Err(
            "ORIG_TG_MOCK=1 requires an explicit ORIG_TG_DB so mock data cannot touch the real store"
                .to_string(),
        ),
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    #[cfg(feature = "mock")]
    if mock_requested() {
        if let Err(e) = ensure_isolated_db() {
            eprintln!("[fatal] {e}");
            std::process::exit(EXIT_BAD_MOCK_CONFIG);
        }
    }

    let config = Config::load();
    let (client, availability, mock) = build_client(&config).await;

    // 打开存储；失败即致命退出（见 `EXIT_STORE_FAILED` 注释），不做空库兜底。
    let store = match orig_tg::store::Store::open(&config.db_path).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "[fatal] open store {} failed: {e}",
                config.db_path.display()
            );
            std::process::exit(EXIT_STORE_FAILED);
        }
    };

    let state = Arc::new(AppState::new(client, config.clone(), availability.clone(), mock, store));

    // 僵尸缓存任务降级（BUG-024）：进程被杀/崩溃时残留的 queued/running 永远等不到 worker，
    // 必须显式标成 interrupted，否则前端会显示一个永不推进的「缓存中」假状态。
    match state.store.mark_stale_cache_tasks().await {
        Ok(n) if n > 0 => {
            state.push_log(format!("cache tasks: {n} stale task(s) marked interrupted"));
        }
        Ok(_) => {}
        Err(e) => eprintln!("[warn] mark stale cache tasks failed: {e}"),
    }
    // 首份读快照：服务启动即有数据，避免首个 GET 返回空列表。
    state.refresh_cache_tasks().await;

    // 后台监控只在 TG 可用时启动：不可用时它只会周期性失败刷日志，没有意义。
    // mock 构建照常启动（它同样是「可用」态），否则合成夹具的喂数行为会与生产路径分叉，
    // 让验收覆盖不到真实链路。
    if availability.is_ready() {
        orig_tg::monitor::spawn(state.clone());
    } else {
        state.push_log("monitor not started: telegram unavailable");
    }

    state.push_log(format!(
        "orig-tg start mode={} mock={mock} proxy={:?}",
        availability.label(),
        config.proxy
    ));
    if let Some(r) = availability.reason() {
        // 原因必须同时进环形日志：前端 `/api/tg/logs` 与 diag 都能读到，不必翻进程输出。
        state.push_log(format!("telegram unavailable: {r}"));
    }

    // 持久化会话恢复后通常已处于 Authorized：延迟 2s 触发首次后台全量会话扫描，
    // 提前填充 dialog_cache 与 PeerRef 缓存，前端首开面板即读本地缓存、媒体请求秒解析。
    if availability.is_ready() {
        let st = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if st.client.view().await.phase == orig_tg::login::LoginPhase::Authorized {
                routes::spawn_dialog_scan(st);
            }
        });
    }

    // CORS 允许来源：内置开发壳/桌面壳来源 + 环境变量追加。
    //
    // 为什么需要可追加：前端的 `request()` 对**所有**请求都带 `Content-Type: application/json`
    // （含 GET），因此 GET 也**不是**简单请求、会先发 OPTIONS 预检。若来源不在白名单，
    // 预检被拒 → `GET /api/tg/session` 失败 → 前端按「服务不可达」判为未绑定 → Telegram 入口
    // 整个消失（不是「未登录」提示，而是入口不见了），排查时极易误判为登录态丢失。
    // 允许 `ORIG_TG_EXTRA_ORIGINS`（逗号分隔）追加，使隔离端口验收/自定义前端部署无需改代码。
    let mut origins: Vec<axum::http::HeaderValue> = [
        "http://localhost:5180",
        "http://127.0.0.1:5180",
        "tauri://localhost",
        "http://tauri.localhost",
    ]
    .iter()
    .filter_map(|s| s.parse().ok())
    .collect();
    if let Ok(extra) = std::env::var("ORIG_TG_EXTRA_ORIGINS") {
        for o in extra.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            match o.parse::<axum::http::HeaderValue>() {
                Ok(v) => origins.push(v),
                Err(_) => eprintln!("ignore invalid CORS origin: {o}"),
            }
        }
    }

    let app = routes::router(state).layer(
        tower_http::cors::CorsLayer::new()
            .allow_origin(origins)
            // 媒体资料库用到 PATCH（改标题/封面/剧集元数据）与 PUT（重设标签集合）；
            // 缺任一项会让浏览器的 CORS 预检失败，前端表现为「保存静默不生效」。
            .allow_methods([
                axum::http::Method::GET,
                axum::http::Method::POST,
                axum::http::Method::PUT,
                axum::http::Method::PATCH,
                axum::http::Method::DELETE,
                axum::http::Method::OPTIONS,
            ])
            .allow_headers([
                axum::http::header::HeaderName::from_static("content-type"),
                axum::http::header::HeaderName::from_static("authorization"),
            ])
            .max_age(std::time::Duration::from_secs(3600)),
    );

    let addr: std::net::SocketAddr = match format!("{}:{}", config.bind, config.port).parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[fatal] invalid bind address {}/{}: {e}", config.bind, config.port);
            std::process::exit(EXIT_BIND_FAILED);
        }
    };

    // bind 成功之后才宣告 listening。
    // 此前日志打在 bind **之前**：端口被占用时仍打印 "listening on http://..." 后 panic，
    // 把排查引向「服务已起但接口 404」的错方向（BUG-023 的直接误导源）。
    // 端口占用不再 `unwrap()` panic，而是给出确定退出码。
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[fatal] orig-tg bind {addr} failed: {e}");
            std::process::exit(EXIT_BIND_FAILED);
        }
    };
    eprintln!(
        "orig-tg listening on http://{addr} (mode={} mock={mock})",
        availability.label()
    );

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[fatal] server error: {e}");
        std::process::exit(1);
    }
}
