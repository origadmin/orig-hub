//! HTTP 路由：orig-tg 对外契约（REST）。与 orig-daemon 的 9876 端口独立。
//!
//! 端点：
//!   GET  /health                     -> {status:ok}
//!   GET  /api/tg/session             -> SessionView（登录阶段）
//!   POST /api/tg/start               -> 发起登录（发送验证码）
//!        body: {"phone":"+86..."}
//!   POST /api/tg/code                -> 提交验证码/2FA 密码
//!        body: {"code":...} / {"password":...}
//!   GET  /api/tg/dialogs             -> [Channel] 订阅频道枚举（未登录返回 401）
//!   GET  /api/tg/messages/:chat_id?limit=100 -> [MediaItem] 频道媒体历史（未登录返回 401）

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use libsql::params;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio_stream::wrappers::ReceiverStream;

use crate::login::{ClientError, DownloadOutcome, LoginPhase, MediaRange};
use crate::monitor;
use crate::state::{AppState, Availability};
use crate::store::{CacheTask, StoredQuery};

pub fn router(state: Arc<AppState>) -> axum::Router {
    Router::new()
        .route("/", get(debug_page))
        .route("/debug", get(debug_page))
        .route("/health", get(health))
        .route("/api/tg/session", get(session))
        .route("/api/tg/start", axum::routing::post(start))
        .route("/api/tg/code", axum::routing::post(code))
        .route("/api/tg/logs", get(logs))
        .route("/api/tg/diag", get(diag))
        .route("/api/tg/dialogs", get(dialogs))
        .route("/api/tg/folders", get(folders))
        .route("/api/tg/thumb/:chat_id/:message_id", get(thumb))
        .route("/api/tg/file/:chat_id/:message_id", get(media_file))
        .route("/api/tg/local/:chat_id/:message_id", get(local_file))
        // 修 C1（BUG-051）：旧 clear_cache 只清 dialog 列表缓存，名不副实。
        // 现指向真正的清缓存实现（只删下载目录内的字节，条目保留）。
        // 兼容别名：旧前端仍走这里。无参请求 = `scope=all`（见 `cache::clear`）。
        .route("/api/tg/cache/clear", axum::routing::post(crate::cache::clear))
        // 缓存任务（服务端任务态）：入队/查询/取消。任务不绑请求生命周期，刷新即丢的根治。
        .route(
            "/api/tg/cache/tasks",
            get(list_cache_tasks).post(enqueue_cache_task),
        )
        // 全量任务列表 + 状态计数（缓存管理面板）。与上面单结果契约并存，
        // 管理面板低频拉取，不参与 1s 轮询（BUG-027 的轮询三律不受影响）。
        .route("/api/tg/cache/tasks/all", get(list_all_cache_tasks))
        .route(
            "/api/tg/cache/tasks/:id",
            get(cache_task_by_id).delete(cancel_cache_task_route),
        )
        .route("/api/tg/messages/:chat_id", get(messages))
        .route("/api/tg/download/:chat_id/:message_id", axum::routing::post(download))
        .route(
            "/api/tg/monitor/channels",
            get(list_monitor_channels).post(add_monitor_channel),
        )
        .route(
            "/api/tg/monitor/channels/:id",
            axum::routing::delete(remove_monitor_channel),
        )
        .route("/api/tg/monitor/messages", get(monitor_messages))
        .route("/api/tg/monitor/search", get(monitor_search))
        .route("/api/tg/monitor/sync", axum::routing::post(monitor_sync))
        .route("/api/tg/stored", get(stored))
        .route(
            "/api/tg/stored/:channel_id/:message_id",
            axum::routing::delete(clear_stored),
        )
        .route("/api/tg/downloaded/:chat_id", get(downloaded_map))
        .route("/api/tg/config", get(get_config).put(put_config))
        // ---- 媒体资料库（内容 / 剧集 / 标签）----
        .route("/api/media/stats", get(media_stats))
        .route(
            "/api/media/items",
            get(list_media_items).post(import_media_items),
        )
        .route(
            "/api/media/items/:id",
            get(get_media_item).patch(patch_media_item).delete(delete_media_item),
        )
        .route("/api/media/items/:id/tags", axum::routing::put(set_media_item_tags))
        .route("/api/media/items/:id/raw", get(media_item_raw))
        // BUG-208：浏览器无硬件 HEVC 时的兼容流（按需实时转码 H.264 + 代理缓存）。
        .route("/api/media/items/:id/stream", get(media_item_stream))
        .route("/api/media/items/by-ref", get(media_item_by_ref))
        .route("/api/media/export/preview", get(export_preview))
        .route("/api/media/export", axum::routing::post(export_media))
        .route(
            "/api/media/series",
            get(list_media_series).post(create_media_series),
        )
        .route(
            "/api/media/series/:id",
            get(get_media_series)
                .patch(patch_media_series)
                .delete(delete_media_series),
        )
        .route(
            "/api/media/series/:id/tags",
            axum::routing::put(set_media_series_tags),
        )
        .route(
            "/api/media/series/:id/episodes",
            axum::routing::post(add_media_episode),
        )
        .route(
            "/api/media/series/:id/episodes/append",
            axum::routing::post(append_media_episodes),
        )
        .route(
            "/api/media/series/:id/merge",
            axum::routing::post(merge_media_series),
        )
        .route(
            "/api/media/episodes/:id",
            axum::routing::patch(patch_media_episode).delete(delete_media_episode),
        )
        .route(
            "/api/media/episodes/:id/move",
            axum::routing::post(move_media_episode),
        )
        // 备用来源（BUG-039 冲突1）：同一集多缓存来源 —— 挂载 / 切主 / 摘除。
        .route(
            "/api/media/episodes/:id/sources",
            axum::routing::post(attach_episode_source),
        )
        .route(
            "/api/media/episodes/:id/sources/primary",
            axum::routing::post(switch_episode_source),
        )
        .route(
            "/api/media/episodes/:id/sources/:item_id",
            axum::routing::delete(detach_episode_source),
        )
        // 集级图片挂载（BUG-168）：一集可挂多张图（replace-all），一图也可挂多集。
        .route(
            "/api/media/episodes/:id/images",
            axum::routing::post(attach_episode_images),
        )
        .route(
            "/api/media/episodes/:id/images/:item_id",
            axum::routing::delete(detach_episode_image),
        )
        // 集的统一挂载读模型（D1=B 第一步）：主条目 / 备用源 / 挂图收敛成一个有序列表。
        .route(
            "/api/media/episodes/:id/bindings",
            get(list_episode_bindings),
        )
        .route("/api/media/tags", get(list_media_tags).post(create_media_tag))
        .route(
            "/api/media/tags/:id",
            axum::routing::patch(patch_media_tag).delete(delete_media_tag),
        )
        .route("/api/media/scan", axum::routing::post(scan_media_dir))
        // M2 缓存模块独立路由组（BUG-051 §0：缓存不再挂在 TG 端）
        .merge(crate::cache::router())
        .with_state(state)
}

/// 内嵌独立网页调试界面（GET /）：登录 / 枚举 / 拉史 / 下载一页完成。
async fn debug_page() -> impl IntoResponse {
    axum::response::Html(DEBUG_PAGE)
}

async fn health() -> impl IntoResponse {
    Json(json!({"status": "ok"}))
}

async fn session(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let view = st.client.view().await;
    // 可用性与登录阶段**正交**：`available=false` 是「TG 不可用（含原因）」，
    // 绝不是「未登录」。二者混同正是 BUG-023 的界面现象（故障被读成登录态丢失）。
    Json(json!({
        "phase": view.phase,
        "phone": view.phone,
        "user_id": view.user_id,
        "available": st.availability.is_ready(),
        "reason": st.availability.reason(),
        // BUG-178：凭证是否已配置。
        //
        // 缺这个字段时，「没配凭证」与「Telegram 连不上」被压成同一个
        // `available=false`，前端只能一律渲染「Telegram 不可用」—— 于是**待用户完成的
        // 动作**（去设置页填 api_id/api_hash、登录）被说成了故障，而设置页同时显示
        // 「Telegram 插件：运行中」，两处自相矛盾。有了它，前端才能把二者分开：
        // 未配置 → 引导配置；已配置连不上 → 如实报链路故障 + 由 daemon 自愈。
        "api_configured": st.config.api_id.is_some() && st.config.api_hash.is_some(),
    }))
}

/// GET /api/tg/logs?lines=N — 最近 N 条诊断日志（新→旧）。
#[derive(Deserialize)]
struct LogsQuery {
    #[serde(default = "default_logs_lines")]
    lines: usize,
}

fn default_logs_lines() -> usize {
    50
}

async fn logs(State(st): State<Arc<AppState>>, Query(q): Query<LogsQuery>) -> impl IntoResponse {
    Json(st.logs.recent(q.lines))
}

/// GET /api/tg/diag — 运行诊断快照（端口/可用性/代理/会话阶段/是否有 API 凭证）。
///
/// `available` + `unavailable_reason` 取代了旧的 `api_mode` 字符串：后者是纯展示标签，
/// 没有任何代码据它分支，故障因此对系统其余部分不可见（BUG-023）。
async fn diag(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let view = st.client.view().await;
    // 存量撞名（BUG-104）：本端点是**手动**触发的诊断快照（AccountsPanel 按钮），
    // 不在任何轮询路径上，故这里的 DB 读不构成轮询压力。
    let collisions = st.store.duplicate_file_paths(20).await.unwrap_or_default();
    // BUG-106：链路活性必须参与健康判定。此前 `health` 恒为 "ok"、只读本地状态，
    // 于是 sender runner 死后「全部接口报绿、实际全残」—— 用户只能在点了某个真发
    // 请求的功能时才撞见裸露的 400。链路断了就如实报 degraded。
    let link_alive = st.client.link_alive();
    let health = if link_alive { "ok" } else { "degraded" };
    Json(json!({
        "health": health,
        // 与 `health` 同源但更直白，便于调用方直接判真假而不用比对字符串。
        "link_alive": link_alive,
        "port": st.config.port,
        "available": st.availability.is_ready(),
        "mode": st.availability.label(),
        "unavailable_reason": st.availability.reason(),
        // 合成数据必须自报家门，避免被当成真实数据（仅 `--features mock` 构建可能为 true）。
        "mock": st.mock,
        "api_configured": st.config.api_id.is_some() && st.config.api_hash.is_some(),
        "proxy": st.config.proxy,
        "session_phase": view.phase,
        "log_lines": st.logs.len(),
        "file_path_collisions": collisions,
    }))
}

#[derive(Deserialize)]
struct StartReq {
    phone: String,
}

async fn start(
    State(st): State<Arc<AppState>>,
    Json(req): Json<StartReq>,
) -> Result<impl IntoResponse, ApiError> {
    // 统一契约：所有 TG 端点在动作前先判可用性，故障一律 503 + 原因（不靠底层调用失败兜底）。
    ensure_available(&st)?;
    st.push_log(format!("/start phone={}", req.phone));
    let phase = match st.client.start(&req.phone).await {
        Ok(ph) => ph,
        Err(e) => {
            st.push_log(format!("/start FAILED phone={}: {e}", req.phone));
            return Err(e.into());
        }
    };
    st.push_log(format!("/start ok phone={} -> {phase:?}", req.phone));
    Ok(Json(json!({"phase": phase, "phone": req.phone})))
}

#[derive(Deserialize)]
struct CodeReq {
    #[serde(rename = "phone")]
    phone: String,
    #[serde(rename = "code")]
    code: Option<String>,
    #[serde(rename = "password")]
    password: Option<String>,
}

async fn code(
    State(st): State<Arc<AppState>>,
    Json(req): Json<CodeReq>,
) -> Result<impl IntoResponse, ApiError> {
    // 必须先查可用性：不可用时 `view()` 返回哨兵 `Anonymous`，若直接往下走会命中
    // 下面的 `Anonymous => Authorized` 分支，**什么都没做却回「已授权」**，
    // 前端据此把账号标记成已绑定 —— 一个凭空的登录态（可用性验收 S1/S2 实测发现）。
    ensure_available(&st)?;
    let view = st.client.view().await;
    let phase = match view.phase {
        LoginPhase::PasswordRequired => match req.password.as_deref() {
            Some(p) => {
                st.push_log("/code submit 2fa password");
                match st.client.submit_password(&req.phone, p).await {
                    Ok(ph) => ph,
                    Err(e) => {
                        st.push_log(format!("/code 2fa FAILED: {e}"));
                        return Err(e.into());
                    }
                }
            }
            None => {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "two-step verification: password required",
                ))
            }
        },
        LoginPhase::CodeRequired => match req.code.as_deref() {
            Some(c) => {
                st.push_log("/code submit code");
                match st.client.submit_code(&req.phone, c).await {
                    Ok(ph) => ph,
                    Err(e) => {
                        st.push_log(format!("/code FAILED code: {e}"));
                        return Err(e.into());
                    }
                }
            }
            None => {
                return Err(ApiError::new(StatusCode::BAD_REQUEST, "code required"))
            }
        },
        // 已授权时重复提交验证码：沿用既有幂等语义，视为成功。
        LoginPhase::Authorized => LoginPhase::Authorized,
        // 未登录却提交验证码：这是调用流程错误，绝不能当成成功。
        // （原实现与 Authorized 合并成一支直接返回 Authorized，构成伪造登录态。）
        LoginPhase::Anonymous => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "no pending login: request a code first",
            ))
        }
    };
    st.push_log(format!("/code ok -> {phase:?}"));
    if phase == LoginPhase::PasswordRequired {
        return Ok(Json(json!({"phase": phase, "next": "submit password"})));
    }
    Ok(Json(json!({"phase": phase})))
}

fn default_dialog_limit() -> u32 {
    50
}

#[derive(Deserialize)]
struct DialogsQuery {
    #[serde(default = "default_dialog_limit")]
    limit: u32,
    #[serde(default)]
    offset: i64,
    #[serde(default)]
    refresh: u32,
}

/// GET /api/tg/dialogs?limit=&offset=&refresh= — 缓存优先分页 + 后台全量扫描。
///
/// v0.4.0 语义（修复假增量 BUG-013）：
/// - **永远先读 SQLite 缓存**分页返回，HTTP 请求不被 Telegram 枚举阻塞（本地真列表）；
/// - 缓存为空（首启）或 `refresh=1` 时，后台 spawn 一次**全量** `client.dialogs()`
///   逐条 upsert；扫描期间 `scanning=true`，前端轮询直到翻为 false；
/// - 返回 `{items,total,hasMore,scanning}`。refresh 不清缓存（旧数据先顶着，避免闪烁）。
///
/// BUG-179：客户端不可用（离线模式 / MTProto 断开）**不再拒绝服务本地缓存**。
/// `dialog_cache` 本身就是历史已授权会话的落库结果 —— 「连不上 Telegram」
/// 是链路状态，不是「本地没有数据」；旧逻辑把两者压成同一个 503，
/// 用户在调试模式下看着 516 条本地频道缓存却什么都拿不到。
/// 客户端不可用时：跳过鉴权与实时 folder 修正、不触发扫描，纯服务缓存；
/// 缓存也为空时才如实报 503（附可用性原因，可行动）。
async fn dialogs(State(st): State<Arc<AppState>>, Query(q): Query<DialogsQuery>) -> Result<impl IntoResponse, ApiError> {
    let client_ready = st.availability.is_ready();
    let mut total = st
        .store
        .count_dialogs()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    if !client_ready {
        if total == 0 {
            // 本地没有可服务的缓存、客户端又不可用：如实报原因，绝不伪装成空列表。
            let reason = st
                .availability
                .reason()
                .unwrap_or("telegram client unavailable");
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, reason));
        }
    } else {
        ensure_authorized(&st).await?;
        // 首启无缓存，或显式刷新：触发后台全量扫描（内部自行去重，不会并发重复跑）。
        if total == 0 || q.refresh != 0 {
            spawn_dialog_scan(st.clone());
        }
    }

    let mut items = st
        .store
        .read_dialogs(q.offset.max(0), q.limit.clamp(1, 200))
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // folder 实时修正（BUG-017）：dialog_cache.folder 覆盖不全（历史扫描缺列），
    // 以 TG 实时 DialogFilter 的 channel_ids 映射为准覆盖；读取失败时静默保留旧值。
    // 客户端不可用时 `folders()` 自然 Err → 走既有降级路径，本地 folder 原样返回。
    if let Ok(folders) = st.client.folders().await {
        let mut map: std::collections::HashMap<i64, &str> = std::collections::HashMap::new();
        for f in folders.iter() {
            for id in f.channel_ids.iter() {
                map.insert(*id, f.title.as_str());
            }
        }
        for it in items.iter_mut() {
            if let Some(title) = map.get(&it.id) {
                it.folder = Some((*title).to_string());
            }
        }
    }
    if client_ready {
        total = st
            .store
            .count_dialogs()
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    }
    let has_more = total > q.offset.max(0) + (q.limit.clamp(1, 200)) as i64;
    Ok(Json(json!({
        "items": items,
        "total": total,
        "hasMore": has_more,
        "scanning": st.is_scanning(),
    })))
}

/// 触发一次后台全量会话扫描（幂等去重：已在扫描时直接忽略）。
///
/// 全量枚举后逐条 upsert 到 `dialog_cache`；同时 grammers 实现会在枚举时
/// 填充 PeerRef 内存缓存，加速后续媒体/消息请求。
pub fn spawn_dialog_scan(st: Arc<AppState>) {
    use std::sync::atomic::Ordering;
    // compare_exchange：false -> true 才启动，杜绝并发重复全量枚举。
    if st
        .dialog_scanning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    st.push_log("dialog scan: background full scan started");
    tokio::spawn(async move {
        let outcome = async {
            let channels = st
                .client
                .dialogs()
                .await
                .map_err(|e| e.to_string())?;
            let n = channels.len();
            for ch in &channels {
                st.store
                    .upsert_dialog(ch)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok::<_, String>(n)
        }
        .await;
        st.dialog_scanning.store(false, Ordering::SeqCst);
        match outcome {
            Ok(n) => st.push_log(format!("dialog scan: done, cached {n} dialogs")),
            Err(e) => st.push_log(format!("dialog scan: FAILED: {e}")),
        }
    });
}

/// GET /api/tg/file/:chat_id/:message_id — 媒体在线流（原始字节，不转 JSON）。
///
/// 照片返回 `image/jpeg`，文档按其 mime-type 返回 content-type；供前端
/// `<img src>` / `<video src>` 在线预览/点播。`cache-control: no-store` 不过度缓存。
///
/// 支持 HTTP Range：视频/文档按区间局部拉取并用 206 Partial Content 返回
/// （Content-Range / Accept-Ranges: bytes / Content-Length），播放器只取当前播放段，
/// 从而显著降低 Telegram 拉取带宽。无 Range 时整段 200 返回。
async fn media_file(
    State(st): State<Arc<AppState>>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    ensure_authorized(&st).await?;
    let range = parse_range(headers.get(header::RANGE))?;

    match st.client.media(chat_id, message_id, range).await {
        Ok(stream) => {
            let mut res = axum::response::Response::new(
                axum::body::Body::from_stream(stream.body),
            );
            let ct = header::HeaderValue::from_str(&stream.content_type)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
            res.headers_mut().insert(header::CONTENT_TYPE, ct);
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            res.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

            match range {
                // 206 Partial Content：带 Content-Range + Content-Length。
                Some(_) => {
                    let total_str = stream
                        .total_size
                        .map_or_else(|| "*".to_string(), |t| t.to_string());
                    let cr = format!(
                        "bytes {}-{}/{}",
                        stream.start, stream.end, total_str
                    );
                    if let Ok(v) = HeaderValue::from_str(&cr) {
                        res.headers_mut().insert(header::CONTENT_RANGE, v);
                    }
                    let len_str = (stream.end - stream.start + 1).to_string();
                    if let Ok(v) = HeaderValue::from_str(&len_str) {
                        res.headers_mut().insert(header::CONTENT_LENGTH, v);
                    }
                    *res.status_mut() = StatusCode::PARTIAL_CONTENT;
                }
                // 200 整段：已知总长时给 Content-Length。
                None => {
                    if let Some(total) = stream.total_size {
                        if let Ok(v) = HeaderValue::from_str(&total.to_string()) {
                            res.headers_mut().insert(header::CONTENT_LENGTH, v);
                        }
                    }
                }
            }
            Ok(res)
        }
        // 区间不可满足 → 416，Content-Range: bytes */total。
        Err(ClientError::UnsatisfiableRange(total)) => {
            let total_str = total.map_or_else(|| "*".to_string(), |t| t.to_string());
            let mut res = axum::response::Response::new(axum::body::Body::empty());
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total_str}")) {
                res.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            res.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            *res.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            Ok(res)
        }
        Err(e) => Err(e.into()),
    }
}

/// 解析 `Range: bytes=...` 请求头。返回需局部拉取的区间；无法解析/多段/非 bytes 单位
/// 一律视为无 Range（整段 200 返回，符合 HTTP 语义）。
fn parse_range(value: Option<&HeaderValue>) -> Result<Option<MediaRange>, ApiError> {
    let Some(v) = value else { return Ok(None) };
    let Ok(text) = v.to_str() else {
        return Ok(None);
    };
    let text = text.trim();
    if !text.starts_with("bytes=") {
        return Ok(None); // 非 bytes 单位或其它 Range 形式：忽略
    }
    let spec = text["bytes=".len()..].trim();
    if spec.contains(',') {
        return Ok(None); // 多段 Range 不支持：回退整段 200
    }
    let Some((start_s, end_s)) = spec.split_once('-') else {
        return Ok(None);
    };
    let start_s = start_s.trim();
    let end_s = end_s.trim();

    if start_s.is_empty() && end_s.is_empty() {
        return Ok(None);
    }

    // bytes=-N（末尾 N 字节）
    if start_s.is_empty() {
        let Ok(tail) = end_s.parse::<u64>() else {
            return Ok(None);
        };
        if tail == 0 {
            return Ok(None);
        }
        return Ok(Some(MediaRange::Tail(tail)));
    }

    let Ok(start) = start_s.parse::<u64>() else { return Ok(None) };

    // bytes=start-（开放）
    if end_s.is_empty() {
        return Ok(Some(MediaRange::Open(start)));
    }

    // bytes=start-end（闭区间）
    let Ok(end) = end_s.parse::<u64>() else { return Ok(None) };
    if end < start {
        return Ok(Some(MediaRange::Closed(start, start))); // 规范：退化，客户端会处理
    }
    Ok(Some(MediaRange::Closed(start, end)))
}

/// GET /api/tg/folders — 用户自定义分组（DialogFilter）。
///
/// **失败降级而非裸抛 400（BUG-106）**：原实现 `st.client.folders().await?` 会把
/// grammers 传输层原文（`request error: dropped (cancelled)`）直接变成 400 响应体，
/// 前端只能原样弹给用户。而**同一个失败**在 `dialogs` handler 里是
/// `if let Ok(folders) = ...` 被容忍的 —— 同一依赖两种容错策略，本身就是缺陷。
///
/// 这里统一为「降级 + 留痕」：**响应体仍是数组**（前端 `listTgFolders(): Promise<TgFolder[]>`，
/// 改形状会直接破坏解析），失败时返回空数组 —— 左栏退化为只显示「未分组」，
/// 而不是把传输层原文弹给用户。原因必须记进 `/api/tg/logs`（**绝不静默吞错**），
/// 链路活性另由 `GET /api/tg/diag` 的 `link_alive` 如实暴露。
async fn folders(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    match st.client.folders().await {
        Ok(folders) => Ok(Json(folders)),
        Err(e) => {
            let reason = e.to_string();
            // 链路已断时给出可行动的说明，而不是让上层去猜传输层原文。
            let hint = if st.client.link_alive() {
                "folders request failed"
            } else {
                "MTProto link is down (sender runner exited); restart orig-tg to recover"
            };
            st.push_log(&format!("/api/tg/folders: degraded to [] -> {reason} ({hint})"));
            Ok(Json(vec![]))
        }
    }
}

#[derive(Deserialize)]
struct MsgQuery {
    #[serde(default = "default_limit")]
    limit: u32,
    /// 历史游标（exclusive）：只返回 message_id < beforeId 的媒体；缺省从最新开始。
    #[serde(rename = "beforeId", default)]
    before_id: Option<i64>,
}

fn default_limit() -> u32 {
    30
}

async fn messages(
    State(st): State<Arc<AppState>>,
    Path(chat_id): Path<i64>,
    Query(q): Query<MsgQuery>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    let limit = q.limit.clamp(1, 100);
    // BUG-106：不再把传输层原文裸抛成 400。
    //
    // **这里刻意不降级成空列表** —— 「这个频道没有消息」和「这次没取到消息」是两回事，
    // 返回 `items: []` 会让用户以为频道是空的（把失败伪装成成功）。故如实返回 503，
    // 并把「链路已断 → 重启 orig-tg 可恢复」作为可行动提示一并返回。
    match st.client.messages(chat_id, limit, q.before_id).await {
        Ok(items) => {
            // 拉满一页则可能还有更早历史；不足一页说明已到顶。
            let has_more = items.len() as u32 >= limit;
            Ok(Json(json!({"items": items, "hasMore": has_more})))
        }
        Err(e) => {
            let reason = e.to_string();
            let hint = if st.client.link_alive() {
                "messages request failed"
            } else {
                "MTProto link is down; restart orig-tg to recover"
            };
            st.push_log(&format!(
                "/api/tg/messages/{chat_id}: failed -> {reason} ({hint})"
            ));
            Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("{hint}: {reason}"),
            ))
        }
    }
}

/// GET /api/tg/thumb/:chat_id/:message_id — 轻量缩略图（image/jpeg 字节流）。
///
/// 列表海报专用：优先返回 TL 内嵌 Cached 缩略图（零网络往返），无内嵌时下载 <=480px
/// 的小尺寸。无可用缩略图返回 404，前端自行降级占位。短缓存 1 天。
async fn thumb(
    State(st): State<Arc<AppState>>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
) -> Result<Response, ApiError> {
    ensure_authorized(&st).await?;
    // BUG-106：缩略图是列表海报专用，**取不到就该让前端降级占位（404）**，
    // 而不是把传输层原文裸抛成 400。
    //
    // 链路一断，一页几十张缩略图会刷出几十个 `400 dropped (cancelled)`，
    // 用户看到的是「整个 TG 功能 400」，实际只是图片暂时取不到 ——
    // 错误被放大成与真实影响完全不成比例的样子。故统一按 404（无缩略图）处理，
    // 但**必须留痕**：链路状态另由 `/api/tg/diag.link_alive` 如实暴露。
    let t = match st.client.thumb(chat_id, message_id).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "thumbnail not available"));
        }
        Err(e) => {
            let reason = e.to_string();
            let hint = if st.client.link_alive() {
                "thumbnail request failed"
            } else {
                "MTProto link is down; restart orig-tg to recover"
            };
            // 高频路径：节流留痕（同一分钟最多一条），避免日志被冲垮掩盖真病因。
            st.push_log_throttled(
                "thumb",
                60,
                format!("/api/tg/thumb/{chat_id}/{message_id}: degraded -> {reason} ({hint})"),
            );
            return Err(ApiError::new(StatusCode::NOT_FOUND, "thumbnail not available"));
        }
    };
    let mut res = Response::new(axum::body::Body::from(t.bytes));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&t.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg")),
    );
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    Ok(res)
}

#[derive(Deserialize)]
struct DownloadReq {
    #[serde(rename = "dir")]
    dir: Option<String>,
}

/// GET /api/tg/local/:chat_id/:message_id — 播放已缓存到本地的文件（支持 Range）。
///
/// 读取 `media_message.file_path`（download 成功时记录的绝对路径）直接流式回本地字节，
/// 不回源 Telegram。未缓存/文件被移动时返回 404，前端降级在线流。
async fn local_file(
    State(st): State<Arc<AppState>>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let db_err = |e: libsql::Error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());

    let Some(msg) = st.store.get_message(chat_id, message_id).await.map_err(db_err)? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "message not stored"));
    };
    let Some(path) = msg.file_path.clone() else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "file not cached"));
    };
    // 契约与媒体库条目投递完全一致（见 serve_local_file）：
    // Range / ETag / Last-Modified / MIME 判定只有一处实现，避免「已缓存播放」退化。
    // P2：存在性判定以解析后的绝对路径为准（相对 = 库根相对）。
    let lib_root = st.store.library_root().await;
    let path = crate::cache::resolve_item_path(&lib_root, &path)
        .to_string_lossy()
        .into_owned();
    if !std::path::Path::new(&path).exists() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cached file missing"));
    }
    serve_local_file(&path, msg.media_type.as_deref(), msg.duration, &headers).await
}

