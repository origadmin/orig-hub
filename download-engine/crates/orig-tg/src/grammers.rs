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
//! 本实现依赖在 `my.telegram.org` 申请的 api_id/api_hash。
//! 未配置或连接失败时**不再回退合成客户端**（BUG-023 的结构性修复）：
//! 服务以 `Availability::Unavailable(原因)` 启动，相关端点诚实返回 503，
//! 由 `unavailable.rs::UnavailableClient` 承载（只返回错误、绝不返回数据）。

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use futures::{Stream, StreamExt};
use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::media::{Media, PhotoSize};
use grammers_client::sender::ConnectionParams;
use grammers_client::session::storages::SqliteSession;
use grammers_client::session::types::PeerRef;
use grammers_client::{Client as TgClient, SenderPool, SignInError, tl};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::login::{
    Channel, Client, ClientError, DownloadOutcome, Folder, LoginPhase, MediaItem, MediaRange,
    MediaStream, SessionView, Thumbnail,
};

/// 单块下载请求的字节数（介于 grammers 的 MIN=4KiB 与 MAX=512KiB 之间）。
static RANGE_CHUNK: i32 = 512 * 1024;

/// 在线拉流的并行 worker 数（BUG-028）。grammers 的 `iter_download` 一次只发一个
/// `upload.GetFile` 请求，吞吐 = chunk/RTT ≈ 0.5MB/s；播放器一条流根本喂不饱，
/// 与缩略图等其他请求共享时更是雪上加霜。grammers 自己的 `download_media` 落盘
/// 也用 4 worker 并行（`WORKER_COUNT`），这里对齐同一数值。
static STREAM_WORKERS: u64 = 4;

/// `take` 未知（整段 200 响应）时每个 worker 的分片长度。
static UNKNOWN_TOTAL_SEGMENT: u64 = 16 * 1024 * 1024;

/// 媒体元数据缓存容量 / TTL。`(chat_id, message_id) -> MediaMeta`。
/// FileLocation 含 access_hash，长期有效；TTL 只是防陈旧的保险丝。
const MEDIA_META_CAP: usize = 256;
const MEDIA_META_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// 缩略图字节缓存容量 / TTL（缩略图不可变，TTL 可以更长）。
const THUMB_CACHE_CAP: usize = 512;
const THUMB_TTL: std::time::Duration = std::time::Duration::from_secs(1800);

/// 缩略图整段拉取的字节上限（正常缩略图远小于此，超出则截断保护）。
static THUMB_MAX_BYTES: usize = 512 * 1024;

/// 媒体历史翻页时，底层原始消息的扫描上限（防止无媒体频道空翻页）。
static MEDIA_RAW_SCAN_CAP: usize = 600;

/// Bot API 频道/超级群对话 id 前缀（-100 拼接，数值上为 -1000000000000 - channel_id）。
static BOT_API_CHANNEL_MARK: i64 = -1_000_000_000_000;

/// 登录中间态（在多次 HTTP 请求之间保留 Telegram 返回的 token）。
struct Pending {
    phase: LoginPhase,
    phone: Option<String>,
    user_id: Option<i64>,
    login_token: Option<LoginToken>,
    password_token: Option<PasswordToken>,
}

/// 缓存的媒体解析结果（BUG-028）。
#[derive(Clone)]
struct MediaMeta {
    media: Media,
    content_type: String,
    total_size: Option<u64>,
}

