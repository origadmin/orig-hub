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
use std::time::{SystemTime, UNIX_EPOCH};

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

impl Channel {
    /// BUG-194：返回一份**展示名永不为空**的副本，供写入 `dialog_cache`。
    ///
    /// 写入路径（`upsert_dialog`）统一走这里，使「库里不存在空标题行」成为
    /// 存储层不变量 —— 无论标题来自 grammers 枚举、mock 还是将来的调用方。
    pub fn identified(mut self) -> Self {
        self.title = identified_title(&self.title, self.id);
        self
    }
}

/// BUG-194：`peer.name()` 解析不到名字时的**可辨识**兜底名。
///
/// 刻意**只陈述已知事实**：不写「已删除账户」这类断言，因为
/// `grammers` 明确说明 `name()` 为 `None` 有多种成因（peer 不可访问、
/// 账号已删除、**或者此前根本没收到过这个名字**）。断言一个未经证实的成因，
/// 与 BUG-194 要修的「把『未知』降级成『空』」是同一类错误。
///
/// 带 id 是必须的：实测 158 条无名会话里若全部标成同一个「已删除账户」，
/// 用户依旧无法分辨（doc 验收要求「每个条目都有可辨识的展示文本」）。
/// id 取正负与 Bot API 约定一致（正 = 用户，负 = 群组/频道）。
pub fn unnamed_dialog_title(id: i64) -> String {
    if id > 0 {
        format!("用户 {id}（无名称）")
    } else {
        format!("群组/频道 {id}（无名称）")
    }
}

/// BUG-194：把一个可能为空的标题收敛成**永不为空**且按 id 可辨识的展示名。
///
/// 非空白标题**原样返回**（仅用 `trim` 判定是否为空，不改写既有 363 条
/// 有名会话，避免顺带改动无关数据）。
pub fn identified_title(raw: &str, id: i64) -> String {
    if raw.trim().is_empty() {
        unnamed_dialog_title(id)
    } else {
        raw.to_string()
    }
}

