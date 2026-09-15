//! 骨架阶段的占位客户端：仅实现登录状态转移与内存持有，不发起真实 MTProto 连接。
//! 接入 grammers 后将替换此实现（同一 `Client` trait）。

use std::sync::Mutex;

use orig_tg::login::{Client, ClientError, LoginPhase, SessionView};

/// 内存占位客户端：固定验证码 00000 即授权（仅供接口契约自洽，非真实登录）。
pub struct DummyClient {
    state: Mutex<LoginPhase>,
}

impl Default for DummyClient {
    fn default() -> Self {
        Self {
            state: Mutex::new(LoginPhase::Anonymous),
        }
    }
}

const DUMMY_CODE: &str = "00000";

#[async_trait::async_trait]
impl Client for DummyClient {
    async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
        *self.state.lock().unwrap() = LoginPhase::CodeRequired;
        Ok(LoginPhase::CodeRequired)
    }

    async fn submit_code(&self, _phone: &str, code: &str) -> Result<LoginPhase, ClientError> {
        if code != DUMMY_CODE {
            return Err(ClientError::InvalidCode);
        }
        *self.state.lock().unwrap() = LoginPhase::Authorized;
        Ok(LoginPhase::Authorized)
    }

    async fn submit_password(&self, _phone: &str, _password: &str) -> Result<LoginPhase, ClientError> {
        Err(ClientError::Other("no 2FA in skeleton client".into()))
    }

    async fn view(&self) -> SessionView {
        SessionView {
            phase: self.state.lock().unwrap().clone(),
            phone: None,
            user_id: None,
        }
    }
}