/// 包装 grammers 客户端的真实实现。
pub struct GrammersClient {
    inner: TgClient,
    /// 发起登录码请求时需要 api_hash（grammers 0.10 的 `request_login_code(phone, api_hash)`）。
    api_hash: String,
    pending: Mutex<Pending>,
    /// PeerRef（含 access_hash）缓存：bot_api 对话 id -> PeerRef。
    /// 枚举 dialogs 时批量填充；媒体/消息接口命中即免去每次全量枚举（实测省 3.8s+）。
    peer_cache: tokio::sync::Mutex<HashMap<i64, PeerRef>>,
    /// 媒体元数据缓存（BUG-028）：`(chat_id, message_id) -> MediaMeta`。
    /// 播放器 seek / 续传 Range / 缩略图重渲染都会重新请求同一媒体，
    /// 每次都要付出一次 `get_messages_by_id` RPC（实测 ~1.2s）——命中即零 RPC。
    media_meta: crate::lru::TtlLru<(i64, i64), MediaMeta>,
    /// 缩略图字节缓存（BUG-028）：缩略图不可变，字节级缓存让 feed 重渲染零 TG 流量。
    thumb_cache: crate::lru::TtlLru<(i64, i64), Arc<Vec<u8>>>,
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
            peer_cache: tokio::sync::Mutex::new(HashMap::new()),
            media_meta: crate::lru::TtlLru::new(MEDIA_META_CAP, MEDIA_META_TTL),
            thumb_cache: crate::lru::TtlLru::new(THUMB_CACHE_CAP, THUMB_TTL),
        })
    }

    /// 解析 bot_api 对话 id 对应的 PeerRef（含 access_hash）。
    ///
    /// 优先读内存缓存；未命中时全量枚举一次 dialogs 并**批量回填缓存**，
    /// 后续媒体/消息/缩略图请求直接命中（避免每次请求都全量枚举，实测 3.8s+）。
    async fn resolve_peer(&self, chat_id: i64) -> Result<PeerRef, ClientError> {
        if let Some(p) = self.peer_cache.lock().await.get(&chat_id).copied() {
            return Ok(p);
        }
        let mut iter = self.inner.iter_dialogs();
        let mut found: Option<PeerRef> = None;
        while let Some(dialog) = iter
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            let id = dialog.peer().id().bot_api_dialog_id().unwrap_or(0);
            let pref = dialog.peer_ref();
            if id == chat_id {
                found = Some(pref);
            }
            self.peer_cache.lock().await.insert(id, pref);
        }
        found.ok_or_else(|| ClientError::Other("chat not found in subscribed dialogs".into()))
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
        // 分组读取失败（如代理连接抖动被断）不阻塞频道枚举：仅降级为「未分组」。
        let folder_of = self.folder_of().await;
        let mut out = Vec::new();
        let mut iter = self.inner.iter_dialogs();
        while let Some(dialog) = iter
            .next()
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
        {
            // 枚举时顺便填充 PeerRef 缓存（媒体/消息接口后续直接命中）。
            let id = dialog.peer().id().bot_api_dialog_id().unwrap_or(0);
            self.peer_cache.lock().await.insert(id, dialog.peer_ref());
            out.push(channel_from_dialog(&dialog, &folder_of));
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

        // 诊断日志（BUG-013 实证）：原始 filters 数量与每个变体，定位空响应来源。
        eprintln!(
            "[tg] GetDialogFilters raw count={} variants=[{}]",
            filters.len(),
            filters
                .iter()
                .map(|f| match f {
                    tl::enums::DialogFilter::Filter(_) => "filter",
                    tl::enums::DialogFilter::Chatlist(_) => "chatlist",
                    tl::enums::DialogFilter::Default => "default",
                })
                .collect::<Vec<_>>()
                .join(",")
        );

        let mut out = Vec::new();
        for f in filters {
            // 普通自定义文件夹 Filter 与共享聊天列表 Chatlist 都对用户可见，统一接受。
            let (id, title, peers) = match f {
                tl::enums::DialogFilter::Filter(filter) => (filter.id, filter.title, filter.include_peers),
                tl::enums::DialogFilter::Chatlist(filter) => {
                    (filter.id, filter.title, filter.include_peers)
                }
                tl::enums::DialogFilter::Default => continue,
            };
            let title = match title {
                tl::enums::TextWithEntities::Entities(t) => t.text,
            };
            // 统一转换为 Bot API 对话 id（与 dialogs 的 id 同空间，否则映射永不命中）。
            let ids: Vec<i64> = peers.iter().filter_map(input_peer_bot_api_id).collect();
            eprintln!(
                "[tg] folder id={id} title={title:?} include={} mapped={}",
                peers.len(),
                ids.len()
            );
            out.push(Folder {
                id,
                title,
                channel_ids: ids,
            });
        }
        Ok(out)
    }

    async fn messages(
        &self,
        chat_id: i64,
        limit: u32,
        before_id: Option<i64>,
    ) -> Result<Vec<MediaItem>, ClientError> {
        // PeerRef 走缓存（dialogs 扫描后已填充），未命中时 resolve_peer 内部兜底枚举。
        let peer = self.resolve_peer(chat_id).await?;

        let want = limit.clamp(1, 100) as usize;
        let mut iter = self.inner.iter_messages(peer);
        // offset_id 为 exclusive max id：只返回 id < before 的消息（天然聊天式历史游标）。
        if let Some(before) = before_id {
            iter = iter.offset_id(before as i32);
        }
        // 不设置 iter.limit：媒体可能稀疏，由 raw_seen 上限保护自动翻页直到取够媒体。
        let mut out = Vec::new();
        let mut raw_seen = 0usize;
        while out.len() < want && raw_seen < MEDIA_RAW_SCAN_CAP {
            let Some(m) = iter
                .next()
                .await
                .map_err(|e| ClientError::Other(e.to_string()))?
            else {
                break; // 无更多消息
            };
            raw_seen += 1;
            let Some((media_type, mime_type, size, file_name, duration)) =
                classify_media(m.media())
            else {
                continue; // 纯文本/服务消息：媒体历史不展示
            };
            let caption = {
                let text = m.text();
                if text.is_empty() {
                    None
                } else {
                    Some(text.to_string())
                }
            };
            out.push(MediaItem {
                id: m.id() as i64,
                caption,
                mime_type,
                size,
                has_media: true,
                media_type: Some(media_type),
                file_name,
                date: Some(m.date().timestamp()),
                duration,
                group_id: m.grouped_id().map(|g| g as i64),
            });
        }
        Ok(out)
    }

    /// 缩略图：优先命中字节缓存（BUG-028），未命中才走 `thumb_fetch` 实拉。
    async fn thumb(
        &self,
        chat_id: i64,
        message_id: i64,
    ) -> Result<Option<Thumbnail>, ClientError> {
        // 缩略图字节缓存（BUG-028）：feed 每次渲染/翻页都会请求同一批缩略图，
        // 字节不可变 → 命中即零 RPC、零 TG 流量。
        let key = (chat_id, message_id);
        if let Some(bytes) = self.thumb_cache.get(&key) {
            return Ok(Some(Thumbnail {
                content_type: "image/jpeg".into(),
                bytes: (*bytes).clone(),
            }));
        }

        let fetched = self.thumb_fetch(chat_id, message_id).await?;
        if let Some(t) = &fetched {
            self.thumb_cache.insert(key, Arc::new(t.bytes.clone()));
        }
        Ok(fetched)
    }

    async fn download(&self, chat_id: i64, message_id: i64, dir: &str) -> Result<DownloadOutcome, ClientError> {
        // PeerRef 走缓存（dialogs 扫描后已填充）。
        let peer = self.resolve_peer(chat_id).await
            .map_err(|_| ClientError::MediaNotFound)?;

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
                    // TG 文档名常含 Windows 非法字符（| : ? * 等），直接落盘会 os error 5/123。
                    sanitize_filename(&name)
                } else {
                    let mime = doc.mime_type().unwrap_or("bin");
                    let ext = extension_for_mime(mime).unwrap_or("bin");
                    format!("doc-{}_{}.{}", chat_id, message_id, ext)
                }
            }
            _ => return Err(ClientError::MediaNotFound),
        };

        let dir = PathBuf::from(dir);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| ClientError::Other(format!("create dir: {e}")))?;
        let path = dir.join(&filename);

        // 缓存走与在线播放完全相同的**并行**拉流流程（BUG-028，替代 iter_download 串行整段
        // + 自管写盘），替代 `message.download_media`（其落盘路径对 Windows 文件名/目录敏感，
        // 曾在文件名含非法字符时统一报 os error 5）。播放正常的媒体即可缓存。
        //
        // 原子落盘（BUG-024）：先写 `<name>.part`，全部字节落完再改名为最终路径。
        // 此前直接写最终路径，中途失败/请求被中断会留下「看着已缓存、实为半截」的文件，
        // 而 DB 未标记 → 磁盘与状态不一致。`PartFile` 的 Drop 保证未完成即自动清理。
        let total = match &media {
            Media::Photo(p) => p.size().map(|s| s as u64),
            Media::Document(d) => d.size().map(|s| s as u64),
            _ => None,
        };
        let mut body = parallel_range_stream(self.inner.clone(), media, 0, 0, total);
        let mut out = PartFile::create(&dir, &filename)
            .await
            .map_err(|e| ClientError::Other(format!("create file: {e}")))?;
        let mut bytes: u64 = 0;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| ClientError::Other(format!("download stream: {e}")))?;
            out.write_all(&chunk)
                .await
                .map_err(|e| ClientError::Other(format!("write file: {e}")))?;
            bytes += chunk.len() as u64;
        }
        out.persist(&path)
            .await
            .map_err(|e| ClientError::Other(format!("flush file: {e}")))?;
        Ok(DownloadOutcome {
            message_id,
            path: path.to_string_lossy().into_owned(),
            bytes,
        })
    }

    async fn message_meta(
        &self,
        chat_id: i64,
        message_id: i64,
    ) -> Result<Option<MediaItem>, ClientError> {
        // PeerRef 走缓存（dialogs 扫描后已填充）；peer 解析失败按无消息处理（回退仅标记）。
        let Ok(peer) = self.resolve_peer(chat_id).await else {
            return Ok(None);
        };
        let found = self
            .inner
            .get_messages_by_id(peer, &[message_id as i32])
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
            .into_iter()
            .find_map(|m| m);
        let Some(message) = found else {
            return Ok(None);
        };
        let Some((media_type, mime_type, size, file_name, duration)) =
            classify_media(message.media())
        else {
            return Ok(None); // 非媒体消息（纯文本/服务消息）
        };
        let caption = {
            let text = message.text();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        };
        Ok(Some(MediaItem {
            id: message.id() as i64,
            caption,
            mime_type,
            size,
            has_media: true,
            media_type: Some(media_type),
            file_name,
            date: Some(message.date().timestamp()),
            duration,
            group_id: message.grouped_id().map(|g| g as i64),
        }))
    }

    /// 单块下载请求的字节数（介于 grammers 的 MIN=4KiB 与 MAX=512KiB 之间）。
    async fn media(
        &self,
        chat_id: i64,
        message_id: i64,
        range: Option<MediaRange>,
    ) -> Result<MediaStream, ClientError> {
        // 媒体解析（含缓存，BUG-028）：peer 解析 + get_messages_by_id 实测 ~1.2s，
        // 播放器 seek / 续传 Range 会反复触发。命中缓存则零 RPC 直接取流。
        let key = (chat_id, message_id);
        let (media, content_type, total_size) = match self.media_meta.get(&key) {
            Some(m) => (m.media, m.content_type, m.total_size),
            None => {
                // PeerRef 走缓存（dialogs 扫描后已填充）。
                let peer = self
                    .resolve_peer(chat_id)
                    .await
                    .map_err(|_| ClientError::MediaNotFound)?;

                let found = self
                    .inner
                    .get_messages_by_id(peer, &[message_id as i32])
                    .await
                    .map_err(|e| ClientError::Other(e.to_string()))?
                    .into_iter()
                    .find_map(|m| m);
                let message = found.ok_or(ClientError::MediaNotFound)?;

                let media = message.media().ok_or(ClientError::MediaNotFound)?;
                let content_type = match &media {
                    Media::Photo(_) => "image/jpeg".to_string(),
                    Media::Document(doc) => doc
                        .mime_type()
                        .map(str::to_string)
                        .unwrap_or_else(|| "application/octet-stream".to_string()),
                    _ => return Err(ClientError::MediaNotFound),
                };
                let total_size = match &media {
                    Media::Photo(photo) => photo.size().map(|s| s as u64),
                    Media::Document(doc) => doc.size().map(|s| s as u64),
                    _ => return Err(ClientError::MediaNotFound),
                };
                // 只缓存可 iter_download 的媒体；Photo/Document 的 FileLocation
                // 含 access_hash，跨请求复用安全。
                self.media_meta.insert(
                    key,
                    MediaMeta {
                        media: media.clone(),
                        content_type: content_type.clone(),
                        total_size,
                    },
                );
                (media, content_type, total_size)
            }
        };

        // 把请求的 Range（含开放区间 / 闭区间 / 末尾 Tail 三种形式）规约成具体的
        // [start, end] 输出区间。无 Range 时返回整段。区间不可满足时抛 UnsatisfiableRange。
        let (start, end) = match range {
            None => (0, total_size.map_or(0, |t| t.saturating_sub(1))),
            Some(r) => {
                let total = total_size.ok_or(ClientError::UnsatisfiableRange(None))?;
                let (s, e_opt) = match r {
                    MediaRange::Open(s) => (s, None),
                    MediaRange::Closed(s, e) => (s, Some(e)),
                    MediaRange::Tail(n) => {
                        if n >= total {
                            (0, None) // 请求超出总长，退化为整段
                        } else {
                            (total - n, Some(total - 1))
                        }
                    }
                };
                let end = e_opt.unwrap_or(total - 1).min(total - 1);
                if s >= total || s > end {
                    return Err(ClientError::UnsatisfiableRange(Some(total)));
                }
                (s, end)
            }
        };
        // 本地只需拉取 [start, end] 区间：先用 chunk 对齐下界把下载偏移前移到
        // 不超过 start 的 chunk 边界，再丢弃首个 chunk 内多余的头部字节（<=chunk）。
        // 这样只向 Telegram 请求需要的分段，不整段进内存。
        let chunk = RANGE_CHUNK as u64;
        let (boundary, skip_lead, take) = match range {
            // 无 Range 且总长未知：整段读到末尾，Take 不加限制。
            None if total_size.is_none() => (0, 0, None),
            // 其余（无 Range 已知总长 / 有 Range）：按已求出区间截取 take 字节。
            _ => {
                let boundary = (start / chunk) * chunk;
                (boundary, start - boundary, Some(end - start + 1))
            }
        };

        // 并行分片拉流（BUG-028）：K 个 worker 各取一段 chunk 对齐的连续区间，
        // 按序合并输出。单 worker 吞吐 = chunk/RTT ≈ 0.5MB/s，K 路并行近似线性扩展。
        let body = parallel_range_stream(self.inner.clone(), media, boundary, skip_lead, take);
        Ok(MediaStream {
            content_type,
            total_size,
            start,
            end,
            body,
        })
    }
}

