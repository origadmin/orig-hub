//! Telegram 登录状态机与客户端抽象。
//!
//! `State` 类型包裹实际 MTProto 会话，骨架阶段先定义清晰的登录状态转移与
//! `Client` trait，后续接入 grammers 客户端（见 `grammers.rs`）时无需改路由层。
//!
//! 状态机（对齐 Telegram 用户账号登录流程）：
//!   Anonymous
//!     → start(phone) 发送验证码
//!   CodeRequired(phone)
//!     → submit_code(code)
//!       → 若账号开启两步验证
//!   PasswordRequired(phone) → submit_password(password)
//!     → Authorized(user_id, phone)

use serde::{Deserialize, Serialize};

/// 会话当前阶段（对前端可序列化展示）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoginPhase {
    /// 未登录。
    Anonymous,
    /// 已发送验证码，等待短信/App 验证码。
    CodeRequired,
    /// 账号开启两步验证，等待 2FA 密码。
    PasswordRequired,
    /// 已登录。
    Authorized,
}

/// 会话状态快照（HTTP 响应体）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionView {
    #[serde(rename = "phase")]
    pub phase: LoginPhase,
    #[serde(rename = "phone", skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(rename = "user_id", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<i64>,
}

/// 客户端抽象：路由层只依赖此 trait，具体实现可替换。
#[async_trait::async_trait]
pub trait Client: Send + Sync {
    /// 发起登录：发送验证码到 phone。返回下一步（值守 2FA 或 CodeRequired）。
    async fn start(&self, phone: &str) -> Result<LoginPhase, ClientError>;
    /// 提交短信/App 验证码。
    async fn submit_code(&self, phone: &str, code: &str) -> Result<LoginPhase, ClientError>;
    /// 提交两步验证密码（2FA）。
    async fn submit_password(&self, phone: &str, password: &str) -> Result<LoginPhase, ClientError>;
    /// 返回当前已登录会话快照（未登录返回 Anonymous）。
    async fn view(&self) -> SessionView;
}

/// 登录流程错误。
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("client not initialized (missing api_id/api_hash)")]
    NotInitialized,
    #[error("invalid code")]
    InvalidCode,
    #[error("wrong 2FA password")]
    InvalidPassword,
    #[error("phone required")]
    MissingPhone,
    #[error("network: {0}")]
    Network(String),
    #[error("{0}")]
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 可用内存中的纯状态机，便于逻辑自测（不依赖真实 Telegram）。
    struct InMemoryClient(std::sync::Mutex<LoginPhase>);

    #[async_trait::async_trait]
    impl Client for InMemoryClient {
        async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
            *self.0.lock().unwrap() = LoginPhase::CodeRequired;
            Ok(LoginPhase::CodeRequired)
        }
        async fn submit_code(&self, _phone: &str, code: &str) -> Result<LoginPhase, ClientError> {
            if code != "00000" {
                return Err(ClientError::InvalidCode);
            }
            *self.0.lock().unwrap() = LoginPhase::Authorized;
            Ok(LoginPhase::Authorized)
        }
        async fn submit_password(&self, _phone: &str, _password: &str) -> Result<LoginPhase, ClientError> {
            Err(ClientError::Other("no 2FA in test".into()))
        }
        async fn view(&self) -> SessionView {
            SessionView {
                phase: self.0.lock().unwrap().clone(),
                phone: None,
                user_id: None,
            }
        }
    }

    #[tokio::test]
    async fn login_flow_transitions() {
        let c = InMemoryClient(std::sync::Mutex::new(LoginPhase::Anonymous));
        let p = c.view().await;
        assert_eq!(p.phase, LoginPhase::Anonymous);

        let p = c.start("+861234567890").await.unwrap();
        assert_eq!(p, LoginPhase::CodeRequired);

        let err = c.submit_code("+861234567890", "12345").await;
        assert!(err.is_err(), "wrong code must fail");

        let p = c.submit_code("+861234567890", "00000").await.unwrap();
        assert_eq!(p, LoginPhase::Authorized);
    }
}