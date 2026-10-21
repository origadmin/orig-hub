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
use crate::ffmpeg_caps::{describe, probe_config, probe_ffmpeg, probe_gpus, FfmpegConfig};
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
        // BUG-279：按条目（chat:msg）查其缓存任务态，媒体库未缓存条目展示用。
        // 必须放在 `:id` 之前（静态段优先于动态段）。
        .route(
            "/api/tg/cache/tasks/by-item",
            get(cache_task_by_item),
        )
        .route(
            "/api/tg/cache/tasks/:id",
            get(cache_task_by_id).delete(cancel_cache_task_route),
        )
        // D22-A②（BUG-296）：任务级组清单 —— 序号全集 + 每条状态（已编入/已登记未编入/无条目）
        // + 真缺口。**派生读**，不新建业务表、不写库。
        .route(
            "/api/tg/cache/tasks/:id/items",
            get(cache_task_items),
        )
        // BUG-277：队列优先级（置顶 / 取消置顶）。单条走 `:id`，**批量走同一个动词
        // 的静态段**（body `{ids:[…]}`）——多选置顶必须一个请求完成，
        // 禁止前端循环调单条（BUG-249 先例）。实现在 `cache::`。
        .route(
            "/api/tg/cache/tasks/:id/priority",
            axum::routing::post(crate::cache::set_task_priority),
        )
        .route(
            "/api/tg/cache/tasks/priority",
            axum::routing::post(crate::cache::set_tasks_priority),
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
        // 「点开频道」= 已读游标推到最新（未读计数归零）。
        .route(
            "/api/tg/monitor/channels/:id/read",
            axum::routing::post(mark_monitor_channel_read),
        )
        // 文字筛选规则（每条 = 一条虚拟监控，用户 2026-10-19 裁定）。
        .route(
            "/api/tg/monitor/filters",
            get(list_monitor_filters).post(add_monitor_filter),
        )
        .route(
            "/api/tg/monitor/filters/:id",
            axum::routing::delete(remove_monitor_filter),
        )
        .route(
            "/api/tg/monitor/filters/:id/read",
            axum::routing::post(mark_monitor_filter_read),
        )
        .route(
            "/api/tg/monitor/filters/:id/messages",
            get(monitor_filter_messages),
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
        // ---- 受管根（管理多根，BUG-323 续 / 用户 2026-10-16）----
        // 下载模块单根（download_dir）不变；以下端点服务于「管理」模块的受管根之并集。
        .route(
            "/api/fs/roots",
            get(list_managed_roots)
                .post(add_managed_root)
                .delete(remove_managed_root),
        )
        .route("/api/fs/roots/primary", axum::routing::post(set_primary_managed_root))
        .route("/api/fs/list", get(list_fs_dir))
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
        // 网格/封面用的**真缩略图**（`?w=`）：原图当缩略图是媒体库卡顿的根因。
        .route("/api/media/items/:id/thumb", get(media_item_thumb))
        // BUG-208：浏览器无硬件 HEVC 时的兼容流（按需实时转码 H.264 + 代理缓存）。
        .route("/api/media/items/:id/stream", get(media_item_stream))
        .route("/api/media/items/by-ref", get(media_item_by_ref))
        .route("/api/media/items/by-refs", get(media_item_by_refs))
        .route("/api/media/export/preview", get(export_preview))
        .route("/api/media/export", axum::routing::post(export_media))
        // D24-A（BUG-311）：批量整理（mp3tag 式）—— 预览全表 diff 与执行分两端点。
        // 「一动词一端点」：preview 只读、可随意重复调用；apply 才落盘。
        .route(
            "/api/media/organize/preview",
            axum::routing::post(organize_preview),
        )
        .route(
            "/api/media/organize/apply",
            axum::routing::post(organize_apply),
        )
        .route("/api/media/organize/presets", get(organize_presets))
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
        // BUG-261：剧集级「补缺」——一次请求把这部剧所有无字节分集的可缓存来源
        // 入队（本仓规约：批量操作禁止前端循环调单条；判据 2 要求 10 集缺 ⇒ 1 个请求）。
        .route(
            "/api/media/series/:id/recache-missing",
            axum::routing::post(recache_series_missing),
        )
        // D22-A②（BUG-296）：剧集级组清单 —— 序号全集 + 每条状态 + 真缺口（先减挂图）。
        // 剧集详情的「缺集灰条」与「已登记未编入」列表都由它派生。
        .route(
            "/api/media/series/:id/manifest",
            get(get_series_manifest),
        )
        // D22-A⑥：人工**拆剧** —— 把同一部剧里被误并进来的条目移到新剧集。
        // 组键统一后「同频道同名幂等同一部」，误并的出口只有这一个（不做自动冲突弹窗）。
        .route(
            "/api/media/series/:id/split",
            axum::routing::post(split_media_series),
        )
        // D22-A②（BUG-296）：**按组清单真缺口**补缓存 —— 收「连条目都没有 / 已登记未编入」
        // 的序号（挂图除外）。与 recache-missing（只收已存在但无字节的分集）互补。
        .route(
            "/api/media/series/:id/recache-gap",
            axum::routing::post(recache_series_gap),
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

/// `Cache-Control` for a full-size photo proxied on demand from Telegram (BUG-117)。
///
/// `private`（不是 `public`）：这些是**登录用户自己的**媒体，共享缓存不得留存。
/// 值与缩略图端点（`thumb`）一致，但语义不同 —— 缩略图是海报，本条是「查看原图」。
const PHOTO_PROXY_CACHE_CONTROL: &str = "private, max-age=86400";

/// 由传输域的 [`MediaStream`] 构造 HTTP 响应。
///
/// 在线流（`GET /api/tg/file/...`）与 BUG-117 的全尺寸原图代理**共用此实现**，
/// 使 Range / 206 / `Content-Range` 契约只定义一次。`range` 必须是**同一个**
/// 传给 `Client::media` 的值：206 分支据此决定是否回 `Content-Range`。
fn media_stream_response(
    stream: crate::login::MediaStream,
    range: Option<MediaRange>,
    cache_control: &'static str,
) -> Response {
    let mut res = Response::new(axum::body::Body::from_stream(stream.body));
    let ct = HeaderValue::from_str(&stream.content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    res.headers_mut().insert(header::CONTENT_TYPE, ct);
    res.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control));

    match range {
        // 206 Partial Content：带 Content-Range + Content-Length。
        Some(_) => {
            let total_str = stream
                .total_size
                .map_or_else(|| "*".to_string(), |t| t.to_string());
            let cr = format!("bytes {}-{}/{}", stream.start, stream.end, total_str);
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
    res
}

/// 416 Range Not Satisfiable：`Content-Range: bytes */total`（total 未知时 `*`）。
fn media_range_not_satisfiable(total: Option<u64>, cache_control: &'static str) -> Response {
    let total_str = total.map_or_else(|| "*".to_string(), |t| t.to_string());
    let mut res = Response::new(axum::body::Body::empty());
    if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total_str}")) {
        res.headers_mut().insert(header::CONTENT_RANGE, v);
    }
    res.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control));
    *res.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
    res
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
        Ok(stream) => Ok(media_stream_response(stream, range, "no-store")),
        // 区间不可满足 → 416，Content-Range: bytes */total。
        Err(ClientError::UnsatisfiableRange(total)) => {
            Ok(media_range_not_satisfiable(total, "no-store"))
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

/// 仅取 `Range` 头的起始字节偏移（B 路径用：判断 `.part` 已落盘足够字节即可 206 服务）。
/// 解析失败/非 `bytes=` 单位/尾部计数（`bytes=-N`）一律返回 None（交由直播流处理）。
fn range_start_only(rstr: &str) -> Option<u64> {
    let text = rstr.trim();
    if !text.starts_with("bytes=") {
        return None;
    }
    let spec = text["bytes=".len()..].trim();
    let (start_s, _) = spec.split_once('-')?;
    let start_s = start_s.trim();
    if start_s.is_empty() {
        return None; // bytes=-N（末尾计数）不在本辅助范围内
    }
    start_s.parse::<u64>().ok()
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
    // BUG-323：解析后必须落在**下载路径**之内 —— 下载路径是所有权限的限制路径，
    // 存量里按旧库根写死的绝对路径正落在这道闸门外，一律 403（不静默服务）。
    let lib_root = st.store.library_root().await;
    let download_root = st.store.download_root().await;
    let path = crate::cache::resolve_managed_path(&download_root, &lib_root, &path)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "cached file path is outside the managed download root (BUG-323)",
            )
        })?
        .to_string_lossy()
        .into_owned();
    if !std::path::Path::new(&path).exists() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cached file missing"));
    }
    serve_local_file(&path, msg.media_type.as_deref(), msg.duration, &headers).await
}

/// 下载目录当前生效值（= 受管根 / 权限边界，BUG-323）。
///
/// 与 [`crate::store::Store::download_root`] **同源**：env `ORIG_TG_DOWNLOAD_DIR`
/// > app_setting `download_dir` > 平台默认下载目录（`~` 展开在那一侧统一做，
/// BUG-071）。此处不再自己拼第三条链 —— 下载路径是全部文件的唯一容器，
/// 只允许一处解析（此前它读 `st.config.download_dir`，与 store 侧各算一套）。
async fn effective_download_dir(st: &AppState) -> String {
    st.store
        .download_root()
        .await
        .to_string_lossy()
        .into_owned()
}

#[derive(Deserialize)]
struct ConfigUpdateReq {
    #[serde(rename = "downloadDir", default)]
    download_dir: Option<String>,
    /// **已废（BUG-323）**：库根不再是独立配置项，收到即 422（见 [`put_config`]）。
    /// 保留该字段只为把「旧调用方仍在写库根」变成一条**明确错误**，
    /// 而不是收下后静默无效（静默无效正是「改了像没改」的来源）。
    #[serde(rename = "libraryDir", default)]
    library_dir: Option<String>,
}

/// GET /api/tg/config — 运行时配置快照（下载路径、派生的库根）。
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
/// **BUG-323（用户 2026-10-16 裁定）**：库根跟随下载路径（= `<downloadDir>/library`），
/// 故 `libraryDir` **不可单独设置** —— 收到一律 422 并直出正确做法（改 `downloadDir`）。
/// 让「库根脱离下载路径」在接口层不可表达，而不是接受后悄悄忽略。
async fn put_config(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ConfigUpdateReq>,
) -> Result<impl IntoResponse, ApiError> {
    if req.library_dir.is_some() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "libraryDir is derived from the download directory (<downloadDir>/library) \
             and cannot be set independently; set downloadDir instead (BUG-323)",
        ));
    }
    let Some(raw_dir) = &req.download_dir else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "nothing to update: provide downloadDir",
        ));
    };
    let dir = raw_dir.trim().to_string();
    if dir.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "downloadDir is empty",
        ));
    }
    // Expand a user-typed leading `~` *before* creating the directory and
    // persisting it, otherwise Windows would materialise `<CWD>/~/...` (BUG-071).
    // BUG-323 复报（2026-10-19）：再收敛分隔符字面（`D:\\x`/`D:/x`/`D://x` → 同一形态）
    // —— 活栈实测 `D://OrigDown` 能一直存进配置，全靠两侧都没有归一化。
    let dir = orig_core::paths::normalize_dir(
        &orig_core::paths::expand_tilde(&dir).to_string_lossy(),
    );
    // 预创建校验：目录不可创建（权限/非法字符）时拒绝保存。
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, &format!("create dir: {e}")))?;
    st.store
        .set_setting("download_dir", &dir)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // BUG-323 复报（2026-10-19）：下载根变更 ⇒ 存量迁移（旧根字节搬进新根 + DB
    // 绝对路径改写），否则「改了路径、库里文件整片失联」= 用户口中的「选择完全无效」。
    // 失败**不阻断保存**（daemon 侧已落库，回滚会让用户看到「保存失败」却查不出
    // 所以然），但必须留痕：回执/原因进响应，原因进日志；下次启动自动重试。
    let (migration, migration_error) = match st.store.migrate_root_change().await {
        Ok(m) => (m, None),
        Err(e) => {
            tracing::warn!(target: "orig_tg::store", "root change migration failed: {e}");
            (None, Some(e))
        }
    };
    // 库根随之派生（无需另写一步，这正是「跟下载走」的意义）。
    let library_root = st.store.library_root().await;
    Ok(Json(json!({
        "downloadDir": dir,
        "libraryDir": library_root.to_string_lossy(),
        "migration": migration,
        "migration_error": migration_error,
    })))
}

/// GET /api/fs/roots — 受管根集合（管理多根）。下载根恒为 `locked` + 默认 `primary`。
async fn list_managed_roots(
    State(st): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let roots = st.store.managed_roots().await;
    Ok(Json(json!({ "roots": roots })))
}

#[derive(Deserialize)]
struct ManagedRootReq {
    path: String,
}

/// POST /api/fs/roots — 新增受管根（去重；下载根除外）。
async fn add_managed_root(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ManagedRootReq>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .add_managed_root(std::path::Path::new(&req.path))
        .await
        .map_err(|e| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, &e))?;
    let roots = st.store.managed_roots().await;
    Ok(Json(json!({ "roots": roots })))
}

/// DELETE /api/fs/roots — 删除受管根（locked/下载根 不可删）。
async fn remove_managed_root(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ManagedRootReq>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .remove_managed_root(std::path::Path::new(&req.path))
        .await
        .map_err(|e| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, &e))?;
    let roots = st.store.managed_roots().await;
    Ok(Json(json!({ "roots": roots })))
}

/// POST /api/fs/roots/primary — 切换主根（只改管理视图默认选中，不动下载落点）。
async fn set_primary_managed_root(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ManagedRootReq>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .set_primary_root(std::path::Path::new(&req.path))
        .await
        .map_err(|e| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, &e))?;
    let roots = st.store.managed_roots().await;
    Ok(Json(json!({ "roots": roots })))
}

#[derive(Deserialize)]
struct FsListQuery {
    path: String,
}

/// GET /api/fs/list?path=<absolute dir> — 在任一受管根内列目录（并集闸门）。
async fn list_fs_dir(
    State(st): State<Arc<AppState>>,
    Query(q): Query<FsListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let roots = st.store.managed_roots().await;
    let root_paths: Vec<PathBuf> = roots.iter().map(|r| PathBuf::from(&r.path)).collect();
    let Some(abs) = crate::cache::resolve_managed_path_union(&root_paths, &q.path) else {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "path is outside any managed root",
        ));
    };
    if !abs.is_dir() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not a directory"));
    }
    let mut entries = Vec::new();
    let mut rd = tokio::fs::read_dir(&abs)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    while let Some(e) = rd
        .next_entry()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    {
        let ft = e
            .file_type()
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        let meta = e.metadata().await.ok();
        entries.push(json!({
            "name": e.file_name().to_string_lossy(),
            "isDir": ft.is_dir(),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "modified": meta
                .and_then(|m| m.modified().ok())
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)),
        }));
    }
    Ok(Json(json!({ "path": abs.to_string_lossy(), "entries": entries })))
}

async fn download(
    State(st): State<Arc<AppState>>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
    Json(req): Json<DownloadReq>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    let dir = resolve_cache_dir(&st, req.dir).await?;
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

/// 解析落盘目录（BUG-323：**下载路径是唯一容器与权限边界**）。
///
/// 基准 = [`crate::store::Store::download_root`]（env > app_setting > 平台默认）。
/// 此前这里是**第三条链**（`req.dir` > app_setting > `Config.download_dir`）：
/// 同一个「下载路径」有多个真源，且 `req.dir` 可指向任意位置 ⇒ 字节能落到下载路径之外。
///
/// 请求级 `dir` 现在只是**下载路径之内**的子目录选择（绝对按原义、相对按下载根
/// join）；越界一律 **403** —— 界外不允许出现任何引擎写的字节。
async fn resolve_cache_dir(st: &AppState, req_dir: Option<String>) -> Result<String, ApiError> {
    let root = st.store.download_root().await;
    let Some(raw) = req_dir.filter(|s| !s.trim().is_empty()) else {
        return Ok(root.to_string_lossy().into_owned());
    };
    let raw = orig_core::paths::expand_tilde(raw.trim());
    let p = if raw.is_absolute() { raw } else { root.join(raw) };
    if !crate::cache::path_within(&root, &p) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            &format!(
                "dir escapes the download directory ({}): pick a path inside it (BUG-323)",
                root.display()
            ),
        ));
    }
    Ok(crate::cache::lexical_normalize(&p).to_string_lossy().into_owned())
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
/// 单条目下载限额的运行时解析（BUG-271，照 `resolve_cache_dir` 先例）。
///
/// 链：DB `app_setting` > config(env) > 类型默认。**「请求」档不适用**：
/// 限额在缓存 worker 内解析，没有 HTTP 请求上下文（`resolve_cache_dir` 的请求档
/// 来自入队请求的 `dir` 参数，这里没有对应入参）——这是一处如实登记的口径收窄。
///
/// 两个键都按秒解析，墙钟允许小数（测试夹具用亚秒档，生产为整档）。
/// 解析失败回退 config，绝不 panic；钳位防止 0/负值把看门狗变相关掉：
/// 墙钟 ∈ [0.1s, 24h]，空闲 ∈ [5s, 24h]（空闲 <5s 等于「治死」档失效）。
async fn download_limits(st: &AppState) -> crate::login::DownloadLimits {
    const MAX_SECS: f64 = 24.0 * 3600.0;
    let wall = setting_secs(st, "download_item_max_secs", st.config.download_item_max_secs as f64)
        .await
        .clamp(0.1, MAX_SECS);
    let idle = setting_secs(st, "download_idle_max_secs", st.config.download_idle_secs as f64)
        .await
        .clamp(5.0, MAX_SECS);
    crate::login::DownloadLimits {
        idle: std::time::Duration::from_secs_f64(idle),
        wall: std::time::Duration::from_secs_f64(wall),
    }
}

/// `app_setting` 里的秒数（允许小数）；缺键/空/解析失败一律回退 `fallback`。
async fn setting_secs(st: &AppState, key: &str, fallback: f64) -> f64 {
    match st.store.get_setting(key).await {
        Ok(Some(v)) if !v.trim().is_empty() => v.trim().parse::<f64>().unwrap_or(fallback),
        _ => fallback,
    }
}

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
    // BUG-271：墙钟（治「慢」）围绕**整个条目**下载计时——与 grammers 流循环内的
    // 空闲看门狗（治「死」，chunk 间判定）并存不合并。「每 89s 来一小块」的流
    // 空闲永不触发，这里必触发。超墙钟走 [`Client::download_limited`] 携带的同一
    // 限额结构，墙钟计时放在路由层：限额从 app_setting 运行时解析（见上），
    // 且超时取消与 BUG-257 的取消语义同构——future 被 drop，`.part` 随之清理。
    //
    // BUG-276：传给 `timeout` 的必须是**剩余额度**，不是每次尝试都重新拿满的一整档。
    // `started`（`Instant`）只能量到「这一次尝试」，而它是**进程本地**时钟 ⇒ 进程一退，
    // 已烧掉的时间随之蒸发；`main.rs` 的重启恢复又把任务重新入队、重新起一次尝试
    // ⇒ 旧实现下**每重启一次就白送一整个 `wall` 窗口**（实测 3.6h 内重启 16 次
    // ⇒ 30min 死线从未到期，同一条目占住队首 21h）。
    // 现在已烧掉的墙钟从库里读（`cache_task_item_wall`），**跨进程存活、重启不清零**。
    let limits = download_limits(st).await;
    // 单条下载端点（`task_id = None`）没有任务载体 ⇒ 退回「每次尝试一整档」的原语义。
    let burned = match task_id {
        None => std::time::Duration::ZERO,
        Some(id) => {
            let ms = st.store.item_wall_elapsed_ms(id, message_id).await.unwrap_or(0);
            std::time::Duration::from_millis(ms.max(0) as u64)
        }
    };
    if burned >= limits.wall {
        if task_id.is_some() {
            st.cache_dl_end();
        }
        // 累计已经超 ⇒ 连新尝试都不开：再开一次只是再烧一遍（缺陷原形的形态）。
        // 原因串与「no bytes for 90s」逐字可区分（BUG-271 判据 4 同款纪律）。
        let reason = format!(
            "download too slow: {:.1}s spent across attempts for chat {chat_id} msg {message_id}; \
             cumulative wall-clock limit {}s exceeded, aborted to keep the cache queue moving",
            burned.as_secs_f64(),
            limits.wall.as_secs()
        );
        st.push_log(&format!(
            "cache_one({chat_id},{message_id}): too slow -> {reason}"
        ));
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, &reason));
    }
    let remaining = limits.wall - burned;
    // 落「本次尝试起点」（幂等：已有在途起点就不覆盖）——崩在途中的那一次正是靠它继续计数。
    if let Some(id) = task_id {
        let _ = st.store.begin_item_wall_attempt(id, message_id).await;
    }
    let started = std::time::Instant::now();
    let download = st.client.download_limited(
        chat_id,
        message_id,
        dir,
        Some(&st.cache_dl),
        &limits,
    );
    let outcome = match tokio::time::timeout(remaining, download).await {
        Ok(Ok(o)) => Ok(o),
        Ok(Err(e)) => {
            let reason = e.to_string();
            let hint = if st.client.link_alive() {
                "download failed"
            } else {
                "MTProto link is down; restart orig-tg to recover"
            };
            Err((
                format!("cache_one({chat_id},{message_id}): failed -> {reason} ({hint})"),
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &format!("{hint}: {reason}"),
                ),
            ))
        }
        Err(_elapsed) => {
            // 超墙钟：**原因串必须与「no bytes for 90s」逐字可区分**（BUG-271 判据 4）。
            // 刻意避开分类链路里网络类的全部签名词（connect/network/timeout/dropped/
            // stalled），否则会被 `tg.reasonNetwork` 吃掉——BUG-257 点 3 同款坑。
            // 该条目由调用方（`run_one_cache_task` 的失败隔离）记入汇总并继续跑
            // 剩余条目，不弃单。
            //
            // BUG-276：报数带上**之前尝试已烧掉的**部分——用户看到的应该是
            // 「这条一共耗了多久」，而不是「最后一次尝试耗了多久」。
            let reason = format!(
                "download too slow: {:.1}s for chat {chat_id} msg {message_id}; \
                 wall-clock limit {}s exceeded, aborted to keep the cache queue moving",
                (burned + started.elapsed()).as_secs_f64(),
                limits.wall.as_secs()
            );
            Err((
                format!("cache_one({chat_id},{message_id}): too slow -> {reason}"),
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, &reason),
            ))
        }
    };
    // 成败两路都要把这次尝试烧掉的墙钟并进累计：被掐断与报错同样真的耗了时间。
    if task_id.is_some() {
        st.cache_dl_end();
    }
    if let Some(id) = task_id {
        let _ = st.store.end_item_wall_attempt(id, message_id).await;
    }
    let outcome = match outcome {
        Ok(o) => o,
        Err((line, err)) => {
            st.push_log(&line);
            return Err(err);
        }
    };
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

                m.file_name.as_deref(),
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
    //
    // BUG-342：条目标题与下载面板行标题**同源同规则**过 `clean_title` 白名单
    // （emoji/书括号/URL 不上库卡片）；空串纪律不变——清后为空 = 没有标题。
    let title = caption_title.as_deref().map(clean_title).unwrap_or_default();
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
    ///
    /// BUG-345：收 string 也收 number——串界修复后前端发字符串（group_id
    /// ~1.4e16 > JS 2^53，number 过界即丢精度），陈旧标签页发的 number 照收。
    #[serde(
        rename = "groupId",
        default,
        deserialize_with = "crate::store::deserialize_group_id_opt"
    )]
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
    let dir = resolve_cache_dir(&st, req.dir).await?;
    // BUG-308（D22-A②）：去重窗口从「活跃任务」扩到**历史认领**。
    //
    // 无活跃任务覆盖时先查该批消息是否已登记入库（`media_item` source+ref）：
    //   ① 全部已登记且字节在盘 ⇒ 整批已入库 ⇒ 拦下（零字节重下、零新 `cache_task` 行）；
    //   ② 全部已登记但部分字节已失 ⇒ **复用原入库记录**（复位重跑补字节，不新建索引行）；
    //   ③ 部分/全部未登记 ⇒ 走常规入队（worker 对已有条目幂等跳过，只补缺的）。
    //
    // 旧实现只在 `enqueue_cache_task` 内部查**活跃**任务（queued/running），任务终态后
    // 同一批消息可被再次入队 ⇒ 重复下载字节 + 第二条入库索引（用户口径：入库 = TG
    // 插件下载的索引，见 BUG-308）。
    let active = st
        .store
        .active_cache_task_covering(req.chat_id, &req.message_ids)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if active.is_none() {
        let claims = st
            .store
            .claimed_messages(req.chat_id, &req.message_ids)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        let all_claimed = !claims.is_empty() && claims.iter().all(|(_, exists, _)| *exists);
        if all_claimed {
            let bytes_all = claims.iter().all(|(_, _, has)| *has);
            if bytes_all {
                return Ok(Json(json!({
                    "alreadyIngested": true,
                    "chatId": req.chat_id,
                    "messageIds": req.message_ids,
                })));
            }
            // 只补**字节已失**的那几条所在的最近任务（不是「任意覆盖」），避免复位到
            // 一个不含缺字节条目的任务上白跑。
            let missing: Vec<i64> = claims
                .iter()
                .filter(|(_, _, has)| !*has)
                .map(|(m, _, _)| *m)
                .collect();
            if let Some(task) = st
                .store
                .requeue_task_covering(req.chat_id, &missing)
                .await
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
            {
                st.refresh_cache_tasks().await;
                spawn_cache_task(st.clone(), task.id);
                return Ok(Json(json!(task)));
            }
        }
    }
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
    // BUG-246：入队即登记消息元数据。任务标题的事实源是 `media_message` 表，而该行
    // 历史上只在 worker **启动任务时**由 `IngestCtx::prepare()` 补写；排队任务不启动
    // worker ⇒ 行整条缺失 ⇒ 标题恒 None ⇒ 前端退回裸频道名。这里后台补写、不阻塞
    // 入队响应：这里后台做、不阻塞返回：与 BUG-170 的裁定同向——事实登记是瞬间的，
    // 耗时的只有字节搬运。
    //
    // BUG-248：同一协程里一并登记**条目本身**（`media_item`）——这是 BUG-170
    // 「先入信息、再入字节」未兑现的另一半：此前条目只由 worker 顺带登记，排队期间
    // 这条内容在媒体库里**查不到**。登记同样失败不阻断入队。
    // 刻意**不另起一个 spawn**：三步串在同一个协程里（条目 → 元数据 → 补强，
    // 见 `register_enqueued_items`），避免两个后台任务同时抢 MTProto 连接。
    {
        let st_bg = st.clone();
        let chat_id = req.chat_id;
        let msg_ids = req.message_ids.clone();
        tokio::spawn(async move {
            register_enqueued_items(&st_bg, chat_id, &msg_ids).await;
        });
    }
    Ok(Json(json!(task)))
}

/// BUG-181：任务 JSON 注入条目内字节进度（仅 `running` 且字节归属当前任务时）。
///
/// `total == 0`（条目刚起步、总量未可知）不注入，前端按「无字节进度」渲染，
/// 避免 `0/0` 这类空洞分母出现。
/// 任务行标题（BUG-232 v2）：**入库内容的 caption**，数据源是消息同步时已落库的
/// `media_message`——不是媒体库条目（v1 的错误修法：按 by-ref 反查成品，只覆盖已入库的任务，
/// 且把服务端一次 SQL 变成客户端逐行补数据）。
/// 单任务端点的标题来源：按频道现查（**不在 5s 轮询路径上**，与
/// [`crate::state::AppState::cache_task_titles_snapshot`] 的批量快照是两条路）。
///
/// 返回值包一层 `Option` 只为与 `cache_task_title` 的入参类型对齐 —— 这条路是
/// 现查的，命中的行都真有标题，包 `Some`；没查到的频道不进表（键不存在）。
/// 它**不参与**增量合并，所以不需要 `None`（「解析过但无标题」）这个状态。
async fn cache_task_titles(
    st: &AppState,
    tasks: &[CacheTask],
) -> std::collections::HashMap<(i64, i64), Option<crate::store::MsgTitleSources>> {
    let mut chans: Vec<i64> = tasks.iter().map(|t| t.chat_id).collect();
    chans.sort_unstable();
    chans.dedup();
    st.store
        .message_captions_for_channels(&chans)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, Some(v)))
        .collect()
}

/// 取任务的标题（BUG-280 两遍选取 + BUG-342 清洗）：**先**扫全组找第一条有非空
/// caption 的消息；全组都无 caption 才退回 file_name（BUG-220 兜底，不得退回频道名）。
/// 两者皆无 ⇒ None（前端退回 `频道名 #<msg>` 链）。
///
/// 为什么不是 first-match：相册组的 caption 常只挂在**靠后**的一条消息上
/// （实测组 3373-3380：3373-3377 只有 file_name，3378 才是真 caption），
/// 而靠前消息的 file_name（`manifest.mp4`）会在 first-match 里抢在它前面 ——
/// 用户看到的就是「队列标题是个无意义的文件名」。caption 与 file_name 分两遍
/// 选取后，「有 caption」才真正优先于「有文件名」。
///
/// 返回 **owned** String：标题要过 `clean_title` 白名单（BUG-342）——下载面板
/// 行标题直接给用户看，emoji/书括号/URL 不得原样上榜。
fn cache_task_title(
    t: &CacheTask,
    titles: &std::collections::HashMap<(i64, i64), Option<crate::store::MsgTitleSources>>,
) -> Option<String> {
    // 第一遍：caption 优先（按 message_ids 序的第一条非空 caption）。
    // `Option<Option<..>>` 压平：外层 = 键在不在（解析过没有），内层 = 有没有标题来源。
    let caption = t
        .message_ids
        .iter()
        .filter_map(|m| titles.get(&(t.chat_id, *m)))
        .flatten()
        .find_map(|s| non_empty(&s.caption))
        .map(clean_title)
        .filter(|s| !s.is_empty());
    caption.or_else(|| {
        // 第二遍：全组无 caption（或清洗后为空）才回退 file_name（BUG-220：
        // 文件名就是内容名，回退到它才是「显示内容」而非退回裸频道名）。
        t.message_ids
            .iter()
            .filter_map(|m| titles.get(&(t.chat_id, *m)))
            .flatten()
            .find_map(|s| non_empty(&s.file_name))
            .map(clean_title)
            .filter(|s| !s.is_empty())
    })
}

/// 非空（trim 后）才认——空串等价于「没有这个来源」。
fn non_empty(s: &str) -> Option<&str> {
    (!s.trim().is_empty()).then_some(s)
}

/// 标题清洗（BUG-342，用户 2026-10-20 裁定「特殊符号、书括号这些异常字符，都应该过滤掉」）。
///
/// 活库实证的污染形态（`media_message.caption` 首行抽样）：
/// ```text
/// 🌟🔥《飘飘欲仙 富二代征服校园母狗》EP7 原档无二次水印 连载中 ⭐⭐⭐
/// ❗️❗️❗️❗️《多啦B梦大冒险》 EP1-8
/// 📱 \u{a0} 《岳母交换计划》 第2集
/// ⚡️ 【阳光合租屋：暧昧同居】 新剧首更 ⚡️ #黄果短剧 #阳光合租屋 #AI短剧
/// 📱新剧首更 【王校长的淫乱契约】第1-5集 #ai短剧 #魔改短剧 #网红魔改
/// Ai商城https://t.me/Aishangchengbot
/// ```
///
/// 规则（确定性白名单，不逐 case 打补丁）：
///   ① URL 删除（`://` 处截断保留前缀词；`t.me/…` 直连词整词删）——促销/引流行
///      **不是标题的一部分**，只删符号会把 URL 剩成一串裸字母数字；
///   ② 字符白名单：字母数字（含 CJK / 西里尔）、`-.,!?'"&+()`、`，。！？、；：·`；
///      其余一律删——emoji、变体选择符、`《》【》「」『』`（用户点名的书括号）、
///      `…`、`*`、`_`、全角括号、NBSP 等装饰字符全在这一类；
///   ③ 空白折叠为单空格 + trim。
///
/// **`#标签` 的文字保留、只删 `#` 字符**：这批频道的 caption 用 hashtag 做剧名/
/// 演员标注（`#《快门沦陷》EP5` 的剧名就在 hashtag 里，BUG-152 的真实链同款），
/// 整词删会把标题本身删没；删字符后 `#《快门沦陷》` ⇒ `快门沦陷`。
///
/// **不清洗 `normalized_series_name` 的输出**：那是剧集**身份键**的一部分
/// （`episodic_group_key` = `tg:named:{chat}:{name}`），在里面清洗会让存量剧集
/// 键失配 ⇒ 同一部剧裂成两部。显示侧清洗只发生在不参与身份的标题落点
/// （本函数的两个调用方：下载面板行标题、媒体库条目标题）。
///
/// 清空 ≠ 报错：全符号标题清后为空 = 如实表达「没有标题」（BUG-154 纪律），
/// 由调用方的回退链（文件名 → 频道名）接手。
pub(crate) fn clean_title(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for tok in raw.split_whitespace() {
        // ① URL：从 scheme **起点**截断（保留 `Ai商城https://…` 里的 `Ai商城`）；
        //    `t.me/` 直连词（无 scheme）整词删。
        let cut = ["https://", "http://"]
            .iter()
            .filter_map(|s| tok.find(s))
            .min();
        let tok = match cut {
            Some(i) => &tok[..i],
            None => tok,
        };
        if tok.is_empty() || tok.contains("t.me/") {
            continue;
        }
        // ② 字符白名单过滤
        let mut kept = String::with_capacity(tok.len());
        for ch in tok.chars() {
            if ch.is_alphanumeric()
                || matches!(
                    ch,
                    '-' | '.' | ',' | '!' | '?' | '\'' | '"' | '&' | '+' | '(' | ')'
                )
                || matches!(ch, '，' | '。' | '！' | '？' | '、' | '；' | '：' | '·')
            {
                kept.push(ch);
            }
        }
        // ③ 拼回（空白已由 split_whitespace 归一）
        if !kept.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&kept);
        }
    }
    out
}

/// 标题自愈（BUG-220 + BUG-246 合流根因）：队列读到**无标题**任务 ⇒ 后台补登记其消息
/// 元数据，下一轮轮询即可拿到 caption。
///
/// 为什么需要：入队时的登记是一次性 `spawn`（`ensure_message_rows` 逐条 MTProto，可失败、
/// 可被连接抢占），**失败后无任何重试** ⇒ 该任务标题永久空 ⇒ 前端退回频道名（用户看到
/// 「又是频道名不是内容」）。这里在**读路径**上补一个自愈闸：读到空就补登记。
///
/// 自限性：`ensure_message_rows` 对**已有行**直接跳过，所以
/// ① 真正缺行（登记失败）会被补上、之后不再重复打 MTProto；
/// ② 消息**本身无 caption**（行存在但 caption 空）不会被反复重取——那类没有标题可造，
///    由前端回退链如实呈现，不属于本自愈能解决的。
static TITLE_SELFHEAL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// BUG-220：标题回填的**尝试次数上限**（按 (chat,msg) 计）。
///
/// 判据改成「有行但无标题」后，真正既无 caption 也无 file_name 的消息每轮都会被
/// 重取；面板在开着时 1s 轮询 ⇒ 不封顶就是持续 MTProto 压力。封顶 3 次后不再打扰：
/// 补到了就自然退出（`message_has_title` 命中），补不到就不再来。
static TITLE_BACKFILL_ATTEMPTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<(i64, i64), u8>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const MAX_TITLE_BACKFILL_ATTEMPTS: u8 = 3;

fn spawn_title_selfheal(
    st: &Arc<AppState>,
    tasks: &[CacheTask],
    titles: &std::collections::HashMap<(i64, i64), Option<crate::store::MsgTitleSources>>,
) {
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;
    // 无标题任务的消息，按 chat 分组。
    let mut by_chat: HashMap<i64, Vec<i64>> = HashMap::new();
    for t in tasks {
        if cache_task_title(t, titles).is_none() {
            by_chat
                .entry(t.chat_id)
                .or_default()
                .extend(t.message_ids.iter().copied());
        }
    }
    if by_chat.is_empty() {
        return;
    }
    // 同一时刻只跑一轮自愈（面板会轮询，避免每轮都拉起）。
    if TITLE_SELFHEAL.swap(true, Ordering::SeqCst) {
        return;
    }
    let st2 = st.clone();
    tokio::spawn(async move {
        for (chat, msgs) in by_chat {
            backfill_message_titles(&st2, chat, &msgs).await;
        }
        TITLE_SELFHEAL.store(false, Ordering::SeqCst);
    });
}

