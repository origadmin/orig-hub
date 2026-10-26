//! HTTP 路由：对齐 orig-hub `internal/core/api.go` + `api_test.go` 的真实 REST 契约。
//!
//! 端点：
//!   GET  /health                        -> {"status":"ok"}            (token 配置后也需鉴权)
//!   GET  /api/downloads                 -> [DownloadStatus]
//!   POST /api/downloads                 -> {"id":"..."}              (201)
//!        body: {"url","output_path"?,"filename"?,"mirrors"?,"headers"?}
//!   GET  /api/downloads/:id             -> DownloadStatus            (404 若不存在)
//!   POST /api/downloads/:id?action=...  -> {"status":"paused"|"resumed"|"cancelled","id":"..."}
//!   DELETE /api/downloads/:id           -> {"status":"deleted","id":"..."}
//!   GET  /api/events                    -> SSE 实时进度（REST+SSE 设计；原 Go 端由 Wails 轮询，此处补充）
//!   GET  /api/activity                  -> 传输中聚合视图（只读，见 `activity.rs`）
//!   GET  /api/files                     -> {roots, files:[FileFact]}（受管下载根成品，BUG-299 M2-T00a）
//!   DELETE /api/files?path=...          -> {ok, path}（受管根边界守卫；404 不存在 / 403 根外）
//!   GET  /api/fs/dirs?path=...          -> {path, parent, entries, roots}（只读目录浏览，BUG-323 缺陷③）
//!
//! 下载流程：parse_url → probe(取总大小) → create_sources(一组 Source) →
//! 用 `BlockMap` + `Task` 调度（见 `orig_core::engine`）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State, Json};
use axum::http::{StatusCode, header::AUTHORIZATION};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures::StreamExt;
use serde::Deserialize;
use serde_json;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use orig_core::engine::Task;
use orig_core::protocol::{DownloadConfig, Metadata, ParsedUrl, Protocol, SseEvent};
use crate::activity::{self, ActivityQuery, ActivitySnapshot, SourcesSnapshot};
use crate::config::{resolve_output, resolve_output_classified};
use crate::fsbrowse;
use crate::files;
use crate::state::{log_dir, AppState, DownloadTask};
use crate::status::DownloadStatus;
use crate::task_store::{
    EngineTaskRecord, ST_CANCELLED, ST_COMPLETED, ST_DOWNLOADING, ST_ERROR, ST_PAUSED,
};

// ---- 请求结构 ----

#[derive(Deserialize)]
pub struct AddReq {
    pub url: String,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub mirrors: Vec<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// 多网卡分流配置（可选）：{"primary_weight":1,"secondaries":{"网卡名":2}}
    #[serde(default)]
    pub interfaces: Option<orig_net::InterfaceSpec>,
    /// 自动分类（R3）：true=强制开启 / false=强制关闭 / None=用配置默认。
    #[serde(default)]
    pub classify: Option<bool>,
    /// 覆盖下载：目标文件已存在时先删除再重新下载（默认 false）。
    #[serde(default)]
    pub overwrite: bool,
    /// 本次下载的代理配置（可选）：缺省用 daemon 配置 [proxy] 段；
    /// 传 {mode:"direct"} 强制直连，{mode:"custom",url:"http://..."} 指定代理。
    #[serde(default)]
    pub proxy: Option<orig_core::protocol::ProxyConfig>,
}

#[derive(Deserialize)]
pub struct ActionReq {
    pub action: String,
}

// ---- 鉴权中间件（对齐 Go 的 ServeHTTP：Bearer token；配置后所有路由含 /health 均须鉴权） ----

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = state.config.read().unwrap().token.clone();
    if let Some(token) = token {
        let header_ok = req
            .headers()
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|a| a.strip_prefix("Bearer "))
            .map(|t| t == token)
            .unwrap_or(false);
        // 浏览器 EventSource 无法带自定义头，SSE 经 `?token=` 透传鉴权。
        let query_ok = query_token_matches(req.uri().query(), &token);
        if !header_ok && !query_ok {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    Ok(next.run(req).await)
}

/// 从查询串中匹配 `?token=<secret>`（仅用于 SSE 等不能带 Authorization 头的场景）。
fn query_token_matches(query: Option<&str>, token: &str) -> bool {
    let Some(q) = query else { return false };
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == "token" && v == token {
            return true;
        }
    }
    false
}

// ---- 路由处理 ----

async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({"status": "ok"}))
}

/// `GET /api/downloads` — 引擎侧全量。
///
/// 与 `/api/activity` 的 download 行共用 `engine_rows` 同一真源（内存 ∪ 库）。
/// 之前本端点**只读内存**，导致栈重启后聚合面看得到行、下载页却空白 —— 同一个
/// 事实两个答案。两个面必须同一份合并结果，否则「数据丢失」的观感永远修不完。
async fn list(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let rows = crate::activity::engine_rows(&st).await;
    let now = now_secs();
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        // 只有内存活体才有实时明细可采；纯记录行只陈事实（不产分块/连接）。
        let detail = match &r.live {
            Some(t) => Some(t.progress().await),
            None => None,
        };
        out.push(DownloadStatus::from_row(r, detail.as_ref(), now));
    }
    axum::Json(out)
}

/// 同名文件自动重命名的候选：`name (1).ext` / `name (2).ext` … 直到磁盘上不存在。
///
/// 只在「原路径**已存在**」时调用（见 [`add`] 的完整度检测分支）；语义是「给冲突文件
/// 找一个空位」，**不**判断原路径本身是否存在。无扩展名时退化为 `name (1)`。
/// 抽成独立函数是为了可测（T08⑤ 回归夹具：同名 `(1)`），逻辑与内联版逐字一致。
async fn next_free_path(output: &std::path::Path) -> std::path::PathBuf {
    let parent = output.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = output
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let ext = output
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut idx = 1;
    loop {
        let candidate = if ext.is_empty() {
            parent.join(format!("{stem} ({idx})"))
        } else {
            parent.join(format!("{stem} ({idx}).{ext}"))
        };
        if tokio::fs::metadata(&candidate).await.is_err() {
            break candidate;
        }
        idx += 1;
    }
}

/// 跑一个任务，并在结束时把**终态**写进持久化层（BUG-319）。
///
/// `POST /api/downloads/:id/retry` — 终态/中断行的重试（BUG-322）。
///
/// **来源无关是本端点的设计前提**：它不认识任何一个协议，只从记录里取出 `url`，
/// 交给 `probe_url` 由 Registry 按 scheme 找到协议 —— 新增协议（未来的第 N 个
/// 来源）注册进 Registry 即自动获得重试能力，本端点零改动。它是 download 侧
/// 的动作，与 TG 侧的 `/api/cache/tasks/:id/retry` 同构（各侧自持命名空间）。
///
/// 与 `POST .../:id?action=pause|resume|cancel` 分开的理由不是命名洁癖：
/// pause/resume/cancel 作用于**内存里的活体句柄**（句柄没了就没得做），retry
/// 作用于**记录**（句柄没了才轮到它）。操作对象不同，404 的语义也不同（前者
/// 「没有活体」、后者「没有记录」），混进同一个 `?action=` 会让调用方分不清
/// 自己拿到的 404 是哪一种。
async fn retry_one(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // 还在内存里 ⇒ 它有句柄、能被 pause/resume，重试是重复入队，不做。
    if st.tasks.lock().await.contains_key(&id) {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({"error": "task is live", "id": id})),
        )
            .into_response();
    }
    let rec = match &st.task_store {
        Some(store) => store.get(&id).await,
        None => None,
    };
    let rec = match rec {
        Some(r) => r,
        None => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({"error": "no such record", "id": id})),
            )
                .into_response()
        }
    };
    // 只接受「停在那儿了」的行。completed 不重试：落盘路径不重命名（见
    // `requeue` 的注释），重试一个已完成的文件只会覆盖它自己，那是噪音不是能力。
    if !matches!(
        rec.status.as_str(),
        crate::task_store::ST_INTERRUPTED
            | crate::task_store::ST_ERROR
            | crate::task_store::ST_CANCELLED
    ) {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({"error": "not retryable", "status": rec.status})),
        )
            .into_response();
    }
    if let Err(e) = requeue(&st, &rec).await {
        return (
            StatusCode::BAD_GATEWAY,
            axum::Json(serde_json::json!({"error": "retry failed", "detail": e})),
        )
            .into_response();
    }
    // `requeue` 末尾会把状态回写成记录里的旧状态（那是它**当时的**处境）；
    // 重试是要它**现在**开始跑，故显式置为 downloading。
    st.set_task_status(&rec.id, crate::task_store::ST_DOWNLOADING)
        .await;
    // `resume: false` 不是冗余：引擎无真续传（每次 offset 0 起），必须让调用方
    // 知道「重试 = 整任务重跑」，否则 UI 会把这个词渲染成「从断点继续」。
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({"status": "retrying", "id": id, "resume": false})),
    )
        .into_response()
}