/// 下载目录当前生效值：DB 设置 > env/默认配置。
/// A leading `~` from either source is expanded (BUG-071).
async fn effective_download_dir(st: &AppState) -> String {
    let raw = st
        .store
        .get_setting("download_dir")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| st.config.download_dir.to_string_lossy().into_owned());
    orig_core::paths::expand_tilde(&raw).to_string_lossy().into_owned()
}

#[derive(Deserialize)]
struct ConfigUpdateReq {
    #[serde(rename = "downloadDir", default)]
    download_dir: Option<String>,
    /// byte-ownership P2：库根（归仓字节的家）。缺省 = 沿用既有解析链
    /// （env > app_setting > config.json > `<TG 数据目录>/library`），不覆盖。
    #[serde(rename = "libraryDir", default)]
    library_dir: Option<String>,
}

/// GET /api/tg/config — 运行时配置快照（缓存下载目录、库根等）。
async fn get_config(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let download_dir = effective_download_dir(&st).await;
    let library_root = st.store.library_root().await;
    Ok(Json(json!({
        "downloadDir": download_dir,
        "libraryDir": library_root.to_string_lossy(),
    })))
}

/// PUT /api/tg/config — 更新运行时配置，持久化到 app_setting。
///
/// 两键独立可选，至少给一个（前端只改其一的请求不会被另一键的缺省清掉）。
async fn put_config(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ConfigUpdateReq>,
) -> Result<impl IntoResponse, ApiError> {
    if req.download_dir.is_none() && req.library_dir.is_none() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "nothing to update: provide downloadDir and/or libraryDir",
        ));
    }
    let mut resp = json!({});
    if let Some(raw_dir) = &req.download_dir {
        let dir = raw_dir.trim().to_string();
        if dir.is_empty() {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "downloadDir is empty"));
        }
        // Expand a user-typed leading `~` *before* creating the directory and
        // persisting it, otherwise Windows would materialise `<CWD>/~/...` (BUG-071).
        let dir = orig_core::paths::expand_tilde(&dir).to_string_lossy().into_owned();
        // 预创建校验：目录不可创建（权限/非法字符）时拒绝保存。
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, &format!("create dir: {e}")))?;
        st.store
            .set_setting("download_dir", &dir)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        resp["downloadDir"] = json!(dir);
    }
    if let Some(raw_dir) = &req.library_dir {
        let dir = raw_dir.trim().to_string();
        if dir.is_empty() {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "libraryDir is empty"));
        }
        let dir = orig_core::paths::expand_tilde(&dir).to_string_lossy().into_owned();
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, &format!("create dir: {e}")))?;
        st.store
            .set_setting("library_dir", &dir)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        resp["libraryDir"] = json!(dir);
    }
    Ok(Json(resp))
}

async fn download(
    State(st): State<Arc<AppState>>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
    Json(req): Json<DownloadReq>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    let dir = resolve_cache_dir(&st, req.dir).await;
    // 幂等（BUG-024）：已缓存且文件仍在 → 直接回既有路径，不重新拉流。
    // 此前无脑重下，导致「继续」把已完成的条目从头下载一遍。
    if let Some(path) = cached_path(&st, chat_id, message_id).await {
        return Ok(Json(json!({
            "messageId": message_id,
            "path": path,
            "bytes": 0,
            "cached": true,
        })));
    }
    let (outcome, _) = cache_one(&st, chat_id, message_id, &dir).await?;
    Ok(Json(json!({
        "messageId": outcome.message_id,
        "path": outcome.path,
        "bytes": outcome.bytes,
        "cached": false,
    })))
}

// ---- 缓存任务：服务端持有任务态，与 HTTP 请求解耦 ----

/// 解析落盘目录：请求显式 dir > DB 设置（前端可改） > env/默认配置。
/// A leading `~` from any source is expanded (BUG-071).
async fn resolve_cache_dir(st: &AppState, req_dir: Option<String>) -> String {
    let db_dir = st
        .store
        .get_setting("download_dir")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty());
    let raw = req_dir
        .filter(|s| !s.is_empty())
        .or(db_dir)
        .unwrap_or_else(|| st.config.download_dir.to_string_lossy().into_owned());
    orig_core::paths::expand_tilde(&raw).to_string_lossy().into_owned()
}

/// 已缓存且落盘文件仍在时的路径（幂等跳过依据）。
///
/// 双条件缺一不可：文件被手动删除/移动后不应再算「已缓存」，否则「继续」会跳过
/// 一条实际缺失的条目，用户点播放才发现没有。
async fn cached_path(st: &AppState, chat_id: i64, message_id: i64) -> Option<String> {
    let msg = st.store.get_message(chat_id, message_id).await.ok().flatten()?;
    if !msg.downloaded {
        return None;
    }
    let p = msg.file_path.clone()?;
    // P2 起个别路径可能是库根相对的：存在性判定必须先解析再 stat。
    let p = crate::cache::resolve_item_path(&st.store.library_root().await, &p)
        .to_string_lossy()
        .into_owned();
    if tokio::fs::metadata(&p).await.is_ok() {
        Some(p)
    } else {
        None
    }
}

/// 下载单条并回填缓存状态（消息元数据 upsert + 标记已缓存），**不做 media_item 入库**。
///
/// byte-ownership P1（设计 I1「事实先登记」）：缓存任务的条目登记已前移到字节之前
/// （T0，见 `run_one_cache_task` 与 `IngestCtx`），任务路径只负责取字节；落盘成功后
/// 由调用方用 `backfill_item_bytes` 专用语句回填 `file_path`（不走 COALESCE upsert）。
/// 单条下载端点（`/api/tg/download`）仍走 [`cache_one`] 的「下载即入库」旧契约。
///
/// `task_id`（BUG-181）：Some 时把条目内字节进度挂到该任务（`cache_dl_begin/end`），
/// 任务端点序列化时注入 `itemBytes`/`itemBytesTotal`；单条端点传 None 不报。
async fn cache_one_bytes(
    st: &AppState,
    task_id: Option<i64>,
    chat_id: i64,
    message_id: i64,
    dir: &str,
) -> Result<DownloadOutcome, ApiError> {
    // 条目内字节进度（BUG-181）：begin 清零并绑定任务；end 在成败两路都解绑，
    // 保证「任务已切条目」后不会把旧字节报给新条目。
    if let Some(id) = task_id {
        st.cache_dl_begin(id);
    }
    let outcome = match st
        .client
        .download(chat_id, message_id, dir, Some(&st.cache_dl))
        .await
    {
        Ok(o) => o,
        Err(e) => {
            if task_id.is_some() {
                st.cache_dl_end();
            }
            let reason = e.to_string();
            let hint = if st.client.link_alive() {
                "download failed"
            } else {
                "MTProto link is down; restart orig-tg to recover"
            };
            st.push_log(&format!(
                "cache_one({chat_id},{message_id}): failed -> {reason} ({hint})"
            ));
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("{hint}: {reason}"),
            ));
        }
    };
    if task_id.is_some() {
        st.cache_dl_end();
    }
    // 缓存状态入库（BUG-016 根因：此前从未标记，列表永远显示未缓存）。
    // 元数据回填（D1 根因）：mark_downloaded 的兜底 upsert 只写 downloaded/file_path，
    // 未监控频道的行缺 type/mime/size/date/duration/group_id → 缓存库显 📄、聚合失效。
    // 先取 TG 消息元数据 upsert（保留 file_path/downloaded/created_at），再标记已下载；
    // 元数据取不到（消息被删/peer 解析失败）时退化为仅标记。入库失败不影响下载结果返回。
    let meta = st.client.message_meta(chat_id, message_id).await.ok().flatten();
    if let Some(m) = &meta {
        let _ = st
            .store
            .upsert_message(
                chat_id,
                message_id,
                m.caption.as_deref(),
                m.mime_type.as_deref(),
                m.size,
                m.media_type.as_deref(),
                m.date,
                m.duration,
                m.group_id,
            )
            .await;
    }
    let _ = st
        .store
        .mark_downloaded(chat_id, message_id, Some(&outcome.path))
        .await;
    Ok(outcome)
}

/// 下载单条并入库（同步端点旧契约）：字节 + 缓存状态回填 + media_item 登记。
/// 缓存任务不走这里——登记已前移（`IngestCtx`），这里只剩单条下载端点在用。
async fn cache_one(
    st: &AppState,
    chat_id: i64,
    message_id: i64,
    dir: &str,
) -> Result<(DownloadOutcome, Option<i64>), ApiError> {
    let outcome = cache_one_bytes(st, None, chat_id, message_id, dir).await?;
    let id = import_cached_file(st, chat_id, message_id, &outcome.path).await;
    Ok((outcome, id))
}

/// 缓存即入库（媒体管理主视图）：把已落盘的缓存文件登记进 media_item。
///
/// ref 约定与 import_media_items 一致：source="tg"、ref="<chat_id>:<message_id>"
/// （按 (source,ref) 幂等，重复导入不产生副本）。title 取 caption，缺省退化为落盘
/// 文件名；kind 由扩展名分类，mime 前缀兜底；元数据缺失时从落盘文件兜底，
/// 保证任何已落盘缓存都可入库。返回条目 id；入库失败记日志返回 None
/// （不影响调用方的缓存结果）。
async fn import_cached_file(
    st: &AppState,
    chat_id: i64,
    message_id: i64,
    path: &str,
) -> Option<i64> {
    let meta = st
        .client
        .message_meta(chat_id, message_id)
        .await
        .ok()
        .flatten();
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    // 标题只取 caption 的**首行**（`split_caption`），不再把整段文案塞进标题 ——
    // 此前卡片/列表里显示的是「标题+正文」的一大坨，播放页更是看不出剧名。
    // 正文同时落到 `description`：条目必须和剧集一样有「介绍位」，
    // 否则切出来的正文无处可去，只能又回流进标题。
    let (caption_title, caption_desc) = meta
        .as_ref()
        .and_then(|m| m.caption.as_deref())
        .map(split_caption)
        .unwrap_or((None, None));
    // BUG-154：无 caption（或首行为空）时**不再把落盘文件名当标题**。
    //
    // 此前是 `caption_title.unwrap_or(file_name)`：TG 落盘名是 `photo--xxx` 之类的
    // 合成串（非用户可读），它被当成 title 存库后，条目卡片显示的就是这个内部名；
    // 而前端 `isRawFileName` 又把它判掉 → 兜底成 `#<itemId>`，用户看到的就是
    // 「临时标题」。标题缺失应当**如实表达为缺失**（空串），让展示层知道
    // 「这条没有标题」，而不是把内部文件名伪装成标题。
    //
    // 空串是刻意的：`upsert_media_item` 的 `ON CONFLICT` 用
    // `COALESCE(NULLIF(excluded.title, ''), media_item.title)` —— 重新缓存一条
    // 早期已落文件名的旧行时，空串不会覆盖它，也不会把「没有标题」写成非空假值。
    let title = caption_title.unwrap_or_default();
    let description = caption_desc;
    let kind = crate::media::classify_ext(&ext)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let mime = meta.as_ref().and_then(|m| m.mime_type.as_deref());
            match mime {
                Some(m) if m.starts_with("video/") => "video".to_string(),
                // 规范 kind 是 `photo`（与扩展名分类一致）；曾写成 `image`，
                // 与 stats/筛选用的 `photo` 键错位，图片会被静默漏进「其他」。
                Some(m) if m.starts_with("image/") => "photo".to_string(),
                Some(m) if m.starts_with("audio/") => "audio".to_string(),
                _ => "file".to_string(),
            }
        });
    let size = meta
        .as_ref()
        .and_then(|m| m.size)
        .or_else(|| std::fs::metadata(path).ok().map(|x| x.len() as i64));
    let duration = meta.as_ref().and_then(|m| m.duration);
    match st
        .store
        .upsert_media_item(
            "tg",
            &format!("{chat_id}:{message_id}"),
            &title,
            &kind,
            Some(path),
            size,
            duration,
            description.as_deref(),
        )
        .await
    {
        Ok(id) => Some(id),
        Err(e) => {
            st.push_log(&format!("cache ingest failed for {chat_id}:{message_id}: {e}"));
            None
        }
    }
}

#[derive(Deserialize)]
struct EnqueueCacheReq {
    #[serde(rename = "chatId")]
    chat_id: i64,
    /// 待缓存消息号（有序）：整组=组内全部，单条=1 项。
    #[serde(rename = "messageIds")]
    message_ids: Vec<i64>,
    /// 相册分组 id（整组缓存时传，用于同组去重）。
    #[serde(rename = "groupId", default)]
    group_id: Option<i64>,
    #[serde(rename = "dir", default)]
    dir: Option<String>,
}

/// POST /api/tg/cache/tasks — 入队缓存任务（幂等：同 key 已有活跃任务则直接复用）。
///
/// 关键结构：任务在此落库并交给后台 worker，**与本次 HTTP 请求解耦**。浏览器刷新、
/// 切频道、关标签页都不再中断缓存；前端重进后读任务表即可恢复「缓存中 n/N」。
async fn enqueue_cache_task(
    State(st): State<Arc<AppState>>,
    Json(req): Json<EnqueueCacheReq>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    if req.message_ids.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "messageIds is empty"));
    }
    let dir = resolve_cache_dir(&st, req.dir).await;
    // 去重键：整组按 (chat, group)，单条按 (chat, message)。
    let item_key = match req.group_id {
        Some(g) => format!("g:{}:{}", req.chat_id, g),
        None => format!("m:{}:{}", req.chat_id, req.message_ids[0]),
    };
    let Some((task, created)) = st
        .store
        .enqueue_cache_task(req.chat_id, req.group_id, &item_key, &req.message_ids, &dir)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    else {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "enqueue cache task failed",
        ));
    };
    // 只有本次真正新建才起 worker；复用活跃任务时 worker 已在跑（重复起会双跑同组）。
    st.refresh_cache_tasks().await;
    if created {
        spawn_cache_task(st.clone(), task.id);
    }
    Ok(Json(task))
}

/// BUG-181：任务 JSON 注入条目内字节进度（仅 `running` 且字节归属当前任务时）。
///
/// `total == 0`（条目刚起步、总量未可知）不注入，前端按「无字节进度」渲染，
/// 避免 `0/0` 这类空洞分母出现。
fn task_with_progress(st: &AppState, t: &CacheTask) -> serde_json::Value {
    let mut v = serde_json::to_value(t).unwrap_or(serde_json::Value::Null);
    if v.is_object() && t.status == "running" {
        if let Some((bytes, total)) = st.cache_dl_progress(t.id) {
            if total > 0 {
                v["itemBytes"] = json!(bytes);
                v["itemBytesTotal"] = json!(total);
            }
        }
    }
    v
}

/// GET /api/tg/cache/tasks — 返回**当前唯一**任务（设计裁定：不论多少缓存在排队，
/// 这个端点只呈现**一个**进度）。选取顺序：running → 最老 queued → 最近一条已结束
/// （供前端收尾展示与失败提示）；队列为空且无历史时 `task: null`。
///
/// `queued`（BUG-181）：排队任务的**覆盖摘要**（id/chat/groupId/messageIds/total，
/// 不带进度——单飞呈现不变）。此前排队任务在该端点完全不可见：用户入队第二组时
/// 前端下 1 拍就被 running 任务覆盖回「未缓存」，呈现为「无法添加」。现在入队
/// 即有「排队中」反馈，仍是同一请求、同一事实源，不新增派生轮询。
///
/// **读路径 O(1)**：服务内存快照，不碰 SQLite。快照由每个 DB 写点同步刷新，
/// 与 worker 的写永远一致（见 `AppState::refresh_cache_tasks`）。
/// 这是前端 1s 轮询的高频端点——读走内存是流畅度的底线。
/// 任务端点响应体（`list_cache_tasks` 的内核，测试直接驱动）。
async fn cache_tasks_payload(st: &AppState) -> serde_json::Value {
    let tasks = st.cache_tasks_snapshot().await;
    // 单飞模型下快照里至多一个 running（+ 若干 queued）；按端点契约选出一个呈现。
    let task = tasks
        .iter()
        .find(|t| t.status == "running")
        .or_else(|| tasks.iter().find(|t| t.status == "queued"))
        .or_else(|| tasks.first())
        .cloned();
    let queued: Vec<serde_json::Value> = tasks
        .iter()
        .filter(|t| t.status == "queued")
        .take(20)
        .map(|t| {
            json!({
                "id": t.id,
                "chatId": t.chat_id,
                "groupId": t.group_id,
                "messageIds": t.message_ids,
                "total": t.total,
            })
        })
        .collect();
    json!({
        "task": task.as_ref().map(|t| task_with_progress(st, t)),
        "queued": queued,
    })
}

async fn list_cache_tasks(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(cache_tasks_payload(&st).await))
}

/// GET /api/tg/cache/tasks/all — 全量任务列表 + 各状态计数（缓存管理面板）。
/// 活跃优先、新→旧，上限 500；counts 覆盖全部状态（未出现为 0）。
async fn list_all_cache_tasks(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let tasks = st
        .store
        .list_cache_tasks(500)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let tasks: Vec<serde_json::Value> = tasks
        .iter()
        .map(|t| task_with_progress(&st, t))
        .collect();
    let mut counts = serde_json::Map::new();
    for s in ["queued", "running", "done", "failed", "cancelled", "interrupted"] {
        counts.insert(s.to_string(), json!(0));
    }
    for (s, n) in st
        .store
        .count_cache_tasks()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    {
        counts.insert(s, json!(n));
    }
    Ok(Json(json!({ "tasks": tasks, "counts": counts })))
}

/// GET /api/tg/cache/tasks/:id — 读取单个任务（轮询用，避免每次拉全量列表）。
async fn cache_task_by_id(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    match st.store.get_cache_task(id).await {
        Ok(Some(t)) => Ok(Json(task_with_progress(&st, &t))),
        Ok(None) => Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found")),
        Err(e) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())),
    }
}

/// DELETE /api/tg/cache/tasks/:id — 取消缓存任务（worker 在下一条目间隙退出）。
async fn cancel_cache_task_route(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let hit = st
        .store
        .cancel_cache_task(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !hit {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no active cache task with this id",
        ));
    }
    st.push_log(format!("/api/tg/cache/tasks/{id}: cancel requested"));
    st.refresh_cache_tasks().await;
    Ok(Json(json!({ "ok": true })))
}

/// 启动后台缓存 worker：**全局单飞**——同一时刻至多一个 worker 协程在跑，
/// 跑完当前任务后按 FIFO 接续最老的 `queued` 任务，直到队列清空。
///
/// 设计裁定（用户）：不论多少缓存在排队，`task` 端点只呈现**一个**当前任务；
/// 与之配套，执行侧也必须是单飞——否则多 worker 并发写进度会把「1s 一次」
/// 的节拍打碎成「1s 多次状态变化」。
///
/// 幂等跳过语义：已缓存条目（DB 标记 + 文件确实存在）直接计为完成，
/// **「继续」因此是真正的续跑剩余条目，而不是从头重下**。
pub fn spawn_cache_task(st: Arc<AppState>, task_id: i64) {
    // 单飞门禁：已有 worker 在跑时，新任务保持 `queued`，由在跑 worker 收尾时接续。
    if !st.claim_cache_worker() {
        return;
    }
    tokio::spawn(async move {
        let mut current = task_id;
        loop {
            run_one_cache_task(&st, current).await;
            // 当前任务到达终态（done/failed/cancelled）——接续队列里最老的 queued。
            match st.store.next_queued_task().await {
                Ok(Some(next)) => current = next.id,
                _ => break,
            }
        }
        st.release_cache_worker();
    });
}

// ---- 缓存任务的元数据登记（byte-ownership P1：事实先登记，设计 I1） ----

/// 消息元数据 → 规范 kind（T0 登记与组预扫共用的同一把尺子）。
///
/// `media_type` 由 grammers 从 mime 派生（`video/*` → "video" 等，见
/// `grammers::classify_media`），两列同源；v0.4.0 迁移前的历史行 `media_type`
/// 为 NULL → 回退 mime 前缀，再不行按 `file`。与旧实现入库的 mime 兜底链一致。
/// 扩展名分类在字节落盘后由 `backfill_item_bytes` 校正——T0 时还没有文件可判。
fn meta_kind(media_type: Option<&str>, mime_type: Option<&str>) -> String {
    match media_type {
        Some("photo") | Some("video") | Some("audio") => media_type.unwrap().to_string(),
        _ => match mime_type {
            Some(m) if m.starts_with("video/") => "video".to_string(),
            Some(m) if m.starts_with("image/") => "photo".to_string(),
            Some(m) if m.starts_with("audio/") => "audio".to_string(),
            _ => "file".to_string(),
        },
    }
}

