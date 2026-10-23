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
//! ## 离线模式（BUG-179 重定语义）
//!
//! 旧设计：非 Release 构建默认跳过 `GrammersClient::connect`（"调试期离线短路"）。
//! 用户规范（2026-09-29）推翻了它：**调试模式下 TG 与媒体库服务也必须正常** ——
//! 调试构建与生产构建是同一个产品，不该有第二套可用性语义。旧默认的实际效果是
//! 调试启动时本地有 516 条频道缓存、服务却对所有 TG 数据端点诚实 503，
//! 「数据在库里、用户看不到」—— 诚实被做成了残废。
//!
//! 现行规则：
//! - **默认在线**（所有构建一致）：凭证齐全就连 MTProto，连不上如实 503。
//! - `ORIG_TG_OFFLINE=1`：显式离线（CI / 端口隔离验收 / 纯前端联调需要确定性时用），
//!   离线只跳过 MTProto 连接，**本地已落库的数据照常服务**（见 `routes.rs` 的
//!   cache-first 端点）。
//! - `ORIG_TG_ONLINE=1`：兼容保留，现在与默认行为一致。

use std::sync::Arc;

use orig_tg::config::Config;
use orig_tg::grammers::GrammersClient;
use orig_tg::login::Client;
use orig_tg::routes;
use orig_tg::routes::configure_delivery_loopback_only;
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
    // 显式离线（`ORIG_TG_OFFLINE=1`）：跳过 MTProto 连接，本地媒体库照常可用，
    // TG 端点里 cache-first 的那些（dialogs 等）仍会服务本地已落库数据（BUG-179）。
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