/// `POST /api/downloads` 与启动恢复共用这一段：两条入队路径的终态处理只能是
/// 同一份，否则「新建的任务记了、恢复的任务没记」又会变成一类分叉。
fn spawn_task(st: &Arc<AppState>, id: String, task: Arc<Task>) {
    let st_run = st.clone();
    let id_run = id.clone();
    tokio::spawn(async move {
        let res = task.run().await;
        if let Err(ref e) = res {
            eprintln!("[download] task {id_run} error: {e}");
            st_run
                .events
                .send(SseEvent::Error {
                    id: id_run.clone(),
                    message: e.to_string(),
                })
                .ok();
            if let Some(dt) = st_run.tasks.lock().await.get(&id_run) {
                *dt.error.lock().await = Some(e.to_string());
            }
        } else {
            eprintln!("[download] task {id_run} completed");
        }
        // 终态落库：取消/失败/完成的行都必须留下 —— 它们是**结果**，
        // 重启后凭空消失就是用户所说的「数据丢失」。
        // 取消与错误分开：取消是用户意图，错误是故障；混成一个状态就等于
        // 把「我取消的」渲染成「下载失败了」。
        let (status, err) = match res {
            Ok(()) => (ST_COMPLETED, None),
            Err(ref e) => {
                if task.control.cancel.is_cancelled() {
                    (ST_CANCELLED, Some(e.to_string()))
                } else {
                    (ST_ERROR, Some(e.to_string()))
                }
            }
        };
        // 认**身份**不认 id：重试是复用同一个 id 建一个新任务（见 `requeue`），
        // 于是旧任务的临终写入若按 id 落库，就会把新任务正在跑的状态改写成
        // 「已取消」—— 用户刚点了重试，界面却又变回已取消（实测序列：
        // downloading 被随后的 cancelled 覆盖）。
        // 同理，用户删除后内存里已没有该 id ⇒ 也要跳过（不许删了又复活）。
        let is_mine = {
            let tasks = st_run.tasks.lock().await;
            match tasks.get(&id_run) {
                Some(dt) => Arc::ptr_eq(&dt.task, &task),
                None => false,
            }
        };
        if !is_mine {
            return;
        }
        let prog = task.progress().await;
        let terminal = {
            let tasks = st_run.tasks.lock().await;
            tasks
                .get(&id_run)
                .map(|t| AppState::record_of(t, status, prog.total, prog.downloaded, now_secs(), err.clone()))
        };
        if let Some(r) = terminal {
            st_run.persist(&r).await;
            // 终态让出内存句柄。活体句柄只在「还能控制它」时才有意义 ——
            // 留着它 ⇒ 该行永远被判定为 live ⇒ 重试端点恒 409（「它还活着」），
            // 而实际上它已经跑完了；同时又挡住库里那条记录的读取（内存优先）。
            // 记录已落库，视图从库里读，两面的行为保持一致。
            st_run.tasks.lock().await.remove(&id_run);
        }
    });
}

/// 由「已探测的 URL + 落盘路径」构造一个可运行的引擎 Task。
///
/// 抽出来是为了让**两条路径共用同一段构造**：
/// - `POST /api/downloads`（用户新加一条）；
/// - BUG-319 的启动恢复（用库里存下来的 url/output 重建被中断的任务）。
///
/// 两条路径共用构造，就不可能出现「新建的任务能跑、恢复的任务跑不起来」
/// 这种双份实现分叉 —— 那正是「已入队但一直 0 字节」类假象的温床。
async fn build_task(
    st: &Arc<AppState>,
    proto: &Arc<dyn Protocol>,
    parsed: &ParsedUrl,
    meta: &Metadata,
    output: &std::path::Path,
    id: &str,
    cfg: &DownloadConfig,
) -> Result<Arc<Task>, String> {
    let sources = proto
        .create_sources(parsed, cfg)
        .await
        .map_err(|e| format!("create sources: {e}"))?;
    Ok(Task::new(
        id.to_string(),
        output.to_path_buf(),
        meta.total_size,
        cfg.block_size,
        sources,
        st.events.clone(),
        proto.name().to_string(),
        cfg.max_concurrency,
        meta.supports_range,
    ))
}

/// 把（解析 + 探测）的结果取出，供新建与恢复共用。
async fn probe_url(
    st: &Arc<AppState>,
    url: &str,
    proxy: Option<&orig_core::protocol::ProxyConfig>,
) -> Result<(Arc<dyn Protocol>, ParsedUrl, Metadata), String> {
    let scheme = url.split("://").next().unwrap_or("").to_string();
    let proto = st
        .registry
        .find_by_scheme(&scheme)
        .ok_or_else(|| format!("unsupported scheme: {scheme}"))?;
    let parsed = proto.parse_url(url).await.map_err(|e| format!("parse url: {e}"))?;
    let meta = proto
        .probe(&parsed, proxy)
        .await
        .map_err(|e| format!("probe failed: {e}"))?;
    Ok((proto, parsed, meta))
}

/// BUG-319 启动恢复：把上次进程留下的未完成下载**重新入队**。
///
/// 顺序不能变：
/// 1. 先把库里「还在跑」的行改写成 `interrupted` —— 此刻确实没有任何 worker 在跑，
///    不改写就等于对外宣称它在下载（与「已开启但未连接」同型的假象）；
/// 2. 逐条用库里的 url/output 重新探测、重建 Task 并跑起来。重建走的是
///    `probe_url` / `build_task`，与新建路径**同一段代码** ⇒ 恢复出来的任务和
///    新建的任务物理上是同一种对象，不存在「恢复的跑不动」这种分叉；
/// 3. 重建失败的（源站已失效 / 网络不通 / scheme 不支持）**留在库里**，
///    状态保持 `interrupted` —— 记录不丢，也不假装还能跑。用户看得见它、可以重试。
///
/// 为什么不无条件重试到成功：源站失效是**外部事实**，重试一百次也不会变好，
/// 而把失败藏起来（假装还在下载）才是真正的数据丢失。
pub async fn recover_engine_tasks(st: &Arc<AppState>) {
    let Some(store) = st.task_store.clone() else {
        return;
    };
    let pending = store.take_over_unfinished().await;
    if pending.is_empty() {
        return;
    }
    eprintln!(
        "[recover] {} engine task(s) left by the previous process; re-enqueuing",
        pending.len()
    );
    for rec in pending {
        match requeue(st, &rec).await {
            Ok(()) => eprintln!("[recover] re-enqueued {} ({})", rec.id, rec.filename),
            Err(e) => eprintln!("[recover] {} stays interrupted: {e}", rec.id),
        }
    }
}