/// 落盘路径的扩展名（无扩展名为空串）——`classify_ext` 的入参。
fn path_ext(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// 逐任务登记上下文（metadata-first ingest 的状态机）。
///
/// 职责：把旧实现「任务末尾一次性 `append_episodes_ranged` + 照片归属」的**最终
/// 库状态**逐消息就地复现（等价性论证）：
///   - 非照片条目：T0 即建剧集槽位。`append_episodes_ranged` 的占用快照/去重/
///     墓碑每次调用都从库中重读，`next` 游标等价演进——**同序**下逐条追加与
///     整批追加产生相同落位，故逐条登记 ≡ 任务末批量登记。
///   - 混编组照片（BUG-168）：挂到「组内它之前最近的**非照片**条目」所在集，
///     组首照片归首个非照片条目那一集（旧实现同一规则，目标池同为 media_pairs
///     = 非照片条目，不限于 video）。目标由全组消息预扫确定；目标条目登记槽位
///     的瞬间即挂（`add_episode_image` insert-or-ignore，幂等）。
///   - photo-only 组（组内无 video）：照片各自成「浏览位」episode（BUG-044），
///     同样吃 caption 集号区间（旧实现非混编时 media_pairs 含全部条目）。
struct IngestCtx {
    task_id: i64,
    chat_id: i64,
    /// 全组消息号（first_caption / 剧集幂等键用）。
    task_msgs: Vec<i64>,
    task_group: Option<i64>,
    created_at: i64,
    /// 组内非照片消息号（预扫）——混编组照片的归属目标全集。
    slot_msgs: Vec<i64>,
    /// 组内是否含 video（预扫）——区分混编组与 photo-only 组。
    has_video: bool,
    /// 已登记槽位的非照片条目：message_id → item_id。
    registered: HashMap<i64, i64>,
    /// 照片挂起表：(目标消息号, photo_msg, photo_item)，目标登记槽位时即挂。
    pending: Vec<(i64, i64, i64)>,
    /// (message_id, item_id) 登记序——标签归档用（与旧 `ingested` 同义同序）。
    ingested: Vec<(i64, i64)>,
    series: Option<i64>,
    /// 刚 create 的剧集：首条挂不上要按旧语义回滚空壳（旧 create+append 的 n==0 分支）。
    series_fresh: bool,
    /// 剧集建立失败/回滚后不再重试（旧实现整批只尝试一次，逐条路径等价为一次）。
    series_blocked: bool,
}

impl IngestCtx {
    /// 任务开始时的预扫：确保组内每条消息的 tg_message 行就位（判型与 caption
    /// 离线可读——剧集标题取 `first_caption` 依赖它；未监控频道此前要等下载后才
    /// 补行，登记前移后必须在 T0 之前就位），再据 `meta_kind` 圈出归属目标池与
    /// has_video。元数据拉取失败的消息不阻断：行缺席时该消息不进目标池，T0 登记
    /// 退化为 file/无标题（与旧实现 meta 缺失同貌）。
    async fn prepare(st: &Arc<AppState>, task: &CacheTask) -> Self {
        for msg_id in &task.message_ids {
            if matches!(st.store.get_message(task.chat_id, *msg_id).await, Ok(Some(_))) {
                continue;
            }
            if let Ok(Some(m)) = st.client.message_meta(task.chat_id, *msg_id).await {
                let _ = st
                    .store
                    .upsert_message(
                        task.chat_id,
                        *msg_id,
                        m.caption.as_deref(),
                        m.mime_type.as_deref(),
                        m.size,
                        m.media_type.as_deref(),
                        m.date,
                        m.duration,
                        m.group_id,
                    )
                    .await;
            }
        }
        let mut slot_msgs = Vec::new();
        let mut has_video = false;
        for msg_id in &task.message_ids {
            let kind = match st.store.get_message(task.chat_id, *msg_id).await {
                Ok(Some(m)) => meta_kind(m.media_type.as_deref(), m.mime_type.as_deref()),
                _ => continue,
            };
            if kind != "photo" {
                slot_msgs.push(*msg_id);
            }
            has_video |= kind == "video";
        }
        Self {
            task_id: task.id,
            chat_id: task.chat_id,
            task_msgs: task.message_ids.clone(),
            task_group: task.group_id,
            created_at: task.created_at,
            slot_msgs,
            has_video,
            registered: HashMap::new(),
            pending: Vec::new(),
            ingested: Vec::new(),
            series: None,
            series_fresh: false,
            series_blocked: false,
        }
    }

    /// T0 事实登记：media_item 行（`file_path=NULL` 待回填），返回 (item_id, 库中 kind)。
    ///
    /// kind 以**库中值**为准：重复登记（重试/幂等重跑）的旧条目保留既有 kind——
    /// 与旧实现 `item_kinds` 取数同源；新建条目写入 T0 判定的 kind（字节未落，
    /// 无扩展名可判）。登记失败返回 None（不阻断任务——旧实现入库失败同样只记日志）。
    async fn register_item(
        &self,
        st: &Arc<AppState>,
        msg_id: i64,
        photo_rule: bool,
    ) -> Option<(i64, String)> {
        let ref_key = format!("{}:{}", self.chat_id, msg_id);
        let row = st.store.get_message(self.chat_id, msg_id).await.ok().flatten();
        let kind = match &row {
            Some(m) => meta_kind(m.media_type.as_deref(), m.mime_type.as_deref()),
            None => "file".to_string(),
        };
        let id = match st.store.item_id_by_ref("tg", &ref_key).await {
            Ok(Some(id)) => id,
            _ => {
                // 新登记：file_path=NULL 是 T0 的核心语义（字节未落，事实先在）。
                // 标题只取 caption 首行（split_caption），其余进 description——
                // 与剧集、与旧 import_cached_file/import_photo_item 同一把尺子。
                let (title, desc) = row
                    .as_ref()
                    .and_then(|m| m.caption.as_deref())
                    .map(crate::media::split_caption)
                    .unwrap_or((None, None));
                // BUG-049 照片条目的可读兜底标题（旧 import_photo_item 同款）；
                // 非照片维持空串（BUG-154：不拿内部文件名伪装标题）。
                let title = match title {
                    Some(t) => t,
                    None if photo_rule => format!("TG 图片 #{msg_id}"),
                    None => String::new(),
                };
                match st
                    .store
                    .upsert_media_item(
                        "tg",
                        &ref_key,
                        &title,
                        &kind,
                        None,
                        row.as_ref().and_then(|m| m.size),
                        row.as_ref().and_then(|m| m.duration),
                        desc.as_deref(),
                    )
                    .await
                {
                    Ok(id) => id,
                    Err(e) => {
                        st.push_log(&format!("cache ingest failed for {ref_key}: {e}"));
                        return None;
                    }
                }
            }
        };
        let kind = st
            .store
            .item_kinds(&[id])
            .await
            .ok()
            .and_then(|m| m.get(&id).cloned())
            .unwrap_or(kind);
        Some((id, kind))
    }

    /// T0 槽位登记：非照片条目编入剧集；混编组照片挂目标集图片位；
    /// photo-only 组照片自成浏览位 episode。每次登记都幂等
    /// （`append_episodes_ranged` 跳过已收录条目、墓碑照拦；挂图 insert-or-ignore）。
    async fn register_slot(&mut self, st: &Arc<AppState>, msg_id: i64, item_id: i64, kind: &str) {
        self.ingested.push((msg_id, item_id));
        if kind == "photo" {
            self.register_photo_slot(st, msg_id, item_id).await;
            return;
        }
        // 非照片：一槽一位（混编/纯视频/photo-only 组同规则，旧 media_pairs 同义）。
        let range = self.caption_range(st, msg_id).await;
        self.append_slot(st, item_id, range).await;
        // 目标就是我：挂起照片此刻落位（旧实现在任务末尾按消息序统一挂，
        // 每集内 `add_episode_image` 的 sort_no 演进与此一致）。
        let due: Vec<(i64, i64)> = self
            .pending
            .iter()
            .filter(|(vm, _, _)| *vm == msg_id)
            .map(|(_, pm, pi)| (*pm, *pi))
            .collect();
        if !due.is_empty() {
            if let Some(sid) = self.series {
                for (pm, pi) in due {
                    self.attach_photo(st, sid, item_id, pm, pi).await;
                }
            }
            self.pending.retain(|(vm, _, _)| *vm != msg_id);
        }
        self.registered.insert(msg_id, item_id);
    }

    /// 混编组照片归属（BUG-168 语义，与旧实现逐字节同规则）：
    /// 组内消息序中它之前最近的**非照片**条目所在集；之前没有 → 组首照片，
    /// 归首个非照片条目那一集（旧实现的 max-then-min 回退）。目标已登记就当场挂，
    /// 否则入挂起表等目标登记（处理顺序即消息顺序，逐条处理时归属都能就地判定）。
    /// 整组无 video（photo-only）→ 自成浏览位 episode（BUG-044）。
    async fn register_photo_slot(&mut self, st: &Arc<AppState>, msg_id: i64, item_id: i64) {
        if !self.has_video {
            // 旧 mixed 判定 = 组内含 video 才挂图；无 video 的组照片仍是独立集
            //（即便组里混着 file/audio——旧 media_pairs 在非混编时含全部条目）。
            let range = self.caption_range(st, msg_id).await;
            self.append_slot(st, item_id, range).await;
            return;
        }
        let target = self
            .slot_msgs
            .iter()
            .copied()
            .filter(|m| *m < msg_id)
            .max()
            .or_else(|| self.slot_msgs.iter().copied().min());
        let Some(target_msg) = target else {
            // 组内没有任何非照片条目：不可能走到（has_video ⇒ slot_msgs 非空），
            // 防御性兜底为自成 episode。
            let range = self.caption_range(st, msg_id).await;
            self.append_slot(st, item_id, range).await;
            return;
        };
        match self.registered.get(&target_msg) {
            Some(&target_item) => {
                if let Some(sid) = self.series {
                    self.attach_photo(st, sid, target_item, msg_id, item_id)
                        .await;
                }
            }
            None => self.pending.push((target_msg, msg_id, item_id)),
        }
    }

    async fn attach_photo(
        &self,
        st: &Arc<AppState>,
        sid: i64,
        target_item: i64,
        photo_msg: i64,
        photo_item: i64,
    ) {
        match st.store.episode_id_of_item(sid, target_item).await {
            Ok(Some(eid)) => {
                if let Err(e) = st.store.add_episode_image(eid, photo_item).await {
                    st.push_log(&format!("attach photo {photo_msg} to episode {eid}: {e}"));
                }
            }
            Ok(None) => {}
            Err(e) => st.push_log(&format!("find episode for item {target_item}: {e}")),
        }
    }

    /// caption 集号区间（BUG-039）：解析不出交给顺序编号。旧 `ranged_items`
    /// 的单条版——同一条 `parse_episode_range`，区间与已占槽位冲突时由
    /// `append_episodes_ranged` 自动回退，不会覆盖既有编排。
    async fn caption_range(&self, st: &Arc<AppState>, msg_id: i64) -> Option<(i64, i64)> {
        match st.store.get_message(self.chat_id, msg_id).await {
            Ok(Some(m)) => m
                .caption
                .as_deref()
                .and_then(crate::media::parse_episode_range)
                // BUG-205：单集优先。caption 解析出的「合集终点」一律丢弃，只保留起点作为单集集号；
                // 「合集（多集）」只能由用户在编辑面板里手动设置，自动入库绝不生成范围。
                .map(|(s, _e)| (s, s)),
            _ => None,
        }
    }

    /// 单条槽位追加（自动路径内核 `append_episodes_ranged`，season=1 与旧实现相同）。
    async fn append_slot(&mut self, st: &Arc<AppState>, item_id: i64, range: Option<(i64, i64)>) {
        let Some(sid) = self.ensure_series(st).await else {
            return;
        };
        let fresh = self.series_fresh;
        match st
            .store
            .append_episodes_ranged(sid, 1, &[(item_id, range)])
            .await
        {
            Ok(0) if fresh => {
                // 旧语义：新建剧集一条都没挂上 = 归档失败，回滚空壳并封锁重建
                //（墓碑拦截的条目不会被自动路径复活——旧整批路径同一分支）。
                self.rollback_series(st, sid, "0 episodes attached").await;
            }
            // Ok(0) 非新建 = 已在季内（重复登记/墓碑），幂等，与旧批量去重同义。
            Ok(_) => {
                if fresh {
                    st.push_log(&format!(
                        "cache task {}: series {sid} registered (metadata-first)",
                        self.task_id
                    ));
                }
                self.series_fresh = false;
            }
            Err(e) => {
                st.push_log(&format!("cache task {}: append episodes: {e}", self.task_id));
                if fresh {
                    self.rollback_series(st, sid, &e.to_string()).await;
                }
            }
        }
    }

    /// 幂等建立/复用任务剧集：标题（caption → 规范化，BUG-152）、幂等键
    ///（相册 group_id 优先）、kind=series 全部与旧实现同源。
    async fn ensure_series(&mut self, st: &Arc<AppState>) -> Option<i64> {
        if let Some(sid) = self.series {
            return Some(sid);
        }
        if self.series_blocked {
            return None;
        }
        // 剧集标题与介绍来自**组内 caption**：首行标题、其余介绍（split_caption）。
        let (title, desc) = match st
            .store
            .first_caption(self.chat_id, &self.task_msgs)
            .await
            .unwrap_or(None)
        {
            Some(cap) => crate::media::split_caption(&cap),
            None => (None, None),
        };
        // BUG-152：剧集名由 caption 的**规范化剧集名**（去集号）决定；无 caption
        //（或首行为空）才回退「频道名 · 日期」；剥完为空同样回退（空标题不可辨识）。
        let title = match title {
            Some(t) => normalized_series_name(&t),
            None => {
                let base = channel_title(st, self.chat_id)
                    .await
                    .unwrap_or_else(|| format!("TG {}", self.chat_id));
                format!("{base} · {}", ymd_str(self.created_at as u64))
            }
        };
        let title = if title.trim().is_empty() {
            let base = channel_title(st, self.chat_id)
                .await
                .unwrap_or_else(|| format!("TG {}", self.chat_id));
            format!("{base} · {}", ymd_str(self.created_at as u64))
        } else {
            title
        };
        // 幂等键优先用 TG 相册 group_id（与入队去重键 `g:{chat}:{group}` 同源）；
        // 退化时用首条消息号（旧实现同款）。
        let key = match self.task_group {
            Some(g) => format!("tg:group:{}:{}", self.chat_id, g),
            None => {
                let first = self.task_msgs.first().copied().unwrap_or(0);
                format!("tg:msgs:{}:{}", self.chat_id, first)
            }
        };
        match st.store.find_series_by_source_key(&key).await {
            Ok(Some(sid)) => {
                // BUG-152：追加批次**不静默覆盖**已有标题；留痕便于诊断候选与现状差异。
                if let Ok(Some(cur)) = st.store.get_series(sid).await {
                    if cur.series.title != title {
                        tracing::debug!(
                            "BUG-152 series {sid} title kept as {:?}; batch candidate {:?} ignored \
                             (source_key={key})",
                            cur.series.title,
                            title
                        );
                    }
                }
                self.series = Some(sid);
                self.series_fresh = false;
                Some(sid)
            }
            Ok(None) => {
                // kind 恒为 `series`：剧集是任意内容的编排容器（含图片浏览位）。
                match st
                    .store
                    .create_series(&title, desc.as_deref(), "series", None, Some(&key))
                    .await
                {
                    Ok(sid) => {
                        self.series = Some(sid);
                        self.series_fresh = true;
                        Some(sid)
                    }
                    Err(e) => {
                        st.push_log(&format!("cache task {}: create series: {e}", self.task_id));
                        self.series_blocked = true;
                        None
                    }
                }
            }
            Err(e) => {
                st.push_log(&format!("cache task {}: find series: {e}", self.task_id));
                self.series_blocked = true;
                None
            }
        }
    }

    /// 回滚刚建的空壳剧集：**低层** `delete_series`（不碰墓碑，BUG-126）——
    /// 删的是刚重建出来的空壳，用户的「已摘除」记录必须留下（旧实现同款注释）。
    async fn rollback_series(&mut self, st: &Arc<AppState>, sid: i64, why: &str) {
        st.push_log(&format!(
            "cache task {}: series {sid} rolled back ({why})",
            self.task_id
        ));
        if let Err(e) = st.store.delete_series(sid).await {
            st.push_log(&format!(
                "cache task {}: rollback series {sid} failed: {e}",
                self.task_id
            ));
        }
        self.series = None;
        self.series_fresh = false;
        self.series_blocked = true;
    }

    /// 任务收尾：残留挂起照片如实留痕。只有目标条目 T0 登记失败才会走到这里
    ///（正常路径目标先于照片登记并即时落位）；重试任务的登记幂等会补齐归属。
    async fn finish(&self, st: &Arc<AppState>) {
        for (vm, pm, _) in &self.pending {
            st.push_log(&format!(
                "cache task {}: photo {pm} pending on unregistered target {vm} (retry will re-attach)",
                self.task_id
            ));
        }
    }
}

/// 跑单个任务直到终态（done / failed / cancelled）。
/// 单次自动归档的标签数上限（防个别刷屏消息带来成百上千标签）。
const MAX_AUTO_TAGS: usize = 20;

async fn run_one_cache_task(st: &Arc<AppState>, task_id: i64) {
    let Ok(Some(task)) = st.store.get_cache_task(task_id).await else {
        return;
    };
    let _ = st.store.mark_cache_task_running(task_id).await;
    st.refresh_cache_tasks().await;
    st.push_log(format!(
        "cache task {task_id}: start {} item(s) chat={}",
        task.total, task.chat_id
    ));
    let dir = resolve_cache_dir(st, None).await;
    let mut done: i64 = 0;

    // ── byte-ownership P1（设计 I1「事实先登记」）─────────────────────────────
    // 登记从「任务终态一次性 append_episodes_ranged」前移到「逐消息取字节之前」：
    // 任务开始处理某条消息时，先建立 media_item 行（file_path=NULL 待回填）与
    // 剧集槽位（T0，瞬间），再取字节；落盘成功后用 `backfill_item_bytes` 专用
    // 语句回填（不走 COALESCE upsert——MEDIA-DESIGN C3：那会粘住旧路径）。
    // 下载失败 → 条目保留缺字节、任务 failed，登记不撤销（重试只重做字节）。
    // 这正是「缓存→不见了→完成→出现」闪烁的根治：条目自 T0 起持续可见。
    let mut ing = IngestCtx::prepare(st, &task).await;
    for msg_id in task.message_ids.iter().copied() {
        if !st.store.is_cache_task_active(task_id).await.unwrap_or(false) {
            st.push_log(format!(
                "cache task {task_id}: cancelled at {done}/{}",
                task.total
            ));
            // 事实不回滚：已登记条目保留；未落位的挂起照片留给下次任务补齐。
            ing.finish(st).await;
            return;
        }
        let _ = st
            .store
            .update_cache_task_progress(task_id, done, Some(msg_id))
            .await;
        st.refresh_cache_tasks().await;
        // 类型判定（BUG-049 photo 规则分支用）：tg_message 行的 media_type 优先
        //（预扫已保证行就位，离线可判）；缺行才 RPC 取元数据（旧实现同款兜底）。
        // caption 顺带取出（P2 归仓文件命名 titleSlug 用，同一行不查两次）。
        let (media_type, tg_caption) = match st.store.get_message(task.chat_id, msg_id).await {
            Ok(Some(m)) => (m.media_type, m.caption),
            _ => {
                let meta = st
                    .client
                    .message_meta(task.chat_id, msg_id)
                    .await
                    .ok()
                    .flatten();
                let media_type = meta.as_ref().and_then(|m| m.media_type.clone());
                let caption = meta.map(|m| m.caption).flatten();
                (media_type, caption)
            }
        };
        let photo_rule = media_type.as_deref() == Some("photo");

        if let Some(path) = cached_path(st, task.chat_id, msg_id).await {
            // 已缓存：字节在盘上。条目可能已入库，仍要进剧集（避免整组里缺这几集）；
            // 查不到 ref = 已落盘但从未入库（历史缓存/换库后丢失）——T0 登记在此补上。
            let registered = ing.register_item(st, msg_id, false).await;
            if let Some((item, kind)) = &registered {
                ing.register_slot(st, msg_id, *item, kind).await;
            }
            if let Some((item, _)) = &registered {
                let ext = path_ext(&path);
                let _ = st
                    .store
                    .backfill_item_bytes(*item, &path, crate::media::classify_ext(&ext))
                    .await;
            }
            done += 1;
            let _ = st.store.update_cache_task_progress(task_id, done, None).await;
            st.refresh_cache_tasks().await;
            continue;
        }
        // BUG-049 规则：图片不缓存——不落盘，T0 登记为浏览条目（字节由 raw 端点
        // 现场代理 TG 缩略图）。已落盘的历史图片走上面的 cached_path 分支保留本地文件。
        let registered = ing.register_item(st, msg_id, photo_rule).await;
        if let Some((item, kind)) = &registered {
            ing.register_slot(st, msg_id, *item, kind).await;
        }
        if photo_rule {
            st.push_log(&format!(
                "cache task {task_id}: photo {msg_id} registered to library (no cache by rule)"
            ));
            done += 1;
            let _ = st.store.update_cache_task_progress(task_id, done, None).await;
            st.refresh_cache_tasks().await;
            continue;
        }
        match cache_one_bytes(st, Some(task_id), task.chat_id, msg_id, &dir).await {
            Ok(outcome) => {
                match &registered {
                    Some((item, _)) => {
                        // byte-ownership P2（I2 归仓）：先把字节**移动**进库根
                        //（失败自动降级：留原位、回填绝对路径，见 house_downloaded_bytes），
                        // 再用专用语句回填 `file_path` = 库根相对路径（不走 COALESCE
                        // upsert——MEDIA-DESIGN C3：那会粘住旧路径）；kind 顺手对齐
                        // 到扩展名分类（T0 时无文件可判）。
                        let housed = crate::cache::house_downloaded_bytes(
                            st,
                            task.chat_id,
                            msg_id,
                            &outcome.path,
                            tg_caption.as_deref(),
                        )
                        .await;
                        // 归仓移动后原落盘位置已空：tg 消息侧的缓存路径必须跟着
                        // 指到真实文件，否则 `cached_path` 幂等判定会误判「未缓存」。
                        let _ = st
                            .store
                            .mark_downloaded(task.chat_id, msg_id, Some(&housed.absolute_path))
                            .await;
                        let ext = path_ext(&housed.absolute_path);
                        let _ = st
                            .store
                            .backfill_item_bytes(
                                *item,
                                &housed.item_path,
                                crate::media::classify_ext(&ext),
                            )
                            .await;
                    }
                    None => {
                        // T0 登记失败（DB 故障）——退回旧「下载即入库」兜底一次。
                        import_cached_file(st, task.chat_id, msg_id, &outcome.path).await;
                    }
                }
                done += 1;
                let _ = st.store.update_cache_task_progress(task_id, done, None).await;
                st.refresh_cache_tasks().await;
            }
            Err(e) => {
                let reason = e.message().to_string();
                st.push_log(format!("cache task {task_id}: failed on {msg_id}: {reason}"));
                let _ = st
                    .store
                    .finish_cache_task(task_id, "failed", Some(&reason))
                    .await;
                st.refresh_cache_tasks().await;
                // 事实不回滚：已登记条目（含缺字节的当前条目）全部保留；
                // 未落位的挂起照片如实留痕，重试任务幂等补齐。
                ing.finish(st).await;
                return;
            }
        }
    }
    let _ = st.store.finish_cache_task(task_id, "done", None).await;
    ing.finish(st).await;
    let item_ids: Vec<i64> = ing.ingested.iter().map(|(_, id)| *id).collect();

    // ③b：组内 caption 的 `#标签` 收集（BUG-045：与成剧**解耦** —— 任何缓存任务
    // 都收集，不再只限 ≥2 条的组）。跨消息去重、带上限；归档目标见下方分支。
    let tags = st
        .store
        .collect_hash_tags(task.chat_id, &task.message_ids, MAX_AUTO_TAGS)
        .await
        .unwrap_or_default();

    // 剧集是**通用归档容器**（第 4 轮裁定）：单条视频、单张图片同样成剧；图片是
    // 剧集的**浏览位内容**；「播放时不许出现图片」由 `media_episode_source` 只收
    // video 的触发器结构性保证。
    //
    // byte-ownership P1：成剧/槽位/照片归属已随逐消息登记**前移**到 T0（见
    // `IngestCtx::append_slot` / `register_photo_slot` / `ensure_series`）——语义与
    // 旧「任务末尾一次性 append_episodes_ranged + 统一挂图」的最终库状态等价：
    // BUG-168 混编组照片归它之前最近的非照片条目所在集（组首归首个）、photo-only
    // 组照片各自成集、caption 集号区间照旧生效；条目 kind 逐条以库中值为准。
    // 已有历史数据不做回填。

    // 标签归档：剧集与条目**同时**归档（union 语义，不清空手工标签、不产生重复关联）。
    //
    // 此前是「有剧集→只写剧集，没剧集→只写条目」的二选一，于是条目卡片永远显示 0 个
    // 标签（用户看到的就是「标签被省略」）；改为两处都写，任一层视图都能看到标签。
    if !tags.is_empty() {
        if let Some(sid) = ing.series {
            match st.store.add_series_tags_by_name(sid, &tags).await {
                Ok(n) => st.push_log(&format!(
                    "cache task {task_id}: archived {n} new tag(s) to series {sid}"
                )),
                Err(e) => st.push_log(&format!("cache task {task_id}: archive tags: {e}")),
            }
        }
        let mut archived = 0usize;
        for iid in &item_ids {
            archived += st
                .store
                .add_item_tags_by_name(*iid, &tags)
                .await
                .unwrap_or(0);
        }
        if archived > 0 {
            st.push_log(&format!(
                "cache task {task_id}: archived {archived} new tag(s) onto {} item(s)",
                item_ids.len()
            ));
        }
    }
    st.refresh_cache_tasks().await;
    st.push_log(format!("cache task {task_id}: done {done}/{}", task.total));
}

/// Unix 秒 → `YYYY-MM-DD`（东八区）。
///
/// 不引 chrono：用 Howard Hinnant 的民用历算法（ERA/DOE/YOE 展开），纯整数运算，
/// 常数时间且无时区数据库依赖。固定 +8h 偏移即可满足「同频道多组缓存标题可区分」的需求。
fn ymd_str(secs: u64) -> String {
    const DAY: i64 = 86_400;
    let local = secs as i64 + 8 * 3600;
    let days = local.div_euclid(DAY);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// 频道标题（剧集命名用）：取不到返回 None。
async fn channel_title(st: &AppState, chat_id: i64) -> Option<String> {
    let chs = st.store.list_channels().await.ok()?;
    chs.into_iter()
        .find(|c| c.channel_id == chat_id)
        .map(|c| c.title)
        .filter(|t| !t.trim().is_empty())
}

// ---- 频道监控（本地库增删查 + 手动触发同步） ----

/// GET /api/tg/monitor/channels — 列出被监控频道。
async fn list_monitor_channels(
    State(st): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let chs = st
        .store
        .list_channels()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(chs))
}

#[derive(Deserialize)]
struct AddMonitorReq {
    #[serde(rename = "channelId")]
    channel_id: i64,
    title: String,
    #[serde(default)]
    username: Option<String>,
}

/// POST /api/tg/monitor/channels — 添加频道到监控（幂等）。
async fn add_monitor_channel(
    State(st): State<Arc<AppState>>,
    Json(req): Json<AddMonitorReq>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .add_channel(req.channel_id, &req.title, req.username.as_deref())
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.push_log(format!("/monitor add channel {} {}", req.channel_id, req.title));
    Ok(Json(json!({"ok": true})))
}

/// DELETE /api/tg/monitor/channels/:id — 移除监控频道（保留已入库消息）。
async fn remove_monitor_channel(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .remove_channel(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.push_log(format!("/monitor remove channel {id}"));
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct MonitorMsgQuery {
    #[serde(rename = "channelId")]
    channel_id: i64,
    #[serde(default = "default_limit")]
    limit: u32,
    /// 历史游标（exclusive）：只返回 message_id < beforeId；缺省取最新一页。
    #[serde(rename = "beforeId", default)]
    before_id: Option<i64>,
    /// 监控内容查找：caption 子串（非空时只查本地已同步消息，不触发网络回补）。
    #[serde(default)]
    q: Option<String>,
}

#[derive(Deserialize)]
struct MonitorSearchQuery {
    /// 监控内容查找关键词（caption 子串，必填；空串返回空集而非全量）。
    q: String,
    #[serde(default = "default_limit")]
    limit: u32,
}

/// GET /api/tg/monitor/search?q=.. — **全局**监控内容查找（跨全部监控频道）。
///
/// 与 `monitor_messages?q=`（单频道内查找）的定位不同：这是「从所有监控频道中
/// 筛出需要的内容」的入口——JOIN `monitored_channel` 限定范围并带出频道标题，
/// 按消息时间新→旧混排，前端按频道分组展示。同样只查本地已同步消息（查询语义，
/// 不做网络回补；未同步到的历史段落不保证命中）。
async fn monitor_search(
    State(st): State<Arc<AppState>>,
    Query(q): Query<MonitorSearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let sq = q.q.trim();
    let items = if sq.is_empty() {
        Vec::new()
    } else {
        st.store
            .search_monitored_messages(sq, q.limit.clamp(1, 200))
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    };
    Ok(Json(json!({ "items": items })))
}

/// GET /api/tg/monitor/messages?channelId=..&limit=..&beforeId=.. — 监控频道媒体（新→旧）。
///
/// v0.4.0 语义（本地真列表 + 在线回补，BUG-013/015）：
/// 1. 永远先查本地库（监控列表不受网络波动影响，秒开）；
/// 2. 本地不足一页时，按 `beforeId`（无则从最新）向 Telegram 回补一页**纯媒体**入库，
///    再重查本地；回补失败不致命——返回本地已有数据并记录日志；
/// 3. 返回 `{items, hasMore}`：未触发回补（本地已满页）保守为 true；
///    回补拉满一页为 true，拉空/不足为 false（到顶）。
async fn monitor_messages(
    State(st): State<Arc<AppState>>,
    Query(q): Query<MonitorMsgQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = q.limit.clamp(1, 100);
    let channel_id = q.channel_id;
    let anchor = q.before_id;

    let db_err = |e: libsql::Error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());

    // 监控内容查找：caption 子串 → 只查本地（搜索是查询语义，不做网络回补）。
    if let Some(sq) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let items = st
            .store
            .search_messages(channel_id, sq, anchor, limit)
            .await
            .map_err(db_err)?;
        let has_more = items.len() >= limit as usize;
        return Ok(Json(json!({ "items": items, "hasMore": has_more })));
    }

    let mut items = st
        .store
        .list_messages(channel_id, anchor, limit)
        .await
        .map_err(db_err)?;

    // 本地已满页：不请求网络（监控列表永远可读），hasMore 保守 true 留给下次滚动验证。
    let mut has_more = true;
    if items.len() < limit as usize {
        // 回补锚点：显式 beforeId 优先；否则用本地最旧一条的 id 继续往更早翻
        //（本地若有历史残留，避免只围绕最新拉取造成空洞）。
        let fetch_anchor = anchor.or_else(|| items.last().map(|m| m.message_id));
        match st.client.messages(channel_id, limit, fetch_anchor).await {
            Ok(fetched) => {
                let got = fetched.len();
                for it in &fetched {
                    st.store
                        .upsert_message(
                            channel_id,
                            it.id,
                            it.caption.as_deref(),
                            it.mime_type.as_deref(),
                            it.size,
                            it.media_type.as_deref(),
                            it.date,
                            it.duration,
                            it.group_id,
                        )
                        .await
                        .map_err(db_err)?;
                }
                // 回补后用同一游标重查本地，得到统一口径的一页。
                items = st
                    .store
                    .list_messages(channel_id, anchor, limit)
                    .await
                    .map_err(db_err)?;
                has_more = got >= limit as usize;
            }
            Err(e) => {
                // 离线/未授权/网络错误：不把本地列表打成 502，降级返回本地数据。
                st.push_log(format!(
                    "monitor/messages channel={channel_id} fallback local-only: {e}"
                ));
                has_more = false;
            }
        }
    }

    Ok(Json(json!({"items": items, "hasMore": has_more})))
}

/// POST /api/tg/monitor/sync — 手动触发一轮增量同步（调试/即时入库）。
async fn monitor_sync(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    match monitor::sync_once(&st).await {
        Ok(added) => Ok(Json(json!({"added": added}))),
        Err(e) => Err(ApiError::new(StatusCode::BAD_GATEWAY, &e)),
    }
}

#[derive(Deserialize)]
struct StoredMsgQuery {
    /// 关键词：匹配 caption / 频道标题 / 落盘路径。
    #[serde(default)]
    q: Option<String>,
    /// 媒体类型过滤（photo/video/audio/file）。
    #[serde(rename = "type", default)]
    media_type: Option<String>,
    /// `1` 时仅返回已缓存（downloaded = 1）；其余返回全部。
    #[serde(default)]
    downloaded: Option<u8>,
    /// 历史游标（exclusive）：只返回 message_id < beforeId。
    #[serde(rename = "beforeId", default)]
    before_id: Option<i64>,
    #[serde(default = "default_limit")]
    limit: u32,
}

/// GET /api/tg/stored?q=&type=&downloaded=1&beforeId=&limit= — 缓存库跨频道聚合视图（新→旧）。
///
/// 聚合全部监控频道已入库媒体（含未缓存行，供展示「缓存中/已缓存」状态与检索），
/// LEFT JOIN 监控频道补频道标题；频道取消监控后历史行仍可见（channelTitle 为 null）。
async fn stored(
    State(st): State<Arc<AppState>>,
    Query(q): Query<StoredMsgQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = q.limit.clamp(1, 200);
    let query = StoredQuery {
        downloaded_only: q.downloaded == Some(1),
        media_type: q.media_type.filter(|s| !s.is_empty()),
        q: q.q,
        before_id: q.before_id,
        limit,
    };
    let items = st
        .store
        .list_stored(&query)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // 拉满一页则可能还有更早历史；不足一页说明已到顶。
    let has_more = items.len() as u32 >= limit;
    Ok(Json(json!({"items": items, "hasMore": has_more})))
}

/// DELETE /api/tg/stored/:channel_id/:message_id — 清除该消息的本地缓存
/// （删字节 + `file_path` 置空 + 复位 downloaded；**媒体库条目保留**，可重新缓存）。
///
/// 修 BUG-051：此前顺带把媒体库条目一起删了——「清缓存」与「删条目」两个语义混在
/// 一条链上，正是清理链分裂的根源。现在：清缓存只动字节，删条目走
/// `DELETE /api/media/items/:id`（连字节一起删）。
async fn clear_stored(
    State(st): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, ApiError> {
    let removed = st
        .store
        .clear_downloaded(channel_id, message_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // 同步把媒体库条目的字节置空（保留行）——避免悬空 file_path 指向已删文件。
    if removed {
        if let Ok(Some(item_id)) = st
            .store
            .item_id_by_ref("tg", &format!("{channel_id}:{message_id}"))
            .await
        {
            let _ = st.store.set_item_file_path(item_id, None).await;
        }
    }
    st.push_log(&format!("/api/tg/stored/{channel_id}/{message_id} cleared={removed}"));
    Ok(Json(json!({"ok": true, "removed": removed})))
}

/// GET /api/tg/downloaded/:chat_id — 该频道已缓存清单：messageId → 落盘路径。
///
/// 这份清单直接决定前端 `local ? tgLocalFileUrl : tgFileUrl`（`TgPanel.tsx` 播放器取源），
/// 所以「在清单里」= 对外承诺「这个文件能本地播」。故 BUG-105 修在这里：
/// **承诺之前先 stat 磁盘**，DB 的 `downloaded` 标志位只说明「曾经下过」。
///
/// 三态处置：
/// - `Present` → 正常给出路径（本地播放）；
/// - `Missing` → 从清单剔除（本次即回落在线流，不会 404）+ 复位 DB 状态，
///   让「缓存 / 重新缓存」入口自然出现（这正是修复的核心目标，不是可选项）；
/// - `Unknown` → 从清单剔除（不承诺本地播）但**不动 DB**，且记一条日志。
///
/// 性能：本端点原本就是一次 DB 读，新增的只有 stat（文件系统，非 DB），
/// 没有把额外 DB 读带进轮询路径。复位写入只在**确认缺失**时发生，
/// 且复位后该行不再进入 `list_downloaded`，故一次收敛、不会每轮重复写。
async fn downloaded_map(
    State(st): State<Arc<AppState>>,
    Path(chat_id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let rows = st
        .store
        .list_downloaded(chat_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let mut map = serde_json::Map::new();
    let mut missing: Vec<i64> = Vec::new();
    let mut unknown = 0usize;
    for (id, path) in rows {
        // P2：库内规范形式（相对 = 库根相对）先解析再探测，口径与投递侧一致。
        let absolute = crate::cache::resolve_item_path(&st.store.library_root().await, &path)
            .to_string_lossy()
            .into_owned();
        match crate::cache::probe_cached_bytes(&absolute).await {
            crate::cache::BytesPresence::Present => {
                map.insert(id.to_string(), serde_json::Value::String(path));
            }
            crate::cache::BytesPresence::Missing => {
                missing.push(id);
            }
            crate::cache::BytesPresence::Unknown => {
                unknown += 1;
            }
        }
    }
    if unknown > 0 {
        st.push_log(format!(
            "downloaded_map channel={chat_id}: {unknown} cached path(s) unstatable; \
             treated as not-local WITHOUT resetting db state"
        ));
    }
    if !missing.is_empty() {
        let mut reset = 0usize;
        for id in &missing {
            // `clear_downloaded`：置空 file_path + 复位 downloaded（文件已不在，unlink 静默）。
            // 复位后前端所有派生自该标志的 UI（已缓存徽标、播放入口）一并返回未缓存态。
            if st.store.clear_downloaded(chat_id, *id).await.unwrap_or(false) {
                reset += 1;
            }
        }
        if reset > 0 {
            st.push_log(format!(
                "downloaded_map channel={chat_id}: {reset} cached row(s) reset to not-downloaded: \
                 bytes missing on disk"
            ));
        }
    }
    Ok(Json(json!({ "downloaded": map })))
}

/// 骨架阶段的登录态守卫：仅内存占位客户端已授权时放行。
/// 可用性前置检查：TG 不可用时返回 503 + 原因。
fn ensure_available(st: &AppState) -> Result<(), ApiError> {
    if let Availability::Unavailable(reason) = &st.availability {
        return Err(ApiError::unavailable(reason));
    }
    Ok(())
}

/// 授权前置检查。
///
/// **先查可用性，再查登录阶段**：TG 不可用时必须返回 503 + 原因，而不是 401「先登录」。
/// 顺序反了就会把「服务故障」伪装成「未登录」—— 这正是 BUG-023 里最误导人的一步：
/// 用户看到的是「登录没了、发不出验证码」，于是去重登，而真实原因是连不上 TG。
async fn ensure_authorized(st: &AppState) -> Result<(), ApiError> {
    ensure_available(st)?;
    let view = st.client.view().await;
    if view.phase != LoginPhase::Authorized {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "not authorized: login first",
        ));
    }
    Ok(())
}

// ---- 错误映射 ----

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: &str) -> Self {
        Self {
            status,
            message: message.to_string(),
        }
    }

    /// 错误文本（后台缓存任务据此把失败原因落库，供前端展示而非静默）。
    fn message(&self) -> &str {
        &self.message
    }

    /// TG 依赖不可用（503）：请求本身合法，是上游依赖不可用。
    /// 与 401「未登录」严格区分，避免故障被读成登录问题（BUG-023）。
    fn unavailable(reason: &str) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, reason)
    }
}