/// 离线模式判定（BUG-179）。
///
/// - `ORIG_TG_OFFLINE=1` 显式离线（CI / 端口隔离验收 / 纯前端联调）。
/// - **默认在线**：调试模式必须与生产同一套可用性语义（用户规范 2026-09-29）。
///   旧的「非 Release 默认离线」让调试启动永远 503，本地缓存数据无法服务，
///   已按新规范移除 —— `debug_assertions` 不再参与可用性判定。
/// - `ORIG_TG_ONLINE=1` 兼容保留：与默认行为一致，仅作显式声明。
///
/// 离线 = 跳过 `GrammersClient::connect`，不发起任何 Telegram 网络请求；
/// 本地媒体库照常可用，cache-first 的 TG 端点服务本地已落库数据（BUG-023 契约不变）。
fn offline_short_circuit() -> bool {
    std::env::var("ORIG_TG_OFFLINE")
        .map(|v| v == "1")
        .unwrap_or(false)
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
    // 投递节流按 bind 是否环回切换（BUG-199）：仅本机 → 不限速；非环回 → 启用 BUG-033 抑风暴。
    configure_delivery_loopback_only(
        config
            .bind
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(true),
    );
    // 先占端口，再连 Telegram（BUG-227）。
    //
    // 为什么顺序要紧：daemon 判定「起来没起来」用的是 **TCP 能否连上本端口**
    // （`orig-daemon/src/state.rs::tg_port_has_listener`），而它的等待窗口原为 5s；
    // 而 orig-tg 原来把 bind 放在 MTProto 之后 —— 「到开始监听」的耗时于是等于
    // **网络登录耗时**（实测 5.10 s / 6.96 s，随代理链路抖动），恰好把窗口顶穿，
    // daemon 于是把一个本可成功的进程判死并 kill，用户看到「TG 服务未能启动，模块已隐藏」。
    // 端口与登录是两件事：端口先归我们所有，登录慢只影响 `/api/tg/*` 的可用性
    // （`Availability::Unavailable` → 503），不该反过来把服务本身判成起不来。
    // 先 bind 期间到达的连接排在 backlog 里，等 `axum::serve` 起来照常处理，不丢请求。
    let addr: std::net::SocketAddr = match format!("{}:{}", config.bind, config.port).parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[fatal] invalid bind address {}/{}: {e}", config.bind, config.port);
            std::process::exit(EXIT_BIND_FAILED);
        }
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[fatal] orig-tg bind {addr} failed: {e}");
            std::process::exit(EXIT_BIND_FAILED);
        }
    };
    eprintln!("orig-tg bound {addr} (TCP listening; telegram connect follows)");

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

    // 2026-10-21 用户裁定「内部文件不入治理」：库根搬进引擎工作区 `.orighub/`，
    // 下载根顶层只留用户内容 —— 这样成品扫描只需排 `.` 开头就是结构性正确，
    // 不再靠 `library`/`.orighub` 名字白名单兜底（白名单必漏）。
    // 必须排在下面那次「顶层普通文件 → legacy-downloads」迁移之前。
    {
        let root = state.store.download_root().await;
        orig_tg::store::Store::migrate_library_into_engine_dir(&root);
    }

    // BUG-421：旧库根搬迁的**行级补漏**。上一步只搬目录，行的 `file_path` 由受管根
    // 迁移改写 —— 实测漏了 72 条（文件已在新根下，行还指着旧根）。漏一条就是一条
    // 永远播不了的条目，且 BUG-420 的回填会把它判成「文件不存在」而跳过。
    // 必须排在上面的目录搬迁之后（否则新根还不存在，无从判定目标）。
    match state.store.repair_old_library_root_rows().await {
        Ok((fixed, skipped)) if fixed > 0 || skipped > 0 => {
            let msg = format!(
                "BUG-421 legacy library-root rows repaired: {fixed} rewritten, {skipped} kept \
                 (target file missing — those really have no bytes)"
            );
            println!("[tg] {msg}");
            state.push_log(msg);
        }
        Ok(_) => {}
        Err(e) => {
            let msg = format!("[warn] BUG-421 legacy library-root row repair failed: {e}");
            eprintln!("{msg}");
            state.push_log(msg);
        }
    }

    // BUG-323：存量受管根迁移（引擎写过的旧落点 → 下载路径之内）。
    //
    // 库根改为派生值后不迁移 = 存量字节整片失联：库根相对路径的条目在新根下
    // 解析不到，绝对路径的条目被权限闸门 403。旧落点有两处：旧库根（应用内部目录）
    // 与**旧默认下载目录** `<TG 数据目录>/downloads`（实测 33 个文件 / 3.5 GB）。
    // 迁移**只移动不覆盖**，失败不阻断启动（源字节仍在原处，下次启动重试）。
    match state.store.migrate_legacy_managed_roots().await {
        Ok(Some(m)) => {
            for r in &m.roots {
                let msg = format!(
                    "legacy root migrated ({}): {} -> {} (moved {} top-level item(s), \
                     skipped {}, rewritten {} row(s))",
                    r.name, r.from, r.to, r.moved, r.skipped, r.rewritten
                );
                println!("[tg] {msg}");
                state.push_log(msg);
            }
            // 迁移回执落盘（只读线索，不删任何东西）：便于事后核对搬了什么。
            if let Ok(json) = serde_json::to_string_pretty(&m) {
                let _ = std::fs::write(state.store.data_dir().join("legacy-roots-migration.json"), json);
            }
            if m.skipped() > 0 {
                state.push_log(format!(
                    "[warn] {} top-level item(s) skipped while migrating legacy roots: \
                     same name already exists at the new root (nothing was overwritten)",
                    m.skipped()
                ));
            }
        }
        Ok(None) => {}
        Err(e) => {
            let msg = format!("[warn] legacy managed-root migration failed: {e}");
            eprintln!("{msg}");
            state.push_log(msg);
        }
    }

    // BUG-323 复报（2026-10-19）：平台默认下载目录（`~/Downloads`）下的引擎旧落点。
    //
    // 与上一段分开的两点理由：① 这两处来自**真实家目录**（`default_download_dir()`
    // 在测试进程里同样解析到家目录），必须只由启动路径触达 —— 混进
    // `legacy_managed_roots()` 会让单测把用户的媒体搬进 %TEMP%（BUG-325 实测
    // 27.5 GB）；② 它体量大得多（实测 24 GB + 3.5 GB），日志单独一行便于核对。
    match state.store.migrate_platform_default_legacy_roots().await {
        Ok(Some(m)) => {
            for r in &m.roots {
                let msg = format!(
                    "platform-default legacy root migrated ({}): {} -> {} (moved {} \
                     top-level item(s), skipped {}, rewritten {} row(s))",
                    r.name, r.from, r.to, r.moved, r.skipped, r.rewritten
                );
                println!("[tg] {msg}");
                state.push_log(msg);
            }
            if m.skipped() > 0 {
                state.push_log(format!(
                    "[warn] {} top-level item(s) skipped while migrating platform-default \
                     legacy roots: same name already exists at the new root (nothing was \
                     overwritten)",
                    m.skipped()
                ));
            }
        }
        Ok(None) => {}
        Err(e) => {
            let msg = format!("[warn] platform-default legacy root migration failed: {e}");
            eprintln!("{msg}");
            state.push_log(msg);
        }
    }

    // BUG-323 复报（2026-10-19）：下载根**运行中变更**后的断点续迁。
    //
    // `migrate_legacy_managed_roots` 只认固定历史落点；用户在设置里把下载路径
    // 从 A 改到 B 之后，锚点 `last_download_root` 仍是 A ⇒ 这里把 A 的引擎字节
    // 搬进 B 并改写 DB。上次迁移有同名冲突（skipped>0）时锚点保留，重启自动重试。
    match state.store.migrate_root_change().await {
        Ok(Some(m)) => {
            let msg = format!(
                "download root change migrated: {} -> {} (moved {} top-level item(s), \
                 skipped {}, rewritten {} row(s))",
                m.from, m.to, m.moved, m.skipped, m.rewritten
            );
            println!("[tg] {msg}");
            state.push_log(msg);
            if let Ok(json) = serde_json::to_string_pretty(&m) {
                let _ = std::fs::write(
                    state.store.data_dir().join("root-change-migration.json"),
                    json,
                );
            }
        }
        Ok(None) => {}
        Err(e) => {
            let msg = format!("[warn] download root change migration failed: {e}");
            eprintln!("{msg}");
            state.push_log(msg);
        }
    }

    // 僵尸缓存任务降级（BUG-024）：进程被杀/崩溃时残留的 running 永远等不到 worker，