fn task_with_progress(st: &AppState, t: &CacheTask, title: Option<&str>) -> serde_json::Value {
    let mut v = serde_json::to_value(t).unwrap_or(serde_json::Value::Null);
    if v.is_object() {
        // 标题随任务一起下发（BUG-232 v2）：行标题 = 入库内容，频道只是元数据。
        if let Some(ti) = title {
            v["title"] = json!(ti);
        }
        if t.status == "running" {
            if let Some((bytes, total)) = st.cache_dl_progress(t.id) {
                if total > 0 {
                    v["itemBytes"] = json!(bytes);
                    v["itemBytesTotal"] = json!(total);
                }
            }
            // BUG-221：字节心跳。与上面的 `itemBytes` 是**两件事**：
            // - `itemBytes` 是「条目内进度条」用的读数，要求总量已知（total > 0）才给，
            //   否则 0/0 的分母没有意义；
            // - `progressBytes` 是「有没有在推进」的读数，**总量未知也要如实下发**
            //   （真实场景里 total 常在开流后若干 chunk 才可知），否则「未知总量」会
            //   退化成「无数据」，界面又回到「0/1 恒 0%」的老样子。
            //   总量未知时 `progressBytesTotal` 显式为 null：前端据此显示
            //   「已下载 X MB」而不是拿 0 当分母假造百分比。
            // `progressAt` 是字节最后一次推进的墙钟（ms epoch），只在真的推进过
            // （`last_ms > 0`）时才给 —— 它是前端区分「在下载 / 卡死」的唯一依据。
            // 全部走内存快照，不碰 SQLite（本端点是 1s 轮询的高频读路径）。
            if let Some((bytes, total, at_ms)) = st.cache_dl_progress_at(t.id) {
                if bytes > 0 {
                    v["progressBytes"] = json!(bytes);
                    v["progressBytesTotal"] = if total > 0 {
                        json!(total)
                    } else {
                        serde_json::Value::Null
                    };
                    if at_ms > 0 {
                        v["progressAt"] = json!(at_ms);
                    }
                }
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
                // BUG-345：group_id > JS 2^53 ⇒ 串界下发（number 过界即丢精度，
                // 活库 62/70 个组键任务曾被污染）。None 序列化为 null。
                "groupId": t.group_id.map(|g| g.to_string()),
                "messageIds": t.message_ids,
                "total": t.total,
            })
        })
        .collect();
    json!({
        // 标题**不在这里**取（BUG-232 v2）：这是 1s 轮询端点，读路径契约是
        // 「服务内存快照，不碰 SQLite」——为了标题加一次 DB 查询会把流畅度底线换掉。
        // 需要标题的是缓存管理面板（/tasks/all）与单任务端点，两者各自带出。
        "task": task.as_ref().map(|t| task_with_progress(st, t, None)),
        "queued": queued,
    })
}

async fn list_cache_tasks(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(cache_tasks_payload(&st).await))
}

/// GET /api/tg/cache/tasks/all — 全量任务列表 + 各状态计数（缓存管理面板）。
/// 活跃优先、新→旧，上限 500；counts 覆盖全部状态（未出现为 0）。
// BUG-085：移除无用的全表 count。daemon 侧的 `TgTasksPayload`
// （download-engine/crates/orig-daemon/src/activity.rs:157-161）只反序列化 `tasks`，
// 从不读取 `counts`——原 `count_cache_tasks()` 的结果每次 5s 轮询都被丢弃，纯属白跑一条
// 全表 count。这里直接砍掉 counts 字段与其查询，保留 tasks 本身即可。
//
// BUG-375：**读路径改走内存快照，零 DB**。
//
// 旧实现每次请求打三条 SQL（`list_cache_tasks(500)` + 逐频道标题 + 清单摘要聚合），
// 而 `st.store` 与下载 worker **共用同一条 libsql 连接** —— worker 持写事务时读只能
// 排队等锁。实测同一请求 3.18s / 0.03s / **13.70s**（无写竞争时三条合计仅 36ms），
// daemon 出向客户端总超时 4s ⇒ 大量请求被切成 `request orig-tg: error sending
// request for url`，用户侧即「TG 入库任务暂时无法读取 / 进度完全不动 / 卡顿」。
//
// 同文件的 `/api/tg/cache/tasks`（单任务端点）早已读 `cache_tasks` 快照、注释写明
// 「读路径 O(1)：服务内存快照，不碰 SQLite —— 这是前端 1s 轮询的高频端点，读走内存
// 是流畅度的底线」。本端点同在轮询路径上（daemon 每 5s 拉一次），却没有享受同等待遇
// —— **快的那条的成果没有辐射到慢的那条**，这就是缺陷本身。
//
// 现在三个快照（tasks / 标题来源 / 清单摘要）都由「唯一写者」在每次 DB 变更后经
// `refresh_cache_tasks` 同步重建，读方 clone `Arc` 即返回：零 DB、零锁竞争。
/// 内核：纯读快照，不碰 `st.store`（测试直接驱动，用「有牙」的判据证明不走库）。
async fn all_cache_tasks_payload(st: &Arc<AppState>) -> serde_json::Value {
    let tasks = st.cache_tasks_snapshot().await;
    let titles = st.cache_task_titles_snapshot().await;
    let summaries = st.cache_task_summaries_snapshot().await;
    // 无标题 ⇒ 后台自愈补登记，下轮轮询即拿到 caption（别再退回频道名）。
    spawn_title_selfheal(st, &tasks, &titles);
    let out: Vec<serde_json::Value> = tasks
        .iter()
        .map(|t| {
            let mut v = task_with_progress(st.as_ref(), t, cache_task_title(t, &titles).as_deref());
            if let Some(s) = summaries.get(&t.id) {
                if v.is_object() {
                    v["manifest"] = json!(s);
                }
            }
            v
        })
        .collect();
    json!({ "tasks": out })
}

async fn list_all_cache_tasks(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(all_cache_tasks_payload(&st).await))
}

/// GET /api/tg/cache/tasks/:id — 读取单个任务（轮询用，避免每次拉全量列表）。
async fn cache_task_by_id(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    match st.store.get_cache_task(id).await {
        Ok(Some(t)) => {
            let titles = cache_task_titles(&st, std::slice::from_ref(&t)).await;
            Ok(Json(task_with_progress(&st, &t, cache_task_title(&t, &titles).as_deref())))
        }
        Ok(None) => Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found")),
        Err(e) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())),
    }
}

/// GET /api/tg/cache/tasks/:id/items — 任务级组清单（D22-A② / BUG-296）。
///
/// 返回**序号全集**（取自 `cache_task.items`，即客户端扫描 TG 的真值）+ 每条状态
/// （`slotted` 已编入 / `registered_unslotted` 已登记未编入 / `missing` 无条目）
/// + `imageCount` + `gap`（真缺口 = 未编入数 − 挂图数）。
///
/// **派生读**：数据源全是既有表，不新建业务表、不写库。`404` = 任务不存在。
async fn cache_task_items(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    match st.store.task_group_manifest(id).await {
        Ok(Some(m)) => Ok(Json(json!(m))),
        Ok(None) => Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found")),
        Err(e) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())),
    }
}

/// BUG-279：`GET /api/tg/cache/tasks/by-item` 的查询参数。
/// - 单条：`chatId` + `messageId` → 返回 `{ task }`；
/// - 批量：`refs=<chat:msg>,<chat:msg>,…` → 返回 `{ tasks: { "<chat:msg>": task|null } }`。
/// 批量用于媒体库剧集详情一次覆盖全部分集，**避免逐集 N+1 请求**（BUG-241 判据：
/// 请求数不得随条目数线性增长）。
#[derive(Debug, Deserialize)]
struct CacheTaskByItemQuery {
    #[serde(rename = "chatId")]
    chat_id: Option<i64>,
    #[serde(rename = "messageId")]
    message_id: Option<i64>,
    refs: Option<String>,
}

/// GET /api/tg/cache/tasks/by-item — 按条目查其缓存任务态（BUG-279）。
///
/// 媒体库未缓存条目据此展示「排队中 / 正在下 / 上次失败（原因）/ 被取消 /
/// 已完成但无字节」。单条 `task: null` / 批量 `tasks[ref]=null` 表示这条视频
/// **从未入队 / 记录已删**——与「失败 / 取消」语义严格区分（后者都有任务记录）。
/// 端点只读、不新建表。批量模式（`refs`）让剧集详情**一次请求**拿全部分集，
/// 杜绝逐集 N+1（对齐 BUG-241 Priority 2 的批量化思路）。复用 `task_with_progress`。
async fn cache_task_by_item(
    State(st): State<Arc<AppState>>,
    Query(q): Query<CacheTaskByItemQuery>,
) -> Result<impl IntoResponse, ApiError> {
    // 批量模式
    if let Some(refs) = q.refs.as_deref() {
        let mut map = serde_json::Map::new();
        for r in refs.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let key = r.to_string();
            let v = match parse_tg_ref_coords(&key) {
                Some((c, m)) => match st.store.cache_task_for_item(c, m).await {
                    Ok(Some(t)) => {
                        let titles = cache_task_titles(&st, std::slice::from_ref(&t)).await;
                        serde_json::to_value(task_with_progress(
                            &st,
                            &t,
                            cache_task_title(&t, &titles).as_deref(),
                        ))
                        .unwrap_or(serde_json::Value::Null)
                    }
                    Ok(None) => serde_json::Value::Null,
                    Err(e) => {
                        return Err(ApiError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            &e.to_string(),
                        ))
                    }
                },
                None => serde_json::Value::Null,
            };
            map.insert(key, v);
        }
        return Ok(Json(json!({ "tasks": map })));
    }
    // 单条模式
    let (chat_id, message_id) = match (q.chat_id, q.message_id) {
        (Some(c), Some(m)) => (c, m),
        _ => {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "chatId+messageId or refs required",
            ))
        }
    };
    match st.store.cache_task_for_item(chat_id, message_id).await {
        Ok(Some(t)) => {
            let titles = cache_task_titles(&st, std::slice::from_ref(&t)).await;
            Ok(Json(json!({ "task": task_with_progress(&st, &t, cache_task_title(&t, &titles).as_deref()) })))
        }
        Ok(None) => Ok(Json(json!({ "task": null }))),
        Err(e) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())),
    }
}

/// DELETE /api/tg/cache/tasks/:id — 取消缓存任务（worker 在下一条目间隙退出）。
///
/// BUG-249：状态迁移走 `cache::cancel_task_kernel` —— 批量取消端点
/// （`POST /api/cache/tasks/cancel?ids=`）调的是同一个内核，单条/批量**同一真源**。
async fn cancel_cache_task_route(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    if !crate::cache::cancel_task_kernel(&st, id).await? {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no active cache task with this id",
        ));
    }
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

/// 消息元数据登记的唯一真源：为本组消息**补写缺失的** `media_message` 行（幂等）。
///
/// **为什么要在入队时也登记一次（BUG-246）**：任务标题链
/// （`cache_task_titles` → `message_captions_for_channels`）的事实源是
/// `media_message` 表；而该行历史上只在 worker **启动任务时**由
/// `IngestCtx::prepare()` 补写。排队任务根本不启动 worker ⇒ 行整条缺失 ⇒
/// 标题恒 None ⇒ 前端退回裸频道名（实测：83 条任务里 `queued` 12/12 无 title，
/// 库中逐消息查全是「缺行」——既不是 caption 为空，也不是 ID 形态不符）。
///
/// 与 BUG-170 的裁定同向：**元数据登记是瞬间的，耗时的只有字节**。所以在入队这条
/// 快路径上顺手登记掉元数据，字节仍交给 worker 慢慢搬。
///
/// 只补缺失：`get_message` 已命中的消息直接跳过，避免每次入队都打一轮 MTProto。
/// 容错语义与 `prepare()` 完全一致——单行失败跳过、不返回错误：元数据只影响标题，
/// 绝不能反过来阻断入队或字节入库。
async fn ensure_message_rows(st: &Arc<AppState>, chat_id: i64, msg_ids: &[i64]) {
    for msg_id in msg_ids {
        if matches!(st.store.get_message(chat_id, *msg_id).await, Ok(Some(_))) {
            continue;
        }
        if let Ok(Some(m)) = st.client.message_meta(chat_id, *msg_id).await {
            let _ = st
                .store
                .upsert_message(
                    chat_id,
                    *msg_id,
                    m.caption.as_deref(),
                    m.mime_type.as_deref(),
                    m.size,
                    m.media_type.as_deref(),
                    m.date,
                    m.duration,
                    m.group_id,

                    m.file_name.as_deref(),
                )
                .await;
        }
    }
}