/// 用一条持久化记录重建任务并入队（保留原 id，界面行标识不变）。
async fn requeue(st: &Arc<AppState>, rec: &EngineTaskRecord) -> Result<(), String> {
    let output = PathBuf::from(&rec.output);
    if let Some(parent) = output.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create dir: {e}"))?;
    }
    let proxy = Some(st.config.read().unwrap().proxy.clone());
    let (proto, parsed, meta) = probe_url(st, &rec.url, proxy.as_ref()).await?;
    // 恢复时用记录里存下来的并发数（用户设过的），其余按探测结果重建。
    // 落盘路径**不重新分类、不重命名**：上次已经落到那儿了，再走一遍
    // 「name (1).ext」等于把一次中断变成两份文件。
    let cfg = DownloadConfig {
        destination: output.parent().map(PathBuf::from),
        block_size: 1 << 20,
        max_concurrency: rec.max_concurrency.max(1),
        // 镜像/网卡绑定是**请求级**的增强项，恢复时没有来源（库里不存），
        // 按缺省处理 —— 宁可少一路镜像，也不能凭空造一个用户没要求过的源。
        mirrors: Vec::new(),
        interfaces: None,
        supports_range: Some(meta.supports_range),
        proxy,
    };
    let task = build_task(st, &proto, &parsed, &meta, &output, &rec.id, &cfg).await?;
    // 用户**暂停过**的任务，重启后仍然是暂停的 —— 暂停是用户意图，
    // 进程消失不是「用户改了主意」。替他继续下载等于代做决定，
    // 而他最有理由暂停的时候（带宽被占、磁盘要留空间）恰恰是重启之后。
    // 于是：重建出来的 Task 先置暂停，再进 run —— 用户点继续才真的继续。
    if rec.status == ST_PAUSED {
        task.control.paused.store(true, Ordering::SeqCst);
    }
    let dt = DownloadTask {
        task: task.clone(),
        url: rec.url.clone(),
        filename: rec.filename.clone(),
        output,
        added_at: rec.added_at,
        max_concurrency: rec.max_concurrency,
        category: rec.category.clone(),
        error: tokio::sync::Mutex::new(None),
    };
    spawn_task(st, rec.id.clone(), task);
    st.tasks.lock().await.insert(rec.id.clone(), dt);
    // 状态恢复到**用户离开时的那个**：暂停的仍是 paused，在跑的才是 downloading。
    st.set_task_status(&rec.id, &rec.status).await;
    Ok(())
}

async fn add(
    State(st): State<Arc<AppState>>,
    Json(req): Json<AddReq>,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    if req.url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "url is required"})),
        );
    }

    // 代理：请求级覆盖 > daemon 配置 [proxy] 段（探测与下载同路径）
    let proxy = req
        .proxy
        .clone()
        .or_else(|| Some(st.config.read().unwrap().proxy.clone()));
    // 解析 + 探测：与 BUG-319 启动恢复共用 `probe_url`，两处只可能有一份行为。
    let (proto, parsed, meta) = match probe_url(&st, &req.url, proxy.as_ref()).await {
        Ok(v) => v,
        Err(e) => {
            // 不支持的 scheme 是**用户输入**的错（400）；解析/探测失败是上游问题（500）。
            let code = if e.starts_with("unsupported scheme") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return (
                code,
                axum::Json(serde_json::json!({"error": e})),
            )
        }
    };

    let id = Uuid::new_v4().to_string();
    // 文件名解析优先级（BUG-001）：用户显式指定 → 嗅探(Content-Disposition) → URL 路径末段 → <id>.bin
    let filename = req
        .filename
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| meta.filename.clone().filter(|s| !s.is_empty()))
        .or_else(|| {
            parsed
                .path
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| format!("{id}.bin"));

    // 三层目录解析 + 自动分类（R3）：
    // - 请求显式指定 output_path → 尊重用户选择，不分类
    // - classify=true 或（classify=None 且配置开启）→ 按扩展名归档子目录
    // - 否则 → 默认下载目录根（回归）
    let category: Option<String>;
    let (mut output, mut cfg) = {
        let cfg_guard = st.config.read().unwrap();
        // 始终按设置 classify_rules 推导分类名（不依赖 enabled：enabled 仅控制是否落子目录，
        // 这里无论是否落子目录都给任务打分类标签，供前端「全部文件」按分类筛选）。
        category = Some(cfg_guard.classify.classify(&filename));
        let classify_on = req.classify.unwrap_or(cfg_guard.classify.enabled);
        let output = if classify_on {
            resolve_output_classified(
                req.output_path.as_deref(),
                &cfg_guard,
                &filename,
                classify_on,
            )
        } else {
            resolve_output(req.output_path.as_deref(), &cfg_guard, &filename)
        };
        let cfg = DownloadConfig {
            destination: output.parent().map(PathBuf::from),
            block_size: 1 << 20,
            max_concurrency: cfg_guard.max_connections,
            mirrors: req.mirrors.clone(),
            interfaces: req.interfaces.clone(),
            supports_range: Some(meta.supports_range),
            proxy: proxy.clone(),
        };
        (output, cfg)
    };
    if let Some(parent) = output.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "create dir", "detail": e.to_string()})),
            );
        }
    }

    // 完整度检测：目标文件已存在且大小等于探测到的总大小 → 拒绝重复下载。
    // 完整度检测：目标文件已存在且大小等于探测到的总大小 → 处理重复下载。
    // （引擎的断点续传会把已有长度标记为已完成，若 len >= total 会“秒完成”且无校验，
    //   用户无法判断文件是否完整，这里拦截处理。）
    // overwrite=true → 删除旧文件重新下载；否则 → 自动重命名（name (1).ext）继续下载。
    let mut renamed = false;
    if meta.total_size > 0 {
        if let Ok(md) = tokio::fs::metadata(&output).await {
            if md.is_file() && md.len() == meta.total_size {
                if req.overwrite {
                    match tokio::fs::remove_file(&output).await {
                        Ok(()) => {}
                        Err(e) => {
                            return (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                axum::Json(serde_json::json!({
                                    "error": "remove old file",
                                    "detail": format!("删除旧文件失败: {e}")
                                })),
                            );
                        }
                    }
                } else {
                    // 自动重命名：name (1).ext / name (2).ext … 直到不冲突
                    let new_output = next_free_path(&output).await;
                    eprintln!(
                        "[download] file exists, auto-rename {} -> {}",
                        output.display(),
                        new_output.display()
                    );
                    output = new_output;
                    cfg.destination = output.parent().map(PathBuf::from);
                    renamed = true;
                }
            }
        }
    }

    let task = match build_task(&st, &proto, &parsed, &meta, &output, &id, &cfg).await {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "create task", "detail": e})),
            )
        }
    };

    let added_at = now_secs();
    let dt = DownloadTask {
        task: task.clone(),
        url: req.url.clone(),
        filename: if renamed { output.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| filename.clone()) } else { filename.clone() },
        output: output.clone(),
        added_at,
        max_concurrency: cfg.max_concurrency,
        category: category.clone(),
        error: tokio::sync::Mutex::new(None),
    };


    let resp_filename = output.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| filename.clone());
    // BUG-319：入队即登记。**登记与传输分离** —— 用户加入队列的那一刻记录就落库
    // （哪怕一个字节都还没下），与媒体库「先登记、字节异步补齐」同源。
    // 只写这一次 + 终态那一次，进度本身不落盘（否则每轮询一次就写一次，IO 热点）。
    let rec = AppState::record_of(&dt, ST_DOWNLOADING, meta.total_size, 0, added_at, None);
    // 后台运行；终态由 `spawn_task` 落库（与启动恢复共用同一段终态处理）。
    spawn_task(&st, id.clone(), task.clone());
    st.tasks.lock().await.insert(id.clone(), dt);
    st.persist(&rec).await;

    (
        StatusCode::CREATED,
        axum::Json(serde_json::json!({"id": id, "filename": resp_filename})),
    )
}

/// `GET /api/downloads/:id` — 单行。内存里没有的行也要能查到（它在库里）。
async fn get_one(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let rows = crate::activity::engine_rows(&st).await;
    let hit = rows.into_iter().find(|x| x.id == id);
    match hit {
        None => StatusCode::NOT_FOUND.into_response(),
        Some(r) => {
            let detail = match &r.live {
                Some(t) => Some(t.progress().await),
                None => None,
            };
            axum::Json(DownloadStatus::from_row(&r, detail.as_ref(), now_secs())).into_response()
        }
    }
}

