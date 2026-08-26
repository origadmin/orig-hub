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
//!
//! 下载流程：parse_url → probe(取总大小) → create_sources(一组 Source) →
//! 用 `BlockMap` + `Task` 调度（见 `libsurge::engine`）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

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

use libsurge::engine::Task;
use libsurge::protocol::{DownloadConfig, ParsedUrl, SseEvent};
use crate::config::{resolve_output, resolve_output_classified};
use crate::state::{AppState, DownloadTask};
use crate::status::DownloadStatus;

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
    pub interfaces: Option<surge_net::InterfaceSpec>,
    /// 自动分类（R3）：true=强制开启 / false=强制关闭 / None=用配置默认。
    #[serde(default)]
    pub classify: Option<bool>,
    /// 覆盖下载：目标文件已存在时先删除再重新下载（默认 false）。
    #[serde(default)]
    pub overwrite: bool,
    /// 本次下载的代理配置（可选）：缺省用 daemon 配置 [proxy] 段；
    /// 传 {mode:"direct"} 强制直连，{mode:"custom",url:"http://..."} 指定代理。
    #[serde(default)]
    pub proxy: Option<libsurge::protocol::ProxyConfig>,
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
        let auth = req
            .headers()
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let ok = auth
            .strip_prefix("Bearer ")
            .map(|t| t == token)
            .unwrap_or(false);
        if !ok {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    Ok(next.run(req).await)
}

// ---- 路由处理 ----

async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({"status": "ok"}))
}

async fn list(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let tasks = st.tasks.lock().await;
    let now = now_secs();
    let mut out = Vec::new();
    for dt in tasks.values() {
        let prog = dt.task.progress().await;
        let status = DownloadStatus::from_progress(
            &dt.task.id,
            &dt.url,
            &dt.filename,
            Some(dt.output.to_string_lossy().into_owned()),
            dt.added_at,
            dt.max_concurrency,
            &prog,
            now,
            dt.error.lock().await.clone(),
        );
        out.push(status);
    }
    axum::Json(out)
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

    let scheme = req.url.split("://").next().unwrap_or("").to_string();
    let proto = match st.registry.find_by_scheme(&scheme) {
        Some(p) => p,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "unsupported scheme", "scheme": scheme})),
            )
        }
    };

    let parsed: ParsedUrl = match proto.parse_url(&req.url).await {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "parse url", "detail": e.to_string()})),
            )
        }
    };

    // 代理：请求级覆盖 > daemon 配置 [proxy] 段（探测与下载同路径）
    let proxy = req
        .proxy
        .clone()
        .or_else(|| Some(st.config.read().unwrap().proxy.clone()));
    let meta = match proto.probe(&parsed, proxy.as_ref()).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "probe failed", "detail": e.to_string()})),
            )
        }
    };

    let id = Uuid::new_v4().to_string();
    let filename = req
        .filename
        .clone()
        .filter(|s| !s.is_empty())
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
    let (mut output, mut cfg) = {
        let cfg_guard = st.config.read().unwrap();
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
                    let new_output = loop {
                        let candidate = if ext.is_empty() {
                            parent.join(format!("{stem} ({idx})"))
                        } else {
                            parent.join(format!("{stem} ({idx}).{ext}"))
                        };
                        if tokio::fs::metadata(&candidate).await.is_err() {
                            break candidate;
                        }
                        idx += 1;
                    };
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

    let sources = match proto.create_sources(&parsed, &cfg).await {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "create sources", "detail": e.to_string()})),
            )
        }
    };

    let task = Task::new(
        id.clone(),
        output.clone(),
        meta.total_size,
        cfg.block_size,
        sources,
        st.events.clone(),
        proto.name().to_string(),
        cfg.max_concurrency,
        meta.supports_range,
    );

    let added_at = now_secs();
    let dt = DownloadTask {
        task: task.clone(),
        url: req.url.clone(),
        filename: if renamed { output.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| filename.clone()) } else { filename.clone() },
        output: output.clone(),
        added_at,
        max_concurrency: cfg.max_concurrency,
        error: tokio::sync::Mutex::new(None),
    };


    let resp_filename = output.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| filename.clone());
    // 后台运行；完成后依据状态写入错误。
    let task_run = task.clone();
    let st_run = st.clone();
    let id_run = id.clone();
    tokio::spawn(async move {
        let res = task_run.run().await;
        if let Err(e) = res {
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
    });
    st.tasks.lock().await.insert(id.clone(), dt);

    (
        StatusCode::CREATED,
        axum::Json(serde_json::json!({"id": id, "filename": resp_filename})),
    )
}

