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

use std::pin::Pin;

use futures::Stream;
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

/// 订阅频道/会话的轻量元数据（枚举 + 频道本地索引的公共 DTO）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: i64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// 频道归属的分组标题（按 TG 自定义分组划分；未归组则为 None）。
    #[serde(rename = "folder", skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// TG 自定义分组（DialogFilter）的公共 DTO，用于前端分组筛选。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: i32,
    pub title: String,
    #[serde(rename = "channelIds", skip_serializing_if = "Vec::is_empty")]
    pub channel_ids: Vec<i64>,
}

/// 频道内一条媒体消息的摘要（历史拉取公共 DTO）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaItem {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(rename = "size", skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    /// 媒体类型：`photo` | `video` | `audio` | `file`；非媒体消息为 None。
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// 文档文件名（仅 Document 且 name 非空时给出）。
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// 消息时间（epoch 秒）。
    #[serde(rename = "date", skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
    /// 媒体时长（秒；视频/音频才有，取自 TG 文档属性，v0.4.1）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i64>,
    /// TG 相册分组 id（同一相册的多条媒体共享同值，v0.4.2；单发媒体为 None）。
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<i64>,
    /// 是否含可在线流式播放/预览的媒体。
    #[serde(rename = "hasMedia")]
    pub has_media: bool,
}

/// 轻量缩略图（列表海报用）。缩略图体积小（通常 < 100KB），整段字节进内存返回。
#[derive(Debug, Clone)]
pub struct Thumbnail {
    /// 缩略图 content-type（Telegram 缩略图统一为 `image/jpeg`）。
    pub content_type: String,
    /// 缩略图原始字节。
    pub bytes: Vec<u8>,
}

/// 一次媒体下载的落盘结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadOutcome {
    /// 消息 id。
    #[serde(rename = "messageId")]
    pub message_id: i64,
    /// 最终落盘路径（绝对路径）。
    #[serde(rename = "path")]
    pub path: String,
    /// 实际写盘字节数。
    #[serde(rename = "bytes")]
    pub bytes: u64,
}

/// HTTP `Range` 头的解析产物（`bytes` 单位，未解析到合法区间时传 `None` 表示整段）。
#[derive(Debug, Clone, Copy)]
pub enum MediaRange {
    /// `bytes=start-`：从 `start` 读到文件末尾。
    Open(u64),
    /// `bytes=start-end`：闭区间，`end` 为含在内的末字节。
    Closed(u64, u64),
    /// `bytes=-N`：文件末尾的 N 字节（需要先知道 total 才能换算 start）。
    Tail(u64),
}

/// 媒体流式响应（供 HTTP Body 直接透传，不整段收进内存）。
pub struct MediaStream {
    /// 媒体 content-type（如 `video/mp4`）。
    pub content_type: String,
    /// 媒体总字节数（未知时为 None）。
    pub total_size: Option<u64>,
    /// 实际响应的起始字节（含）。
    pub start: u64,
    /// 实际响应的结束字节（含）。
    pub end: u64,
    /// 按需流式产出的字节块流（每项一块，直接喂给 `Body::from_stream`）。
    pub body: Pin<Box<dyn Stream<Item = Result<Vec<u8>, std::io::Error>> + Send>>,
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
    /// 枚举用户订阅的会话（频道/群组/私聊），含频道元数据（全量，供后台缓存扫描）。
    async fn dialogs(&self) -> Result<Vec<Channel>, ClientError>;
    /// 枚举用户自定义分组（DialogFilter），含每组归属的频道 id（Bot API 对话 id 空间）。
    async fn folders(&self) -> Result<Vec<Folder>, ClientError>;
    /// 拉取指定会话的媒体历史（从新到旧），最多 `limit` 条**媒体消息**（纯文本跳过）。
    ///
    /// `before_id` 为历史游标（exclusive）：`Some(id)` 时只返回 message_id < id 的消息；
    /// `None` 时从最新开始。内部按需自动翻页直到取够媒体条数或无更多。
    async fn messages(
        &self,
        chat_id: i64,
        limit: u32,
        before_id: Option<i64>,
    ) -> Result<Vec<MediaItem>, ClientError>;
    /// 获取指定会话中某条媒体消息的轻量缩略图（列表海报用，不落盘）。
    /// 无可用缩略图（非媒体/无 thumb）时返回 `Ok(None)`。
    async fn thumb(&self, chat_id: i64, message_id: i64) -> Result<Option<Thumbnail>, ClientError>;
    /// 获取指定会话中某条媒体消息的在线流（不落盘）。
    ///
    /// `range` 为解析后的字节区间：`Some` 时按区间局部拉取（206 Source），
    /// `None` 表示整段返回（200）。区间不可满足时返回 `ClientError::UnsatisfiableRange`。
    async fn media(
        &self,
        chat_id: i64,
        message_id: i64,
        range: Option<MediaRange>,
    ) -> Result<MediaStream, ClientError>;
    /// 将指定会话中某条媒体消息下载到 `dir`，返回落盘结果。
    async fn download(&self, chat_id: i64, message_id: i64, dir: &str) -> Result<DownloadOutcome, ClientError>;
    /// 获取单条消息的媒体元数据（下载后回填入库用）。
    ///
    /// 消息不存在、拉取失败或非媒体消息时返回 `Ok(None)`，调用方回退为仅标记 downloaded。
    async fn message_meta(
        &self,
        chat_id: i64,
        message_id: i64,
    ) -> Result<Option<MediaItem>, ClientError>;
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
    #[error("media not found")]
    MediaNotFound,
    /// 请求的字节区间不可满足：`Option` 内为媒体总字节数（未知时为 None），对应 416。
    #[error("requested byte range not satisfiable")]
    UnsatisfiableRange(Option<u64>),
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
        async fn dialogs(&self) -> Result<Vec<Channel>, ClientError> {
            Ok(Vec::new())
        }
        async fn folders(&self) -> Result<Vec<Folder>, ClientError> {
            Ok(Vec::new())
        }
        async fn messages(
            &self,
            _chat_id: i64,
            _limit: u32,
            _before_id: Option<i64>,
        ) -> Result<Vec<MediaItem>, ClientError> {
            Ok(Vec::new())
        }
        async fn thumb(
            &self,
            _chat_id: i64,
            _message_id: i64,
        ) -> Result<Option<Thumbnail>, ClientError> {
            Ok(None)
        }
        async fn media(&self, _chat_id: i64, _message_id: i64, _range: Option<MediaRange>) -> Result<MediaStream, ClientError> {
            Err(ClientError::MediaNotFound)
        }
        async fn download(&self, _chat_id: i64, _message_id: i64, _dir: &str) -> Result<DownloadOutcome, ClientError> {
            Err(ClientError::MediaNotFound)
        }
        async fn message_meta(
            &self,
            _chat_id: i64,
            _message_id: i64,
        ) -> Result<Option<MediaItem>, ClientError> {
            Ok(None)
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