/// BUG-220：**标题回填**（与上面的登记是**两件事**，判据不同）。
///
/// 登记 `ensure_message_rows` 的判据是「行是否存在」——只要行在就跳过（BUG-246 的语义，
/// 不能改：改了会让增量登记反复打 MTProto）。但标题要的判据是「**有没有标题来源**」：
/// 一条 caption 为空、file_name 也还没补的行，对登记而言「已完成」，对标题而言「仍缺」。
///
/// 所以这里单列一个只管标题的补齐：缺标题就重取一次元数据（把 file_name 补上），
/// 按 (chat,msg) 最多 `MAX_TITLE_BACKFILL_ATTEMPTS` 次——补到即止（`message_has_title`
/// 命中），补不到就永久放弃，绝不每轮轮询都去打扰 MTProto。
async fn backfill_message_titles(st: &Arc<AppState>, chat_id: i64, msg_ids: &[i64]) {
    // 本轮回合**真正写库**的引用（BUG-375）：自愈补回的标题必须让快照重新解析，
    // 否则增量合并的快照里这些引用早已是「解析过、无标题」，补回来的 caption
    // 会被永久挡在快照外 —— 界面看不到，`spawn_title_selfheal` 也不再触发
    // （它只扫无标题任务，而那时标题已经在库里了）。
    let mut wrote: Vec<(i64, i64)> = Vec::new();
    for msg_id in msg_ids {
        if matches!(st.store.message_has_title(chat_id, *msg_id).await, Ok(true)) {
            continue;
        }
        {
            let mut m = TITLE_BACKFILL_ATTEMPTS.lock().unwrap_or_else(|e| e.into_inner());
            let n = m.entry((chat_id, *msg_id)).or_insert(0);
            if *n >= MAX_TITLE_BACKFILL_ATTEMPTS {
                continue;
            }
            *n += 1;
        }
        if let Ok(Some(meta)) = st.client.message_meta(chat_id, *msg_id).await {
            let ok = st
                .store
                .upsert_message(
                    chat_id,
                    *msg_id,
                    meta.caption.as_deref(),
                    meta.mime_type.as_deref(),
                    meta.size,
                    meta.media_type.as_deref(),
                    meta.date,
                    meta.duration,
                    meta.group_id,
                    meta.file_name.as_deref(),
                )
                .await;
            if ok.is_ok() {
                wrote.push((chat_id, *msg_id));
            }
        }
    }
    if !wrote.is_empty() {
        // 不是「打回未解析」而是**当场重新解析并写回快照**（BUG-375）：只移除键会让
        // 标题在下一次写点前一直不可见，而自愈又因「库里已有标题」不再触发 ⇒ 永久看不到。
        st.resolve_cache_task_titles(&wrote).await;
    }
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

/// **T0 事实登记的唯一真源**：`media_item` 行（`file_path=NULL` 待回填），
/// 返回 `(item_id, 库中 kind)`。
///
/// 登记 **= 事实先到**，`file_path=NULL` 是它的核心语义（字节未落、信息先在）：
/// 用户点「加入媒体库」的瞬间条目就该存在于媒体库，而不是等 worker 把字节搬完。
/// BUG-248 之前本函数只挂在 [`IngestCtx::register_item`] 上，而它的调用点只有
/// worker 逐条路径 ⇒ 排队期间条目在媒体库里**根本不存在**（顺序倒置）。提取成与
/// `IngestCtx` 无关的自由函数后，入队时刻（没有该剧集/槽位上下文）也能直接复用
/// 同一份登记逻辑——AGENTS.md §2 单一真源，禁止两处各写一份。
///
/// 已存在（按 `source`+`ref`）时**不新建第二行**，而是走 [`strengthen_registered_item`]
/// 用**更强的事实补强**它：T0 那一刻可能还没有 `media_message` 行（RT 慢/值尚未拉取），
/// 登记只能用「空」事实（kind=file、标题空），元数据到位后必须能把这两种事实修回来，
/// 否则「先登记」换来的就是一个永远认不出的空卡片（BUG-220 同类的认不出）。
///
/// kind 以**库中值**为准：重复登记（重试/幂等重跑）的旧条目保留既有 kind——
/// 与旧实现 `item_kinds` 取数同源；新建条目写入 T0 判定的 kind（字节未落，
/// 无扩展名可判）。登记失败返回 `None`（不阻断调用方——**登记是加速，不是字节的前提**）。
///
/// BUG-281：`group_desc` = 组级 caption 的**正文**（`split_caption(first_caption(...)).1`，
/// 与 [`IngestCtx::ensure_series`] 同一来源）。相册组的 caption 在 TG 上通常只挂在
/// **一条**消息上（实测组 3373-3380 只有 3378 有），该消息自己的 caption 没有正文时
/// （无 caption / 单行 caption / 行未到位），分集介绍继承组级正文 —— 否则 79% 的
/// 分集介绍全空。**标题不继承**（BUG-154：不拿内部文件名/别条文案伪造标题）。
async fn register_media_item_t0(
    st: &Arc<AppState>,
    chat_id: i64,
    msg_id: i64,
    photo_rule: bool,
    group_desc: Option<&str>,
) -> Option<(i64, String)> {
    let ref_key = format!("{}:{}", chat_id, msg_id);
    let row = st.store.get_message(chat_id, msg_id).await.ok().flatten();
    let kind = match &row {
        Some(m) => meta_kind(m.media_type.as_deref(), m.mime_type.as_deref()),
        None => "file".to_string(),
    };
    let id = match st.store.item_id_by_ref("tg", &ref_key).await {
        Ok(Some(id)) => {
            // 已在库：只做补强（同一事实的更完整版本），不再开口重新 upsert。
            strengthen_registered_item(st, id, &row, kind.as_str(), msg_id, photo_rule, group_desc)
                .await;
            id
        }
        _ => {
            // 新登记：file_path=NULL 是 T0 的核心语义（字节未落，事实先在）。
            // 标题只取 caption 首行（split_caption），其余进 description——
            // 与剧集、与旧 import_cached_file/import_photo_item 同一把尺子。
            let (title, desc) = row
                .as_ref()
                .and_then(|m| m.caption.as_deref())
                .map(crate::media::split_caption)
                .unwrap_or((None, None));
            // BUG-281：自己的 caption 没有正文时，继承组级 caption 正文
            // （相册组只有一条消息带 caption；标题不继承，见函数文档）。
            let desc = desc.or_else(|| group_desc.map(str::to_string));
            // BUG-049 照片条目的可读兜底标题（旧 import_photo_item 同款）；
            // 非照片维持空串（BUG-154：不拿内部文件名伪装标题）。
            //
            // BUG-362：兜底标题必须带**频道名**。旧形态 `TG 图片 #{msg_id}` 只说了
            // 「这是 TG 的一张图」—— 媒体库列表里它和 `NanaZip_xxx.zip`、
            // `未命名视频 #1574 SE4`、真 caption 并排成五种互不相干的题命名方式，
            // 用户原话「样式混乱：NanaZip 在第一行，TG弹窗标题在第二行」：
            // 他要看的是**这条内容来自哪个 TG 会话**，而旧标题把它抹成了编号。
            // 取不到频道名时才退回 `TG {chat_id}`（与剧集命名同一把尺子，见
            // `channel_title` 的调用处），绝不退回空串（空标题不可辨识）。
            let title = match title {
                Some(t) => t,
                None if photo_rule => {
                    let base = channel_title(st, chat_id)
                        .await
                        .unwrap_or_else(|| format!("TG {chat_id}"));
                    format!("{base} · 图片 #{msg_id}")
                }
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

/// 用**更强的事实**补强一条已登记的条目（只在「更强」时动手）。
///
/// 为什么需要它：BUG-248 的登记被推到入队时刻，而那一刻 `media_message` 行可能还没到
///（RT 受 MTProto 影响，实测同一条消息在下载争用下 27s 后才落行）。先登记是契约，
/// 于是首版用到的事实可能是空的：kind 只能判成 `file`、标题只能是空串。元数据到位后
/// 必须补回来——否则「先入信息」换来的就是一张永远认不出的卡。
///
/// 保守规则（宁可少写，不可改写用户的事实）：
///   - 标题：只有**现有标题为空/纯空白**时才写入（用户改过的、参照 BUG-049 生成的
///     兜底标题一律不动）；拿不到 caption 就不写（BUG-154：不拿内部文件名伪装）；
///   - kind：只做**单向升级**（`file` → `video`/`photo`/`audio`），不降级。字节落盘后
///     由 `backfill_item_bytes` 按扩展名再校正一次，这里不与它抢判；
///   - 介绍/时长/尺寸：结构性缺失（NULL）才补，已有值不动。
///
/// BUG-281：`group_desc` = 组级 caption 正文（同 [`register_media_item_t0`] 的来源）。
/// 该消息自己的 caption 没有正文、且条目介绍位仍为 NULL/空白时，用组级正文补位
/// （fill-empty guard）：用户写过的介绍不覆盖；有自有正文时走既有 own-caption 写法
/// （本条不改其行为）。组级补填**单独**就能触发一次写入——监控同步会预填
/// `media_message` 行，入队时条目已带完整 kind/时长，只有介绍位是空的。
async fn strengthen_registered_item(
    st: &Arc<AppState>,
    id: i64,
    row: &Option<crate::store::StoredMessage>,
    derived_kind: &str,
    msg_id: i64,
    photo_rule: bool,
    group_desc: Option<&str>,
) {
    let Some(msg) = row.as_ref() else {
        // 元数据仍未到位：此刻没有任何更强的事实，什么都不写（下一次登记会再来）。
        return;
    };
    let Some(existing) = st.store.get_media_item(id).await.ok().flatten() else {
        return;
    };
    let existing_blank = existing.title.trim().is_empty();
    let (title, desc) = msg
        .caption
        .as_deref()
        .map(crate::media::split_caption)
        .unwrap_or((None, None));
    let patch_title = match title {
        Some(t) if existing_blank => Some(t),
        // 没有 caption 的照片：BUG-049 兜底标题同样只在标题仍空时补。
        // BUG-362：与 `register_media_item_t0` 的新登记同一把尺子 —— 兜底标题带
        // **频道名**（`{频道} · 图片 #{msg_id}`），不再是无从辨认的 `TG 图片 #{msg_id}`。
        None if existing_blank && photo_rule => {
            let base = channel_title(st, msg.channel_id)
                .await
                .unwrap_or_else(|| format!("TG {}", msg.channel_id));
            Some(format!("{base} · 图片 #{msg_id}"))
        }
        _ => None,
    };
    // kind 只单向升级：`file` 是从「没有元数据」推出来的占位，被更有信息量的判定替换
    // 才叫补强；反过来把已明确的 kind 降级成一无所知的 `file` 是破坏。
    let patch_kind = match (existing.kind.as_str(), derived_kind) {
        ("file", k) if k != "file" => Some(k.to_string()),
        _ => None,
    };
    let patch_duration = msg.duration.filter(|_| existing.duration.is_none());
    // BUG-281：组级介绍补填（fill-empty guard）——自己的 caption 没有正文、
    // 且介绍位仍为空（NULL/空白）时才继承组级正文；非空即用户的事实，不覆盖。
    let existing_desc_blank = existing
        .description
        .as_deref()
        .is_none_or(|d| d.trim().is_empty());
    let group_fill: Option<Option<String>> = if desc.is_some() {
        // 有自有正文：走既有 own-caption 写法，不重复补（两者同源时值也相同）。
        None
    } else if existing_desc_blank {
        group_desc
            .map(str::to_string)
            .filter(|d| !d.trim().is_empty())
            .map(Some)
    } else {
        None
    };
    // 早退条件：既有三件套**原样**（own-caption 介绍的写入时机因此不变），
    // 外加组级补填——它必须能单独触发一次写入（见函数文档的监控预填行场景）。
    if patch_title.is_none()
        && patch_kind.is_none()
        && patch_duration.is_none()
        && group_fill.is_none()
    {
        return;
    }
    let patch = crate::media::ItemPatch {
        title: patch_title,
        description: desc.map(Some).or(group_fill),
        poster: None,
        duration: patch_duration,
        width: None,
        height: None,
        kind: patch_kind,
    };
    if let Err(e) = st.store.update_media_item(id, &patch).await {
        st.push_log(&format!("cache ingest strengthen #{id} failed: {e}"));
    }
}

/// BUG-248：入队时刻的登记 —— 「信息已在、字节未到」在这里落地。
///
/// 三步**串在同一个协程**里，顺序是刻意的：
///
///   ① **先登记**（此刻有什么事实就用什么，可能只有 ref）：不等 MTProto —— 用户点
///      「加入媒体库」的瞬间条目就该在媒体库里，排队期间看得见是本条的全部要义；
///   ② 补 `media_message` 行（BUG-246 的同一件事，慢路径，MTProto RT）；
///   ③ 再登记一次：①建的条目此时被 [`strengthen_registered_item`] 用真标题/kind 补强，
///      **不必等 worker 轮到这条任务**（队列可能要排几十分钟）；组级 caption 的正文
///      也在这一步分发给组内各分集（BUG-281：相册组的 caption 只挂在一条消息上）。
///
/// 剧集槽位**不在这里登记**——入队时刻没有剧集/归属上下文（那份目标池来自全组预扫
/// [`IngestCtx::prepare`]），槽位仍由 worker 处理时建立。
///
/// 容错与 BUG-246 一致（**登记失败不阻断入队**）：登记只影响「先在」，字节搬运由
/// worker 负责；把一次 DB 故障变成「加入媒体库失败」比不做更糟。
async fn register_enqueued_items(st: &Arc<AppState>, chat_id: i64, msg_ids: &[i64]) {
    // ① T0 事实登记：快路径，不为元数据行等待。此刻 `media_message` 行一般还没落
    // （监控同步 / worker 才会补），组级 caption 取不到 ⇒ 传 None，留给 ③ 补。
    for msg_id in msg_ids {
        register_media_item_t0(st, chat_id, *msg_id, false, None).await;
    }
    // ② 元数据登记（BUG-246 的唯一真源，幂等、缺黄豆几百毫秒到几十秒都可能）。
    ensure_message_rows(st, chat_id, msg_ids).await;
    // BUG-281：组级 caption 只取一次（与 `IngestCtx::ensure_series` 同一来源）——
    // 首行标题、其余正文。相册组的 caption 通常只挂在一条消息上，正文在这里
    // 分发给组内其余分集（标题不分发：BUG-154 不伪造标题）。
    let group_desc = st
        .store
        .first_caption(chat_id, msg_ids)
        .await
        .ok()
        .flatten()
        .as_deref()
        .map(crate::media::split_caption)
        .and_then(|(_title, body)| body);
    // ③ 元数据到位后补强既有条目（标题 / kind / 时长 / 组级介绍）。
    for msg_id in msg_ids {
        let photo_rule = matches!(
            st.store.get_message(chat_id, *msg_id).await,
            Ok(Some(m)) if m.media_type.as_deref() == Some("photo")
        );
        register_media_item_t0(st, chat_id, *msg_id, photo_rule, group_desc.as_deref()).await;
    }
}

/// 逐任务登记上下文（metadata-first ingest 的状态机）。
///
/// 职责：把旧实现「任务末尾一次性 `append_episodes_ranged` + 照片归属」的**最终
/// 库状态**逐消息就地复现（等价性论证）：
///   - 非照片条目：T0 即建剧集槽位。`append_episodes_ranged` 的占用快照/去重/
///     墓碑每次调用都从库中重读，`next` 游标等价演进——**同序**下逐条追加与
///     整批追加产生相同落位，故逐条登记 ≡ 任务末批量登记。
///     实际只有 **video** 能落位（BUG-044 触发器只放 video；file/audio 留作库内内容）。
///   - 混编组照片（BUG-168）：挂到「组内它之前最近的**非照片**条目」所在集，
///     组首照片归首个非照片条目那一集（旧实现同一规则，目标池同为 media_pairs
///     = 非照片条目，不限于 video）。目标由全组消息预扫确定；目标条目登记槽位
///     的瞬间即挂（`add_episode_image` insert-or-ignore，幂等）。
///   - photo-only 组（组内无 video）：照片**不成集**（BUG-044 回归修复，2026-10-15
///     用户裁定「图片与视频混用集是基础逻辑错误」）—— 只完成 T0 登记，留在库内内容位。
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
    /// BUG-281：组级 caption 的**正文**（`prepare` 时取一次，与 `ensure_series`
    /// 同源）——自己的 caption 没有正文的分集继承它；标题不继承（BUG-154）。
    group_desc: Option<String>,
}

impl IngestCtx {
    /// 任务开始时的预扫：确保组内每条消息的 tg_message 行就位（判型与 caption
    /// 离线可读——剧集标题取 `first_caption` 依赖它；未监控频道此前要等下载后才
    /// 补行，登记前移后必须在 T0 之前就位），再据 `meta_kind` 圈出归属目标池与
    /// has_video。元数据拉取失败的消息不阻断：行缺席时该消息不进目标池，T0 登记
    /// 退化为 file/无标题（与旧实现 meta 缺失同貌）。
    async fn prepare(st: &Arc<AppState>, task: &CacheTask) -> Self {
    // 元数据登记走唯一真源（BUG-246）：入队时通常已补过行，这里重跑是幂等的
    // 安全网——历史任务、入队时登记失败的消息、以及升级前入队的任务都靠它兜底。
    ensure_message_rows(st, task.chat_id, &task.message_ids).await;
    // BUG-281：组级 caption 正文只取一次（与 `ensure_series` 同一来源）——相册组
    // 的 caption 通常只挂在一条消息上，正文分发给组内自己的 caption 没有正文的
    // 分集；标题不分发（BUG-154：不伪造标题）。
    let group_desc = st
        .store
        .first_caption(task.chat_id, &task.message_ids)
        .await
        .ok()
        .flatten()
        .as_deref()
        .map(crate::media::split_caption)
        .and_then(|(_title, body)| body);
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
            group_desc,
        }
    }

    /// T0 事实登记：`media_item` 行（`file_path=NULL` 待回填），返回 (item_id, 库中 kind)。
    ///
    /// 逻辑本体在上方的 [`register_media_item_t0`] —— 它是登记的唯一真源，入队时刻
    /// （BUG-248）与本 worker 路径共用同一份实现，语义不变：**含 `item_id_by_ref`
    /// 复用、失败只记日志、返回 `(item_id, 库中 kind)`**。这里的 `&self` 只提供
    /// `chat_id`（剧集上下文在 `register_slot`，与条目登记无关）与 `group_desc`
    /// （BUG-281：组级 caption 正文，`prepare` 时取一次）。
    async fn register_item(
        &self,
        st: &Arc<AppState>,
        msg_id: i64,
        photo_rule: bool,
    ) -> Option<(i64, String)> {
        register_media_item_t0(
            st,
            self.chat_id,
            msg_id,
            photo_rule,
            self.group_desc.as_deref(),
        )
        .await
    }

    /// T0 槽位登记：**只有视频编入剧集**；混编组照片挂目标集图片位；
    /// photo-only 组照片不成集（BUG-044 回归修复）。每次登记都幂等
    /// （`append_episodes_ranged` 跳过已收录条目、墓碑照拦；挂图 insert-or-ignore）。
    async fn register_slot(&mut self, st: &Arc<AppState>, msg_id: i64, item_id: i64, kind: &str) {
        self.ingested.push((msg_id, item_id));
        if kind == "photo" {
            self.register_photo_slot(st, msg_id, item_id).await;
            return;
        }
        // BUG-044 回归修复（2026-10-15 用户裁定）：分集只能是视频。第 4 轮曾把
        // 分集放宽到 `video | photo`（「剧集是通用归档容器」），结果是图片与视频
        // 混用「集」—— 实测生产库 50 条真实照片分集、31 个纯图剧集。file/audio
        // 同样不成集（触发器只放 video），它们作为库内内容条目可检索。
        if kind != "video" {
            return;
        }
        // 非照片：一槽一位（混编/纯视频组同规则，旧 media_pairs 同义）。
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
    ///
    /// **photo-only 组不成集**（BUG-044 回归修复，2026-10-15）：组内无视频时照片
    /// 只完成 T0 登记（`media_item` 行，标题/介绍/标签照常），不占集号 ——
    /// 「图片与视频混用集」正是第 4 轮「照片各自成集」的直接后果。
    async fn register_photo_slot(&mut self, st: &Arc<AppState>, msg_id: i64, item_id: i64) {
        if !self.has_video {
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
            // 组内没有任何非照片条目：不可能走到（has_video ⇒ slot_msgs 非空）。
            // 防御性兜底同样**不成集**（BUG-044）：照片留在库内内容位，不占集号。
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
        let norm = title.as_deref().map(normalized_series_name).unwrap_or_default();
        let title = if norm.trim().is_empty() {
            let base = channel_title(st, self.chat_id)
                .await
                .unwrap_or_else(|| format!("TG {}", self.chat_id));
            format!("{base} · {}", ymd_str(self.created_at as u64))
        } else {
            norm.clone()
        };
        // D22-A①（BUG-292）：幂等键统一为**规范化剧名**，相册 `group_id` 只作退化兜底。
        // 旧实现按 `task.group_id` 有无二选一 —— 同一部剧分批缓存两次入库键不等，
        // 于是裂成两部（实测生产库 3→5 对）。
        let key = episodic_group_key(
            self.chat_id,
            &norm,
            self.task_group,
            self.task_msgs.first().copied().unwrap_or(0),
        );
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

/// 条目级失败的**任务级汇总**（BUG-257 方向 3）。
///
/// `cache_task.error` 是任务级字段，而失败是条目级事件。汇总必须能直接回答用户的
/// 问题「**哪几条**失败了」：`N/M item(s) failed: chat:msg 短原因; …`。
///
/// 两个封顶是刻意的：
/// - **每条原因截 80 字符**——足够辨认「no bytes for 90s」「media not found」这类信号，
///   又不至于把 20 条失败撑成几千字节（error 列要进任务 JSON，随 1s 轮询下发）；
/// - **至多列 10 条**，其余以计数交代——完整逐条原因在 RingLog（`push_log`），那里
///   才是日志的家；error 列是给前端一行展示的，不是日志的替身。
///
/// 前缀 `N/M item(s) failed:` 同时是**前端识别标记**：`CacheManagerDialog` 见到它
/// 就原样展示（它本身就是答案），否则才走 `describeTgFailure` 的折叠——别改这个
/// 前缀的形状，改了前端就退回「通用文案吃掉具体诊断」的老毛病（BUG-257 点 3）。
fn summarize_item_failures(chat_id: i64, total: i64, failures: &[(i64, String)]) -> String {
    const MAX_LISTED: usize = 10;
    const MAX_REASON_CHARS: usize = 80;
    let mut parts: Vec<String> = failures
        .iter()
        .take(MAX_LISTED)
        .map(|(msg, reason)| {
            let mut r = reason.trim().to_string();
            if r.chars().count() > MAX_REASON_CHARS {
                r = r.chars().take(MAX_REASON_CHARS).collect::<String>() + "…";
            }
            format!("{chat_id}:{msg} {r}")
        })
        .collect();
    if failures.len() > MAX_LISTED {
        parts.push(format!("… and {} more (see /api/tg/logs)", failures.len() - MAX_LISTED));
    }
    format!(
        "{}/{} item(s) failed: {}",
        failures.len(),
        total,
        parts.join("; ")
    )
}

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
    let dir = effective_download_dir(st).await;
    let mut done: i64 = 0;

    // ── byte-ownership P1（设计 I1「事实先登记」）─────────────────────────────
    // 登记从「任务终态一次性 append_episodes_ranged」前移到「逐消息取字节之前」：
    // 任务开始处理某条消息时，先建立 media_item 行（file_path=NULL 待回填）与
    // 剧集槽位（T0，瞬间），再取字节；落盘成功后用 `backfill_item_bytes` 专用
    // 语句回填（不走 COALESCE upsert——MEDIA-DESIGN C3：那会粘住旧路径）。
    // 下载失败 → 条目保留缺字节、任务 failed，登记不撤销（重试只重做字节）。
    // 这正是「缓存→不见了→完成→出现」闪烁的根治：条目自 T0 起持续可见。
    let mut ing = IngestCtx::prepare(st, &task).await;
    // BUG-257（裁定 2026-10-10，方向 3）：条目级失败**不终止任务**。用户原话：
    // 「单条失败……不应该影响其他的」。因此逐条记录失败、继续跑完剩余条目，
    // 循环结束再按「是否有失败」落一次终态（见循环后的 summarize）。
    let mut failures: Vec<(i64, String)> = Vec::new();
    // BUG-257：条目之间的取消判据从「读 DB」改为「认令牌」。两者都在，但令牌是
    // **可达在途 IO** 的那个（见下方 `select!`），必须让两处读**同一个**判据 ——
    // 否则会出现「在途被取消了、下一条目却又按 DB 判成活跃」的自相矛盾。
    let cancel = st.cache_cancel(task_id);
    for msg_id in task.message_ids.iter().copied() {
        if cancel.is_set() || !st.store.is_cache_task_active(task_id).await.unwrap_or(false) {
            st.push_log(format!(
                "cache task {task_id}: cancelled at {done}/{}",
                task.total
            ));
            // 事实不回滚：已登记条目保留；未落位的挂起照片留给下次任务补齐。
            ing.finish(st).await;
            st.clear_cache_cancel(task_id);
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
        // BUG-352：**图片与视频同等下载**。此前这里有一条「BUG-049 图片不缓存」的
        // 短路：photo 只做 T0 登记、跳到 `continue`，字节永不落盘（日志
        // `registered to library (no cache by rule)`）。那条规则在入口上无任何可选
        // 表达——筛选面板勾选的是**整组**（组内图片与视频同样被勾上、同样计入
        // messageIds），界面承诺「选中的 = 要下载的」（BUG-327），引擎却静默跳过其中
        // 一类，且用户没有任何入口能说「我要/不要图片」。
        // 图片是内容不是浏览点（媒体库唯一内容仓、本地文件夹可读）：字节照下，
        // T0 登记照做，`photo_rule` 只保留它原本的另一半职责——无标题时的
        // 「TG 图片 #<msg>」兜底标题。图片仍**不成剧集**（BUG-044，未动）。
        let registered = ing.register_item(st, msg_id, photo_rule).await;
        if let Some((item, kind)) = &registered {
            ing.register_slot(st, msg_id, *item, kind).await;
        }
        // BUG-257：取消**可达在途条目**。此前这里只有一个 `.await`，取消只在下一条目
        // 之前生效 ⇒ 用户按了取消，正在下这一条仍要等满 90s 空闲看门狗才停
        //（判据 1）。现在把整个下载 future 与取消令牌竞速：取消置位 ⇒ 本 await 立即
        // 返回，`.part` 随 future drop 清理（`PartFile` 的 Drop 语义），队列前进。
        //
        // `biased` 且取消分支排第一：取消与下载完成同时就绪时**优先判取消**——
        // 都已经到终态了，再把这一条计成 done 只会让用户看到「取消了却还在涨进度」。
        let cancel = st.cache_cancel(task_id);
        let download = cache_one_bytes(st, Some(task_id), task.chat_id, msg_id, &dir);
        tokio::pin!(download);
        let outcome = tokio::select! {
            biased;
            _ = cancel.wait() => {
                st.push_log(format!(
                    "cache task {task_id}: cancelled during item {msg_id} at {done}/{} \
                     (in-flight transfer aborted)",
                    task.total
                ));
                // 事实不回滚：已登记条目保留（含缺字节的当前条目）。
                // **不调 finish_cache_task**：`cancel_cache_task` 已置 `cancelled`，
                // 再写一次终态只会把「用户取消」说成别的状态。
                ing.finish(st).await;
                st.clear_cache_cancel(task_id);
                return;
            }
            res = &mut download => res,
        };
        match outcome {
            Ok(outcome) => {
                match &registered {
                    Some((item, _)) => {
                        // D24-A（BUG-309）：字节已由 `download` 落到**内容寻址** blob
                        // （`<download_dir>/.blobs/ab/cd/<hash>`）—— 归仓即完成，**不再**
                        // 搬进 `<库根>/<频道>/`（搬走会破坏内容寻址与引用计数）。
                        // `file_path` 记**绝对** blob 路径：`resolve_item_path` 对绝对路径
                        // 原样返回；且它落在下载目录内 ⇒ 进得了清理工作集（按 refcount 回收）。
                        // `kind` 保持 T0 登记值（blob 无扩展名，`classify_ext("")` 会误判成
                        // `file` ⇒ 投递 MIME 退化，故**不**按路径重判）。
                        if let Some(hash) = outcome.content_hash.as_deref() {
                            let _ = st
                                .store
                                .mark_downloaded(task.chat_id, msg_id, Some(&outcome.path))
                                .await;
                            let size = std::fs::metadata(&outcome.path)
                                .map(|m| m.len() as i64)
                                .unwrap_or(outcome.bytes as i64);
                            let _ = st
                                .store
                                .backfill_item_bytes_with_blob(
                                    *item,
                                    &outcome.path,
                                    None,
                                    hash,
                                    size,
                                )
                                .await;
                        } else {
                            // 降级：调用点未给 hash（mock / 旧客户端）—— 退回旧平铺归仓。
                            let housed = crate::cache::house_downloaded_bytes(
                                st,
                                task.chat_id,
                                msg_id,
                                &outcome.path,
                                tg_caption.as_deref(),
                            )
                            .await;
                            let _ = st
                                .store
                                .mark_downloaded(
                                    task.chat_id,
                                    msg_id,
                                    Some(&housed.absolute_path),
                                )
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
                // BUG-257（方向 3）：**记录、继续**。此前这里直接
                // `finish_cache_task("failed")` + `return` —— 条目级事件被升级成任务级
                // 终止，实测 9 条任务第 2 条卡死 ⇒ 剩下 7 条从未尝试（done=2/9 且整条
                // failed）。现在失败只属于这一条：记日志（完整原因在 RingLog）、
                // 记入汇总、`continue` 下一条。**不得**在循环内落终态。
                let reason = e.message().to_string();
                st.push_log(format!(
                    "cache task {task_id}: item {msg_id} failed: {reason} \
                     (continuing with remaining items)"
                ));
                failures.push((msg_id, reason));
                continue;
            }
        }
    }
    // 终态**只在这里落一次**（裁定方向 3）：全成 → done；有失败 → failed + 汇总。
    // 状态语义不变（仍是既有六态，不新增值，RETRYABLE_STATES / BUG-249 契约不动）；
    // 变的是 error 的**内容**：从「第一条失败的原因」换成「哪几条失败了」——
    // 任务级字段终于装下了条目级的事实。取消是例外：令牌触发路径已在循环内提前
    // 返回（终态 `cancelled` 已由 cancel_cache_task 写好），走不到这里。
    let failed = !failures.is_empty();
    let summary = failed.then(|| summarize_item_failures(task.chat_id, task.total, &failures));
    let _ = st
        .store
        .finish_cache_task(
            task_id,
            if failed { "failed" } else { "done" },
            summary.as_deref(),
        )
        .await;
    st.refresh_cache_tasks().await;
    if failed {
        st.push_log(format!(
            "cache task {task_id}: finished with {} failure(s): {}",
            failures.len(),
            summary.as_deref().unwrap_or_default()
        ));
    }
    ing.finish(st).await;
    // 终态即注销令牌：否则 token 表随任务数单调增长（队列可达几十条 × 进程生命周期）。
    st.clear_cache_cancel(task_id);
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

/// POST /api/tg/monitor/channels/:id/read — 标记该频道已读（未读计数归零）。
///
/// 「点开」在语义上是**用户看过了这个频道**，所以游标推到当前最大 message_id。
/// 与「移除监控」分开：已读不改监控关系，也不动已入库消息。
async fn mark_monitor_channel_read(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .mark_channel_read(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct AddMonitorFilterReq {
    /// 显示名（= 这条虚拟监控的名字）；缺省用关键词本身。
    #[serde(default)]
    label: Option<String>,
    /// 匹配关键词（子串，大小写不敏感；匹配 caption 或 file_name）。
    keyword: String,
}

/// GET /api/tg/monitor/filters — 文字筛选规则列表（含各规则命中条数）。
async fn list_monitor_filters(
    State(st): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let items = st
        .store
        .list_filters()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({ "items": items })))
}

/// POST /api/tg/monitor/filters — 新建一条筛选规则（同关键词幂等）。
async fn add_monitor_filter(
    State(st): State<Arc<AppState>>,
    Json(req): Json<AddMonitorFilterReq>,
) -> Result<impl IntoResponse, ApiError> {
    let keyword = req.keyword.trim();
    if keyword.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "keyword is empty"));
    }
    let label = req
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(keyword);
    let id = st
        .store
        .add_filter(label, keyword)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.push_log(format!("/monitor filter add {id} {keyword:?}"));
    Ok(Json(json!({"ok": true, "id": id})))
}

/// DELETE /api/tg/monitor/filters/:id — 删除筛选规则（不动已入库消息）。
async fn remove_monitor_filter(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .remove_filter(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.push_log(format!("/monitor filter remove {id}"));
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct FilterMsgQuery {
    #[serde(default = "default_limit")]
    limit: u32,
    /// 复合游标（BUG-330 / TGM-05）：上一页最后一行的
    /// `(COALESCE(msg_date, created_at), channel_id, message_id)`。
    /// 三个都必须传才算一个完整游标——缺任何一个按无游标（第一页）处理，
    /// 宁可回到第一页也不半截游标翻出重复页。
    /// 查询参数名是 camelCase（前端 `tg.ts` 的 URLSearchParams 与兄弟结构体
    /// `MonitorMsgQuery` 同一约定）——必须显式 `rename`，serde 默认只认下划线
    /// 字段名；漏 rename 的后果是游标被静默丢弃、每页都拉回第一页。
    #[serde(rename = "beforeDate", default)]
    before_date: Option<i64>,
    #[serde(rename = "beforeChannelId", default)]
    before_channel_id: Option<i64>,
    #[serde(rename = "beforeMessageId", default)]
    before_message_id: Option<i64>,
}

/// GET /api/tg/monitor/filters/:id/messages — 某条筛选规则的命中列表（新→旧）。
///
/// 只查本地已同步消息（查询语义，不做网络回补）。命中项带 `channelTitle` 供前端
/// 显示来源；入库时前端按 `channelId` 分组调 `POST /api/tg/cache/tasks`（该端点
/// 一次只接受一个 chatId，跨频道批量必须拆开——这不是本端点要解决的问题）。
async fn monitor_filter_messages(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Query(q): Query<FilterMsgQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let cursor = match (q.before_date, q.before_channel_id, q.before_message_id) {
        (Some(d), Some(c), Some(m)) => Some((d, c, m)),
        _ => None,
    };
    let items = st
        .store
        .filter_messages(id, q.limit, cursor)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!({ "items": items })))
}

/// POST /api/tg/monitor/filters/:id/read — 「点开某条规则」：已读游标推到当前时刻，
/// 「+N 新命中」归零（BUG-330 / TGM-06）。与频道侧 `POST /monitor/channels/:id/read` 同构。
async fn mark_monitor_filter_read(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    st.store
        .mark_filter_read(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.push_log(format!("/monitor filter read {id}"));
    Ok(Json(json!({"ok": true})))
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

                            it.file_name.as_deref(),
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
///
/// **单飞（BUG-102）**：响应为 `{"started": bool, "added": u64}`。
/// `started === false` 表示**已有一轮同步在跑、本次被单飞挡下**（未发起任何
/// Telegram RPC）——此时 `added` 恒为 0。调用方据此区分「我触发的」与「被合并的」，
/// 而不是把「被挡下」误读成「同步了但没新内容」。
async fn monitor_sync(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    match monitor::sync_once(&st).await {
        Ok(outcome) => Ok(Json(json!({
            "started": outcome.started(),
            "added": match outcome {
                monitor::SyncOutcome::Ran { added } => added,
                monitor::SyncOutcome::Skipped => 0,
            },
        }))),
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
    classify_ext, is_valid_series_kind, scan_dir, split_caption, BundleError, EpisodeEdit,
    EpisodeMove, ItemPatch, ItemQuery, SeriesPatch, SERIES_KINDS,
};

/// `GET /api/media/items?kind=&q=&tagId=&seriesId=&unassigned=&hasBytes=&sort=&limit=&offset=`
#[derive(Deserialize)]
struct MediaItemsQuery {
    kind: Option<String>,
    q: Option<String>,
    #[serde(rename = "tagId")]
    tag_id: Option<i64>,
    #[serde(rename = "seriesId")]
    series_id: Option<i64>,
    unassigned: Option<bool>,
    /// BUG-304 / D18：只列已落盘条目（成品列表不列无字节）。缺省 false = 不过滤。
    #[serde(rename = "hasBytes")]
    has_bytes: Option<bool>,
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
        has_bytes: q.has_bytes.unwrap_or(false),
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

/// `POST /api/media/organize/preview` — 批量整理**预览**（D24-A / BUG-311，只读）。
///
/// 逐条渲染模板 → 目标路径（旧路径→新路径、冲突、非法字符清洗）→ 返回全表 diff。
/// **不碰磁盘**（除 `metadata` 探测），可随意重复调用。
async fn organize_preview(
    State(st): State<Arc<AppState>>,
    Json(req): Json<crate::organize::OrganizeRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let report = crate::organize::plan(&st.store, &req)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, &e))?;
    st.push_log(&format!(
        "/api/media/organize/preview: {} item(s), template={:?}",
        report.rows.len(),
        req.template
    ));
    Ok(Json(json!(report)))
}

/// `POST /api/media/organize/apply` — 批量整理**执行**（D24-A / BUG-311）。
///
/// 按 `preview` 的同一份计划落盘：同卷硬链接 / 跨卷副本；目标已就位则跳过（幂等）；
/// 重名加序号（不覆盖）。产物登记为「外部发布路径」。
async fn organize_apply(
    State(st): State<Arc<AppState>>,
    Json(req): Json<crate::organize::OrganizeRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let report = crate::organize::apply(&st.store, &req)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, &e))?;
    st.push_log(&format!(
        "/api/media/organize/apply: {} written, {} failed of {}",
        report.summary.written, report.summary.failed, report.summary.total
    ));
    Ok(Json(json!(report)))
}

/// `GET /api/media/organize/presets` — 整理模板预设（前端下拉用）。
async fn organize_presets() -> impl IntoResponse {
    Json(json!({ "presets": crate::organize::preset_templates() }))
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
    // BUG-304 / D18（用户 2026-10-14 拍板）：导入即成剧 —— 一次导入就是一个
    // 单集剧集（用户口径「视频 = 剧集」的直接翻译）。此前导入路径只
    // `upsert_media_item`，local 条目永远拿不到剧集归属（实测 58 条全有字节、
    // 全无剧），只能等下次进程启动时的自愈补——那期间它们又是「未归档」。
    // 幂等键与启动自愈同一把（`item:{id}` / tg 组键），重复导入不裂剧集。
    // 失败不阻断导入响应（与 BUG-246「登记失败不阻断入队」同口径）。
    match st.store.file_items_into_series(&ids).await {
        Ok((created, attached)) => {
            st.push_log(&format!(
                "/api/media/items: BUG-304 auto-filed {attached} item(s) into {created} new series"
            ));
        }
        Err(e) => {
            st.push_log(&format!(
                "/api/media/items: BUG-304 auto-file failed (non-fatal): {e}"
            ));
        }
    }
    Ok(Json(json!({"ids": ids, "count": ids.len()})))
}

#[derive(Deserialize)]
struct ByRefQuery {
    source: String,
    #[serde(rename = "ref")]
    ref_key: String,
}

/// BUG-241 Priority 2：批量 by-ref 的查询参数（`refs` = 逗号分隔的 `chat:msg` 列表）。
#[derive(Deserialize)]
struct ByRefsQuery {
    source: String,
    refs: String,
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

/// `GET /api/media/items/by-refs?source=tg&refs=<r1>,<r2>,…` — 批量按 (source,ref) 查条目。
///
/// BUG-241 Priority 2：TG 面板此前对每张未见过的图片各发一次 `by-ref`（逐条 N+1，
/// 实测首屏 54 次）；此端点**一个请求**覆盖全部 ref，返回 `{ ids: { ref: id } }`
/// （未入库的 ref 不出现）。前端据此消除 N+1。
async fn media_item_by_refs(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ByRefsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let refs: Vec<String> = q
        .refs
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    let ids = st
        .store
        .item_ids_by_refs(&q.source, &refs)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let mut map = serde_json::Map::new();
    for (r, id) in ids {
        map.insert(r, json!(id));
    }
    Ok(Json(json!({ "ids": map })))
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
        //
        // D24-A（BUG-309）：删条目 = **引用计数必减一次**（条目本身消失），字节则
        // 「删最后一个引用才回收」。`clear_item_bytes` 同处完成 release + 置空并回传
        // 是否归零；`Some(false)`（仍有其他条目共享）⇒ 字节必须留下，否则共享方变死链。
        let orphan = st
            .store
            .clear_item_bytes(id)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        if let Some(p) = item.file_path.as_deref() {
            let dir = crate::cache::download_dir(&st).await;
            let lib_root = st.store.library_root().await;
            let absolute = crate::cache::resolve_item_path(&lib_root, p);
            let absolute_str = absolute.to_string_lossy().into_owned();
            let owned = crate::cache::inside_dir(&dir, &absolute_str)
                || crate::cache::inside_dir(&lib_root, &absolute_str);
            // 无 hash（存量未纳入）或归零 ⇒ 可回收；仍有共享引用 ⇒ 留给别人。
            if owned && orphan.unwrap_or(true) {
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

/// D22-A①（BUG-292/296/297）：episodic 组的**唯一幂等键**。
///
/// 首选**规范化剧名**（`tg:named:{chat}:{name}`）——同一部剧分批缓存（EP1-5 今天、
/// EP6-10 下周）只要剧名一致就落同一部，不再因「本次任务有没有带 `group_id`」而分裂。
/// 旧实现按 `task.group_id` 有无二选一（`tg:group:` / `tg:msgs:`），两次入库键不等 ⇒
/// 同一相册裂成两部（实测生产库 3→5 对，见 BUG-292）。
///
/// 剧名不可得（无 caption，或 caption 整行就是集号）时依次退化：相册 `group_id` →
/// 首条消息号。**退化路径不是主路径**：它只保证「没有剧名的相册」仍能归组，不参与
/// 正常追剧场景。
///
/// **不禁止同名**：键含 `chat_id`，跨频道同名各自成剧、同频道同名幂等同一部；
/// 误并（同频道同名实为两部）走人工「拆剧」，不做自动冲突弹窗（D22-A⑥）。
pub(crate) fn episodic_group_key(
    chat_id: i64,
    normalized_name: &str,
    group_id: Option<i64>,
    first_msg: i64,
) -> String {
    let name = normalized_name.trim();
    if !name.is_empty() {
        format!("tg:named:{chat_id}:{name}")
    } else if let Some(g) = group_id {
        format!("tg:group:{chat_id}:{g}")
    } else {
        format!("tg:msgs:{chat_id}:{first_msg}")
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

/// 内容域给出的**附件定位**（attachment locator）：这条内容的字节现在在哪。
///
/// 这是 BUG-117 的模块边界收口点。内容域（`media.rs` / 库行）只回答「字节在哪」，
/// **不负责取字节**，因此它不需要认识 grammers 类型、也不 import 传输域 —— 铁律
/// 「内容域不 import grammers 类型」得以保持。取字节是**路由层**的职责，由它调
/// 传输域代理。
#[derive(Debug, Clone, PartialEq, Eq)]
enum RawLocator {
    /// 已落盘：库内规范路径（相对 = 库根相对），路由层解析后本地投递。
    LocalPath(String),
    /// 未落盘但来源是 Telegram：路由层凭坐标向传输域取**原图**。
    ///
    /// 只对 photo 给出：图片不落盘是产品既定行为（BUG-115/121 拍板「照片不下载」，
    /// 故 `file_path` 为空对图片是**常态**而非异常），此时原图只能在线取。
    TelegramPhoto {
        /// 传输域坐标：会话 id。
        chat_id: i64,
        /// 传输域坐标：消息 id。
        message_id: i64,
    },
    /// 既无本地字节，也无可回源来源：只能如实报「无字节」。
    Unavailable,
}

/// 解析一条库行的原图字节定位。**纯函数**：不碰传输域、不做 IO。
///
/// 判据只有一条：本地有字节就本地读；没有且来源是 TG 图片，就回源取原图。
/// 绝不因为「取不到原图」就退给缩略图 —— 那正是 BUG-117 的缺陷本体
/// （缩略图不是原图，静默顶替等于「查看原图」这条路根本不存在）。
fn resolve_raw_locator(
    item: &crate::media::MediaItem,
) -> RawLocator {
    if let Some(p) = item.file_path.clone().filter(|s| !s.trim().is_empty()) {
        return RawLocator::LocalPath(p);
    }
    // 只有 TG 来源能回源；本地/其它来源缺字节就是真缺，如实报缺。
    if item.source == "tg" && item.kind == "photo" {
        if let Some((chat_id, message_id)) = parse_tg_ref_coords(&item.ref_key) {
            return RawLocator::TelegramPhoto {
                chat_id,
                message_id,
            };
        }
    }
    RawLocator::Unavailable
}

/// `GET /api/media/items/:id/raw` — 按 id 流式读取原图字节，支持 HTTP Range（拖动进度必需）。
///
/// 两条投递路径共用同一套 Range / ETag / MIME 契约：
///
/// 1. **已落盘** → `serve_local_file`（与 TG 已缓存投递同一实现）；
/// 2. **未落盘的 TG 图片** → 向传输域取**原图**在线流（BUG-117）。
///
/// BUG-117 的两处修正，都落在这条分支上：
/// - **画质**：改取原图（`Client::media` → `Media::Photo`），不再取缩略图
///   （`Client::thumb`）。此前「查看原图」拿到的是 Telegram 缩略图。
/// - **越界**：缩略图代理从内容域**上移到路由层**（本函数），内容域只经
///   [`resolve_raw_locator`] 返回定位，不再直接调用传输域。
///
/// 原图取不到时**如实报错**并留痕，绝不静默给一张缩略图充数。
#[derive(Deserialize)]
struct ThumbQuery {
    /// 目标宽度（像素）；高度按比例。缺省 320，夹在 48..=1024。
    w: Option<u32>,
}

/// 缩略图响应头（与 `/raw` 的差异：这里允许浏览器缓存一天，因为它是**派生字节**，
/// 原图不变则缩略图不变）。
fn thumb_response(bytes: Vec<u8>) -> Response {
    let mut res = Response::new(axum::body::Body::from(bytes));
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    res
}

/// GET /api/media/items/:id/thumb?w=320 —— 网格/封面用的**真缩略图**。
///
/// 为什么必须有这个端点：媒体库照片网格此前直接拿 `/raw`（**原图**，MB 级）当缩略图。
/// 一屏 50 格就是几百 MB 挤在同一个源的 6 条连接上，滚动态整页发卡 —— 这是「请求爆炸」
/// 里比 TG 缩略图更重的一档。本端点把单格字节压到 20–40KB，并**落盘缓存**，
/// 第二次浏览近乎零成本。
///
/// 语义边界（都是刻意为之，别顺手改）：
/// - **只服务 `kind == "photo"`**：视频封面由前端抽帧，不走这里。
/// - 未落盘的照片**不在这里回源**（那会把网格变成远端取图队列）⇒ 404，前端回落 `/raw`。
/// - 解不动（HEIC 等）⇒ 404 回落，**不让「没有缩略图」变成「图没了」**。
/// - `/raw` 与 `/stream` 的语义不受影响：它们仍投递原图/原流（BUG-117）。
async fn media_item_thumb(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Query(q): Query<ThumbQuery>,
) -> Result<Response, ApiError> {
    let w = q.w.unwrap_or(320).clamp(48, 1024);
    let item = st
        .store
        .get_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "media item not found"))?;
    if item.kind != "photo" {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "thumbnail endpoint only applies to photos",
        ));
    }
    let RawLocator::LocalPath(p) = resolve_raw_locator(&item) else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "photo has no local bytes (grid falls back to /raw)",
        ));
    };
    let lib_root = st.store.library_root().await;
    let download_root = st.store.download_root().await;
    let path = crate::cache::resolve_managed_path(&download_root, &lib_root, &p).ok_or_else(|| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "media file path is outside the managed download root (BUG-323)",
        )
    })?;

    // 落盘缓存：同一 (条目, 宽度) 只解码一次。目录与 TG 缩略图缓存同级。
    let cache_path = st
        .config
        .db_path
        .parent()
        .map(|d| d.join("thumb-cache").join(format!("media_{id}_{w}.jpg")));
    if let Some(cp) = &cache_path {
        if let Ok(bytes) = std::fs::read(cp) {
            return Ok(thumb_response(bytes));
        }
    }

    // 解码 + 缩放放阻塞线程池：单张 4MP JPEG 解码约几十毫秒，不能占着 async runtime
    // 影响 TG 控制面（`/api/tg/*` 全在同一个 runtime 上）。
    let src = path.to_path_buf();
    let encoded = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let data = std::fs::read(&src).map_err(|e| format!("read failed: {e}"))?;
        let img = image::load_from_memory(&data).map_err(|e| format!("decode failed: {e}"))?;
        let thumb = img.thumbnail(w, u32::MAX);
        let mut out = Vec::new();
        thumb
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
            .map_err(|e| format!("encode failed: {e}"))?;
        Ok(out)
    })
    .await
    .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &format!("thumb task failed: {e}")))?
    .map_err(|e| ApiError::new(StatusCode::NOT_FOUND, &e))?;

    if let Some(cp) = &cache_path {
        if let Some(dir) = cp.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(cp, &encoded);
    }
    Ok(thumb_response(encoded))
}

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

    match resolve_raw_locator(&item) {
        // P2：file_path 是库内规范形式（相对 = 库根相对），投递前先解析。
        // BUG-323：解析后必须落在下载路径之内（下载路径是所有权限的限制路径）。
        RawLocator::LocalPath(p) => {
            let lib_root = st.store.library_root().await;
            let download_root = st.store.download_root().await;
            let p = crate::cache::resolve_managed_path(&download_root, &lib_root, &p)
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::FORBIDDEN,
                        "media file path is outside the managed download root (BUG-323)",
                    )
                })?
                .to_string_lossy()
                .into_owned();
            serve_local_file(&p, Some(item.kind.as_str()), item.duration, &headers).await
        }
        // 未落盘 → 路由层调传输域代理**原图**（不是缩略图）。
        RawLocator::TelegramPhoto {
            chat_id,
            message_id,
        } => {
            // 与在线流端点共用解析：Range 语义只有一处定义。
            let range = parse_range(headers.get(header::RANGE))?;
            match st.client.media(chat_id, message_id, range).await {
                Ok(stream) => Ok(media_stream_response(
                    stream,
                    range,
                    PHOTO_PROXY_CACHE_CONTROL,
                )),
                Err(ClientError::UnsatisfiableRange(total)) => Ok(media_range_not_satisfiable(
                    total,
                    PHOTO_PROXY_CACHE_CONTROL,
                )),
                Err(e) => {
                    // 取不到原图就如实报「无字节」，并留痕（不静默、不缩略图顶替）。
                    // 链路已断时给出可行动说明，避免把上游故障读成「图片不存在」。
                    let reason = e.to_string();
                    let hint = if st.client.link_alive() {
                        "full-size photo unavailable from telegram"
                    } else {
                        "MTProto link is down; restart orig-tg to recover"
                    };
                    st.push_log_throttled(
                        "raw_photo",
                        60,
                        format!(
                            "/api/media/items/{id}/raw: no local bytes for photo {chat_id}:{message_id} \
                             -> {reason} ({hint})"
                        ),
                    );
                    Err(ApiError::new(
                        StatusCode::NOT_FOUND,
                        &format!("photo has no local bytes and its full-size source is unavailable: {reason}"),
                    ))
                }
            }
        }
        // 无字节且不可回源：显式提示，不静默降级。
        RawLocator::Unavailable => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "item has no local file",
        )),
    }
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

/// 单飞表的**占坑守卫**（BUG-288）：`Drop` 即出表。
///
/// 修复前，出表只发生在 `transcode_pump` 里的 `finish()` 闭包中；于是存在两条
/// 「条目进了表、却永无 pump 为它 `finish`」的窗口：
///
/// 1. **spawn 前取消**（BUG-288 取证补充二「路径 A」）：`insert` 之后、
///    `tokio::spawn(pump)` 之前还有 `.part` metadata / `serve_local_file` /
///    `ffmpeg_config()` 三个 await，客户端断开 ⇒ hyper 丢弃 handler future ⇒
///    条目永久残留（实测：≈0.01 s 恒 503、ffmpeg 进程数 0，只能重启进程才解）。
/// 2. **pump 自身异常终止**：future 被 drop 或 panic ⇒ `finish` 永不执行。
///
/// 本守卫把「出表」上移为**作用域语义**：它在 `insert` 的**同一处**诞生，之后
/// 任何出口（正常 spawn、Range 早退、handler 被取消、panic）都必然出表。
/// 所有权随后随 pump future 一起 move，于是上述两条窗口一并兜住。
struct TranscodeSlot {
    key: TranscodeKey,
    /// 尚未出表。`finish()` 走正常收尾时置 `false`，`Drop` 便不再重复 remove。
    armed: bool,
}

impl TranscodeSlot {
    fn new(key: TranscodeKey) -> Self {
        Self { key, armed: true }
    }

    /// 显式出表（正常收尾）：之后 `Drop` 不再动表。幂等。
    fn disarm(&mut self) {
        if self.armed {
            self.armed = false;
            Self::remove(&self.key);
        }
    }

    fn remove(key: &TranscodeKey) {
        // 持锁区内只有 `HashMap::remove`——无 await、无 IO、不 panic（BUG-288
        // 取证补充二「结论 1」）。这里用 `if let Ok` 而非 `expect`：万一别处真把
        // 互斥锁毒化，宁可不出表，也不要让每个 handler / 每次收尾都 panic
        // （毒化后全站 500 远比一次泄漏严重）。
        if let Ok(mut m) = transcode_inflight().lock() {
            m.remove(key);
        }
    }
}

impl Drop for TranscodeSlot {
    fn drop(&mut self) {
        if self.armed {
            self.armed = false;
            Self::remove(&self.key);
        }
    }
}

/// 单飞角色：抢到坑 = 冷启动（带出表守卫）；没抢到 = 挂在 watch 上等。
enum Role {
    /// `(发送端, 出表守卫)`。守卫为 `None` ⇒ 锚点 live-only 流（BUG-226：没占过坑，
    /// 绝不能把可能属于别人的同键条目顶掉）。
    Start(tokio::sync::watch::Sender<bool>, Option<TranscodeSlot>),
    Wait(TranscodeDone),
}

/// 单飞占坑（BUG-288）。
///
/// 抢到 ⇒ `Role::Start`，且**守卫与 insert 同一处诞生**，故「insert 之后、spawn
/// 之前」这段窗口的任何出口都会出表；没抢到 ⇒ `Role::Wait`。
fn acquire_transcode_role(key: TranscodeKey) -> Role {
    // BUG-293/L1：**毒化不得 panic**。原为 `.expect("transcode map poisoned")`，而
    // `std::sync::Mutex` 在持锁线程 panic 后永久毒化 ⇒ 此后**每一次** `/stream` 请求
    // 都在这里 panic（全站播放永久失败，只能重启）。与本文件 `TITLE_BACKFILL_ATTEMPTS`
    // 同策略：取回内部值继续用，不让一次 panic 变成全局不可用。
    let mut m = transcode_inflight().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(rx) = m.get(&key) {
        return Role::Wait(rx.clone());
    }
    let (tx, rx) = tokio::sync::watch::channel(false);
    m.insert(key, rx);
    Role::Start(tx, Some(TranscodeSlot::new(key)))
}

/// 孤儿键接管（BUG-288）：**覆盖**已有条目并重新占坑。
///
/// 与 `acquire_transcode_role` 的差别是允许覆盖——被覆盖的那个条目已经被判定为
/// 孤儿（watch 发送端已死、代理未产出），若只 remove 不 insert，该键会在「无人
/// 认领」的状态下被后续请求再次撞上；必须**当场重新占坑**才能既恢复该变体、
/// 又保持单飞（后续请求仍走 `Wait`，不会各起一条 ffmpeg）。
fn reclaim_transcode_slot(
    key: TranscodeKey,
) -> (tokio::sync::watch::Sender<bool>, Option<TranscodeSlot>) {
    let (tx, rx) = tokio::sync::watch::channel(false);
    if let Ok(mut m) = transcode_inflight().lock() {
        m.insert(key, rx);
    }
    (tx, Some(TranscodeSlot::new(key)))
}

/// 挂在 watch 上等一次在途转码（BUG-288）。
///
/// 返回 `(proxy_ready, orphan)`：
/// - `proxy_ready`：`final_p` 已落盘 ⇒ 调用方直接 serve 代理；
/// - `orphan`：代理**未**落盘**且** watch 发送端已关闭 ⇒ 表里的这个键已经没有
///   任何 pump 会为它 `finish`（即路径 A 的孤儿条目）。调用方据此回收该键并
///   重新起转码，而不是把该变体永久钉死在 503。
///
/// 修复前这里只判「有没有文件」：无文件即 503，且从不删条目 ⇒ 孤儿键既出不去、
/// 也没人能再 Start，只能重启进程。
async fn wait_for_transcode(rx: &mut TranscodeDone, final_p: &std::path::Path) -> (bool, bool) {
    let sender_gone = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = sender_gone.clone();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(600), async {
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                // 发送端已关闭：pump 从未启动 / 已被 drop / 已 panic。
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                break;
            }
        }
    })
    .await;
    let ready = tokio::fs::metadata(final_p).await.is_ok();
    (
        ready,
        !ready && sender_gone.load(std::sync::atomic::Ordering::SeqCst),
    )
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

/// H.264 编码档位（BUG: 高倍速实时转码 veryfast 跟不上 → 直播流被播放器反超而卡死）。
/// ≥3x 退让画质保“跟得上实时”：ultrafast + 更高 crf + 更低 fps。
///
/// **BUG-289 修正（2026-10-13，实测）**：`fps` **不得取 24**。
/// 24 fps 在 60 Hz 显示上不是整数倍刷新（60/24=2.5）⇒ 每帧交替占 2 或 3 个刷新周期
/// （3:2 pulldown）⇒ **规则性顿挫**。实测 4x 冷直播：`presented=24fps`、
/// 帧间隔 p50 = **49.8 ms**（=3 刷新）、`gt50 = 168` —— 即约 1/3 的帧多占一个刷新周期，
/// 肉眼就是「一顿一顿」。改为 **30**（60 与 120 的公约数 ⇒ 每帧恰好 2/4 个刷新周期）后
/// 帧间隔应回到 ~33.3 ms 且 `gt50`≈0。
///
/// **为何降 fps 并不换来性能**：输出时间轴被 `setpts/速度` 压缩，总输出帧数 =
/// `时长/速度 × fps`。4x@30fps 的总帧数只有 1x@30fps 的 1/4 ⇒ 高倍速的**编码负载更低**
/// （解码帧数不随速度变），故「≥3x 降 fps 保实时」的前提不成立；24 fps 纯属白白引入抖动。
#[derive(Clone, Copy)]
struct EncodeProfile {
    preset: &'static str,
    crf: u8,
    fps: u16,
}

fn encode_profile(speed_hundredths: u16) -> EncodeProfile {
    if speed_hundredths >= 300 {
        // BUG-289：30（而非 24）—— 60 Hz/120 Hz 的公约数，避免 3:2 pulldown 抖动。
        EncodeProfile { preset: "ultrafast", crf: 28, fps: 30 }
    } else {
        EncodeProfile { preset: "veryfast", crf: 23, fps: 30 }
    }
}

/// 无倍速（兼容代理，BUG-208）所用档位。
///
/// 必须与 pump 中 `speed_hundredths = None` 时的历史默认值**逐字一致**
/// （`veryfast` / `crf 23` / `fpsmax 30`）——抽成常量是为了让「文件名里写的指纹」
/// 与「pump 真正下给 ffmpeg 的参数」同源，不再两处各写一份魔数。
const COMPAT_ENCODE_PROFILE: EncodeProfile = EncodeProfile {
    preset: "veryfast",
    crf: 23,
    fps: 30,
};

