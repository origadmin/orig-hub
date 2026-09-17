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

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::login::{ClientError, DownloadOutcome, LoginPhase, MediaRange};
use crate::monitor;
use crate::state::{AppState, Availability};
use crate::store::StoredQuery;

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
        .route("/api/tg/cache/clear", axum::routing::post(clear_cache))
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
        .route("/api/tg/cache/finished", axum::routing::delete(clear_finished_cache_tasks))
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
            "/api/media/episodes/:id",
            axum::routing::patch(patch_media_episode).delete(delete_media_episode),
        )
        .route("/api/media/tags", get(list_media_tags).post(create_media_tag))
        .route(
            "/api/media/tags/:id",
            axum::routing::patch(patch_media_tag).delete(delete_media_tag),
        )
        .route("/api/media/scan", axum::routing::post(scan_media_dir))
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
    Json(json!({
        "health": "ok",
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
async fn dialogs(State(st): State<Arc<AppState>>, Query(q): Query<DialogsQuery>) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    let limit = q.limit.clamp(1, 200);
    let offset = q.offset.max(0);

    let total = st
        .store
        .count_dialogs()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    // 首启无缓存，或显式刷新：触发后台全量扫描（内部自行去重，不会并发重复跑）。
    if total == 0 || q.refresh != 0 {
        spawn_dialog_scan(st.clone());
    }

    let mut items = st
        .store
        .read_dialogs(offset, limit)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // folder 实时修正（BUG-017）：dialog_cache.folder 覆盖不全（历史扫描缺列），
    // 以 TG 实时 DialogFilter 的 channel_ids 映射为准覆盖；读取失败时静默保留旧值。
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
    let total = st
        .store
        .count_dialogs()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let has_more = total > offset + limit as i64;
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

/// POST /api/tg/cache/clear — 清空分组缓存（仅清缓存表，不删除任何用户数据）。
async fn clear_cache(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    st.store
        .clear_dialog_cache()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.push_log("/api/tg/cache/clear");
    Ok(Json(json!({"ok": true})))
}

async fn folders(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    let folders = st.client.folders().await?;
    Ok(Json(folders))
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
    let items = st.client.messages(chat_id, limit, q.before_id).await?;
    // 拉满一页则可能还有更早历史；不足一页说明已到顶。
    let has_more = items.len() as u32 >= limit;
    Ok(Json(json!({"items": items, "hasMore": has_more})))
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
    let Some(t) = st.client.thumb(chat_id, message_id).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "thumbnail not available"));
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
    if !std::path::Path::new(&path).exists() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cached file missing"));
    }
    serve_local_file(&path, msg.media_type.as_deref(), msg.duration, &headers).await
}

/// 下载目录当前生效值：DB 设置 > env/默认配置。
async fn effective_download_dir(st: &AppState) -> String {
    st.store
        .get_setting("download_dir")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| st.config.download_dir.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
struct ConfigUpdateReq {
    #[serde(rename = "downloadDir")]
    download_dir: String,
}

/// GET /api/tg/config — 运行时配置快照（缓存下载目录等）。
async fn get_config(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let download_dir = effective_download_dir(&st).await;
    Ok(Json(json!({ "downloadDir": download_dir })))
}

/// PUT /api/tg/config — 更新运行时配置（当前仅 downloadDir），持久化到 app_setting。
async fn put_config(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ConfigUpdateReq>,
) -> Result<impl IntoResponse, ApiError> {
    let dir = req.download_dir.trim().to_string();
    if dir.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "downloadDir is empty"));
    }
    // 预创建校验：目录不可创建（权限/非法字符）时拒绝保存。
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, &format!("create dir: {e}")))?;
    st.store
        .set_setting("download_dir", &dir)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({ "downloadDir": dir })))
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
async fn resolve_cache_dir(st: &AppState, req_dir: Option<String>) -> String {
    let db_dir = st
        .store
        .get_setting("download_dir")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty());
    req_dir
        .filter(|s| !s.is_empty())
        .or(db_dir)
        .unwrap_or_else(|| st.config.download_dir.to_string_lossy().into_owned())
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
    if tokio::fs::metadata(&p).await.is_ok() {
        Some(p)
    } else {
        None
    }
}