/// 通过订阅枚举建立「频道 id -> 分组标题」映射（取首个命中；失败降级为空映射）。
impl GrammersClient {
    /// 缩略图实际拉取（`thumb()` 的缓存未命中路径）：解析消息 → 选最小可用尺寸 →
    /// 64KiB 分块拉取。放在 inherent impl，避免被 async_trait 视作 trait 成员。
    async fn thumb_fetch(
        &self,
        chat_id: i64,
        message_id: i64,
    ) -> Result<Option<Thumbnail>, ClientError> {
        let Ok(peer) = self.resolve_peer(chat_id).await else {
            return Ok(None);
        };
        let found = self
            .inner
            .get_messages_by_id(peer, &[message_id as i32])
            .await
            .map_err(|e| ClientError::Other(e.to_string()))?
            .into_iter()
            .find_map(|m| m);
        let Some(message) = found else { return Ok(None) };
        let media = message.media();
        let thumbs: Vec<PhotoSize> = match media {
            Some(Media::Photo(p)) => p.thumbs().to_vec(),
            Some(Media::Document(d)) => d.thumbs().to_vec(),
            _ => return Ok(None),
        };

        // 优先用 TL 内嵌的 Cached 缩略图（完整 JPEG 字节，零网络往返，实测最快）。
        // Stripped 是 Telegram 特殊占位压缩格式（首字节 0x01），不能直接当 JPEG，跳过。
        if let Some(PhotoSize::Cached(c)) = thumbs
            .iter()
            .find(|x| matches!(x, PhotoSize::Cached(_)))
        {
            if !c.bytes.is_empty() {
                return Ok(Some(Thumbnail {
                    content_type: "image/jpeg".into(),
                    bytes: c.bytes.clone(),
                }));
            }
        }

        // 次选可下载的 Size/Progressive：宽度 <=480 中取最宽的（清晰且省流），
        // 全是超大图时退化为第一个可下载尺寸。
        let downloadable: Vec<&PhotoSize> = thumbs
            .iter()
            .filter(|x| {
                matches!(x, PhotoSize::Size(_) | PhotoSize::Progressive(_))
            })
            .collect();
        let pick = downloadable
            .iter()
            .copied()
            .filter(|x| photo_size_dims(x).map_or(false, |(w, _)| w > 0 && w <= 480))
            .max_by_key(|x| photo_size_dims(x).map(|(w, _)| w).unwrap_or(0))
            .or_else(|| downloadable.first().copied());
        let Some(ps) = pick else { return Ok(None) };

        let mut iter = self.inner.iter_download(ps);
        iter = iter.chunk_size(64 * 1024);
        let mut bytes = Vec::new();
        while bytes.len() < THUMB_MAX_BYTES {
            let Some(chunk) = iter
                .next()
                .await
                .map_err(|e| ClientError::Other(e.to_string()))?
            else {
                break;
            };
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(None);
        }
        bytes.truncate(THUMB_MAX_BYTES);
        Ok(Some(Thumbnail {
            content_type: "image/jpeg".into(),
            bytes,
        }))
    }

