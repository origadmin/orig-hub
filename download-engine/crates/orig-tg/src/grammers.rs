//! grammers 实现的 MTProto 客户端（真实 Telegram 拉取层）。
//!
//! 对接 `grammers-client` 完成用户账号登录与授权状态管理：
//!   Anonymous
//!     → start(phone)  → request_login_code         → CodeRequired
//!     → submit_code    → sign_in(token, code)
//!       → 成功                                  → Authorized
//!       → 需两步验证                           → PasswordRequired（缓存 PasswordToken）
//!     → submit_password → check_password(pt, pwd) → Authorized
//!
//! 会话（等同密码凭证）通过 `Config.session_path` 落盘持久化（grammers 0.10 的
//! `SqliteSession`，基于 libsql 自动持久化，无需手动 save_to_file）。
//! 本实现依赖在 `my.telegram.org` 申请的 api_id/api_hash；未配置时由 main 回退到 DummyClient。

use std::path::PathBuf;
use std::sync::Arc;

use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::media::Media;
use grammers_client::sender::ConnectionParams;
use grammers_client::session::storages::SqliteSession;
use grammers_client::{Client as TgClient, SenderPool, SignInError, tl};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::login::{
    Channel, Client, ClientError, DownloadOutcome, Folder, LoginPhase, MediaItem, SessionView,
};

/// 登录中间态（在多次 HTTP 请求之间保留 Telegram 返回的 token）。
struct Pending {
    phase: LoginPhase,
    phone: Option<String>,
    user_id: Option<i64>,
    login_token: Option<LoginToken>,
    password_token: Option<PasswordToken>,
}

/// 包装 grammers 客户端的真实实现。
pub struct GrammersClient {
    inner: TgClient,
    /// 发起登录码请求时需要 api_hash（grammers 0.10 的 `request_login_code(phone, api_hash)`）。
    api_hash: String,
    pending: Mutex<Pending>,
}

impl GrammersClient {
    /// 连接 Telegram 并建立/恢复 MTProto 会话。
    pub async fn connect(cfg: &Config) -> Result<Self, ClientError> {
        let (api_id, api_hash) = match (cfg.api_id, cfg.api_hash.as_ref()) {
            (Some(id), Some(hash)) if !hash.is_empty() => (id, hash.clone()),
            _ => return Err(ClientError::NotInitialized),
        };

        // grammers 0.10：会话改为 SqliteSession（libsql），自动持久化登录态。
        let session = SqliteSession::open(&cfg.session_path)
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        let params = match &cfg.proxy {
            Some(url) => ConnectionParams {
                proxy_url: Some(url.clone()),
                ..Default::default()
            },
            None => Default::default(),
        };
        // 0.10 连接模型：SenderPool + 后台 runner + Client::new(handle)。
        let pool = SenderPool::with_configuration(Arc::new(session), api_id, params);
        let inner = TgClient::new(pool.handle);
        // 驱动 sender pool 的后台任务（到各 DC 的连接按需建立）。
        let _runner = tokio::spawn(pool.runner.run());

        // 已登录则直接进入 Authorized 并记录 user_id；否则为 Anonymous。
        let mut pending = Pending {
            phase: LoginPhase::Anonymous,
            phone: None,
            user_id: None,
            login_token: None,
            password_token: None,
        };
        if inner
            .is_authorized()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            pending.phase = LoginPhase::Authorized;
            if let Ok(user) = inner.get_me().await {
                pending.user_id = user.id().bot_api_dialog_id();
            }
        }

        Ok(Self {
            inner,
            api_hash,
            pending: Mutex::new(pending),
        })
    }
}

#[async_trait::async_trait]
impl Client for GrammersClient {
    async fn start(&self, phone: &str) -> Result<LoginPhase, ClientError> {
        let mut p = self.pending.lock().await;
        if p.phase == LoginPhase::Authorized {
            return Ok(LoginPhase::Authorized);
        }
        let token = self
            .inner
            .request_login_code(phone, &self.api_hash)
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        p.phone = Some(phone.to_string());
        p.login_token = Some(token);
        p.phase = LoginPhase::CodeRequired;
        Ok(LoginPhase::CodeRequired)
    }