impl From<ClientError> for ApiError {
    fn from(e: ClientError) -> Self {
        let (status, msg) = match &e {
            ClientError::NotInitialized => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()),
            // TG 不可用：显式 503 + 原因（此前会退化为假客户端的 200/假数据）。
            ClientError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()),
            ClientError::InvalidCode | ClientError::InvalidPassword => {
                (StatusCode::UNAUTHORIZED, e.to_string())
            }
            ClientError::MediaNotFound => (StatusCode::NOT_FOUND, e.to_string()),
            ClientError::UnsatisfiableRange(_) => {
                (StatusCode::RANGE_NOT_SATISFIABLE, e.to_string())
            }
            ClientError::MissingPhone | ClientError::Other(_) => {
                (StatusCode::BAD_REQUEST, e.to_string())
            }
            ClientError::Network(_) => (StatusCode::BAD_GATEWAY, e.to_string()),
        };
        Self::new(status, &msg)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}

// ═════════════════════ 媒体资料库（内容 / 剧集 / 标签）═════════════════════
// 与 TG 流水（/api/tg/*）职责分离：这里是用户可增删改的**资料库**。

use crate::media::{
    classify_ext, scan_dir, split_caption, BundleError, EpisodeEdit, EpisodeMove, ItemPatch,
    ItemQuery, SeriesPatch,
};

/// `GET /api/media/items?kind=&q=&tagId=&seriesId=&unassigned=&sort=&limit=&offset=`
#[derive(Deserialize)]
struct MediaItemsQuery {
    kind: Option<String>,
    q: Option<String>,
    #[serde(rename = "tagId")]
    tag_id: Option<i64>,
    #[serde(rename = "seriesId")]
    series_id: Option<i64>,
    unassigned: Option<bool>,
    sort: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}

async fn list_media_items(
    State(st): State<Arc<AppState>>,
    Query(q): Query<MediaItemsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let query = ItemQuery {
        kind: q.kind.filter(|s| !s.is_empty()),
        q: q.q.filter(|s| !s.is_empty()),
        tag_id: q.tag_id,
        series_id: q.series_id,
        unassigned: q.unassigned.unwrap_or(false),
        sort: q.sort,
        limit: q.limit.unwrap_or(60),
        offset: q.offset.unwrap_or(0),
    };
    let items = st
        .store
        .list_media_items(&query)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let total = st
        .store
        .count_media_items(&query)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"items": items, "total": total})))
}

/// `GET /api/media/stats` — 资料库概览计数。
async fn media_stats(
    State(st): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let s = st
        .store
        .library_stats()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!(s)))
}

/// GET /api/media/export/preview?seriesIds=1,2,3 — 导出完备性校验（byte-ownership P5，只读）。
///
/// 逐剧集列出导出阻断项（缺字节/缺简介/缺图/零字节）；`seriesIds` 缺省 = 全库。
/// **一动词一端点**：这里是只读 preview，真正的导出动作属 P6 另端点 —— 校验
/// 不产生任何写副作用，可随意重复调用。
#[derive(Deserialize)]
struct ExportPreviewQuery {
    /// 逗号分隔的剧集 id；缺省/空 = 全库。
    #[serde(rename = "seriesIds", default)]
    series_ids: Option<String>,
}

async fn export_preview(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ExportPreviewQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ids: Option<Vec<i64>> = match q.series_ids.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.parse::<i64>().map_err(|_| {
                        ApiError::new(StatusCode::BAD_REQUEST, &format!("invalid seriesId: {s}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
    };
    let series = st
        .store
        .export_readiness(ids.as_deref())
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let mut by_kind: std::collections::BTreeMap<String, u64> = Default::default();
    let mut issues_total: u64 = 0;
    for s in &series {
        for i in &s.issues {
            *by_kind.entry(i.kind.to_string()).or_default() += 1;
            issues_total += 1;
        }
    }
    let series_ready = series.iter().filter(|s| s.issues.is_empty()).count();
    st.push_log(&format!(
        "/api/media/export/preview: {} series, {} issue(s) (ready {}/{})",
        series.len(),
        issues_total,
        series_ready,
        series.len()
    ));
    Ok(Json(json!({
        "series": series,
        "summary": {
            "seriesTotal": series.len(),
            "seriesReady": series_ready,
            "issuesTotal": issues_total,
            "byKind": by_kind,
        }
    })))
}

#[derive(Deserialize)]
struct ExportMediaReq {
    /// 缺省 = 全库（与 preview 契约一致）。
    #[serde(rename = "seriesIds", default)]
    series_ids: Option<Vec<i64>>,
    /// 导出包落盘目录（必须为空或不存在，避免覆盖用户数据）。
    #[serde(rename = "targetDir")]
    target_dir: String,
}

/// POST /api/media/export — EE 导出本体（byte-ownership P6）。
///
/// - 先走 `export_bundle` 内的完备性闸口：任何 issue 存在 → 422 + issue 清单
///   （前端据此把对话框复位到「补全问题」视图）。
/// - 目标目录非空 → 400；DB/IO/JSON 错误 → 500 并留痕。
/// - 导出是**复制**不是移动，库内字节保持不动。
async fn export_media(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ExportMediaReq>,
) -> Result<Response, ApiError> {
    if req.target_dir.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "targetDir is empty"));
    }
    let target = std::path::PathBuf::from(&req.target_dir);
    match st.store.export_bundle(req.series_ids.as_deref(), &target).await {
        Ok(r) => Ok(Json(json!(r)).into_response()),
        Err(BundleError::NotReady(reports)) => {
            // 不复用 ApiError：需要把 issue 清单一并回传，让前端复位到补全视图。
            let body = json!({
                "error": "export not ready: some series have missing bytes/description/image",
                "issues": reports,
            });
            Ok((StatusCode::UNPROCESSABLE_ENTITY, Json(body)).into_response())
        }
        Err(BundleError::BadTarget(m)) => {
            Err(ApiError::new(StatusCode::BAD_REQUEST, &m))
        }
        Err(other) => {
            st.push_log(&format!("/api/media/export failed: {other}"));
            Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &other.to_string()))
        }
    }
}

/// 导入请求体：批量条目（本地路径或 TG 引用）。
#[derive(Deserialize)]
struct ImportReq {
    items: Vec<ImportItem>,
}

#[derive(Deserialize)]
struct ImportItem {
    /// 绝对路径（本地导入）。
    path: Option<String>,
    /// TG 引用：`"<chat_id>:<message_id>"`。
    #[serde(rename = "ref")]
    tg_ref: Option<String>,
    /// source：local（默认）/ tg。
    source: Option<String>,
    title: Option<String>,
    /// 介绍（缺省时由 title/caption 切分推导 —— 见 `import_media_items`）。
    description: Option<String>,
    kind: Option<String>,
    size: Option<i64>,
    duration: Option<i64>,
}

/// `POST /api/media/items` — 批量导入（按 source+ref 幂等，重复导入不产生副本）。
async fn import_media_items(
    State(st): State<Arc<AppState>>,
    Json(body): Json<ImportReq>,
) -> Result<impl IntoResponse, ApiError> {
    let mut ids = Vec::new();
    for it in body.items {
        let source = it.source.clone().unwrap_or_else(|| "local".to_string());
        let (ref_key, path, title, kind, size) = if source == "tg" {
            let r = match it.tg_ref.clone() {
                Some(r) => r,
                None => continue,
            };
            // BUG-154：TG 引用 `"<chat_id>:<message_id>"` 是**内部标识**，不是标题。
            // 调用方没给 title 时此前落的就是它 → 展示层看到 `#<itemId>` 式的兜底。
            // 改为空串：真正的标题由下方「以流水 caption 为准」的服务端切分产出；
            // caption 也空则如实为空（与 `import_cached_file` 同一裁定）。
            (
                r.clone(),
                None,
                it.title.clone().unwrap_or_default(),
                it.kind.clone().unwrap_or_else(|| "file".to_string()),
                it.size,
            )
        } else {
            let p = match it.path.clone() {
                Some(p) => p,
                None => continue,
            };
            let name = std::path::Path::new(&p)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            let ext = std::path::Path::new(&p)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            let kind = it
                .kind
                .clone()
                .or_else(|| classify_ext(&ext).map(str::to_string))
                .unwrap_or_else(|| "file".to_string());
            let size = it.size.or_else(|| std::fs::metadata(&p).ok().map(|m| m.len() as i64));
            (p.clone(), Some(p), it.title.clone().unwrap_or(name), kind, size)
        };
        // 文本切分**在服务端收口**：TG 条目以流水里的原始 caption 为准（服务端是唯一真相源），
        // 调用方传来的 title 只作兜底。此前是让调用方自己决定 —— 侧栏「加入媒体库」
        // 直接把整段 caption 当 title 传进来，条目于是只有一坨原文、没有介绍位。
        // 现在任何入口都产出「标题 + 介绍」两栏，规则只此一处。
        let (title, description) = {
            let derived = if source == "tg" {
                match parse_tg_ref(&ref_key) {
                    Some((chat, msg)) => st.store.first_caption(chat, &[msg]).await.ok().flatten(),
                    None => None,
                }
            } else {
                None
            };
            let text = derived.unwrap_or(title);
            let (t, d) = split_caption(&text);
            (t.unwrap_or(text), it.description.clone().or(d))
        };
        let id = st
            .store
            .upsert_media_item(
                &source,
                &ref_key,
                &title,
                &kind,
                path.as_deref(),
                size,
                it.duration,
                description.as_deref(),
            )
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        ids.push(id);
    }
    st.push_log(&format!("/api/media/items imported {} item(s)", ids.len()));
    Ok(Json(json!({"ids": ids, "count": ids.len()})))
}

#[derive(Deserialize)]
struct ByRefQuery {
    source: String,
    #[serde(rename = "ref")]
    ref_key: String,
}

/// `GET /api/media/items/by-ref?source=tg&ref=<chat>:<msg>` — 按 (source,ref) 查条目。
/// BUG-049：前端据此判断图片是否已入库（已入库显「已入库」，否则给「加入媒体库」）。
async fn media_item_by_ref(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ByRefQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let id = st
        .store
        .item_id_by_ref(&q.source, &q.ref_key)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({ "id": id })))
}

/// `GET /api/media/items/:id`
async fn get_media_item(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let item = st
        .store
        .get_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    match item {
        Some(i) => Ok(Json(json!(i))),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "media item not found")),
    }
}

/// `PATCH /api/media/items/:id` — 改标题/封面/时长/尺寸/类型。
async fn patch_media_item(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<ItemPatch>,
) -> Result<impl IntoResponse, ApiError> {
    // 空标题显式拒绝（422），而不是静默当作「不改」：标题是条目主标识，客户端发空值
    // 一定是 bug，报出来才能被发现。数据侧另有一道防线（store 不会把空写成空串）。
    if let Some(t) = body.title.as_deref() {
        if t.trim().is_empty() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "title must not be empty",
            ));
        }
    }
    let ok = st
        .store
        .update_media_item(id, &body)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "media item not found"));
    }
    Ok(Json(json!({"ok": true})))
}

/// `DELETE /api/media/items/:id` — 从资料库移除（唯一清理链：**连字节一起删**）。
///
/// 只删**下载目录内**的字节（缓存自己产出的）；导入/扫描进来的外部文件不在下载
/// 目录内，永不删除——那些是用户自己的文件，不是缓存。
/// 修 BUG-051：此前只复位 TG 标记、不删文件，留下孤儿文件。
/// 修 BUG-135：两处失败**不再被 `let _ =` 吞掉**——BUG-109 已裁定「必须如实报错」，
/// 同仓 `cache::reset_tg_flag` 就是按这条规则写的，本函数此前与它自相矛盾：
/// - 清 TG `downloaded` 失败 → **中止**删除并 500。它失败会让条目被下次同步「复活」，
///   删除等于没删；「删了又回来」这个错误状态不允许存在，宁可报错也不能假装成功。
/// - 删字节失败 → **不中止**（用户意图优先；残留字节有兜底回收通道
///   `POST /api/cache/clear?scope=orphan`），但必须 warn 留痕（含路径与 io::Error）
///   并在响应里如实带 `bytesRemoved:false` / `bytesError`。
/// 修 BUG-162：**先判标记、再删字节**。清 TG `downloaded` 标记是**第一个**可能中止的
/// 检查点，必须排在任何破坏性动作（`remove_file`）之前——否则一旦标记清不掉，函数
/// 返回 500 时字节已被删，而 500 文案却自称 `nothing was deleted`（自相矛盾，且中止点
/// 落在破坏性动作之后）。顺序对调后，500 分支下**盘上一个字节未删、DB 行也原封不动**，
/// 文案与事实一致。
async fn delete_media_item(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    // 先取出来：既用于「删字节 + 清 TG 缓存副本」，也用于**如实回报删了几条**。
    let existing = st
        .store
        .get_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // 字节面默认「没有要删的字节 / 字节已不在」：条目无路径、外部文件（永不删）
    // 都落在这一档，只有**真的删失败**才翻成 false。
    let mut bytes_removed = true;
    let mut bytes_error: Option<String> = None;
    if let Some(item) = &existing {
        // BUG-162：**先判标记、再删字节**。清 TG `downloaded` 标记是第一个可能中止的
        // 检查点，必须排在 `remove_file` 之前 —— 否则标记清不掉时，函数在字节已删之后
        // 才返回 500，与文案 `nothing was deleted` 自相矛盾（中止点在破坏性动作之后）。
        //
        // 双向联动（TG 来源条目）：删媒体库条目 → 同步清 TG 缓存副本。
        // 否则下次缓存 upsert（按 source+ref 幂等）会把条目"复活"，看起来像删不掉。
        // 复用 `cache::reset_tg_flag`（唯一实现，清字节那条链也用它）：**失败即中止**，
        // 与本文件此前吞掉失败的做法相反——留一个清不掉的 `downloaded` 标记，
        // 等于把「删了又回来」这个 bug 固化成数据。
        if !crate::cache::reset_tg_flag(&st, &item.source, &item.ref_key).await {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!(
                    "cannot delete media item {id}: the tg downloaded flag could not be cleared \
                     (see server log), so the entry would reappear on the next sync; \
                     nothing was deleted"
                ),
            ));
        }
        // 标记已清除，才轮到破坏性动作：删**下载目录或库根内**的字节（外部文件永不删）。
        // P2 归仓字节在库根下（`file_path` 是库根相对路径），同样属本系统产出——
        // 删条目是唯一能带走它们的链（`cache/clear` 按 I3 对库根字节让路），漏掉
        // 这里就会留下无任何回收通道的孤儿。
        if let Some(p) = item.file_path.as_deref() {
            let dir = crate::cache::download_dir(&st).await;
            let lib_root = st.store.library_root().await;
            let absolute = crate::cache::resolve_item_path(&lib_root, p);
            let absolute_str = absolute.to_string_lossy().into_owned();
            let owned = crate::cache::inside_dir(&dir, &absolute_str)
                || crate::cache::inside_dir(&lib_root, &absolute_str);
            if owned {
                if let Err(e) = std::fs::remove_file(&absolute) {
                    bytes_removed = false;
                    bytes_error = Some(e.to_string());
                    let msg = format!(
                        "delete_media_item: remove_file failed for {absolute_str} (item {id}): {e}; \
                         entry deleted anyway, bytes left behind \
                         (reclaim via POST /api/cache/clear?scope=orphan)"
                    );
                    tracing::warn!("{msg}");
                    st.push_log(&format!("WARN {msg}"));
                }
            }
        }
    }
    st.store
        .delete_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // `removed:0` = 这条本来就不存在（**幂等删除**，不报 404）。必须如实区分：
    // 一个恒真的 `{"ok": true}` 会让调用方无法判断「删掉了」还是「本来就没有」。
    let mut body = json!({
        "ok": true,
        "removed": if existing.is_some() { 1 } else { 0 },
        "bytesRemoved": bytes_removed,
    });
    // 只在真的删失败时带上原因：成功路径不带空字段，调用方无需判空串。
    if let Some(e) = bytes_error {
        body["bytesError"] = json!(e);
    }
    Ok(Json(body))
}

/// 解析 TG 引用 `"<chat_id>:<message_id>"`（缓存即入库的 ref 约定）。
pub(crate) fn parse_tg_ref(r: &str) -> Option<(i64, i64)> {
    let (a, b) = r.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

/// 从 caption 的**标题行**里定位代表集号的那一段（BUG-152：剧集名 = 标题行去掉它）。
///
/// 返回 `Some((start, end))` = 集号段在 `title` 里的字节区间；无集号信号返回 `None`。
/// 调用方按 `[..start]` + `[end..]` 拼出剧名（见 [`normalized_series_name`]）。
///
/// 与 [`crate::media::parse_episode_range`] 共用同一套集号语法，但目的不同：那边只要
/// `(start, end)` 数字，这边要的是**可被剥掉的原文区间**。
///
/// 两步：
/// 1. **找锚点**（`#` / `EP` / `第`）：从左往右扫，命中锚点后吃掉紧跟的数字/连接符。
///    锚点是必需的 —— 剧名本身常含数字（`1990-2020 经典回顾`），没有锚点就无从区分
///    「集号」与「剧名里的数字」，宁可返回 `None` 也不误剥。
/// 2. **吃掉尾随噪声**：真实频道的 caption 惯例是「集号 + 推广文案」
///    （`… EP2 原档 内群抢先更新 连载中 ⭐⭐⭐`）。集号后面跟的往往不是剧名的一部分，
///    而是频道自带的宣传语与装饰符号，故一路吞到**下一个可能是剧名的片段**为止。
///
/// 已知取舍：第 2 步会吞掉集号之后的正文。这是刻意的 —— 集号是**归属信号**，它之后
/// 的文本属于「这一集」，而非「这部剧名」；保留它会让剧名随集数变化，重新引入
/// 本轮要修的非确定性。
fn episode_span(title: &str) -> Option<(usize, usize)> {
    let t = title.trim_end();
    // 锚点扫描：`EP`（大小写不敏感）/ `#` / `第` / 裸 `集`。
    for (idx, c) in t.char_indices() {
        let anchor_len = if c == '第' {
            c.len_utf8()
        } else if c == '#' {
            // BUG-156 交互：`#12` 是「行内孤立的 # 数字」集号标记
            // （同 `media::parse_episode_range` 形态 D），但 `#剧名` 的剧名**本身可以以
            // 数字开头**（`#18岁太奶奶驾到重整家族荣耀`）。两者的前缀在字面上完全一样，
            // 唯一的分界是**数字之后**：集号标记的数字是**独立 token**
            // （后面是空白/行尾），剧名的数字后面**紧跟文字**。
            // 因此这里要求 `#` 后的数字段必须被空白或行尾收尾；否则它不是集号锚点。
            if !hash_digits_are_standalone(t, idx) {
                continue;
            }
            c.len_utf8()
        } else if starts_with_ep(&t[idx..]) && ep_anchor_ok(t, idx) {
            // `EP` 是两字节前缀，锚点从 `idx + 2` 起算。
            2
        } else {
            continue;
        };
        let num_start = idx + anchor_len;
        // 锚点与数字之间允许空白：`EP 03` / `第 3-4 集`。
        let num_start = num_start + t[num_start..].len() - t[num_start..].trim_start().len();
        // 集号数字段：数字 + 连接符（含区间 `01-02`）。
        let digits_end = num_start
            + t[num_start..]
                .char_indices()
                .take_while(|(_, c)| is_ep_number_char(*c))
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
        let has_digit = t[num_start..digits_end].chars().any(|c| c.is_ascii_digit());
        if !has_digit {
            continue;
        }
        return Some((idx, digits_end));
    }
    // 无 `EP`/`#`/`第` 锚点：再认一次「纯数字 + 集」的写法（`10-20集合集`、`1-2集`）。
    // 单独放在锚点扫描之后，是为了让带锚点的写法（信息更明确）优先。
    bare_episode_span(t)
}

/// `t` 中位置 `idx`（一个 `#`）之后是否跟着「**独立数字 token**」——即 `#12` 形态的
/// 集号标记（BUG-156 交互修正）。
///
/// - `#12` / `#12 后续` → 数字后是空白或行尾 → **是**集号标记；
/// - `#18岁太奶奶…` / `#《异世界男妓》` → 数字后紧跟文字（或根本没有数字）→ **不是**，
///   它是 `#剧名`，`#` 必须留给标题。
///
/// 与 [`crate::media::parse_episode_range`] 形态 D 同规矩（那里也是「行内孤立的 `#` 数字」）。
fn hash_digits_are_standalone(t: &str, idx: usize) -> bool {
    let after = &t[idx + 1..];
    let digits: usize = after
        .char_indices()
        .take_while(|(_, c)| c.is_ascii_digit())
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    if digits == 0 {
        return false;
    }
    // 数字之后必须是空白或行尾才算独立 token。
    match after[digits..].chars().next() {
        None => true,
        Some(c) => c.is_whitespace() || c.is_ascii_punctuation(),
    }
}

/// `10-20集合集` / `1-2集` 这类**没有显式锚点**的写法：数字段后紧跟 `集`。
///
/// 之所以敢认「裸数字 + 集」：`集` 字本身就出现在数字右侧，是强信号；
/// 而 `1990-2020 经典回顾` 这类剧名里的数字后面**没有** `集`，不会命中。
fn bare_episode_span(t: &str) -> Option<(usize, usize)> {
    for (i, c) in t.char_indices() {
        if !c.is_ascii_digit() {
            continue;
        }
        // 数字段起点：前一个字符不能是字母数字（避免切进 `2020` 的中间）。
        if t[..i]
            .chars()
            .next_back()
            .map(|p| p.is_alphanumeric())
            .unwrap_or(false)
        {
            continue;
        }
        let digits_end = i
            + t[i..]
                .char_indices()
                .take_while(|(_, c)| is_ep_number_char(*c))
                .last()
                .map(|(j, c)| j + c.len_utf8())
                .unwrap_or(0);
        // 数字段之后可带空白，然后必须是 `集`。
        let after = &t[digits_end..];
        let ws = after.len() - after.trim_start().len();
        if after[ws..].starts_with('集') {
            return Some((i, digits_end));
        }
    }
    None
}

/// `s` 是否以 `EP`/`ep`/`Ep` 开头，且其前一步（由调用方的锚点扫描保证）不是字母数字。
/// 调用方在 `t.char_indices()` 里逐字符扫描，故这里只需认「以 EP 打头」；
/// `XEP2` 之类会把锚点落在 `E` 上，需要再挡一层「前一字符非字母数字」（`C#` 式误判防护）。
fn starts_with_ep(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].eq_ignore_ascii_case(&b'e') && b[1].eq_ignore_ascii_case(&b'p')
}

/// 位置 `idx` 处的 `EP` 锚点是否可信：前一个字符不能是字母数字
/// （`XEP2`、`работа.ep2` 之类是剧名/单词的一部分，不是独立集号标记）。
fn ep_anchor_ok(t: &str, idx: usize) -> bool {
    match t[..idx].chars().next_back() {
        Some(c) => !c.is_alphanumeric(),
        None => true,
    }
}

/// 集号数字段允许的字符：数字与区间连接符。
fn is_ep_number_char(c: char) -> bool {
    c.is_ascii_digit() || matches!(c, '-' | '~' | '～' | '—')
}

/// 剧集名规范化（BUG-152）：标题行去掉代表集号的那一段。
///
/// **剧名 = 集号之前的全部内容** —— 这是 Telegram 频道 caption 的稳定惯例
/// （`剧名 EP2 推广文案`）。集号之后的文字属于「这一集」的推销语/状态标注
/// （`原档`、`内群抢先更新`、`连载中`、`集合集`），不是剧名的一部分；一旦保留，
/// 剧名就会随集数变化，重新引入本轮要修的非确定性。因此这里**丢弃集号之后的一切**。
///
/// 若整个标题行都是集号（剥完为空），回退为原文的 trim 版本 —— 调用方
/// （`run_one_cache_task`）对空结果另有「频道名 · 日期」兜底，这里不做第二个兜底。
///
/// `pub(crate)`：BUG-156 的防再发要求断言打在**生产调用链**
/// `normalized_series_name(split_caption(cap).0)` 上，测试在 `media.rs` 侧。
pub(crate) fn normalized_series_name(title_line: &str) -> String {
    match episode_span(title_line) {
        Some((start, _end)) => {
            let name = title_line[..start].trim();
            if name.is_empty() {
                // 形如 `EP01` / `第5集`：整行就是集号 —— 交给调用方兜底。
                String::new()
            } else {
                name.to_string()
            }
        }
        None => title_line.trim().to_string(),
    }
}

#[derive(Deserialize)]
struct TagSetReq {
    #[serde(rename = "tagIds", default)]
    tag_ids: Vec<i64>,
}