async fn action(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<ActionReq>,
) -> Result<axum::Json<serde_json::Value>, StatusCode> {
    // 副作用在锁内、落库在锁外：持着任务表的锁去 await DB 会把整张表堵在后面。
    // 返回值是（响应里的动作标签，库里的状态）—— 两者刻意不同名：
    // 「resumed」是给调用方的人话，「downloading」是库内状态机的字面量。
    // BUG-392：统一状态变更 —— `tg:<id>` 行由服务端代理到 orig-tg，
    // UI 只认这一个入口（不再直连 orig-tg，避免端口顺延后动作对空端口发）。
    if let Some(tg_id) = id.strip_prefix("tg:") {
        return tg_control(&st, tg_id, &q.action).await.map(axum::Json);
    }
    let (label, next_status) = {
        let tasks = st.tasks.lock().await;
        let dt = tasks.get(&id).ok_or(StatusCode::NOT_FOUND)?;
        match q.action.as_str() {
            "pause" => {
                dt.task.control.paused.store(true, Ordering::SeqCst);
                dt.task
                    .events
                    .send(SseEvent::Paused { id: id.clone() })
                    .ok();
                ("paused", ST_PAUSED)
            }
            "resume" => {
                dt.task.control.paused.store(false, Ordering::SeqCst);
                dt.task.control.resume.notify_waiters();
                dt.task
                    .events
                    .send(SseEvent::Resumed { id: id.clone() })
                    .ok();
                ("resumed", ST_DOWNLOADING)
            }
            "cancel" => {
                dt.task.control.cancel.cancel();
                dt.task
                    .events
                    .send(SseEvent::Deleted { id: id.clone() })
                    .ok();
                ("cancelled", ST_CANCELLED)
            }
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    };
    // BUG-319：状态迁移落库。取消的行**不删** —— 它是用户做过的事，
    // 重启后还在列表里，与「失败」区分开。
    st.set_task_status(&id, next_status).await;
    Ok(axum::Json(serde_json::json!({"status": label, "id": id})))
}

async fn delete_one(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<axum::Json<serde_json::Value>, StatusCode> {
    // 终态行已让出内存句柄（见 `spawn_task` 收尾）⇒ 必须「内存 + 库」两处都查，
    // 只查内存会让终态行删不掉 —— 而它恰恰是用户最想清掉的那一行。
    // BUG-392：统一状态变更（删除同属状态变更，走同一入口）。
    if let Some(tg_id) = id.strip_prefix("tg:") {
        return tg_control(&st, tg_id, "delete").await.map(axum::Json);
    }
    let dt = st.tasks.lock().await.remove(&id);
    if dt.is_none() && !st.record_exists(&id).await {
        return Err(StatusCode::NOT_FOUND);
    }
    // 顺序：**先删记录，再取消**。反了的话，正在跑的任务被取消后由后台收尾
    // 落一条终态记录回来 —— 用户刚删掉的行又复活了。
    // BUG-319：删除是**唯一**让记录消失的路径，且只由用户的显式删除触发。
    // 取消（action=cancel）不删记录 —— 它是结果，要留在列表里。
    st.forget(&id).await;
    if let Some(dt) = dt {
        dt.task.control.cancel.cancel();
        dt.task
            .events
            .send(SseEvent::Deleted { id: id.clone() })
            .ok();
    }
    Ok(axum::Json(serde_json::json!({"status": "deleted", "id": id})))
}

async fn events(
    State(st): State<Arc<AppState>>,
) -> Sse<impl futures::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = st.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|r| async move {
        match r {
            Ok(ev) => Some(Ok(Event::default().event(ev.name()).data(ev.data_json()))),
            Err(_) => None,
        }
    });
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

/// GET /api/activity — 传输中**只读**聚合视图（BUG-077 方案 (a)）。
///
/// 把本进程内存里的普通下载任务，与 orig-tg（9877）的缓存任务合并成统一 `TaskView`。
/// 语义与端点边界（改动前必读 `activity.rs` 顶部五条铁律）：
/// - **只读**：不写任何一侧的存储；
/// - **控制分流**：写操作仍走 `/api/downloads/:id` 与 `/api/cache/*`，这里只给
///   `control`（归属侧 + 原生 id）与 `actions`（真实具备的动词）；
/// - **不给统一删除**，对 TG 侧**不给暂停/继续**（无真续传，那会是假能力）；
/// - **恒 200**：9877 不可达时降级为「该来源不可用」，普通下载任务照常返回。
///
/// 复用现有 `/api/events` 广播做刷新触发 —— **不新建 SSE 通道**（架构裁定）；
/// 该通道只承载下载侧事件，TG 侧由前端按轮询周期一并拉回。
async fn activity(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ActivityQuery>,
) -> axum::Json<ActivitySnapshot> {
    axum::Json(activity::collect(&st, q.scope()).await)
}

/// BUG-395 第一步：`GET /api/sources` —— 来源健康独立端点。
///
/// 把「横幅要不要显示」这个全局问题从 58KB 任务列表里摘出来：本端点只有约 200B，
/// 可独立于 `/api/activity`/`/api/downloads` 低频轮询。`sources` 口径与
/// `ActivitySnapshot.sources` 逐字一致；`/api/downloads` 的 `sources` 保留为兼容字段。
async fn sources(State(st): State<Arc<AppState>>) -> axum::Json<SourcesSnapshot> {
    axum::Json(activity::source_health(&st).await)
}

/// BUG-392：**统一列表端点** —— 全来源（插件/TG 入库 + 原生引擎 + BT）一个列表。
///
/// 此前 `/api/downloads` 只回引擎原生面（于是它长期只挂着 1 条 mock 夹具，被读成
/// 「数据只有一条」），统一聚合面却是另一个端点 `/api/activity`；UI 只认后者，
/// 两个 endpoint 各说一半。用户共识：下载只有**一个列表接口**。
/// 原引擎原生列表退居 `/api/downloads/native`（调试/详情投影，非 UI 列表路径）。
async fn list_unified(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ActivityQuery>,
) -> axum::Json<ActivitySnapshot> {
    axum::Json(activity::collect(&st, q.scope()).await)
}

/// BUG-392：**统一状态变更接口**的 TG 侧代理。
///
/// 共识是「一个列表接口 + 一个状态变更接口」。此前 TG 入库行的取消/重试/优先下载
/// 由前端**直连 orig-tg**（`/api/tg/cache/tasks/...`），UI 同时认两个域 ——
/// orig-tg 重启顺延端口后前端手里是旧端口，动作全失败而列表照常显示。
/// 现在由 daemon 服务端分流：端口真源只有 `st.tg_port_state()` 一处（BUG-318）。
///
/// **不造假**：TG 无断点续传 ⇒ pause/resume 一律 422（activity.rs 五铁律④）。
async fn tg_control(
    st: &AppState,
    id: &str,
    action: &str,
) -> Result<serde_json::Value, StatusCode> {
    let base = format!("http://127.0.0.1:{}", st.tg_port_state());
    let (method, url, body): (&str, String, Option<serde_json::Value>) = match action {
        "cancel" | "delete" => ("DELETE", format!("{base}/api/tg/cache/tasks/{id}"), None),
        "retry" => ("POST", format!("{base}/api/tg/cache/tasks/{id}/retry"), None),
        // 优先下载（BUG-277）：置顶数值由 orig-tg 算，前端只给意图。
        "prefer" => (
            "POST",
            format!("{base}/api/tg/cache/tasks/{id}/priority"),
            Some(serde_json::json!({"top": true})),
        ),
        "unprefer" => (
            "POST",
            format!("{base}/api/tg/cache/tasks/{id}/priority"),
            Some(serde_json::json!({"priority": 0})),
        ),
        "pause" | "resume" => return Err(StatusCode::UNPROCESSABLE_ENTITY),
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    let mut req = match method {
        "DELETE" => st.http.delete(&url),
        _ => st.http.post(&url),
    };
    if let Some(b) = body {
        // reqwest 未开 `json` feature：手写 content-type + body，语义等价。
        req = req
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(b.to_string());
    }
    let resp = req.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !resp.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    Ok(serde_json::json!({"id": format!("tg:{id}"), "action": action}))
}

/// GET /api/config — 当前 daemon 配置（供设置页初始化）。
///
/// **出参纪律（BUG-357）**：所有**路径**字段一律走 [`dir_out`] —— 同一响应里曾同时出现
/// `D:/OrigDown`、`D:\OrigDown`、`C:\Users\…` 三种斜杠形态，而前端要拿它们做「是否
/// 同一目录」的比较与展示 ⇒ 必然误判（用户原话「返回的路径混乱错误」）。
async fn get_config(State(st): State<Arc<AppState>>) -> axum::Json<serde_json::Value> {
    // 先把配置读成一个**不含 guard 的快照**：`plugins_snapshot` 要 await（探活子进程），
    // 而 `RwLockReadGuard` 跨 await 会让整个 future 变成 !Send ⇒ axum 直接报
    // `Handler` 未实现（实测踩过，报错完全看不出根因是 guard）。
    let (
        download_dir,
        library_root,
        effective_root,
        manual_root,
        max_connections,
        classify_enabled,
        classify_rules,
        proxy_mode,
        proxy_url,
    ) = {
        let cfg = st.config.read().unwrap();
        let map = cfg.classify.merged_map();
        let mut sorted: Vec<(String, String)> = map.into_iter().collect();
        sorted.sort();
        let rules: serde_json::Map<String, serde_json::Value> = sorted
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();
        (
            cfg.download_dir.as_deref().map(dir_out),
            dir_out(&crate::config::library_root(&cfg)),
            dir_out(&crate::config::effective_download_root(&cfg)),
            dir_out(&crate::config::manual_download_root(&cfg)),
            cfg.max_connections,
            cfg.classify.enabled,
            rules,
            match cfg.proxy.mode {
                orig_core::protocol::ProxyMode::Direct => "direct",
                orig_core::protocol::ProxyMode::System => "system",
                orig_core::protocol::ProxyMode::Custom => "custom",
            },
            cfg.proxy.url.clone(),
        )
    };
    let plugins = plugins_snapshot(&st).await;
    let logs_dir = log_dir();
    axum::Json(serde_json::json!({
        // daemon 实际监听端口（可能与配置端口不同：保留区顺延，BUG-178）。
        // 前端与桌面壳一律读它，不得各自硬编码 9876。
        "port": st.port,
        "download_dir": download_dir,
        // BUG-323（用户 2026-10-16 裁定）：库根 = `<生效下载路径>/.orighub/library`，
        // **派生值**（2026-10-21「内部文件不入治理」把它挪进引擎工作区，下载根顶层
        // 只留用户内容）。
        // 键名由 `library_dir` 改为 `library_root` —— 值语义变了（不再是可配项），
        // 沿用旧键名会让调用方以为它还能被写回去。
        "library_root": library_root,
        // 生效下载路径（= 受管根 / 权限边界）：配置值或平台默认。前端「当前生效」
        // 直出它，不自己拼（拼出来必然与引擎漂移）。
        "effective_download_root": effective_root,
        // BUG-323：手动下载**未配置** `download_dir` 时的实际默认根
        // （= 名义默认过禁用盘规则后的值：`~/Downloads` 在 C: 上 ⇒ D:/OrigDown）。
        // 前端用它作占位，不自己拼路径。
        "manual_download_root": manual_root,
        // **名义**系统默认下载目录（Windows = SHGetKnownFolderPath(FOLDERID_Downloads)，
        // 如 C:/Users/<user>/Downloads）—— 仅名义值：用户 2026-10-19 裁定
        // 「~/Downloads是默认设置,但是不使用,改用加载配置的D盘设置」，实际落点看
        // `manual_download_root` / `effective_download_root`（两者都会把 C: 改道到 D:）。
        // 保留下发只为让前端能显示「默认是什么」，不得直接当写点。
        "default_download_dir": dir_out(&orig_core::paths::default_download_dir()),
        "max_connections": max_connections,
        "classify_enabled": classify_enabled,
        "classify_rules": classify_rules,
        "proxy": {
            "mode": proxy_mode,
            "url": proxy_url,
        },
        // 插件清单（BUG-358）：契约里**不得**再出现 `tg_enabled` 这类把插件名写死的键
        // （用户原话：「"tg_enabled"这些都是什么？毫无共通性…我把TG改成BB，这个还能用吗？」）。
        // 前端按 `id` 取自己那一份，不认识就跳过 ⇒ 换插件不需要改前端。
        "plugins": plugins,
        // 调试日志（BUG-243）：把**路径**下发给设置-关于页，用户出错时能直接去查，
        // 不必先问「日志在哪」。目录与文件同源（`state::log_dir()`），前端不拼路径。
        // orig-tg.log = 子进程完整 stdout/stderr（启动失败原因就在里面）；
        // errors.log  = daemon 记录的核心错误（append-only）。
        "logs": {
            "dir": dir_out(&logs_dir),
            "orig_tg": dir_out(&logs_dir.join("orig-tg.log")),
            "errors": dir_out(&logs_dir.join("errors.log")),
        },
    }))
}

/// 路径字段的统一出参形态（BUG-357）。
///
/// 正向斜杠 + 折叠重复分隔符。**只作用于下发的字符串**，不改内部语义：
/// 边界判定/落点仍用 `PathBuf`，但凡是"给外面看/给外面比"的路径，形态必须唯一 ——
/// `D:\OrigDown` 与 `D:/OrigDown` 是同一个目录，前端按字符串比较却会判成两个。
///
/// 2026-10-22：实现收敛到 [`orig_core::paths::to_wire`]（同一个规则只能有一份）。
/// 保留本函数只是为了让调用点读起来仍是「出参形态」，逻辑不再重复。
fn dir_out(p: &std::path::Path) -> String {
    orig_core::paths::to_wire(p)
}

/// 插件注册表 —— **契约的唯一声明点**（BUG-358）。
///
/// 用户 2026-10-21 裁定：「最初定义就是以共通插件化来做…我把TG改成BB，这个还能用吗？
/// 插件是要即插即用的，当前设计实现完全错误」。
///
/// 加一个插件 = 这里加一行 + 实现它的监督器（spawn/探活/重启）。**前端与
/// `/api/config` 契约都不需要改** —— 它们只认 `id`，不认 `tg`。
struct PluginSpec {
    /// 稳定标识（前端按它取；**不得**出现在 `/api/config` 的顶层键里）。
    id: &'static str,
    /// 展示名（界面文案的唯一来源，前端不再自己写「Telegram」）。
    label: &'static str,
}

const PLUGIN_TG: &str = "tg";

const PLUGINS: &[PluginSpec] = &[PluginSpec { id: PLUGIN_TG, label: "Telegram" }];

/// 插件运行态快照（`/api/config` 与启停/重启端点的**同一份**出参）。
///
/// 字段名用 camelCase：这是给前端消费的契约，与其它 HTTP 边界一致（BUG 族：
/// snake/camel 混用会让参数被静默忽略）。`health` 只有实现了链路巡检的插件才有。
async fn plugins_snapshot(st: &Arc<AppState>) -> Vec<serde_json::Value> {
    let mut out = Vec::with_capacity(PLUGINS.len());
    for spec in PLUGINS {
        // 监督器按 id 分派：目前只有 TG 一家实现了 spawn/探活/自愈。
        // 新增插件时在这里加一条分支（前端无感），而不是在契约里加 `bb_enabled`。
        //
        // 读配置必须在**独立语句块**里取完：`RwLockReadGuard` 跨 await 会让 future
        // 变成 !Send（axum 只报「Handler 未实现」，看不出根因）。
        let enabled = if spec.id == PLUGIN_TG {
            let v = st.config.read().unwrap().tg_enabled;
            v
        } else {
            false
        };
        let (running, port, last_error, health) = if spec.id == PLUGIN_TG {
            (
                st.tg_is_running().await,
                st.tg_port_state(),
                st.tg_last_error(),
                Some(st.tg_link_status()),
            )
        } else {
            (false, 0u16, None, None)
        };
        let mut entry = serde_json::json!({
            "id": spec.id,
            "label": spec.label,
            "enabled": enabled,
            "running": running,
            "port": port,
            "lastError": last_error,
        });
        if let Some(h) = health {
            // BUG-351：链路健康 + 自愈历史（`restarts`/`lastRestartAt` 让界面能如实说
            // 「最近重启过 N 次」，而不是在几百 ms 的重启窗口里恒绿）。
            entry["health"] = serde_json::json!({
                "linkDown": h["link_down"],
                "downStreak": h["down_streak"],
                "confirmsRequired": h["confirms_required"],
                "restarts": h["restarts"],
                "lastRestartAt": h["last_restart_at"],
                "reason": h["reason"],
            });
        }
        out.push(entry);
    }
    out
}

#[derive(Deserialize)]
pub struct ClassifyUpdateReq {
    pub enabled: bool,
    /// 扩展名（小写，无点）→ 分类目录名；完整覆盖用户自定义部分。
    pub rules: HashMap<String, String>,
}

/// PUT /api/config/download — 保存下载目录（运行时生效 + 持久化到 download-engine.toml）。
/// body: `{"dir": "D:/Videos"}`；`dir` 空/缺省 = 回到平台默认目录（`default_download_dir`）。
///
/// BUG-234：此前 `download_dir` 只有 GET（`/api/config`），设置页保存只写 localStorage，
/// 用户改了目录下载照旧 —— 分类/代理/TG 都有「运行时生效 + 持久化」端点，唯它漏掉。
///
/// **BUG-323**：下载路径是全部文件的唯一容器（库根 = 其下 `library`），因此保存后
/// **立即把生效路径下发给 orig-tg**（`PUT /api/tg/config`），不依赖「改完重启引擎」。
/// TG 不可用时**不静默**：把原因带回响应（`tg_error`）并写日志，但本次保存不回滚
/// （daemon 侧已落库，回滚会让用户看到「保存失败」却查不出所以然）。
async fn put_config_download(
    State(st): State<Arc<AppState>>,
    Json(req): Json<DownloadUpdateReq>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    let dir = req
        .dir
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        // BUG-323 复报（2026-10-19）：`~` 展开后收敛分隔符字面再入库。
        // 活栈实测：无归一化时 `D:\\OrigDown` 一路存成 `D://OrigDown`，
        // 界面（`D:\OrigDown`）与引擎（`D://OrigDown`）从此各说各话。
        .map(|d| {
            orig_core::paths::normalize_dir(
                &orig_core::paths::expand_tilde(&d).to_string_lossy(),
            )
        });
    {
        let mut cfg = st.config.write().unwrap();
        cfg.download_dir = dir.map(std::path::PathBuf::from);
        // 持久化（读锁已释放）
        cfg.save_download_dir("download-engine.toml")
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("persist download config: {e}"),
                )
            })?;
    }
    let (eff, lib) = {
        let cfg = st.config.read().unwrap();
        (
            crate::config::effective_download_root(&cfg),
            crate::config::library_root(&cfg),
        )
    };
    let (tg_synced, tg_error) = sync_tg_download_dir(&st, &eff).await;
    let cfg = st.config.read().unwrap();
    Ok(axum::Json(serde_json::json!({
        "ok": true,
        "download_dir": cfg.download_dir.as_ref().map(|p| dir_out(p)),
        "default_download_dir": dir_out(&orig_core::paths::default_download_dir()),
        // 生效路径与派生的库根：前端据此刷新「当前生效」与库根展示，不自己拼。
        "effective_download_root": dir_out(&eff),
        "library_root": dir_out(&lib),
        "tg_synced": tg_synced,
        "tg_error": tg_error,
    })))
}

