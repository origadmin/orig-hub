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
use axum::routing::{get, post};
use futures::StreamExt;
use serde::Deserialize;
use serde_json;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use libsurge::engine::Task;
use libsurge::protocol::{DownloadConfig, ParsedUrl, SseEvent};
use crate::config::resolve_output;
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
    if let Some(token) = &state.config.token {
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

    let meta = match proto.probe(&parsed).await {
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

    // 三层目录解析：请求 output_path → 配置 download_dir → 平台默认（~/Downloads）。
    let output = resolve_output(req.output_path.as_deref(), &st.config, &filename);
    if let Some(parent) = output.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "create dir", "detail": e.to_string()})),
            );
        }
    }

    let cfg = DownloadConfig {
        destination: output.parent().map(PathBuf::from),
        block_size: 1 << 20,
        max_concurrency: st.config.max_connections,
        mirrors: req.mirrors.clone(),
    };

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
    );

    let added_at = now_secs();
    let dt = DownloadTask {
        task: task.clone(),
        url: req.url.clone(),
        filename: filename.clone(),
        output: output.clone(),
        added_at,
        max_concurrency: cfg.max_concurrency,
        error: tokio::sync::Mutex::new(None),
    };

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
        axum::Json(serde_json::json!({"id": id})),
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