    async fn folder_of(&self) -> std::collections::HashMap<i64, String> {
        let mut folder_of: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        if let Ok(folders) = self.folders().await {
            for folder in folders {
                let title = folder.title.clone();
                for id in folder.channel_ids {
                    folder_of.entry(id).or_insert_with(|| title.clone());
                }
            }
        }
        folder_of
    }
}

/// 将一条 Dialog 转换为公共 Channel DTO（含分组标题映射）。
fn channel_from_dialog(
    dialog: &grammers_client::peer::Dialog,
    folder_of: &std::collections::HashMap<i64, String>,
) -> Channel {
    let peer = dialog.peer();
    let id = peer.id().bot_api_dialog_id().unwrap_or(0);
    Channel {
        id,
        title: peer.name().unwrap_or_default().to_string(),
        username: peer.username().map(str::to_string),
        folder: folder_of.get(&id).cloned(),
    }
}

/// 清洗文件名：Windows 非法字符/控制字符替换为 `_`，去尾部 `.`/空格（NTFS 拒绝），
/// 空名兜底 `download.bin`；保留原始扩展名。
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim().to_string();
    if trimmed.is_empty() {
        "download.bin".into()
    } else {
        trimmed
    }
}

/// 把 `iter_download` 的 chunk 流包装成只产出区间字节的流：
/// 先丢弃 `skip_lead` 个前端字节（首个 chunk 的头部对齐多余字节），
/// 再限制累计输出不超过 `take` 字节（`None` 表示不加限制读到末尾）。
/// 每项一块，供 `Body::from_stream` 直接透传。
/// 原子落盘守卫：写 `<name>.part`，`persist()` 改名为最终路径。
///
/// 未调用 `persist` 就被丢弃（拉流报错、请求被中断、任务取消）时，`Drop` 直接删掉半成品，
/// 保证磁盘上**永不出现「半截但看起来像已缓存」**的文件——状态与内容不会脱节。
struct PartFile {
    file: Option<tokio::fs::File>,
    part: PathBuf,
    persisted: bool,
}

