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

use crate::login::{Client, ClientError, LoginPhase, MediaRange};
use crate::monitor;
use crate::state::AppState;
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
    Json(view)
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

/// GET /api/tg/diag — 运行诊断快照（端口/客户端真实度/代理/会话阶段/是否有 API 凭证）。
async fn diag(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let view = st.client.view().await;
    Json(json!({
        "health": "ok",
        "port": st.config.port,
        "api_mode": st.api_mode,
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
        LoginPhase::Anonymous | LoginPhase::Authorized => LoginPhase::Authorized,
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
    ensure_authorized(&*st.client).await?;
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
    ensure_authorized(&*st.client).await?;
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
    ensure_authorized(&*st.client).await?;
    st.store
        .clear_dialog_cache()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.push_log("/api/tg/cache/clear");
    Ok(Json(json!({"ok": true})))
}

async fn folders(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&*st.client).await?;
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
    ensure_authorized(&*st.client).await?;
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
    ensure_authorized(&*st.client).await?;
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
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    const CHUNK: usize = 512 * 1024;
    let db_err = |e: libsql::Error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());

    let Some(msg) = st.store.get_message(chat_id, message_id).await.map_err(db_err)? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "message not stored"));
    };
    let Some(path) = msg.file_path.clone() else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "file not cached"));
    };
    let total = match tokio::fs::metadata(&path).await {
        Ok(m) => m.len(),
        Err(_) => return Err(ApiError::new(StatusCode::NOT_FOUND, "cached file missing")),
    };
    let range = parse_range(headers.get(header::RANGE))?;

    // 规约 [start, end]（闭区间），逻辑与在线流 media() 一致。
    let (start, end) = match range {
        None => (0u64, total.saturating_sub(1)),
        Some(r) => {
            let (s, e_opt) = match r {
                MediaRange::Open(s) => (s, None),
                MediaRange::Closed(s, e) => (s, Some(e)),
                MediaRange::Tail(n) => {
                    if n >= total {
                        (0, Some(total.saturating_sub(1)))
                    } else {
                        (total - n, Some(total - 1))
                    }
                }
            };
            let e = e_opt.unwrap_or(total - 1).min(total - 1);
            if s >= total || s > e {
                let mut res = axum::response::Response::new(axum::body::Body::empty());
                if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total}")) {
                    res.headers_mut().insert(header::CONTENT_RANGE, v);
                }
                *res.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
                return Ok(res);
            }
            (s, e)
        }
    };

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let take = end - start + 1;
    // 按块读本地文件产出字节流（futures::unfold，不整段进内存）。
    let body = futures::stream::unfold(
        (file, take),
        |(mut f, mut remain)| async move {
            if remain == 0 {
                return None;
            }
            let want = remain.min(CHUNK as u64) as usize;
            let mut buf = vec![0u8; want];
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    remain -= n as u64;
                    Some((Ok(buf), (f, remain)))
                }
                Err(e) => Some((Err(e), (f, 0))),
            }
        },
    );

    let ct = msg
        .mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".into());
    let mut res = axum::response::Response::new(axum::body::Body::from_stream(body));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&ct)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    res.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if range.is_some() {
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
            res.headers_mut().insert(header::CONTENT_RANGE, v);
        }
        *res.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    if let Ok(v) = HeaderValue::from_str(&take.to_string()) {
        res.headers_mut().insert(header::CONTENT_LENGTH, v);
    }
    Ok(res)
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
    ensure_authorized(&*st.client).await?;
    // 目录优先级：请求显式 dir > DB 设置（前端可改） > env/默认配置。
    let db_dir = st
        .store
        .get_setting("download_dir")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty());
    let dir = req
        .dir
        .filter(|s| !s.is_empty())
        .or(db_dir)
        .unwrap_or_else(|| st.config.download_dir.to_string_lossy().into_owned());
    let outcome = st.client.download(chat_id, message_id, &dir).await?;
    // 缓存状态入库（BUG-016 根因：此前从未标记，列表永远显示未缓存）。
    // 元数据回填（D1 根因）：mark_downloaded 的兜底 upsert 只写 downloaded/file_path，
    // 未监控频道的行缺 type/mime/size/date/duration/group_id → 缓存库显 📄、聚合失效。
    // 先取 TG 消息元数据 upsert（保留 file_path/downloaded/created_at），再标记已下载；
    // 元数据取不到（消息被删/peer 解析失败）时退化为仅标记。入库失败不影响下载结果返回。
    if let Ok(Some(meta)) = st.client.message_meta(chat_id, message_id).await {
        let _ = st
            .store
            .upsert_message(
                chat_id,
                message_id,
                meta.caption.as_deref(),
                meta.mime_type.as_deref(),
                meta.size,
                meta.media_type.as_deref(),
                meta.date,
                meta.duration,
                meta.group_id,
            )
            .await;
    }
    let _ = st
        .store
        .mark_downloaded(chat_id, message_id, Some(&outcome.path))
        .await;
    Ok(Json(outcome))
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
async fn ensure_authorized(c: &dyn Client) -> Result<(), ApiError> {
    let view = c.view().await;
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
}

impl From<ClientError> for ApiError {
    fn from(e: ClientError) -> Self {
        let (status, msg) = match &e {
            ClientError::NotInitialized => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()),
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