/// BUG-194：枚举期入口 —— 把 `peer.name()` 的 `Option` 直接收敛成展示名，
/// 杜绝调用方再写 `unwrap_or_default()` 把「未知」降级成「空」。
pub fn dialog_display_title(peer_name: Option<&str>, id: i64) -> String {
    identified_title(peer_name.unwrap_or_default(), id)
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

/// 下载字节进度句柄（BUG-181）：`download()` 实现方在每个非空 chunk 落盘前累加
/// `bytes`、在总量可知时设置 `total`。调用方（缓存 worker）把它接到 AppState 的
/// 原子上，任务端点序列化时注入 `itemBytes`/`itemBytesTotal` —— 条目内的下载
/// 不再是 UI 上的冻结态（一条 200MB 视频以 0.7MB/s 下载约 5 分钟，此前该窗口
/// 内 `done` 计数纹丝不动，对用户完全等价于「系统死了」）。
///
/// 字段全是 `Arc<AtomicU64>`：句柄可 Clone 进 worker 与序列化方，无锁累加。
///
/// `last_ms`（BUG-221）：**字节最后一次推进**的墙钟时刻（ms epoch，0 = 尚无推进）。
/// 它只在 `add_bytes` 里随字节一起更新（单一真源），因此「有字节、但很久没再涨」
/// 与「正在跑」在服务端就是可区分的两件事 —— 没有它，前端只能拿
/// `cache_task.updated_at`（只在消息边界写）去猜，大文件下载期间那个值天然不动，
/// 用户据此只能判定「卡住了」。
#[derive(Clone, Default)]
pub struct DownloadProgress {
    pub bytes: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub total: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub last_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

/// 当前墙钟（ms epoch）；取不到（时钟早于 epoch）时为 0 —— 宁可「未知」也不假造。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl DownloadProgress {
    pub fn set_total(&self, total: u64) {
        self.total
            .store(total, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn add_bytes(&self, n: u64) {
        self.bytes
            .fetch_add(n, std::sync::atomic::Ordering::Relaxed);
        // 只有**真的推进**才刷新心跳：空 chunk（n == 0）不构成进展，
        // 否则「零字节空转」会被当成「刚动过」，停滞判据失效。
        if n > 0 {
            self.last_ms
                .store(now_ms(), std::sync::atomic::Ordering::Relaxed);
        }
    }
    pub fn reset(&self) {
        self.bytes.store(0, std::sync::atomic::Ordering::Relaxed);
        self.total.store(0, std::sync::atomic::Ordering::Relaxed);
        // 新条目尚无推进 ⇒ 心跳未知（0）。写成 now() 会让「排队后刚开流、一个字节
        // 都还没到」被算成「刚推进过」，停滞判据就被推迟了一次假心跳。
        self.last_ms.store(0, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn load(&self) -> (u64, u64) {
        (
            self.bytes.load(std::sync::atomic::Ordering::Relaxed),
            self.total.load(std::sync::atomic::Ordering::Relaxed),
        )
    }
    /// 字节 + 总量 + 最后推进时刻（`BUG-221`）。`last_ms == 0` 表示尚无推进。
    pub fn load_with_at(&self) -> (u64, u64, u64) {
        let (bytes, total) = self.load();
        (
            bytes,
            total,
            self.last_ms.load(std::sync::atomic::Ordering::Relaxed),
        )
    }
}

/// 单条目下载限额（BUG-271）。
///
/// 两个阈值治**两种病**，刻意并存、不得合并成一个判定——合并会把「慢」误判成「死」：
///
/// - [`DownloadLimits::idle`]（空闲，默认 90s）：治「**死**」。TCP 半死/代理断流时
///   range 流的 `next()` 永不返回，没有它 worker 卡死在条目内。判据是「无字节间隔」，
///   任何非空 chunk 重置计时。
/// - [`DownloadLimits::wall`]（墙钟，默认 30min）：治「**慢**」。空闲计时对
///   「每 89s 来一小块」的流**永不触发**（chunk 到达即重置）——连接活着、字节极慢，
///   队首被无限期占住。墙钟是总时长死线，与 chunk 到达无关。
///
/// 取值链（照 `resolve_cache_dir` 先例）：DB `app_setting` > config(env) > 默认。
/// 「请求」档不适用：限额在缓存 worker 内解析，那里没有 HTTP 请求上下文。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadLimits {
    /// 空闲停滞上限：连续无字节超过该时长判「死」（治 BUG-257 前的卡死形态）。
    pub idle: std::time::Duration,
    /// 单条目墙钟上限：总耗时（与 chunk 到达无关）超过该时长判「慢」（BUG-271）。
    pub wall: std::time::Duration,
}

impl Default for DownloadLimits {
    fn default() -> Self {
        Self {
            // 90s：原 `grammers.rs` 硬编码值原样收编（治「死」的既定语义不变）。
            idle: std::time::Duration::from_secs(90),
            // 30min：BUG-271.md 的示例档。1MB/s 慢链 ≈ 1.8GB/条目；更大或更慢
            // 用 `download_item_max_secs` 设置上调。超限条目可重试且不弃单
            // （BUG-257 隔离通道），故误伤大文件的代价是「重跑该条」，不是丢任务。
            wall: std::time::Duration::from_secs(30 * 60),
        }
    }
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
    /// MTProto 发信链路是否仍然活着（BUG-106）。
    ///
    /// `false` = 链路已断：此后所有**实时** RPC 都会返回 `RequestError::Dropped`
    /// （原文 `request error: dropped (cancelled)`）。而只读本地库/会话文件的接口
    /// （如 `session` / `dialogs` 缓存）仍会正常返回 —— 这正是「全接口报绿、实际全残」
    /// 的成因。健康接口必须先看这个方法，不能只看会话授权态。
    ///
    /// 默认 `true`：mock / 无网实现不走真实 MTProto，不存在链路死亡问题。
    fn link_alive(&self) -> bool {
        true
    }
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
    ///
    /// `progress`（BUG-181）：`Some` 时实现方须按 chunk 累加字节并设置总量；
    /// `None`（在线投递等非缓存路径）不报进度。实现方**不得**因 progress 为 None 失败。
    async fn download(
        &self,
        chat_id: i64,
        message_id: i64,
        dir: &str,
        progress: Option<&DownloadProgress>,
    ) -> Result<DownloadOutcome, ClientError>;

    /// 同 [`Client::download`]，但携带**单条目下载限额**（BUG-271）。
    ///
    /// 提供默认实现（忽略限额、直通 [`Client::download`]）是刻意的：全库只有一个
    /// 生产调用点（缓存条目路径）需要限额，而 mock / 测试夹具 / 不可用客户端共 6 个
    /// 实现**不该**为 trait 签名变更买单。真实实现（GrammersClient）覆写本方法，
    /// 把 `idle` 交给其流循环；`wall` 由路由层围绕本调用整体计时（见
    /// `cache_one_bytes`）——两层各治一病，互不合并。
    async fn download_limited(
        &self,
        chat_id: i64,
        message_id: i64,
        dir: &str,
        progress: Option<&DownloadProgress>,
        limits: &DownloadLimits,
    ) -> Result<DownloadOutcome, ClientError> {
        let _ = limits;
        self.download(chat_id, message_id, dir, progress).await
    }
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
    /// TG 整体不可用（凭证缺失 / MTProto 连接失败）。
    ///
    /// 这是**显式错误态**：绝不允许用「返回合成数据的假客户端」替代（BUG-023）。
    /// 映射为 503 + 原因，使故障可见；调用方据此区分「依赖不可用」与「未登录」。
    #[error("telegram unavailable: {0}")]
    Unavailable(String),
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

    /// BUG-194 策略钉子（纯函数层）：空标题永不落空，且按 id 可辨识。
    ///
    /// 这一层是 `grammers::channel_from_dialog` 的根因修复点 —— 旧代码
    /// `peer.name().unwrap_or_default()` 正是从这里把「未知」降级成「空」。
    #[test]
    fn blank_dialog_title_falls_back_to_identifiable_bug194() {
        // None（peer 解析不到名字）与空串、纯空白：三者都必须被兜底。
        for raw in [None, Some(""), Some("   "), Some("\t\n ")] {
            let t = dialog_display_title(raw, 270804017);
            assert!(
                !t.trim().is_empty(),
                "无名会话不得产出空标题（BUG-194），raw={raw:?}"
            );
            assert!(t.contains("270804017"), "兜底名须带 id 以便可辨识: {t}");
        }
        // 有名会话原样保留（不回归）。
        assert_eq!(dialog_display_title(Some("麻豆短剧"), -1004493170102), "麻豆短剧");
        assert_eq!(dialog_display_title(Some("Telegram"), 777000), "Telegram");
        // 有名字但首尾带空白：判定按 trim，但不改写内容。
        assert_eq!(dialog_display_title(Some(" Telegram "), 777000), " Telegram ");
        // 正负 id 分别对应用户 / 群组频道（Bot API 约定）。
        assert!(unnamed_dialog_title(100).starts_with("用户"));
        assert!(unnamed_dialog_title(-100).starts_with("群组/频道"));
        // 两条无名会话必须彼此可区分。
        assert_ne!(dialog_display_title(None, 1), dialog_display_title(None, 2));
    }

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
        async fn download(
            &self,
            _chat_id: i64,
            _message_id: i64,
            _dir: &str,
            _progress: Option<&DownloadProgress>,
        ) -> Result<DownloadOutcome, ClientError> {
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