    async fn submit_code(&self, _phone: &str, code: &str) -> Result<LoginPhase, ClientError> {
        let mut p = self.pending.lock().await;
        let token = p
            .login_token
            .as_ref()
            .ok_or(ClientError::Other("no login code requested: call /start first".into()))?;
        match self.inner.sign_in(token, code).await {
            Ok(user) => {
                p.phase = LoginPhase::Authorized;
                p.user_id = user.id().bot_api_dialog_id();
                Ok(LoginPhase::Authorized)
            }
            Err(SignInError::PasswordRequired(password_token)) => {
                p.password_token = Some(password_token);
                p.phase = LoginPhase::PasswordRequired;
                Ok(LoginPhase::PasswordRequired)
            }
            Err(SignInError::InvalidCode) => Err(ClientError::InvalidCode),
            Err(SignInError::SignUpRequired) => {
                Err(ClientError::Other("sign up required in official client first".into()))
            }
            Err(e) => Err(ClientError::Other(e.to_string())),
        }
    }

    async fn submit_password(&self, _phone: &str, password: &str) -> Result<LoginPhase, ClientError> {
        let mut p = self.pending.lock().await;
        let password_token = p
            .password_token
            .take()
            .ok_or(ClientError::Other("no 2FA context: submit code first".into()))?;
        match self.inner.check_password(password_token, password.as_bytes()).await {
            Ok(user) => {
                p.phase = LoginPhase::Authorized;
                p.user_id = user.id().bot_api_dialog_id();
                Ok(LoginPhase::Authorized)
            }
            Err(SignInError::InvalidPassword(_)) => Err(ClientError::InvalidPassword),
            Err(e) => Err(ClientError::Other(e.to_string())),
        }
    }

    async fn view(&self) -> SessionView {
        let p = self.pending.lock().await;
        SessionView {
            phase: p.phase.clone(),
            phone: p.phone.clone(),
            user_id: p.user_id,
        }
    }

