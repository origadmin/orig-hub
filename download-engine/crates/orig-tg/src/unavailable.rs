//! TG 不可用时的**诚实空对象**。
//!
//! 与 `mock` 的区别就是本模块存在的全部理由：
//!
//! | | 行为 | 后果 |
//! |---|---|---|
//! | `mock`（仅测试构建） | **说谎**：返回合成频道/消息/缩略图/下载文件 | 调用方无从分辨真假 |
//! | `UnavailableClient` | **说真话**：每个能力返回 `ClientError::Unavailable(原因)` | 路由映射为 503 + 原因，故障可见 |
//!
//! 历史教训（BUG-023）：此前「凭证齐全但 MTProto 连不上」被静默换成 `DummyClient`，
//! 它照常返回 `Ok`，服务对外表现为**健康**，前端只能看到「未登录 / 发不出验证码」，
//! 于是把一次连接故障误判成登录态丢失，排查代价极高。
//!
//! 本类型**不会**出现在正常路径上：仅当凭证缺失或 MTProto 连接失败时挂载
//! （见 `main::build_client`），且不可用时所有 TG 能力显式失败，不产出任何假数据。

use crate::login::{
    Channel, Client, ClientError, DownloadOutcome, Folder, LoginPhase, MediaItem, MediaRange,
    MediaStream, SessionView, Thumbnail,
};

/// 永远不可用的客户端实现：把「不可用」这个事实**如实**传播给每个调用点。
pub struct UnavailableClient {
    reason: String,
}

impl UnavailableClient {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    /// 不可用原因（诊断/日志用）。
    pub fn reason(&self) -> &str {
        &self.reason
    }

    fn err(&self) -> ClientError {
        ClientError::Unavailable(self.reason.clone())
    }
}

#[async_trait::async_trait]
impl Client for UnavailableClient {
    async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
        Err(self.err())
    }

    async fn submit_code(&self, _phone: &str, _code: &str) -> Result<LoginPhase, ClientError> {
        Err(self.err())
    }

    async fn submit_password(&self, _phone: &str, _password: &str) -> Result<LoginPhase, ClientError> {
        Err(self.err())
    }

    async fn view(&self) -> SessionView {
        // `view()` 在 trait 上不可失败，这里只能返回哨兵值 `Anonymous`。
        // 「不可用」与「未登录」的区分**不依赖本方法**：由路由层基于
        // `AppState::availability` 下发给前端（`/api/tg/session` 的
        // `available` / `reason` 字段），避免把故障读成「没登录」。
        SessionView {
            phase: LoginPhase::Anonymous,
            phone: None,
            user_id: None,
        }
    }

    async fn dialogs(&self) -> Result<Vec<Channel>, ClientError> {
        Err(self.err())
    }

    async fn folders(&self) -> Result<Vec<Folder>, ClientError> {
        Err(self.err())
    }

    /// 未配置 / 不可用的实现根本没有 MTProto 链路（BUG-106）。
    fn link_alive(&self) -> bool {
        false
    }

    async fn messages(
        &self,
        _chat_id: i64,
        _limit: u32,
        _before_id: Option<i64>,
    ) -> Result<Vec<MediaItem>, ClientError> {
        Err(self.err())
    }

    async fn thumb(&self, _chat_id: i64, _message_id: i64) -> Result<Option<Thumbnail>, ClientError> {
        Err(self.err())
    }

    async fn media(
        &self,
        _chat_id: i64,
        _message_id: i64,
        _range: Option<MediaRange>,
    ) -> Result<MediaStream, ClientError> {
        Err(self.err())
    }

    async fn download(
        &self,
        _chat_id: i64,
        _message_id: i64,
        _dir: &str,
    ) -> Result<DownloadOutcome, ClientError> {
        Err(self.err())
    }

    async fn message_meta(
        &self,
        _chat_id: i64,
        _message_id: i64,
    ) -> Result<Option<MediaItem>, ClientError> {
        Err(self.err())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 核心不变量：不可用客户端对**每一个**能力都必须失败，绝不能有任何一个
    /// 悄悄返回 `Ok` —— 那正是 DummyClient 的病根。
    #[tokio::test]
    async fn every_capability_fails_honestly() {
        let c = UnavailableClient::new("test reason");

        assert!(c.start("+10000000000").await.is_err());
        assert!(c.submit_code("+10000000000", "00000").await.is_err());
        assert!(c.submit_password("+10000000000", "pw").await.is_err());
        assert!(c.dialogs().await.is_err());
        assert!(c.folders().await.is_err());
        assert!(c.messages(1, 10, None).await.is_err());
        assert!(c.thumb(1, 1).await.is_err());
        assert!(c.media(1, 1, None).await.is_err());
        assert!(c.download(1, 1, ".").await.is_err());
        assert!(c.message_meta(1, 1).await.is_err());

        // 错误必须是 Unavailable（→ 503），而不是别的语义（如 401 未登录）。
        match c.dialogs().await.unwrap_err() {
            ClientError::Unavailable(r) => assert_eq!(r, "test reason"),
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    /// `view()` 不可失败，只能给哨兵值；调用方必须靠 `availability` 判断真伪。
    #[tokio::test]
    async fn view_is_anonymous_sentinel() {
        let c = UnavailableClient::new("x");
        let v = c.view().await;
        assert_eq!(v.phase, LoginPhase::Anonymous);
        assert!(v.phone.is_none());
        assert!(v.user_id.is_none());
    }
}