/// 下载单条并入库（元数据回填 + 标记已缓存）。同步端点与后台任务共用同一实现。
async fn cache_one(
    st: &AppState,
    chat_id: i64,
    message_id: i64,
    dir: &str,
) -> Result<(DownloadOutcome, Option<i64>), ApiError> {
    let outcome = st.client.download(chat_id, message_id, dir).await?;
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
    // 缓存即入库（媒体管理主视图）：TG 缓存内容登记进 media_item，媒体管理
    // （含剧集归集/标签/搜索）从此可见。ref 约定与 import_media_items 一致：
    // source="tg"、ref="<chat_id>:<message_id>"（按 (source,ref) 幂等，重复缓存不产生副本）。
    // title 取 caption，缺省退化为落盘文件名；kind 由扩展名分类，mime 前缀兜底；
    // 元数据缺失时从落盘文件兜底，保证任何成功缓存都可入库。
    {
        let file_name = std::path::Path::new(&outcome.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let ext = std::path::Path::new(&outcome.path)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let title = meta
            .as_ref()
            .and_then(|m| {
                m.caption
                    .as_deref()
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or(file_name);
        let kind = crate::media::classify_ext(&ext)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let mime = meta.as_ref().and_then(|m| m.mime_type.as_deref());
                match mime {
                    Some(m) if m.starts_with("video/") => "video".to_string(),
                    Some(m) if m.starts_with("image/") => "image".to_string(),
                    Some(m) if m.starts_with("audio/") => "audio".to_string(),
                    _ => "file".to_string(),
                }
            });
        let size = meta
            .as_ref()
            .and_then(|m| m.size)
            .or_else(|| std::fs::metadata(&outcome.path).ok().map(|x| x.len() as i64));
        let duration = meta.as_ref().and_then(|m| m.duration);
        match st
            .store
            .upsert_media_item(
                "tg",
                &format!("{chat_id}:{message_id}"),
                &title,
                &kind,
                Some(&outcome.path),
                size,
                duration,
            )
            .await
        {
            Ok(id) => {
                // 返回入库 id：整组缓存时 worker 据此把一批条目编成剧集（BUG-031）。
                return Ok((outcome, Some(id)));
            }
            Err(e) => {
                st.push_log(&format!("cache ingest failed for {chat_id}:{message_id}: {e}"));
            }
        }
    }
    Ok((outcome, None))
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

/// GET /api/tg/cache/tasks — 返回**当前唯一**任务（设计裁定：不论多少缓存在排队，
/// 这个端点只返回一个结果）。选取顺序：running → 最老 queued → 最近一条已结束
/// （供前端收尾展示与失败提示）；队列为空且无历史时 `task: null`。
///
/// **读路径 O(1)**：服务内存快照，不碰 SQLite。快照由每个 DB 写点同步刷新，
/// 与 worker 的写永远一致（见 `AppState::refresh_cache_tasks`）。
/// 这是前端 1s 轮询的高频端点——读走内存是流畅度的底线。
async fn list_cache_tasks(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let tasks = st.cache_tasks_snapshot().await;
    // 单飞模型下快照里至多一个 running（+ 若干 queued）；按端点契约选出一个呈现。
    let task = tasks
        .iter()
        .find(|t| t.status == "running")
        .or_else(|| tasks.iter().find(|t| t.status == "queued"))
        .or_else(|| tasks.first())
        .cloned();
    Ok(Json(json!({ "task": task })))
}

/// GET /api/tg/cache/tasks/all — 全量任务列表 + 各状态计数（缓存管理面板）。
/// 活跃优先、新→旧，上限 500；counts 覆盖全部状态（未出现为 0）。
async fn list_all_cache_tasks(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let tasks = st
        .store
        .list_cache_tasks(500)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
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

/// DELETE /api/tg/cache/finished — 清除全部终态任务记录（活跃任务不动）。
async fn clear_finished_cache_tasks(
    State(st): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let removed = st
        .store
        .clear_finished_cache_tasks()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.refresh_cache_tasks().await;
    st.push_log(&format!("/api/tg/cache/finished removed={removed}"));
    Ok(Json(json!({"ok": true, "removed": removed})))
}

/// GET /api/tg/cache/tasks/:id — 读取单个任务（轮询用，避免每次拉全量列表）。
async fn cache_task_by_id(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    match st.store.get_cache_task(id).await {
        Ok(Some(t)) => Ok(Json(t)),
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

/// 跑单个任务直到终态（done / failed / cancelled）。
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
    // 入库条目 id（按 message_ids 顺序）——整组缓存据此编成剧集。
    let mut item_ids: Vec<i64> = Vec::new();
    for msg_id in task.message_ids.iter().copied() {
        if !st.store.is_cache_task_active(task_id).await.unwrap_or(false) {
            st.push_log(format!(
                "cache task {task_id}: cancelled at {done}/{}",
                task.total
            ));
            return;
        }
        let _ = st
            .store
            .update_cache_task_progress(task_id, done, Some(msg_id))
            .await;
        st.refresh_cache_tasks().await;
        if cached_path(st, task.chat_id, msg_id).await.is_some() {
            // 已缓存：条目可能已入库，仍要进剧集（避免整组里缺这几集）。
            if let Ok(Some(id)) = st
                .store
                .item_id_by_ref("tg", &format!("{}:{}", task.chat_id, msg_id))
                .await
            {
                if !item_ids.contains(&id) {
                    item_ids.push(id);
                }
            }
            done += 1;
            let _ = st.store.update_cache_task_progress(task_id, done, None).await;
            st.refresh_cache_tasks().await;
            continue;
        }
        match cache_one(st, task.chat_id, msg_id, &dir).await {
            Ok((_, item_id)) => {
                if let Some(id) = item_id {
                    if !item_ids.contains(&id) {
                        item_ids.push(id);
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
                return;
            }
        }
    }
    let _ = st.store.finish_cache_task(task_id, "done", None).await;
    // 整组缓存 → 自动成剧（BUG-031）：一批条目按 message_ids 顺序编为第 1..N 集。
    // 幂等：同一组（按 chat+首条消息标记）复用同一剧集，重复缓存不会建第二部剧、
    // 也不会把同一条目编成两集（append_episodes 已跳过已收录条目）。
    if item_ids.len() >= 2 {
        // 幂等键优先用 TG 相册 group_id（与入队去重键 `g:{chat}:{group}` 同源）；
        // 退化时用首条消息号——此前一律用首条消息号，同一相册若成员构成变化
        // （翻页边界/夹带非媒体消息）会被判成两部剧。
        let key = match task.group_id {
            Some(g) => format!("tg:group:{}:{}", task.chat_id, g),
            None => {
                let first = task.message_ids.first().copied().unwrap_or(0);
                format!("tg:msgs:{}:{}", task.chat_id, first)
            }
        };
        // 剧集类型按入组条目实际构成推导（此前硬编码 video：纯图片相册也标成「视频」）。
        let kinds = st.store.kinds_of_items(&item_ids).await.unwrap_or_default();
        let has_video = kinds.contains("video");
        let has_photo = kinds.contains("photo");
        let kind = match (has_video, has_photo) {
            (true, false) => "series",
            (false, true) => "album",
            _ => "collection",
        };
        match st.store.find_series_by_source_key(&key).await {
            Ok(Some(sid)) => {
                match st.store.append_episodes(sid, 1, &item_ids).await {
                    Ok(n) => st.push_log(&format!(
                        "cache task {task_id}: appended {n} episode(s) to series {sid}"
                    )),
                    Err(e) => st.push_log(&format!("cache task {task_id}: append episodes: {e}")),
                }
            }
            Ok(None) => {
                // 标题带日期：同一频道多组缓存不会得到一堆同名剧集，用户可分。
                let base = channel_title(st, task.chat_id)
                    .await
                    .unwrap_or_else(|| format!("TG {}", task.chat_id));
                let title = format!("{base} · {}", ymd_str(task.created_at as u64));
                match st
                    .store
                    .create_series(&title, None, kind, None, Some(&key))
                    .await
                {
                    Ok(sid) => match st.store.append_episodes(sid, 1, &item_ids).await {
                        Ok(n) => st.push_log(&format!(
                            "cache task {task_id}: series {sid} ({kind}) with {n} episode(s)"
                        )),
                        Err(e) => st.push_log(&format!("cache task {task_id}: append episodes: {e}")),
                    },
                    Err(e) => st.push_log(&format!("cache task {task_id}: create series: {e}")),
                }
            }
            Err(e) => st.push_log(&format!("cache task {task_id}: find series: {e}")),
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
/// （删除落盘文件副本 + 复位 downloaded/file_path；库内消息记录保留，可重新缓存）。
async fn clear_stored(
    State(st): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, ApiError> {
    let removed = st
        .store
        .clear_downloaded(channel_id, message_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // 双向联动（缓存即入库的对称面）：缓存副本没了 → 媒体库条目一并移除，
    // 避免留下 file_path 指向已删文件的死条目（重新缓存会再次入库）。
    if removed {
        let _ = st
            .store
            .delete_media_item_by_ref("tg", &format!("{channel_id}:{message_id}"))
            .await;
    }
    st.push_log(&format!("/api/tg/stored/{channel_id}/{message_id} cleared={removed}"));
    Ok(Json(json!({"ok": true, "removed": removed})))
}

/// GET /api/tg/downloaded/:chat_id — 该频道已缓存清单：messageId → 落盘路径。
/// 供前端 feed/缓存库合并统一缓存状态（DB 为唯一真相源，刷新后状态不丢）。
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
    for (id, path) in rows {
        map.insert(id.to_string(), serde_json::Value::String(path));
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

pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: &str) -> Self {
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
    classify_ext, scan_dir, ItemPatch, ItemQuery, SeriesPatch,
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
            (
                r.clone(),
                None,
                it.title.clone().unwrap_or(r),
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
        let id = st
            .store
            .upsert_media_item(&source, &ref_key, &title, &kind, path.as_deref(), size, it.duration)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        ids.push(id);
    }
    st.push_log(&format!("/api/media/items imported {} item(s)", ids.len()));
    Ok(Json(json!({"ids": ids, "count": ids.len()})))
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

/// `DELETE /api/media/items/:id` — 从资料库移除（**不删磁盘原文件**）。
async fn delete_media_item(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    // 双向联动（TG 来源条目）：删媒体库条目 → 同步清 TG 缓存副本。
    // 否则下次缓存 upsert（按 source+ref 幂等）会把条目"复活"，看起来像删不掉。
    if let Ok(Some(item)) = st.store.get_media_item(id).await {
        if item.source == "tg" {
            if let Some((chat, msg)) = parse_tg_ref(&item.ref_key) {
                let _ = st.store.clear_downloaded(chat, msg).await;
            }
        }
    }
    st.store
        .delete_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

/// 解析 TG 引用 `"<chat_id>:<message_id>"`（缓存即入库的 ref 约定）。
fn parse_tg_ref(r: &str) -> Option<(i64, i64)> {
    let (a, b) = r.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

/// `PUT /api/media/items/:id/tags` — 全量重设标签集合。
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
    let p = item
        .file_path
        .clone()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "item has no local file"))?;
    // 与 TG 已缓存投递共用同一实现（serve_local_file）：Range / ETag / MIME 一处定义。
    serve_local_file(&p, Some(item.kind.as_str()), item.duration, &headers).await
}

/// 投递背压：允许的播放倍率余量（目标速率 = 码率 × 本系数）。
const DELIVERY_BUDGET_FACTOR: f64 = 6.0;
/// `duration` 未知时的兜底速率上限（字节/秒）。
const DELIVERY_FALLBACK_BPS: f64 = 16.0 * 1024.0 * 1024.0;

/// 目标投递速率（字节/秒）。返回 `0.0` 表示不限速。
///
/// **为什么必须限速（BUG-033 实测，勿仅凭直觉删除）**：
/// 本地千兆下服务端能以数百 MB/s 把字节灌给解码器，而解码器 1x 只消费「码率」、
/// 2x 消费 2×码率。Chromium 读够当前 buffer 即 abort 连接、另起请求重取同一区域，
/// 表现为「同一块数据请求无数遍」：实测 2x 播放 10s 内 **137 个请求 / 792 MiB
/// （冗余 63x，白传 70%+）**，在 WebView2 里就是界面卡死。
///
/// 该行为**与投递端实现无关**，已用对照实验逐项排除：
///   - 标准 Python Range 实现（同一文件、同一播法）同样复现 130 请求 / 51x 冗余
///   - 块大小 1 / 4 / 8 / 32 MiB / EOF 五档：请求数 123–137，全在同一量级
///   - 前端 `preload` = auto / metadata / none 三档：73 / 69 / 65，无杠杆
///   - 浏览器缓存开 / 关：137 / 136，无杠杆
/// 唯一有效的杠杆是**发送速率**：限到 6 MiB/s 后传输量 290 MiB → 19.6 MiB、
/// 冗余 29x → **1.97x**。
///
/// 可用 `ORIG_TG_DELIVERY_BPS` 覆盖（0 = 关闭限速，便于 A/B，无需重编）。
fn delivery_bps(total: u64, duration_secs: Option<i64>) -> f64 {
    if let Ok(v) = std::env::var("ORIG_TG_DELIVERY_BPS") {
        return v.trim().parse::<f64>().unwrap_or(0.0);
    }
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
                    // 客户端断开时整个 stream 被 drop，这里的 sleep 随之中断，不会泄漏。
                    let due = sent_next as f64 / bps;
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
async fn list_media_series(
    State(st): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let list = st
        .store
        .list_series()
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
async fn delete_media_series(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .delete_series(id)
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
#[derive(Deserialize)]
struct EpisodeReq {
    #[serde(rename = "itemId")]
    item_id: i64,
    season: Option<i64>,
    #[serde(rename = "episodeNo")]
    episode_no: Option<i64>,
    title: Option<String>,
}

/// `POST /api/media/series/:id/episodes`
async fn add_media_episode(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeReq>,
) -> Result<impl IntoResponse, ApiError> {
    let eid = st
        .store
        .add_episode(
            id,
            body.item_id,
            body.season.unwrap_or(1),
            body.episode_no.unwrap_or(1),
            body.title.as_deref(),
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
    let n = st
        .store
        .append_episodes(id, body.season.unwrap_or(1), &body.item_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"added": n})))
}

#[derive(Deserialize)]
struct EpisodePatchReq {
    title: Option<String>,
    description: Option<String>,
}

/// `PATCH /api/media/episodes/:id` — 改单集标题。
async fn patch_media_episode(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodePatchReq>,
) -> Result<impl IntoResponse, ApiError> {
    let ok = st
        .store
        .update_episode(id, body.title.as_deref(), body.description.as_deref())
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "episode not found"));
    }
    Ok(Json(json!({"ok": true})))
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