    async fn dialogs(&self) -> Result<Vec<Channel>, ClientError> {
        // 先读分组，建立 频道id -> 分组标题 映射（一个频道可属多组，取首个命中）。
        let mut folder_of: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        for folder in self.folders().await? {
            let title = folder.title.clone();
            for id in folder.channel_ids {
                folder_of.entry(id).or_insert_with(|| title.clone());
            }
        }

        let mut iter = self.inner.iter_dialogs();
        let mut out = Vec::new();
        while let Some(dialog) = iter
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            let peer = dialog.peer();
            let id = peer.id().bot_api_dialog_id().unwrap_or(0);
            out.push(Channel {
                id,
                title: peer.name().unwrap_or_default().to_string(),
                username: peer.username().map(str::to_string),
                folder: folder_of.get(&id).cloned(),
            });
        }
        Ok(out)
    }

    async fn folders(&self) -> Result<Vec<Folder>, ClientError> {
        // 走原始 TL 调用拉取自定义分组（grammers 高层未暴露 DialogFilter）。
        let result = self
            .inner
            .invoke(&tl::functions::messages::GetDialogFilters {})
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?;
        let filters = match result {
            tl::enums::messages::DialogFilters::Filters(f) => f.filters,
        };

        let mut out = Vec::new();
        for f in filters {
            let tl::enums::DialogFilter::Filter(filter) = f else { continue };
            let title = match filter.title {
                tl::enums::TextWithEntities::Entities(t) => t.text,
            };
            let mut ids = Vec::new();
            for peer in filter.include_peers {
                let id = match peer {
                    tl::enums::InputPeer::Channel(p) => Some(p.channel_id),
                    tl::enums::InputPeer::Chat(p) => Some(p.chat_id),
                    tl::enums::InputPeer::User(p) => Some(p.user_id),
                    _ => None,
                };
                if let Some(id) = id {
                    ids.push(id);
                }
            }
            out.push(Folder {
                id: filter.id,
                title,
                channel_ids: ids,
            });
        }
        Ok(out)
    }

    async fn messages(&self, chat_id: i64, limit: u32) -> Result<Vec<MediaItem>, ClientError> {
        // 先通过订阅枚举解析目标会话的 PeerRef（含 access_hash），再拉取媒体历史。
        let mut dialogs = self.inner.iter_dialogs();
        let mut peer = None;
        while let Some(dialog) = dialogs
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            if dialog.peer().id().bot_api_dialog_id() == Some(chat_id) {
                peer = Some(dialog.peer_ref());
                break;
            }
        }
        let peer = peer.ok_or_else(|| {
            ClientError::Other("chat not found in subscribed dialogs".into())
        })?;

        let mut msgs = self.inner.iter_messages(peer).limit(limit.max(1) as usize);
        let mut out = Vec::new();
        while let Some(m) = msgs
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            let caption = {
                let text = m.text();
                if text.is_empty() {
                    None
                } else {
                    Some(text.to_string())
                }
            };
            let (mime_type, size) = match m.media() {
                Some(Media::Document(doc)) => (
                    doc.mime_type().map(str::to_string),
                    doc.size().map(|s| s as i64),
                ),
                Some(Media::Photo(_)) => (Some("image/jpeg".into()), None),
                _ => (None, None),
            };
            out.push(MediaItem {
                id: m.id() as i64,
                caption,
                mime_type,
                size,
            });
        }
        Ok(out)
    }

    async fn download(&self, chat_id: i64, message_id: i64, dir: &str) -> Result<DownloadOutcome, ClientError> {
        // 通过订阅枚举解析目标会话（拿到 access_hash 等上下文）。
        let mut dialogs = self.inner.iter_dialogs();
        let mut peer = None;
        while let Some(dialog) = dialogs
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            if dialog.peer().id().bot_api_dialog_id() == Some(chat_id) {
                peer = Some(dialog.peer_ref());
                break;
            }
        }
        let peer = peer.ok_or(ClientError::MediaNotFound)?;

        let found = self
            .inner
            .get_messages_by_id(peer, &[message_id as i32])
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
            .into_iter()
            .find_map(|m| m);
        let message = found.ok_or(ClientError::MediaNotFound)?;

        let media = message.media().ok_or(ClientError::MediaNotFound)?;
        let filename = match &media {
            Media::Photo(_) => format!("photo-{}_{}.jpg", chat_id, message_id),
            Media::Document(doc) => {
                let name = doc.name().unwrap_or_default().trim().to_string();
                if !name.is_empty() {
                    name
                } else {
                    let mime = doc.mime_type().unwrap_or("bin");
                    let ext = extension_for_mime(mime).unwrap_or("bin");
                    format!("doc-{}_{}.{}", chat_id, message_id, ext)
                }
            }
            _ => return Err(ClientError::MediaNotFound),
        };

        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir)
            .map_err(|e| ClientError::Other(format!("create dir: {e}")))?;
        let path = dir.join(&filename);

        let ok = message
            .download_media(&path)
            .await
            .map_err(|e| ClientError::Other(format!("download: {e}")))?;
        if !ok {
            return Err(ClientError::MediaNotFound);
        }
        let bytes = std::fs::metadata(&path)
            .map(|m| m.len())
            .unwrap_or(0);
        Ok(DownloadOutcome {
            message_id,
            path: path.to_string_lossy().into_owned(),
            bytes,
        })
    }
}

/// 由 MIME 推断文件扩展名（仅覆盖媒体常见类型，回退 None）。
fn extension_for_mime(mime: &str) -> Option<&'static str> {
    let base = mime.split(';').next().unwrap_or(mime).trim();
    match base {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "video/mp4" => Some("mp4"),
        "video/x-matroska" | "video/webm" => Some("mkv"),
        "audio/mpeg" => Some("mp3"),
        "audio/ogg" => Some("ogg"),
        "application/pdf" => Some("pdf"),
        "text/plain" => Some("txt"),
        _ => None,
    }
}