/// 把生效下载路径下发给 orig-tg（`PUT /api/tg/config {downloadDir}`）。
///
/// 返回 `(synced, error)`。失败**不静默**（BUG-167：用户主动操作的失败必须可见）：
/// 原因同时进响应与 daemon 日志；成功则记账，避免巡检重复推送。
/// 下载路径未同步时 TG 的库根/落点会停在旧值（`sync_download_root_if_needed` 会在
/// 下一轮巡检自动重试）。
async fn sync_tg_download_dir(st: &AppState, dir: &std::path::Path) -> (bool, Option<String>) {
    let want = dir.to_string_lossy().into_owned();
    match st.push_tg_download_root(&want).await {
        Ok(()) => {
            *st.tg_synced_download_root.lock().await = Some(want);
            (true, None)
        }
        Err(e) => {
            eprintln!("[warn] {e}");
            (false, Some(e))
        }
    }
}

#[derive(Deserialize)]
pub struct DownloadUpdateReq {
    /// 目标下载目录；空串/缺省 = 清除设置，回退平台默认。
    #[serde(default)]
    pub dir: Option<String>,
}

#[derive(Deserialize)]
pub struct LibraryUpdateReq {
    /// 已废字段：仅为把「旧调用方仍在写库根」解析出来并给出 422（而不是 400/静默无效）。
    #[serde(default)]
    #[allow(dead_code)]
    pub dir: Option<String>,
}