// 必须显式标成 interrupted，否则前端会显示一个永不推进的「缓存中」假状态。
    match state.store.mark_stale_cache_tasks().await {
        Ok(n) if n > 0 => {
            state.push_log(format!("cache tasks: {n} stale task(s) marked interrupted"));
        }
        Ok(_) => {}
        Err(e) => eprintln!("[warn] mark stale cache tasks failed: {e}"),
    }
    // BUG-257：排队任务**保留并重新入队**。`mark_stale_cache_tasks` 只降级 `running`
    // （`queued` 从未传输过一个字节，降级成「中途被打断」没有依据）。此前两者都被降级，
    // 等于「重启即清空待办」——实测一次重启作废 26 个 queued。
    //
    // 投递**只经`spawn_cache_task`**（单飞门禁在那里）：在 store 层 spawn 会绕过门禁。
    // 启动时首个任务直接起 worker，其余留在 `queued` 由它 FIFO 接续。
    match state.store.recover_queued_cache_tasks().await {
        Ok(tasks) if !tasks.is_empty() => {
            let n = tasks.len();
            let head = tasks[0].id;
            for t in tasks {
                state.push_log(format!("cache task {}: re-queued after restart", t.id));
            }
            orig_tg::routes::spawn_cache_task(state.clone(), head);
            println!("[tg] cache queue resumed after restart: {n} task(s) re-queued");
        }
        Ok(_) => {}
        Err(e) => eprintln!("[warn] recover queued cache tasks failed: {e}"),
    }
    // 首份读快照：服务启动即有数据，避免首个 GET 返回空列表。
    state.refresh_cache_tasks().await;

    // BUG-420：存量内容 hash 回填（后台、幂等、不阻断启动）。
    //
    // `content_hash` 的唯一生产点是内容寻址落盘（D24-A / BUG-309），2026-10-12 才落地
    // ⇒ 此前下载的条目没有 hash，而 BUG-407/408 的归并判据「同 hash ⇒ 同一集」对它们
    // **恒不成立**（实测真实库 video 只有 19/377 有 hash）。这里补一次：读盘算 SHA-256、
    // 只写 `content_hash` 一列 —— 不搬字节、不碰 `media_blob` 引用计数。
    //
    // 位置：必须排在上面几次「迁移改写 file_path」之后，否则 `resolve_item_path` 会按
    // 旧路径判「文件不存在」而整片跳过。延迟 8 s 只为让监听与首屏先起来。
    {
        let bg = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(
                bg.config.hash_backfill_delay_secs,
            ))
            .await;
            let rep = orig_tg::hash_backfill::backfill_content_hashes(&bg, 0).await;
            if !rep.is_noop() {
                println!("[tg] BUG-420 hash backfill: {}", rep.summary());
            }
        });
    }

    // 存量文件名撞车对账（BUG-100）：**只报不修**。
    // 新落盘已带 chat/message 唯一后缀，存量不动（改存量命名会让新代码找不到旧文件）。
    // 这里把撞名清单暴露出来，修复动作（清哪条、要不要重下）由人决定 ——
    // 自动修复等于替用户删文件，是明确禁止的。
    match state.store.duplicate_file_paths(20).await {
        Ok(dups) if !dups.is_empty() => {
            let shared: i64 = dups.iter().map(|d| d.count).sum();
            let msg = format!(
                "file_path collision: {} path(s) shared by {shared} row(s); \
                 worst: {} x{} in {}",
                dups.len(),
                dups[0].path,
                dups[0].count,
                dups[0].table
            );
            eprintln!("[warn] {msg}");
            // 同时进环形日志：前端 `/api/tg/logs` 与设置页日志面板可直接看到，不必翻进程输出。
            state.push_log(format!("[warn] {msg}"));
        }
        Ok(_) => {}
        Err(e) => eprintln!("[warn] file path collision audit failed: {e}"),
    }

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

    // 端口已在启动早期 bind（见上，BUG-227）；这里只补「什么模式」这一句。
    // 「bind 前就宣告 listening」的老毛病（BUG-023 的误导源）不会回来：那行日志
    // 现在紧跟在真正的 bind 之后，端口被占用时根本走不到这里。
    eprintln!(
        "orig-tg listening on http://{addr} (mode={} mock={mock})",
        availability.label()
    );

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[fatal] server error: {e}");
        std::process::exit(1);
    }
}
