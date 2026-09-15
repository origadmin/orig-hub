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
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::login::{Client, ClientError, LoginPhase};
use crate::state::AppState;

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
        .route("/api/tg/messages/:chat_id", get(messages))
        .route("/api/tg/download/:chat_id/:message_id", axum::routing::post(download))
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

async fn dialogs(State(st): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&*st.client).await?;
    let dialogs = st.client.dialogs().await?;
    Ok(Json(dialogs))
}

#[derive(Deserialize)]
struct MsgQuery {
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    100
}

async fn messages(
    State(st): State<Arc<AppState>>,
    Path(chat_id): Path<i64>,
    Query(q): Query<MsgQuery>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&*st.client).await?;
    let items = st.client.messages(chat_id, q.limit).await?;
    Ok(Json(items))
}

#[derive(Deserialize)]
struct DownloadReq {
    #[serde(rename = "dir")]
    dir: Option<String>,
}

async fn download(
    State(st): State<Arc<AppState>>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
    Json(req): Json<DownloadReq>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_authorized(&*st.client).await?;
    let dir = req
        .dir
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| st.config.download_dir.to_string_lossy().into_owned());
    let outcome = st.client.download(chat_id, message_id, &dir).await?;
    Ok(Json(outcome))
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