async fn get_one(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<axum::Json<DownloadStatus>, StatusCode> {
    let tasks = st.tasks.lock().await;
    let dt = tasks.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let prog = dt.task.progress().await;
    let now = now_secs();
    let status = DownloadStatus::from_progress(
        &dt.task.id,
        &dt.url,
        &dt.filename,
        Some(dt.output.to_string_lossy().into_owned()),
        dt.added_at,
        dt.max_concurrency,
        &prog,
        now,
        dt.error.lock().await.clone(),
    );
    Ok(axum::Json(status))
}

async fn action(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<ActionReq>,
) -> Result<axum::Json<serde_json::Value>, StatusCode> {
    let tasks = st.tasks.lock().await;
    let dt = tasks.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    match q.action.as_str() {
        "pause" => {
            dt.task.control.paused.store(true, Ordering::SeqCst);
            dt.task
                .events
                .send(SseEvent::Paused { id: id.clone() })
                .ok();
            Ok(axum::Json(serde_json::json!({"status": "paused", "id": id})))
        }
        "resume" => {
            dt.task.control.paused.store(false, Ordering::SeqCst);
            dt.task.control.resume.notify_waiters();
            dt.task
                .events
                .send(SseEvent::Resumed { id: id.clone() })
                .ok();
            Ok(axum::Json(serde_json::json!({"status": "resumed", "id": id})))
        }
        "cancel" => {
            dt.task.control.cancel.cancel();
            dt.task
                .events
                .send(SseEvent::Deleted { id: id.clone() })
                .ok();
            Ok(axum::Json(serde_json::json!({"status": "cancelled", "id": id})))
        }
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

async fn delete_one(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<axum::Json<serde_json::Value>, StatusCode> {
    let dt = st.tasks.lock().await.remove(&id).ok_or(StatusCode::NOT_FOUND)?;
    dt.task.control.cancel.cancel();
    dt.task
        .events
        .send(SseEvent::Deleted { id: id.clone() })
        .ok();
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

/// GET /api/config — 当前 daemon 配置（供设置页初始化）。
async fn get_config(State(st): State<Arc<AppState>>) -> axum::Json<serde_json::Value> {
    let cfg = st.config.read().unwrap();
    let map = cfg.classify.merged_map();
    let mut sorted: Vec<(String, String)> = map.into_iter().collect();
    sorted.sort();
    let rules: serde_json::Map<String, serde_json::Value> = sorted
        .into_iter()
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect();
    axum::Json(serde_json::json!({
        "download_dir": cfg.download_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
        "max_connections": cfg.max_connections,
        "classify_enabled": cfg.classify.enabled,
        "classify_rules": rules,
        "proxy": {
            "mode": match cfg.proxy.mode {
                libsurge::protocol::ProxyMode::Direct => "direct",
                libsurge::protocol::ProxyMode::System => "system",
                libsurge::protocol::ProxyMode::Custom => "custom",
            },
            "url": cfg.proxy.url,
        },
    }))
}

#[derive(Deserialize)]
pub struct ClassifyUpdateReq {
    pub enabled: bool,
    /// 扩展名（小写，无点）→ 分类目录名；完整覆盖用户自定义部分。
    pub rules: HashMap<String, String>,
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
        "system" => libsurge::protocol::ProxyMode::System,
        "custom" => libsurge::protocol::ProxyMode::Custom,
        _ => libsurge::protocol::ProxyMode::Direct,
    };
    // custom 模式必须给 url
    if mode == libsurge::protocol::ProxyMode::Custom {
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
                libsurge::protocol::ProxyMode::Direct => "direct",
                libsurge::protocol::ProxyMode::System => "system",
                libsurge::protocol::ProxyMode::Custom => "custom",
            },
            "url": cfg.proxy.url,
        },
    })))
}

/// 枚举本机网卡（供 UI 多网卡配置页展示）。
///
/// 返回**全部适配器**（含断开/无 IP 的物理网卡，附 `connected` 标记）；
/// 主网卡 always enabled；虚拟网卡（Hyper-V/WSL/隧道等）标记 is_virtual 由前端折叠。
/// 前端据此渲染：主网卡（固定）+ 可用附属网卡（可选开关）+ 未连接网卡（禁用）。
async fn list_interfaces() -> axum::Json<serde_json::Value> {
    // 全部适配器（Windows: GetAdaptersAddresses；其它平台退化为 up 网卡）
    let all = surge_net::list_all_adapters().unwrap_or_default();
    // 默认池（主网卡）用于判断 enabled
    let pool = surge_net::InterfacePool::resolve(None)
        .unwrap_or_else(|_| surge_net::InterfacePool::default());
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
    axum::Json(serde_json::json!({
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
    }))
}
/// 构造路由树（含鉴权中间件）。
pub fn router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .route("/health", get(health))
        .route("/api/downloads", get(list).post(add))
        .route(
            "/api/downloads/:id",
            get(get_one).post(action).delete(delete_one),
        )
        .route("/api/events", get(events))
        .route("/api/interfaces", get(list_interfaces))
        .route("/api/config", get(get_config))
        .route("/api/config/classify", axum::routing::put(put_config_classify))
        .route("/api/config/proxy", axum::routing::put(put_config_proxy))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}