async fn set_media_item_tags(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<TagSetReq>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .set_item_tags(id, &body.tag_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

/// 单次响应体上限（8 MiB）：超出则只回一段 206，浏览器会继续发后续 Range。
/// 客户端显式闭区间 `bytes=S-E` 的单次回包上限（安全阀）。
const MAX_CHUNK: u64 = 64 * 1024 * 1024;

/// open-ended（`bytes=S-`，播放主路径）的单次回包块大小。
///
/// 取值经过 A/B 实测（`verify_shots/diag_raw_wire.cjs`，缓存禁用、关前后端同条件）：
/// `EOF` / `8MiB` / `32MiB` 三档在**请求数**与**线上冗余**上无显著差异
/// （18/28/20 次；6.2x/5.8x/6.4x 冗余），前端 `preload` 改成 `metadata` 同样无变化。
/// 那 6x 冗余来自 Chromium 对「快源 + 大文件 + 可拖」的固有投机预读
/// （双读线程各自预取 ~10MiB 后再自行 `ERR_ABORTED`，`loadstart=1` 证明与前端重建元素无关），
/// **不是服务端 Range 语义的缺陷**，因此不再为它调参。
///
/// 取 32MiB 不变的理由只有两条，与上面那组数字无关：
///   1. 响应有界 —— 拖一次进度条不会吐出 244MiB 的单体响应；
///   2. 如实 `Content-Range` 让浏览器把区间写进媒体缓存（配合 ETag 复用已取字节）。
const OPEN_CHUNK: u64 = 32 * 1024 * 1024;

/// 解析 `Range: bytes=start-end`（仅取首段，忽略多段）。
/// 解析 `bytes=` 区间，返回 `(start, end, open_ended)`。
/// `open_ended` 表示客户端请求的是 `bytes=S-`（到结尾），播放主路径即此形态。
fn media_parse_range(hdr: Option<&str>, total: u64) -> Option<(u64, u64, bool)> {
    let h = hdr?;
    let v = h.strip_prefix("bytes=")?;
    let first = v.split(',').next()?.trim();
    let mut parts = first.splitn(2, '-');
    let s = parts.next()?.trim();
    let e = parts.next()?.trim();
    if s.is_empty() {
        // `bytes=-N`：最后 N 字节
        let n: u64 = e.parse().ok()?;
        if n == 0 || n > total {
            return None;
        }
        Some((total - n, total - 1, false))
    } else {
        let start: u64 = s.parse().ok()?;
        if start >= total {
            return None;
        }
        let (end, open) = if e.is_empty() {
            (total - 1, true)
        } else {
            let e: u64 = e.parse().ok()?;
            (e.min(total - 1), false)
        };
        if end < start {
            return None;
        }
        Some((start, end, open))
    }
}

/// `GET /api/media/items/:id/raw` — 按 id 流式读取落盘文件，支持 HTTP Range（拖动进度必需）。
async fn media_item_raw(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let item = st
        .store
        .get_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "media item not found"))?;
    let p = match item.file_path.clone() {
        Some(p) => p,
        None => {
            // BUG-049：图片不落盘 —— tg 图片条目现场代理 TG 缩略图字节（不持久化），
            // 媒体库/灯箱用同一个 mediaItemUrl 即可显示，无需感知「未缓存」状态。
            if item.source == "tg" && item.kind == "photo" {
                let parts: Vec<&str> = item.ref_key.splitn(2, ':').collect();
                if parts.len() == 2 {
                    if let (Ok(chat), Ok(msg)) =
                        (parts[0].parse::<i64>(), parts[1].parse::<i64>())
                    {
                        if let Ok(Some(t)) = st.client.thumb(chat, msg).await {
                            let mut res = Response::new(axum::body::Body::from(t.bytes));
                            res.headers_mut().insert(
                                header::CONTENT_TYPE,
                                HeaderValue::from_str(&t.content_type)
                                    .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg")),
                            );
                            res.headers_mut().insert(
                                header::CACHE_CONTROL,
                                HeaderValue::from_static("public, max-age=86400"),
                            );
                            return Ok(res);
                        }
                    }
                }
                return Err(ApiError::new(
                    StatusCode::NOT_FOUND,
                    "photo not cached and thumbnail unavailable",
                ));
            }
            return Err(ApiError::new(StatusCode::NOT_FOUND, "item has no local file"));
        }
    };
    // 与 TG 已缓存投递共用同一实现（serve_local_file）：Range / ETag / MIME 一处定义。
    // P2：file_path 是库内规范形式（相对 = 库根相对），投递前先解析。
    let lib_root = st.store.library_root().await;
    let p = crate::cache::resolve_item_path(&lib_root, &p).to_string_lossy().into_owned();
    serve_local_file(&p, Some(item.kind.as_str()), item.duration, &headers).await
}

// ---- 兼容流（BUG-208）：浏览器解不动的编码（实测整类 HEVC）按需转码 ----

/// Transcode variant: None is the legacy compatibility proxy; Some is a speed FRC variant.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct TranscodeKey {
    item_id: i64,
    speed_hundredths: Option<u16>,
}

type TranscodeDone = tokio::sync::watch::Receiver<bool>;
static TRANSCODE_INFLIGHT: std::sync::OnceLock<
    std::sync::Mutex<HashMap<TranscodeKey, TranscodeDone>>,
> = std::sync::OnceLock::new();

fn transcode_inflight() -> &'static std::sync::Mutex<HashMap<TranscodeKey, TranscodeDone>> {
    TRANSCODE_INFLIGHT.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Only accept declared player rates; never interpolate arbitrary input into FFmpeg filters.
fn parse_stream_speed(speed: Option<&str>) -> Result<Option<u16>, ApiError> {
    match speed {
        None | Some("1") => Ok(None),
        Some("0.5") => Ok(Some(50)),
        Some("0.75") => Ok(Some(75)),
        Some("1.25") => Ok(Some(125)),
        Some("1.5") => Ok(Some(150)),
        Some("2") => Ok(Some(200)),
        Some("3") => Ok(Some(300)),
        Some("4") => Ok(Some(400)),
        Some(_) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "unsupported stream speed; use one of 0.5, 0.75, 1.25, 1.5, 2, 3, 4",
        )),
    }
}

fn speed_value(speed_hundredths: u16) -> f64 {
    f64::from(speed_hundredths) / 100.0
}

/// Parse the optional `t` query param: a start anchor in **source-content**
/// seconds (BUG-226).
///
/// `Some(t)` asks the server to start the transcode at `t` instead of 0:00, so a
/// cold-cache deep-position entry plays instantly instead of waiting for the
/// transcode to chew through everything before the anchor. Values below 0.25s
/// are canonicalized to `None` (an anchor at 0 *is* the canonical proxy's
/// timeline; there is no reason to fork behaviour for it). The anchor is clamped
/// into the source so ffmpeg always has something to encode.
fn parse_stream_start(
    query: &HashMap<String, String>,
    src_duration: Option<i64>,
) -> Result<Option<f64>, ApiError> {
    let Some(raw) = query.get("t") else {
        return Ok(None);
    };
    let t: f64 = raw.trim().parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid stream anchor; t must be seconds",
        )
    })?;
    if !t.is_finite() || t < 0.0 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid stream anchor; t must be a non-negative number of seconds",
        ));
    }
    if t < 0.25 {
        return Ok(None);
    }
    if let Some(d) = src_duration {
        if d > 0 {
            let cap = (d as f64 - 0.5).max(0.0);
            if t > cap {
                return Ok(Some(cap));
            }
        }
    }
    Ok(Some(t))
}

fn transformed_duration(duration_secs: Option<i64>, speed_hundredths: Option<u16>) -> Option<i64> {
    match (duration_secs, speed_hundredths) {
        (Some(duration), Some(speed)) if duration > 0 => {
            Some(((duration as f64 / speed_value(speed)).round() as i64).max(1))
        }
        (duration, _) => duration,
    }
}

fn speed_video_filter(speed_hundredths: u16) -> String {
    format!("setpts=(PTS-STARTPTS)/{:.2},fps=30", speed_value(speed_hundredths))
}

/// Keep every atempo stage in FFmpeg's supported [0.5, 2.0] range.
fn atempo_filter(speed_hundredths: u16) -> String {
    let mut remaining = speed_value(speed_hundredths);
    let mut filters = Vec::new();
    while remaining > 2.0 {
        filters.push("atempo=2.0".to_string());
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        filters.push("atempo=0.5".to_string());
        remaining /= 0.5;
    }
    filters.push(format!("atempo={remaining:.2}"));
    format!("asetpts=PTS-STARTPTS,{}", filters.join(","))
}

fn stream_mode_header(speed_hundredths: Option<u16>, fallback: &'static str) -> HeaderValue {
    match speed_hundredths {
        Some(speed) => HeaderValue::from_str(&format!("decimate={}", speed_value(speed)))
            .unwrap_or_else(|_| HeaderValue::from_static(fallback)),
        None => HeaderValue::from_static(fallback),
    }
}

/// ffmpeg 可执行文件名（平台差异只在这一个常量）。
const FFMPEG_EXE: &str = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

/// ffmpeg 解析链（BUG-208，首个命中为准）：
///   1. env `ORIG_FFMPEG_PATH`（显式指定，最高优先）；
///   2. sidecar 同目录（打包布局）；
///   3. `<TG 数据目录>/bin/`；
///   4. `<应用 bin 目录>`（`%LocalAppData%\OrigHub\bin`，dev 与生产通吃的安装位）；
///   5. `<TG 数据目录>/../bin/`（生产布局 `%LocalAppData%\OrigHub\{tg,bin}`）；
///   6. `PATH`。
/// 找不到返回 None——调用方把「装 ffmpeg 的可行动指引」放进 501 响应，
/// 前端保留 BUG-207 停载遮罩兜底，绝不静默降级。
fn resolve_ffmpeg_path(tg_data_dir: &std::path::Path) -> Option<PathBuf> {
    let explicit = std::env::var("ORIG_FFMPEG_PATH").ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(std::path::Path::to_path_buf));
    let app_bin = std::env::var("LOCALAPPDATA")
        .ok()
        .map(|v| std::path::Path::new(&v).join("OrigHub").join("bin"));
    let path_var = std::env::var("PATH").ok();
    resolve_ffmpeg_from(
        explicit.as_deref(),
        exe_dir.as_deref(),
        tg_data_dir,
        app_bin.as_deref(),
        path_var.as_deref(),
    )
}

/// 纯函数版解析链（便于单测）：不读 env、不做副作用，只 stat 文件。
fn resolve_ffmpeg_from(
    explicit: Option<&str>,
    exe_dir: Option<&std::path::Path>,
    tg_data_dir: &std::path::Path,
    app_bin: Option<&std::path::Path>,
    path_var: Option<&str>,
) -> Option<PathBuf> {
    if let Some(v) = explicit {
        let p = orig_core::paths::expand_tilde(v.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe_dir {
        cands.push(d.join(FFMPEG_EXE));
    }
    cands.push(tg_data_dir.join("bin").join(FFMPEG_EXE));
    if let Some(ab) = app_bin {
        cands.push(ab.join(FFMPEG_EXE));
    }
    if let Some(parent) = tg_data_dir.parent() {
        cands.push(parent.join("bin").join(FFMPEG_EXE));
    }
    for p in cands {
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(pv) = path_var {
        for dir in std::env::split_paths(pv) {
            let p = dir.join(FFMPEG_EXE);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// `GET /api/media/items/:id/stream[?speed=S]` — H.264 compatibility/FRC stream (BUG-208/223).
///
/// 背景：库内重量级条目（>8Mbps 共 9 条）实测整类 HEVC，Chromium 只认硬件 HEVC
/// 而本机没有 → 0 帧解码 + `preload=auto` 的 abort-and-re-request 风暴
/// （BUG-207 仪表化证据：20s 97–137 请求、GB 级无效 IO）。本地播放器能播是因为
/// 自带软件解码；**任何投递算法都变不出解码能力**，唯一结构性出路是转成
/// 浏览器必解的 H.264（兼容性碾压：全平台硬解）。
///
/// 行为：
///   0. **探针**（`?probe=1`，BUG-226）→ 只答 `{"ready":bool,"duration":s}`，
///      不占坑、不起 ffmpeg——前端换档前据此决定直连代理还是带 `t` 锚点。
///   1. **代理命中**（`<id>.mp4` 或 `<id>-speed-<百分之一倍速>.mp4` 已存在）→ 直接
///      `serve_local_file`（Range / ETag / MIME / 背压一处定义，不重造）；FRC 响应头标记 `decimate=S`。
///   2. **同一变体转码在途** → 挂在 watch 上等完成再服务代理（单飞），不同速度有独立缓存/任务键。
///   3. **冷启动** → spawn ffmpeg 实时转 **fMP4**（`frag_keyframe+empty_moov`，
///      浏览器无需等整片转完即可开播），stdout 一边泵给响应、一边 tee 落 `.part`，
///      成功后原子改名成正式代理；客户端断开 → 杀 ffmpeg + 清 `.part`。
///      头 `x-orig-stream: live`。
///   4. **锚点起转**（`?t=<源内容秒>`，BUG-226）→ `-ss t` 从指定位置起转的
///      **live-only** 流：字节与正式代理（从 0:00 起）不同源，不落盘、不改名、
///      不进单飞表；冷缓存下深位换档/续播用它免去「转码从 0 追上来」的等待。
///
/// 失败语义：ffmpeg 不存在 → 501；转码中途失败 → 流提前终止（浏览器走 onError
/// → 致命遮罩），`.part` 清除不留垃圾。代理目录在 TG 数据目录下（**不进库**：
/// 派生缓存混进唯一内容仓会破坏「1 份存档」的计数语义）。
async fn media_item_stream(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let speed_hundredths = parse_stream_speed(query.get("speed").map(String::as_str))?;
    let item = st
        .store
        .get_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "media item not found"))?;
    // 与 /raw 相同的路径闸门（cache::resolve_item_path：绝对原样 / 相对 join 库根）。
    let src = match item.file_path.clone() {
        Some(p) => {
            let lib_root = st.store.library_root().await;
            crate::cache::resolve_item_path(&lib_root, &p)
        }
        None => return Err(ApiError::new(StatusCode::NOT_FOUND, "item has no local file")),
    };
    if tokio::fs::metadata(&src).await.is_err() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "source file missing"));
    }
    let proxy_dir = st.store.proxy_dir();
    let key = TranscodeKey { item_id: id, speed_hundredths };
    let variant = speed_hundredths
        .map(|speed| format!("{id}-speed-{speed}.mp4"))
        .unwrap_or_else(|| format!("{id}.mp4"));
    let final_p = proxy_dir.join(&variant);
    let part_p = proxy_dir.join(format!("{variant}.part"));
    let stream_duration = transformed_duration(item.duration, speed_hundredths);

    // 0) 探针（BUG-226）：只回答「该变体的代理是否已就绪 + 源内容时长」，
    //    **绝不**占单飞坑、**绝不** spawn ffmpeg——否则一次探测就会把「冷缓存的
    //    正式代理转码」从天而降地启动。前端换档前用它决定：代理就绪 → 直接换
    //    src（Range 可拖）；冷缓存 → 带 `t` 从当前内容位置起转，免去转码从 0:00
    //    追上来的分钟级等待。
    if query.get("probe").map(String::as_str) == Some("1") {
        let ready = tokio::fs::metadata(&final_p).await.is_ok();
        return Ok(
            Json(json!({ "ready": ready, "duration": item.duration })).into_response(),
        );
    }

    let start_secs = parse_stream_start(&query, item.duration)?;

    // 1) 代理命中：完整文件走既有投递契约。
    if tokio::fs::metadata(&final_p).await.is_ok() {
        let mut res = serve_local_file(
            final_p.to_string_lossy().as_ref(),
            Some("video"),
            stream_duration,
            &headers,
        )
        .await?;
        res.headers_mut()
            .insert("x-orig-stream", stream_mode_header(speed_hundredths, "proxy"));
        return Ok(res);
    }

    // ffmpeg 不存在应在占坑**之前**判定——否则 501 早退会把在途表弄脏（占坑无 pump）。
    let ffmpeg = resolve_ffmpeg_path(&proxy_dir).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            "ffmpeg not available; install it (set ORIG_FFMPEG_PATH, or place ffmpeg.exe at %LocalAppData%\\OrigHub\\bin\\ffmpeg.exe) to enable compatibility streams",
        )
    })?;

    // 2)/3) 单飞占坑：抢到 = 冷启动；没抢到 = 在途等待。
    //
    // BUG-226：带 `t` 锚点的请求**不进单飞表**——锚点流是 live-only（不落盘、
    // 不改名、不可被后续请求命中），每次请求各起一条；若与正式代理转码共用
    // 一个键，锚点流的 finish 会把别人的占坑顶掉。
    enum Role {
        Start(tokio::sync::watch::Sender<bool>),
        Wait(TranscodeDone),
    }
    let registered = start_secs.is_none();
    let role = if !registered {
        let (tx, _rx) = tokio::sync::watch::channel(false);
        Role::Start(tx)
    } else {
        let mut m = transcode_inflight().lock().expect("transcode map poisoned");
        match m.get(&key) {
            Some(rx) => Role::Wait(rx.clone()),
            None => {
                let (tx, rx) = tokio::sync::watch::channel(false);
                m.insert(key, rx);
                Role::Start(tx)
            }
        }
    };

    match role {
        Role::Wait(rx) => {
            // 在途等待：完成（或发送端消失=任务以任意方式结束）后代理应已就位。
            let mut rx = rx;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(600), async move {
                while !*rx.borrow_and_update() {
                    if rx.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
            if tokio::fs::metadata(&final_p).await.is_ok() {
                let mut res = serve_local_file(
                    final_p.to_string_lossy().as_ref(),
                    Some("video"),
                    stream_duration,
                    &headers,
                )
                .await?;
                res.headers_mut()
                    .insert("x-orig-stream", stream_mode_header(speed_hundredths, "proxy"));
                return Ok(res);
            }
            Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "transcode in flight but proxy not ready; retry later",
            ))
        }
        Role::Start(tx) => {
            let (resp_tx, resp_rx) =
                tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(32);
            tokio::spawn(transcode_pump(
                ffmpeg,
                src,
                part_p,
                final_p,
                key,
                speed_hundredths,
                start_secs,
                registered,
                tx,
                resp_tx,
            ));
            let body = axum::body::Body::from_stream(ReceiverStream::new(resp_rx));
            let mut res = Response::new(body);
            res.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
            res.headers_mut()
                .insert("x-orig-stream", stream_mode_header(speed_hundredths, "live"));
            Ok(res)
        }
    }
}

/// 兼容流转码泵（BUG-208）：ffmpeg stdout →（响应通道 + `.part` 落盘）双写。
///
/// 成功（exit 0 且客户端未中途断开）→ `.part` 原子改名成正式代理；
/// 客户端断开 / 转码失败 → 清 `.part` 不留垃圾。出口统一：出表 + 唤醒等待者。
///
/// BUG-226：`start_secs = Some(t)` 时是**锚点 live-only 流**——`-ss t` 从指定
/// 内容位置起转，字节流与正式代理（从 0:00 起）不是同一份字节，因此**不落盘、
/// 不改名、不进单飞表**（`registered=false`，finish 不得出别人的坑），客户端
/// 断开即杀 ffmpeg。
#[allow(clippy::too_many_arguments)]
async fn transcode_pump(
    ffmpeg: PathBuf,
    src: PathBuf,
    part_p: PathBuf,
    final_p: PathBuf,
    key: TranscodeKey,
    speed_hundredths: Option<u16>,
    start_secs: Option<f64>,
    registered: bool,
    done_tx: tokio::sync::watch::Sender<bool>,
    resp_tx: tokio::sync::mpsc::Sender<Result<axum::body::Bytes, std::io::Error>>,
) {
    let id = key.item_id;
    let persist = start_secs.is_none();
    let finish = |completed: bool| {
        // 出表 + 唤醒等待者（drop done_tx 兜底：panic 路径也会关闭 watch）。
        // 锚点流没占过坑，绝不能把（可能属于别人的）同键条目顶掉。
        if registered {
            transcode_inflight()
                .lock()
                .expect("transcode map poisoned")
                .remove(&key);
        }
        let _ = done_tx.send(completed);
    };

    if let Some(parent) = part_p.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            tracing::error!(target: "orig_tg::transcode", "item {id}: create proxy dir failed: {e}");
            finish(false);
            return;
        }
    }

    let mut command = tokio::process::Command::new(&ffmpeg);
    // BUG-226：`-ss` 必须放在 `-i` **之前**（输入侧快 seek）；输出时间轴由
    // `setpts=PTS-STARTPTS` 归零，从锚点起算。
    if let Some(t) = start_secs {
        tracing::info!(target: "orig_tg::transcode", "item {id}: anchored live stream from {t:.3}s (not persisted)");
        command.arg("-ss").arg(format!("{t:.3}"));
    }
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        &src.to_string_lossy(),
        // 首条视频轨 + 首条音轨（无音轨不报错）；字幕/封面轨一律丢弃
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
    ]);
    if let Some(speed) = speed_hundredths {
        // Retimestamp then sample CFR 30fps; supports fractional speed, VFR and any source fps.
        //
        // BUG-223：**不传 `-r 30`**。`fps=30` 滤镜已把输出重采样为 CFR 30，
        // 而下面无条件带的 `-fpsmax 30` 与 `-r` 在同一条流上互斥
        // （ffmpeg: "Only one of -fpsmax and -r can be set for a stream."），
        // 两者同时出现会让 ffmpeg **拒绝打开输出文件** → 整条 FRC 流 0 字节，
        // 浏览器端表现为「切了倍速就再也出不了画面」。判据①②的实测都建立在
        // 只带`-r 30`（判据①脚本）或只带 `-fpsmax 30`（本函数）的单一上限上。
        command
            .arg("-vf")
            .arg(speed_video_filter(speed))
            .arg("-af")
            .arg(atempo_filter(speed));
    }
    command.args([
        // H.264：全平台硬解兼容目标（veryfast 在本机实测可实时转码）。
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        // 兼容代理与 FRC 变体均限制输出视频最高 30fps。
        "-fpsmax",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        // fMP4：空 moov 前置 → 浏览器不等整片转完即可开播
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 响应通道断开时 drop child 会自动杀进程（kill_on_drop）
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：sidecar 无控制台，防止每次转码弹黑窗
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(target: "orig_tg::transcode", "item {id}: spawn ffmpeg failed: {e}");
            finish(false);
            return;
        }
    };
    let mut stdout = child.stdout.take().expect("stdout was piped");
    // stderr 必须持续排干（管道写满会卡死 ffmpeg），失败原因落日志
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut s = stderr;
            let mut buf = Vec::new();
            // 有界读取：stderr 只需要最后的错误摘要
            let _ = tokio::io::AsyncReadExt::take(&mut s, 8 * 1024)
                .read_to_end(&mut buf)
                .await;
            let msg = String::from_utf8_lossy(&buf);
            if !msg.trim().is_empty() {
                tracing::warn!(target: "orig_tg::transcode", "ffmpeg stderr: {}", msg.trim());
            }
        });
    }
    // `.part` 只为可缓存的正式代理而写；锚点 live-only 流不落盘。
    let mut file = if persist {
        match tokio::fs::File::create(&part_p).await {
            Ok(f) => Some(f),
            Err(e) => {
                tracing::error!(target: "orig_tg::transcode", "item {id}: create .part failed: {e}");
                finish(false);
                return;
            }
        }
    } else {
        None
    };

    let mut buf = vec![0u8; 256 * 1024];
    let mut client_gone = false;
    loop {
        match stdout.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                use tokio::io::AsyncWriteExt;
                if let Some(file) = file.as_mut() {
                    if file.write_all(&buf[..n]).await.is_err() {
                        // 落盘失败不影响直播给客户端（例如磁盘满时至少本次能看完）
                        tracing::warn!(target: "orig_tg::transcode", "item {id}: write .part failed; proxy will be skipped");
                    }
                }
                if !client_gone
                    && resp_tx
                        .send(Ok(axum::body::Bytes::copy_from_slice(&buf[..n])))
                        .await
                        .is_err()
                {
                    // Legacy compatibility requests and anchored live-only streams
                    // (BUG-226) cancel immediately. Canonical FRC variants keep
                    // transcoding to a seekable speed-specific proxy after client
                    // disconnect.
                    client_gone = true;
                    if speed_hundredths.is_none() || !persist {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::error!(target: "orig_tg::transcode", "item {id}: read ffmpeg stdout failed: {e}");
                break;
            }
        }
    }

    let mut completed = false;
    if client_gone && (speed_hundredths.is_none() || !persist) {
        let _ = child.kill().await;
        let _ = child.wait().await;
        if persist {
            let _ = tokio::fs::remove_file(&part_p).await;
        }
    } else {
        drop(stdout); // 关闭管道让 ffmpeg 收到 EOF、自然退出
        match child.wait().await {
            Ok(s) if s.success() => {
                if persist && tokio::fs::rename(&part_p, &final_p).await.is_ok() {
                    completed = true;
                    tracing::info!(target: "orig_tg::transcode", "item {id}: proxy ready at {}", final_p.display());
                }
            }
            Ok(s) => {
                tracing::warn!(target: "orig_tg::transcode", "item {id}: transcode failed: {s}");
                if persist {
                    let _ = tokio::fs::remove_file(&part_p).await;
                }
            }
            Err(e) => {
                tracing::error!(target: "orig_tg::transcode", "item {id}: wait ffmpeg failed: {e}");
                if persist {
                    let _ = tokio::fs::remove_file(&part_p).await;
                }
            }
        }
    }
    finish(completed);
}

/// 投递节流是否仅针对非环回（真实远端）场景的开关。
///
/// orig-tg 由 `config.bind` 默认固定为 `127.0.0.1`（仅本机）。环回口带宽免费、
/// 冗余重取命中页缓存无害，故投递默认**不限速**（见 `delivery_bps` 与 BUG-199）。
/// 仅在显式把 bind 设成非环回地址（向 LAN / 远端共享）时，才需要 BUG-033 的
/// 抑风暴限速。该开关由 `main` 在解析 `config.bind` 后写入，未配置时按「环回」处理。
use std::sync::OnceLock;
static DELIVERY_LOOPBACK_ONLY: OnceLock<bool> = OnceLock::new();

/// 由 `main` 在解析 `config.bind` 后调用：记录是否仅环回监听。
///
/// 必须是 `pub`：`main.rs` 是**独立的二进制 crate**，`pub(crate)` 对它不可见
/// （`routes` 属 lib crate）。
pub fn configure_delivery_loopback_only(v: bool) {
    let _ = DELIVERY_LOOPBACK_ONLY.set(v);
}

/// 是否仅环回监听。未配置时按「是」处理——宁可本地不限速，也不在本地误节流。
fn delivery_loopback_only() -> bool {
    *DELIVERY_LOOPBACK_ONLY.get().unwrap_or(&true)
}

/// 投递背压：允许的播放倍率余量（目标速率 = 码率 × 本系数）。
const DELIVERY_BUDGET_FACTOR: f64 = 6.0;
/// `duration` 未知时的兜底速率上限（字节/秒）。
const DELIVERY_FALLBACK_BPS: f64 = 16.0 * 1024.0 * 1024.0;
/// 初始突发信用（秒）：每个响应开头允许「不计入节流」的时间额度。
///
/// 线性速率曲线的「应有耗时」是从 0 开始爬升的，于是**每个请求的第一个块**都要先
/// 等服务 `chunk / bps` 秒才发出（`CHUNK = 1 MiB` ⇒ 在真实码率下为 135–1000 ms）。
/// 每次拖进度条、以及 Chromium 的 abort-and-re-request 循环都会重付一次这笔
/// time-to-first-byte 代价——这正是「播放浏览卡顿异常严重」的主因。
/// 用**秒**而非字节做信用，可随码率自动缩放（等价于把速率曲线整体右移本秒数），
/// 稳态速率仍为 `bps`，因此 BUG-033 实测的抑风暴结论不变。
const DELIVERY_BURST_SECS: f64 = 4.0;

/// 本批发送后「应有」的耗时（秒）。等价于把线性速率曲线整体右移 `burst_secs`：
/// 开头 `burst_secs` 秒对应的字节立即可发（消除每请求重启的 TTFB 代价），
/// 之后稳态速率仍是 `bps`（BUG-033 实测的抑风暴结论不变）。
///
/// 纯函数：不读 env、不做 IO，便于单测。`bps <= 0` 时由调用方卫兵拦截。
fn delivery_due_secs(sent_bytes: u64, bps: f64, burst_secs: f64) -> f64 {
    (sent_bytes as f64 / bps - burst_secs).max(0.0)
}

