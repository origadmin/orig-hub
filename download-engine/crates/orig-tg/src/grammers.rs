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
//! 会话（等同密码凭证）通过 `Config.session_path` 落盘持久化（`grammers_session::Session`）。
//! 本实现依赖在 `my.telegram.org` 申请的 api_id/api_hash；未配置时由 main 回退到 DummyClient。

use std::path::PathBuf;

use grammers_client::types::{LoginToken, Media, PasswordToken};
use grammers_client::{Client as TgClient, Config as GConfig, SignInError};
use grammers_client::grammers_tl_types as tl;
use grammers_session::Session;
use tokio::sync::Mutex;

use crate::config::Config;
use crate::login::{
    Channel, Client, ClientError, DownloadOutcome, LoginPhase, MediaItem, SessionView,
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
    session_path: PathBuf,
    pending: Mutex<Pending>,
}

impl GrammersClient {
    /// 连接 Telegram 并建立/恢复 MTProto 会话。
    pub async fn connect(cfg: &Config) -> Result<Self, ClientError> {
        let (api_id, api_hash) = match (cfg.api_id, cfg.api_hash.as_ref()) {
            (Some(id), Some(hash)) if !hash.is_empty() => (id, hash.clone()),
            _ => return Err(ClientError::NotInitialized),
        };

        let session = Session::load_file_or_create(&cfg.session_path)
            .map_err(|e| ClientError::Network(e.to_string()))?;
        let inner = TgClient::connect(GConfig {
            session,
            api_id,
            api_hash,
            params: Default::default(),
        })
        .await
        .map_err(|e| ClientError::Network(e.to_string()))?;

        // 已登录则直接进入 Authorized 并记录 user_id；否则为 Anonymous。
        let mut pending = Pending {
            phase: LoginPhase::Anonymous,
            phone: None,
            user_id: None,
            login_token: None,
            password_token: None,
        };
        if inner.is_authorized().await.map_err(|e| ClientError::Other(e.to_string()))? {
            pending.phase = LoginPhase::Authorized;
            pending.user_id = inner.session().get_user().map(|u| u.id);
        }
        // 持久化连接建立的 auth key（Anonymous 阶段也需保存 key，后续登录续用）。
        inner
            .session()
            .save_to_file(&cfg.session_path)
            .map_err(|e| ClientError::Other(e.to_string()))?;

        Ok(Self {
            inner,
            session_path: cfg.session_path.clone(),
            pending: Mutex::new(pending),
        })
    }

    /// 登录成功后把会话（含 auth key + user）写入本地会话文件。
    fn persist_session(&self) {
        if let Err(e) = self.inner.session().save_to_file(&self.session_path) {
            tracing::warn!("failed to persist tg session: {e}");
        }
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
            .request_login_code(phone)
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
                p.user_id = Some(user.id());
                self.persist_session();
                Ok(LoginPhase::Authorized)
            }
            Err(SignInError::PasswordRequired(password_token)) => {
                p.password_token = Some(password_token);
                p.phase = LoginPhase::PasswordRequired;
                Ok(LoginPhase::PasswordRequired)
            }
            Err(SignInError::InvalidCode) => Err(ClientError::InvalidCode),
            Err(SignInError::SignUpRequired { .. }) => {
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
                p.user_id = Some(user.id());
                self.persist_session();
                Ok(LoginPhase::Authorized)
            }
            Err(SignInError::InvalidPassword) => Err(ClientError::InvalidPassword),
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
        let mut iter = self.inner.iter_dialogs();
        let mut out = Vec::new();
        while let Some(dialog) = iter
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            let chat = dialog.chat();
            out.push(Channel {
                id: chat.id(),
                title: chat.name().to_string(),
                username: chat.username().map(str::to_string),
            });
        }
        Ok(out)
    }

    async fn messages(&self, chat_id: i64, limit: u32) -> Result<Vec<MediaItem>, ClientError> {
        // 先通过订阅枚举解析目标会话的 PackedChat（含 access_hash），再拉取媒体历史。
        let mut dialogs = self.inner.iter_dialogs();
        let mut peer = None;
        while let Some(dialog) = dialogs
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            let chat = dialog.chat();
            if chat.id() == chat_id {
                peer = Some(chat.pack());
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
                Some(Media::Document(doc)) => match doc.raw.document.as_ref() {
                    Some(tl::enums::Document::Document(d)) => {
                        (Some(d.mime_type.clone()), Some(d.size))
                    }
                    _ => (Some("application/octet-stream".into()), None),
                },
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
            let chat = dialog.chat();
            if chat.id() == chat_id {
                peer = Some(chat.pack());
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
                let name = doc.name().trim().to_string();
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