/// PUT /api/config/library — **已废（BUG-323，用户 2026-10-16 裁定）**：库根不可独立配置。
///
/// 库根是 `<生效下载路径>/library` 的**派生值**（用户：「库根跟下载走，所有文件不允许
/// 脱离下载路径，下载路径是所有权限的限制路径」）。因此本端点恒 422 并直出正确做法
/// （改 `PUT /api/config/download`）—— 让「库根脱离下载路径」在接口层不可表达，
/// 而不是收下后写进 toml 变成第二个根。
///
/// 历史：D23-A⑥ 曾让设置页「库根目录」同时写 daemon 与 TG，两边共用一个可配根；
/// 这正是「两个根」的来源，已整条撤回。
async fn put_config_library(
    State(_st): State<Arc<AppState>>,
    Json(_req): Json<LibraryUpdateReq>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    Err((
        StatusCode::UNPROCESSABLE_ENTITY,
        "library_dir is derived from the download directory \
         (<download_dir>/.orighub/library) and cannot be set independently; \
         set the download directory instead (BUG-323)"
            .to_string(),
    ))
}

/// PUT /api/config/classify — 保存自动分类规则（运行时生效 + 持久化到 download-engine.toml）。
/// body: {"enabled": bool, "rules": {"mp4": "Videos", ...}}
/// rules 为完整覆盖：先合并内置默认，再应用用户覆盖（未提供的扩展名回退默认分类）。
async fn put_config_classify(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ClassifyUpdateReq>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    // 完整覆盖写入
    {
        let mut cfg = st.config.write().unwrap();
        cfg.classify.map = req.rules;
        cfg.classify.enabled = req.enabled;
        // 持久化（读锁已释放）
        cfg.save_classify_map(&cfg.classify.map).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("persist classify config: {e}"),
            )
        })?;
    }
    let merged = st.config.read().unwrap().classify.merged_map();
    let mut sorted: Vec<(String, String)> = merged.into_iter().collect();
    sorted.sort();
    let rules: serde_json::Map<String, serde_json::Value> = sorted
        .into_iter()
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect();
    Ok(axum::Json(serde_json::json!({
        "ok": true,
        "classify_enabled": st.config.read().unwrap().classify.enabled,
        "classify_rules": rules,
    })))
}

/// PUT /api/config/proxy — 保存 HTTP 下载代理配置（运行时生效 + 持久化到 download-engine.toml）。
/// body: {"mode": "direct"|"system"|"custom", "url": "http://..."|"socks5://..."}
#[derive(Deserialize)]
pub struct ProxyUpdateReq {
    pub mode: String,
    #[serde(default)]
    pub url: Option<String>,
}

async fn put_config_proxy(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ProxyUpdateReq>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    let mode = match req.mode.as_str() {
        "system" => orig_core::protocol::ProxyMode::System,
        "custom" => orig_core::protocol::ProxyMode::Custom,
        _ => orig_core::protocol::ProxyMode::Direct,
    };
    // custom 模式必须给 url
    if mode == orig_core::protocol::ProxyMode::Custom {
        let url = req.url.as_deref().unwrap_or("");
        if url.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "custom proxy requires url".into()));
        }
    }
    let url = req.url.filter(|u| !u.is_empty());
    {
        let mut cfg = st.config.write().unwrap();
        cfg.proxy.mode = mode;
        cfg.proxy.url = url;
        cfg.save_proxy("download-engine.toml")
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("persist proxy config: {e}")))?;
    }
    let cfg = st.config.read().unwrap();
    Ok(axum::Json(serde_json::json!({
        "ok": true,
        "proxy": {
            "mode": match cfg.proxy.mode {
                orig_core::protocol::ProxyMode::Direct => "direct",
                orig_core::protocol::ProxyMode::System => "system",
                orig_core::protocol::ProxyMode::Custom => "custom",
            },
            "url": cfg.proxy.url,
        },
    })))
}

/// POST /api/proxy/verify — 验证代理连通性（HTTP(S)/SOCKS5 均可）。
/// 通过给定代理对 `api.telegram.org` 发起 TLS 连接，返回是否可达与耗时。
/// body: {"mode": "direct"|"system"|"custom", "url": "http://..."|"socks5://..."}
#[derive(Deserialize)]
pub struct ProxyVerifyReq {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub url: Option<String>,
}