/// 目标投递速率（字节/秒）。返回 `0.0` 表示不限速。
///
/// **默认不限速（BUG-199）**：orig-tg 由 `config.bind` 固定为 `127.0.0.1`（仅本机），
/// 投递走环回口，带宽免费；Chromium 对同一大文件的 abort-and-re-request 重取命中
/// 页缓存本就无害。此前对**每一次**投递做全局节流（`bitrate×6`、4s 突发后按速率曲线
/// 右移），会放慢合法投递、诱发「连接太慢 → 中断重取」循环，正是
/// 「本地播放器流畅、经 WEB 卡顿」「HLS 流畅、当前不流畅」的根因。
/// 故环回口直接返回 `0.0`，使 WEB 投递与本地播放器同速。
///
/// **何时仍需限速（BUG-033，保留）**：仅当 bind 非环回（向 LAN / 远端共享）时，
/// 冗余重取才真实占用上行带宽。此时走下方计算分支——以下为 BUG-033 的原始结论，
/// 切勿仅凭直觉削弱：
/// 本地千兆下服务端能以数百 MB/s 把字节灌给解码器，而解码器 1x 只消费「码率」、
/// 2x 消费 2×码率。Chromium 读够当前 buffer 即 abort 连接、另起请求重取同一区域，
/// 表现为「同一块数据请求无数遍」：实测 2x 播放 10s 内 **137 个请求 / 792 MiB
/// （冗余 63x，白传 70%+）**，在 WebView2 里就是界面卡死。
/// 唯一有效的杠杆是**发送速率**：限到 6 MiB/s 后传输量 290 MiB → 19.6 MiB、
/// 冗余 29x → **1.97x**。对照实验（Python Range 实现、块大小 1/4/8/32MiB/EOF、
/// `preload` 三档、缓存开关）均无法替代速率杠杆。
///
/// 返回的稳态速率 `bps` 开头 TTFB 代价由 `delivery_due_secs` 的**初始突发信用**
/// （见 `DELIVERY_BURST_SECS`）单独消除，二者正交。
///
/// 可用 `ORIG_TG_DELIVERY_BPS` 覆盖（0 = 关闭限速，便于 A/B，无需重编）：
/// 非 0 值时**无视环回判定**直接启用限速，供真实远端场景手动开启 BUG-033 抑风暴。
fn delivery_bps(total: u64, duration_secs: Option<i64>) -> f64 {
    // 显式覆盖优先：非 0 值无视环回判定直接启用限速（真实远端场景）。
    if let Ok(v) = std::env::var("ORIG_TG_DELIVERY_BPS") {
        return v.trim().parse::<f64>().unwrap_or(0.0);
    }
    // 环回口（仅本机）带宽免费：跳过节流，使 WEB 投递与本地播放器同速（BUG-199）。
    if delivery_loopback_only() {
        return 0.0;
    }
    // 以下为 BUG-033 抑风暴速率（仅非环回场景到达）：
    match duration_secs.filter(|d| *d > 0) {
        Some(d) => {
            let bitrate = total as f64 / d as f64; // 字节/秒
            (bitrate * DELIVERY_BUDGET_FACTOR).max(1024.0 * 1024.0)
        }
        None => DELIVERY_FALLBACK_BPS,
    }
}

/// 按扩展名给一个尽量准确的 Content-Type（图片尤其重要，否则 <img> 不渲染）。
/// 本地文件投递（播放主路径的唯一实现，BUG-031）。
///
/// `/api/media/items/:id/raw`（媒体库条目）与 `/api/tg/local/:chat/:msg`（TG 已缓存）
/// 共用本函数——两条路径都直接喂 `<video>`，契约必须完全一致，否则「已缓存播放」
/// 会在其中一条上退化（此前 local 只有 512KiB 分块、无 validator、MIME 取 DB 值）。
///
/// 契约：
///   - 无 Range → 200 + 完整文件（**绝不只给前 N MiB**：那会让浏览器误判文件长度，
///     duration/seek 全错并触发请求风暴）
///   - `bytes=S-`（播放主路径）→ 206 + 32MiB 块（见 `OPEN_CHUNK`）+ 如实 Content-Range
///   - `bytes=S-E`（闭区间）→ 206 + 尊重请求（安全阀 64MiB，Content-Range 如实）
///   - 恒带 ETag / Last-Modified：Chromium 媒体缓存据此复用已取字节，缺了就会重复下载
///   - MIME 按扩展名优先（DB 里的 mime 可能是空或过时），未知再按 kind 兜底
async fn serve_local_file(
    path: &str,
    kind: Option<&str>,
    duration_secs: Option<i64>,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let meta = tokio::fs::metadata(path).await.map_err(|e| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            &format!("file unreadable: {e} ({path})"),
        )
    })?;
    let total = meta.len();
    if total == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "empty file"));
    }

    let mime = match mime_of_ext_opt(path) {
        Some(m) => m,
        None => match kind.unwrap_or("") {
            "photo" => "image/jpeg".to_string(),
            "audio" => "audio/mpeg".to_string(),
            "video" => "video/mp4".to_string(),
            _ => "application/octet-stream".to_string(),
        },
    };

    let range_hdr = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let (status, start, end) = match media_parse_range(range_hdr.as_deref(), total) {
        Some((s, e, open)) => {
            let e = if open {
                (s + OPEN_CHUNK - 1).min(total - 1)
            } else {
                e.min(s + MAX_CHUNK - 1).min(total - 1)
            };
            (StatusCode::PARTIAL_CONTENT, s, e)
        }
        None if range_hdr.is_some() => {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{total}"))],
            )
                .into_response());
        }
        None => (StatusCode::OK, 0, total.saturating_sub(1)),
    };
    let len = end - start + 1;

    let mut f = tokio::fs::File::open(path).await.map_err(|e| {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &format!("open failed: {e}"))
    })?;
    f.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &format!("seek failed: {e}"))
    })?;
    const CHUNK: usize = 1024 * 1024;
    // 背压：按「码率 × 余量」节流，避免客户端读够即断、反复重取（见 delivery_bps）。
    let bps = delivery_bps(total, duration_secs);
    // 初始突发信用（秒）：与 delivery_bps 覆盖 `ORIG_TG_DELIVERY_BPS` 的写法一致，
    // 可用 `ORIG_TG_DELIVERY_BURST_SECS` 覆盖（解析失败/未设则用默认常量）。
    let burst_secs = std::env::var("ORIG_TG_DELIVERY_BURST_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(DELIVERY_BURST_SECS);
    let started = std::time::Instant::now();
    let body = futures::stream::unfold((f, len, 0u64), move |(mut f, mut remain, sent)| async move {
        if remain == 0 {
            return None;
        }
        let want = (remain as usize).min(CHUNK);
        let mut buf = vec![0u8; want];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                remain -= n as u64;
                let sent_next = sent + n as u64;
                if bps > 0.0 {
                    // 已发送字节数「应有」的耗时减去真实耗时 = 本批还需再等多久。
                    // `delivery_due_secs` 把速率曲线整体右移 `burst_secs`：每个响应开头
                    // 的 `burst_secs` 对应字节不再等待，消除每请求重启的 TTFB 代价
                    // （BUG-033 的节流仍在：稳态速率仍为 bps）。客户端断开时整个 stream
                    // 被 drop，这里的 sleep 随之中断，不会泄漏。
                    let due = delivery_due_secs(sent_next, bps, burst_secs);
                    let lag = due - started.elapsed().as_secs_f64();
                    if lag > 0.0 {
                        tokio::time::sleep(std::time::Duration::from_secs_f64(lag)).await;
                    }
                }
                Some((Ok::<_, std::io::Error>(buf), (f, remain, sent_next)))
            }
            Err(e) => Some((Err(e), (f, 0, sent))),
        }
    });

    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = format!("\"{:x}-{:x}\"", total, mtime_secs);

    let mut res = axum::response::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::ETAG, etag)
        .header(header::LAST_MODIFIED, http_date(mtime_secs))
        .header(header::CACHE_CONTROL, "public, max-age=31536000");
    if status == StatusCode::PARTIAL_CONTENT {
        res = res.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    res.body(axum::body::Body::from_stream(body))
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))
}

/// Unix 秒 → RFC 1123 日期（`Last-Modified`），不引入日期库依赖。
fn http_date(secs: u64) -> String {
    const DAY: u64 = 86400;
    let days = (secs / DAY) as i64;
    let rem = secs % DAY;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // days since 1970-01-01 → 公历年月日（Howard Hinnant civil_from_days 算法）
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    const WD: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let wd = ((days % 7) + 11) % 7; // 1970-01-01 = Thursday
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        WD[wd as usize],
        d,
        MO[(m - 1) as usize],
        y,
        h,
        mi,
        s
    )
}

/// 按扩展名判定 MIME，未知返回 `None`（供投递端点使用：未知则按 kind 兜底，
/// **不设 `image/jpeg` 之类兜底值**——那会把 `.mov` 视频误标成静态图，
/// 浏览器据此走 `<img>` 解码路径而拒播）。
fn mime_of_ext_opt(path: &str) -> Option<String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    Some(
        match ext.as_str() {
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "avif" => "image/avif",
            "heic" => "image/heic",
            "jpg" | "jpeg" => "image/jpeg",
            "webm" => "video/webm",
            "mkv" => "video/x-matroska",
            "mov" => "video/quicktime",
            "mp4" | "m4v" => "video/mp4",
            "ts" => "video/mp2t",
            "avi" => "video/x-msvideo",
            "wmv" => "video/x-ms-wmv",
            "flv" => "video/x-flv",
            "mpg" | "mpeg" => "video/mpeg",
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "ogg" => "audio/ogg",
            _ => return None,
        }
        .to_string(),
    )
}

// ---- 剧集 ----

/// `GET /api/media/series`
/// `GET /api/media/series` 查询参数：`tagId` 可选，用于按标签筛剧集
/// （TG 自动归档的 `#标签` 落到剧集上，故筛剧集才有意义）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSeriesQuery {
    tag_id: Option<i64>,
}

async fn list_media_series(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ListSeriesQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let list = st
        .store
        .list_series_filtered(q.tag_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"items": list})))
}

/// 新建剧集请求体。
#[derive(Deserialize)]
struct CreateSeriesReq {
    title: String,
    description: Option<String>,
    kind: Option<String>,
    year: Option<i64>,
}

/// `POST /api/media/series`
async fn create_media_series(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CreateSeriesReq>,
) -> Result<impl IntoResponse, ApiError> {
    let id = st
        .store
        .create_series(
            &body.title,
            body.description.as_deref(),
            body.kind.as_deref().unwrap_or("series"),
            body.year,
            None, // 用户手动创建：不参与 TG 幂等去重
        )
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"id": id})))
}

/// `GET /api/media/series/:id` — 详情（含分集）。
async fn get_media_series(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let d = st
        .store
        .get_series(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    match d {
        Some(d) => Ok(Json(json!(d))),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "series not found")),
    }
}

/// `PATCH /api/media/series/:id`
async fn patch_media_series(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<SeriesPatch>,
) -> Result<impl IntoResponse, ApiError> {
    let ok = st
        .store
        .update_series(id, &body)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "series not found"));
    }
    Ok(Json(json!({"ok": true})))
}

/// `DELETE /api/media/series/:id` — 删剧集（内容条目保留，仅解除归属）。
///
/// 走**用户显式**删剧入口（BUG-126）：连带清掉这部剧的墓碑（按 `series_id` 与按
/// `source_key` 两种形态）。不能用低层 `delete_series` —— 那条是自动成剧回滚用的，
/// 清了墓碑会让「用户摘除」的记录被回滚抹掉，下次同步复活。
async fn delete_media_series(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .delete_series_explicit(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

async fn set_media_series_tags(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<TagSetReq>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .set_series_tags(id, &body.tag_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

/// 添加单集请求体。
///
/// 没有 `title`：分集的标题就是它指向条目的标题（改标题请走
/// `PATCH /api/media/episodes/:id` 或 `PATCH /api/media/items/:id`，
/// 两者写的是同一个字段）。收一个用不上的 title 字段等于「说了能改名，其实没改」。
#[derive(Deserialize)]
struct EpisodeReq {
    #[serde(rename = "itemId")]
    item_id: i64,
    season: Option<i64>,
    #[serde(rename = "episodeNo")]
    episode_no: Option<i64>,
}

/// `POST /api/media/series/:id/episodes`
async fn add_media_episode(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeReq>,
) -> Result<impl IntoResponse, ApiError> {
    // 剧集收 video / photo（trigger 是硬门，这里给可读的 422）。
    let kinds = st
        .store
        .item_kinds(std::slice::from_ref(&body.item_id))
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if kinds
        .get(&body.item_id)
        .map(|k| k != "video" && k != "photo")
        .unwrap_or(true)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "only video or photo items can be episodes",
        ));
    }
    let eid = st
        .store
        .add_episode(
            id,
            body.item_id,
            body.season.unwrap_or(1),
            body.episode_no.unwrap_or(1),
        )
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"id": eid})))
}

/// 批量追加请求体：按数组顺序编为连续集号。
#[derive(Deserialize)]
struct AppendEpisodesReq {
    #[serde(rename = "itemIds")]
    item_ids: Vec<i64>,
    season: Option<i64>,
}

/// `POST /api/media/series/:id/episodes/append`
async fn append_media_episodes(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<AppendEpisodesReq>,
) -> Result<impl IntoResponse, ApiError> {
    // 剧集收 video / photo。混入的音频等不合法条目显式 422（附明细），不静默过滤。
    let kinds = st
        .store
        .item_kinds(&body.item_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let rejected: Vec<i64> = body
        .item_ids
        .iter()
        .filter(|id| {
            kinds
                .get(*id)
                .map(|k| k != "video" && k != "photo")
                .unwrap_or(true)
        })
        .copied()
        .collect();
    if !rejected.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("only video or photo items can be episodes, rejected: {rejected:?}"),
        ));
    }
    let n = st
        .store
        .append_episodes(id, body.season.unwrap_or(1), &body.item_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"added": n})))
}

/// 合并请求体：把源剧集的**全部分集**并入路径上的剧集。
///
/// 二选一（BUG-186 扩展）：
///   - `{ "sourceId": 12 }`            —— 既有单源形态（剧集内页入口在用）；
///   - `{ "sourceIds": [12, 13, 14] }` —— 新增多源形态（剧集墙多选合并）。
///
/// 只给 `sourceId` 等价于 `sourceIds: [sourceId]`（**既有行为逐字不变**）；
/// 两者都不给 → 400；两者都给 → **以 `sourceIds` 为准**（不静默丢弃，日志如实反映）。
#[derive(Deserialize)]
struct MergeSeriesReq {
    #[serde(rename = "sourceId")]
    source_id: Option<i64>,
    #[serde(rename = "sourceIds")]
    source_ids: Option<Vec<i64>>,
}

/// `POST /api/media/series/:id/merge` — 合并剧集（BUG-037 / BUG-186）。
///
/// 把源剧集的分集整体搬入 `:id` 的末尾（各季续编集号）并**删除源剧集**，
/// 全程单事务。刻意的语义边界：**不做任何内容级去重** —— 文件名相同而内容不同、
/// 同一内容多源导入、`1-2` 与 `1,2` 并存、每批都带的预告，一律原样保留；
/// 只有「同一条目（item_id）已在目标同季」才跳过，且跳过明细随响应回传，
/// 不让「少搬了东西」被静默掩盖。
///
/// BUG-186：支持**一次事务合并多个源**（`sourceIds`）。多个源要么全部成功、要么整体
/// 回滚 —— 任一源失败（不存在 / 等于目标 / SQL 出错）都不留「并了一半」的状态。
async fn merge_media_series(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<MergeSeriesReq>,
) -> Result<impl IntoResponse, ApiError> {
    // ── 解析请求体为「去重后的源 id 列表」──
    //
    // 契约：`sourceId` 与 `sourceIds` 二选一；都给则以 `sourceIds` 为准。
    let both_given = body.source_id.is_some() && body.source_ids.is_some();
    let mut sources: Vec<i64> = match (body.source_id, body.source_ids) {
        (_, Some(ids)) => ids,
        (Some(single), None) => vec![single],
        (None, None) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "sourceId 或 sourceIds 必须提供其一",
            ));
        }
    };
    // 去重（保序）：重复 id 只合并一次。
    {
        let mut seen = std::collections::HashSet::new();
        sources.retain(|s| seen.insert(*s));
    }
    if sources.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "sourceIds 不能为空"));
    }

    // 源不得等于目标（自合并会删掉目标自身）。顺序与既有单源路径一致：先判自合并。
    if sources.iter().any(|s| *s == id) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "sourceId 不能与目标剧集相同",
        ));
    }
    // 目标存在性。
    let target_ok = st
        .store
        .series_exists(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !target_ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "target series not found"));
    }
    // 每个源都必须存在（任一缺失 → 404，批量整体不执行）。
    for &src in &sources {
        let ok = st
            .store
            .series_exists(src)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        if !ok {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "source series not found"));
        }
    }

    // 单源走既有路径（可观察行为逐字不变）；多源走**同一事务**的批量路径。
    let rep = if sources.len() == 1 {
        st.store.merge_series(id, sources[0]).await
    } else {
        st.store.merge_series_batch(id, &sources).await
    }
    .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    if sources.len() == 1 && !both_given {
        // 既有形态：日志逐字不变。
        st.push_log(&format!(
            "/api/media/series/{id}/merge: 并入 {} 集，跳过 {} 集（源 {} 已删除）",
            rep.added,
            rep.skipped.len(),
            sources[0]
        ));
    } else {
        let note = if both_given {
            "（sourceId 被忽略，以 sourceIds 为准）"
        } else {
            ""
        };
        st.push_log(&format!(
            "/api/media/series/{id}/merge: 并入 {} 集，跳过 {} 集（源 {:?} 已删除）{note}",
            rep.added,
            rep.skipped.len(),
            sources
        ));
    }
    Ok(Json(json!({
        "added": rep.added,
        "skippedCount": rep.skipped.len(),
        "skipped": rep.skipped,
    })))
}

/// `PATCH /api/media/episodes/:id` — 改单集标题 / 介绍 / 集号 / 季号。
///
/// 集号允许任意值（2、3…不必从 1 连续）；目标槽被同剧另一条占用时后端**对调**两条
/// 的槽位（见 `Store::update_episode`）—— 故不会因为「号重复」而 409。
async fn patch_media_episode(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeEdit>,
) -> Result<impl IntoResponse, ApiError> {
    // 集号/季号是位置，必须 >= 1：0 与负数会被哨兵机制误当作空闲槽，
    // 在入口挡掉比在 SQL 层留下隐患可靠。
    if matches!(body.episode_no, Some(n) if n < 1) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "episodeNo must be >= 1",
        ));
    }
    if matches!(body.season, Some(n) if n < 1) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "season must be >= 1",
        ));
    }
    let ok = st
        .store
        .update_episode(id, &body)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "episode not found"));
    }
    Ok(Json(json!({"ok": true})))
}

/// `POST /api/media/episodes/:id/move` — 剧集内换位（`{"dir":"up"|"down"}`）。
///
/// 只与**同季相邻**的一集交换槽位：集号可以跳号，整季重排会把用户编好的号抹平。
/// 已在边界（没有相邻分集）返回 `moved: false`，让界面能如实提示而不是假装成功。
async fn move_media_episode(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeMove>,
) -> Result<impl IntoResponse, ApiError> {
    let moved = st
        .store
        .move_episode(id, body.dir == "up")
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true, "moved": moved})))
}

// ── 备用来源（BUG-039 冲突1：同一集有多个缓存来源）─────────────────────────

#[derive(Deserialize)]
struct EpisodeSourceReq {
    #[serde(rename = "itemId")]
    item_id: i64,
}

/// `POST /api/media/episodes/:id/sources` — 挂条目为该集备用源（幂等）。
async fn attach_episode_source(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeSourceReq>,
) -> Result<impl IntoResponse, ApiError> {
    let attached = st
        .store
        .attach_episode_source(id, body.item_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true, "attached": attached})))
}

/// `POST /api/media/episodes/:id/sources/primary` — 主备切换（item 必须已是备用源）。
async fn switch_episode_source(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeSourceReq>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .switch_episode_source(id, body.item_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

/// `DELETE /api/media/episodes/:id/sources/:item_id` — 摘除备用源（只摘关联，内容保留）。
async fn detach_episode_source(
    State(st): State<Arc<AppState>>,
    Path((id, item_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .detach_episode_source(id, item_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

// ── 集级图片挂载（BUG-168）─────────────────────────────────────────────────

#[derive(Deserialize)]
struct EpisodeImagesReq {
    #[serde(rename = "itemIds")]
    item_ids: Vec<i64>,
}

/// `POST /api/media/episodes/:id/images` — 挂图（**replace-all** 语义，BUG-168）。
/// 按 `itemIds` 数组顺序重写该集的图片位；集不存在 → 404，
/// 混入非 photo 条目 → 422（附明细，不静默过滤）。
async fn attach_episode_images(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeImagesReq>,
) -> Result<impl IntoResponse, ApiError> {
    let exists = st
        .store
        .row_opt("SELECT 1 FROM media_episode WHERE id = ?1", params![id])
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if exists.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "episode not found"));
    }
    let kinds = st
        .store
        .item_kinds(&body.item_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let rejected: Vec<i64> = body
        .item_ids
        .iter()
        .filter(|id| kinds.get(*id).map(|k| k != "photo").unwrap_or(true))
        .copied()
        .collect();
    if !rejected.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("only photo items can be attached as episode images, rejected: {rejected:?}"),
        ));
    }
    let attached = st
        .store
        .attach_episode_images(id, &body.item_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true, "attached": attached})))
}

/// `DELETE /api/media/episodes/:id/images/:item_id` — 摘除一张挂图（幂等，BUG-168）。
/// 未挂过也 200（`removed:0` 如实回报，不伪装失败也不伪装成功）。
async fn detach_episode_image(
    State(st): State<Arc<AppState>>,
    Path((id, item_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, ApiError> {
    let removed = st
        .store
        .detach_episode_image(id, item_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(
        json!({"ok": true, "removed": if removed { 1 } else { 0 }}),
    ))
}

// ── 集的统一挂载读模型（D1=B 第一步）──────────────────────────────────────

/// `GET /api/media/episodes/:id/bindings` — 集的**统一挂载读模型**（纯只读）。
///
/// 把主条目 / 备用源 / 挂图收敛成一个有序列表，每项带 `role`
/// （`main` | `alternate` | `image`；`segment` 为片段占位，本步不产出行）。
/// UNION 现有三张表，**不搬迁任何行、不碰任何写路径**。
/// 集不存在 → 404（与 `attach_episode_images` 同一口径，不静默返回空列表）。
async fn list_episode_bindings(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let exists = st
        .store
        .row_opt("SELECT 1 FROM media_episode WHERE id = ?1", params![id])
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if exists.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "episode not found"));
    }
    let items = st
        .store
        .list_episode_bindings(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"items": items})))
}

/// `DELETE /api/media/episodes/:id` — 从剧集中移除单集（内容保留）。
async fn delete_media_episode(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .remove_episode(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

// ---- 标签 ----

/// `GET /api/media/tags`
async fn list_media_tags(
    State(st): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let list = st
        .store
        .list_tags()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"items": list})))
}

#[derive(Deserialize)]
struct CreateTagReq {
    name: String,
    color: Option<String>,
}

/// `POST /api/media/tags` — 重名幂等返回既有 id。
async fn create_media_tag(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CreateTagReq>,
) -> Result<impl IntoResponse, ApiError> {
    if body.name.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "tag name required"));
    }
    let id = st
        .store
        .create_tag(body.name.trim(), body.color.as_deref())
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"id": id})))
}

#[derive(Deserialize)]
struct UpdateTagReq {
    name: Option<String>,
    color: Option<String>,
}

/// `PATCH /api/media/tags/:id`
async fn patch_media_tag(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateTagReq>,
) -> Result<impl IntoResponse, ApiError> {
    let ok = st
        .store
        .update_tag(id, body.name.as_deref(), body.color.as_deref())
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "tag not found"));
    }
    Ok(Json(json!({"ok": true})))
}

/// `DELETE /api/media/tags/:id`
async fn delete_media_tag(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .delete_tag(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

// ---- 本地目录扫描 ----

#[derive(Deserialize)]
struct ScanReq {
    path: String,
    max: Option<usize>,
}

/// `POST /api/media/scan` — 递归扫描本地目录，返回可识别媒体（供导入前预览）。
async fn scan_media_dir(
    State(st): State<Arc<AppState>>,
    Json(body): Json<ScanReq>,
) -> Result<impl IntoResponse, ApiError> {
    // 去掉结尾多余分隔符：`D:\test_videos\` / `D:/test_videos/` 这类用户输入
    // 在 Windows 上会被判定为非目录，先归一化再校验。
    let trimmed = body.path.trim();
    let cleaned = trimmed.trim_end_matches(|c| c == '\\' || c == '/');
    let root = std::path::PathBuf::from(if cleaned.is_empty() { trimmed } else { cleaned });
    if !root.is_dir() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            &format!("not a directory: {}", body.path),
        ));
    }
    let found = scan_dir(&root, body.max.unwrap_or(5000)).map_err(|e| {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &format!("scan failed: {e}"))
    })?;
    st.push_log(&format!(
        "/api/media/scan {} -> {} file(s)",
        body.path,
        found.len()
    ));
    Ok(Json(json!({"items": found, "count": found.len()})))
}

// ---- 内嵌独立网页调试界面 ----

#[cfg(test)]
mod tests {
    use super::delete_media_item;
    use super::delivery_due_secs;
    use super::cache_tasks_payload;
    use super::list_episode_bindings;
    use super::merge_media_series;
    use super::normalized_series_name;
    use super::parse_stream_speed;
    use super::parse_stream_start;
    use super::resolve_ffmpeg_from;
    use super::speed_video_filter;
    use super::atempo_filter;
    use super::transformed_duration;
    use super::router;
    use super::serve_local_file;
    use super::MergeSeriesReq;

    #[test]
    fn stream_speed_profiles_are_whitelisted_and_build_cfr_filters() {
        assert!(matches!(parse_stream_speed(None), Ok(None)));
        assert!(matches!(parse_stream_speed(Some("1")), Ok(None)));
        assert!(matches!(parse_stream_speed(Some("0.5")), Ok(Some(50))));
        assert!(matches!(parse_stream_speed(Some("0.75")), Ok(Some(75))));
        assert!(matches!(parse_stream_speed(Some("1.25")), Ok(Some(125))));
        assert!(matches!(parse_stream_speed(Some("2")), Ok(Some(200))));
        assert!(parse_stream_speed(Some("2.5")).is_err());
        assert!(parse_stream_speed(Some("2;evil")).is_err());

        assert_eq!(transformed_duration(Some(120), Some(50)), Some(240));
        assert_eq!(transformed_duration(Some(120), Some(200)), Some(60));
        assert_eq!(transformed_duration(Some(120), None), Some(120));
        assert_eq!(speed_video_filter(50), "setpts=(PTS-STARTPTS)/0.50,fps=30");
        assert_eq!(speed_video_filter(200), "setpts=(PTS-STARTPTS)/2.00,fps=30");
        assert_eq!(atempo_filter(50), "asetpts=PTS-STARTPTS,atempo=0.50");
        assert_eq!(atempo_filter(200), "asetpts=PTS-STARTPTS,atempo=2.00");
        assert_eq!(atempo_filter(300), "asetpts=PTS-STARTPTS,atempo=2.0,atempo=1.50");
        assert_eq!(atempo_filter(400), "asetpts=PTS-STARTPTS,atempo=2.0,atempo=2.00");
    }