fn encode_profile_for(speed_hundredths: Option<u16>) -> EncodeProfile {
    speed_hundredths
        .map(encode_profile)
        .unwrap_or(COMPAT_ENCODE_PROFILE)
}

/// 编码档位指纹（BUG-291）。
///
/// 把档位的实质参数（`preset` / `crf` / `fps`）折叠成一个**确定性**、文件系统安全
/// 的短标记。必须确定性：不得用 `DefaultHasher` 之类运行期不稳定的哈希，否则同一
/// 档位两次请求会算出不同名字 ⇒ 每次都重转，「秒开」就没了。
fn encode_profile_fingerprint(p: EncodeProfile) -> String {
    format!("{}-crf{}-{}fps", p.preset, p.crf, p.fps)
}

/// 代理变体文件名（BUG-291）：**带档位指纹**。
///
/// 旧命名只有 `(item_id, speed)`，改了 `encode_profile` 之后文件名不变 ⇒
/// 命中判据（`metadata(final_p)` 只判存在）会永久沿用旧档位产出的陈旧代理
/// （BUG-289 实测某 4x 代理仍是旧档 30 fps）。把指纹折进名字后，档位一改 ⇒
/// 名字变 ⇒ 旧代理自然失效、不可能再被命中。
///
/// `speed_hundredths = None`（兼容代理）同样带指纹：它的档位由
/// `COMPAT_ENCODE_PROFILE` 定义，改了也应失效重建。
fn proxy_variant_for(id: i64, speed_hundredths: Option<u16>, profile: EncodeProfile) -> String {
    let fp = encode_profile_fingerprint(profile);
    match speed_hundredths {
        Some(speed) => format!("{id}-speed-{speed}-{fp}.mp4"),
        None => format!("{id}-{fp}.mp4"),
    }
}

/// 当前档位下的代理变体文件名（BUG-291）。
fn proxy_variant(id: i64, speed_hundredths: Option<u16>) -> String {
    proxy_variant_for(id, speed_hundredths, encode_profile_for(speed_hundredths))
}

fn speed_video_filter(speed_hundredths: u16, fps: u16) -> String {
    format!("setpts=(PTS-STARTPTS)/{:.2},fps={}", speed_value(speed_hundredths), fps)
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

/// §2.5.7：ffmpeg 能力配置（硬件加速解码）进程级缓存。
///
/// 仅探测一次；探测失败 / 被 `ORIG_TG_HWACCEL=off` 禁用时一律回落软件解码——
/// 软件解码下 `FfmpegConfig::input_args()` 返回空 `Vec`，命令行逐字等价于现状
/// （不加任何 `-hwaccel`）。默认 `auto` = 按探测结果启用硬件解码（HEVC 等硬解
/// 走 GPU，规避纯软件解码的实时性瓶颈）。
static FFMPEG_CONFIG: tokio::sync::OnceCell<FfmpegConfig> = tokio::sync::OnceCell::const_new();

/// 解析当前 ffmpeg 的能力配置（带缓存 + 软件兜底）。
async fn ffmpeg_config(ffmpeg: &std::path::Path) -> FfmpegConfig {
    if std::env::var("ORIG_TG_HWACCEL").as_deref() == Ok("off") {
        return FfmpegConfig::software();
    }
    FFMPEG_CONFIG
        .get_or_init(|| async {
            let probe = probe_ffmpeg(ffmpeg).await;
            if !probe.ok() {
                tracing::warn!(
                    target: "orig_tg::transcode",
                    "ffmpeg caps probe failed ({:?}); falling back to software decode",
                    probe.errors
                );
                return FfmpegConfig::software();
            }
            let gpus = probe_gpus().await;
            let cfg = probe_config(&probe, &gpus);
            tracing::info!(
                target: "orig_tg::transcode",
                "ffmpeg config resolved: {}",
                describe(&cfg)
            );
            cfg
        })
        .await
        .clone()
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
///   1. **代理命中**（`<id>-<档位指纹>.mp4` 或 `<id>-speed-<百分之一倍速>-<档位指纹>.mp4`
///      已存在）→ 直接
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
    // 与 /raw 相同的路径闸门（cache::resolve_managed_path：绝对原样 / 相对 join
    // 库根，且**必须落在下载路径之内**，BUG-323）。
    let src = match item.file_path.clone() {
        Some(p) => {
            let lib_root = st.store.library_root().await;
            let download_root = st.store.download_root().await;
            crate::cache::resolve_managed_path(&download_root, &lib_root, &p).ok_or_else(|| {
                ApiError::new(
                    StatusCode::FORBIDDEN,
                    "media file path is outside the managed download root (BUG-323)",
                )
            })?
        }
        None => return Err(ApiError::new(StatusCode::NOT_FOUND, "item has no local file")),
    };
    if tokio::fs::metadata(&src).await.is_err() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "source file missing"));
    }
    // BUG-323：代理目录 = `<下载路径>/.orighub/proxies`（派生，随下载路径走），
    // 首次使用时就地创建（旧位置曾由启动流程预建，搬迁后不再有那一步）。
    let proxy_dir = st.store.proxy_dir().await;
    if let Err(e) = tokio::fs::create_dir_all(&proxy_dir).await {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("create proxy dir {}: {e}", proxy_dir.display()),
        ));
    }
    let key = TranscodeKey { item_id: id, speed_hundredths };
    // BUG-291：变体名带编码档位指纹，档位变更 ⇒ 旧代理不再可能被命中。
    let variant = proxy_variant(id, speed_hundredths);
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
        // 命中即「最近使用」：刷新 mtime，使 LRU 预算（enforce_proxy_budget）
        // 优先淘汰久未播放的代理，而非正在看 / 刚看过的。
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .open(&final_p)
            .and_then(|f| f.set_modified(std::time::SystemTime::now()));
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
    // BUG-278：探测落点必须是**真实数据目录本体**（`data_dir()`），而非派生的
    // `proxy_dir`（`<数据目录>/proxies`）——否则 `<数据目录>/bin` 这一受支持落点会
    // 退化成 `<数据目录>/proxies/bin`（恒空）。
    let ffmpeg = resolve_ffmpeg_path(&st.store.data_dir()).ok_or_else(|| {
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
    let registered = start_secs.is_none();
    let role = if !registered {
        let (tx, _rx) = tokio::sync::watch::channel(false);
        Role::Start(tx, None)
    } else {
        acquire_transcode_role(key)
    };

    // BUG-288：**先**做孤儿自愈判定。`Role::Wait` 要么直接返回响应 / 503，要么把
    // 「无 pump 认领的孤儿条目」降级为冷启动（重新占坑）⇒ 此后恒为 Start。
    let (tx, slot) = match role {
        Role::Wait(mut rx) => {
            let (ready, orphan) = wait_for_transcode(&mut rx, &final_p).await;
            if ready {
                // 命中即「最近使用」：与上面的代理命中分支同一套 LRU 语义。
                let _ = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&final_p)
                    .and_then(|f| f.set_modified(std::time::SystemTime::now()));
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
            if !orphan {
                // 真·在途（pump 还活着）：保留既有语义——请客户端稍后重试。
                // 修复前**孤儿也走这条**，且条目永不出表 ⇒ 该变体被永久钉死在 503。
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "transcode in flight but proxy not ready; retry later",
                ));
            }
            // 孤儿条目：表里有键、却没有任何 pump 会为它 `finish`
            // （BUG-288 取证补充二「路径 A」：handler 在 insert 之后、spawn 之前被
            // 取消）。出表 + **当场重新占坑** ⇒ 该变体立刻可恢复，且后续请求仍走
            // Wait（单飞不破，不会各起一条 ffmpeg）。
            tracing::warn!(
                target: "orig_tg::transcode",
                "item {}: orphaned transcode slot (no live pump); reclaiming and restarting",
                id
            );
            reclaim_transcode_slot(key)
        }
        Role::Start(tx, slot) => (tx, slot),
    };

    {
        // B：可寻址化——若客户端带 Range 且同键转码的 `.part` 已落盘足够字节，
        // 直接从增长中的 `.part` 回 206（serve_local_file 按当前实际长度给 Content-Range），
        // 浏览器缺多少再要多少。这样 4x 暂停后再播不必等整片转完、也不必重新起直播流。
        //
        // BUG-288：这条分支只发响应、**不会** spawn pump，所以修复前它会留下一个
        // 无 pump 认领的孤儿条目（与「路径 A」同源的变体）。现在守卫 `slot` 随
        // `return` 一起 drop ⇒ 出表，不会污染单飞表。
        if registered {
            if let Some(rstr) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
                if let Some(start) = range_start_only(rstr) {
                    if let Ok(meta) = tokio::fs::metadata(&part_p).await {
                        if meta.len() > start {
                            let mut res = serve_local_file(
                                part_p.to_string_lossy().as_ref(),
                                Some("video"),
                                None,
                                &headers,
                            )
                            .await?;
                            res.headers_mut().insert(
                                "x-orig-stream",
                                stream_mode_header(speed_hundredths, "part"),
                            );
                            return Ok(res);
                        }
                    }
                }
            }
        }
        let (resp_tx, resp_rx) =
            tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(32);
        let cfg = ffmpeg_config(&ffmpeg).await;
        // BUG-288：守卫的所有权**随 pump future 一起 move** ⇒ pump 被 drop / panic
        // 也必然出表（原先只有 pump 走到 `finish()` 才出表）。
        tokio::spawn(transcode_pump(
            ffmpeg,
            src,
            part_p,
            final_p,
            key,
            speed_hundredths,
            start_secs,
            slot,
            tx,
            resp_tx,
            cfg,
        ));
        let body = axum::body::Body::from_stream(ReceiverStream::new(resp_rx));
        let mut res = Response::new(body);
        res.headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
        // 仅可缓存路径（registered）声明可 Range：完成代理与增长中 `.part` 都能 206 服务；
        // 锚点 live-only 流不落盘、不可 Range。
        if registered {
            res.headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        }
        res.headers_mut()
            .insert("x-orig-stream", stream_mode_header(speed_hundredths, "live"));
        Ok(res)
    }
}

/// 兼容流转码泵（BUG-208）：ffmpeg stdout →（响应通道 + `.part` 落盘）双写。
///
/// 成功（exit 0 且客户端未中途断开）→ `.part` 原子改名成正式代理；
/// 客户端断开 / 转码失败 → 清 `.part` 不留垃圾。出口统一：出表 + 唤醒等待者。
///
/// BUG-226：`start_secs = Some(t)` 时是**锚点 live-only 流**——`-ss t` 从指定
/// 内容位置起转，字节流与正式代理（从 0:00 起）不是同一份字节，因此**不落盘、
/// 不改名、不进单飞表**（`slot = None`，finish 不得出别人的坑），客户端
/// 断开即杀 ffmpeg。
///
/// BUG-288：`slot` 是单飞表的**出表守卫**，所有权随本 future 一起 move：
/// panic / 任务被 drop 时 `Drop` 也会出表，不再依赖「必须走到 `finish()`」。
#[allow(clippy::too_many_arguments)]
async fn transcode_pump(
    ffmpeg: PathBuf,
    src: PathBuf,
    part_p: PathBuf,
    final_p: PathBuf,
    key: TranscodeKey,
    speed_hundredths: Option<u16>,
    start_secs: Option<f64>,
    mut slot: Option<TranscodeSlot>,
    done_tx: tokio::sync::watch::Sender<bool>,
    resp_tx: tokio::sync::mpsc::Sender<Result<axum::body::Bytes, std::io::Error>>,
    cfg: FfmpegConfig,
) {
    let id = key.item_id;
    let persist = start_secs.is_none();
    let mut finish = |completed: bool| {
        // BUG-288：出表交给守卫（`disarm` = 显式出表，之后 `Drop` 不再重复 remove）。
        // 守卫为 `None` ⇒ 锚点流没占过坑，绝不能把（可能属于别人的）同键条目顶掉。
        if let Some(slot) = slot.as_mut() {
            slot.disarm();
        }
        // 唤醒等待者（drop done_tx 兜底：panic 路径也会关闭 watch）。
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
    // §2.5.7：输入侧硬件加速参数（软件解码时为空 `Vec`，逐字兼容现状）。
    // 必须放在 `-i` **之前**，否则 ffmpeg 拒绝。
    command.args(cfg.input_args());
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
    // BUG-291：档位只在一处定义（`encode_profile_for`），代理文件名与下给 ffmpeg
    // 的 `-preset/-crf/-fpsmax` 同源，杜绝「文件名说一套、编码做一套」。
    let profile = encode_profile_for(speed_hundredths);
    let preset = profile.preset;
    let crf = profile.crf.to_string();
    let fpsmax = profile.fps.to_string();
    if let Some(speed) = speed_hundredths {
        // Retimestamp then sample CFR N fps; supports fractional speed, VFR and any source fps.
        //
        // BUG-223：**不传 `-r`**。`fps=N` 滤镜已把输出重采样为 CFR N，
        // 而下面无条件带的 `-fpsmax N` 与 `-r` 在同一条流上互斥
        // （ffmpeg: "Only one of -fpsmax and -r can be set for a stream."），
        // 两者同时出现会让 ffmpeg **拒绝打开输出文件** → 整条 FRC 流 0 字节，
        // 浏览器端表现为「切了倍速就再也出不了画面」。高倍速（≥3x）改用更低 fps
        // （见 `encode_profile`）以换取实时余量。
        let fps = profile.fps;
        command
            .arg("-vf")
            .arg(speed_video_filter(speed, fps))
            .arg("-af")
            .arg(atempo_filter(speed));
    }
    command.args([
        // H.264：全平台硬解兼容目标。
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        crf.as_str(),
        "-pix_fmt",
        "yuv420p",
        // 兼容代理与 FRC 变体均限制输出视频最高 fps（与滤镜 fps 对齐）。
        "-fpsmax",
        fpsmax.as_str(),
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
    // C：单飞防饿死（**BUG-293 修正**）。原实现把「无进展」判定挂在**循环顶部**，而循环体
    // 会阻塞在 `stdout.read()` / `resp_tx.send()` 里 ⇒ 守卫**永远轮不到执行**：实测客户端停读后
    // ffmpeg 被反压顶到 **0% CPU**、`.part` 冻结 50 s 仍未触发（阈值 30 s），该 `(item, speed)`
    // 变体从此**永久卡死**，后续请求挂到 `wait_for_transcode` 的 600 s 才 503。
    // 现改为给**两处阻塞点各自加时限**，使「整轮无进展」必被检出：
    //   · `stdout.read` 超时 ⇒ ffmpeg 僵死（被反压顶住）⇒ 杀进程 + 清 `.part` + 出坑。
    //     不再依赖 `ever_read`：**从未产出任何字节**的僵死同样要清。
    //   · `resp_tx.send` 超时 ⇒ 客户端不再消费（停读 / 暂停）⇒ 判 `client_gone`：
    //     FRC 变体**继续**把 `.part` 写完落盘（保住可 seek 的代理），live-only（1x / 锚点）收尾。
    let stall_limit = std::time::Duration::from_secs(30);
    loop {
        let read = match tokio::time::timeout(stall_limit, stdout.read(&mut buf)).await {
            Ok(r) => r,
            Err(_) => {
                tracing::warn!(target: "orig_tg::transcode", "item {id}: no ffmpeg output for {:.1}s; aborting wedged transcode", stall_limit.as_secs_f32());
                let _ = child.kill().await;
                let _ = child.wait().await;
                if persist {
                    let _ = tokio::fs::remove_file(&part_p).await;
                }
                finish(false);
                return;
            }
        };
        match read {
            Ok(0) => break,
            Ok(n) => {
                use tokio::io::AsyncWriteExt;
                if let Some(file) = file.as_mut() {
                    if file.write_all(&buf[..n]).await.is_err() {
                        // 落盘失败不影响直播给客户端（例如磁盘满时至少本次能看完）
                        tracing::warn!(target: "orig_tg::transcode", "item {id}: write .part failed; proxy will be skipped");
                    }
                }
                if !client_gone {
                    // BUG-293：投递也必须有界 —— 客户端停读时不得让泵永久阻塞
                    // （否则泵停 ⇒ 不再排空 ffmpeg stdout ⇒ ffmpeg 被反压顶死）。
                    let sent = tokio::time::timeout(
                        stall_limit,
                        resp_tx.send(Ok(axum::body::Bytes::copy_from_slice(&buf[..n]))),
                    )
                    .await;
                    if !matches!(sent, Ok(Ok(()))) {
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
                    // 落盘后立刻清算代理缓存磁盘预算（在 blocking 线程跑，不拖慢收尾）。
                    if let Some(dir) = final_p.parent().map(|p| p.to_path_buf()) {
                        let _ = tokio::task::spawn_blocking(move || enforce_proxy_budget(&dir, id)).await;
                    }
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

/// 代理缓存磁盘预算（LRU 淘汰）。
///
/// 每次转码完成、正式代理改名落盘后调用一次：扫描 `proxy_dir` 下所有已完成
/// `*.mp4`，若总占用超 `ORIG_TG_PROXY_MAX_BYTES`（默认 2 GiB），按**文件修改时间
/// 升序**（最旧先淘汰）删除代理，直到降到阈值的 90%（留余量，避免下一次完成又
/// 立刻触发）。
///
/// 不碰 `*.part`（在途转码尚未完成，删了会打断正在生成的代理）；被 serve 命中的
/// 代理已在读取前 `set_modified` 刷新 mtime，故「正在看 / 刚看过」的代理不会优先
/// 被淘汰。这是重播缓存（开播即落盘整部代理）的代价回收器。
fn enforce_proxy_budget(proxy_dir: &std::path::Path, id: i64) {
    let max = std::env::var("ORIG_TG_PROXY_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(2 * 1024 * 1024 * 1024);
    let mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    let read = match std::fs::read_dir(proxy_dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in read.flatten() {
        let p = ent.path();
        // 只清算正式代理 `*.mp4`；跳过 `.part`（在途转码）与无扩展名文件。
        if p.extension().and_then(|e| e.to_str()) != Some("mp4") {
            continue;
        }
        if let Ok(meta) = ent.metadata() {
            let sz = meta.len();
            total = total.saturating_add(sz);
            let mt = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            files.push((p, sz, mt));
        }
    }
    if total <= max {
        return;
    }
    // 最旧（修改时间最早）在前优先淘汰。
    files.sort_by_key(|a| a.2);
    let target = max * 9 / 10;
    let mut freed: u64 = 0;
    for (p, sz, _) in files {
        if total.saturating_sub(freed) <= target {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            tracing::info!(target: "orig_tg::proxy", "item {id}: evicted proxy {} ({} bytes) to stay under budget", p.display(), sz);
            freed = freed.saturating_add(sz);
        }
    }
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
    // BUG-307 临时修复：剧集墙只显示「真实群集」，隐藏 D18 自动「单视频=S1E1」便利序列。
    //
    // 标记：`source_key LIKE 'item:%'`（D18 在 `media.rs` 为每个本地 item 自动建序列时写入）。
    // 这些是数据层便利记录，**不是**用户/插件建立的群集，混在剧集墙里让用户误以为
    // 「非 TG 数据进了剧集」（用户 2026-10-14 截图证据：`scene_*`/`portrait_*`/
    // `banner_*`/`sample_*`/`movie` 全是 `D:\test_videos\...` 下的本地文件，被建成了
    // 160 个 D18 自动序列）。
    //
    // 为什么不在 `list_series_filtered` 的 SQL WHERE 里过滤：那个函数同时被
    // `get_series(id)`（按 id 查单条，`media.rs:2085`）复用，SQL 过滤会顺带让 D18
    // 自动序列的详情页打不开。Post-filter 只影响剧集**列表**端点。
    //
    // 正确做法是给 `media_series` 加 `is_auto_series` 布尔列 + 迁移（性能好、逻辑清晰），
    // 但用户明确「当前先进行简单的错误修复,整体需要重新架构设计」，架构重设计时再换。
    let list: Vec<_> = list
        .into_iter()
        .filter(|s| s.source_key.as_deref().map_or(true, |k| !k.starts_with("item:")))
        .collect();
    Ok(Json(json!({"items": list})))
}

/// 新建剧集请求体。
#[derive(Deserialize)]
struct CreateSeriesReq {
    title: String,
    description: Option<String>,
    /// 类型；缺省 = `series`。枚举外的值一律 422（BUG-258：脏类型不得进列）。
    kind: Option<String>,
    year: Option<i64>,
}

/// `POST /api/media/series`
async fn create_media_series(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CreateSeriesReq>,
) -> Result<impl IntoResponse, ApiError> {
    // 类型枚举在**路由层**就 422，而不是等 store 报错后回 500：调用方（前端表单、
    // 脚本）需要知道「这个值非法」，而不是「服务端炸了」。store 侧另有一道
    // 断言（`create_series` 校验 `is_valid_series_kind`），拦住绕过路由的写路径。
    let kind = body.kind.as_deref().unwrap_or("series");
    if !is_valid_series_kind(kind) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("invalid series kind {kind:?}: expected one of {SERIES_KINDS:?}"),
        ));
    }
    let id = st
        .store
        .create_series(
            &body.title,
            body.description.as_deref(),
            kind,
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
///
/// BUG-258：类型枚举在路由层 422。`kind` 曾是「任何字符串都照收」的字段，
/// 而前端 `kindLabel()` 会把未知值原样透出 —— 于是 `PATCH {"kind":"garbage"}`
/// 能把一个界面无法解释的徽标写进列。**非法状态必须不可表达**。
async fn patch_media_series(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<SeriesPatch>,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(kind) = body.kind.as_deref() {
        if !is_valid_series_kind(kind) {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                &format!("invalid series kind {kind:?}: expected one of {SERIES_KINDS:?}"),
            ));
        }
    }
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
    /// BUG-129：**显式**覆盖意图。缺省即「不覆盖」。
    ///
    /// 这个端点是**按槽位写入**（`episodeNo` 缺省 1 = S1E1），而底层
    /// `add_episode` 带 `ON CONFLICT ... DO UPDATE` —— 槽位被占时它会**静默顶掉**
    /// 原条目：不报错、不提示，被顶掉者的去向从返回值里看不出来（实测 `389` 顶掉 `390`）。
    /// 于是「覆盖」这个**破坏性**动作必须由调用方显式表达：没说不覆盖，就不许覆盖。
    overwrite: Option<bool>,
}

/// `POST /api/media/series/:id/episodes`
///
/// BUG-129：按槽位写入，**槽位已被占用且未传 `overwrite: true` 时返回 409**，
/// 并在错误信息里告知占用者（`itemId`）—— 由调用方决定是换槽、换条目，还是显式覆盖。
/// 此前是直接覆盖，用户只会发现「我的一集不见了」，且无从归因。
async fn add_media_episode(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<EpisodeReq>,
) -> Result<impl IntoResponse, ApiError> {
    // 剧集分集只能是视频（BUG-044：图片是浏览点，不参与编集；触发器是硬门，
    // 这里给可读的 422）。图片请走「挂图」（`media_episode_image`）。
    let kinds = st
        .store
        .item_kinds(std::slice::from_ref(&body.item_id))
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if kinds
        .get(&body.item_id)
        .map(|k| k != "video")
        .unwrap_or(true)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "only video items can be episodes",
        ));
    }
    let season = body.season.unwrap_or(1);
    let episode_no = body.episode_no.unwrap_or(1);
    // BUG-129：写之前先问槽位。**必须查在写之前** —— 若先写后判，「原条目仍在」
    // 就不成立了（BUG-129 判据 2 专门盯这条：「先删后报错」也能骗过只断言 409 的测试）。
    let occupant = st
        .store
        .episode_slot_occupant(id, season, episode_no)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if let Some(occ) = occupant {
        // 「指向的就是同一条目」不算冲突：那是无副作用的幂等重放（调用方重试同一次请求），
        // 报 409 反而会逼调用方去开 `overwrite` —— 而那正是本条要拦的危险动作。
        if !body.overwrite.unwrap_or(false) && occ.item_id != body.item_id {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                &format!(
                    "S{season}E{episode_no} is already occupied by item {}; \
                     pass \"overwrite\": true to replace it, or choose another episodeNo",
                    occ.item_id
                ),
            ));
        }
    }
    let eid = st
        .store
        .add_episode(id, body.item_id, season, episode_no)
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
    // 剧集分集只能是视频（BUG-044）。混入的图片等不合法条目显式 422（附明细），不静默过滤。
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
                .map(|k| k != "video")
                .unwrap_or(true)
        })
        .copied()
        .collect();
    if !rejected.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("only video items can be episodes, rejected: {rejected:?}"),
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

/// `GET /api/media/series/:id/manifest` — 剧集级组清单（D22-A② / BUG-296）。
///
/// 剧集详情的「缺集灰条」与「已登记未编入」列表都由它派生：序号全集 = 覆盖该剧已认领
/// 消息的缓存任务 `items` 的并集；`gap` = 未编入数 − 挂图数（**先减图片**，图集是设计）。
/// 剧集不存在 → 404（与 `GET /api/media/series/:id` 同一语义）。
async fn get_series_manifest(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let ok = st
        .store
        .series_exists(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "series not found"));
    }
    let m = st
        .store
        .series_group_manifest(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    Ok(Json(json!(m)))
}

/// `POST /api/media/series/:id/split` 的请求体（D22-A⑥ 人工拆剧）。
#[derive(Debug, Deserialize)]
struct SplitSeriesReq {
    /// 要拆出的条目 id（`media_item.id`）。空 ⇒ 400。
    #[serde(rename = "itemIds", default)]
    item_ids: Vec<i64>,
    /// 新剧集标题；缺省 = `原剧名 · 拆分`。
    #[serde(default)]
    title: Option<String>,
}

/// `POST /api/media/series/:id/split` — 人工**拆剧**（D22-A⑥）。
///
/// 把给定条目移入一个**新建的手工剧集**（`source_key = NULL`），源剧集保留其余分集，
/// 并对搬走的条目在源剧集记「已摘除」墓碑（自动路径不得再编回，BUG-126）。
/// 语义与理由见 [`crate::media::Store::split_series`]。
async fn split_media_series(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<SplitSeriesReq>,
) -> Result<impl IntoResponse, ApiError> {
    if body.item_ids.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "itemIds must not be empty",
        ));
    }
    // 去重（保序）：重复 id 只搬一次。
    let mut item_ids = body.item_ids.clone();
    {
        let mut seen = std::collections::HashSet::new();
        item_ids.retain(|i| seen.insert(*i));
    }
    let rep = st
        .store
        .split_series(id, &item_ids, body.title.as_deref())
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    match rep {
        Some(rep) => {
            st.push_log(&format!(
                "/api/media/series/{id}/split: 拆出 {} 集到新剧集 {}",
                rep.moved, rep.new_series_id
            ));
            Ok(Json(json!(rep)))
        }
        // 源剧集不存在 / 给定条目一个都不在源里：两者都是 no-op，语义上等价于 404。
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "series not found or none of itemIds belong to it",
        )),
    }
}

/// `POST /api/media/series/:id/recache-gap` — **按组清单真缺口**补缓存（D22-A② / BUG-296）。
///
/// 与 BUG-261 的 `recache-missing` 的分工：后者只收**已存在但无字节**的分集（从分集自身
/// 的来源 ref 出发）；本端点收**组清单里未编入的序号**（含「连条目都没有」的 `missing`
/// 与「已登记未编入」的 `registered_unslotted`）—— 它们的共同点是**在媒体库里没有分集**，
/// 只有 `(chat, msg)` 坐标，故必须从组清单反推。
///
/// **挂图必须排除**：图片按 BUG-049 不落盘、作为集级挂图存在（组清单里落
/// `registered_unslotted`），它们不是缺口。按 `gap` 的口径（未编入 − 挂图）入队。
///
/// 入队复用 `Store::enqueue_cache_task`，组键 `g:` 前缀（gap），与 `b:`（batch 补缺）、
/// `m:`（单条）、`g:`（相册）的键空间一致 —— 同批次重复点击命中活跃任务即复用（幂等）。
async fn recache_series_gap(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    let ok = st
        .store
        .series_exists(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !ok {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "series not found"));
    }
    let m = st
        .store
        .series_group_manifest(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let image_msgs: std::collections::HashSet<i64> = st
        .store
        .series_image_msg_ids(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .into_iter()
        .collect();

    // 真缺口 = 未编入（非 slotted）且**不是挂图**的序号。
    let mut by_chat: std::collections::BTreeMap<i64, Vec<i64>> = std::collections::BTreeMap::new();
    for e in &m.entries {
        if e.state == "slotted" || image_msgs.contains(&e.message_id) {
            continue;
        }
        by_chat.entry(m.chat_id).or_default().push(e.message_id);
    }

    let dir = effective_download_dir(&st).await;
    let mut enqueued = 0usize;
    let mut groups = 0usize;
    for (chat_id, mut message_ids) in by_chat {
        message_ids.sort_unstable();
        message_ids.dedup();
        let first = message_ids[0];
        // 组键用 `g:` 前缀（gap）：与 `b:`（batch）/ `m:`（单条）互不相交。
        let item_key = format!("g:{}:{}", chat_id, first);
        let Some((task, created)) = st
            .store
            .enqueue_cache_task(chat_id, None, &item_key, &message_ids, &dir)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        else {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "enqueue cache task failed",
            ));
        };
        enqueued += message_ids.len();
        groups += 1;
        st.refresh_cache_tasks().await;
        if created {
            {
                let st_bg = st.clone();
                tokio::spawn(async move {
                    register_enqueued_items(&st_bg, chat_id, &message_ids).await;
                });
            }
            spawn_cache_task(st.clone(), task.id);
        }
    }
    if groups > 0 {
        st.push_log(&format!(
            "/api/media/series/{id}/recache-gap: 入队 {enqueued} 条（{groups} 组）"
        ));
    }
    Ok(Json(json!({ "enqueued": enqueued, "groups": groups })))
}

// ---- BUG-261：剧集级「补缺」（缓存与来源绑定） ----

/// 缺失集没有任何可缓存来源时的 skip 原因（固定英文短串；界面原样透出，不翻译）。
const NO_RECACHEABLE_REF_REASON: &str = "no recacheable source ref (tg ref missing)";

/// 解析 TG ref `"chat:msg"` 为 `(chat_id, message_id)` 坐标。
///
/// ref 是**内部标识**（`import_media_items` 的 `"<chat_id>:<message_id>"`）；
/// 非 `数字:数字` 形态（老数据 / 脏数据）返回 None —— 调用方按「不可缓存」跳过，
/// 绝不让一个坏 ref 阻断整批入队。
fn parse_tg_ref_coords(ref_key: &str) -> Option<(i64, i64)> {
    let (chat, msg) = ref_key.trim().rsplit_once(':')?;
    let chat_id = chat.trim().parse::<i64>().ok()?;
    let message_id = msg.trim().parse::<i64>().ok()?;
    Some((chat_id, message_id))
}

/// 分集的「可缓存来源」ref：主源 tg 且 ref 非空优先，其次任一 tg 备用源。
///
/// 与 `EpisodeView::has_recacheable_source` 的判据**同一口径**（不含 has_bytes）——
/// 「缓存逻辑与来源绑定」意味着判据对象是**这一集的可用来源集合**，
/// 而不是当前主源（主源 local + 备用源 tg 的集同样可缓存，BUG-261 现象 3）。
fn episode_recache_ref(ep: &crate::media::EpisodeView) -> Option<&str> {
    if ep.source.as_deref() == Some("tg") {
        if let Some(r) = ep.ref_key.as_deref().filter(|s| !s.trim().is_empty()) {
            return Some(r);
        }
    }
    ep.sources
        .iter()
        .find(|s| {
            s.source.as_deref() == Some("tg")
                && s.ref_key.as_deref().is_some_and(|r| !r.trim().is_empty())
        })
        .and_then(|s| s.ref_key.as_deref())
}

