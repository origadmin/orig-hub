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

use grammers_client::types::{LoginToken, PasswordToken};
use grammers_client::{Client as TgClient, Config as GConfig, SignInError};
use grammers_session::Session;
use tokio::sync::Mutex;

use crate::config::Config;
use crate::login::{Client, ClientError, LoginPhase, SessionView};

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
}