    /// BUG-208：ffmpeg 解析链的优先级与落空语义。
    /// 显式路径（存在才认）→ 数据目录自有 bin → 数据目录兄弟 bin → PATH → None。
    #[test]
    fn resolve_ffmpeg_prefers_explicit_then_data_dir_bins() {
        let base =
            std::env::temp_dir().join(format!("orig_ffmpeg_probe_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        // 1) 数据目录自有 bin 命中（显式路径不存在时落到这里）
        let data1 = base.join("tg1");
        let bin1 = data1.join("bin");
        std::fs::create_dir_all(&bin1).unwrap();
        let fake = bin1.join(super::FFMPEG_EXE);
        std::fs::write(&fake, b"stub").unwrap();
        let hit =
            resolve_ffmpeg_from(Some("Z:/definitely/missing/ffmpeg"), None, &data1, None, None);
        assert_eq!(hit.as_deref(), Some(fake.as_path()));

        // 2) 自有 bin 缺失 → 应用 bin 目录（%LocalAppData%\OrigHub\bin，dev/生产通吃）命中
        let data2 = base.join("tg2");
        std::fs::create_dir_all(&data2).unwrap();
        let app_bin = base.join("OrigHub-bin");
        std::fs::create_dir_all(&app_bin).unwrap();
        let app_exe = app_bin.join(super::FFMPEG_EXE);
        std::fs::write(&app_exe, b"stub").unwrap();
        let hit2 = resolve_ffmpeg_from(None, None, &data2, Some(&app_bin), None);
        assert_eq!(hit2.as_deref(), Some(app_exe.as_path()));

        // 3) 应用 bin 也缺 → 兄弟 bin（生产布局 <data>/../bin）命中
        let data3 = base.join("tg3");
        std::fs::create_dir_all(&data3).unwrap();
        let sibling_bin = base.join("bin");
        std::fs::create_dir_all(&sibling_bin).unwrap();
        let sibling = sibling_bin.join(super::FFMPEG_EXE);
        std::fs::write(&sibling, b"stub").unwrap();
        let hit3 = resolve_ffmpeg_from(None, None, &data3, None, None);
        assert_eq!(hit3.as_deref(), Some(sibling.as_path()));

        // 4) 全部落空 → None（不假装能转码，501 留给调用方）。
        //    注意：data4 必须挂在**隔离的父目录**下——上面的 base/bin 已存在，
        //    会作为「兄弟 bin」被命中（这正是解析链的正确行为）。
        let root2 = base.join("iso");
        let data4 = root2.join("tg4");
        std::fs::create_dir_all(&data4).unwrap();
        assert_eq!(resolve_ffmpeg_from(None, None, &data4, None, None), None);

        // 5) PATH 候选兜底
        let hit5 = resolve_ffmpeg_from(
            None,
            None,
            &data4,
            None,
            Some(sibling_bin.to_str().unwrap()),
        );
        assert_eq!(hit5.as_deref(), Some(sibling.as_path()));

        let _ = std::fs::remove_dir_all(&base);
    }

    use serde_json::json;

    use std::sync::Arc;

    use axum::extract::{Path, State};
    use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
    use axum::response::IntoResponse;
    use axum::Json;

    use crate::config::Config;
    use crate::state::{AppState, Availability};
    use crate::store::Store;

    /// BUG-152 判据 2：剧集名必须**不含集号**，且剧名本身必须完整留下。
    #[test]
    fn normalized_series_name_strips_the_episode_token() {
        // 集号在行尾
        assert_eq!(normalized_series_name("某剧 EP01"), "某剧");
        assert_eq!(normalized_series_name("某剧 EP01-02"), "某剧");
        assert_eq!(normalized_series_name("某剧 EP01-02 集合集"), "某剧");
        assert_eq!(normalized_series_name("某剧 第5集"), "某剧");
        assert_eq!(normalized_series_name("某剧 第3~4集"), "某剧");
        assert_eq!(normalized_series_name("某剧 第 3-4 集"), "某剧");
        assert_eq!(normalized_series_name("某剧 10-20集合集"), "某剧");
        assert_eq!(normalized_series_name("某剧 #12"), "某剧");
        // 无集号信号 → 原样保留
        assert_eq!(normalized_series_name("某剧"), "某剧");
        assert_eq!(normalized_series_name(""), "");
        // 剧名里的数字**不得**被误剥（无集号锚点）
        assert_eq!(normalized_series_name("1990-2020 经典回顾"), "1990-2020 经典回顾");
        assert_eq!(normalized_series_name("2019"), "2019");
        // 括号型标签式剧名（真实 caption 常见写法）不应被当成集号
        assert_eq!(normalized_series_name("#《异世界男妓》"), "#《异世界男妓》");
        // 锚点前是字母数字 → 不是集号（`XEP2` 的 ep 属剧名）
        assert_eq!(normalized_series_name("SEP2"), "SEP2");
    }

    /// BUG-152 现实场景：真实频道的 caption 惯例是「剧名 + 集号 + 推广文案 + 装饰」。
    /// 集号可能因此落在**行中**——剧名仍必须剥干净（这是端到端复现里发现的缺口）。
    #[test]
    fn normalized_series_name_handles_mid_line_episode_with_promo_tail() {
        assert_eq!(
            normalized_series_name("🌟🔥🔥《网调我的冰山妈妈》 EP2 原档 内群抢先更新 连载中 ⭐⭐⭐"),
            "🌟🔥🔥《网调我的冰山妈妈》"
        );
        assert_eq!(
            normalized_series_name("😀😀😀 #《艳母献身记》 EP1"),
            "😀😀😀 #《艳母献身记》"
        );
        assert_eq!(
            normalized_series_name("📱 《遥控器：操控全城女神》 第1-9集"),
            "📱 《遥控器：操控全城女神》"
        );
    }

    /// 交付约束的**直接**判据：不论批次怎么切，规范化剧集名都一致 ——
    /// 这是「多批次入库 title == 一次性全批入库 title」的单测版本。
    #[test]
    fn normalized_series_title_is_batch_independent() {
        // 同一部剧的四条 caption（真实写法：剧名 + 集号 + 标签）
        let captions = [
            "异世界男妓-瓦尔哈拉神枪馆 EP01 #短剧",
            "异世界男妓-瓦尔哈拉神枪馆 EP02 #短剧",
            "异世界男妓-瓦尔哈拉神枪馆 EP03-04 集合集 #短剧",
            "异世界男妓-瓦尔哈拉神枪馆 #短剧",
        ];
        let normalize = |cap: &str| {
            let (title, _) = crate::media::split_caption(cap);
            normalized_series_name(&title.unwrap_or_default())
        };
        // 一次性全批：取第一条（等价于 routes 里 first_caption → 规范化）
        let all_at_once = normalize(captions[0]);
        // 任意单条分批：结果必须与全批一致
        for cap in captions {
            assert_eq!(
                normalize(cap), all_at_once,
                "batch split must not change the series title (caption={cap:?})"
            );
        }
        assert_eq!(all_at_once, "异世界男妓-瓦尔哈拉神枪馆");
    }

    // ---- BUG-162：破坏性动作前必须先判 TG 标记；500 分支下字节必须一字节未删 ----

    /// 构造一个「下载目录」指向独立临时目录的 `AppState`（仅本组用例使用）。
    async fn state_in_download_dir(dir: &std::path::Path) -> Arc<AppState> {
        let mut cfg = Config::default();
        cfg.download_dir = dir.to_path_buf();
        Arc::new(AppState::new(
            Arc::new(crate::unavailable::UnavailableClient::new("test")),
            cfg,
            Availability::Unavailable("test".to_string()),
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        ))
    }

    /// 每次调用都给出唯一临时目录（进程内并发用例互不串扰）。
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let d = std::env::temp_dir()
            .join(format!("orig_routes_{tag}_{}_{nanos}", std::process::id()));
        std::fs::create_dir_all(&d).expect("scratch dir must be creatable");
        d
    }

    /// BUG-162 判据：TG 标记清除失败时，接口必须在**动手删字节之前**中止 ——
    /// 三态实测：HTTP 500、条目仍在、且**盘上字节仍在**（一字节未删）。
    ///
    /// 构造「标记清除失败」：`source=tg` 且 `ref` 不可解析 —— `reset_tg_flag` 直接返回
    /// false（与 QA 复现方式一致）。缺陷原形下顺序相反，字节会先被删掉再返回 500。
    #[tokio::test]
    async fn delete_media_item_aborts_before_deleting_bytes_when_tg_flag_cannot_clear() {
        let dir = scratch_dir("del_tg_flag_fail");
        let st = state_in_download_dir(&dir).await;

        let f = dir.join("stale.mp4");
        std::fs::write(&f, vec![0u8; 777]).expect("seed bytes");
        let file_path = f.to_string_lossy().into_owned();
        let id = st
            .store
            .upsert_media_item(
                "tg",
                "not-a-valid-tg-ref",
                "t",
                "video",
                Some(&file_path),
                Some(777),
                None,
                None,
            )
            .await
            .expect("insert item");

        let result = delete_media_item(State(st.clone()), Path(id)).await;
        let err = match result {
            Ok(_) => panic!("标记清不掉必须报错，不得假装成功"),
            Err(e) => e,
        };
        assert_eq!(
            err.status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "标记清除失败必须如实 500"
        );
        assert!(
            f.exists(),
            "BUG-162：500 分支下字节必须仍在盘上（缺陷原形是把字节删了再 500）"
        );
        assert_eq!(
            std::fs::metadata(&f).expect("stat bytes").len(),
            777,
            "字节数必须与失败前一致"
        );
        assert!(
            st.store.get_media_item(id).await.unwrap().is_some(),
            "条目必须仍在（`nothing was deleted` 必须为真）"
        );
    }

    /// 反向回归：正常删除路径仍然**真的删掉字节**（别把「先判标记」写成「永不删字节」）。
    #[tokio::test]
    async fn delete_media_item_still_removes_bytes_for_a_deletable_source() {
        let dir = scratch_dir("del_ok");
        let st = state_in_download_dir(&dir).await;

        let f = dir.join("gone.mp4");
        std::fs::write(&f, vec![0u8; 128]).expect("seed bytes");
        let file_path = f.to_string_lossy().into_owned();
        // 非 tg 来源：`reset_tg_flag` 直接放行 —— 验证字节删除这一半仍然工作。
        let id = st
            .store
            .upsert_media_item(
                "local",
                "x",
                "t",
                "video",
                Some(&file_path),
                Some(128),
                None,
                None,
            )
            .await
            .expect("insert item");

        let result = delete_media_item(State(st.clone()), Path(id)).await;
        assert!(result.is_ok(), "非 tg 来源的删除不应报错");
        assert!(!f.exists(), "正常删除必须真的把字节删掉");
        assert!(
            st.store.get_media_item(id).await.unwrap().is_none(),
            "条目必须从库里移除"
        );
    }

    // ---- TTFB：初始突发信用（每响应以「秒」为额度，随码率自动缩放）----

    /// 进程级 env 会跨并行测试相互影响，所有依赖投递 env 的计时用例共用同一把锁。
    static DELIVERY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 纯数学：burst 信用把速率曲线整体右移，稳态斜率仍是 `1 / bps`。
    #[test]
    fn delivery_due_secs_matches_burst_then_ramps() {
        // 首 1 MiB 落在 4s 信用内 → 「应有耗时」为 0（立即可发）。
        assert_eq!(delivery_due_secs(1024 * 1024, 1048576.0, 4.0), 0.0);
        // 8 MiB：应有耗时 8s − 4s 信用 = 4s。
        assert_eq!(delivery_due_secs(8 * 1024 * 1024, 1048576.0, 4.0), 4.0);
        // 0 字节 → 0。
        assert_eq!(delivery_due_secs(0, 1048576.0, 4.0), 0.0);
    }

    /// 验牙测试：带 burst 信用时，第一个块必须**立即**到达（TTFB 不再是 chunk/bps）。
    ///
    /// 4 MiB 文件 + `duration=500` ⇒ 速率被 1 MiB/s 下限钉住；`CHUNK = 1 MiB`，
    /// 旧实现首块要等 `1MiB / 1MiB/s ≈ 1000 ms`，本用例会因此 FAIL。
    /// BUG-226：`t` 锚点解析——缺省/近零归一为 None（走正式代理时间轴）。
    #[test]
    fn parse_stream_start_ignores_absent_and_near_zero() {
        let mut q: HashMap<String, String> = HashMap::new();
        assert_eq!(parse_stream_start(&q, Some(50)).unwrap(), None);
        q.insert("t".into(), "0".into());
        assert_eq!(parse_stream_start(&q, Some(50)).unwrap(), None);
        q.insert("t".into(), "0.1".into());
        assert_eq!(parse_stream_start(&q, Some(50)).unwrap(), None);
    }

    /// BUG-226：合法正锚点原样通过；前后空白容忍。
    #[test]
    fn parse_stream_start_accepts_positive_anchor() {
        let mut q: HashMap<String, String> = HashMap::new();
        q.insert("t".into(), "30".into());
        assert_eq!(parse_stream_start(&q, Some(50)).unwrap(), Some(30.0));
        q.insert("t".into(), " 12.5 ".into());
        assert_eq!(parse_stream_start(&q, None).unwrap(), Some(12.5));
    }

    /// BUG-226：垃圾与负数必须 400，绝不把任意字符串带进 ffmpeg 命令行。
    #[test]
    fn parse_stream_start_rejects_garbage_and_negative() {
        let mut q: HashMap<String, String> = HashMap::new();
        q.insert("t".into(), "abc".into());
        assert!(parse_stream_start(&q, None).is_err());
        q.insert("t".into(), "-1".into());
        assert!(parse_stream_start(&q, None).is_err());
        q.insert("t".into(), "NaN".into());
        assert!(parse_stream_start(&q, None).is_err());
    }

    /// BUG-226：锚点被钳进源内（至少给 ffmpeg 留 0.5s 可转）；未知时长不设上限。
    #[test]
    fn parse_stream_start_clamps_to_source_tail() {
        let mut q: HashMap<String, String> = HashMap::new();
        q.insert("t".into(), "49.9".into());
        assert_eq!(parse_stream_start(&q, Some(50)).unwrap(), Some(49.5));
        q.insert("t".into(), "1000".into());
        assert_eq!(parse_stream_start(&q, Some(50)).unwrap(), Some(49.5));
        q.insert("t".into(), "1000".into());
        assert_eq!(parse_stream_start(&q, None).unwrap(), Some(1000.0));
    }

    #[tokio::test]
    async fn serve_local_file_first_byte_is_immediate() {
        use futures::StreamExt;
        let _guard = DELIVERY_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 排除外部 env 干扰：清掉 bps / burst 覆盖，走纯默认路径。
        std::env::remove_var("ORIG_TG_DELIVERY_BPS");
        std::env::remove_var("ORIG_TG_DELIVERY_BURST_SECS");

        let dir = scratch_dir("first_byte");
        let f = dir.join("sample.mp4");
        std::fs::write(&f, vec![0u8; 4 * 1024 * 1024]).expect("seed 4 MiB");
        let path = f.to_string_lossy().into_owned();

        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-"));

        // 从发起到取回第一块 = 完整 time-to-first-byte。
        let t0 = std::time::Instant::now();
        let resp = match serve_local_file(&path, Some("video"), Some(500), &headers).await {
            Ok(r) => r,
            Err(e) => panic!("serve must succeed, got {}: {}", e.status, e.message()),
        };
        let mut stream = resp.into_body().into_data_stream();
        let first = stream.next().await.expect("must yield a first chunk");
        let elapsed = t0.elapsed();
        assert!(first.is_ok(), "first chunk must be Ok");
        assert!(
            elapsed < std::time::Duration::from_millis(150),
            "首块必须立即到达（burst 信用生效）；实际耗时 {elapsed:?}"
        );
    }

    /// 反向回归：burst 信用不得把稳态节流关掉（BUG-033 节流路径本身仍须生效）。
    ///
    /// BUG-199 之后默认不限速（环回口带宽免费），故本用例**显式开启**限速：
    /// 设 `ORIG_TG_DELIVERY_BPS=1048576`（1 MiB/s）且 `ORIG_TG_DELIVERY_BURST_SECS=0`，
    /// 4 MiB 读完整体必须 >= 3.0 s（理论上 ~4 s）。守住「环境变量启用节流时 pacing 仍在」。
    #[tokio::test]
    async fn serve_local_file_still_throttles() {
        let _guard = DELIVERY_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("ORIG_TG_DELIVERY_BPS", "1048576");
        std::env::set_var("ORIG_TG_DELIVERY_BURST_SECS", "0");

        let dir = scratch_dir("throttle");
        let f = dir.join("sample.mp4");
        std::fs::write(&f, vec![0u8; 4 * 1024 * 1024]).expect("seed 4 MiB");
        let path = f.to_string_lossy().into_owned();

        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-"));

        let t0 = std::time::Instant::now();
        let resp = match serve_local_file(&path, Some("video"), Some(500), &headers).await {
            Ok(r) => r,
            Err(e) => panic!("serve must succeed, got {}: {}", e.status, e.message()),
        };
        let body = axum::body::to_bytes(resp.into_body(), 16 * 1024 * 1024)
            .await
            .expect("body must be fully readable");
        let elapsed = t0.elapsed();
        // 无论断言结果如何都先清 env —— 它是进程级，会污染其他用例。
        std::env::remove_var("ORIG_TG_DELIVERY_BURST_SECS");

        assert_eq!(body.len(), 4 * 1024 * 1024, "必须读完整体");
        assert!(
            elapsed >= std::time::Duration::from_secs(3),
            "burst=0 时稳态节流必须仍在（4 MiB @ 1 MiB/s ⇒ ~4s）；实际耗时 {elapsed:?}"
        );
        // 无论断言结果如何都先清 env —— 它是进程级，会污染其他用例。
        std::env::remove_var("ORIG_TG_DELIVERY_BPS");
        std::env::remove_var("ORIG_TG_DELIVERY_BURST_SECS");
    }

    /// BUG-199 反向回归：环回口默认**不限速**。
    ///
    /// 不加任何 env 覆盖时，4 MiB 文件必须远快于节流（< 1 s 读完），
    /// 确保本地 WEB 投递与本地播放器同速、不再卡顿。
    #[tokio::test]
    async fn serve_local_file_unthrottled_by_default() {
        let _guard = DELIVERY_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 排除外部 env 干扰：清掉 bps / burst 覆盖，走纯默认路径。
        std::env::remove_var("ORIG_TG_DELIVERY_BPS");
        std::env::remove_var("ORIG_TG_DELIVERY_BURST_SECS");

        let dir = scratch_dir("unthrottled");
        let f = dir.join("sample.mp4");
        std::fs::write(&f, vec![0u8; 4 * 1024 * 1024]).expect("seed 4 MiB");
        let path = f.to_string_lossy().into_owned();

        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-"));

        let t0 = std::time::Instant::now();
        let resp = match serve_local_file(&path, Some("video"), Some(500), &headers).await {
            Ok(r) => r,
            Err(e) => panic!("serve must succeed, got {}: {}", e.status, e.message()),
        };
        let body = axum::body::to_bytes(resp.into_body(), 16 * 1024 * 1024)
            .await
            .expect("body must be fully readable");
        let elapsed = t0.elapsed();

        assert_eq!(body.len(), 4 * 1024 * 1024, "必须读完整体");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "环回口默认必须不限速（4 MiB 应远小于 1s 读完）；实际耗时 {elapsed:?}"
        );
    }

    // ---- D1=B 第一步：集的统一挂载读模型（路由层契约）----

    /// `GET /api/media/episodes/:id/bindings` 的**路由层**契约。
    ///
    /// 为什么不能只靠 `media.rs` 的单测（BUG-156）：那只证明「读模型算得对」，
    /// 证不了「路由挂得上、404 分得清、JSON 键名对」。这三件事只有路由层看得见：
    ///   1. **路由表能建起来** —— axum 对冲突/重复路由在建表时即 panic；
    ///   2. **集不存在 → 404** —— 不得静默返回空列表（那会让前端把「集没了」
    ///      误读成「这集没挂任何东西」）；
    ///   3. **JSON 键名契约** —— `itemId`/`role`/`seq`/`ref`，前端按它取数；
    ///      `ref` 键必须**存在**（可为 null），否则前端 `?.` 链会静默变 undefined。
    #[tokio::test]
    async fn episode_bindings_route_contract() {
        use crate::unavailable::UnavailableClient;

        let store = Store::open(":memory:")
            .await
            .expect("in-memory store must open");
        let st = Arc::new(AppState::new(
            Arc::new(UnavailableClient::new("test: link down")),
            Config::default(),
            Availability::Unavailable("test".to_string()),
            false,
            store,
        ));

        // ① 路由表可建（冲突/重复注册会在这里 panic，而不是等到运行时）
        let _ = router(st.clone());

        // ② 集不存在 ⇒ 404
        match list_episode_bindings(State(st.clone()), Path(999_999_i64)).await {
            Ok(_) => panic!("不存在的集必须 404，不得静默返回空列表"),
            Err(e) => assert_eq!(e.status, StatusCode::NOT_FOUND, "集不存在必须是 404"),
        }

        // ③ 存在的集 ⇒ 200 + 键名契约
        let sid = st
            .store
            .create_series("剧", None, "series", None, None)
            .await
            .unwrap();
        let vid = st
            .store
            .upsert_media_item("tg", "v:1", "主版本", "video", None, None, None, None)
            .await
            .unwrap();
        let ep = st.store.add_episode(sid, vid, 1, 1).await.unwrap();

        let resp = match list_episode_bindings(State(st.clone()), Path(ep)).await {
            Ok(r) => r.into_response(),
            Err(e) => panic!("存在的集必须 200，实得 {}: {}", e.status, e.message()),
        };
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("body must be readable");
        let v: serde_json::Value = serde_json::from_slice(&body).expect("must be JSON");
        let item = &v["items"][0];
        assert_eq!(item["role"], "main", "单来源集的第一项必须是 main");
        assert_eq!(item["itemId"], vid, "键名必须是 itemId（camelCase 契约）");
        assert_eq!(item["seq"], 0);
        assert_eq!(item["title"], "主版本");
        assert!(
            item.get("ref").is_some(),
            "`ref` 键必须存在（可为 null），否则前端取键会静默变 undefined"
        );
        assert_eq!(
            v["items"].as_array().map(|a| a.len()),
            Some(1),
            "只有主条目时**恰好** 1 项 —— 界面不该据此画出两个「来源」"
        );
    }

    // ---- byte-ownership P1：登记前移（metadata-first ingest） ----

    use super::run_one_cache_task;

    use std::collections::HashMap;

    use crate::login::{
        Channel, Client, ClientError, DownloadOutcome, Folder, LoginPhase,
        MediaItem as TgMedia, MediaRange, MediaStream, SessionView, Thumbnail,
    };
    use crate::media::ItemQuery;
    use crate::store::CacheTask;

    const CACHE_FIXTURE_CHAT: i64 = 424242;
    const CACHE_FIXTURE_GROUP: i64 = 9001;

    /// 测试夹具客户端：固定消息元数据 + 可注入的下载失败（P1 单测用）。
    struct CacheFixtureClient {
        chat_id: i64,
        msgs: HashMap<i64, TgMedia>,
        /// 下载必失败的消息号（模拟字节获取失败）。
        fail_downloads: Vec<i64>,
    }

    fn fixture_msg(
        id: i64,
        media_type: &str,
        mime: &str,
        caption: Option<&str>,
        group: Option<i64>,
    ) -> TgMedia {
        TgMedia {
            id,
            caption: caption.map(str::to_string),
            mime_type: Some(mime.to_string()),
            size: Some(4096),
            media_type: Some(media_type.to_string()),
            file_name: None,
            date: Some(1_700_000_000 + id),
            duration: if media_type == "video" { Some(12) } else { None },
            group_id: group,
            has_media: true,
        }
    }

    fn mixed_group_msgs() -> Vec<TgMedia> {
        vec![
            fixture_msg(1, "video", "video/mp4", Some("某剧 EP01 #tag"), Some(CACHE_FIXTURE_GROUP)),
            fixture_msg(2, "photo", "image/jpeg", None, Some(CACHE_FIXTURE_GROUP)),
            fixture_msg(3, "video", "video/mp4", Some("某剧 EP02"), Some(CACHE_FIXTURE_GROUP)),
            fixture_msg(4, "photo", "image/jpeg", None, Some(CACHE_FIXTURE_GROUP)),
        ]
    }

