//! HTTP 路由：orig-tg 对外契约（REST）。与 orig-daemon 的 9876 端口独立。
//!
//! 端点：
//!   GET  /health                     -> {status:ok}
//!   GET  /api/tg/session             -> SessionView（登录阶段）
//!   POST /api/tg/start               -> 发起登录（发送验证码）
//!        body: {"phone":"+86..."}
//!   POST /api/tg/code                -> 提交验证码/2FA 密码
//!        body: {"code":...} / {"password":...}
//!   GET  /api/tg/dialogs             -> [Channel] 订阅频道枚举（占位，未登录返回 401）
//!   GET  /api/tg/messages?chat=...   -> [MediaItem] 频道历史拉取（占位，未登录返回 401）

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::login::{Client, ClientError, LoginPhase};
use crate::state::AppState;

/// 骨架阶段频道/媒体 DTO（占位，供接口契约对齐）。
#[derive(Debug, serde::Serialize)]
pub struct Channel {
    pub id: i64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct MediaItem {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(rename = "size", skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
}

pub fn router(state: Arc<AppState>) -> axum::Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/tg/session", get(session))
        .route("/api/tg/start", axum::routing::post(start))
        .route("/api/tg/code", axum::routing::post(code))
        .route("/api/tg/dialogs", get(dialogs))
        .route("/api/tg/messages", get(messages))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({"status": "ok"}))
}

async fn session(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let view = st.client.view().await;
    Json(view)
}

#[derive(Deserialize)]
struct StartReq {
    phone: String,
}

async fn start(
    State(st): State<Arc<AppState>>,
    Json(req): Json<StartReq>,
) -> Result<impl IntoResponse, ApiError> {
    let phase = st.client.start(&req.phone).await?;
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
            Some(p) => st.client.submit_password(&req.phone, p).await?,
            None => {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "two-step verification: password required",
                ))
            }
        },
        LoginPhase::CodeRequired => match req.code.as_deref() {
            Some(c) => st.client.submit_code(&req.phone, c).await?,
            None => {
                return Err(ApiError::new(StatusCode::BAD_REQUEST, "code required"))
            }
        },
        LoginPhase::Anonymous | LoginPhase::Authorized => LoginPhase::Authorized,
    };
    if phase == LoginPhase::PasswordRequired {
        return Ok(Json(json!({"phase": phase, "next": "submit password"})));
    }
    Ok(Json(json!({"phase": phase})))
}

async fn dialogs(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&*st.client).await?;
    // 骨架阶段：接口契约占位，返回空列表；接入 grammers 后实现真实枚举。
    Ok(Json(Vec::<Channel>::new()))
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct MsgQuery {
    chat: i64,
}

async fn messages(
    State(st): State<Arc<AppState>>,
    Query(_q): Query<MsgQuery>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&*st.client).await?;
    // 骨架阶段：接口契约占位，返回空列表；接入 grammers 后实现真实历史拉取。
    Ok(Json(Vec::<MediaItem>::new()))
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