async fn post_proxy_verify(
    Json(req): Json<ProxyVerifyReq>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    let mode = match req.mode.as_str() {
        "system" => orig_core::protocol::ProxyMode::System,
        "custom" => orig_core::protocol::ProxyMode::Custom,
        _ => orig_core::protocol::ProxyMode::Direct,
    };
    let proxy = orig_core::protocol::ProxyConfig {
        mode,
        url: req.url.filter(|u| !u.is_empty()),
    };

    let target = "https://api.telegram.org";
    let started = std::time::Instant::now();
    let result = verify_proxy(&proxy, target).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(status) => Ok(axum::Json(serde_json::json!({
            "ok": true,
            "latency_ms": latency_ms,
            "status": status.as_u16(),
            "target": target,
        }))),
        Err(e) => Err((StatusCode::BAD_GATEWAY, format!("proxy unreachable: {e}"))),
    }
}

/// 通过指定代理对 `target` 发起一次 HTTPS 探测请求，返回响应状态码。
async fn verify_proxy(
    proxy: &orig_core::protocol::ProxyConfig,
    target: &str,
) -> Result<reqwest::StatusCode, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(8))
        // 纯连通性探测：仅关心代理能否把流量送达目标，不校验证书/吊销，
        // 否则 schannel 的吊销检查会误判可用代理为不可达。
        .danger_accept_invalid_certs(true)
        .use_rustls_tls();
    builder = match proxy.mode {
        orig_core::protocol::ProxyMode::Direct => builder.no_proxy(),
        orig_core::protocol::ProxyMode::System => builder,
        orig_core::protocol::ProxyMode::Custom => match &proxy.url {
            Some(u) => {
                // socks5h = 远端 DNS（经代理解析域名）；socks5 本地解析会拿到被污染的 IP，
                // 导致真实可达代理被判不可达（curl --socks5-hostname 同理）。
                let probe_url = u
                    .replace("socks5://", "socks5h://")
                    .replace("socks://", "socks5h://");
                match reqwest::Proxy::all(&probe_url) {
                    Ok(p) => builder.proxy(p),
                    Err(e) => return Err(format!("invalid proxy url {u:?}: {e}")),
                }
            }
            None => builder.no_proxy(),
        },
    };
    let client = builder.build().map_err(|e| e.to_string())?;
    let resp = client.get(target).send().await.map_err(|e| e.to_string())?;
    Ok(resp.status())
}

/// 插件启停请求体（与插件无关：所有插件都是「开/关」两个动作）。
#[derive(Deserialize)]
pub struct TgUpdateReq {
    pub enabled: bool,
}

/// PUT /api/plugins/:id/enabled — 启停一个可选插件（运行时生效 + 持久化）。
/// body: {"enabled": bool}
///
/// BUG-358：契约里不再出现 `tg` —— 前端只认 `id`（见 [`PLUGINS`]）。旧路径
/// `PUT /api/config/tg` 保留为别名（桌面壳与旧版前端仍在调，不做破坏性移除）。
async fn put_plugin_enabled(
    State(st): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<TgUpdateReq>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    if !PLUGINS.iter().any(|p| p.id == id) {
        return Err((
            StatusCode::NOT_FOUND,
            format!("unknown plugin id: {id}"),
        ));
    }
    // 目前只有 TG 一家有监督器；新增插件在此加分支（前端无感）。
    if req.enabled {
        {
            let mut cfg = st.config.write().unwrap();
            cfg.tg_enabled = true;
            cfg.save_tg("download-engine.toml").map_err(|e| {
                (StatusCode::INTERNAL_SERVER_ERROR, format!("persist plugin config: {e}"))
            })?;
        }
        st.tg_start().await.map_err(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("start {id}: {e}"))
        })?;
    } else {
        {
            let mut cfg = st.config.write().unwrap();
            cfg.tg_enabled = false;
            cfg.save_tg("download-engine.toml").map_err(|e| {
                (StatusCode::INTERNAL_SERVER_ERROR, format!("persist plugin config: {e}"))
            })?;
        }
        st.tg_stop().await;
    }
    Ok(axum::Json(serde_json::json!({
        "ok": true,
        "plugins": plugins_snapshot(&st).await,
    })))
}

/// POST /api/plugins/:id/restart — 重启一个插件（**daemon 是唯一执行者**）。
///
/// 为什么单独开一个端点（BUG-178）：orig-tg 只在启动时连一次 Telegram，凭证补齐 /
/// 网络修好后**必须重启**才生效。以前这个动作散在桌面壳 `ensure_tg` 与前端
/// 「重试连接」两处，TG 进程因此有两个主人、互相 kill。现在只有这一个入口：
/// 凭证保存 / 链路恢复 / 用户点「重新连接」都归一到这里，由 daemon 独占执行。
async fn post_plugin_restart(
    State(st): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    if !PLUGINS.iter().any(|p| p.id == id) {
        return Err((
            StatusCode::NOT_FOUND,
            format!("unknown plugin id: {id}"),
        ));
    }
    let enabled = st.config.read().unwrap().tg_enabled;
    if !enabled {
        return Err((
            StatusCode::CONFLICT,
            format!("plugin {id} is disabled; enable it before restarting"),
        ));
    }
    st.tg_restart().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("restart {id}: {e}"),
        )
    })?;
    Ok(axum::Json(serde_json::json!({
        "ok": true,
        "plugins": plugins_snapshot(&st).await,
    })))
}

/// 旧路径别名：`PUT /api/config/tg` → [`put_plugin_enabled`]（id 固定 `tg`）。
///
/// 保留原因：桌面壳与旧版前端仍调它；破坏性移除会让「壳能起、界面报错」。
/// 新代码一律走 `/api/plugins/:id/enabled`。
async fn put_config_tg(
    State(st): State<Arc<AppState>>,
    Json(req): Json<TgUpdateReq>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    put_plugin_enabled(State(st), axum::extract::Path(PLUGIN_TG.to_string()), Json(req)).await
}

/// 旧路径别名：`POST /api/tg/restart` → [`post_plugin_restart`]（id 固定 `tg`）。
async fn post_tg_restart(
    State(st): State<Arc<AppState>>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    post_plugin_restart(State(st), axum::extract::Path(PLUGIN_TG.to_string())).await
}

/// `/api/interfaces` 结果缓存（BUG-092）。
///
/// `orig_net::list_all_adapters()` 走 Windows `GetAdaptersAddresses`，实测单次约 1s；
/// 而该端点由「新建下载弹窗一打开」触发 → 弹窗开合肉眼可见卡顿。网卡清单极少变化，
/// 故按 TTL 缓存。TTL 到期后由**命中的那次请求**重算一次 —— 不预刷新、不建后台任务，
/// 不把它变成高频刷新端点（AGENTS.md §5）。
const INTERFACES_TTL: Duration = Duration::from_secs(30);

static INTERFACES_CACHE: OnceLock<RwLock<Option<(Instant, serde_json::Value)>>> = OnceLock::new();

fn interfaces_cache_slot() -> &'static RwLock<Option<(Instant, serde_json::Value)>> {
    INTERFACES_CACHE.get_or_init(|| RwLock::new(None))
}

/// 读缓存：命中且未过期则返回值，否则 None。
fn interfaces_cache_get() -> Option<serde_json::Value> {
    let slot = INTERFACES_CACHE.get()?;
    let guard = slot.read().ok()?;
    let (at, value) = guard.as_ref()?;
    if at.elapsed() < INTERFACES_TTL {
        Some(value.clone())
    } else {
        None
    }
}

fn interfaces_cache_put(value: serde_json::Value) {
    let slot = interfaces_cache_slot();
    if let Ok(mut g) = slot.write() {
        *g = Some((Instant::now(), value));
    }
}

/// 手动失效：配置变更 / 网卡增删后调用，下一次请求立即重算。
/// （`GET /api/interfaces?refresh=1` 走的就是这条路径。）
pub fn invalidate_interfaces_cache() {
    let slot = interfaces_cache_slot();
    if let Ok(mut g) = slot.write() {
        *g = None;
    }
}

#[derive(Deserialize)]
struct InterfacesQuery {
    /// 传任意值（除 `0`/`false`）即强制跳过缓存重算一次 —— 手动失效的 HTTP 出口。
    refresh: Option<String>,
}