    #[async_trait::async_trait]
    impl Client for CacheFixtureClient {
        async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::CodeRequired)
        }
        async fn submit_code(&self, _p: &str, _c: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::Authorized)
        }
        async fn submit_password(&self, _p: &str, _w: &str) -> Result<LoginPhase, ClientError> {
            Err(ClientError::Other("no 2FA in fixture client".into()))
        }
        async fn view(&self) -> SessionView {
            SessionView { phase: LoginPhase::Authorized, phone: None, user_id: None }
        }
        async fn dialogs(&self) -> Result<Vec<Channel>, ClientError> {
            Ok(Vec::new())
        }
        async fn folders(&self) -> Result<Vec<Folder>, ClientError> {
            Ok(Vec::new())
        }
        async fn messages(
            &self,
            _chat_id: i64,
            _limit: u32,
            _before_id: Option<i64>,
        ) -> Result<Vec<TgMedia>, ClientError> {
            Ok(Vec::new())
        }
        async fn thumb(
            &self,
            _chat_id: i64,
            _message_id: i64,
        ) -> Result<Option<Thumbnail>, ClientError> {
            Ok(None)
        }
        async fn media(
            &self,
            _chat_id: i64,
            _message_id: i64,
            _range: Option<MediaRange>,
        ) -> Result<MediaStream, ClientError> {
            Err(ClientError::MediaNotFound)
        }
        async fn download(
            &self,
            chat_id: i64,
            message_id: i64,
            dir: &str,
            _progress: Option<&crate::login::DownloadProgress>,
        ) -> Result<DownloadOutcome, ClientError> {
            if self.fail_downloads.contains(&message_id) {
                return Err(ClientError::Other("injected download failure".into()));
            }
            let path = std::path::Path::new(dir).join(format!("fixture-{chat_id}-{message_id}.mp4"));
            std::fs::write(&path, b"fixture-bytes")
                .map_err(|e| ClientError::Other(format!("write: {e}")))?;
            Ok(DownloadOutcome {
                message_id,
                path: path.to_string_lossy().into_owned(),
                bytes: 13,
            })
        }
        async fn message_meta(
            &self,
            chat_id: i64,
            message_id: i64,
        ) -> Result<Option<TgMedia>, ClientError> {
            if chat_id != self.chat_id {
                return Ok(None);
            }
            Ok(self.msgs.get(&message_id).cloned())
        }
    }

    async fn cache_fixture_state(
        dir: &std::path::Path,
        fail: Vec<i64>,
        msgs: Vec<TgMedia>,
    ) -> Arc<AppState> {
        let mut by_id = HashMap::new();
        for m in msgs {
            by_id.insert(m.id, m);
        }
        let mut cfg = Config::default();
        cfg.download_dir = dir.to_path_buf();
        Arc::new(AppState::new(
            Arc::new(CacheFixtureClient {
                chat_id: CACHE_FIXTURE_CHAT,
                msgs: by_id,
                fail_downloads: fail,
            }),
            cfg,
            Availability::Ready,
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        ))
    }

    async fn enqueue_fixture_task(st: &AppState, ids: &[i64], group: Option<i64>) -> CacheTask {
        let key = match group {
            Some(g) => format!("g:{CACHE_FIXTURE_CHAT}:{g}"),
            None => format!("m:{CACHE_FIXTURE_CHAT}:{}", ids[0]),
        };
        st.store
            .enqueue_cache_task(
                CACHE_FIXTURE_CHAT,
                group,
                &key,
                ids,
                &st.config.download_dir.to_string_lossy(),
            )
            .await
            .expect("enqueue must succeed")
            .expect("task must be created")
            .0
    }

    /// BUG-181 判据 a：任务 1 在跑时入队任务 2，`/api/tg/cache/tasks` 必须同时给出
    /// running 的 `task` 与排队任务的 `queued` 覆盖摘要——入队即有反馈，不再无声消失。
    #[tokio::test]
    async fn queued_task_is_visible_in_tasks_endpoint() {
        let dir = scratch_dir("bug181_queued_visible");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![
                fixture_msg(1, "video", "video/mp4", Some("EP01"), None),
                fixture_msg(2, "video", "video/mp4", Some("EP02"), None),
                fixture_msg(3, "video", "video/mp4", Some("EP03"), None),
            ],
        )
        .await;
        let task_a = enqueue_fixture_task(&st, &[1, 2], None).await;
        let _task_b = enqueue_fixture_task(&st, &[3], None).await;
        // 任务 A 置 running（模拟 worker 在跑），快照刷新。
        let _ = st.store.mark_cache_task_running(task_a.id).await;
        st.refresh_cache_tasks().await;

        let resp = cache_tasks_payload(&st).await;
        let task = resp.get("task").cloned().expect("task field present");
        assert_eq!(
            task.get("id").and_then(|v| v.as_i64()),
            Some(task_a.id),
            "呈现的任务必须是 running 的任务 A"
        );
        let queued = resp
            .get("queued")
            .and_then(|v| v.as_array())
            .expect("queued array present");
        assert!(
            queued
                .iter()
                .any(|q| q.get("messageIds").and_then(|m| m.as_array())
                    .map(|m| m.contains(&json!(3)))
                    .unwrap_or(false)),
            "排队任务 B（msg 3）必须出现在 queued 覆盖摘要里，实际: {queued:?}"
        );
    }

    /// BUG-181 判据 b：running 任务的条目内字节进度注入 `itemBytes`/`itemBytesTotal`；
    /// 条目结束（end 解绑）后不再注入——旧字节不得错配给新状态。
    #[tokio::test]
    async fn item_byte_progress_is_injected_only_while_owned() {
        let dir = scratch_dir("bug181_progress");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(1, "video", "video/mp4", Some("EP01"), None)],
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1], None).await;
        let _ = st.store.mark_cache_task_running(task.id).await;
        st.refresh_cache_tasks().await;

        // 模拟 worker 下载中：绑定任务 + 字节 40/100。
        st.cache_dl_begin(task.id);
        st.cache_dl.set_total(100);
        st.cache_dl.add_bytes(40);
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        assert_eq!(
            task_json.get("itemBytes").and_then(|v| v.as_u64()),
            Some(40),
            "条目内字节必须注入"
        );
        assert_eq!(
            task_json.get("itemBytesTotal").and_then(|v| v.as_u64()),
            Some(100),
            "条目内总量必须注入"
        );

        // 解绑后（条目结束）：不再注入。
        st.cache_dl_end();
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        assert!(
            task_json.get("itemBytes").is_none(),
            "解绑后不得再注入 itemBytes"
        );
    }

    /// 分集结构快照：(episode_no, episode_no_end, 条目 ref, kind, has_bytes, 挂图 refs)。
    async fn episode_snapshot(
        st: &AppState,
        sid: i64,
    ) -> Vec<(i64, Option<i64>, String, String, bool, Vec<String>)> {
        let detail = st.store.get_series(sid).await.unwrap().unwrap();
        let mut out = Vec::new();
        for e in detail.episodes {
            let item = st.store.get_media_item(e.item_id).await.unwrap().unwrap();
            let mut image_refs = Vec::new();
            for im in &e.images {
                let it = st.store.get_media_item(im.item_id).await.unwrap().unwrap();
                image_refs.push(it.ref_key);
            }
            out.push((
                e.episode_no,
                e.episode_no_end,
                item.ref_key,
                e.kind.unwrap_or_default(),
                e.has_bytes,
                image_refs,
            ));
        }
        out
    }

    /// P1 判据 a：字节获取失败 → 条目**已登记**（file_path=NULL、槽位仍在）、
    /// 任务 failed——登记不回滚（设计 §2 Tf / I1；重试只重做字节）。
    #[tokio::test]
    async fn cache_task_failure_keeps_registered_item_without_bytes() {
        let dir = scratch_dir("p1_fail");
        let st = cache_fixture_state(
            &dir,
            vec![2],
            vec![
                fixture_msg(1, "video", "video/mp4", Some("某剧 EP01"), None),
                fixture_msg(2, "video", "video/mp4", Some("某剧 EP02"), None),
            ],
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1, 2], None).await;
        run_one_cache_task(&st, task.id).await;

        let t = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(t.status, "failed", "字节失败任务必须如实 failed");

        // 条目 1（成功）：字节已回填。
        let id1 = st
            .store
            .item_id_by_ref("tg", "424242:1")
            .await
            .unwrap()
            .expect("item 1 must be registered");
        let it1 = st.store.get_media_item(id1).await.unwrap().unwrap();
        assert_eq!(it1.kind, "video");
        assert!(it1.file_path.is_some(), "成功条目必须已回填 file_path");

        // 条目 2（失败）：T0 已登记、保留、缺字节。
        let id2 = st
            .store
            .item_id_by_ref("tg", "424242:2")
            .await
            .unwrap()
            .expect("failed item must stay registered (no rollback)");
        let it2 = st.store.get_media_item(id2).await.unwrap().unwrap();
        assert_eq!(it2.kind, "video");
        assert!(it2.file_path.is_none(), "失败条目不得回填 file_path");

        // 槽位在 T0 即建立（先于字节）：两条分集都在。
        let series = st.store.list_series().await.unwrap();
        assert_eq!(series.len(), 1, "同一任务的两条视频必须同剧");
        let detail = st.store.get_series(series[0].id).await.unwrap().unwrap();
        let eps: Vec<(i64, i64)> = detail.episodes.iter().map(|e| (e.episode_no, e.item_id)).collect();
        assert_eq!(eps, vec![(1, id1), (2, id2)], "T0 槽位失败不回滚");
    }

    /// P1 判据 b：混编组逐条登记后的最终库状态与旧实现**等价**（同 item/episode
    /// 结构）。对照组用旧实现语义直接驱动 store（消息 upsert + 带路径 upsert +
    /// 一次性 ranged append + 末尾统一挂图），逐结构比对。
    ///
    /// 夹具 [视频1, 照片2, 视频3, 照片4]（同 group）：照片2 是组首 → 归首个视频
    /// （EP01 那集）；照片4 归它之前最近的视频（EP02 那集）——BUG-168 语义。
    #[tokio::test]
    async fn mixed_group_incremental_registration_equals_legacy_batch() {
        let msgs = mixed_group_msgs();

        // ── 新实现：逐条登记（T0 → 字节 → 回填）──
        let dir_new = scratch_dir("p1_equiv_new");
        let st_new = cache_fixture_state(&dir_new, vec![], msgs.clone()).await;
        let t = enqueue_fixture_task(&st_new, &[1, 2, 3, 4], Some(CACHE_FIXTURE_GROUP)).await;
        run_one_cache_task(&st_new, t.id).await;

        // ── 旧实现（重构前 run_one_cache_task 尾段）逐字复刻，store 直驱 ──
        let dir_old = scratch_dir("p1_equiv_old");
        let st_old = cache_fixture_state(&dir_old, vec![], msgs.clone()).await;
        let sid_old = {
            let store = &st_old.store;
            let chat = CACHE_FIXTURE_CHAT;
            // 旧 cache_one / import_photo_item：先补消息行（caption 等元数据）。
            for m in &msgs {
                let _ = store
                    .upsert_message(
                        chat,
                        m.id,
                        m.caption.as_deref(),
                        m.mime_type.as_deref(),
                        m.size,
                        m.media_type.as_deref(),
                        m.date,
                        m.duration,
                        m.group_id,
                    )
                    .await;
            }
            let mut ingested: Vec<(i64, i64)> = Vec::new();
            for m in &msgs {
                let ref_key = format!("{chat}:{}", m.id);
                let id = if m.media_type.as_deref() == Some("photo") {
                    store
                        .upsert_media_item(
                            "tg",
                            &ref_key,
                            &format!("TG 图片 #{}", m.id),
                            "photo",
                            None,
                            m.size,
                            None,
                            None,
                        )
                        .await
                        .unwrap()
                } else {
                    let path = dir_old.join(format!("fixture-{chat}-{}.mp4", m.id));
                    // 旧实现里路径来自真实下载落盘；对照组同样写出夹具文件，
                    // 让 has_bytes 的磁盘探测与新旧两侧同一真值。
                    std::fs::write(&path, b"fixture-bytes").expect("fixture file must write");
                    let (title, desc) = crate::media::split_caption(m.caption.as_deref().unwrap_or(""));
                    store
                        .upsert_media_item(
                            "tg",
                            &ref_key,
                            &title.unwrap_or_default(),
                            "video",
                            Some(&path.to_string_lossy()),
                            m.size,
                            m.duration,
                            desc.as_deref(),
                        )
                        .await
                        .unwrap()
                };
                ingested.push((m.id, id));
            }
            // 旧尾段：kind 批量取回 → 混编判定 → media_pairs（非照片）→ ranged append。
            let ids: Vec<i64> = ingested.iter().map(|(_, id)| *id).collect();
            let kinds = store.item_kinds(&ids).await.unwrap();
            let photo_pairs: Vec<(i64, i64)> = ingested
                .iter()
                .filter(|(_, id)| kinds.get(id).map(|k| k == "photo").unwrap_or(false))
                .copied()
                .collect();
            let has_video = kinds.values().any(|k| k == "video");
            assert!(has_video && !photo_pairs.is_empty(), "夹具必须是混编组");
            let media_pairs: Vec<(i64, i64)> = ingested
                .iter()
                .filter(|(_, id)| kinds.get(id).map(|k| k != "photo").unwrap_or(true))
                .copied()
                .collect();
            // 旧标题链：first_caption → split_caption → normalized_series_name。
            let cap = store.first_caption(chat, &[1, 2, 3, 4]).await.unwrap().unwrap();
            let (t0, d0) = crate::media::split_caption(&cap);
            let title = normalized_series_name(&t0.unwrap());
            let sid = store
                .create_series(&title, d0.as_deref(), "series", None, Some("tg:group:424242:9001"))
                .await
                .unwrap();
            // 旧 ranged_items：caption 集号区间。
            let mut items = Vec::new();
            for (mid, iid) in &media_pairs {
                let range = store
                    .get_message(chat, *mid)
                    .await
                    .unwrap()
                    .unwrap()
                    .caption
                    .as_deref()
                    .and_then(crate::media::parse_episode_range)
                    // BUG-205：丢弃 caption 解析出的合集终点，单集优先（多集仅手动编辑）
                    .map(|(s, _e)| (s, s));
                items.push((*iid, range));
            }
            store.append_episodes_ranged(sid, 1, &items).await.unwrap();
            // 旧挂图：向前最近的非照片条目，组首归首个。
            for (mid, item) in &photo_pairs {
                let target_msg = media_pairs
                    .iter()
                    .map(|(m, _)| *m)
                    .filter(|m| *m < *mid)
                    .max()
                    .or_else(|| media_pairs.iter().map(|(m, _)| *m).min())
                    .unwrap();
                let target_item = media_pairs.iter().find(|(m, _)| *m == target_msg).unwrap().1;
                let eid = store.episode_id_of_item(sid, target_item).await.unwrap().unwrap();
                store.add_episode_image(eid, *item).await.unwrap();
            }
            sid
        };

        // ── 逐结构比对 ──
        let s_new = st_new.store.list_series().await.unwrap();
        let s_old = st_old.store.list_series().await.unwrap();
        assert_eq!(s_new.len(), 1, "新实现必须恰好一部剧");
        assert_eq!(s_old.len(), 1);
        assert_eq!(s_new[0].title, s_old[0].title, "剧集标题必须等价");
        assert_eq!(s_new[0].kind, s_old[0].kind);
        let d_new = st_new.store.get_series(s_new[0].id).await.unwrap().unwrap();
        let d_old = st_old.store.get_series(sid_old).await.unwrap().unwrap();
        assert_eq!(d_new.episodes.len(), d_old.episodes.len(), "分集数必须等价");
        for (en, eo) in d_new.episodes.iter().zip(d_old.episodes.iter()) {
            assert_eq!(en.episode_no, eo.episode_no, "集号必须等价");
            assert_eq!(en.episode_no_end, eo.episode_no_end, "合集终点必须等价");
            let rn = st_new.store.get_media_item(en.item_id).await.unwrap().unwrap();
            let ro = st_old.store.get_media_item(eo.item_id).await.unwrap().unwrap();
            assert_eq!(rn.ref_key, ro.ref_key, "同槽位必须是同一条 TG 消息");
            assert_eq!(rn.kind, ro.kind, "条目 kind 必须等价");
            assert_eq!(rn.file_path.is_some(), ro.file_path.is_some(), "字节态必须等价");
            assert_eq!(en.has_bytes, eo.has_bytes);
            // 挂图（浏览位）逐一比对。
            let inew = st_new.store.list_episode_images(en.id).await.unwrap();
            let iold = st_old.store.list_episode_images(eo.id).await.unwrap();
            let mut refs_new = Vec::new();
            for m in &inew {
                refs_new.push(st_new.store.get_media_item(m.item_id).await.unwrap().unwrap().ref_key);
            }
            let mut refs_old = Vec::new();
            for m in &iold {
                refs_old.push(st_old.store.get_media_item(m.item_id).await.unwrap().unwrap().ref_key);
            }
            assert_eq!(refs_new, refs_old, "集 {} 的挂图必须等价", en.episode_no);
        }
    }

    /// P1 判据 c：幂等重跑不产生重复条目/重复剧集/重复分集/重复挂图，
    /// 且库状态与首次运行完全一致（同 ref 复用、append 跳过、挂图 insert-or-ignore）。
    #[tokio::test]
    async fn cache_task_rerun_is_idempotent() {
        let msgs = mixed_group_msgs();
        let dir = scratch_dir("p1_rerun");
        let st = cache_fixture_state(&dir, vec![], msgs).await;
        let t1 = enqueue_fixture_task(&st, &[1, 2, 3, 4], Some(CACHE_FIXTURE_GROUP)).await;
        run_one_cache_task(&st, t1.id).await;

        let series = st.store.list_series().await.unwrap();
        assert_eq!(series.len(), 1);
        let sid = series[0].id;
        let first = episode_snapshot(&st, sid).await;

        // 重跑：同组再次入队（首个任务已终态 → 新任务行），文件已缓存走幂等跳过。
        let t2 = enqueue_fixture_task(&st, &[1, 2, 3, 4], Some(CACHE_FIXTURE_GROUP)).await;
        run_one_cache_task(&st, t2.id).await;
        let t2s = st.store.get_cache_task(t2.id).await.unwrap().unwrap();
        assert_eq!(t2s.status, "done", "重跑必须成功（幂等跳过）");

        let items = st
            .store
            .list_media_items(&ItemQuery::default())
            .await
            .unwrap();
        assert_eq!(items.len(), 4, "重跑不得新增条目");
        let series2 = st.store.list_series().await.unwrap();
        assert_eq!(series2.len(), 1, "重跑不得建第二部剧");
        assert_eq!(series2[0].id, sid);
        let second = episode_snapshot(&st, sid).await;
        assert_eq!(first, second, "重跑后的库状态必须与首次运行完全一致");
    }

    // ---- BUG-186：剧集合并路由层契约（多源批量 / 单源兼容）----

    /// 构造一个仅用于合并路由用例的 `AppState`（内存库）。
    async fn merge_fixture_state() -> Arc<AppState> {
        use crate::unavailable::UnavailableClient;
        Arc::new(AppState::new(
            Arc::new(UnavailableClient::new("test: merge route")),
            Config::default(),
            Availability::Unavailable("test".to_string()),
            false,
            Store::open(":memory:")
                .await
                .expect("in-memory store must open"),
        ))
    }

    /// 调用 `merge_media_series` 并解构为 `(状态码, JSON)`。
    ///
    /// `ApiError` 未实现 `Debug`，`Ok` 侧是 `impl IntoResponse`（同样无 `Debug`），
    /// 故不能用 `unwrap` / `expect_err`，这里手写解构。
    async fn merge_call(
        st: Arc<AppState>,
        target: i64,
        req: MergeSeriesReq,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, String)> {
        match merge_media_series(State(st), Path(target), Json(req)).await {
            Ok(resp) => {
                let resp = resp.into_response();
                let status = resp.status();
                let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
                    .await
                    .expect("body must be readable");
                let v: serde_json::Value =
                    serde_json::from_slice(&bytes).expect("body must be JSON");
                Ok((status, v))
            }
            Err(e) => Err((e.status, e.message().to_string())),
        }
    }

    /// 既有单源形态 `{ "sourceId": N }` 必须继续可用（剧集内页入口在用），
    /// 且响应体形状不变（`added` / `skippedCount` / `skipped`）。
    #[tokio::test]
    async fn merge_route_legacy_source_id_still_works() {
        let st = merge_fixture_state().await;
        // 顺带证明路由表能建起来（重复/冲突路由在建表时即 panic）。
        let _ = router(st.clone());

        let target = st.store.create_series("T", None, "series", None, None).await.unwrap();
        let src = st.store.create_series("S", None, "series", None, None).await.unwrap();
        let item = st
            .store
            .upsert_media_item("tg", "s:1", "s1", "video", None, None, None, None)
            .await
            .unwrap();
        let _ = st.store.add_episode(src, item, 1, 1).await.unwrap();

        let (status, v) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: Some(src), source_ids: None },
        )
        .await
        .expect("单源形态必须继续可用");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["added"], 1, "应并入 1 集");
        assert_eq!(v["skippedCount"], 0, "响应体形状不变");
        assert!(v.get("skipped").is_some(), "`skipped` 键必须存在");
        assert!(st.store.get_series(src).await.unwrap().is_none(), "源应被删除");
    }

    /// 新增多源形态 `{ "sourceIds": [...] }`：3 个源一次事务并入目标。
    #[tokio::test]
    async fn merge_route_batch_merges_multiple_sources() {
        let st = merge_fixture_state().await;
        let target = st.store.create_series("T", None, "series", None, None).await.unwrap();
        let mut sources = Vec::new();
        for si in 0..3 {
            let s = st
                .store
                .create_series(&format!("S{si}"), None, "series", None, None)
                .await
                .unwrap();
            let item = st
                .store
                .upsert_media_item("tg", &format!("s{si}:1"), "x", "video", None, None, None, None)
                .await
                .unwrap();
            let _ = st.store.add_episode(s, item, 1, 1).await.unwrap();
            sources.push(s);
        }

        let (status, v) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: None, source_ids: Some(sources.clone()) },
        )
        .await
        .expect("多源形态必须可用");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["added"], 3, "3 个源各 1 集 → 搬入 3 集");
        assert_eq!(v["skippedCount"], 0);

        for s in &sources {
            assert!(
                st.store.get_series(*s).await.unwrap().is_none(),
                "源 {s} 应被删除"
            );
        }
        let after = st.store.get_series(target).await.unwrap().unwrap();
        assert_eq!(after.episodes.len(), 3, "目标应有三条分集");
    }

    /// 路由层回滚：`sourceIds` 里混一个不存在的 id → 404，且源与目标都保持原样。
    #[tokio::test]
    async fn merge_route_batch_rolls_back_on_missing_source() {
        let st = merge_fixture_state().await;
        let target = st.store.create_series("T", None, "series", None, None).await.unwrap();
        let s1 = st.store.create_series("S1", None, "series", None, None).await.unwrap();
        let i1 = st
            .store
            .upsert_media_item("tg", "a:1", "a", "video", None, None, None, None)
            .await
            .unwrap();
        let _ = st.store.add_episode(s1, i1, 1, 1).await.unwrap();

        let s1_before = st.store.get_series(s1).await.unwrap().unwrap().episodes.len();
        let target_before = st.store.get_series(target).await.unwrap().unwrap().episodes.len();
        assert_eq!(s1_before, 1);
        assert_eq!(target_before, 0);

        let (status, _msg) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: None, source_ids: Some(vec![s1, 999_999]) },
        )
        .await
        .expect_err("含不存在的源必须 404");
        assert_eq!(status, StatusCode::NOT_FOUND);

        // 无副作用：源与目标分集数都保持原样。
        assert_eq!(
            st.store.get_series(s1).await.unwrap().unwrap().episodes.len(),
            s1_before,
            "源 S1 必须保持原样（整体回滚）"
        );
        assert_eq!(
            st.store.get_series(target).await.unwrap().unwrap().episodes.len(),
            target_before,
            "目标必须保持原样（整体回滚）"
        );
    }

    /// 自合并（源含目标）→ 400 且无副作用；既有单源自合并形态同样 400。
    #[tokio::test]
    async fn merge_route_rejects_self_merge() {
        let st = merge_fixture_state().await;
        let target = st.store.create_series("T", None, "series", None, None).await.unwrap();
        let s1 = st.store.create_series("S1", None, "series", None, None).await.unwrap();

        // 多源形态含目标 → 400。
        let (status, _m) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: None, source_ids: Some(vec![s1, target]) },
        )
        .await
        .expect_err("源含目标必须 400");
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // 既有单源形态：sourceId == 目标 → 400（逐字保留旧行为）。
        let (status2, _m2) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: Some(target), source_ids: None },
        )
        .await
        .expect_err("单源自合并必须 400");
        assert_eq!(status2, StatusCode::BAD_REQUEST);

        assert!(st.store.get_series(target).await.unwrap().is_some(), "目标必须仍在");
        assert!(st.store.get_series(s1).await.unwrap().is_some(), "源必须仍在");
    }

    /// 两者都不给 → 400；空数组 → 400。
    #[tokio::test]
    async fn merge_route_rejects_missing_or_empty_body() {
        let st = merge_fixture_state().await;
        let target = st.store.create_series("T", None, "series", None, None).await.unwrap();

        let (e1, _) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: None, source_ids: None },
        )
        .await
        .expect_err("两者都不给必须 400");
        assert_eq!(e1, StatusCode::BAD_REQUEST);

        let (e2, _) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: None, source_ids: Some(vec![]) },
        )
        .await
        .expect_err("空数组必须 400");
        assert_eq!(e2, StatusCode::BAD_REQUEST);
    }

    /// 两者都给 → 以 `sourceIds` 为准（不静默丢弃）。
    #[tokio::test]
    async fn merge_route_prefers_source_ids_when_both_given() {
        let st = merge_fixture_state().await;
        let target = st.store.create_series("T", None, "series", None, None).await.unwrap();
        let a = st.store.create_series("A", None, "series", None, None).await.unwrap();
        let b = st.store.create_series("B", None, "series", None, None).await.unwrap();
        let ia = st
            .store
            .upsert_media_item("tg", "a:1", "a", "video", None, None, None, None)
            .await
            .unwrap();
        let ib = st
            .store
            .upsert_media_item("tg", "b:1", "b", "video", None, None, None, None)
            .await
            .unwrap();
        let _ = st.store.add_episode(a, ia, 1, 1).await.unwrap();
        let _ = st.store.add_episode(b, ib, 1, 1).await.unwrap();

        // sourceId=A 与 sourceIds=[B] 同时给 → 只并 B，A 不受影响。
        let (status, v) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: Some(a), source_ids: Some(vec![b]) },
        )
        .await
        .expect("两者都给应成功");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["added"], 1, "只应并入 sourceIds 指定的 B");
        assert!(st.store.get_series(b).await.unwrap().is_none(), "B 应被删除");
        assert!(
            st.store.get_series(a).await.unwrap().is_some(),
            "A 必须未被合并（sourceId 被忽略）"
        );
    }

    /// `sourceIds` 去重：重复 id 只合并一次，不报错、不重复搬。
    #[tokio::test]
    async fn merge_route_dedupes_repeated_source_ids() {
        let st = merge_fixture_state().await;
        let target = st.store.create_series("T", None, "series", None, None).await.unwrap();
        let a = st.store.create_series("A", None, "series", None, None).await.unwrap();
        let ia = st
            .store
            .upsert_media_item("tg", "a:1", "a", "video", None, None, None, None)
            .await
            .unwrap();
        let _ = st.store.add_episode(a, ia, 1, 1).await.unwrap();

        let (status, v) = merge_call(
            st.clone(),
            target,
            MergeSeriesReq { source_id: None, source_ids: Some(vec![a, a, a]) },
        )
        .await
        .expect("重复 id 应被去重而非报错");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["added"], 1, "去重后只搬 1 集");
        assert!(st.store.get_series(a).await.unwrap().is_none(), "源应被删除");
    }
}

// 内联单页（无外部资源）：浏览器打开 http://127.0.0.1:9877 即可完成
// 登录 / 枚举订阅 / 拉史 / 下载 的全流程调试。
const DEBUG_PAGE: &str = r#"
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>orig-tg 调试控制台</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 18px; }
  section { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  section > h2 { font-size: 14px; margin: 0 0 12px; }
  label { display: block; margin-bottom: 8px; }
  input, button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #ccc; }
  input { width: 260px; }
  button { cursor: pointer; background: #226fd9; color: #fff; border-color: #226fd9; margin-left: 8px; }
  button.ghost { background: transparent; color: inherit; }
  #status { font-weight: 600; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  pre { background: rgba(127,127,127,.12); border-radius: 6px; padding: 10px; overflow: auto; max-height: 320px; }
  .msg { background: rgba(127,127,127,.08); border-radius: 6px; padding: 8px 10px; }
  .msg + .msg { margin-top: 6px; }
  #log { color: #888; font-size: 12px; margin-bottom: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>orig-tg 调试控制台</h1>
  <div class="sub">Telegram 频道内容整理 · 独立 sidecar 服务 · REST + 内嵌调试页</div>
  <div id="log"></div>
  <div class="row"><span id="status">——</span><button class="ghost" onclick="refresh()">刷新</button></div>

  <section>
    <h2>登录</h2>
    <div class="row">
      <input id="phone" placeholder="+86 139…" autocomplete="off">
      <button onclick="doStart()">发送验证码</button>
    </div>
    <div class="row" id="codeRow" style="display:none">
      <input id="code" placeholder="验证码" autocomplete="off">
      <button onclick="doCode()">提交验证码</button>
    </div>
    <div class="row" id="pwdRow" style="display:none">
      <input id="password" type="password" placeholder="两步验证密码" autocomplete="off">
      <button onclick="doPassword()">提交密码</button>
    </div>
  </section>

  <section>
    <h2>订阅频道</h2>
    <div class="row"><button onclick="loadDialogs()">枚举订阅频道</button></div>
    <pre id="dialogs">未加载</pre>
  </section>

  <section>
    <h2>频道媒体历史</h2>
    <div class="row">
      <input id="chatId" placeholder="频道 id (Dialogs 中第一列)" autocomplete="off">
      <button onclick="loadMessages()">拉取媒体历史</button>
      <label style="margin:0">条数 <input id="limit" value="50" style="width:70px"></label>
    </div>
    <pre id="messages">未加载</pre>
  </section>

  <section>
    <h2>下载</h2>
    <div class="row">
      <input id="dlChat" placeholder="频道 id" autocomplete="off">
      <input id="dlMsg" placeholder="消息 id" autocomplete="off">
      <input id="dlDir" placeholder="落地目录(留空用默认)" autocomplete="off" style="width:220px">
      <button onclick="doDownload()">下载到本地</button>
    </div>
    <pre id="result">——</pre>
  </section>

<script>
const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  log('> ' + path);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => null);
  log('< ' + r.status + ' ' + (data ? JSON.stringify(data) : r.statusText));
  if (!r.ok) throw new Error((data && data.error) || r.statusText);
  return data;
};
const log = (t) => {
  const d = new Date().toTimeString().slice(0, 8);
  const el = $('#log');
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + d + '  ' + t;
};

async function refresh() {
  try { const v = await api('/api/tg/session'); $('#status').textContent = '会话: ' + v.phase; }
  catch (e) { $('#status').textContent = e.message; }
}
async function doStart() {
  const phone = $('#phone').value.trim();
  await api('/api/tg/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ phone }) });
  $('#codeRow').style.display = 'block';
  await refresh();
}
async function doCode() {
  const phone = $('#phone').value.trim(), code = $('#code').value.trim();
  try {
    const r = await api('/api/tg/code', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ phone, code }) });
    if (r.phase === 'PasswordRequired') { $('#pwdRow').style.display = 'block'; }
  } catch (e) { alert(e.message); }
  await refresh();
}
async function doPassword() {
  const phone = $('#phone').value.trim(), password = $('#password').value;
  try { await api('/api/tg/code', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ phone, password }) }); }
  catch (e) { alert(e.message); }
  await refresh();
}
async function loadDialogs() {
  const d = await api('/api/tg/dialogs');
  $('#dialogs').textContent = JSON.stringify(d, null, 2);
}
async function loadMessages() {
  const id = $('#chatId').value.trim(), limit = $('#limit').value.trim() || '50';
  const m = await api('/api/tg/messages/' + id + '?limit=' + limit);
  $('#messages').textContent = JSON.stringify(m, null, 2);
}
async function doDownload() {
  const chat = $('#dlChat').value.trim(), msg = $('#dlMsg').value.trim();
  const dir = $('#dlDir').value.trim();
  const body = dir ? JSON.stringify({ dir }) : '{}';
  const r = await api('/api/tg/download/' + chat + '/' + msg, { method: 'POST', headers: {'Content-Type':'application/json'}, body });
  $('#result').textContent = JSON.stringify(r, null, 2);
}
refresh();
</script>
</body>
</html>
"#;