/// `POST /api/media/series/:id/recache-missing` — 剧集级「补缺」（BUG-261）。
///
/// 收集这部剧里 `has_bytes != Present` 的分集，解析各自**可缓存来源**的 ref
/// （`episode_recache_ref`：主源 tg 优先，其次任一 tg 备用源），按 chat 聚组后
/// 复用 `Store::enqueue_cache_task` 入队。返回 `{enqueued, groups, skipped}`：
///
/// - `enqueued`：入队的消息数（有字节的集不重复入队）；
/// - `groups`：按 chat 聚的组数（同 chat 的多集合并为**一个**任务）；
/// - `skipped`：ref 非 tg / 缺失的缺失集，**必须**带原因 ——「不得静默」是
///   BUG-261 修复后判据 4 的硬要求，静默跳过等于把「缺来源」伪装成「已处理」。
///
/// 组键用 `b:` 前缀（batch），与单条 `m:` / 相册 `g:` 的键空间互不相交：
/// 同一批次重复点击命中活跃任务直接复用（幂等），且**不会**与单条任务的键相撞
/// —— store 的活跃任务复用按 item_key 整体命中，键相撞会把同组其余消息吞掉。
async fn recache_series_missing(
    State(st): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&st).await?;
    let Some(d) = st
        .store
        .get_series(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "series not found"));
    };

    // ── 收集缺失集的可缓存坐标（主源 tg 优先，其次备用源）──
    let mut by_chat: std::collections::BTreeMap<i64, Vec<i64>> = std::collections::BTreeMap::new();
    let mut skipped: Vec<serde_json::Value> = Vec::new();
    for ep in &d.episodes {
        if ep.has_bytes {
            continue; // 有字节的集不在「补缺」范围
        }
        match episode_recache_ref(ep).and_then(parse_tg_ref_coords) {
            Some((chat_id, message_id)) => {
                by_chat.entry(chat_id).or_default().push(message_id);
            }
            None => skipped.push(json!({
                "itemId": ep.item_id,
                "reason": NO_RECACHEABLE_REF_REASON,
            })),
        }
    }

    let dir = effective_download_dir(&st).await;
    let mut enqueued = 0usize;
    let mut groups = 0usize;
    // BTreeMap 遍历序确定（chat 升序）——响应与日志不随 HashMap 序漂移。
    for (chat_id, mut message_ids) in by_chat {
        message_ids.sort_unstable();
        message_ids.dedup();
        let first = message_ids[0];
        let item_key = format!("b:{}:{}", chat_id, first);
        let Some((task, created)) = st
            .store
            .enqueue_cache_task(chat_id, None, &item_key, &message_ids, &dir)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        else {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "enqueue cache task failed",
            ));
        };
        enqueued += message_ids.len();
        groups += 1;
        st.refresh_cache_tasks().await;
        if created {
            // 与单条入队同一纪律：T0 登记（BUG-246/248）与 worker 单飞启动都不缺席；
            // 两者都只在**真正新建**时做（复用活跃任务时已在跑，重复起会双跑同组）。
            {
                let st_bg = st.clone();
                tokio::spawn(async move {
                    register_enqueued_items(&st_bg, chat_id, &message_ids).await;
                });
            }
            spawn_cache_task(st.clone(), task.id);
        }
    }
    if groups > 0 {
        st.push_log(&format!(
            "/api/media/series/{id}/recache-missing: 入队 {enqueued} 集（{groups} 组），跳过 {} 集",
            skipped.len()
        ));
    }
    Ok(Json(json!({
        "enqueued": enqueued,
        "groups": groups,
        "skipped": skipped,
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
    use super::download_limits;
    use super::delivery_due_secs;
    use super::all_cache_tasks_payload;
    use super::cache_tasks_payload;
    use super::clean_title;
    use super::create_media_series;
    use super::list_all_cache_tasks;
    use super::list_episode_bindings;
    use super::merge_media_series;
    use super::normalized_series_name;
    use super::parse_stream_speed;
    use super::parse_stream_start;
    use super::encode_profile_for;
    use super::proxy_variant;
    use super::proxy_variant_for;
    use super::EncodeProfile;
    use super::acquire_transcode_role;
    use super::reclaim_transcode_slot;
    use super::transcode_inflight;
    use super::wait_for_transcode;
    use super::Role;
    use super::TranscodeKey;
    use super::patch_media_series;
    use super::resolve_ffmpeg_from;
    use super::speed_video_filter;
    use super::atempo_filter;
    use super::transformed_duration;
    use super::router;
    use super::serve_local_file;
    use super::MergeSeriesReq;
    // BUG-129：409 判据要直接调 handler（状态码与错误信息都只在 handler 层可见）。
    use super::add_media_episode;
    use super::EpisodeReq;

    // ── BUG-291：代理文件名必须带编码档位指纹 ─────────────────────────────

    /// 判据 1（BUG-291）：**改编码档位 ⇒ 代理必失效**。
    ///
    /// 缺陷形态是「文件名只有 `(item_id, speed)`，命中判据只 `metadata()` 判存在」，
    /// 于是旧档位产出的代理会被永久沿用（BUG-289 实测某 4x 代理仍是旧档 30 fps）。
    /// 本测试锁住的是**可命中路径本身**：只要当前档位算出的名字与「旧档位 / 修复前
    /// 旧命名」算出的名字不同，陈旧代理就**不可能**再被 `:4285` 的 `metadata()` 命中，
    /// 也就必然重建。
    ///
    /// 反向证伪：把 `proxy_variant_for` 的函数体退回无指纹版本（签名不变）⇒
    /// 下面第 ① 条断言立刻变红（`673-speed-400.mp4` 会被重新命中）。
    #[test]
    fn bug291_encode_profile_change_invalidates_stale_proxy() {
        const ID: i64 = 673;
        // BUG-291/BUG-289：「旧档位」= ≥3x 曾按 **24 fps** 编码（BUG-289 修复后现行档位为 30 fps）。
        // 注意：这个值必须与 `encode_profile(400)` 至少差一个字段，否则下面的 `assert_ne!`
        // 会因为「新旧档位撞名」而变红——这正是指纹机制该拦住的情形。
        let stale_profile = EncodeProfile {
            preset: "ultrafast",
            crf: 28,
            fps: 24,
        };
        let current_4x = proxy_variant(ID, Some(400));

        // ① 修复前的旧命名（磁盘上真实存在的陈旧代理就是这个名字）绝不能被再命中。
        assert_ne!(
            current_4x,
            format!("{ID}-speed-400.mp4"),
            "BUG-291 回归：4x 代理名退化成无指纹的旧命名，陈旧代理会被 metadata() 命中沿用"
        );
        // ② 旧档位（30 fps）算出的名字 ≠ 现行档位名 ⇒ 改档位即失效重建。
        assert_ne!(
            current_4x,
            proxy_variant_for(ID, Some(400), stale_profile),
            "BUG-291 回归：改了 fps 之后代理名不变，旧档代理仍会被命中"
        );
        // ③ crf 变了名字也要变（指纹必须覆盖 crf，不只是 fps）。
        assert_ne!(
            current_4x,
            proxy_variant_for(
                ID,
                Some(400),
                EncodeProfile {
                    preset: "ultrafast",
                    crf: 20,
                    fps: 24
                }
            ),
            "BUG-291 回归：指纹未覆盖 crf"
        );
        // ④ preset 变了名字也要变。
        assert_ne!(
            current_4x,
            proxy_variant_for(
                ID,
                Some(400),
                EncodeProfile {
                    preset: "veryfast",
                    crf: 28,
                    fps: 24
                }
            ),
            "BUG-291 回归：指纹未覆盖 preset"
        );
        // ⑤ 形状断言：指纹必须落在倍速之后、扩展名之前，不得改变既有命名骨架。
        assert!(
            current_4x.starts_with(&format!("{ID}-speed-400-")) && current_4x.ends_with(".mp4"),
            "代理名形状应为 `<id>-speed-<n>-<指纹>.mp4`，实际：{current_4x}"
        );
        // ⑥ 不回归秒开：指纹必须**确定性**（同参数两次调用同名），否则每次都重转。
        assert_eq!(current_4x, proxy_variant(ID, Some(400)));
        // ⑦ 不推翻 BUG-226：不同变体（1x 兼容代理 / 各倍速）仍各自独立成文件。
        let compat = proxy_variant(ID, None);
        assert_ne!(compat, current_4x);
        assert_ne!(compat, proxy_variant(ID, Some(200)));
        assert_ne!(proxy_variant(ID, Some(200)), proxy_variant(ID, Some(300)));
        // ⑧ 兼容代理同样带指纹（其档位由 COMPAT_ENCODE_PROFILE 定义）。
        assert_ne!(compat, format!("{ID}.mp4"));
        assert_eq!(compat, proxy_variant_for(ID, None, encode_profile_for(None)));
    }

    // ── BUG-288：单飞表条目泄漏（孤儿条目永久 503） ───────────────────────

    /// 判据 7（BUG-288 取证补充二「路径 A」）：**在 insert 之后、spawn 之前注入取消**
    /// ⇒ 单飞表不得留下无 pump 认领的条目，且该键必须能被**重新** `Start`。
    ///
    /// 修复前的形态：条目进了表、`tx` 随被丢弃的 handler future 一起 drop ⇒
    /// 此后每个请求进 `Role::Wait` 都瞬间 `changed()=Err` → 无代理 → **瞬间 503**，
    /// 且永不出表（唯一出表口是 pump 的 `finish()`，而这里根本没有 pump），
    /// 只能重启 orig-tg 才解。
    ///
    /// 注入方式是**真的取消一个持有守卫的 future**（`tokio::spawn` + `abort()`），
    /// 而不是「手动调一次 remove」——后者会把自己要证的东西当成前提。
    #[tokio::test]
    async fn bug288_cancellation_between_insert_and_spawn_leaves_no_orphan_slot() {
        let key = TranscodeKey {
            item_id: 991_288,
            speed_hundredths: Some(400),
        };
        // 本测试独占这个 key：先清场，收尾也清场（表是进程级 static）。
        transcode_inflight().lock().expect("poisoned").remove(&key);

        // ① 占坑：与 handler 走同一个 `acquire_transcode_role`（不是测试内重写的副本）。
        let (tx, slot) = match acquire_transcode_role(key) {
            Role::Start(tx, slot) => (tx, slot.expect("抢到坑必带出表守卫")),
            Role::Wait(_) => panic!("首个请求必须抢到坑（Start），而不是 Wait"),
        };
        assert!(
            transcode_inflight().lock().expect("poisoned").contains_key(&key),
            "占坑后该键必须在表内——这正是「insert 之后、spawn 之前」的窗口"
        );

        // ② 注入取消：handler future 持有守卫，并在 `ffmpeg_config().await` 处
        //    被客户端断开 ⇒ hyper 丢弃 future ⇒ 守卫 `Drop`。
        let handler = tokio::spawn(async move {
            let _slot = slot;
            let _tx = tx;
            std::future::pending::<()>().await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        handler.abort();
        let _ = handler.await; // 等 future 真正被 drop（守卫 Drop 生效）

        // ③ 修复前：键残留 ⇒ 后续请求进 Wait ⇒ 瞬间 503、永不自愈。
        //    修复后：守卫已出表 ⇒ 该键可以被**重新** Start（不再 503）。
        assert!(
            !transcode_inflight()
                .lock()
                .expect("poisoned")
                .contains_key(&key),
            "BUG-288 回归：handler 被取消后单飞表仍残留该键（无 pump 认领 ⇒ 该变体永久 503）"
        );
        match acquire_transcode_role(key) {
            Role::Start(_, Some(_)) => {}
            Role::Start(_, None) => panic!("重新抢到的坑必须带出表守卫"),
            Role::Wait(_) => panic!("BUG-288 回归：取消之后该键仍被视为在途 ⇒ 请求会拿到 503"),
        }

        transcode_inflight().lock().expect("poisoned").remove(&key);
    }

    /// 判据 1（BUG-288）：等待方必须能**区分**「真·在途」与「孤儿」，
    /// 只把孤儿交给自愈路径——否则要么泄漏照旧，要么在 pump 还在跑时重复起 ffmpeg。
    #[tokio::test]
    async fn bug288_wait_distinguishes_orphan_from_live_transcode() {
        let dir = std::env::temp_dir().join(format!("orig-tg-bug288-{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let final_p = dir.join("991288-speed-400-ultrafast-crf28-30fps.mp4");
        let _ = tokio::fs::remove_file(&final_p).await;

        // ① 孤儿形态：pump 从未启动（发送端已 drop）+ 代理未落盘。
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        drop(tx);
        let (ready, orphan) = wait_for_transcode(&mut rx, &final_p).await;
        assert!(!ready, "代理未落盘时不得报告就绪");
        assert!(
            orphan,
            "BUG-288 回归：发送端已死 + 无代理 ⇒ 必须判定为孤儿（进而回收重转），而不是恒 503"
        );

        // ② pump 已完成但代理未落盘：发送端仍活着 ⇒ **不是**孤儿，
        //    保留既有 503 语义（不得误判成孤儿而在 pump 还在跑时重复起 ffmpeg）。
        let (tx2, mut rx2) = tokio::sync::watch::channel(false);
        let _ = tx2.send(true);
        let (ready2, orphan2) = wait_for_transcode(&mut rx2, &final_p).await;
        assert!(!ready2);
        assert!(
            !orphan2,
            "发送端仍活着 ⇒ 不是孤儿（既有 503 语义必须保留，不得重复起 ffmpeg）"
        );

        // ③ 完成且代理已落盘 ⇒ 就绪可 serve（自愈的终态）。
        let _ = tokio::fs::write(&final_p, b"fake-proxy-bytes").await;
        let (tx3, mut rx3) = tokio::sync::watch::channel(false);
        let _ = tx3.send(true);
        let (ready3, orphan3) = wait_for_transcode(&mut rx3, &final_p).await;
        assert!(ready3, "代理落盘后必须报告就绪（否则等待方不会去 serve）");
        assert!(!orphan3);

        let _ = tokio::fs::remove_file(&final_p).await;
    }

    /// 判据 3（BUG-288）：孤儿键被回收后**必须重新占坑** —— 只 remove 不 insert 会让
    /// 该键处于无人认领状态，后续请求各起一条 ffmpeg，单飞就被打破了。
    #[tokio::test]
    async fn bug288_reclaim_of_orphan_slot_keeps_single_flight() {
        let key = TranscodeKey {
            item_id: 992_288,
            speed_hundredths: Some(200),
        };
        transcode_inflight().lock().expect("poisoned").remove(&key);

        // 人为制造 BUG-288 现场：条目在表内，但它的发送端已死（无任何 pump 认领）。
        let (dead_tx, dead_rx) = tokio::sync::watch::channel(false);
        transcode_inflight()
            .lock()
            .expect("poisoned")
            .insert(key, dead_rx);
        drop(dead_tx);
        assert!(
            matches!(acquire_transcode_role(key), Role::Wait(_)),
            "孤儿条目在被回收前确实会让请求走 Wait —— 这正是恒 503 的来源"
        );

        // 回收：出表 + **重新**占坑（handler 在判定孤儿后走的就是这一步）。
        let (_tx, slot) = reclaim_transcode_slot(key);
        assert!(slot.is_some(), "回收后必须持有出表守卫");
        assert!(
            transcode_inflight().lock().expect("poisoned").contains_key(&key),
            "BUG-288 回归：回收后表里没有该键 ⇒ 后续请求会各起一条 ffmpeg（单飞被打破）"
        );
        assert!(
            matches!(acquire_transcode_role(key), Role::Wait(_)),
            "BUG-288 回归：回收后该键没被占住 ⇒ 并发请求会各起一条 ffmpeg"
        );

        drop(slot);
        transcode_inflight().lock().expect("poisoned").remove(&key);
    }

    // ── BUG-257：取消可达在途 IO（判据 1） ────────────────────────────────

    /// 一个 `download()` **永远挂住**的客户端：精确复现「卡住的条目」。
    ///
    /// 它刻意**不**自己超时：真实卡死时能救场的只有 90s 空闲看门狗，而那正是本测试
    /// 要证明**不必再等**的东西。用它当夹具，「取消是否可达在途」就是被测命题本身，
    /// 而不是对某个 mock 行为的间接断言。
    struct HangingClient {
        /// 被`download()` 进入的次数（用来确认「确实卡在下载里」而不是提前退出）。
        entered: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl crate::login::Client for HangingClient {
        async fn start(&self, _: &str) -> Result<crate::login::LoginPhase, crate::login::ClientError> {
            Err(crate::login::ClientError::NotInitialized)
        }
        async fn submit_code(
            &self,
            _: &str,
            _: &str,
        ) -> Result<crate::login::LoginPhase, crate::login::ClientError> {
            Err(crate::login::ClientError::NotInitialized)
        }
        async fn submit_password(
            &self,
            _: &str,
            _: &str,
        ) -> Result<crate::login::LoginPhase, crate::login::ClientError> {
            Err(crate::login::ClientError::NotInitialized)
        }
        async fn view(&self) -> crate::login::SessionView {
            crate::login::SessionView {
                phase: crate::login::LoginPhase::Anonymous,
                phone: None,
                user_id: None,
            }
        }
        async fn dialogs(&self) -> Result<Vec<crate::login::Channel>, crate::login::ClientError> {
            Ok(Vec::new())
        }
        async fn folders(&self) -> Result<Vec<crate::login::Folder>, crate::login::ClientError> {
            Ok(Vec::new())
        }
        async fn messages(
            &self,
            _: i64,
            _: u32,
            _: Option<i64>,
        ) -> Result<Vec<crate::login::MediaItem>, crate::login::ClientError> {
            Ok(Vec::new())
        }
        async fn thumb(
            &self,
            _: i64,
            _: i64,
        ) -> Result<Option<crate::login::Thumbnail>, crate::login::ClientError> {
            Ok(None)
        }
        async fn media(
            &self,
            _: i64,
            _: i64,
            _: Option<crate::login::MediaRange>,
        ) -> Result<crate::login::MediaStream, crate::login::ClientError> {
            Err(crate::login::ClientError::MediaNotFound)
        }
        /// 永不返回：模拟「TCP 半死、range 流next() 永不返回」。
        async fn download(
            &self,
            _: i64,
            _: i64,
            _: &str,
            _: Option<&crate::login::DownloadProgress>,
        ) -> Result<crate::login::DownloadOutcome, crate::login::ClientError> {
            self.entered
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // 永久挂起：只有取消（或进程结束）能解开，正是要修的那个形态。
            std::future::pending::<()>().await;
            unreachable!("pending() 永不返回")
        }
        async fn message_meta(
            &self,
            _: i64,
            _: i64,
        ) -> Result<Option<crate::login::MediaItem>, crate::login::ClientError> {
            Ok(None)
        }
    }

    /// 判据 1（BUG-257）：对**卡在条目内**的任务发出取消，必须在**秒级**退出，
    /// 而**不是**等满 90s 空闲看门狗；且任务**不得**被写成 `done`/`failed`。
    ///
    /// 三条断言分别锁住用户能感知到的三件事：
    /// ① 生效上限（秒级，不是 90s）；② 终态是 `cancelled`（用户取消，不是被判定失败）；
    /// ③ 确实卡在下载里（否则本测试可能只是「提前退出」的假阳性）。
    #[tokio::test]
    async fn cancel_aborts_an_in_flight_download_in_seconds_not_ninety() {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};

        let entered = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let st = std::sync::Arc::new(crate::state::AppState::new(
            std::sync::Arc::new(HangingClient { entered: entered.clone() }),
            crate::config::Config::default(),
            crate::state::Availability::Ready,
            false,
            crate::store::Store::open(":memory:").await.expect("store"),
        ));

        // 入队一条真实会走下载路径的任务（媒体类型非 photo ⇒ 不走「图片不缓存」分支）。
        st.store
            .upsert_message(-1001, 55, Some("hangs"), Some("video/mp4"), Some(9_000), Some("video".into()), Some(0), None, None, None)
            .await
            .unwrap();
        let (task, created) = st
            .store
            .enqueue_cache_task(-1001, None, "m:-1001:55", &[55], &std::env::temp_dir().to_string_lossy())
            .await
            .unwrap()
            .unwrap();
        assert!(created);

        let worker = tokio::spawn({
            let st = st.clone();
            async move { run_one_cache_task(&st, task.id).await }
        });

        // 等worker 真的卡进download()（而不是还没起步就退出了）。
        let deadline = Instant::now() + Duration::from_secs(10);
        while entered.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            entered.load(Ordering::SeqCst),
            1,
            "夹具前提：worker 必须已卡在 download() 里"
        );

        // 取消 → 计时。
        let t0 = Instant::now();
        assert!(crate::cache::cancel_task_kernel(&st, task.id).await.expect("cancel must succeed"));
        tokio::time::timeout(Duration::from_secs(20), worker)
            .await
            .expect("BUG-257：取消必须在 20s 内让在途传输退出（旧行为要等满 90s 看门狗）")
            .expect("worker task must not panic");
        let elapsed = t0.elapsed();
        assert!(
            elapsed < Duration::from_secs(10),
            "取消生效上限实测 {elapsed:?}，超过 10s 就不是「可达在途」"
        );

        let t = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(
            t.status, "cancelled",
            "取消后的终态必须是 cancelled —— 被判定成 done/failed 都是谎报"
        );
        assert!(
            st.logs
                .recent(50)
                .iter()
                .any(|l| l.contains("in-flight transfer aborted")),
            "在途中止必须留痕，否则无法与「压根没跑」区分"
        );
        println!("BUG-257 判据 1 实测：取消在途生效耗时 {elapsed:?}（旧行为需等满 90s 看门狗）");
    }

    /// **反向证伪**（BUG-257 判据 7）：把在途 `select!` 换回「只查DB」的旧语义，
    /// 判据 1 必须重新 FAIL——否则它测的就不是「取消可达在途 IO」，而是别的什么东西。
    ///
    /// 这条断言的价值恰恰在它**会失败**：它锁住的是「判据 1 仍然有效」。若将来有人
    /// 顺手把 `select!` 简化回`cache_one_bytes(..).await`（看起来完全等价、因为
    /// 循环顶部仍在查活跃性），本测试会立刻红给你看，而不是让BUG-257 悄悄复活。
    ///
    /// 复现旧行为的方式：直接调`download()` 并**只**等它自己结束——永不返回的夹具
    /// 于是只能靠 20s 超时兜住，与「90s 看门狗」同构。
    #[tokio::test]
    async fn falsification_without_select_the_download_only_ends_by_timeout() {
        use std::sync::atomic::Ordering;
        use std::time::Duration;

        let entered = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let client = HangingClient { entered: entered.clone() };

        // 旧路径：`download()` 直接 await，**没有任何取消信号**参与竞速。
        let hung = tokio::time::timeout(
            Duration::from_secs(20),
            client.download(-1001, 55, ".", None),
        )
        .await;

        assert_eq!(entered.load(Ordering::SeqCst), 1, "夹具必须已进入 download()");
        assert!(
            hung.is_err(),
            "无 select! 时在途下载只能靠外部超时结束 —— 这正是 BUG-257 修掉的那条路径；\
             若本行失败，说明夹具不再复现「卡住」，判据 1 就失去了对照"
        );
    }

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
        assert_eq!(speed_video_filter(50, 30), "setpts=(PTS-STARTPTS)/0.50,fps=30");
        assert_eq!(speed_video_filter(200, 30), "setpts=(PTS-STARTPTS)/2.00,fps=30");
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
    use crate::media::SeriesPatch;
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

    /// BUG-342：标题清洗——输入全部取自**活库 caption 首行抽样**（不是臆造用例）。
    ///
    /// 用户裁定原话：「下载中可以看到特殊符号,书括号这些异常字符,都应该过滤掉」。
    /// 判据双向：① 活数据形态必须清成无符号形态；② 正常标题（数字剧名、ASCII
    /// 标点、集号区间）不得被误伤——清洗是白名单过滤，不是「删一切非中文」。
    #[test]
    fn clean_title_strips_symbols_on_live_caption_shapes() {
        // emoji + 书括号 + 尾部星级 + 促销尾缀
        assert_eq!(
            clean_title("🌟🔥《飘飘欲仙 富二代征服校园母狗》EP7 原档无二次水印 连载中 ⭐⭐⭐"),
            "飘飘欲仙 富二代征服校园母狗EP7 原档无二次水印 连载中"
        );
        assert_eq!(clean_title("❗️❗️❗️❗️《多啦B梦大冒险》 EP1-8"), "多啦B梦大冒险 EP1-8");
        // NBSP（`\u{a0}`）+ 手机 emoji + 书名号
        assert_eq!(
            clean_title("📱 \u{a0} 《岳母交换计划》 第2集"),
            "岳母交换计划 第2集"
        );
        // 【】方括号 + hashtag 只删 `#` 字符（tag 文字是标题内容，见函数文档①）
        assert_eq!(
            clean_title(
                "⚡️ 【阳光合租屋：暧昧同居】 新剧首更  ⚡️ #黄果短剧 #阳光合租屋 #AI短剧 #成人短剧 #暧昧同居"
            ),
            "阳光合租屋：暧昧同居 新剧首更 黄果短剧 阳光合租屋 AI短剧 成人短剧 暧昧同居"
        );
        // hashtag 本身就是剧名（BUG-152 真实链同款形态）：文字必须留下
        assert_eq!(clean_title("😀😀😀😀😀😀😀😀  #《快门沦陷》 EP5-6"), "快门沦陷 EP5-6");
        assert_eq!(
            clean_title("📱新剧首更 【王校长的淫乱契约】第1-5集  #ai短剧  #魔改短剧 #网红魔改 #王校长的淫乱契约"),
            "新剧首更 王校长的淫乱契约第1-5集 ai短剧 魔改短剧 网红魔改 王校长的淫乱契约"
        );
        // URL 整删（含无 scheme 的 t.me 直连词），前缀词保留
        assert_eq!(clean_title("Ai商城https://t.me/Aishangchengbot"), "Ai商城");
        assert_eq!(clean_title("https://t.me/foo bar"), "bar");
        assert_eq!(clean_title("promo t.me/joinchat/abc end"), "promo end");
        // 正常标题零误伤：数字剧名、集号区间、ASCII 标点、扩展名
        assert_eq!(clean_title("普通标题 第1集"), "普通标题 第1集");
        assert_eq!(clean_title("1990-2020 经典回顾"), "1990-2020 经典回顾");
        assert_eq!(clean_title("妻善3.mp4"), "妻善3.mp4");
        assert_eq!(clean_title("EP01-02 (全集)"), "EP01-02 (全集)");
        // 全符号 ⇒ 空 = 如实「没有标题」（BUG-154 纪律，交回退链接手）
        assert_eq!(clean_title("🌟🌟🌟"), "");
        assert_eq!(clean_title("《》"), "");
        assert_eq!(clean_title("   "), "");
        assert_eq!(clean_title(""), "");
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
        let st = Arc::new(AppState::new(
            Arc::new(crate::unavailable::UnavailableClient::new("test")),
            cfg,
            Availability::Unavailable("test".to_string()),
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        ));
        pin_download_dir(&st, dir).await;
        st
    }

    /// 每次调用都给出唯一临时目录（进程内并发用例互不串扰）。
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        // 2026-10-19：夹具必须在**非禁用盘**（`store::fixture_base`）：下载根解析到
        // C: 会被改道到真实内容根 `D:\OrigDown`，「钉下载根」会静默指向用户真实
        // 内容目录 —— 媒资清理类用例会在真实文件上动手。落点跟着工作区 target/tmp 走。
        let d = crate::store::fixture_base(tag);
        std::fs::create_dir_all(&d).expect("scratch dir must be creatable");
        d
    }

    /// BUG-323：把 `dir` 钉成**下载根**（受管根 / 权限边界）。
    ///
    /// 下载路径的真源在 `Store`（`app_setting download_dir`），不再是
    /// `Config.download_dir` —— 后者在 BUG-323 之后只剩「启动期提示」作用。
    /// 夹具**只允许落在非禁用盘的测试夹具根**上：库根已跟随下载根，夹具若不钉，
    /// 默认档会落到用户真实的 `~/Downloads`（媒资清理类用例一旦跑起来就会动那里
    /// 的文件）；而钉在 C: 上又会被禁用盘规则改道到真实内容根 `D:\OrigDown`。
    async fn pin_download_dir(st: &AppState, dir: &std::path::Path) {
        assert!(
            dir.starts_with(crate::store::fixture_root()),
            "夹具只允许把下载根钉在非禁用盘的测试夹具根上，收到 {dir:?}"
        );
        st.store
            .set_setting("download_dir", dir.to_string_lossy().as_ref())
            .await
            .expect("pin download root");
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

    // ---- BUG-258：剧集类型枚举 422 / 年份三态（HTTP 契约层）----

    /// BUG-258：`PATCH /api/media/series/:id` 收到非法 `kind` 必须 **422**。
    ///
    /// 缺陷原形：路由把 `SeriesPatch` 原样交给 store，而 `kind` 是「任何字符串都
    /// 照收」的字段 ⇒ `{"kind":"garbage"}` 成功写入，界面上的 `kindLabel()` 又把
    /// 未知值原样透出，于是出现一个用户看得见、却没有任何语义的徽标。
    /// **非法状态必须不可表达。**
    #[tokio::test]
    async fn patch_series_rejects_a_kind_outside_the_enum_with_422() {
        let dir = scratch_dir("kind_422");
        let st = state_in_download_dir(&dir).await;
        let sid = st
            .store
            .create_series("合法剧", None, "series", None, None)
            .await
            .unwrap();

        // 逐个非法值都必须 422（大小写敏感、空串、以及「看起来像」的近邻词）。
        for bad in ["garbage", "", "Album", "SERIES", "series ", "album2"] {
            let body: SeriesPatch = serde_json::from_value(json!({ "kind": bad }))
                .unwrap_or_else(|e| panic!("body must deserialize so the 422 comes from validation: {e}"));
            let res = patch_media_series(State(st.clone()), Path(sid), Json(body)).await;
            let err = match res {
                Ok(_) => panic!("kind={bad:?} 必须被拒绝，却返回成功"),
                Err(e) => e,
            };
            assert_eq!(
                err.status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "kind={bad:?} 必须 422（可枚举的非法值不该报成 500）"
            );
            // 422 之后列值必须原封不动。
            assert_eq!(
                st.store.get_series(sid).await.unwrap().unwrap().series.kind,
                "series",
                "kind={bad:?} 被拒后不得部分写入"
            );
        }

        // 三个合法值都必须 200（别把枚举写死成只认一个）。
        for good in crate::media::SERIES_KINDS {
            let body: SeriesPatch =
                serde_json::from_value(json!({ "kind": good })).expect("legal kind deserializes");
            let res = patch_media_series(State(st.clone()), Path(sid), Json(body)).await;
            assert!(res.is_ok(), "kind={good:?} 必须被接受");
            assert_eq!(
                st.store.get_series(sid).await.unwrap().unwrap().series.kind,
                good,
                "kind={good:?} 必须真的写进列"
            );
        }
    }

    /// BUG-258：`POST /api/media/series` 同样拒绝非法 `kind`（建剧集也是写路径）。
    #[tokio::test]
    async fn create_series_rejects_a_kind_outside_the_enum_with_422() {
        let dir = scratch_dir("kind_422_create");
        let st = state_in_download_dir(&dir).await;
        let res = create_media_series(
            State(st.clone()),
            Json(super::CreateSeriesReq {
                title: "坏剧".to_string(),
                description: None,
                kind: Some("garbage".to_string()),
                year: None,
            }),
        )
        .await;
        let err = match res {
            Ok(_) => panic!("非法 kind 必须被拒绝，却返回成功"),
            Err(e) => e,
        };
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            st.store.list_series().await.unwrap().is_empty(),
            "被拒的建剧请求不得留下任何行"
        );
    }

    /// BUG-258 判据 3 + 判据 4（HTTP 层）：`{"year": null}` 清空年份，
    /// 而**缺省该键**保持原值。
    ///
    /// 这是前端唯一的通道（`SeriesEditPanel` 的保存），因此必须在端点这一层
    /// 证明三态成立 —— 只在 store 层证明不足以说明真实调用链可用。
    #[tokio::test]
    async fn patch_series_year_clears_on_explicit_null_and_keeps_when_absent() {
        let dir = scratch_dir("year_three_state");
        let st = state_in_download_dir(&dir).await;
        let sid = st
            .store
            .create_series("年份剧", None, "series", Some(2024), None)
            .await
            .unwrap();

        let patch_json = |v: serde_json::Value| -> SeriesPatch {
            serde_json::from_value(v).expect("body deserializes")
        };

        // ① 设值 → 2024 保持。
        let res = patch_media_series(
            State(st.clone()),
            Path(sid),
            Json(patch_json(json!({ "year": 2024 }))),
        )
        .await;
        assert!(res.is_ok());
        assert_eq!(
            st.store.get_series(sid).await.unwrap().unwrap().series.year,
            Some(2024)
        );

        // ② 缺省 year 键（只改标题）→ 年份不得被写坏（判据 4）。
        let res = patch_media_series(
            State(st.clone()),
            Path(sid),
            Json(patch_json(json!({ "title": "只改标题" }))),
        )
        .await;
        assert!(res.is_ok());
        assert_eq!(
            st.store.get_series(sid).await.unwrap().unwrap().series.year,
            Some(2024),
            "BUG-258 判据 4：缺省 year 键必须是不改"
        );

        // ③ 显式 null → 清空为 NULL（判据 3）。缺陷原形下这里是 200 但值不变。
        let res = patch_media_series(
            State(st.clone()),
            Path(sid),
            Json(patch_json(json!({ "year": null }))),
        )
        .await;
        assert!(res.is_ok(), "清空年份必须是成功而不是报错");
        assert_eq!(
            st.store.get_series(sid).await.unwrap().unwrap().series.year,
            None,
            "BUG-258 判据 3：PATCH {{\"year\": null}} 必须把年份清成 NULL"
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
    use super::backfill_message_titles;

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
        /// BUG-257：true = 每个消息只**第一次**尝试失败（瞬时故障模型），重试放行。
        /// false（默认，既有测试语义）= 列表内的消息**每次**都失败。
        fail_first_attempt_only: bool,
        /// download() 调用计数（按消息号）——重试幂等判据的观测点：
        /// 已成功条目在 retry 后**不得**再次下载（BUG-257 方向 3 实测要求）。
        download_calls: Arc<std::sync::Mutex<HashMap<i64, usize>>>,
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
            // 计数先行：无论成败，「这条被下载过几次」都是幂等判据的原始事实。
            {
                let mut g = self
                    .download_calls
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                *g.entry(message_id).or_insert(0) += 1;
                let attempts = *g.get(&message_id).unwrap_or(&0);
                let injected = self.fail_downloads.contains(&message_id);
                let must_fail =
                    injected && (!self.fail_first_attempt_only || attempts == 1);
                if must_fail {
                    return Err(ClientError::Other("injected download failure".into()));
                }
            }
            let path = std::path::Path::new(dir).join(format!("fixture-{chat_id}-{message_id}.mp4"));
            std::fs::write(&path, b"fixture-bytes")
                .map_err(|e| ClientError::Other(format!("write: {e}")))?;
            Ok(DownloadOutcome {
                message_id,
                path: path.to_string_lossy().into_owned(),
                bytes: 13,
                content_hash: None,
                dedup: false,
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
        cache_fixture_state_counted(dir, fail, msgs, false).await.0
    }

    /// 同 [`cache_fixture_state`]，但把 download() 调用计数交给调用方，
    /// 并可选「瞬时故障」模型（每消息只第一次失败）——BUG-257 方向 3 的
    /// 重试幂等判据要用它**实测**「已成功条目不得重新下载」。
    async fn cache_fixture_state_counted(
        dir: &std::path::Path,
        fail: Vec<i64>,
        msgs: Vec<TgMedia>,
        fail_first_attempt_only: bool,
    ) -> (Arc<AppState>, Arc<std::sync::Mutex<HashMap<i64, usize>>>) {
        let mut by_id = HashMap::new();
        for m in msgs {
            by_id.insert(m.id, m);
        }
        let mut cfg = Config::default();
        cfg.download_dir = dir.to_path_buf();
        let calls = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let st = Arc::new(AppState::new(
            Arc::new(CacheFixtureClient {
                chat_id: CACHE_FIXTURE_CHAT,
                msgs: by_id,
                fail_downloads: fail,
                fail_first_attempt_only,
                download_calls: calls.clone(),
            }),
            cfg,
            Availability::Ready,
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        ));
        pin_download_dir(&st, dir).await;
        (st, calls)
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

    // ── BUG-271：慢流（墙钟上限）夹具与判据 ───────────────────────────────

    /// 「每 interval 来 1 chunk、共 chunks 块」的慢流客户端（BUG-271 判据 1）。
    ///
    /// 间隔刻意**远小于**空闲看门狗（90s）⇒ 空闲档对它**永不触发**——这正是
    /// 「慢」与「死」的分界：旧代码（无墙钟）会正常完成下载（只是慢），
    /// 新代码在墙钟内判失败。生产里的「每 89s 来 1 chunk」被等比缩到测试尺度
    /// （每 120ms 来 1 chunk），语义不变：chunk 间隔 ≪ 空闲阈值、总量 ≫ 墙钟。
    struct TrickleClient {
        chat_id: i64,
        msgs: HashMap<i64, TgMedia>,
        /// 走慢流的消息号；其余消息瞬时完成（与 CacheFixtureClient 同款落盘）。
        trickle: Vec<i64>,
        chunk_interval: std::time::Duration,
        chunks: usize,
        download_calls: Arc<std::sync::Mutex<HashMap<i64, usize>>>,
    }

    #[async_trait::async_trait]
    impl Client for TrickleClient {
        async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::CodeRequired)
        }
        async fn submit_code(&self, _p: &str, _c: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::Authorized)
        }
        async fn submit_password(&self, _p: &str, _w: &str) -> Result<LoginPhase, ClientError> {
            Err(ClientError::Other("no 2FA in trickle fixture".into()))
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
            _c: i64,
            _l: u32,
            _b: Option<i64>,
        ) -> Result<Vec<TgMedia>, ClientError> {
            Ok(Vec::new())
        }
        async fn thumb(&self, _: i64, _: i64) -> Result<Option<Thumbnail>, ClientError> {
            Ok(None)
        }
        async fn media(
            &self,
            _: i64,
            _: i64,
            _: Option<MediaRange>,
        ) -> Result<MediaStream, ClientError> {
            Err(ClientError::MediaNotFound)
        }
        /// 慢流：逐 chunk 落盘、chunk 间睡 `chunk_interval`（**远小于**空闲阈值）。
        /// 被墙钟掐断时本 future 被 drop——与生产流被 drop 同构，残余半截文件
        /// 留在落盘目录（DB 无 downloaded 标志 ⇒ `cached_path` 不会误判已缓存）。
        async fn download(
            &self,
            chat_id: i64,
            message_id: i64,
            dir: &str,
            _progress: Option<&crate::login::DownloadProgress>,
        ) -> Result<DownloadOutcome, ClientError> {
            {
                let mut g = self.download_calls.lock().unwrap_or_else(|e| e.into_inner());
                *g.entry(message_id).or_insert(0) += 1;
            }
            let path = std::path::Path::new(dir).join(format!("trickle-{chat_id}-{message_id}.mp4"));
            if !self.trickle.contains(&message_id) {
                std::fs::write(&path, b"fast-bytes")
                    .map_err(|e| ClientError::Other(format!("write: {e}")))?;
                return Ok(DownloadOutcome {
                    message_id,
                    path: path.to_string_lossy().into_owned(),
                    bytes: 10,
                    content_hash: None,
                    dedup: false,
                });
            }
            let mut f = std::fs::File::create(&path)
                .map_err(|e| ClientError::Other(format!("create: {e}")))?;
            let mut total = 0u64;
            for i in 0..self.chunks {
                tokio::time::sleep(self.chunk_interval).await;
                use std::io::Write;
                f.write_all(format!("chunk-{i};").as_bytes())
                    .map_err(|e| ClientError::Other(format!("write: {e}")))?;
                total += 8;
            }
            Ok(DownloadOutcome {
                message_id,
                path: path.to_string_lossy().into_owned(),
                bytes: total,
                content_hash: None,
                dedup: false,
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

    /// 慢流夹具状态（同 `cache_fixture_state` 的构造纪律）。
    async fn trickle_fixture_state(
        dir: &std::path::Path,
        trickle: Vec<i64>,
        interval: std::time::Duration,
        chunks: usize,
        msgs: Vec<TgMedia>,
    ) -> (
        Arc<AppState>,
        Arc<std::sync::Mutex<HashMap<i64, usize>>>,
    ) {
        trickle_fixture_state_in(
            dir,
            ":memory:",
            trickle,
            interval,
            chunks,
            msgs,
            Arc::new(std::sync::Mutex::new(HashMap::new())),
        )
        .await
    }

    /// 同 [`trickle_fixture_state`]，但**库位置与调用计数器由调用方给定**。
    ///
    /// BUG-276 用它模拟「重启」：每次重启都 `Store::open` **同一个文件库**并构造
    /// 全新 `AppState`（新进程 ⇒ 新的 `Instant` 时基），唯一跨重启存活的东西只有
    /// 那个 db 文件 —— 若累计墙钟落在进程里，本用例必 FAIL。
    /// 计数器共享则是为了观测「第 N 次尝试到底有没有真的发起下载」。
    #[allow(clippy::too_many_arguments)]
    async fn trickle_fixture_state_in(
        dir: &std::path::Path,
        db: &str,
        trickle: Vec<i64>,
        interval: std::time::Duration,
        chunks: usize,
        msgs: Vec<TgMedia>,
        calls: Arc<std::sync::Mutex<HashMap<i64, usize>>>,
    ) -> (
        Arc<AppState>,
        Arc<std::sync::Mutex<HashMap<i64, usize>>>,
    ) {
        let mut by_id = HashMap::new();
        for m in msgs {
            by_id.insert(m.id, m);
        }
        let mut cfg = Config::default();
        cfg.download_dir = dir.to_path_buf();
        let st = Arc::new(AppState::new(
            Arc::new(TrickleClient {
                chat_id: CACHE_FIXTURE_CHAT,
                msgs: by_id,
                trickle,
                chunk_interval: interval,
                chunks,
                download_calls: calls.clone(),
            }),
            cfg,
            Availability::Ready,
            false,
            Store::open(db).await.expect("store must open"),
        ));
        pin_download_dir(&st, dir).await;
        (st, calls)
    }

    fn trickle_msgs() -> Vec<TgMedia> {
        vec![
            fixture_msg(1, "video", "video/mp4", Some("某剧 EP01"), None),
            fixture_msg(2, "video", "video/mp4", Some("某剧 EP02"), None),
            fixture_msg(3, "video", "video/mp4", Some("某剧 EP03"), None),
        ]
    }

    /// BUG-271 判据 1：慢流（chunk 间隔 ≪ 空闲阈值）在**墙钟内**判失败，且**不弃单**。
    ///
    /// 「每 89s 来 1 chunk」在生产不可测（30min 档要等半小时），按语义等比缩小：
    /// 每 120ms 来 1 chunk（≪ 90s 空闲 ⇒ 空闲档永不触发，证明这确实是「慢」不是
    /// 「死」）、共 6 块 ≈ 0.72s（≫ 墙钟 0.4s，经 `download_item_max_secs` 设置注入）。
    /// 期望：条目 2 被墙钟判失败、条目 1/3 照常处理（done=2）、汇总只列条目 2、
    /// 原因串为「too slow」而非「no bytes for」——两种病两种话。
    #[tokio::test]
    async fn trickle_stream_hits_the_wall_clock_without_abandoning_the_rest() {
        let dir = scratch_dir("bug271_trickle_wall");
        let (st, calls) =
            trickle_fixture_state(&dir, vec![2], std::time::Duration::from_millis(120), 6, trickle_msgs())
                .await;
        // 墙钟经 app_setting 注入（判据 3：改设置即生效，无需重编译）。
        st.store.set_setting("download_item_max_secs", "0.4").await.unwrap();
        let task = enqueue_fixture_task(&st, &[1, 2, 3], None).await;

        let t0 = std::time::Instant::now();
        run_one_cache_task(&st, task.id).await;
        let elapsed = t0.elapsed();

        let t = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(t.status, "failed", "超墙钟条目须判失败（失败隔离通道）");
        assert_eq!(
            t.done, 2,
            "条目 2 超墙钟 ⇒ done 停在 2；若为 3 说明墙钟没起作用（判据 1 FAIL）"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "慢流必须在墙钟内被掐断（实测 {elapsed:?}），而不是等它自己下完/等满空闲阈值"
        );
        // 条目 2 确实启动过（夹具前提），但没跑完（若跑完 done 会是 3）。
        assert_eq!(calls.lock().unwrap_or_else(|e| e.into_inner()).get(&2).copied(), Some(1));

        // 不弃单：失败条目**之后**的条目照常入库。
        let id3 = st
            .store
            .item_id_by_ref("tg", "424242:3")
            .await
            .unwrap()
            .expect("条目 3 必须被处理（不弃单）");
        assert!(st.store.get_media_item(id3).await.unwrap().unwrap().file_path.is_some());

        // 原因串：与「no bytes for 90s」逐字可区分（判据 4 的引擎侧）。
        let err = t.error.expect("failed 任务须带汇总");
        assert!(err.starts_with("1/3 item(s) failed:"), "{err}");
        assert!(err.contains("424242:2"), "{err}");
        assert!(!err.contains("424242:1") && !err.contains("424242:3"), "{err}");
        assert!(
            err.contains("download too slow"),
            "超墙钟原因必须是「too slow」语义: {err}"
        );
        assert!(
            !err.contains("no bytes for") && !err.contains("download stalled"),
            "「慢」不得被说成「死」——空闲看门狗的原因串不许出现在这里: {err}"
        );
    }

    /// BUG-271 判据 2（反向证伪）：**墙钟够不着时**，同一条慢流会正常下完 ⇒ 任务
    /// `done`。这就是判据 1 在「去掉墙钟分支」后的形态——若有人删掉超时分支，
    /// 判据 1 的测试会退化成本测试的结果（done=3）而 FAIL，证明它测的确实是墙钟。
    ///
    /// 同时反证另一件事：全程 0.72s ≪ 90s 空闲阈值 ⇒ **空闲看门狗从未触发**，
    /// 「慢」不由「死」的判定捕获——两档缺一不可。
    #[tokio::test]
    async fn falsification_without_a_reachable_wall_the_trickle_completes_normally() {
        let dir = scratch_dir("bug271_trickle_no_wall");
        let (st, _calls) = trickle_fixture_state(
            &dir,
            vec![2],
            std::time::Duration::from_millis(120),
            6,
            trickle_msgs(),
        )
        .await;
        // 不设小墙钟：默认 30min（1800s）远超慢流总耗时 0.72s ⇒ 墙钟判据够不着。
        let task = enqueue_fixture_task(&st, &[1, 2, 3], None).await;
        run_one_cache_task(&st, task.id).await;

        let t = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(
            t.status, "done",
            "无（可及的）墙钟时慢流必须正常完成——空闲档不治「慢」"
        );
        assert_eq!(t.done, 3, "三条全部下完");
        assert!(t.error.is_none(), "done 任务不得残留原因");
    }

    /// BUG-271 判据 3：阈值链 app_setting > config(env) > 默认，改设置**无需重编译**；
    /// 解析失败回退、钳位防 0 值变相关掉看门狗。
    #[tokio::test]
    async fn download_limits_resolve_through_the_setting_chain() {
        let dir = scratch_dir("bug271_limits_chain");
        let (st, _calls) = trickle_fixture_state(&dir, vec![], std::time::Duration::from_millis(1), 1, vec![])
            .await;

        // 默认档：config 默认 == 类型默认（墙钟 30min、空闲 90s）。
        let d = download_limits(&st).await;
        assert_eq!(d.wall, std::time::Duration::from_secs(30 * 60));
        assert_eq!(d.idle, std::time::Duration::from_secs(90));

        // app_setting 覆盖 config（墙钟允许小数——测试与精细调节用）。
        st.store.set_setting("download_item_max_secs", "12.5").await.unwrap();
        st.store.set_setting("download_idle_max_secs", "300").await.unwrap();
        let d = download_limits(&st).await;
        assert_eq!(d.wall, std::time::Duration::from_secs_f64(12.5));
        assert_eq!(d.idle, std::time::Duration::from_secs(300));

        // 解析失败回退 config（绝不 panic、绝不静默取 0）。
        st.store.set_setting("download_item_max_secs", "abc").await.unwrap();
        assert_eq!(
            download_limits(&st).await.wall,
            std::time::Duration::from_secs(30 * 60)
        );

        // 钳位：0/负值不得把看门狗变相关掉（空闲 <5s 即「治死」档失效）。
        st.store.set_setting("download_item_max_secs", "0").await.unwrap();
        st.store.set_setting("download_idle_max_secs", "1").await.unwrap();
        let d = download_limits(&st).await;
        assert!(d.wall.as_secs_f64() >= 0.1, "墙钟钳位下限 0.1s");
        assert!(d.idle.as_secs_f64() >= 5.0, "空闲钳位下限 5s");
    }

    /// BUG-276：**重启不清零** —— 条目级墙钟必须是「累计值」而不是「每次尝试重新计」。
    ///
    /// 生产形态的等比缩小：生产里「3.6h 重启 16 次 ⇒ 30min 死线永不到期」；
    /// 这里是「墙钟 2s，每次尝试在 400ms 处被掐断」。两条硬约束：
    ///
    /// 1. **单次尝试够不着墙钟**：慢流一次跑完只要 1200ms（< 2000ms）⇒
    ///    只要计时被重置，任何一次不被打断的尝试都能下完 —— 反向证伪的支点。
    /// 2. **累计必须跨重启增长**：四次被掐断的尝试累计 ≈ 1.8s ⇒
    ///    最后一次只剩约 200ms 额度，跑不完 1200ms ⇒ 判失败。
    ///
    /// 四次运行 = 首次尝试 + **3 次「重启」**；每次重启都 `Store::open` 同一个
    /// **文件库**并构造全新 `AppState`（新进程 ⇒ 新的 `Instant` 时基），
    /// 唯一跨重启存活的只有那个 db 文件。掐断前先等条目 2 的下载**真的起跑**
    /// （夹具在 `download` 入口计数），否则机器一忙，掐断会落在启动开销上 ——
    /// 测的就不再是「尝试」了。
    ///
    /// **反向证伪**：把 `cache_one_bytes` 的计时改回 `timeout(limits.wall, download)`
    /// （= 每次尝试拿满一整档）⇒ 每次尝试只烧 400ms 就被掐断、累计永不达标
    /// ⇒ 最后一次重新起一次完整下载、1200ms 后正常完成 ⇒ `status` 为 `done`、
    /// `done` 为 3 ⇒ 下面两条断言必 FAIL。
    #[tokio::test]
    async fn wall_clock_accumulates_across_restarts_instead_of_resetting() {
        let dir = scratch_dir("bug276_wall_accum");
        // 库必须是**文件库**（跨「重启」共享状态），但落在 `%TEMP%`：D: 上
        // `Store::open` 实测 ~4s（该盘 fsync 慢），而本用例的墙钟判据是「跨重启
        // 累计」—— 启动开销本身就会把 2.0s 阈值烧过，随后三次重启根本跑不完
        // （2026-10-19 实测：boot1 打开库耗时 1.18s，条目在第二次重启前就已
        // 因累计超时被判失败）。夹具 DB 不是内容（媒体字节），不适用 C 盘禁用
        // 规则 —— 被禁的是下载根/库根这类**内容**落点，本用例的 `dir` 仍钉在
        // 非禁用盘上（见 `scratch_dir`）。
        let db_dir = std::env::temp_dir().join(format!("orig_routes_bug276_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&db_dir);
        std::fs::create_dir_all(&db_dir).unwrap();
        let db = db_dir.join("bug276.db").to_string_lossy().into_owned();
        let calls = Arc::new(std::sync::Mutex::new(HashMap::new()));
        // 墙钟 2s；慢流 240ms × 5 块 = 1200ms 跑完（**<** 墙钟 ⇒ 不被打断就一定下得完，
        // 这是反向证伪的支点）；每次尝试掐断在 400ms（≪ 1200ms ⇒ 单次够不着墙钟）。
        const SLICE: std::time::Duration = std::time::Duration::from_millis(400);
        const CHUNK: std::time::Duration = std::time::Duration::from_millis(240);
        const CHUNKS: usize = 5;

        /// 一次「进程启动」：全新 AppState（新 `Instant` 时基）+ 同一个文件库。
        async fn trickle_boot(
            dir: &std::path::Path,
            db: &str,
            calls: &Arc<std::sync::Mutex<HashMap<i64, usize>>>,
        ) -> Arc<AppState> {
            trickle_fixture_state_in(
                dir,
                db,
                vec![2],
                CHUNK,
                CHUNKS,
                trickle_msgs(),
                calls.clone(),
            )
            .await
            .0
        }

        // ① 入队 + 首次尝试：等条目 2 的下载**真的起跑**，再烧 `SLICE`，然后把整个
        //    future drop（= 进程被杀，传输中断）。
        let task_id = {
            let st = trickle_boot(&dir, &db, &calls).await;
            // 墙钟经 app_setting 注入（判据 4：阈值链 `app_setting > env > 默认` 不变）。
            st.store.set_setting("download_item_max_secs", "2.0").await.unwrap();
            let task = enqueue_fixture_task(&st, &[1, 2, 3], None).await;
            let fut = run_one_cache_task(&st, task.id);
            tokio::pin!(fut);
            // 先等起跑：机器忙时启动开销可能吃掉整个 SLICE，掐断就会落空。
            let started = loop {
                let seen = calls
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&2)
                    .copied()
                    .unwrap_or(0);
                if seen >= 1
                    || !st.store.is_cache_task_active(task.id).await.unwrap_or(false)
                {
                    break seen >= 1;
                }
                tokio::select! {
                    _ = &mut fut => break false,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {}
                }
            };
            assert!(started, "首次尝试必须真的发起过下载");
            tokio::time::sleep(SLICE).await;
            drop(fut);
            task.id
        };

        // ② 三次「重启」：每轮都掐断在 `SLICE` ⇒ 累计单调增长。
        //    每轮先等本次尝试起跑，再读累计：只要任务还在队里，累计就必须**比上一轮
        //    更大** —— 这是「重启没有把计时清零」的直接证据。
        let mut prev: i64 = 0;
        let mut restarts: usize = 0;
        for i in 0..3 {
            let attempt = i + 2;
            let st = trickle_boot(&dir, &db, &calls).await;
            let fut = run_one_cache_task(&st, task_id);
            tokio::pin!(fut);
            let started = loop {
                let seen = calls
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&2)
                    .copied()
                    .unwrap_or(0);
                if seen >= attempt
                    || !st.store.is_cache_task_active(task_id).await.unwrap_or(false)
                {
                    break seen >= attempt;
                }
                tokio::select! {
                    _ = &mut fut => break false,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {}
                }
            };
            restarts += 1;
            if started {
                tokio::time::sleep(SLICE).await;
            }
            drop(fut);
            if !started {
                // 累计已在上一轮达标 ⇒ 条目已判失败；终态随即回收累计（读回 0）
                // ⇒ 单调性无从比较，收尾即可。
                break;
            }
            // 只在任务仍在队里时比较：一旦离队，`finish_cache_task` 已回收累计。
            if st.store.is_cache_task_active(task_id).await.unwrap_or(false) {
                let burned = st.store.item_wall_elapsed_ms(task_id, 2).await.unwrap_or(0);
                assert!(
                    burned > prev,
                    "第 {} 次重启后累计墙钟必须比上一轮更大（上一轮 {prev}ms，本轮 {burned}ms）\
                     —— 若被清零就退回了 BUG-276 的缺陷原形",
                    i + 1
                );
                prev = burned;
            }
        }
        assert!(restarts >= 3, "本用例必须重启 ≥3 次（实测 {restarts}）");
        assert!(
            prev >= 300,
            "跨重启累计必须已显著增长（实测 {prev}ms）—— 若为 0 说明计时又落回进程内"
        );

        // ③ 最后一次「重启」后不再打断：跑到终态。
        //    累计 ≈ 1.8s ⇒ 只剩约 200ms 额度，跑不完 1200ms 的慢流 ⇒ 判失败。
        let st = trickle_boot(&dir, &db, &calls).await;
        let t0 = std::time::Instant::now();
        run_one_cache_task(&st, task_id).await;
        let elapsed = t0.elapsed();

        let t = st.store.get_cache_task(task_id).await.unwrap().unwrap();
        assert_eq!(
            t.status, "failed",
            "累计超墙钟的条目必须判失败（走 BUG-271 失败隔离通道）"
        );
        assert_eq!(
            t.done, 2,
            "条目 2 累计超墙钟 ⇒ done 停在 2；若为 3 说明墙钟被重启清零了（判据 1 FAIL）"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "最后一次运行只应烧掉剩余额度（实测 {elapsed:?}）"
        );
        // 原因串：与「no bytes for 90s」逐字可区分（BUG-271 判据 4 的引擎侧）。
        let err = t.error.expect("failed 任务须带汇总");
        assert!(err.starts_with("1/3 item(s) failed:"), "{err}");
        assert!(err.contains("424242:2"), "{err}");
        assert!(!err.contains("424242:1") && !err.contains("424242:3"), "{err}");
        assert!(err.contains("download too slow"), "{err}");
        assert!(
            !err.contains("no bytes for") && !err.contains("download stalled"),
            "「慢」不得被说成「死」: {err}"
        );
        // 不弃单：失败条目**之后**的条目照常入库。
        let id3 = st
            .store
            .item_id_by_ref("tg", "424242:3")
            .await
            .unwrap()
            .expect("条目 3 必须被处理（不弃单）");
        assert!(st.store.get_media_item(id3).await.unwrap().unwrap().file_path.is_some());
        // 夹具前提：条目 2 确实被反复重试过（每次「重启」都真的重新发起了下载）。
        let attempts = calls.lock().unwrap_or_else(|e| e.into_inner()).get(&2).copied().unwrap_or(0);
        assert!(
            attempts >= 2,
            "条目 2 必须被多次重试（实测 {attempts} 次）—— 否则本用例没有在测重启路径"
        );
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

    /// BUG-221 判据 a：running 且字节已推进 ⇒ 注入**具体**的 `progressAt`（ms epoch）
    /// 与 `progressBytes`/`progressBytesTotal`。
    ///
    /// 「具体」是关键：`progressAt` 若退化成 0/缺失，前端就只剩 `updated_at`
    /// （只在消息边界写）可看 —— 大文件下载数分钟期间它不动，用户只能判定「卡死」。
    #[tokio::test]
    async fn progress_heartbeat_is_injected_while_bytes_advance() {
        let dir = scratch_dir("bug221_heartbeat");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(1, "video", "video/mp4", Some("EP01"), None)],
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1], None).await;
        let _ = st.store.mark_cache_task_running(task.id).await;
        st.refresh_cache_tasks().await;

        // 起步（未收字节）：**不得**注入 —— 没起步不等于卡住，此时报心跳是假信号。
        st.cache_dl_begin(task.id);
        st.cache_dl.set_total(200);
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        assert!(
            task_json.get("progressAt").is_none(),
            "一个字节都还没推进时不得注入心跳（否则「未起步」会被当成「刚动过」）"
        );
        assert!(
            task_json.get("progressBytes").is_none(),
            "零字节时不得注入 progressBytes"
        );

        // 真正推进：注入具体毫秒值（不是 0，不是缺失）。
        st.cache_dl.add_bytes(80);
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        let at = task_json
            .get("progressAt")
            .and_then(|v| v.as_u64())
            .expect("running 且有字节推进时必须注入 progressAt");
        assert!(
            at > 1_600_000_000_000,
            "progressAt 必须是具体的 ms epoch 值，实际: {at}"
        );
        assert_eq!(
            task_json.get("progressBytes").and_then(|v| v.as_u64()),
            Some(80),
            "已收字节必须如实下发"
        );
        assert_eq!(
            task_json.get("progressBytesTotal").and_then(|v| v.as_u64()),
            Some(200),
            "总量已知时必须下发，供前端算百分比"
        );

        // 再次推进：心跳必须跟着往前走（「恢复推进」在服务端是可观测的）。
        let before = at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        st.cache_dl.add_bytes(40);
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        let after = task_json
            .get("progressAt")
            .and_then(|v| v.as_u64())
            .expect("继续推进后仍须有心跳");
        assert!(
            after >= before,
            "心跳必须单调前移：before={before} after={after}"
        );
        assert_eq!(
            task_json.get("progressBytes").and_then(|v| v.as_u64()),
            Some(120),
            "字节必须累加下发"
        );

        // 解绑（条目结束/切走）：心跳不得再归属本任务。
        st.cache_dl_end();
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        assert!(
            task_json.get("progressAt").is_none(),
            "解绑后不得再注入 progressAt（旧心跳不得错配）"
        );
    }

    /// BUG-221 判据 b：总量未知（total == 0）时**仍要**下发已收字节，
    /// `progressBytesTotal` 显式为 `null` —— 「未知总量」不得退化成「无数据」。
    #[tokio::test]
    async fn progress_bytes_survive_unknown_total() {
        let dir = scratch_dir("bug221_unknown_total");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(1, "video", "video/mp4", Some("EP01"), None)],
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1], None).await;
        let _ = st.store.mark_cache_task_running(task.id).await;
        st.refresh_cache_tasks().await;

        st.cache_dl_begin(task.id);
        // 不 set_total：模拟「开流了但服务端还没拿到 Content-Length」。
        st.cache_dl.add_bytes(4096);
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        assert_eq!(
            task_json.get("progressBytes").and_then(|v| v.as_u64()),
            Some(4096),
            "总量未知也必须如实下发已收字节"
        );
        assert!(
            task_json
                .get("progressBytesTotal")
                .map(|v| v.is_null())
                .unwrap_or(false),
            "总量未知时 progressBytesTotal 必须是显式的 null，实际: {:?}",
            task_json.get("progressBytesTotal")
        );
        assert!(
            task_json.get("itemBytes").is_none(),
            "总量未知时仍不注入 itemBytes（0/0 的分母没有意义）"
        );
    }

    /// BUG-221 判据 c：非 running 的任务**不**注入心跳。
    ///
    /// 排队任务挂着旧条目的字节是错配的常见形态：心跳一旦越界，前端会对一个
    /// 还没开工的任务报「已 N 秒无进展」。
    #[tokio::test]
    async fn progress_heartbeat_is_not_injected_for_queued_task() {
        let dir = scratch_dir("bug221_queued");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(1, "video", "video/mp4", Some("EP01"), None)],
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1], None).await;
        // 故意**不**置 running：任务仍是 queued。
        st.refresh_cache_tasks().await;
        assert_eq!(
            st.cache_tasks_snapshot().await.first().map(|t| t.status.clone()),
            Some("queued".to_string()),
            "前置：任务须处于 queued"
        );

        st.cache_dl_begin(task.id);
        st.cache_dl.set_total(100);
        st.cache_dl.add_bytes(50);
        let resp = cache_tasks_payload(&st).await;
        let task_json = resp.get("task").cloned().expect("task field present");
        assert!(
            task_json.get("progressAt").is_none(),
            "排队任务不得注入心跳"
        );
        assert!(
            task_json.get("progressBytes").is_none(),
            "排队任务不得注入字节进度"
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

    /// BUG-257 方向 3（裁定 2026-10-10）：**一条条目失败不得终止整个任务**。
    ///
    /// 旧行为：`Err` 分支立刻 `finish_cache_task("failed")` + `return` —— 9 条任务
    /// 第 2 条卡死 ⇒ 剩下 7 条**从未尝试**（实测 done=2/9 且整条 failed）。
    /// 判据：3 条任务、第 2 条失败 ⇒ 终态 `failed`、`done=2`、**条目 3 仍被处理**
    /// （在库、有字节），汇总 error 列出且只列出失败条目。
    #[tokio::test]
    async fn item_failure_is_isolated_and_remaining_items_still_process() {
        let dir = scratch_dir("bug257_isolate");
        let (st, _calls) = cache_fixture_state_counted(
            &dir,
            vec![2],
            vec![
                fixture_msg(1, "video", "video/mp4", Some("某剧 EP01"), None),
                fixture_msg(2, "video", "video/mp4", Some("某剧 EP02"), None),
                fixture_msg(3, "video", "video/mp4", Some("某剧 EP03"), None),
            ],
            false,
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1, 2, 3], None).await;
        run_one_cache_task(&st, task.id).await;

        let t = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(
            t.status, "failed",
            "有失败 ⇒ 任务 failed（部分失败 = failed 的既有状态语义，不新增状态值）"
        );
        assert_eq!(
            t.done, 2,
            "条目 1/3 必须处理完 —— 旧实现会在第 2 条处整体终止，done 停在 1"
        );

        // 核心判据：失败条目**之后**的条目不再被放弃。
        let id3 = st
            .store
            .item_id_by_ref("tg", "424242:3")
            .await
            .unwrap()
            .expect("条目 3 必须被处理（旧实现在条目 2 处 return，它从未被尝试）");
        let it3 = st.store.get_media_item(id3).await.unwrap().unwrap();
        assert!(it3.file_path.is_some(), "条目 3 必须有字节");

        // 汇总 error：列出且**只列出**失败条目（这就是「哪几条失败了」的答案）。
        let err = t.error.expect("failed 任务必须带汇总原因");
        assert!(
            err.starts_with("1/3 item(s) failed:"),
            "汇总前缀须是 N/M item(s) failed:（前端据此原样展示）: {err}"
        );
        assert!(err.contains("424242:2"), "汇总须列出失败条目: {err}");
        assert!(
            !err.contains("424242:1") && !err.contains("424242:3"),
            "汇总不得把成功条目也列进去: {err}"
        );
        assert!(
            err.contains("injected download failure"),
            "汇总须带短原因: {err}"
        );
    }

    /// BUG-257 方向 3 的**关键另一半**：重试幂等必须实测，不能凭「代码读起来像」。
    ///
    /// 对失败任务走真实 retry 路径（`retry_cache_task` 复位 → worker 重跑）：
    /// - 已成功条目（1/3）**不得再次下载**——`cached_path()`（DB 标志 且 文件存在）
    ///   直接跳过，download 计数不涨；
    /// - 只有失败条目（2）重新走下载；
    /// - `media_item` 不产生重复行（T0 登记按 ref 幂等）。
    #[tokio::test]
    async fn retry_reruns_only_the_failed_items_and_never_duplicates_rows() {
        let dir = scratch_dir("bug257_retry_idempotent");
        let (st, calls) = cache_fixture_state_counted(
            &dir,
            vec![2],
            vec![
                fixture_msg(1, "video", "video/mp4", Some("某剧 EP01"), None),
                fixture_msg(2, "video", "video/mp4", Some("某剧 EP02"), None),
                fixture_msg(3, "video", "video/mp4", Some("某剧 EP03"), None),
            ],
            false,
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1, 2, 3], None).await;
        run_one_cache_task(&st, task.id).await;

        // 基线：首轮下载计数 = 每条各一次；登记各一行。
        let refs: Vec<String> = (1..=3).map(|m| format!("{CACHE_FIXTURE_CHAT}:{m}")).collect();
        let ids_before = {
            let mut v = Vec::new();
            for r in &refs {
                v.push(
                    st.store
                        .item_id_by_ref("tg", r)
                        .await
                        .unwrap()
                        .unwrap_or_default(),
                );
            }
            v
        };
        assert_eq!(
            calls.lock().unwrap_or_else(|e| e.into_inner()).get(&1).copied(),
            Some(1),
            "前置：条目 1 首轮恰好下载一次"
        );

        // 真实 retry 路径的 store 步骤（与 retry_task_kernel 同一语句）：
        // status→queued、done→0、error→NULL。worker 随后重跑同一条任务。
        let retried = st
            .store
            .retry_cache_task(task.id)
            .await
            .unwrap()
            .expect("failed 任务必须可 retry");
        assert_eq!(retried.status, "queued");
        run_one_cache_task(&st, task.id).await;

        let g = calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            (g.get(&1).copied(), g.get(&3).copied()),
            (Some(1), Some(1)),
            "已成功条目在 retry 后**不得**重新下载 —— 这是「重试不重复下载」的硬判据"
        );
        assert_eq!(
            g.get(&2).copied(),
            Some(2),
            "只有失败条目重新走下载（恰好再试一次，不是 N 次）"
        );
        drop(g);

        for (r, before) in refs.iter().zip(&ids_before) {
            assert_eq!(
                count_rows(&st, r).await,
                1,
                "条目 {r} 在重试后仍只能有一行 —— 重复登记 = 重复卡片"
            );
            let now = st.store.item_id_by_ref("tg", r).await.unwrap().unwrap();
            assert_eq!(now, *before, "重试必须命中同一行（upsert 幂等），不得新建");
        }

        // 条目 2 仍失败（永久故障模型）⇒ 终态仍是 failed，但 done 仍是 2 且
        // 汇总只含条目 2 —— 重试没有把任务变得更糟。
        let t = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(t.status, "failed");
        assert_eq!(t.done, 2);
        let err = t.error.unwrap_or_default();
        assert!(err.contains("424242:2") && !err.contains("424242:1"), "{err}");
    }

    /// 瞬时故障模型：重试后失败条目**恢复成功** ⇒ 任务到 `done`，且成功条目
    /// **依旧零重下**。这半边证明「重试」是真实的出路，而不是永远 failed 的死循环。
    #[tokio::test]
    async fn transient_failure_completes_on_retry_without_redownloading_successes() {
        let dir = scratch_dir("bug257_retry_transient");
        let (st, calls) = cache_fixture_state_counted(
            &dir,
            vec![2],
            vec![
                fixture_msg(1, "video", "video/mp4", Some("某剧 EP01"), None),
                fixture_msg(2, "video", "video/mp4", Some("某剧 EP02"), None),
                fixture_msg(3, "video", "video/mp4", Some("某剧 EP03"), None),
            ],
            true, // 第 2 条只第一次失败：模拟「网络抖了一下」
        )
        .await;
        let task = enqueue_fixture_task(&st, &[1, 2, 3], None).await;
        run_one_cache_task(&st, task.id).await;
        assert_eq!(
            st.store.get_cache_task(task.id).await.unwrap().unwrap().status,
            "failed",
            "前置：首轮因条目 2 失败"
        );

        st.store.retry_cache_task(task.id).await.unwrap().unwrap();
        run_one_cache_task(&st, task.id).await;

        let t = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(t.status, "done", "瞬时故障清除后，重试必须让任务走到 done");
        assert_eq!(t.done, 3, "三条全部就位");
        assert!(t.error.is_none(), "done 任务不得残留失败原因");

        let g = calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            (g.get(&1).copied(), g.get(&3).copied()),
            (Some(1), Some(1)),
            "恢复重试同样不得重下已成功条目"
        );
        assert_eq!(g.get(&2).copied(), Some(2), "只有条目 2 被重下");
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

                        m.file_name.as_deref(),
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

    // ---- BUG-117：原图必须是真原图，且内容域不越界调传输域 ----

    use super::{media_item_raw, resolve_raw_locator, RawLocator};

    /// 原图 vs 缩略图的**可区分**字节：判据要能证明「给的是原图，不是缩略图」。
    const FULL_SIZE_BYTES: &[u8] = b"FULL-SIZE-ORIGINAL-JPEG-BYTES";
    const THUMB_BYTES: &[u8] = b"thumb";

    /// BUG-117 夹具：`media()`（原图）与 `thumb()`（缩略图）给**可区分**的字节，
    /// 并分别计数 —— 判据因此能证明「走的是原图通道，且绝不碰缩略图通道」。
    struct PhotoSourceClient {
        full_size: Vec<u8>,
        /// `media()` 返回 Err 时的模拟失败（用于「取不到原图必须如实报错」）。
        media_fails: bool,
        media_calls: Arc<std::sync::Mutex<Vec<(i64, i64)>>>,
        thumb_calls: Arc<std::sync::Mutex<Vec<(i64, i64)>>>,
    }

    #[async_trait::async_trait]
    impl Client for PhotoSourceClient {
        async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::CodeRequired)
        }
        async fn submit_code(&self, _p: &str, _c: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::Authorized)
        }
        async fn submit_password(&self, _p: &str, _w: &str) -> Result<LoginPhase, ClientError> {
            Err(ClientError::Other("no 2FA in BUG-117 fixture".into()))
        }
        async fn view(&self) -> SessionView {
            SessionView {
                phase: LoginPhase::Authorized,
                phone: None,
                user_id: None,
            }
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
        /// 缩略图通道：**只**用于列表海报。原图路径一旦碰它，判据即失败。
        async fn thumb(
            &self,
            chat_id: i64,
            message_id: i64,
        ) -> Result<Option<Thumbnail>, ClientError> {
            self.thumb_calls
                .lock()
                .unwrap()
                .push((chat_id, message_id));
            Ok(Some(Thumbnail {
                content_type: "image/jpeg".to_string(),
                bytes: THUMB_BYTES.to_vec(),
            }))
        }
        /// 原图通道：整段字节（夹具不实现区间，Range 判据另行用纯函数覆盖）。
        async fn media(
            &self,
            chat_id: i64,
            message_id: i64,
            _range: Option<MediaRange>,
        ) -> Result<MediaStream, ClientError> {
            self.media_calls.lock().unwrap().push((chat_id, message_id));
            if self.media_fails {
                return Err(ClientError::MediaNotFound);
            }
            let n = self.full_size.len() as u64;
            // 先把字节移出`self`：`MediaStream.body`要求`'static`流，
            // 不能让async块借用`&self`。
            let bytes = self.full_size.clone();
            Ok(MediaStream {
                content_type: "image/jpeg".to_string(),
                total_size: Some(n),
                start: 0,
                end: n.saturating_sub(1),
                body: Box::pin(futures::stream::once(async move { Ok(bytes) })),
            })
        }
        async fn download(
            &self,
            _chat_id: i64,
            _message_id: i64,
            _dir: &str,
            _progress: Option<&crate::login::DownloadProgress>,
        ) -> Result<DownloadOutcome, ClientError> {
            Err(ClientError::Other("BUG-117 fixture: unused".into()))
        }
        async fn message_meta(
            &self,
            _chat_id: i64,
            _message_id: i64,
        ) -> Result<Option<TgMedia>, ClientError> {
            Ok(None)
        }
    }

    /// BUG-117 夹具状态：内存库 + 上述客户端；返回状态与两侧调用计数。
    #[allow(clippy::type_complexity)]
    async fn photo_source_state(
        media_fails: bool,
    ) -> (Arc<AppState>, Arc<std::sync::Mutex<Vec<(i64, i64)>>>, Arc<std::sync::Mutex<Vec<(i64, i64)>>>) {
        let media_calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let thumb_calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut cfg = Config::default();
        let dir = scratch_dir("bug117_photo_source");
        cfg.download_dir = dir.clone();
        let st = Arc::new(AppState::new(
            Arc::new(PhotoSourceClient {
                full_size: FULL_SIZE_BYTES.to_vec(),
                media_fails,
                media_calls: media_calls.clone(),
                thumb_calls: thumb_calls.clone(),
            }),
            cfg,
            Availability::Ready,
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        ));
        pin_download_dir(&st, &dir).await;
        (st, media_calls, thumb_calls)
    }

    /// 调用 `media_item_raw` 并把响应体收成字节（`Ok` 侧 `Response` 无 `Debug`，
    /// 故手写解构，同 `merge_call` / `recache_missing_call`）。
    async fn raw_call(
        st: Arc<AppState>,
        id: i64,
        headers: HeaderMap,
    ) -> Result<(StatusCode, axum::body::Bytes), (StatusCode, String)> {
        match media_item_raw(State(st), Path(id), headers).await {
            Ok(resp) => {
                let status = resp.status();
                let bytes = axum::body::to_bytes(resp.into_body(), 16 * 1024 * 1024)
                    .await
                    .expect("body must be readable");
                Ok((status, bytes))
            }
            Err(e) => Err((e.status, e.message().to_string())),
        }
    }

    /// **BUG-117 主判据**：未落盘的 TG 图片，`/raw` 必须返回**原图**字节，
    /// 且**绝不**返回缩略图字节。
    ///
    /// 这条直接钉住缺陷本体：修复前该分支调 `client.thumb()`，拿到的是
    /// `THUMB_BYTES`；修复后走 `client.media()`，必须是 `FULL_SIZE_BYTES`。
    #[tokio::test]
    async fn media_item_raw_returns_full_size_not_thumbnail_bug117() {
        let (st, media_calls, thumb_calls) = photo_source_state(false).await;
        let id = st
            .store
            .upsert_media_item(
                "tg",
                "424242:71",
                "photo",
                "photo",
                None, // file_path 为空 = 图片不落盘（BUG-115/121 拍板的常态）
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let (status, body) = raw_call(st.clone(), id, HeaderMap::new())
            .await
            .expect("未落盘图片必须仍能取到原图，而不是 404");

        assert_eq!(status, StatusCode::OK, "回源原图应 200");
        assert_eq!(
            body.as_ref(),
            FULL_SIZE_BYTES,
            "BUG-117：`/raw` 必须给**原图**字节，绝不能是缩略图字节"
        );
        assert_ne!(
            body.as_ref(),
            THUMB_BYTES,
            "BUG-117：缩略图不得顶替原图（「查看原图」这条路必须真的存在）"
        );
        // 分层判据：走的是原图通道，且缩略图通道一次都没被碰。
        assert_eq!(
            *media_calls.lock().unwrap(),
            vec![(424242, 71)],
            "必须向传输域取原图，且坐标取自 ref_key"
        );
        assert!(
            thumb_calls.lock().unwrap().is_empty(),
            "BUG-117：原图路径不得再调用缩略图通道"
        );
    }

    /// 反向判据：原图取不到时**如实报错**，不静默给缩略图充数（缺陷修复方向 3）。
    #[tokio::test]
    async fn media_item_raw_reports_error_instead_of_thumbnail_bug117() {
        let (st, _media_calls, thumb_calls) = photo_source_state(true).await;
        let id = st
            .store
            .upsert_media_item("tg", "424242:72", "photo", "photo", None, None, None, None)
            .await
            .unwrap();

        let (status, msg) = raw_call(st.clone(), id, HeaderMap::new())
            .await
            .expect_err("原图取不到必须报错，而不是退给缩略图");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(
            msg.contains("no local bytes"),
            "错误须如实说明「本地无字节且原图不可得」，实际：{msg}"
        );
        assert!(
            thumb_calls.lock().unwrap().is_empty(),
            "失败路径同样不得回退到缩略图"
        );
    }

    /// 已落盘条目仍走本地投递，**不回源**（回归护栏：修 BUG-117 不能把
    /// 「有本地字节」也改成在线取）。
    #[tokio::test]
    async fn media_item_raw_prefers_local_bytes_over_network_bug117() {
        let (st, media_calls, thumb_calls) = photo_source_state(false).await;
        // 已落盘条目必须落在**下载路径之内**（BUG-323：下载路径是所有权限的限制
        // 路径）—— 界外路径如今一律 403，夹具若另起一个临时目录就会撞上闸门。
        let dir = st.config.download_dir.clone();
        let f = dir.join("photo.jpg");
        std::fs::write(&f, b"LOCAL-FILE-BYTES").expect("seed local file");
        let id = st
            .store
            .upsert_media_item(
                "tg",
                "424242:73",
                "photo",
                "photo",
                Some(&f.to_string_lossy()),
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let (status, body) = raw_call(st.clone(), id, HeaderMap::new())
            .await
            .expect("已落盘条目必须可读");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_ref(), b"LOCAL-FILE-BYTES", "有本地字节就必须读本地");
        assert!(
            media_calls.lock().unwrap().is_empty() && thumb_calls.lock().unwrap().is_empty(),
            "已落盘时不得回源（原图与缩略图都不该被调用）"
        );
    }

    /// 定位判据（纯函数层，模块边界的直接钉子）：内容域只回答「字节在哪」。
    ///
    /// `resolve_raw_locator` 必须是**纯**的：它只读库行，不碰传输域 —— 这正是
    /// 「内容域不越界调传输域」在代码层的落点。
    #[test]
    fn resolve_raw_locator_localizes_bytes_without_transport_bug117() {
        let mut item = crate::media::MediaItem {
            id: 1,
            source: "tg".to_string(),
            ref_key: "424242:71".to_string(),
            title: "t".to_string(),
            source_title: None,
            description: None,
            kind: "photo".to_string(),
            file_path: Some("photos/a.jpg".to_string()),
            absolute_path: None,
            poster: None,
            size: None,
            duration: None,
            width: None,
            height: None,
            added_at: 0,
            tags: Vec::new(),
            series_id: None,
            series_title: None,
            series_season: None,
            series_episode_no: None,
            series_episode_no_end: None,
            series_episode_count: None,
            bytes_presence: crate::cache::BytesPresence::Present,
        };
        // 有本地字节 → 本地。
        assert_eq!(
            resolve_raw_locator(&item),
            RawLocator::LocalPath("photos/a.jpg".to_string())
        );
        // 空白 file_path 视为无字节（不得被当成有效路径去开文件）。
        item.file_path = Some("   ".to_string());
        assert_eq!(
            resolve_raw_locator(&item),
            RawLocator::TelegramPhoto {
                chat_id: 424242,
                message_id: 71
            }
        );
        // TG 图片无字节 → 回源原图坐标。
        item.file_path = None;
        assert_eq!(
            resolve_raw_locator(&item),
            RawLocator::TelegramPhoto {
                chat_id: 424242,
                message_id: 71
            }
        );
        // 非图片不提供回源：视频的在线流有自己的端点，这里只如实报缺。
        item.kind = "video".to_string();
        assert_eq!(resolve_raw_locator(&item), RawLocator::Unavailable);
        item.kind = "photo".to_string();
        // 非 TG 来源不回源（本地库条目没有传输域坐标）。
        item.source = "local".to_string();
        assert_eq!(resolve_raw_locator(&item), RawLocator::Unavailable);
        item.source = "tg".to_string();
        // 脏 ref（如 BUG-261 判据 4 的 "not-a-ref"）不得被当成坐标。
        item.ref_key = "not-a-ref".to_string();
        assert_eq!(resolve_raw_locator(&item), RawLocator::Unavailable);
    }

    // ---- BUG-261：剧集级「补缺」端点（POST /api/media/series/:id/recache-missing）----

    use super::{parse_tg_ref_coords, recache_series_missing};
    use super::recache_series_gap;

    /// 纯解析：`"chat:msg"` → 坐标；脏形态一律 None（路由侧据此进 skipped）。
    #[test]
    fn parse_tg_ref_coords_accepts_only_numeric_pairs() {
        assert_eq!(parse_tg_ref_coords("424242:71"), Some((424242, 71)));
        assert_eq!(parse_tg_ref_coords("-1001:55"), Some((-1001, 55)));
        assert_eq!(parse_tg_ref_coords(" -1002 : 77 "), Some((-1002, 77)));
        assert_eq!(parse_tg_ref_coords("not-a-ref"), None, "无冒号");
        assert_eq!(parse_tg_ref_coords("abc:1"), None, "chat 非数字");
        assert_eq!(parse_tg_ref_coords("100:"), None, "msg 非数字");
        assert_eq!(parse_tg_ref_coords(""), None, "空 ref");
    }

    /// 构造一个「已授权」的补缺路由夹具（`ensure_authorized` 要求 Available+Authorized）。
    async fn recache_missing_fixture_state() -> Arc<AppState> {
        let mut cfg = Config::default();
        cfg.download_dir = scratch_dir("bug261_recache_missing");
        Arc::new(AppState::new(
            Arc::new(CacheFixtureClient {
                chat_id: CACHE_FIXTURE_CHAT,
                msgs: HashMap::new(),
                fail_downloads: Vec::new(),
                fail_first_attempt_only: false,
                download_calls: Arc::new(std::sync::Mutex::new(HashMap::new())),
            }),
            cfg,
            Availability::Ready,
            false,
            Store::open(":memory:")
                .await
                .expect("in-memory store must open"),
        ))
    }

    /// 调用 `recache_series_missing` 并解构为 `(状态码, JSON)`（同 `merge_call` 的手写解构：
    /// `ApiError` / `impl IntoResponse` 都没有 `Debug`，不能 unwrap/expect_err）。
    async fn recache_missing_call(
        st: Arc<AppState>,
        id: i64,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, String)> {
        match recache_series_missing(State(st), Path(id)).await {
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

    /// 判据主体：2 集缺字节、tg ref 同 chat ⇒ 入队 **1 组**（一个任务含 2 条消息），
    /// 且任务保持 queued（worker 门禁被测试先占住，不真跑下载）。
    #[tokio::test]
    async fn recache_missing_groups_missing_episodes_by_chat_bug261() {
        let st = recache_missing_fixture_state().await;
        // 门禁先占住：路由里 spawn_cache_task 的 claim 会失败，任务保持 queued 可断言。
        assert!(st.claim_cache_worker(), "门禁初始必须空闲");
        let sid = st
            .store
            .create_series("补缺夹具", None, "series", None, None)
            .await
            .unwrap();
        let i1 = st
            .store
            .upsert_media_item("tg", "424242:71", "ep1", "video", None, None, None, None)
            .await
            .unwrap();
        let i2 = st
            .store
            .upsert_media_item("tg", "424242:72", "ep2", "video", None, None, None, None)
            .await
            .unwrap();
        let _ = st.store.add_episode(sid, i1, 1, 1).await.unwrap();
        let _ = st.store.add_episode(sid, i2, 1, 2).await.unwrap();

        let (status, v) = recache_missing_call(st.clone(), sid)
            .await
            .expect("route must respond");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["enqueued"], 2, "两集缺字节 ⇒ 2 条消息入队");
        assert_eq!(v["groups"], 1, "同 chat 聚成 1 组");
        assert_eq!(
            v["skipped"].as_array().map(|a| a.len()),
            Some(0),
            "没有该跳过的集"
        );

        let tasks = st.store.list_cache_tasks(10).await.unwrap();
        assert_eq!(tasks.len(), 1, "同 chat 一次任务（不是逐集 2 个）");
        assert_eq!(tasks[0].chat_id, 424242);
        assert_eq!(tasks[0].message_ids, vec![71, 72], "组内消息按序齐全");
        assert_eq!(tasks[0].status, "queued", "worker 未起，任务保持排队");
    }

    /// `recache_series_gap` 的调用解构（同 `recache_missing_call`）。
    async fn recache_gap_call(
        st: Arc<AppState>,
        id: i64,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, String)> {
        match recache_series_gap(State(st), Path(id)).await {
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

    /// D22-A②（BUG-296）：**按组清单真缺口**补缓存 —— 收「连条目都没有 / 已登记未编入」
    /// 的序号（`missing` + `registered_unslotted`），**排除挂图**。
    ///
    /// 反向证伪：把 `image_msgs` 过滤去掉 ⇒ 图（74）被当缺口，`enqueued` 从 2 变 3 ⇒ FAIL。
    /// 这正是 BUG-296 §复报补充的红线：不先减挂图会把「1 视频 + 9 图」错报成丢 9 集。
    #[tokio::test]
    async fn recache_gap_enqueues_unslotted_but_not_images_bug296() {
        let st = recache_missing_fixture_state().await;
        assert!(st.claim_cache_worker(), "门禁初始必须空闲");
        let chat = 424242i64;
        let key = format!("tg:named:{chat}:某剧");
        // 序号全集 = 71,72,73,74（由**同组键**任务的 items 给出；D22-A①）。
        st.store
            .conn
            .execute(
                "INSERT INTO cache_task (chat_id, group_id, item_key, items, total, done, status, created_at, updated_at)
                 VALUES (?1, NULL, ?2, ?3, 4, 4, 'done', 0, 0)",
                libsql::params![chat, key.clone(), serde_json::to_string(&[71, 72, 73, 74]).unwrap()],
            )
            .await
            .unwrap();
        let sid = st
            .store
            .create_series("某剧", None, "series", None, Some(&key))
            .await
            .unwrap();
        // 71 已编入（有槽位）。
        let i1 = st
            .store
            .upsert_media_item("tg", &format!("{chat}:71"), "ep1", "video", None, None, None, None)
            .await
            .unwrap();
        st.store.add_episode(sid, i1, 1, 1).await.unwrap();
        // 72 已登记未编入（视频）—— 应入队。
        st.store
            .upsert_media_item("tg", &format!("{chat}:72"), "ep2", "video", None, None, None, None)
            .await
            .unwrap();
        // 73 无条目 —— 应入队。
        // 74 是**挂图**（有 item 行 + media_episode_image 行、无槽位）—— 不得入队。
        let img = st
            .store
            .upsert_media_item("tg", &format!("{chat}:74"), "p", "photo", None, None, None, None)
            .await
            .unwrap();
        let ep_id = st
            .store
            .get_series(sid)
            .await
            .unwrap()
            .unwrap()
            .episodes[0]
            .id;
        st.store
            .conn
            .execute(
                "INSERT INTO media_episode_image (episode_id, item_id, sort_no, created_at) \
                 VALUES (?1, ?2, 0, 0)",
                libsql::params![ep_id, img],
            )
            .await
            .unwrap();

        let (status, v) = recache_gap_call(st.clone(), sid).await.expect("route must respond");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["enqueued"], 2, "缺口 = 72（已登记未编入）+ 73（无条目），挂图 74 不算");
        assert_eq!(v["groups"], 1, "同 chat 聚成 1 组");

        let tasks = st.store.list_cache_tasks(10).await.unwrap();
        // 预插的同键任务（status=done）也在表里，故只数**新建的 queued 任务**。
        let queued: Vec<_> = tasks.iter().filter(|t| t.status == "queued").collect();
        assert_eq!(queued.len(), 1, "同 chat 一次任务");
        assert_eq!(queued[0].message_ids, vec![72, 73], "只入队真缺口，且不含挂图 74");
    }

    /// 判据 4 的服务端半边：route 缺失（local 主源 / 脏 ref）的缺失集**必须**进
    /// skipped 并带原因，不得静默；此时不产生任何任务。
    #[tokio::test]
    async fn recache_missing_reports_skipped_without_route_bug261() {
        let st = recache_missing_fixture_state().await;
        assert!(st.claim_cache_worker());
        let sid = st
            .store
            .create_series("无路夹具", None, "series", None, None)
            .await
            .unwrap();
        let local = st
            .store
            .upsert_media_item("local", "C:/local/v.mp4", "ep1", "video", None, None, None, None)
            .await
            .unwrap();
        let dirty = st
            .store
            .upsert_media_item("tg", "not-a-ref", "ep2", "video", None, None, None, None)
            .await
            .unwrap();
        let _ = st.store.add_episode(sid, local, 1, 1).await.unwrap();
        let _ = st.store.add_episode(sid, dirty, 1, 2).await.unwrap();

        let (status, v) = recache_missing_call(st.clone(), sid)
            .await
            .expect("route must respond");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["enqueued"], 0, "无任何可缓存坐标 ⇒ 0 入队");
        assert_eq!(v["groups"], 0);
        let skipped = v["skipped"].as_array().expect("skipped array").clone();
        assert_eq!(skipped.len(), 2, "两条缺失集都要如实报缺");
        let ids: Vec<i64> = skipped
            .iter()
            .map(|x| x["itemId"].as_i64().expect("itemId"))
            .collect();
        assert!(ids.contains(&local) && ids.contains(&dirty), "ids={ids:?}");
        for s in &skipped {
            assert_eq!(
                s["reason"].as_str(),
                Some(super::NO_RECACHEABLE_REF_REASON),
                "每条 skipped 都必须带原因（不得静默）"
            );
        }
        assert!(
            st.store.list_cache_tasks(10).await.unwrap().is_empty(),
            "没有入队就不该有任务行"
        );
    }

    /// 全部有字节 ⇒ 0 入队 0 跳过（补缺是「补缺」，不重复搬运已有字节）。
    #[tokio::test]
    async fn recache_missing_is_noop_when_all_episodes_have_bytes_bug261() {
        let st = recache_missing_fixture_state().await;
        assert!(st.claim_cache_worker());
        let dir = scratch_dir("bug261_recache_missing_bytes");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("ep1.mp4");
        std::fs::write(&file, b"real bytes").unwrap();
        let sid = st
            .store
            .create_series("齐装夹具", None, "series", None, None)
            .await
            .unwrap();
        let item = st
            .store
            .upsert_media_item(
                "tg",
                "424242:81",
                "ep1",
                "video",
                Some(&file.to_string_lossy()),
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let _ = st.store.add_episode(sid, item, 1, 1).await.unwrap();

        let (status, v) = recache_missing_call(st.clone(), sid)
            .await
            .expect("route must respond");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["enqueued"], 0, "全有字节 ⇒ 0 入队");
        assert_eq!(v["groups"], 0);
        assert_eq!(v["skipped"].as_array().map(|a| a.len()), Some(0));
        assert!(st.store.list_cache_tasks(10).await.unwrap().is_empty());
    }

    /// 不存在的剧集 → 404（与 `GET /api/media/series/:id` 同一语义）。
    #[tokio::test]
    async fn recache_missing_404_for_unknown_series_bug261() {
        let st = recache_missing_fixture_state().await;
        assert!(st.claim_cache_worker());
        let (status, msg) = recache_missing_call(st.clone(), 987_654_321)
            .await
            .expect_err("unknown series must be 404");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(msg, "series not found");
    }

    // ---- BUG-248：入队即登记条目（「先入信息、再入字节」） ----

    use super::{
        cache_task_title, cache_task_titles, enqueue_cache_task, ensure_message_rows,
        register_enqueued_items, register_media_item_t0, strengthen_registered_item,
        EnqueueCacheReq,
    };

    /// 元数据**迟到**的客户端：`message_meta` 先睡 `delay_ms` 再给真值。
    ///
    /// 它复刻的是运行时实测到的病态（BUG-248 A/B 首轮）：MTProto 与下载争用时，
    /// 同一条消息的元数据要 **27s** 后才落 `media_message` 行。任何「等元数据齐了再登记」
    /// 的实现都会在这段窗口里让媒体库空着 —— 也就是用户投诉的原样。
    struct SlowMetaClient {
        meta: std::collections::HashMap<i64, TgMedia>,
        delay_ms: u64,
    }

    #[async_trait::async_trait]
    impl Client for SlowMetaClient {
        async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::CodeRequired)
        }
        async fn submit_code(&self, _p: &str, _c: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::Authorized)
        }
        async fn submit_password(&self, _p: &str, _w: &str) -> Result<LoginPhase, ClientError> {
            Err(ClientError::Other("no 2FA in BUG-248 fixture".into()))
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
            _chat_id: i64,
            _message_id: i64,
            _dir: &str,
            _progress: Option<&crate::login::DownloadProgress>,
        ) -> Result<DownloadOutcome, ClientError> {
            Err(ClientError::Other("BUG-248 fixture: no bytes".into()))
        }
        async fn message_meta(
            &self,
            _chat_id: i64,
            message_id: i64,
        ) -> Result<Option<TgMedia>, ClientError> {
            tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
            Ok(self.meta.get(&message_id).cloned())
        }
    }

    /// BUG-248 判据（运行时病态的回归）：**元数据迟到也不许拖住登记**。
    ///
    /// 登记必须在入队那一刻就发生（条目先到），标题/kind 等元数据到位后被**补强**，
    /// 而且这条路径不依赖 worker —— 队列可能要排几十分钟。
    #[tokio::test]
    async fn enqueue_registers_the_item_even_when_metadata_arrives_late() {
        let dir = scratch_dir("bug248_late_metadata");
        let mut by_id = std::collections::HashMap::new();
        by_id.insert(
            41,
            fixture_msg(41, "video", "video/mp4", Some("迟到的标题\n说明"), None),
        );
        let mut cfg = Config::default();
        cfg.download_dir = dir.to_path_buf();
        let st = Arc::new(AppState::new(
            Arc::new(SlowMetaClient { meta: by_id, delay_ms: 1200 }),
            cfg,
            Availability::Ready,
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        ));
        pin_download_dir(&st, &dir).await;
        assert!(st.claim_cache_worker(), "门禁初始必须空闲");

        let (status, task) = enqueue_call(
            st.clone(),
            EnqueueCacheReq {
                chat_id: CACHE_FIXTURE_CHAT,
                message_ids: vec![41],
                group_id: None,
                dir: None,
            },
        )
        .await
        .expect("元数据迟到不得阻断入队");
        assert_eq!(status, StatusCode::OK);
        let task_id = task["id"].as_i64().expect("task id");

        // ① 元数据还没回来，条目就必须已经在（短板事实：kind=file、标题空）。
        let ref_key = format!("{CACHE_FIXTURE_CHAT}:41");
        let id = wait_item_id(&st, &ref_key).await;
        let early = st.store.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(early.file_path, None, "T0 登记字节未落");
        assert_eq!(
            early.kind, "file",
            "元数据未到时只能判成 file（无常可言；后续一次ாக upgrade）"
        );
        assert!(
            early.title.trim().is_empty(),
            "拿不到 caption 就必须是空标题（BUG-154：不拿内部文件名伪装），实得 {early_title:?}",
            early_title = early.title
        );
        assert_eq!(
            st.store.get_cache_task(task_id).await.unwrap().unwrap().status,
            "queued",
            "登记这一步不等字节、不动任务状态"
        );

        // ② 元数据回库后（不等 worker）：标题/kind 被补强，且不产生第二行。
        wait_title(&st, id, "迟到的标题").await;
        let late = st.store.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(late.title, "迟到的标题", "标题必须被补强");
        assert_eq!(late.kind, "video", "kind 必须升级（file → video）");
        assert_eq!(late.description.as_deref(), Some("说明"));
        assert_eq!(late.duration, Some(12), "缺失的时长同样补齐");
        assert_eq!(late.file_path, None, "补强不碰字节");
        assert_eq!(count_rows(&st, &ref_key).await, 1, "补强不得产生第二行");
        assert_eq!(
            st.store.get_cache_task(task_id).await.unwrap().unwrap().status,
            "queued",
            "任务始终 queued（worker 没起）"
        );

        // ③ 已有的强事实不被改写：用户改过标题后再登记一次，标题保持用户值。
        let _ = st
            .store
            .update_media_item(
                id,
                &crate::media::ItemPatch {
                    title: Some("用户改过的标题".to_string()),
                    description: None,
                    poster: None,
                    duration: None,
                    width: None,
                    height: None,
                    kind: None,
                },
            )
            .await
            .unwrap();
        register_enqueued_items(&st, CACHE_FIXTURE_CHAT, &[41]).await;
        let kept = st.store.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(kept.title, "用户改过的标题", "补强不许覆盖用户已改的标题");
    }

    /// 轮询等待某条目被补强到目标标题（后台协程异步进行）。
    async fn wait_title(st: &AppState, id: i64, want: &str) {
        for _ in 0..200 {
            if let Ok(Some(it)) = st.store.get_media_item(id).await {
                if it.title == want {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("BUG-248: 条目 {id} 的标题应在 10s 内被补强为 {want:?}");
    }

    /// BUG-248 判据 1：**任务仍在 `queued`** 时条目必须已在媒体库里可查，
    /// 且字节未到（`file_path` 为 NULL）。缺陷原形下这一步要等 worker 轮到才开始，
    /// 排队期间 `item_id_by_ref` 恒为 None。
    #[tokio::test]
    async fn enqueue_registers_media_items_while_the_task_is_still_queued() {
        let dir = scratch_dir("bug248_enqueue_register");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![
                fixture_msg(11, "video", "video/mp4", Some("先登记的一集 标题行\n说明行"), None),
                fixture_msg(12, "photo", "image/jpeg", None, None),
            ],
        )
        .await;
        // 占住单飞门禁：新任务不会被 worker 拉起 ⇒ 真实复现「排队期间」。
        // worker 一旦启动就会自己去登记条目，那样本用例什么也证明不了。
        assert!(st.claim_cache_worker(), "门禁初始必须空闲");

        let (status, task) = enqueue_call(
            st.clone(),
            EnqueueCacheReq {
                chat_id: CACHE_FIXTURE_CHAT,
                message_ids: vec![11, 12],
                group_id: None,
                dir: None,
            },
        )
        .await
        .expect("入队不得因登记失败而报错");
        assert_eq!(status, StatusCode::OK);
        let task_id = task["id"].as_i64().expect("task id");
        assert_eq!(
            task["status"].as_str(),
            Some("queued"),
            "新入队任务此刻必须是 queued"
        );

        // 登记在后台协程里跑（同一 spawn：条目 → BUG-246 元数据 → 补强），轮询等它落地。
        let video_ref = format!("{CACHE_FIXTURE_CHAT}:11");
        let photo_ref = format!("{CACHE_FIXTURE_CHAT}:12");
        let video_id = wait_item_id(&st, &video_ref).await;
        let photo_id = wait_item_id(&st, &photo_ref).await;

        // 任务**仍然是 queued**（worker 没动过它）—— 这正是本条要的前时态。
        let live = st.store.get_cache_task(task_id).await.unwrap().unwrap();
        assert_eq!(live.status, "queued", "登记期间任务必须保持排队态");

        // 元数据到位前后都是同一条目（补强不是新建），故先把「字节未到」钉死。
        let seed = st.store.get_media_item(video_id).await.unwrap().unwrap();
        assert_eq!(seed.file_path, None, "T0 登记字节未落 ⇒ file_path 必须是 NULL");

        // 元数据（同一协程的第 ② 步）到位后被补强为与 worker 同一把尺子的 kind/标题。
        wait_title(&st, video_id, "先登记的一集 标题行").await;
        let video = st.store.get_media_item(video_id).await.unwrap().unwrap();
        assert_eq!(video.file_path, None, "补强不碰字节");
        assert_eq!(video.kind, "video", "kind 与 worker 同一把尺子（meta_kind）");
        assert_eq!(video.title, "先登记的一集 标题行", "标题取 caption 首行");
        assert_eq!(video.description.as_deref(), Some("说明行"));

        // BUG-362：无 caption 的照片兜底标题 = `{频道名} · 图片 #{msg_id}`。
        // 夹具没有为 424242 建监控频道 ⇒ `channel_title` 取不到 ⇒ 退回 `TG {chat_id}`
        // （与剧集命名同一把尺子）。旧口径 `TG 图片 #12` 已废：它在媒体库列表里
        // 与 `NanaZip_xxx.zip` / 真 caption 并排，五种题命名方式互相不可辨。
        wait_title(&st, photo_id, "TG 424242 · 图片 #12").await;
        let photo = st.store.get_media_item(photo_id).await.unwrap().unwrap();
        assert_eq!(photo.file_path, None);
        assert_eq!(photo.kind, "photo");
        assert_eq!(
            photo.title, "TG 424242 · 图片 #12",
            "photo 兜底标题口径必须与 worker 一致（BUG-049 / BUG-362）"
        );

        // 剧集槽位不在入队时刻登记（没有剧集上下文），worker 处理时才建。
        assert_eq!(
            video.series_id, None,
            "入队只登记事实，槽位归 worker（本用例 worker 未启动）"
        );
    }

    /// BUG-362：无 caption 的照片兜底标题必须带**频道名**。
    ///
    /// 用户 2026-10-21 原话：「样式混乱 "NanaZip_7.0.1843.0_Binaries.zip" 在第一行.
    /// TG弹窗标题在第二行」—— 媒体库列表里他要看的是**这条内容来自哪个 TG 会话**，
    /// 而旧兜底 `TG 图片 #{msg_id}` 只说了「这是 TG 的一张图」，会话名被抹成编号。
    ///
    /// 判据（反向证伪）：把频道名换成另一个值，标题必须跟着变 —— 证明频道名真的
    /// 进了标题，而不是碰巧等于某个常量。
    #[tokio::test]
    async fn photo_fallback_title_names_the_channel_bug362() {
        let dir = scratch_dir("bug362_photo_title_channel");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(31, "photo", "image/jpeg", None, None)],
        )
        .await;
        assert!(st.claim_cache_worker(), "占住单飞门禁：只测登记，不跑 worker");

        st.store
            .add_channel(CACHE_FIXTURE_CHAT, "每日沙雕墙", Some("woshadiao"))
            .await
            .expect("夹具频道必须可建");

        let (status, _task) = enqueue_call(
            st.clone(),
            EnqueueCacheReq {
                chat_id: CACHE_FIXTURE_CHAT,
                message_ids: vec![31],
                group_id: None,
                dir: None,
            },
        )
        .await
        .expect("入队不得因登记失败而报错");
        assert_eq!(status, StatusCode::OK);

        let ref_key = format!("{CACHE_FIXTURE_CHAT}:31");
        let id = wait_item_id(&st, &ref_key).await;
        let item = st.store.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(
            item.title, "每日沙雕墙 · 图片 #31",
            "兜底标题必须带频道名（BUG-362）：取不到才退 TG {{chat_id}}"
        );
        assert_ne!(
            item.title, "TG 424242 · 图片 #31",
            "反向证伪：频道名在场时不得退化成 chat_id"
        );

        // 频道名变化 ⇒ 标题里的频道名必须跟着变（证明它真的来自频道表）。
        st.store
            .add_channel(CACHE_FIXTURE_CHAT, "另一个频道", None)
            .await
            .expect("改标题必须幂等");
        // 已坐实的标题不被改写（保守规则：只补空标题），故这里只证**新登记**走新名。
        let dir2 = scratch_dir("bug362_photo_title_channel_renamed");
        let st2 = cache_fixture_state(
            &dir2,
            vec![],
            vec![fixture_msg(41, "photo", "image/jpeg", None, None)],
        )
        .await;
        st2.store
            .add_channel(CACHE_FIXTURE_CHAT, "另一个频道", None)
            .await
            .expect("夹具频道必须可建");
        let (status2, _t2) = enqueue_call(
            st2.clone(),
            EnqueueCacheReq {
                chat_id: CACHE_FIXTURE_CHAT,
                message_ids: vec![41],
                group_id: None,
                dir: None,
            },
        )
        .await
        .expect("入队不得因登记失败而报错");
        assert_eq!(status2, StatusCode::OK);
        let id2 = wait_item_id(&st2, &format!("{CACHE_FIXTURE_CHAT}:41")).await;
        let item2 = st2.store.get_media_item(id2).await.unwrap().unwrap();
        assert_eq!(
            item2.title, "另一个频道 · 图片 #41",
            "频道名必须真的进标题（换名即换题）"
        );
    }

    /// BUG-248 判据 2：重复入队 / 已存在条目**不产生第二行**（幂等）。
    /// 元数据标题缺失的行**不**在此伪造：`EnsureItemRows` 跳过无元数据的消息，
    /// 交给 worker 补齐后登记（避免空标题被首次登记坐实）。
    #[tokio::test]
    async fn repeated_enqueue_never_creates_a_second_media_item() {
        let dir = scratch_dir("bug248_enqueue_idempotent");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(21, "video", "video/mp4", Some("幂等条目"), None)],
        )
        .await;
        assert!(st.claim_cache_worker());

        let first = enqueue_call(
            st.clone(),
            EnqueueCacheReq {
                chat_id: CACHE_FIXTURE_CHAT,
                message_ids: vec![21],
                group_id: None,
                dir: None,
            },
        )
        .await
        .expect("首次入队必须成功");
        let first_id = first.1["id"].as_i64().unwrap();
        let ref_key = format!("{CACHE_FIXTURE_CHAT}:21");
        let item = wait_item_id(&st, &ref_key).await;

        // 第二次入队：同 key ⇒ 复用活跃任务，登记协程再跑一遍。
        for _ in 0..3 {
            let (_, again) = enqueue_call(
                st.clone(),
                EnqueueCacheReq {
                    chat_id: CACHE_FIXTURE_CHAT,
                    message_ids: vec![21],
                    group_id: None,
                    dir: None,
                },
            )
            .await
            .expect("重复入队必须成功");
            assert_eq!(
                again["id"].as_i64(),
                Some(first_id),
                "同 key 入队必须复用同一任务"
            );
        }
        // 直接再打一次登记内核（幂等性的最低层 Likewise 由 `item_id_by_ref` 命中保证）。
        let again_id = register_media_item_t0(&st, CACHE_FIXTURE_CHAT, 21, false, None)
            .await
            .expect("重复登记必须返回既有条目")
            .0;

        assert_eq!(again_id, item, "重复登记必须回到同一个 item id");

        // 入队时刻的批量入口同样幂等（每条消息走一次内核）。
        register_enqueued_items(&st, CACHE_FIXTURE_CHAT, &[21]).await;
        assert_eq!(count_rows(&st, &ref_key).await, 1, "条目只能有一行");
    }

    /// BUG-248 判据 3：登记失败**不阻断入队**（与 BUG-246 同一个容错语义）。
    ///
    /// 失败用**真实 DB 层故障**注入（BEFORE INSERT 触发器 RAISE(ABORT)），
    /// 不是给函数打个假返回值：这样连同一条 SQL、同一条错误返回路径都覆盖到了。
    #[tokio::test]
    async fn enqueue_survives_item_registration_failure() {
        let dir = scratch_dir("bug248_enqueue_failure");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(31, "video", "video/mp4", Some("登记会失败"), None)],
        )
        .await;
        assert!(st.claim_cache_worker());
        st.store
            .conn
            .execute(
                "CREATE TRIGGER bug248_block_insert BEFORE INSERT ON media_item
                 BEGIN SELECT RAISE(ABORT, 'bug-248 injected registration failure'); END",
                (),
            )
            .await
            .expect("failure injection must be installed");

        // 内核层：故障必须表现为 `None`（无可奉告），不得 panic / 不得谎报成功。
        assert_eq!(
            register_media_item_t0(&st, CACHE_FIXTURE_CHAT, 31, false, None).await,
            None,
            "登记失败必须返回 None（调用方据此不阻断）"
        );
        // 只统计**入队之前**的失败日志：下面要证明的是「后台那次登记真的跑过并失败了」，
        // 而不是被这次直接调用混过去。
        let noted_before = log_count(&st, "cache ingest failed");

        // 端点层：入队照常 200 + 任务照常落库（登记只是「先在」，不是字节的前提）。
        let (status, task) = enqueue_call(
            st.clone(),
            EnqueueCacheReq {
                chat_id: CACHE_FIXTURE_CHAT,
                message_ids: vec![31],
                group_id: None,
                dir: None,
            },
        )
        .await
        .expect("登记失败不得让入队失败");
        assert_eq!(status, StatusCode::OK);
        let task_id = task["id"].as_i64().expect("task id");
        let live = st.store.get_cache_task(task_id).await.unwrap().unwrap();
        assert_eq!(live.status, "queued", "任务必须照常排队");
        assert_eq!(
            st.store
                .item_id_by_ref("tg", &format!("{CACHE_FIXTURE_CHAT}:31"))
                .await
                .unwrap(),
            None,
            "登记失败 ⇒ 条目确实没建成（不得假装登记成功）"
        );
        wait_log(&st, "cache ingest failed", noted_before).await;
    }

    // ── BUG-280：队列标题 = caption 优先（两遍选取），file_name 只兜底 ──────────

    /// BUG-280 判据 1（**可证伪**）：组内**靠前**消息只有 file_name（`manifest.mp4`）、
    /// **靠后**消息带多行 caption ⇒ 任务标题 = 靠后那条 caption 的**首行**。
    ///
    /// 复刻实测任务 176（组 3373-3380）的形状：3374 只有 `manifest.mp4`，
    /// 3378 才是真 caption。反向证伪：把选取改回 first-match（旧
    /// `COALESCE(caption, file_name)` 语义）⇒ 首命中停在 `manifest.mp4`
    /// ⇒ 本断言 FAIL（用户原病的原样）。
    #[tokio::test]
    async fn task_title_prefers_later_caption_over_earlier_file_name_bug280() {
        let dir = scratch_dir("bug280_title_caption_first");
        let st = cache_fixture_state(&dir, vec![], vec![]).await;
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                81,
                None,
                Some("video/mp4"),
                Some(1),
                Some("video"),
                Some(1),
                None,
                None,
                Some("manifest.mp4"),
            )
            .await
            .unwrap();
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                82,
                None,
                Some("video/mp4"),
                Some(1),
                Some("video"),
                Some(1),
                None,
                None,
                Some("manifest (2).mp4"),
            )
            .await
            .unwrap();
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                83,
                Some("🌟《温柔的妈妈被我弄哭了》EP1-8 频道连载中\n剧情介绍：她披着最乖巧温顺的皮。"),
                Some("video/mp4"),
                Some(1),
                Some("video"),
                Some(1),
                None,
                None,
                Some("温柔妈妈被我弄哭了6.mp4"),
            )
            .await
            .unwrap();
        let task = enqueue_fixture_task(&st, &[81, 82, 83], Some(CACHE_FIXTURE_GROUP)).await;
        let titles = cache_task_titles(&st, std::slice::from_ref(&task)).await;
        assert_eq!(
            cache_task_title(&task, &titles).as_deref(),
            // BUG-342：期望值随清洗规则更新（emoji/《》删除）；「靠后真 caption
            // 赢过靠前 file_name」的 BUG-280 判据本身不变。
            Some("温柔的妈妈被我弄哭了EP1-8 频道连载中"),
            "靠后的真 caption 必须赢过靠前的 file_name，且只取首行（不得是 manifest.mp4）"
        );
    }

    /// BUG-280 判据 2：全组无 caption ⇒ 标题 = 第一个 file_name
    /// （BUG-220 兜底不得推翻 —— 不回退裸频道名）。
    #[tokio::test]
    async fn task_title_falls_back_to_first_file_name_bug280() {
        let dir = scratch_dir("bug280_title_file_name_fallback");
        let st = cache_fixture_state(&dir, vec![], vec![]).await;
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                84,
                None,
                Some("video/mp4"),
                Some(1),
                Some("video"),
                Some(1),
                None,
                None,
                Some("妻善3.mp4"),
            )
            .await
            .unwrap();
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                85,
                None,
                Some("video/mp4"),
                Some(1),
                Some("video"),
                Some(1),
                None,
                None,
                Some("妻善4.mp4"),
            )
            .await
            .unwrap();
        let task = enqueue_fixture_task(&st, &[84, 85], Some(CACHE_FIXTURE_GROUP)).await;
        let titles = cache_task_titles(&st, std::slice::from_ref(&task)).await;
        assert_eq!(
            cache_task_title(&task, &titles).as_deref(),
            Some("妻善3.mp4"),
            "全组无 caption 时必须回退第一个 file_name（BUG-220）"
        );
    }

    /// BUG-280 判据 3：caption 与 file_name 皆空 ⇒ `None`
    /// （前端据此退回 `频道名 #<msg>`，不得出现空串或裸 `#`）。
    #[tokio::test]
    async fn task_title_is_none_when_neither_caption_nor_file_name_bug280() {
        let dir = scratch_dir("bug280_title_none");
        let st = cache_fixture_state(&dir, vec![], vec![]).await;
        // 行存在但两个来源都空（WHERE 谓词把它挡在标题表外）。
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                86,
                None,
                Some("video/mp4"),
                Some(1),
                Some("video"),
                Some(1),
                None,
                None,
                None,
            )
            .await
            .unwrap();
        // 另一条连行都没有（登记尚未发生的排队任务）。
        let task = enqueue_fixture_task(&st, &[86, 87], Some(CACHE_FIXTURE_GROUP)).await;
        let titles = cache_task_titles(&st, std::slice::from_ref(&task)).await;
        assert_eq!(
            cache_task_title(&task, &titles).as_deref(),
            None,
            "两者皆空必须是 None（前端回退链的触发条件）"
        );
    }

    // ── BUG-375：`/api/tg/cache/tasks/all` 读路径必须零 DB（毫秒级） ──────────

    /// BUG-375 判据 1（**有牙**）：`all_cache_tasks_payload` 只读内存快照，
    /// 不碰 `st.store`。
    ///
    /// 为什么这条判据能证伪：入队后**故意不调 `refresh_cache_tasks`** ——
    /// 此刻 DB 里明明有 1 条任务，而快照是空的。若实现仍走库（旧行为），
    /// payload 会返回 1 条；只有读快照才返回 0 条。⇒ 把实现改回查库，本断言立刻 FAIL。
    ///
    /// 背景（实测）：旧实现每次请求打三条 SQL，而 `st.store` 与下载 worker 共用同一条
    /// libsql 连接，worker 持写事务时读只能排队等锁 —— 同一请求实测 3.18s / 0.03s /
    /// **13.70s**（无写竞争时三条合计仅 36ms）。daemon 出向客户端总超时 4s ⇒ 大量
    /// 请求被切成 `request orig-tg: error sending request for url`，用户侧即
    /// 「TG 入库任务暂时无法读取 / 进度完全不动 / 卡顿」。
    #[tokio::test]
    async fn all_cache_tasks_payload_reads_snapshot_not_store_bug375() {
        let dir = scratch_dir("bug375_all_tasks_snapshot");
        let st = cache_fixture_state(&dir, vec![], vec![]).await;
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                201,
                Some("BUG-375 快照标题"),
                Some("video/mp4"),
                Some(1),
                Some("video"),
                Some(1),
                None,
                None,
                Some("bug375.mp4"),
            )
            .await
            .unwrap();
        let task = enqueue_fixture_task(&st, &[201], Some(CACHE_FIXTURE_GROUP)).await;

        // 此刻 DB 有 1 条任务，但快照尚未刷新。
        let before = all_cache_tasks_payload(&st).await;
        assert_eq!(
            before["tasks"].as_array().map(Vec::len),
            Some(0),
            "未刷新快照时必须返回 0 条 —— 走库就会返回 DB 里那 1 条（旧行为）"
        );

        // 写者刷新后，同一次读必须拿到全部三类数据（任务 + 标题 + 清单摘要）。
        st.refresh_cache_tasks().await;
        let after = all_cache_tasks_payload(&st).await;
        let arr = after["tasks"].as_array().expect("tasks must be an array");
        assert_eq!(arr.len(), 1, "刷新后快照必须含刚入队的任务");
        assert_eq!(arr[0]["id"].as_i64(), Some(task.id));
        assert_eq!(
            arr[0]["title"].as_str(),
            Some("BUG-375 快照标题"),
            "标题也必须来自快照（不再按频道逐条查库）"
        );
        assert!(
            arr[0].get("manifest").is_some(),
            "组清单摘要同样必须来自快照"
        );
    }

    /// BUG-375 判据 2：快照条数上限与端点契约一致（500），
    /// 不能被某个更小的常量悄悄砍掉 —— 那会让界面无故少显示任务。
    #[test]
    fn snapshot_limit_matches_the_endpoint_contract_bug375() {
        assert_eq!(
            crate::state::CACHE_TASK_SNAPSHOT_LIMIT, 500,
            "快照上限必须等于 /tasks/all 的契约上限 500"
        );
    }

    /// BUG-375 判据 3（**规模实测**）：用户的要求是「获取当前进度是毫秒级需求」。
    /// 在 ≈ 真实量级（400 任务 / 4000 条带标题消息）上分别量写路径与读路径，
    /// 把数字打进测试输出 —— 「毫秒级」在这里是**断言**，不是形容词。
    ///
    /// 阈值取**宽松上界**而非贴线值：CI 机器抖动不该让这条无故变红，但旧实现
    /// （读路径逐条查库、与写事务抢同一条 libsql 连接）在同一数据量下实测
    /// 3.18s，宽松上界依然把它拦在门外 —— 这条判据有牙。
    ///
    /// 库用 `:memory:`：本条要测的是「读路径碰不碰库」，磁盘快慢只会污染数字，
    /// 内存库把变量消掉。（墙钟类用例仍须落文件 DB，见 MEMORY.md。）
    #[tokio::test]
    async fn all_cache_tasks_payload_is_millisecond_scale_bug375() {
        const TASKS: i64 = 400;
        const PER_TASK: i64 = 10;
        let dir = scratch_dir("bug375_latency_scale");
        let st = cache_fixture_state(&dir, vec![], vec![]).await;

        // 先铺消息（标题来源）再入队任务 —— 与真实「扫描到消息 → 用户选条目入库」同序。
        for t in 0..TASKS {
            let mut ids = Vec::new();
            for m in 0..PER_TASK {
                let mid = t * PER_TASK + m + 1;
                st.store
                    .upsert_message(
                        CACHE_FIXTURE_CHAT,
                        mid,
                        Some(&format!("BUG-375 标题 {t}/{m}")),
                        Some("video/mp4"),
                        Some(1024),
                        Some("video"),
                        Some(1_700_000_000 + mid),
                        None,
                        None,
                        Some(&format!("bug375_{t}_{m}.mp4")),
                    )
                    .await
                    .unwrap();
                ids.push(mid);
            }
            st.store
                .enqueue_cache_task(
                    CACHE_FIXTURE_CHAT,
                    None,
                    &format!("m:{CACHE_FIXTURE_CHAT}:{}", ids[0]),
                    &ids,
                    &st.config.download_dir.to_string_lossy(),
                )
                .await
                .expect("enqueue must succeed")
                .expect("task must be created");
        }

        // ── 写路径：逐条 SQL 计时，再测整体刷新 ──
        // 分解是必须的：`refresh_cache_tasks` 现在是三条 SQL，其中
        // `task_manifest_summaries` 是**本次新搬到写路径**的（原先它在读路径上，
        // 由 `/tasks/all` 每次请求各跑一遍）。不分解就说不清「写点到底新增了多少」，
        // 而写点多付出的每一毫秒都压在用户点击后的响应和墙钟类用例的阈值上。
        let q0 = std::time::Instant::now();
        let tasks = st
            .store
            .list_cache_tasks(crate::state::CACHE_TASK_SNAPSHOT_LIMIT)
            .await
            .unwrap();
        let list_ms = q0.elapsed().as_secs_f64() * 1000.0;

        let refs: Vec<(i64, i64)> = tasks
            .iter()
            .flat_map(|t| t.message_ids.iter().map(move |m| (t.chat_id, *m)))
            .collect();
        let q1 = std::time::Instant::now();
        let _titles = st.store.message_captions_for_refs(&refs).await.unwrap();
        let titles_ms = q1.elapsed().as_secs_f64() * 1000.0;

        let q2 = std::time::Instant::now();
        let _sums = st.store.task_manifest_summaries().await.unwrap();
        let manifest_ms = q2.elapsed().as_secs_f64() * 1000.0;

        let w0 = std::time::Instant::now();
        st.refresh_cache_tasks().await;
        let write_ms = w0.elapsed().as_secs_f64() * 1000.0;

        // ── 稳态刷新（下载循环内「每完成一条目」那一次的真实形态）──
        // 第一次刷新后所有引用都已解析，之后没有新引用 ⇒ 标题一条 SQL 都不该打。
        let mut steady = Vec::new();
        for _ in 0..5 {
            let s0 = std::time::Instant::now();
            st.refresh_cache_tasks().await;
            steady.push(s0.elapsed().as_secs_f64() * 1000.0);
        }
        steady.sort_by(|a, b| a.partial_cmp(b).expect("samples must be finite"));
        let steady_ms = steady[steady.len() / 2];

        // ── 对照组：把全部引用打回「未解析」后再刷一次 ──
        // **判据必须负载无关**：322 个用例并行跑时这台机器上任何绝对时间都会涨
        // 2～3 倍（实测稳态 11.8ms → 32.6ms），拿绝对阈值当判据就是拿 CI 抖动
        // 当功能缺陷。所以这里用**同一份代码、同一时刻**的两次测量互相比：
        // 稳态那次没有新引用（标题零 SQL），对照组把引用全部置回未解析
        // （标题必须真的去查）。两者相差的就是标题查询本身。
        // 把「只查未解析引用」改回全量重查 ⇒ 两次做完全一样的活 ⇒ 比值趋近 1，
        // 判据立刻红。机器快慢只同比例放大两边，不动比值。
        let all_refs: Vec<(i64, i64)> = tasks
            .iter()
            .flat_map(|t| t.message_ids.iter().map(move |m| (t.chat_id, *m)))
            .collect();
        st.invalidate_cache_task_titles(&all_refs).await;
        let c0 = std::time::Instant::now();
        st.refresh_cache_tasks().await;
        let requery_ms = c0.elapsed().as_secs_f64() * 1000.0;
        // 复原：对照组已把引用全部标回未解析，之后的读路径测量要回到稳态。
        st.refresh_cache_tasks().await;

        // ── 读路径：一次完整 payload（零 DB）──
        // 跑 5 次取中位数：单次调度抖动会把数字讲错，而中位数对一条离群值不敏感。
        // 全部任务都带标题 ⇒ `spawn_title_selfheal` 直接返回，不会有后台自愈
        // 在读路径计时期间抢连接污染读数。
        let mut samples = Vec::new();
        let mut n = 0usize;
        for _ in 0..5 {
            let r0 = std::time::Instant::now();
            let v = all_cache_tasks_payload(&st).await;
            samples.push(r0.elapsed().as_secs_f64() * 1000.0);
            n = v["tasks"].as_array().map(Vec::len).unwrap_or(0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).expect("samples must be finite"));
        let median_ms = samples[samples.len() / 2];

        println!(
            "BUG-375 规模实测：{TASKS} 任务 / {msgs} 条带标题消息（{profile} 构建）\n  \
             写路径 list_cache_tasks({limit})      = {list_ms:>8.2} ms\n  \
             写路径 message_captions_for_refs   = {titles_ms:>8.2} ms\n  \
             写路径 task_manifest_summaries     = {manifest_ms:>8.2} ms\n  \
             写路径 refresh_cache_tasks（首刷） = {write_ms:>8.2} ms\n  \
             写路径 refresh_cache_tasks（稳态） = {steady_ms:>8.2} ms ← 下载循环内每条目一次\n  \
             写路径 refresh_cache_tasks（对照） = {requery_ms:>8.2} ms ← 引用全部置回未解析\n  \
             读路径 all_cache_tasks_payload     = {median_ms:>8.2} ms（中位数，5 次：{all}）",
            profile = if cfg!(debug_assertions) { "debug" } else { "release" },
            msgs = TASKS * PER_TASK,
            limit = crate::state::CACHE_TASK_SNAPSHOT_LIMIT,
            all = samples
                .iter()
                .map(|v| format!("{v:.2}"))
                .collect::<Vec<_>>()
                .join(", "),
        );

        assert_eq!(n, TASKS as usize, "快照必须含全部任务（上限 500 未被触发）");
        assert!(
            write_ms < 500.0,
            "写路径在 {TASKS} 任务量级必须 < 500ms，实测 {write_ms:.2}ms —— \
             这条守的是「别把开销转嫁给写点」（墙钟类用例的时序阈值在写路径上）"
        );
        // 以下绝对上界都取**很宽的值**：322 个用例并行时机器负载能让任何耗时涨
        // 2～3 倍（实测：读 19.7→52.3ms、稳态 11.8→32.6ms）。拿贴线阈值当判据，
        // 红的是 CI 抖动而不是功能缺陷。所以绝对界只负责「数量级没崩」，
        // 真正的牙齿在下面两条**比值**判据和 `all_cache_tasks_payload_reads_snapshot_not_store_bug375`
        // （那条直接证明读路径不碰库，与机器快慢无关）。
        assert!(
            median_ms < 250.0,
            "读路径不得退回到百毫秒级（实测 {median_ms:.2}ms）—— 旧实现等锁时实测 3.18s"
        );
        // 分解出来的单条 SQL 也各有上界：任一条失控都会顺着写路径
        // 打到用户点击后的响应上（`run_one_cache_task` 一个任务生命周期要刷 6 次）。
        assert!(
            manifest_ms < 300.0,
            "task_manifest_summaries 必须 < 300ms，实测 {manifest_ms:.2}ms —— \
             它是本次新搬到写路径的聚合查询（json_each join 全任务）"
        );
        assert!(
            titles_ms < 200.0,
            "message_captions_for_refs 必须 < 200ms，实测 {titles_ms:.2}ms —— \
             按需查询（只取任务实际引用的消息）是把它从 34ms/次 全频道扫描降下来的前提"
        );
        // ★ 比值判据（**负载无关**）：稳态刷新 vs 「引用全部置回未解析」的对照刷新。
        // 稳态那次没有新引用 ⇒ 标题零 SQL；对照组必须真的去查。两者只差标题查询，
        // 所以稳态必须明显更便宜。改回全量重查 ⇒ 两次做一样的活 ⇒ 比值趋近 1 ⇒ 红。
        // 机器快慢同比例放大两边，不动比值 —— 这就是它比绝对阈值可靠的原因。
        assert!(
            requery_ms > steady_ms * 1.5,
            "稳态刷新必须明显便宜于「全部重新查标题」的对照：\
             稳态 {steady_ms:.2}ms vs 对照 {requery_ms:.2}ms。\
             若这条红，说明「只查未解析引用」被改回了全量重查 —— \
             下载循环内每完成一条目就要多付一次标题查询（400 引用实测 45ms）"
        );
    }

    /// BUG-375 判据 4（**有牙**）：标题自愈补回的 caption 必须能进快照。
    ///
    /// 「只查未解析引用」省掉了稳态下的标题查询，代价是：一条消息第一次被解析成
    /// 「无标题」后，之后从 Telegram 补回来的 caption 不会自己出现。
    /// 这条路只有 `backfill_message_titles` 末尾那次重新解析接着 —— 漏了它，
    /// 自愈就白做：界面看不到标题，而 `spawn_title_selfheal` 也不会再触发
    /// （它只扫无标题任务，而那时标题已经在库里了）。
    ///
    /// 本测试**走真实自愈路径**（直接调 `backfill_message_titles`，夹具客户端的
    /// `message_meta` 返回预置 caption），且**刻意不调 `refresh_cache_tasks`** ——
    /// 生产里 `/tasks/all` 之后同样没有任何东西会刷（写点可能几小时不来），
    /// 所以「补回的标题要可见」不能依赖刷新。在测试里补一次 refresh、或只把引用
    /// 打回未解析，都会把「生产代码漏了这一步」放过去 ⇒ 牙齿就没了。
    ///
    /// 证伪方式：把 `backfill_message_titles` 末尾的 `resolve_cache_task_titles`
    /// 改回「只 remove 键」（本方法的第一版正是如此），最后一条断言立刻红。
    #[tokio::test]
    async fn selfhealed_title_reaches_the_snapshot_bug375() {
        let dir = scratch_dir("bug375_selfheal_invalidate");
        // 夹具客户端**有**这条消息的 caption（自愈要从这里补），但库里先放一行
        // 不带任何标题来源的数据 —— 正是「登记过、标题还缺」的现场。
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![fixture_msg(
                777,
                "video",
                "video/mp4",
                Some("自愈补回的标题"),
                None,
            )],
        )
        .await;
        st.store
            .upsert_message(
                CACHE_FIXTURE_CHAT,
                777,
                None,
                Some("video/mp4"),
                Some(1024),
                Some("video"),
                Some(1_700_000_000),
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let _task = enqueue_fixture_task(&st, &[777], None).await;

        st.refresh_cache_tasks().await;
        let v1 = all_cache_tasks_payload(&st).await;
        assert!(
            v1["tasks"][0]["title"].is_null(),
            "无标题来源时不得伪造标题（BUG-154）"
        );
        // 此刻快照里该引用已被解析为「无标题」——正是增量合并要跳过的状态。
        assert!(
            st.cache_task_titles_snapshot()
                .await
                .get(&(CACHE_FIXTURE_CHAT, 777))
                .is_some_and(|v| v.is_none()),
            "首刷后引用必须被标记为「解析过、无标题」，否则稳态优化不成立"
        );

        // 自愈：走真实路径（`backfill_message_titles` 内部从客户端取 caption 写库）。
        backfill_message_titles(&st, CACHE_FIXTURE_CHAT, &[777]).await;

        // **不调 refresh_cache_tasks**：生产里 `/tasks/all` 之后同样没人会刷。
        let v2 = all_cache_tasks_payload(&st).await;
        assert_eq!(
            v2["tasks"][0]["title"].as_str(),
            Some("自愈补回的标题"),
            "自愈补回的标题必须**不依赖刷新**就进入快照 —— \
             只把引用打回未解析的话，它要等到下一次写点才可见，\
             而自愈又因「库里已有标题」不再触发 ⇒ 永久看不到"
        );
    }

    // ── BUG-281：相册组的分集介绍继承组级 caption 正文 ───────────────────────

    /// BUG-281 判据 1（**可证伪**）：组里只有一条消息带多行 caption ⇒ 入库后
    /// **每个分集**的介绍都等于组级正文；caption 所有者保留自己的；无 caption 的
    /// 视频标题仍空（BUG-154：不拿内部文件名伪造标题）。
    ///
    /// 反向证伪：把 `register_enqueued_items` 传给 ③ 的 `group_desc` 改回 None
    /// （移除继承）⇒ 非所有者的介绍回到 NULL ⇒ 本断言 FAIL（实测 118/149 的原病）。
    #[tokio::test]
    async fn enqueue_group_inherits_caption_body_for_every_episode_bug281() {
        let dir = scratch_dir("bug281_group_inherit");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![
                fixture_msg(91, "video", "video/mp4", None, Some(CACHE_FIXTURE_GROUP)),
                fixture_msg(
                    92,
                    "video",
                    "video/mp4",
                    Some("组剧标题\n组级介绍：她披着最乖巧温顺的皮。"),
                    Some(CACHE_FIXTURE_GROUP),
                ),
                fixture_msg(93, "video", "video/mp4", None, Some(CACHE_FIXTURE_GROUP)),
            ],
        )
        .await;
        register_enqueued_items(&st, CACHE_FIXTURE_CHAT, &[91, 92, 93]).await;

        let body = "组级介绍：她披着最乖巧温顺的皮。";
        for msg in [91, 92, 93] {
            let id = st
                .store
                .item_id_by_ref("tg", &format!("{CACHE_FIXTURE_CHAT}:{msg}"))
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("msg {msg} 的条目必须已登记"));
            let it = st.store.get_media_item(id).await.unwrap().unwrap();
            assert_eq!(
                it.description.as_deref(),
                Some(body),
                "msg {msg} 的介绍必须是组级正文（BUG-281：组内共享，实测原病下只有 92 有）"
            );
            assert_eq!(it.kind, "video", "msg {msg} 的 kind 必须被补强");
        }
        // BUG-154：无 caption 的视频不伪造标题 ⇒ 保持空串。
        for msg in [91, 93] {
            let id = st
                .store
                .item_id_by_ref("tg", &format!("{CACHE_FIXTURE_CHAT}:{msg}"))
                .await
                .unwrap()
                .unwrap();
            let it = st.store.get_media_item(id).await.unwrap().unwrap();
            assert!(
                it.title.trim().is_empty(),
                "无 caption 的视频标题必须保持空（BUG-154），实得 {:?}",
                it.title
            );
        }
        // caption 所有者：标题取自己 caption 的首行（不继承别条、不伪造）。
        let owner = st
            .store
            .item_id_by_ref("tg", &format!("{CACHE_FIXTURE_CHAT}:92"))
            .await
            .unwrap()
            .unwrap();
        let owner = st.store.get_media_item(owner).await.unwrap().unwrap();
        assert_eq!(owner.title, "组剧标题", "caption 所有者保留自己的标题");
    }

    /// BUG-281 判据 2：`strengthen_registered_item` 的组级介绍补填 =
    /// **fill-empty guard**（BUG-054 三态契约）。
    ///
    /// 三态各钉一条：空介绍位补组级正文 / 用户写过的介绍不动 /
    /// 显式清空过的介绍不被 own-caption 路径写回。
    #[tokio::test]
    async fn strengthen_fills_group_desc_only_into_empty_slot_bug281() {
        let dir = scratch_dir("bug281_strengthen_guard");
        let st = cache_fixture_state(
            &dir,
            vec![],
            vec![
                fixture_msg(101, "video", "video/mp4", None, None),
                fixture_msg(102, "video", "video/mp4", Some("自有标题\n自有正文"), None),
                fixture_msg(103, "video", "video/mp4", None, None),
            ],
        )
        .await;
        ensure_message_rows(&st, CACHE_FIXTURE_CHAT, &[101, 102, 103]).await;
        let group = "组级介绍正文";

        // ① 空介绍位（T0 形态：元数据未到位时建的 kind=file、无时长）⇒ 补组级正文。
        let id_empty = st
            .store
            .upsert_media_item(
                "tg",
                &format!("{CACHE_FIXTURE_CHAT}:101"),
                "",
                "file",
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let row101 = st.store.get_message(CACHE_FIXTURE_CHAT, 101).await.unwrap();
        strengthen_registered_item(&st, id_empty, &row101, "video", 101, false, Some(group)).await;
        assert_eq!(
            st.store
                .get_media_item(id_empty)
                .await
                .unwrap()
                .unwrap()
                .description
                .as_deref(),
            Some(group),
            "空介绍位必须补上组级正文"
        );

        // ② 用户写过的介绍 ⇒ 不动（fill-empty guard）。
        let id_user = st
            .store
            .upsert_media_item(
                "tg",
                &format!("{CACHE_FIXTURE_CHAT}:103"),
                "用户标题",
                "video",
                None,
                None,
                Some(12),
                Some("用户写的介绍"),
            )
            .await
            .unwrap();
        let row103 = st.store.get_message(CACHE_FIXTURE_CHAT, 103).await.unwrap();
        strengthen_registered_item(&st, id_user, &row103, "video", 103, false, Some(group)).await;
        assert_eq!(
            st.store
                .get_media_item(id_user)
                .await
                .unwrap()
                .unwrap()
                .description
                .as_deref(),
            Some("用户写的介绍"),
            "用户写过的介绍不得被组级正文覆盖"
        );

        // ③ 显式清空过的介绍（BUG-054 三态：NULL = 合法意图）⇒ own-caption 路径
        //    保持既有写法（早退不写），清空不被复活。
        let id_cleared = st
            .store
            .upsert_media_item(
                "tg",
                &format!("{CACHE_FIXTURE_CHAT}:102"),
                "自有标题",
                "video",
                None,
                None,
                Some(12),
                None,
            )
            .await
            .unwrap();
        st.store
            .update_media_item(
                id_cleared,
                &crate::media::ItemPatch {
                    description: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let row102 = st.store.get_message(CACHE_FIXTURE_CHAT, 102).await.unwrap();
        strengthen_registered_item(&st, id_cleared, &row102, "video", 102, false, Some(group))
            .await;
        assert!(
            st.store
                .get_media_item(id_cleared)
                .await
                .unwrap()
                .unwrap()
                .description
                .is_none(),
            "显式清空的介绍不得被 strengthen 写回（既有 own-caption 行为原样保留）"
        );
    }

    /// BUG-345：入队请求的 `groupId` 收 **string**（串界修复后的前端形状）也收
    /// **number**（陈旧标签页）——两个形状必须解到同一个 i64。group_id 量级
    /// ~1.4e16 > JS 2^53，只收 number 的旧契约正是活库 62/70 个组键任务被
    /// 舍入污染的上游。
    #[test]
    fn enqueue_group_id_accepts_string_and_number() {
        let from_str: EnqueueCacheReq = serde_json::from_str(
            r#"{"chatId":-1004493170102,"messageIds":[4728],"groupId":"14315949991671397"}"#,
        )
        .expect("string groupId must deserialize");
        assert_eq!(
            from_str.group_id,
            Some(14315949991671397),
            "字符串形态必须精确落到 i64（number 形态在这里就已经丢精度了）"
        );
        let from_num: EnqueueCacheReq = serde_json::from_str(
            r#"{"chatId":-1004493170102,"messageIds":[4728],"groupId":14315949991671396}"#,
        )
        .expect("number groupId must still deserialize");
        assert_eq!(from_num.group_id, Some(14315949991671396));
        let missing: EnqueueCacheReq =
            serde_json::from_str(r#"{"chatId":-1004493170102,"messageIds":[4728]}"#)
                .expect("missing groupId must default");
        assert_eq!(missing.group_id, None);
    }

    /// 调用入队端点并解构为 `(状态码, 任务 JSON)`。
    async fn enqueue_call(
        st: Arc<AppState>,
        req: EnqueueCacheReq,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, String)> {
        match enqueue_cache_task(State(st), Json(req)).await {
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

    /// 轮询等待某个 `ref` 的条目落地（后台登记协程是异步的）。
    async fn wait_item_id(st: &AppState, ref_key: &str) -> i64 {
        for _ in 0..200 {
            if let Ok(Some(id)) = st.store.item_id_by_ref("tg", ref_key).await {
                return id;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("BUG-248: 入队后最多 5s 内条目必须出现在媒体库（ref={ref_key}）");
    }

    /// 等待某条日志**新增**（失败路径必须留痕，不能静默吞掉）。
    ///
    /// `baseline` 是入队之前的命中条数：等到它增加，才证明**后台那次登记真的跑过**
    /// ——否则用例会被更早一次同名日志蒙混过关。
    async fn wait_log(st: &AppState, needle: &str, baseline: usize) {
        for _ in 0..200 {
            if log_count(st, needle) > baseline {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("BUG-248: 登记失败必须留痕（期待日志含 {needle}）");
    }

    /// 环形日志里含 `needle` 的条数。
    fn log_count(st: &AppState, needle: &str) -> usize {
        st.logs.recent(200).iter().filter(|l| l.contains(needle)).count()
    }

    /// 某个 `ref` 的条目行数（幂等判据）。
    async fn count_rows(st: &AppState, ref_key: &str) -> i64 {
        let mut rows = st
            .store
            .conn
            .query(
                "SELECT COUNT(*) FROM media_item WHERE source = 'tg' AND ref = ?1",
                libsql::params![ref_key.to_string()],
            )
            .await
            .expect("count must run");
        let row = rows.next().await.expect("count row").expect("count row exists");
        row.get(0).expect("count column")
    }

    // ── BUG-129：`addEpisode` 按槽位静默覆盖 ─────────────────────────────
    //
    // 判据（`docs/bugs/BUG-129.md` 方案 B）：槽位已被占用且未传 `overwrite` 时
    // 返回 **409**，且**原条目仍在**。
    //
    // 「原条目仍在」是本测试的**重点**，不是「返回了 409」：先删后报错、或报错前
    // 先动过原条目，都能骗过只断言状态码的测试。所以每条 409 之后都重新读库，
    // 断言槽位仍指向原条目、原行 id 未变、行数未变。

    /// BUG-129 判据：`POST /api/media/series/:id/episodes` 在槽位被占用且
    /// **未传 `overwrite`** 时必须 409，且**原条目仍在**（顶掉 `390` 那个现场的回归）。
    #[tokio::test]
    async fn add_episode_occupied_slot_conflicts_and_keeps_original_bug129() {
        use crate::unavailable::UnavailableClient;

        let store = Store::open(":memory:").await.expect("store");
        let st = Arc::new(AppState::new(
            Arc::new(UnavailableClient::new("test: link down")),
            Config::default(),
            Availability::Unavailable("test".to_string()),
            false,
            store,
        ));
        let sid = st
            .store
            .create_series("剧", None, "series", None, None)
            .await
            .unwrap();
        // 复刻 BUG-129 现场：390 已占住 S1E1，389 随后带着默认 episodeNo(=1) 进来。
        let original = st
            .store
            .upsert_media_item("tg", "v:390", "原条目", "video", None, None, None, None)
            .await
            .unwrap();
        let newcomer = st
            .store
            .upsert_media_item("tg", "v:389", "新条目", "video", None, None, None, None)
            .await
            .unwrap();
        // 第三个独立条目：D22-A④ 起 `media_episode UNIQUE(item_id)` 规定一个条目全局只属
        // 一集，⑤ 的「另一季另一个槽」必须换一条目，否则会撞 item 唯一键而非槽位键。
        let another = st
            .store
            .upsert_media_item("tg", "v:388", "第三条目", "video", None, None, None, None)
            .await
            .unwrap();
        st.store.add_episode(sid, original, 1, 1).await.unwrap();
        let before = st.store.episode_slot_occupant(sid, 1, 1).await.unwrap().unwrap();
        assert_eq!(before.item_id, original, "前置：S1E1 先归原条目 390");

        // ① 默认槽位 + 未传 overwrite ⇒ 409，且错误信息要告知占用者
        let err = match add_media_episode(
            State(st.clone()),
            Path(sid),
            Json(EpisodeReq {
                item_id: newcomer,
                season: None,
                episode_no: None,
                overwrite: None,
            }),
        )
        .await
        {
            Ok(_) => panic!("BUG-129: 槽位被占用且未传 overwrite 时不得静默覆盖"),
            Err(e) => e,
        };
        assert_eq!(
            err.status,
            StatusCode::CONFLICT,
            "BUG-129 判据：槽位被占用且未传 overwrite 必须是 409"
        );
        assert!(
            err.message().contains(&original.to_string()),
            "409 必须告知占用者是谁（期望含 itemId {original}），实得：{}",
            err.message()
        );

        // ② 判据核心：**原条目仍在**，且原行 id 未变（不是删旧建新）
        let after = st.store.episode_slot_occupant(sid, 1, 1).await.unwrap().unwrap();
        assert_eq!(
            after.item_id, original,
            "BUG-129 判据：原条目仍在 —— 409 不得伴随任何写入"
        );
        assert_eq!(after.episode_id, before.episode_id, "原行 id 不得改变");
        assert_eq!(
            count_episode_rows(&st, sid).await,
            1,
            "BUG-129 判据：槽位行数不变（顶掉 ≠ 删旧建新）"
        );

        // ③ 显式 `overwrite: true` ⇒ 放行，且**真的**覆盖（否则修复等于把端点焊死）
        let ok = add_media_episode(
            State(st.clone()),
            Path(sid),
            Json(EpisodeReq {
                item_id: newcomer,
                season: None,
                episode_no: None,
                overwrite: Some(true),
            }),
        )
        .await
        .expect("BUG-129: 显式 overwrite 必须放行 —— 修复不能把按槽位写入整个禁掉");
        let resp = ok.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("body must be readable");
        let v: serde_json::Value = serde_json::from_slice(&body).expect("must be JSON");
        assert!(v["id"].is_i64(), "响应契约仍是 {{\"id\": <episodeId>}}");
        let overwritten = st.store.episode_slot_occupant(sid, 1, 1).await.unwrap().unwrap();
        assert_eq!(overwritten.item_id, newcomer, "显式覆盖必须生效");
        assert_eq!(overwritten.episode_id, before.episode_id, "覆盖落在同一行（upsert）");

        // ④ 空槽不受影响：BUG-129 的闸只拦「已占用」，不得把正常加入一起拦掉
        //
        // 用 `original`（被 ③ 顶下、此刻**无归属**）而非 `newcomer`：D22-A④ 起
        // `media_episode UNIQUE(item_id)` 规定一个条目全局只属一集，`newcomer` 已在 S1E1。
        let fresh = add_media_episode(
            State(st.clone()),
            Path(sid),
            Json(EpisodeReq {
                item_id: original,
                season: None,
                episode_no: Some(9), // 空槽
                overwrite: None,
            }),
        )
        .await
        .expect("BUG-129: 空槽必须照常写入 —— 闸只拦已占用槽位");
        assert_eq!(fresh.into_response().status(), StatusCode::OK);

        // ⑤ 季参与键：S2E1 是另一个槽，即使 S1E1 被占也不该报冲突。
        //    换用 `another`（独立条目）—— `original` 此刻已归 S1E9，见上条注释。
        let _ = add_media_episode(
            State(st.clone()),
            Path(sid),
            Json(EpisodeReq {
                item_id: another,
                season: Some(2),
                episode_no: Some(1),
                overwrite: None,
            }),
        )
        .await
        .expect("BUG-129: S2E1 未被占用，不得被 S1E1 的占用误判成冲突");
    }

    /// 某剧集某季的分集行数（BUG-129 判据用：顶掉 ≠ 删旧建新）。
    async fn count_episode_rows(st: &AppState, series_id: i64) -> i64 {
        let mut rows = st
            .store
            .conn
            .query(
                "SELECT COUNT(*) FROM media_episode WHERE series_id = ?1 AND season = 1",
                libsql::params![series_id],
            )
            .await
            .expect("count must run");
        let row = rows.next().await.expect("count row").expect("count row exists");
        row.get(0).expect("count column")
    }

    // ── BUG-085：全量端点不再跑那条被丢弃的全表 count ─────────────────────
    //
    // 判据（docs/bugs/BUG-085.md）：`/api/tg/cache/tasks/all` 历史上在返回 `tasks` 之外还会
    // 多算一份 `counts`，而 daemon 侧 `TgTasksPayload`（orig-daemon/src/activity.rs:157-161）
    // 从不反序列化 `counts`——等于每次 5s 轮询白跑一条全表 count。修复把 `counts` 字段连同
    // `count_cache_tasks()` 调用一起砍掉。本测试锁住修复成果：返回体**必须**含 `tasks`、
    // **必须不**含 `counts`（即那条无用查询已消失）。

    /// BUG-085 判据：`list_all_cache_tasks` 的响应必须含 `tasks` 且**不含** `counts`。
    #[tokio::test]
    async fn list_all_cache_tasks_omits_discarded_counts_bug085() {
        let st = crate::state::AppState::new(
            std::sync::Arc::new(crate::unavailable::UnavailableClient::new("bug085")),
            crate::config::Config::default(),
            crate::state::Availability::Unavailable("bug085".to_string()),
            false,
            crate::store::Store::open(":memory:").await.expect("store"),
        );
        let st = std::sync::Arc::new(st);

        // 放一条任务行，证明 `tasks` 仍正常返回（不是把整个接口删了）。
        st.store
            .upsert_message(-1001, 55, Some("t"), Some("video/mp4"), Some(9_000), Some("video".into()), Some(0), None, None, None)
            .await
            .unwrap();
        st.store
            .enqueue_cache_task(-1001, None, "m:-1001:55", &[55], &std::env::temp_dir().to_string_lossy())
            .await
            .unwrap();
        // BUG-375：本端点已改读内存快照 ⇒ 入队后必须由「写者」刷一次，
        // 否则读到的是空快照（这正是新契约：读零 DB，写在写点刷）。
        st.refresh_cache_tasks().await;

        let resp = list_all_cache_tasks(State(st.clone()))
            .await
            .expect("list_all_cache_tasks 必须成功")
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("body must be readable");
        let v: serde_json::Value = serde_json::from_slice(&body).expect("must be JSON");

        assert!(v.get("tasks").is_some(), "BUG-085: 响应必须仍含 tasks 字段");
        assert!(
            v["tasks"].as_array().map(|a| !a.is_empty()).unwrap_or(false),
            "BUG-085: tasks 应有刚入队的任务"
        );
        assert!(
            v.get("counts").is_none(),
            "BUG-085: 被 daemon 丢弃的 counts 字段必须消失（否则仍白跑全表 count）"
        );
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