impl InterfacesQuery {
    fn wants_refresh(&self) -> bool {
        !matches!(self.refresh.as_deref(), None | Some("0") | Some("false"))
    }
}

/// GET /api/interfaces — 枚举本机网卡（供 UI 多网卡配置页展示）。
///
/// 返回**全部适配器**（含断开/无 IP 的物理网卡，附 `connected` 标记）；
/// 主网卡 always enabled；虚拟网卡（Hyper-V/WSL/隧道等）标记 is_virtual 由前端折叠。
/// 前端据此渲染：主网卡（固定）+ 可用附属网卡（可选开关）+ 未连接网卡（禁用）。
async fn list_interfaces(Query(q): Query<InterfacesQuery>) -> axum::Json<serde_json::Value> {
    if q.wants_refresh() {
        invalidate_interfaces_cache();
    } else if let Some(hit) = interfaces_cache_get() {
        return axum::Json(hit);
    }
    // 枚举网卡是同步阻塞调用（Windows GetAdaptersAddresses，实测 ~1s），
    // 丢到阻塞池执行，避免占住 async worker 线程拖慢其它端点。
    let value = tokio::task::spawn_blocking(compute_interfaces)
        .await
        .unwrap_or_else(|_| compute_interfaces());
    interfaces_cache_put(value.clone());
    axum::Json(value)
}

/// 计算网卡清单（**未缓存**，约 1s；只应由 `list_interfaces` 在缓存未命中时调用）。
fn compute_interfaces() -> serde_json::Value {
    // 全部适配器（Windows: GetAdaptersAddresses；其它平台退化为 up 网卡）
    let all = orig_net::list_all_adapters().unwrap_or_default();
    // 默认池（主网卡）用于判断 enabled
    let pool = orig_net::InterfacePool::resolve(None)
        .unwrap_or_else(|_| orig_net::InterfacePool::default());
    let primary_name = pool.primary.name.clone();
    let enabled_names: std::collections::HashSet<String> = pool
        .members()
        .iter()
        .map(|m| m.name.clone())
        .collect();

    let mut primary_out: Option<serde_json::Value> = None;
    let mut secondaries: Vec<serde_json::Value> = Vec::new();
    for nic in all {
        let connected = nic.ip.is_some() && nic.is_up;
        let entry = serde_json::json!({
            "name": nic.name,
            "description": nic.description,
            "ip": nic.ip.map(|i| i.to_string()),
            "is_default": nic.is_default,
            "connected": connected,
            "is_virtual": nic.is_virtual,
            "enabled": connected && (nic.is_default || enabled_names.contains(&nic.name)),
            "weight": if nic.is_default || enabled_names.contains(&nic.name) {
                pool.members().iter().find(|m| m.name == nic.name).map(|m| m.weight).unwrap_or(1)
            } else {
                1
            },
        });
        if nic.is_default || nic.name == primary_name {
            primary_out = Some(entry);
        } else {
            secondaries.push(entry);
        }
    }
    serde_json::json!({
        "primary": primary_out.unwrap_or_else(|| serde_json::json!({
            "name": pool.primary.name,
            "ip": pool.primary.ip.to_string(),
            "is_default": true,
            "connected": true,
            "is_virtual": false,
            "enabled": true,
            "weight": pool.primary.weight,
        })),
        "secondaries": secondaries,
    })
}

/// 构造路由树（含鉴权中间件）。
pub fn router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .route("/health", get(health))
        // BUG-392：GET 是**统一列表**（全来源）；POST（新增任务）语义不变。
        .route("/api/downloads", get(list_unified).post(add))
        // 引擎原生明细投影（分块/连接数等），调试与详情用；UI 列表不走这里。
        .route("/api/downloads/native", get(list))
        .route(
            "/api/downloads/:id",
            get(get_one).post(action).delete(delete_one),
        )
        // BUG-322：重试与 pause/resume/cancel 操作对象不同（记录 vs 活体句柄），
        // 故独立成动词端点，不塞进 `?action=`。
        .route("/api/downloads/:id/retry", axum::routing::post(retry_one))
        .route("/api/events", get(events))
        .route("/api/activity", get(activity))
        .route("/api/sources", get(sources))
        // BUG-299 M2-T00a：受管下载根成品事实（文件域「全部文件」的 downloads 一侧）。
        // GET 枚举 / DELETE 删除（受管根边界守卫，见 files.rs）。
        .route("/api/files", get(files::list_files).delete(files::delete_file))
        // BUG-323 缺陷③：WEB（网页调试模式）没有系统原生目录对话框 ⇒ 设置页
        // 「浏览…」在浏览器里是死的。补一个只读目录浏览端点，让挑目录这条通路
        // 与桌面壳同源（详见 fsbrowse.rs 头部注释）。
        .route("/api/fs/dirs", get(fsbrowse::list_dirs))
        .route("/api/interfaces", get(list_interfaces))
        .route("/api/config", get(get_config))
        .route("/api/config/classify", axum::routing::put(put_config_classify))
        .route("/api/config/proxy", axum::routing::put(put_config_proxy))
        // BUG-234：download_dir 此前只读（GET /api/config），设置页改了也不生效 ——
        // 补上与 classify/proxy/tg 同语义的「运行时生效 + 持久化」端点。
        .route("/api/config/download", axum::routing::put(put_config_download))
        // D23-A⑥：设置页「库根目录」同步写 daemon（与 TG 共用同一受管根）。
        .route("/api/config/library", axum::routing::put(put_config_library))
        .route("/api/proxy/verify", axum::routing::post(post_proxy_verify))
        // BUG-358：插件启停/重启走**插件无关**的路径（前端只认 id）。
        .route("/api/plugins/:id/enabled", axum::routing::put(put_plugin_enabled))
        .route("/api/plugins/:id/restart", axum::routing::post(post_plugin_restart))
        // 旧路径别名（桌面壳仍在调）：内部转调上面两个处理器，语义完全一致。
        .route("/api/config/tg", axum::routing::put(put_config_tg))
        .route("/api/tg/restart", axum::routing::post(post_tg_restart))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

/// 当前 Unix 秒（`pub(crate)`：`activity.rs` 的时间戳同源，避免两套时钟口径）。
pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::next_free_path;
    use std::path::{Path, PathBuf};

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orig-daemon-routes-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// T08⑤ 回归夹具：同名文件得到 `name (1).ext`，再冲突则 `name (2).ext`。
    #[tokio::test]
    async fn next_free_path_appends_numeric_suffix() {
        let dir = tmp_dir("suffix");
        let orig = dir.join("a.mp4");
        std::fs::write(&orig, b"x").unwrap();

        let p1 = next_free_path(&orig).await;
        assert_eq!(p1, dir.join("a (1).mp4"));
        // 占用 (1) 后应跳到 (2)。
        std::fs::write(&p1, b"x").unwrap();
        let p2 = next_free_path(&orig).await;
        assert_eq!(p2, dir.join("a (2).mp4"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无扩展名：后缀接在文件名后（`name (1)`），不带多余点。
    #[tokio::test]
    async fn next_free_path_handles_extensionless() {
        let dir = tmp_dir("noext");
        let orig = dir.join("plain");
        std::fs::write(&orig, b"x").unwrap();

        let p = next_free_path(&orig).await;
        assert_eq!(p, dir.join("plain (1)"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多点文件名只按**最后一段**当扩展名（`a.b.tar.gz` → `a.b.tar (1).gz`）。
    #[tokio::test]
    async fn next_free_path_splits_on_last_extension() {
        let dir = tmp_dir("multi");
        let orig = dir.join("a.b.tar.gz");
        std::fs::write(&orig, b"x").unwrap();

        let p = next_free_path(&orig).await;
        assert_eq!(p, dir.join("a.b.tar (1).gz"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 候选落在原文件**同一父目录**（不得改变目录）。
    #[tokio::test]
    async fn next_free_path_stays_in_same_dir() {
        let dir = tmp_dir("samedir");
        let orig = dir.join("c.mkv");
        std::fs::write(&orig, b"x").unwrap();

        let p = next_free_path(&orig).await;
        assert_eq!(p.parent(), Some(Path::new(dir.to_str().unwrap())));

        let _ = std::fs::remove_dir_all(&dir);
    }
}