impl PartFile {
    async fn create(dir: &Path, filename: &str) -> io::Result<Self> {
        let part = dir.join(format!("{filename}.part"));
        let file = tokio::fs::File::create(&part).await?;
        Ok(Self {
            file: Some(file),
            part,
            persisted: false,
        })
    }

    async fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        use tokio::io::AsyncWriteExt;
        match self.file.as_mut() {
            Some(f) => f.write_all(buf).await,
            None => Ok(()),
        }
    }

    /// 收尾：flush → 关闭句柄 → 原子改名为最终路径（Windows 上 rename 覆盖已存在目标）。
    async fn persist(mut self, final_path: &Path) -> io::Result<()> {
        use tokio::io::AsyncWriteExt;
        if let Some(f) = self.file.as_mut() {
            f.flush().await?;
        }
        // 先关句柄再改名，避免某些播放器占用目标文件时的共享冲突差异。
        drop(self.file.take());
        tokio::fs::rename(&self.part, final_path).await?;
        self.persisted = true;
        Ok(())
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.persisted {
            // Drop 不能 await：用同步删除清掉半成品（文件通常已在磁盘上，开销可忽略）。
            let _ = std::fs::remove_file(&self.part);
        }
    }
}

/// 并行分片拉流（BUG-028）：把 `[boundary, boundary+take)`（`take=None` 时到 EOF）
/// 切成 K 个 chunk 对齐的连续分片，每个分片一个独立 `iter_download` worker 经有界
/// 通道回传；合并任务按分片顺序转发，并统一裁剪 `skip_lead` / `take`。
///
/// 为什么必须并行：grammers 的 `DownloadIter::next()` 一次只发一个 `upload.GetFile`
/// 请求，单流吞吐 = chunk/RTT（512KiB / ~1s ≈ 0.5MB/s），播放器一条流根本喂不饱，
/// 与缩略图等其他请求共享客户端时更是雪上加霜。K 路并行吞吐近似线性扩展
/// （实测 2 路并发总吞吐 ×2）；grammers 官方 `download_media` 落盘同样用 4 worker
/// （`files.rs::WORKER_COUNT`），此处对齐同一数值。
///
/// 取消语义：浏览器中断响应时输出端被 drop → 合并任务 send 失败退出 → worker
/// send 失败退出 → iter 析构，无任务残留。
fn parallel_range_stream(
    client: TgClient,
    media: Media,
    boundary: u64,
    skip_lead: u64,
    take: Option<u64>,
) -> Pin<Box<dyn Stream<Item = Result<Vec<u8>, io::Error>> + Send>> {
    use tokio::sync::mpsc;

    let chunk = RANGE_CHUNK as u64;
    // 分片长度：take 已知 → 均分为 chunk 对齐的 K 段；未知 → 固定段长，末段读到 EOF。
    let seg = match take {
        Some(t) => t.div_ceil(chunk).div_ceil(STREAM_WORKERS) * chunk,
        None => UNKNOWN_TOTAL_SEGMENT,
    };

    let (out_tx, out_rx) = mpsc::channel::<Result<Vec<u8>, io::Error>>(4);
    let mut rxs = Vec::with_capacity(STREAM_WORKERS as usize);

    for w in 0..STREAM_WORKERS {
        let seg_start = boundary + w * seg;
        // 每段上限：末段自然截到 take 边界；take 未知时只有最后一个 worker 不设限。
        let cap: u64 = match take {
            Some(t) => t.saturating_sub(w * seg).min(seg),
            None if w + 1 < STREAM_WORKERS => seg,
            None => u64::MAX,
        };
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, io::Error>>(2);
        rxs.push(rx);
        let client = client.clone();
        let media = media.clone();
        tokio::spawn(async move {
            // chunk_size 必须先于 skip_chunks（skip_chunks 按 limit 对齐偏移）。
            let mut iter = client.iter_download(&media).chunk_size(RANGE_CHUNK);
            if seg_start > 0 {
                iter = iter.skip_chunks((seg_start / chunk) as i32);
            }
            let mut remaining = cap;
            while remaining > 0 {
                match iter.next().await {
                    Ok(Some(bytes)) => {
                        let bytes = if bytes.len() as u64 > remaining {
                            bytes[..remaining as usize].to_vec()
                        } else {
                            bytes
                        };
                        let len = bytes.len();
                        remaining -= len as u64;
                        if tx.send(Ok(bytes)).await.is_err() {
                            return; // 下游取消，迭代器随 task 结束析构
                        }
                        // 短块 = EOF（grammers 语义），后续请求只会返回空。
                        if len < RANGE_CHUNK as usize {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(e) => {
                        let _ = tx
                            .send(Err(io::Error::new(
                                io::ErrorKind::Other,
                                format!("media worker: {e}"),
                            )))
                            .await;
                        return;
                    }
                }
            }
        });
    }

    // 合并任务：分片 0 的通道耗尽后接分片 1……输出严格有序；
    // 前端裁剪 skip_lead（chunk 对齐多余字节），总量裁剪 take。
    tokio::spawn(async move {
        let mut skip_lead = skip_lead;
        let mut take = take;
        'outer: for mut rx in rxs {
            while let Some(item) = rx.recv().await {
                match item {
                    Ok(mut bytes) => {
                        if skip_lead > 0 {
                            let d = (skip_lead as usize).min(bytes.len());
                            bytes.drain(..d);
                            skip_lead -= d as u64;
                        }
                        if bytes.is_empty() {
                            continue;
                        }
                        if let Some(t) = take {
                            if t == 0 {
                                break 'outer;
                            }
                            let n = (t as usize).min(bytes.len());
                            bytes.truncate(n);
                            take = Some(t - n as u64);
                        }
                        if out_tx.send(Ok(bytes)).await.is_err() {
                            break 'outer;
                        }
                    }
                    Err(e) => {
                        let _ = out_tx.send(Err(e)).await;
                        break 'outer;
                    }
                }
            }
        }
    });

    Box::pin(futures::stream::unfold(out_rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }))
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

/// 将消息附件分类为 (media_type, mime_type, size, file_name)。
///
/// 仅接受照片与文档（视频/音频/文件）；GeoLive/Sticker/Dice 等返回 `None`，
/// 由调用方决定跳过（媒体历史只展示照片/视频/可下载文档）。
fn classify_media(
    media: Option<Media>,
) -> Option<(
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<i64>,
)> {
    match media {
        Some(Media::Document(doc)) => {
            let mime = doc.mime_type().map(str::to_string);
            let media_type = match mime.as_deref() {
                Some(m) if m.starts_with("video/") => "video",
                Some(m) if m.starts_with("audio/") => "audio",
                Some(m) if m.starts_with("image/") => "photo",
                _ => "file",
            };
            // 时长：视频/音频文档属性携带（秒），用于区分预览片段与完整视频。
            // grammers 0.10 media::Document 已聚合 Video/Audio 属性时长。
            let duration = doc.duration().map(|d| d as i64);
            Some((
                media_type.to_string(),
                mime,
                doc.size().map(|s| s as i64),
                doc.name()
                    .map(str::to_string)
                    .filter(|s| !s.is_empty()),
                duration,
            ))
        }
        Some(Media::Photo(_)) => {
            Some(("photo".into(), Some("image/jpeg".into()), None, None, None))
        }
        _ => None,
    }
}

/// 读取可下载缩略图（Size/Progressive）的像素尺寸。
fn photo_size_dims(ps: &PhotoSize) -> Option<(i32, i32)> {
    match ps {
        PhotoSize::Size(s) => Some((s.width, s.height)),
        PhotoSize::Progressive(p) => Some((p.width, p.height)),
        _ => None,
    }
}

/// DialogFilter 内的裸 InputPeer 转 Bot API 对话 id（与 `PeerId::bot_api_dialog_id` 同空间）：
/// - 频道/超级群：`-1000000000000 - channel_id`（即 `-100` 前缀）
/// - 基本群：`-chat_id`
/// - 用户：`user_id`（正数）
/// - FromMessage 变体递归取内部 peer id
fn input_peer_bot_api_id(peer: &tl::enums::InputPeer) -> Option<i64> {
    use tl::enums::InputPeer;
    match peer {
        InputPeer::Channel(p) => Some(BOT_API_CHANNEL_MARK - p.channel_id),
        InputPeer::Chat(p) => Some(-p.chat_id),
        InputPeer::User(p) => Some(p.user_id),
        InputPeer::ChannelFromMessage(b) => Some(BOT_API_CHANNEL_MARK - b.channel_id),
        InputPeer::UserFromMessage(b) => Some(b.user_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orig_tg_part_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 未 `persist` 就被丢弃（拉流报错 / 请求中断 / 任务取消）→ 半成品必须被清理，
    /// 磁盘上不得留下「半截但看起来像已缓存」的文件。
    #[tokio::test]
    async fn part_file_discarded_on_drop() {
        let dir = tmp_dir("drop");
        let final_path = dir.join("video.mp4");
        {
            let mut f = PartFile::create(&dir, "video.mp4").await.unwrap();
            f.write_all(b"partial-bytes").await.unwrap();
            assert!(dir.join("video.mp4.part").exists(), "写入期间应落在 .part");
            assert!(!final_path.exists(), "写入期间不得出现最终文件");
        }
        assert!(
            !dir.join("video.mp4.part").exists(),
            "丢弃后半成品必须被清理"
        );
        assert!(!final_path.exists(), "失败不得留下最终文件");
    }

    /// `persist` → 改名为最终路径，无 `.part` 残留（原子可见性）。
    #[tokio::test]
    async fn part_file_persists_atomically() {
        let dir = tmp_dir("persist");
        let final_path = dir.join("clip.mp4");
        let mut f = PartFile::create(&dir, "clip.mp4").await.unwrap();
        f.write_all(b"abcdef").await.unwrap();
        f.persist(&final_path).await.unwrap();
        assert!(
            !dir.join("clip.mp4.part").exists(),
            "persist 后不得残留 .part"
        );
        assert_eq!(std::fs::read(&final_path).unwrap(), b"abcdef");
    }
}
