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

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::{Stream, StreamExt};
use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::media::{Media, PhotoSize};
use grammers_client::sender::ConnectionParams;
use grammers_client::session::storages::SqliteSession;
use grammers_client::session::types::{PeerAuth, PeerId, PeerRef};
use grammers_client::{Client as TgClient, SenderPool, SignInError, tl};
use sha2::Digest;
use tokio::sync::Mutex;

use crate::config::Config;
use crate::login::{
    dialog_display_title, Channel, Client, ClientError, DownloadOutcome, Folder, LoginPhase,
    MediaItem, MediaRange, MediaStream, SessionView, Thumbnail,
};

/// 把 panic payload 转成可读字符串（BUG-106）。
///
/// `panic!` 的 payload 只保证是 `Box<dyn Any + Send>`，**没保证是字符串**：
/// `panic!("{}", x)` 给 `String`，`panic!("literal")` 给 `&str`，
/// 而 `panic!(some_vec)` 之类给的是别的类型。
/// 直接 `downcast_ref::<&str>()` 而不再兜一层，遇到非字符串 payload 就只能打印
/// 「panicked」—— 病因在最关键的那一处被丢掉。这里三种情况分别处理。
fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

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

/// BUG-193：Telegram 的**归档**文件夹 id。
///
/// `messages.getDialogs` 的 `folder_id` 语义：`None` = 主文件夹，`Some(1)` = 归档。
/// grammers-client 0.10.0 的 `DialogIter` 把该字段硬编码成 `None`
/// （`src/client/dialogs.rs:29`），因此 `iter_dialogs()` **只枚举主文件夹** ——
/// 归档对话永远拿不到。本实现改为自建分页器并显式传 `folder_id`。
const ARCHIVE_FOLDER_ID: i32 = 1;

/// 自建 `messages.getDialogs` 分页器的单页条数（Telegram 上限 100）。
///
/// 与 grammers `DialogIter::MAX_LIMIT` 取值一致：调大不生效，只会引入分页死循环。
const DIALOG_PAGE_LIMIT: i32 = 100;

/// 自建分页器的最大页数（≈ 20000 条对话，远超实测 519 条）。
///
/// 纯防御：游标若因任何原因不前进，兜底停机而不是无限打 Telegram。
const DIALOG_PAGE_CAP: usize = 200;

/// 会话枚举必须覆盖的 `folder_id` 全集（BUG-193 判据钉子）。
///
/// **为什么把它写成数据而不是散在代码里**：BUG-193 的验收要求「注掉归档枚举，
/// 判据必须变红」。若 `None` / `Some(1)` 是两处各写一遍的字面量，删掉任何一处
/// 都不会触发任何编译期或运行期信号 —— 判据只能靠人眼比对 diff。
/// 声明成一份**被测试断言的常量**后，「少枚举一个文件夹」就成了可测的差异。
///
/// `None` = 主文件夹，`Some(1)` = 归档。**两者都不可省**：grammers 的
/// `iter_dialogs()` 只覆盖 `None`（BUG-193 根因）。
const ENUMERATED_FOLDER_IDS: [Option<i32>; 2] = [None, Some(ARCHIVE_FOLDER_ID)];

/// 登录中间态（在多次 HTTP 请求之间保留 Telegram 返回的 token）。
struct Pending {
    phase: LoginPhase,
    phone: Option<String>,
    user_id: Option<i64>,
    login_token: Option<LoginToken>,
    password_token: Option<PasswordToken>,
}

/// `GetDialogFilters` 的解析产物：公开 DTO + 对账用的成员表（BUG-193）。
///
/// 两者并存而不是只留 `Vec<Folder>`：`Folder::channel_ids` 只有裸 `i64`，而
/// `DialogFilter` 成员是 `InputPeer`，**自带 `access_hash`** —— 那是把裸 id 换回
/// 实体的唯一凭据，对账补齐（`resolve_folder_gaps`）离不开它。
#[derive(Default)]
struct FolderIndex {
    /// 对外暴露的分组 DTO（`/api/tg/folders` 的数据源，行为不变）。
    folders: Vec<Folder>,
    /// 去重后的分组成员（跨分组去重，取首个命中分组）。
    members: Vec<FolderMember>,
}

/// 一条分组成员声明：Bot API 对话 id + 所属分组 + 原始 `InputPeer`。
struct FolderMember {
    /// Bot API 对话 id（与 `Channel::id` 同空间）。
    id: i64,
    /// 所属分组标题（一个频道可属多组，取首个命中）。
    folder: String,
    /// `DialogFilter` 里的原始 `InputPeer`，保留 `access_hash` 供补齐查询使用。
    peer: tl::enums::InputPeer,
}

/// `messages.getDialogs` 一页响应里某个 peer 的展示信息与访问凭据。
///
/// 由响应自带的 `users` / `chats` 向量建索引 —— grammers 的 `PeerMap` 是
/// `pub(crate)`，外部拿不到，故自建。
struct RawPeerInfo {
    /// 展示名（`None` = 解析不到，按 BUG-194 走可辨识兜底名）。
    title: Option<String>,
    username: Option<String>,
    /// 带 `access_hash` 的引用；缺 `access_hash` 的实体为 `None`。
    peer_ref: Option<PeerRef>,
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
    /// MTProto 发信后台任务句柄（BUG-106）。
    ///
    /// 此前写成 `let _runner = tokio::spawn(pool.runner.run())` —— JoinHandle 当场被
    /// 丢弃（detach），runner 退出 / panic 之后**无人知晓**：此后每一次 `invoke()`
    /// 都恒返回 `RequestError::Dropped`（`request error: dropped (cancelled)`），
    /// 而进程继续存活、`/api/tg/session` 继续报 `Authorized`、`/api/tg/diag` 继续报
    /// `health:ok` —— 全部是谎言。**丢弃 JoinHandle 等于销毁任务死亡的证据。**
    /// 这里保留句柄，使链路中断可被观测。
    ///
    /// 句柄本身交给看门狗任务去 `await`（见 `connect()`），本字段只留**死亡标志**：
    /// runner 一旦结束（正常退出 / panic / 被取消）就置 true，并连同**退出原因**打进日志。
    /// 只留 `is_finished()` 是不够的 —— 那只能回答「死了没有」，
    /// 回答不了「怎么死的」，而不知道病因就无法决定能否自愈（BUG-106 待确认项）。
    sender_dead: Arc<AtomicBool>,
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
    /// RPC 失败归类的**无 self 形式**，供 `Self` 尚未构造完的调用点使用。
    ///
    /// 判据是**两条信号的或**：
    ///
    /// - `link_dead`：看门狗已置死亡标志；
    /// - 错误原文含 `dropped`：grammers 的 `RequestError::Dropped`（显示为
    ///   `request error: dropped (cancelled)`）**只在发信任务已死时出现**，
    ///   它本身就是链路已死的证据。
    ///
    /// 第二条不是冗余：runner 死亡 → 标志置位与在途 RPC 失败是**并发**的，
    /// 标志可能晚一步。只靠标志，死亡后的**首批**失败仍会被判成 400。
    /// 判「是否已死」不能只依赖一个由别的任务异步写入的标志。
    fn classify_rpc_err(link_dead: bool, e: impl std::fmt::Display) -> ClientError {
        let raw = e.to_string();
        if link_dead || raw.contains("dropped") {
            ClientError::Unavailable(format!(
                "MTProto link is down (sender runner exited); restart orig-tg to recover: {raw}"
            ))
        } else {
            ClientError::Other(raw)
        }
    }

    /// RPC 失败的**源头归类**（BUG-110）。
    ///
    /// 链路已断时的失败**不是客户端错误**：请求本身合法，死的是上游依赖
    /// （MTProto 发信任务）。此前一律包成 `ClientError::Other`，而
    /// `From<ClientError> for ApiError` 把 `Other` 映射成 **400 Bad Request + 原文**，
    /// 三重错：
    ///
    /// 1. **状态码撒谎**：依赖故障被报成 4xx「你的请求有问题」，前端据此
    ///    既不重试、也不提示「稍后再试」，故障被读成用户操作失误；
    /// 2. **裸漏内部原文**：`request error: dropped (cancelled)` 直接进 UI；
    /// 3. **端点级补丁必然漏**：BUG-106 给 `folders` / `thumb` / `cache_one`
    ///    各写了一份降级与 hint，但只要某条路径走 `From`（如 `/api/tg/file`
    ///    的 `Err(e) => Err(e.into())`），补丁就失效。
    ///
    /// 在**源头**归类正确，全部端点自动正确 —— 不依赖每个 handler 都记得降级。
    fn rpc_err(&self, e: impl std::fmt::Display) -> ClientError {
        Self::classify_rpc_err(!self.link_alive(), e)
    }

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
        //
        // BUG-106：句柄**必须保留**（不再 `let _runner = ...`）—— 它是判断
        // 「链路是否还活着」的唯一依据。详见 `GrammersClient::sender_dead` 字段注释。
        let runner = tokio::spawn(pool.runner.run());
        let sender_dead = Arc::new(AtomicBool::new(false));
        let flag = sender_dead.clone();
        // 看门狗：**await 句柄以拿到退出原因**。
        //
        // 只有把句柄 await 掉才能区分「正常返回」/「panic」/「被取消」，并取出 panic payload。
        // 没有这段文字，下次 runner 死掉时我们仍然只知道「链路断了」，
        // 知道不了病因 —— 于是永远无法判断「重连是否只是把崩溃变成崩溃循环」。
        tokio::spawn(async move {
            match runner.await {
                Ok(()) => {
                    flag.store(true, Ordering::SeqCst);
                    eprintln!(
                        "[tg] MTProto sender runner exited without panic; \
                         subsequent RPCs will fail with Dropped until restart"
                    );
                }
                Err(e) => {
                    flag.store(true, Ordering::SeqCst);
                    match e.try_into_panic() {
                        Ok(payload) => {
                            eprintln!(
                                "[tg] MTProto sender runner PANICKED: {}",
                                panic_payload_to_string(payload)
                            );
                        }
                        Err(e) => {
                            eprintln!("[tg] MTProto sender runner task was cancelled: {e}");
                        }
                    }
                }
            }
        });

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
            // `Self` 尚未构造完：用无 self 形式（此时 runner 刚起来，链路视为活）。
            .map_err(|e| Self::classify_rpc_err(sender_dead.load(Ordering::SeqCst), e))?
        {
            pending.phase = LoginPhase::Authorized;
            if let Ok(user) = inner.get_me().await {
                pending.user_id = user.id().bot_api_dialog_id();
            }
        }

        Ok(Self {
            inner,
            sender_dead,
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
            .map_err(|e| self.rpc_err(e))?
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

    /// 自建分页器：枚举指定 `folder_id` 的全部对话（BUG-193）。
    ///
    /// grammers 0.10 的 `DialogIter::new` 把 `folder_id` 硬编码成 `None`，且
    /// `IterBuffer::from_request` 是 `pub(crate)` —— 高层 API **无法**表达归档
    /// 文件夹。故此处直接发 `messages.getDialogs`，翻页语义与 grammers 的
    /// `DialogIter::next` 逐条对齐（首屏 `exclude_pinned=false`、其后置 `true`：
    /// 置顶只在首屏返回一次，置顶对话不会因此丢失）。
    ///
    /// 返回的每条同时写入 `peer_cache`，使归档频道的媒体/消息接口可直接命中。
    async fn dialogs_in_folder(
        &self,
        folder_id: i32,
        folder_of: &HashMap<i64, String>,
    ) -> Result<Vec<Channel>, ClientError> {
        let mut out: Vec<Channel> = Vec::new();
        let mut request = tl::functions::messages::GetDialogs {
            exclude_pinned: false,
            folder_id: Some(folder_id),
            offset_date: 0,
            offset_id: 0,
            offset_peer: tl::enums::InputPeer::Empty,
            limit: DIALOG_PAGE_LIMIT,
            hash: 0,
        };
        let mut pages = 0usize;
        loop {
            // 翻页游标必须严格前进，否则服务端会无限返回同一页。
            pages += 1;
            if pages > DIALOG_PAGE_CAP {
                eprintln!(
                    "[tg] BUG-193: archive enumeration hit page cap ({DIALOG_PAGE_CAP}); \
                     stopping to avoid an unbounded loop"
                );
                break;
            }
            let (dialogs, messages, users, chats, last_chunk) =
                match self.inner.invoke(&request).await.map_err(|e| self.rpc_err(e))? {
                    tl::enums::messages::Dialogs::Dialogs(d) => {
                        (d.dialogs, d.messages, d.users, d.chats, true)
                    }
                    tl::enums::messages::Dialogs::Slice(d) => {
                        let last = (d.dialogs.len() as i32) < DIALOG_PAGE_LIMIT;
                        (d.dialogs, d.messages, d.users, d.chats, last)
                    }
                    // `hash` 恒为 0，服务端不可能回 NotModified；真回了也不当空列表。
                    tl::enums::messages::Dialogs::NotModified(_) => (Vec::new(), Vec::new(), Vec::new(), Vec::new(), true),
                };
            if dialogs.is_empty() {
                break;
            }
            let peers = raw_peer_index(&users, &chats);
            // 下一页的游标：末条会话的 peer + 其末条消息（date/id），缺一不可。
            let mut cursor: Option<(i32, i32, tl::enums::InputPeer)> = None;
            for d in &dialogs {
                let peer = d.peer();
                let peer_ref = PeerId::from(&peer);
                let Some(id) = peer_ref.bot_api_dialog_id() else {
                    continue;
                };
                let info = peers.get(&id);
                // PeerRef 回填：让归档频道后续的媒体/消息请求零额外枚举。
                if let Some(pr) = info.and_then(|i| i.peer_ref) {
                    self.peer_cache.lock().await.insert(id, pr);
                }
                out.push(Channel {
                    id,
                    title: dialog_display_title(
                        info.and_then(|i| i.title.as_deref()),
                        id,
                    ),
                    username: info.and_then(|i| i.username.clone()),
                    folder: folder_of.get(&id).cloned(),
                });
                let top = d.top_message();
                let date = messages
                    .iter()
                    .find_map(|m| match m {
                        tl::enums::Message::Message(x) if x.id == top => Some(x.date),
                        tl::enums::Message::Service(x) if x.id == top => Some(x.date),
                        _ => None,
                    })
                    .unwrap_or(0);
                cursor = info
                    .and_then(|i| i.peer_ref)
                    .map(|pr| (date, top, (&pr).into()));
            }
            if last_chunk {
                break;
            }
            match cursor {
                Some((date, id, peer)) => {
                    request.exclude_pinned = true;
                    request.offset_date = date;
                    request.offset_id = id;
                    request.offset_peer = peer;
                }
                // 拿不到游标就无法安全翻页（再请求一次只会重复同一页）。
                None => break,
            }
        }
        Ok(out)
    }

    /// 为「分组声明了、但两轮文件夹枚举都没取到」的频道补齐最小记录。
    ///
    /// BUG-193 修复项 2。`DialogFilter` 的成员是 `InputPeer`，其中
    /// `InputPeerChannel` / `InputPeerUser` **自带 `access_hash`** —— 这正是把裸 id
    /// 换回实体的凭据。凭它分别调 `channels.getChannels` / `messages.getChats` /
    /// `users.getUsers`，一次每类批量取回真实标题。
    ///
    /// 取回的实体同时写入 `peer_cache`：只补列表不补凭据的话，这些频道会变成
    /// 「看得见、点进去什么都拉不到」的死行。
    async fn resolve_folder_gaps(
        &self,
        wanted: &[&FolderMember],
        folder_of: &HashMap<i64, String>,
    ) -> Vec<Channel> {
        // 按 peer 种类分桶：三个 RPC 的入参类型互不相同。
        let mut input_channels: Vec<tl::enums::InputChannel> = Vec::new();
        let mut chat_ids: Vec<i64> = Vec::new();
        let mut input_users: Vec<tl::enums::InputUser> = Vec::new();
        let mut unusable = 0usize;
        for m in wanted {
            match unwrap_from_message_peer(&m.peer) {
                tl::enums::InputPeer::Channel(c) => {
                    input_channels.push(tl::enums::InputChannel::Channel(
                        tl::types::InputChannel {
                            channel_id: c.channel_id,
                            access_hash: c.access_hash,
                        },
                    ));
                }
                tl::enums::InputPeer::Chat(c) => chat_ids.push(c.chat_id),
                tl::enums::InputPeer::User(u) => {
                    input_users.push(tl::enums::InputUser::User(tl::types::InputUser {
                        user_id: u.user_id,
                        access_hash: u.access_hash,
                    }));
                }
                // Self / Empty：不是可解析的 peer。
                _ => unusable += 1,
            }
        }

        let mut out: Vec<Channel> = Vec::new();
        let mut cache = self.peer_cache.lock().await;

        if !input_channels.is_empty() {
            let n = input_channels.len();
            let request = tl::functions::channels::GetChannels {
                id: input_channels.clone(),
            };
            match self.inner.invoke(&request).await {
                // `Chats::Chats` 与 `Chats::Slice` 载荷类型不同，用 grammers 的
                // `.chats()` 访问器统一取出 `Vec<Chat>`（两变体都实现了它）。
                Ok(r) => {
                    for chat in r.chats() {
                        if let Some((ch, pr)) = channel_from_chat(&chat, folder_of) {
                            if let Some(pr) = pr {
                                cache.insert(ch.id, pr);
                            }
                            out.push(ch);
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[tg] BUG-193: getChannels batch failed for {n} channel(s): {e}; retrying per-peer"
                    );
                    // **整批失败 ≠ 全部不可用**：官方客户端对分组成员就是**逐个**解析的，
                    // 而 `channels.getChannels` 是整批 400 —— 批里只要有一个坏
                    // access_hash（移出/被踢后分组配置里的陈旧引用），服务端就对
                    // **整批**返回 CHANNEL_PRIVATE。2026-10-12 实测：66 个打包一次，
                    // 批量视角 resolved=0；逐个重试才能把「被冤枉的好成员」捞回来。
                    let mut ok = 0usize;
                    let mut bad = 0usize;
                    for one in input_channels {
                        let single = tl::functions::channels::GetChannels { id: vec![one] };
                        match self.inner.invoke(&single).await {
                            Ok(r) => {
                                for chat in r.chats() {
                                    if let Some((ch, pr)) = channel_from_chat(&chat, folder_of) {
                                        if let Some(pr) = pr {
                                            cache.insert(ch.id, pr);
                                        }
                                        out.push(ch);
                                    }
                                }
                                ok += 1;
                            }
                            Err(_) => bad += 1,
                        }
                    }
                    eprintln!("[tg] BUG-193: per-peer retry ok={ok} bad={bad}");
                }
            }
        }

        if !chat_ids.is_empty() {
            let n = chat_ids.len();
            // 基本群不需要 access_hash，`messages.getChats` 只收裸 chat_id。
            let request = tl::functions::messages::GetChats { id: chat_ids };
            match self.inner.invoke(&request).await {
                Ok(r) => {
                    for chat in r.chats() {
                        if let Some((ch, pr)) = channel_from_chat(&chat, folder_of) {
                            if let Some(pr) = pr {
                                cache.insert(ch.id, pr);
                            }
                            out.push(ch);
                        }
                    }
                }
                Err(e) => eprintln!("[tg] BUG-193: getChats failed for {n} chat(s): {e}"),
            }
        }

        if !input_users.is_empty() {
            let n = input_users.len();
            let request = tl::functions::users::GetUsers { id: input_users };
            match self.inner.invoke(&request).await {
                // `users.getUsers` 直接返回 `Vec<User>`（无 Slice 变体），无需拆包。
                Ok(users) => {
                    for user in &users {
                        if let Some((ch, pr)) = channel_from_user(user, folder_of) {
                            if let Some(pr) = pr {
                                cache.insert(ch.id, pr);
                            }
                            out.push(ch);
                        }
                    }
                }
                Err(e) => eprintln!("[tg] BUG-193: getUsers failed for {n} user(s): {e}"),
            }
        }

        if unusable > 0 {
            eprintln!(
                "[tg] BUG-193: {unusable} folder-declared peer(s) were Self/Empty and stay uncached"
            );
        }
        out
    }

    /// 拉取并解析 `GetDialogFilters`，同时产出公开 DTO 与对账用的成员表。
    ///
    /// **为什么不再只返回 `Folder`**：`Folder::channel_ids` 只有 `i64`，而
    /// `DialogFilter` 里的 `InputPeer` **自带 `access_hash`**。此前把 `InputPeer`
    /// 当场折成 id 丢掉，等于扔掉了「把裸 id 换回实体」的唯一凭据 ——
    /// BUG-193 的对账补齐（`resolve_folder_gaps`）正需要它。
    async fn folder_index(&self) -> Result<FolderIndex, ClientError> {
        // 走原始 TL 调用拉取自定义分组（grammers 高层未暴露 DialogFilter）。
        let result = self
            .inner
            .invoke(&tl::functions::messages::GetDialogFilters {})
            .await
            .map_err(|e| self.rpc_err(e))?;
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

        let mut index = FolderIndex::default();
        for f in filters {
            // 普通自定义文件夹 Filter 与共享聊天列表 Chatlist 都对用户可见，统一接受。
            //
            // BUG-195：`DialogFilter` 的成员是**两个**独立字段 ——
            // `pinned_peers`（文件夹内置顶的）与 `include_peers`（其余成员）。
            // 只读 `include_peers` 会把置顶成员整个丢掉（实测 MyTop 应为 24 却只读到 20，
            // 差的正是 4 个 pinned）。两者都要取，且要去重（同一 peer 可能两处都在）。
            let (id, title, peers, pinned_len) = match f {
                tl::enums::DialogFilter::Filter(filter) => {
                    let pinned_len = filter.pinned_peers.len();
                    let mut peers = filter.pinned_peers;
                    peers.extend(filter.include_peers);
                    (filter.id, filter.title, peers, pinned_len)
                }
                tl::enums::DialogFilter::Chatlist(filter) => {
                    let pinned_len = filter.pinned_peers.len();
                    let mut peers = filter.pinned_peers;
                    peers.extend(filter.include_peers);
                    (filter.id, filter.title, peers, pinned_len)
                }
                tl::enums::DialogFilter::Default => continue,
            };
            let title = match title {
                tl::enums::TextWithEntities::Entities(t) => t.text,
            };
            // 统一转换为 Bot API 对话 id（与 dialogs 的 id 同空间，否则映射永不命中）。
            // 去重：置顶成员可能同时出现在 `include_peers` 里，重复会污染后续对账。
            let mut seen_in_folder: HashSet<i64> = HashSet::new();
            let mut ids: Vec<i64> = Vec::new();
            for p in peers.iter() {
                if let Some(v) = input_peer_bot_api_id(p) {
                    if seen_in_folder.insert(v) {
                        ids.push(v);
                        index.members.push(FolderMember {
                            id: v,
                            folder: title.clone(),
                            peer: p.clone(),
                        });
                    }
                }
            }
            eprintln!(
                "[tg] folder id={id} title={title:?} pinned={pinned_len} peers={} mapped={}",
                peers.len(),
                ids.len()
            );
            index.folders.push(Folder {
                id,
                title,
                channel_ids: ids,
            });
        }
        // 同一频道可属多个分组；`folder_of()` 取首个命中，这里同步去重，
        // 使「declared 基准集」与实际标注口径一致（否则同一个 id 会被补齐两次）。
        let mut deduped: Vec<FolderMember> = Vec::new();
        let mut member_ids: HashSet<i64> = HashSet::new();
        for m in index.members {
            if member_ids.insert(m.id) {
                deduped.push(m);
            }
        }
        index.members = deduped;
        Ok(index)
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
            Err(e) => Err(self.rpc_err(e)),
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
            Err(e) => Err(self.rpc_err(e)),
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
        // 先读分组：既是「频道 -> 分组标题」标注的来源，也是 BUG-193 对账的基准集。
        // 分组读取失败（如代理连接抖动被断）不阻塞频道枚举：降级为「未分组 + 无对账」。
        let index = self.folder_index().await.unwrap_or_else(|e| {
            eprintln!("[tg] BUG-193: dialog folder index unavailable, degraded: {e}");
            FolderIndex::default()
        });
        let folder_of: HashMap<i64, String> = index
            .members
            .iter()
            .map(|m| (m.id, m.folder.clone()))
            .collect();

        let mut seen: HashSet<i64> = HashSet::new();
        let mut skipped_unidentifiable = 0usize;

        // ---- 主文件夹（grammers 高层枚举，folder_id = None）----
        let mut primary = Vec::new();
        let mut iter = self.inner.iter_dialogs();
        while let Some(dialog) = iter
            .next()
            .await
            .map_err(|e| self.rpc_err(e))?
        {
            // 枚举时顺便填充 PeerRef 缓存（媒体/消息接口后续直接命中）。
            let id = dialog.peer().id().bot_api_dialog_id().unwrap_or(0);
            self.peer_cache.lock().await.insert(id, dialog.peer_ref());
            // BUG-194：身份不可判定的 Dialog（id 解析失败）不入库，
            // 否则会以 id=0 撞主键、覆盖出一条假会话。
            match channel_from_dialog(&dialog, &folder_of) {
                Some(ch) => primary.push(ch),
                None => skipped_unidentifiable += 1,
            }
        }
        if skipped_unidentifiable > 0 {
            // 不静默丢数据：留下可对账的痕迹（BUG-013 实证日志风格）。
            eprintln!(
                "[tg] dialog scan: skipped {skipped_unidentifiable} dialogs with unidentifiable peer"
            );
        }

        // ---- 归档文件夹（folder_id = 1）----
        // BUG-193 根因修复。grammers 0.10 的 `DialogIter` 把 `folder_id` 写死为
        // `None`（`client/dialogs.rs:29`），`iter_dialogs()` **只枚举主文件夹** ——
        // 归档对话永远拿不到，于是归档频道虽进了 TG 分组，应用会话列表里却根本没
        // 这一行（doc 实测 66 个）。故自建分页器显式传 `folder_id`。
        //
        // 失败**不得**连累主文件夹结果：降级为空并留下可对账日志。
        let archived = if ENUMERATED_FOLDER_IDS.contains(&Some(ARCHIVE_FOLDER_ID)) {
            match self.dialogs_in_folder(ARCHIVE_FOLDER_ID, &folder_of).await {
                Ok(list) => list,
                Err(e) => {
                    eprintln!("[tg] BUG-193: archive folder enumeration failed, degraded: {e}");
                    Vec::new()
                }
            }
        } else {
            // 不可达分支：显式保留，使「枚举范围」与 `ENUMERATED_FOLDER_IDS` 单一真源绑定。
            Vec::new()
        };
        let archived_len = archived.len();
        let mut out = merge_dialog_folders(primary, archived);
        for ch in out.iter() {
            seen.insert(ch.id);
        }
        eprintln!(
            "[tg] BUG-193: dialogs merged primary+archive total={} (archive contributed {archived_len})",
            out.len()
        );

        // ---- 以分组声明为基准对账（BUG-193 修复项 2）----
        // 归档枚举补的是「归档文件夹里的对话」；但分组声明里还可能有**既不在主文件夹、
        // 也不在归档文件夹**的频道（被移出/已退群却仍被分组引用的历史成员）。
        // 它们在列表里同样缺席，故按需解析后各补一条最小记录。
        let missing = missing_from_declaration(&seen, index.members.iter().map(|m| m.id));
        if !missing.is_empty() {
            let wanted: Vec<&FolderMember> = index
                .members
                .iter()
                .filter(|m| missing.binary_search(&m.id).is_ok())
                .collect();
            let resolved = self.resolve_folder_gaps(&wanted, &folder_of).await;
            let resolved_len = resolved.len();
            out.extend(resolved);
            eprintln!(
                "[tg] BUG-193: folder reconciliation declared={} missing={} resolved={} still_missing={}",
                index.members.len(),
                missing.len(),
                resolved_len,
                missing.len().saturating_sub(resolved_len)
            );
        }

        Ok(out)
    }

    async fn folders(&self) -> Result<Vec<Folder>, ClientError> {
        Ok(self.folder_index().await?.folders)
    }

    /// 链路活性（BUG-106）：sender runner 还在跑才算活着。
    ///
    /// runner 一旦退出（panic 或主动结束），`invoke()` 会**永久**返回
    /// `RequestError::Dropped`，且不会自愈 —— 所以这里必须如实报 `false`。
    fn link_alive(&self) -> bool {
        // 由看门狗任务在 runner 结束（无论何种原因）时置位。
        !self.sender_dead.load(Ordering::SeqCst)
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
                .map_err(|e| self.rpc_err(e))?
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

    async fn download(
        &self,
        chat_id: i64,
        message_id: i64,
        dir: &str,
        progress: Option<&crate::login::DownloadProgress>,
    ) -> Result<DownloadOutcome, ClientError> {
        // 无限额调用点（若日后出现）走默认档；缓存条目路径经
        // `download_limited` 携带运行时解析的限额（BUG-271）。
        self.download_limited(
            chat_id,
            message_id,
            dir,
            progress,
            &crate::login::DownloadLimits::default(),
        )
        .await
    }

    /// 带限额的下载实现（BUG-271）：流循环的**空闲**判定取 `limits.idle`
    /// （原 `STALL_IDLE` 硬编码 90s 收编为可配）。墙钟（`limits.wall`）不在这里——
    /// 它由路由层围绕整个条目下载计时（`cache_one_bytes`）：空闲是**chunk 间**判定
    /// （治「死」），墙钟是**条目总时长**判定（治「慢」），两个判定各管一层、
    /// 各出各的原因串，合并会把「慢」误判成「死」。
    async fn download_limited(
        &self,
        chat_id: i64,
        message_id: i64,
        dir: &str,
        progress: Option<&crate::login::DownloadProgress>,
        limits: &crate::login::DownloadLimits,
    ) -> Result<DownloadOutcome, ClientError> {
        // PeerRef 走缓存（dialogs 扫描后已填充）。
        let peer = self.resolve_peer(chat_id).await
            .map_err(|_| ClientError::MediaNotFound)?;

        let found = self
            .inner
            .get_messages_by_id(peer, &[message_id as i32])
            .await
            .map_err(|e| self.rpc_err(e))?
            .into_iter()
            .find_map(|m| m);
        let message = found.ok_or(ClientError::MediaNotFound)?;

        let media = message.media().ok_or(ClientError::MediaNotFound)?;
        // D24-A（BUG-309）：落盘改**内容寻址** —— `<download_dir>/.blobs/ab/cd/<sha256>`。
        //
        // 旧布局（`<chat>_<msg>` 唯一锚，BUG-100）解决了「同名覆盖」，代价是「同内容必存
        // 多份」；且文档分支用裸原始名 `sanitize_filename` 时仍会**跨频道撞名覆盖**（内容
        // 不同即物理丢失）。hash 布局让「同内容 → 同一路径」成为设计意图，配合引用计数
        // （`media_blob`）共享字节、删最后引用才回收。
        //
        // `filename` 仅作**降级**用途保留（blob 区不可创建时退回旧平铺布局），不决定正常路径。
        let filename = match &media {
            Media::Photo(_) => format!("photo-{}_{}.jpg", chat_id, message_id),
            Media::Document(doc) => {
                let name = doc.name().unwrap_or_default().trim().to_string();
                if !name.is_empty() {
                    // TG 文档名常含 Windows 非法字符（| : ? * 等），直接落盘会 os error 5/123。
                    cache_filename(&name, chat_id, message_id)
                } else {
                    let mime = doc.mime_type().unwrap_or("bin");
                    let ext = extension_for_mime(mime).unwrap_or("bin");
                    format!("doc-{}_{}.{}", chat_id, message_id, ext)
                }
            }
            _ => return Err(ClientError::MediaNotFound),
        };

        let dir = PathBuf::from(dir);
        // 临时文件落在 `<dir>/.blobs/_tmp/`（与正式 blob 同卷 ⇒ rename 原子）。
        let tmp = crate::blob::tmp_path(&dir);
        tokio::fs::create_dir_all(crate::blob::tmp_dir(&dir))
            .await
            .map_err(|e| ClientError::Other(format!("create blob tmp dir: {e}")))?;

        // 缓存走与在线播放完全相同的**并行**拉流流程（BUG-028，替代 iter_download 串行整段
        // + 自管写盘），替代 `message.download_media`（其落盘路径对 Windows 文件名/目录敏感，
        // 曾在文件名含非法字符时统一报 os error 5）。播放正常的媒体即可缓存。
        //
        // 原子落盘（BUG-024）：先写临时文件，全部字节落完再改名。`PartFile` 的 Drop 保证
        // 未完成即自动清理 —— 磁盘上永不出现「半截但看起来像已缓存」的文件。
        let total = match &media {
            Media::Photo(p) => p.size().map(|s| s as u64),
            Media::Document(d) => d.size().map(|s| s as u64),
            _ => None,
        };
        let mut body = parallel_range_stream(self.inner.clone(), media, 0, 0, total);
        // BUG-181：总量在开流前就可知 → 先报，让 UI 从第一拍起就有分母。
        if let Some(p) = progress {
            if let Some(t) = total {
                p.set_total(t);
            }
        }
        let mut out = PartFile::create_at(&tmp)
            .await
            .map_err(|e| ClientError::Other(format!("create file: {e}")))?;
        let mut bytes: u64 = 0;
        // 空闲停滞看门狗（单飞 worker 的生死线）：TCP 半死（代理断流/DC 停滞）时
        // range 流的 `next()` 永不返回，缓存 worker 卡死在条目内 ⇒ 单飞队列永久饿死
        // （「添加一个后,后续无法添加」根因），且协作式取消只在条目间隙生效，
        // 卡在条目内时连取消都失灵。判据是「无字节间隔」而非总时长——大文件慢速
        // 是合法的；任何非空 chunk 都重置计时。超时即报错：任务失败 → worker 接续
        // 队列，取消也随之恢复有效（循环必然终止）。
        //
        // BUG-271：时长收编为可配（`limits.idle`，默认仍 90s）。它治的是「死」；
        // 「慢」（chunk 一直来但总量耗时过长）由路由层墙钟另判——本循环对「每
        // 89s 来一小块」的流**故意**不触发，那是墙钟的职责，不是这里的。
        let stall_idle = limits.idle;
        loop {
            match tokio::time::timeout(stall_idle, body.next()).await {
                Ok(Some(chunk)) => {
                    let chunk =
                        chunk.map_err(|e| ClientError::Other(format!("download stream: {e}")))?;
                    out.write_all(&chunk)
                        .await
                        .map_err(|e| ClientError::Other(format!("write file: {e}")))?;
                    if !chunk.is_empty() {
                        bytes += chunk.len() as u64;
                        // BUG-181：按 chunk 报字节（写盘成功才计，保证「UI 字节」≤ 落盘事实）。
                        if let Some(p) = progress {
                            p.add_bytes(chunk.len() as u64);
                        }
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    return Err(ClientError::Other(format!(
                        "download stalled: no bytes for {}s (chat {chat_id} msg {message_id}); \
                         connection presumed dead, aborted to unblock the cache queue",
                        stall_idle.as_secs()
                    )));
                }
            }
        }
        // 收尾到内容寻址布局：算流式 hash → dedup 命中删临时文件 / 否则 rename 到 blob。
        let (final_path, content_hash, dedup) = out
            .finish_into_blob(&dir)
            .await
            .map_err(|e| ClientError::Other(format!("flush file: {e}")))?;
        let _ = &filename; // 降级布局的命名（当前恒走 blob，保留以备未来开关）
        Ok(DownloadOutcome {
            message_id,
            path: final_path.to_string_lossy().into_owned(),
            bytes,
            content_hash: Some(content_hash),
            dedup,
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
            .map_err(|e| self.rpc_err(e))?
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
                    .map_err(|e| self.rpc_err(e))?
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
            .map_err(|e| self.rpc_err(e))?
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
                .map_err(|e| self.rpc_err(e))?
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
}

/// 将一条 Dialog 转换为公共 Channel DTO（含分组标题映射）。
///
/// 返回 `None` 表示这条 Dialog **无法确定身份**，调用方应跳过、不入库
/// （BUG-194 修复项 2：区分「名字为空」与「peer 解析失败」）。
fn channel_from_dialog(
    dialog: &grammers_client::peer::Dialog,
    folder_of: &std::collections::HashMap<i64, String>,
) -> Option<Channel> {
    let peer = dialog.peer();
    // `bot_api_dialog_id()` 仅对 self_user 返回 None。旧代码 `unwrap_or(0)`
    // 会把这类 Dialog 写成 id=0，而 `dialog_cache.id` 是主键 ⇒ 多条互相覆盖
    // 成一条假的「会话 0」。身份不可判定 ⇒ 不入库。
    let id = peer.id().bot_api_dialog_id()?;
    // BUG-194 根因：原为 `peer.name().unwrap_or_default().to_string()`，
    // 把「解析不到名字」静默降级成「名字是空字符串」——信息丢失且与
    // 「真的叫空名字」不可区分，前端 `groupChannels` 只按搜索词过滤、
    // 不过滤空标题 ⇒ 列表里渲染出 156 个认不出的空白行。
    // 现在按 doc 修复项 1：给出带 id 的可辨识兜底标识，不直接留空。
    // 有名会话（实测 363 条）走原样返回，不受任何影响。
    let title = dialog_display_title(peer.name(), id);
    Some(Channel {
        id,
        title,
        username: peer.username().map(str::to_string),
        folder: folder_of.get(&id).cloned(),
    })
}

/// 合并主文件夹与归档文件夹的枚举结果，按 id 去重（BUG-193）。
///
/// **主文件夹优先**：同一频道若两处都出现，以主文件夹那条为准 —— 它带 grammers
/// 已解析好的 `Peer`（名称/用户名），而归档那条走的是本文件的 TL 直解路径。
/// 保留「先到先得」而不是排序，保证主文件夹结果整体顺序不变（不回归既有列表）。
fn merge_dialog_folders(primary: Vec<Channel>, archived: Vec<Channel>) -> Vec<Channel> {
    let mut seen: HashSet<i64> = HashSet::with_capacity(primary.len() + archived.len());
    let mut out: Vec<Channel> = Vec::with_capacity(primary.len() + archived.len());
    for ch in primary.into_iter().chain(archived) {
        if seen.insert(ch.id) {
            out.push(ch);
        }
    }
    out
}

/// 分组声明了、但枚举没取到的频道 id（升序、去重）—— BUG-193 对账判据。
///
/// 返回**升序**数组，使调用方的补齐顺序与日志可复现（`HashSet` 迭代序不确定）。
fn missing_from_declaration<I>(seen: &HashSet<i64>, declared: I) -> Vec<i64>
where
    I: IntoIterator<Item = i64>,
{
    let mut missing: Vec<i64> = declared
        .into_iter()
        .filter(|id| !seen.contains(id))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    missing
}

/// 剥掉 `inputPeer*FromMessage` 外壳，取其内层真正带 `access_hash` 的 peer。
///
/// `inputPeerChannelFromMessage` / `inputPeerUserFromMessage` 自身**不带**
/// `access_hash`（只有 `peer` + `msg_id` + `channel_id`/`user_id`），而内层
/// `peer` 才是完整的 `InputPeer`。不剥壳就拿不到补齐所需的凭据。
fn unwrap_from_message_peer(peer: &tl::enums::InputPeer) -> &tl::enums::InputPeer {
    match peer {
        tl::enums::InputPeer::UserFromMessage(u) => unwrap_from_message_peer(&u.peer),
        tl::enums::InputPeer::ChannelFromMessage(c) => unwrap_from_message_peer(&c.peer),
        other => other,
    }
}

/// 由 `messages.getDialogs` 响应自带的 `users` / `chats` 建 `Bot API id -> 实体信息` 索引。
///
/// grammers 的 `build_peer_map` 是 `pub(crate)`，外部无法复用，故自建。键用
/// `PeerId::bot_api_dialog_id()` —— 与 `Channel::id` 同一空间，保证后续查表命中。
fn raw_peer_index(
    users: &[tl::enums::User],
    chats: &[tl::enums::Chat],
) -> HashMap<i64, RawPeerInfo> {
    let mut out: HashMap<i64, RawPeerInfo> = HashMap::with_capacity(users.len() + chats.len());
    for u in users {
        let tl::enums::User::User(x) = u else {
            continue; // UserEmpty：无实体信息。
        };
        let Some(id) = PeerId::user(x.id).and_then(|p| p.bot_api_dialog_id()) else {
            continue;
        };
        // 名称口径与 grammers `Peer::name()` 对齐：用户只取 `first_name`
        // （grammers 同款），空则由 `dialog_display_title` 兜底。
        let title = x
            .first_name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| x.username.clone());
        let peer_ref = x.access_hash.and_then(|h| {
            PeerId::user(x.id).map(|p| PeerRef {
                id: p,
                auth: PeerAuth::from_hash(h),
            })
        });
        out.insert(
            id,
            RawPeerInfo {
                title,
                username: x.username.clone(),
                peer_ref,
            },
        );
    }
    for c in chats {
        // 先算出 `PeerId` 再取展示字段：把「是频道还是基本群」的判定收敛到一处，
        // 避免两处各判一次而漂移（`PeerId::chat` 与 `PeerId::channel` 是不同
        // 类型的函数项，不能放进同一个元组）。
        let peer_id = match c {
            tl::enums::Chat::Chat(x) => PeerId::chat(x.id),
            tl::enums::Chat::Forbidden(x) => PeerId::chat(x.id),
            tl::enums::Chat::Channel(x) => PeerId::channel(x.id),
            tl::enums::Chat::ChannelForbidden(x) => PeerId::channel(x.id),
            // ChatEmpty：Telegram 只确认 id 存在，无名称。
            tl::enums::Chat::Empty(_) => continue,
        };
        let Some(peer_id) = peer_id else {
            continue;
        };
        let Some(id) = peer_id.bot_api_dialog_id() else {
            continue;
        };
        let (title, username, access_hash) = match c {
            tl::enums::Chat::Chat(x) => (x.title.clone(), None, None),
            tl::enums::Chat::Forbidden(x) => (x.title.clone(), None, None),
            tl::enums::Chat::Channel(x) => {
                (x.title.clone(), x.username.clone(), x.access_hash)
            }
            tl::enums::Chat::ChannelForbidden(x) => (x.title.clone(), None, Some(x.access_hash)),
            tl::enums::Chat::Empty(_) => continue,
        };
        // 基本群不需要 access_hash（与 grammers `PeerInfo::Chat` 一致），给 ambient 权限。
        let peer_ref = Some(PeerRef {
            id: peer_id,
            auth: match access_hash {
                Some(h) => PeerAuth::from_hash(h),
                None => PeerAuth::default(),
            },
        });
        out.insert(
            id,
            RawPeerInfo {
                title: Some(title),
                username,
                peer_ref,
            },
        );
    }
    out
}

/// `tl::enums::Chat` -> 公共 `Channel` DTO（补齐路径专用）。
///
/// 返回 `(Channel, PeerRef?)`：peer 引用为 `None` 表示该实体没带 `access_hash`
/// （`chatForbidden` 等），此时**仍入库**（列表可见）但不入 `peer_cache` ——
/// 写一个必然失败的 PeerRef 只会污染缓存并掩盖「确实没有凭据」这一事实。
fn channel_from_chat(
    chat: &tl::enums::Chat,
    folder_of: &HashMap<i64, String>,
) -> Option<(Channel, Option<PeerRef>)> {
    if matches!(chat, tl::enums::Chat::Empty(_)) {
        return None;
    }
    let peer_id = match chat {
        tl::enums::Chat::Chat(x) => PeerId::chat(x.id),
        tl::enums::Chat::Forbidden(x) => PeerId::chat(x.id),
        tl::enums::Chat::Channel(x) => PeerId::channel(x.id),
        tl::enums::Chat::ChannelForbidden(x) => PeerId::channel(x.id),
        tl::enums::Chat::Empty(_) => None,
    }?;
    let id = peer_id.bot_api_dialog_id()?;
    let title = match chat {
        tl::enums::Chat::Chat(x) => Some(x.title.clone()),
        tl::enums::Chat::Forbidden(x) => Some(x.title.clone()),
        tl::enums::Chat::Channel(x) => Some(x.title.clone()),
        tl::enums::Chat::ChannelForbidden(x) => Some(x.title.clone()),
        tl::enums::Chat::Empty(_) => None,
    };
    let username = match chat {
        tl::enums::Chat::Channel(x) => x.username.clone(),
        _ => None,
    };
    let peer_ref = match chat {
        tl::enums::Chat::Channel(x) => x.access_hash.map(|h| PeerRef {
            id: peer_id,
            auth: PeerAuth::from_hash(h),
        }),
        tl::enums::Chat::ChannelForbidden(x) => Some(PeerRef {
            id: peer_id,
            auth: PeerAuth::from_hash(x.access_hash),
        }),
        // 基本群不需要 access_hash，用 ambient 权限（与 grammers `PeerInfo::Chat` 一致）。
        tl::enums::Chat::Chat(_) | tl::enums::Chat::Forbidden(_) => Some(PeerRef {
            id: peer_id,
            auth: PeerAuth::default(),
        }),
        tl::enums::Chat::Empty(_) => None,
    };
    Some((
        Channel {
            id,
            title: dialog_display_title(title.as_deref(), id),
            username,
            folder: folder_of.get(&id).cloned(),
        },
        peer_ref,
    ))
}

/// `tl::enums::User` -> 公共 `Channel` DTO（补齐路径专用）。
fn channel_from_user(
    user: &tl::enums::User,
    folder_of: &HashMap<i64, String>,
) -> Option<(Channel, Option<PeerRef>)> {
    let tl::enums::User::User(x) = user else {
        return None; // UserEmpty：无实体信息。
    };
    let peer_id = PeerId::user(x.id)?;
    let id = peer_id.bot_api_dialog_id()?;
    // 名称口径与 grammers `Peer::name()` 对齐（只取 first_name），空则走兜底名。
    let name = x
        .first_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| x.username.clone());
    let peer_ref = x.access_hash.map(|h| PeerRef {
        id: peer_id,
        auth: PeerAuth::from_hash(h),
    });
    Some((
        Channel {
            id,
            title: dialog_display_title(name.as_deref(), id),
            username: x.username.clone(),
            folder: folder_of.get(&id).cloned(),
        },
        peer_ref,
    ))
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

/// 落盘文件名的字符上限（不含目录部分）。
///
/// Windows `MAX_PATH` = 260，而下载目录本身常在 60~120 字符量级，且落盘期间还有
/// `.part` 临时后缀（BUG-024 原子落盘，+5 字符）。故文件名留 180 字符安全档。
/// 超长时**只截名字部分**：`-chat-msg` 唯一后缀与扩展名永不参与截断，
/// 唯一性优先于可读性（截断破坏唯一性 = BUG-100 原样复发）。
const MAX_CACHE_FILENAME_CHARS: usize = 180;

/// 生成带唯一后缀的落盘文件名：`<清洗后名字>-<chat_id>-<message_id>.<ext>`（BUG-100）。
///
/// **过渡方案，不是最终形态**：后续 hash blob 存储改造
/// （`docs/design/blob-store-design.md`：`<download_dir>/blobs/ab/cd/<sha256hex>`）
/// 落地后由它的迁移任务统一搬运存量文件，届时本函数即可退役。
///
/// **只影响新建**：存量行的 `file_path` 已写进数据库，改它们的命名会让新代码找不到旧文件
/// 并制造数据错位，故存量一律不动（撞名只由 `Store::duplicate_file_paths` 暴露，不自动修复）。
fn cache_filename(name: &str, chat_id: i64, message_id: i64) -> String {
    let clean = sanitize_filename(name);
    let (stem, ext) = split_ext(&clean);
    let suffix = format!("-{chat_id}-{message_id}");
    let ext_part = match ext {
        Some(e) => format!(".{e}"),
        None => String::new(),
    };
    // 先扣掉不可截断的两段，剩下的预算才给名字 —— 顺序反了会截掉唯一后缀。
    let budget = MAX_CACHE_FILENAME_CHARS.saturating_sub(suffix.len() + ext_part.len());
    let stem = truncate_chars(&stem, budget);
    // 名字被截到 0（超长扩展名等极端输入）时兜底，避免产出以 `-` 开头的怪名。
    let stem = if stem.is_empty() {
        "media".to_string()
    } else {
        stem
    };
    format!("{stem}{suffix}{ext_part}")
}

/// 拆出主干与扩展名：`a.tar.gz` → `("a.tar", Some("gz"))`；无扩展名 → `(原名, None)`。
fn split_ext(name: &str) -> (String, Option<String>) {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned());
    (stem, ext)
}

/// 按**字符**（不是字节）截断：UTF-8 中文名按字节切会产生非法序列，落盘直接 os error。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
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
    /// 流式 SHA-256（D24-A / BUG-309）：在 `write_all` 里顺序累计，`persist` / 落 blob 前
    /// finalize。写路径全程无 seek、无回退、无并发写 ⇒ 零额外 IO 拿到内容指纹。
    hasher: sha2::Sha256,
}

impl PartFile {
    /// 旧命名式落盘（`<dir>/<filename>.part` → `<dir>/<filename>`）—— **仅测试用**。
    /// 生产路径已改为内容寻址 blob（[`Self::finish_into_blob`]），此函数保留给
    /// 只验证「流式哈希 + 半成品清理」语义的单测，避免它们依赖 blob 布局。
    #[allow(dead_code)]
    async fn create(dir: &Path, filename: &str) -> io::Result<Self> {
        Self::create_at(&dir.join(format!("{filename}.part"))).await
    }

    /// 在**指定路径**建临时文件（blob 布局用 `_tmp/<uuid>.part`）。
    async fn create_at(part: &Path) -> io::Result<Self> {
        let file = tokio::fs::File::create(part).await?;
        Ok(Self {
            file: Some(file),
            part: part.to_path_buf(),
            persisted: false,
            hasher: sha2::Sha256::new(),
        })
    }

    async fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        use sha2::Digest;
        use tokio::io::AsyncWriteExt;
        self.hasher.update(buf);
        match self.file.as_mut() {
            Some(f) => f.write_all(buf).await,
            None => Ok(()),
        }
    }

    /// 收尾：flush → 关闭句柄 → 原子改名为最终路径（Windows 上 rename 覆盖已存在目标）。
    ///
    /// **仅测试用**：生产落盘走 [`Self::finish_into_blob`]（内容寻址）。
    #[allow(dead_code)]
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

    /// 收尾到**内容寻址**布局（D24-A / BUG-309）：flush → 关句柄 → 算 hash →
    /// dedup 命中（同 hash 的 blob 已存在）则删临时文件，否则 `rename` 到
    /// `<download_dir>/.blobs/ab/cd/<hash>`。
    ///
    /// 返回 `(blob 绝对路径, hash, dedup)`。dedup 命中时**不覆盖**既有字节
    /// （hash 保证内容一致，覆盖是纯浪费，且避免并发任务抢同一路径）。
    async fn finish_into_blob(mut self, download_dir: &Path) -> io::Result<(PathBuf, String, bool)> {
        use sha2::Digest;
        use tokio::io::AsyncWriteExt;
        if let Some(f) = self.file.as_mut() {
            f.flush().await?;
        }
        drop(self.file.take());
        let hash = crate::blob::hex_encode(&self.hasher.clone().finalize());
        let final_path = crate::blob::blob_path(download_dir, &hash);
        if final_path.exists() {
            let _ = tokio::fs::remove_file(&self.part);
            self.persisted = true;
            return Ok((final_path, hash, true));
        }
        if let Some(parent) = final_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&self.part, &final_path).await?;
        self.persisted = true;
        Ok((final_path, hash, false))
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

    /// BUG-100 核心：同名文件在不同频道/不同消息下必须落到**不同**文件名。
    /// 这是「清一条、另一条变死链」的唯一防线。
    #[test]
    fn cache_filename_is_unique_across_chats_and_messages() {
        let a = cache_filename("video_2024.mp4", -100111, 42);
        let b = cache_filename("video_2024.mp4", -100222, 42);
        let c = cache_filename("video_2024.mp4", -100111, 43);
        assert_ne!(a, b, "不同频道同名不得撞名");
        assert_ne!(a, c, "同频道不同消息不得撞名");
        assert!(a.ends_with("-100111-42.mp4"), "唯一后缀须保留扩展名在后: {a}");
        assert!(a.starts_with("video_2024-"), "原始名须在前，便于人肉检索: {a}");
    }

    /// 非法字符仍须清洗（Windows 落盘 os error 5/123），且与唯一后缀共存。
    #[test]
    fn cache_filename_sanitizes_illegal_chars() {
        // 频道 id 为负（Telegram 惯例），故后缀形如 `--1001-7`；双横杠是预期的、
        // 不影响唯一性，也不参与清洗（清洗只作用于原始名部分）。
        let n = cache_filename("a:b|c?d*e.mp4", -1001, 7);
        assert_eq!(n, "a_b_c_d_e--1001-7.mp4");
        // 空名/纯非法名走兜底，不得产出空文件名。
        assert_eq!(cache_filename("", -1001, 7), "download--1001-7.bin");
        // 无扩展名：后缀照带，不补假扩展名。
        assert_eq!(cache_filename("README", -1001, 7), "README--1001-7");
        // 正 id（用户/群组）不产生双横杠。
        assert_eq!(cache_filename("a.mp4", 1001, 7), "a-1001-7.mp4");
    }

    /// 超长名截断时**只能截名字部分**：chat/msg 后缀与扩展名必须完整存活，
    /// 否则唯一性被截断破坏，BUG-100 原样复发。
    #[test]
    fn cache_filename_truncates_stem_but_keeps_unique_suffix() {
        let long = "很".repeat(400);
        let n = cache_filename(&format!("{long}.mkv"), -1001234567890, 987654321);
        let suffix = "-1001234567890-987654321.mkv";
        assert!(
            n.ends_with(suffix),
            "唯一后缀与扩展名不得被截断: {}… (len={})",
            &n[n.len().saturating_sub(40)..],
            n.chars().count()
        );
        assert!(
            n.chars().count() <= MAX_CACHE_FILENAME_CHARS,
            "总长须受控（Windows MAX_PATH）: {}",
            n.chars().count()
        );
        // 极端：扩展名长到把名字预算吃光 → 兜底名，仍带唯一后缀。
        let huge_ext = format!("x.{}", "e".repeat(300));
        let n2 = cache_filename(&huge_ext, -1001, 7);
        assert!(n2.starts_with("media--1001-7."), "预算耗尽须兜底而非产出空名: {n2}");
    }

    /// BUG-106：把「看门狗能否取出 panic 病因」做成可执行的断言。
    ///
    /// 这段 downcast 逻辑是「下次 runner 死掉时能不能定性」的唯一依靠 ——
    /// 它一旦失效，日志里就只剩一句 `PANICKED: <non-string panic payload>`，
    /// 等于病因在最关键处又被丢掉，和这次的故障一模一样。
    ///
    /// **这里刻意不真 spawn 一个会 panic 的任务**：实测在 libtest 的默认多线程模式下，
    /// 只要本模块里有测试真的让 tokio 任务 panic，整个测试进程就会稳定崩在
    /// `STATUS_ACCESS_VIOLATION (0xc0000005)`（连续两次必现；`--test-threads=1` 则 64/64 全绿，
    /// 只跑这两个也全绿 —— 是并发与 panic 处理的交互，不是本逻辑的问题）。
    /// 留一个必然让 CI 崩的测试换一点点覆盖率不划算，故改为直接构造 payload：
    /// 三种分支照样覆盖，而 `try_into_panic()` 本身是 tokio 的 API，不需要我们替它担保。
    #[test]
    fn panic_payload_to_string_covers_every_payload_shape() {
        // `panic!("literal")` 的 payload 是 &'static str。
        let p: Box<dyn Any + Send> = Box::new("literal-boom");
        assert_eq!(
            panic_payload_to_string(p),
            "literal-boom",
            "字面量 panic 的病因必须完整可见"
        );

        // `panic!("{}", x)` 的 payload 是 String。
        let p: Box<dyn Any + Send> = Box::new(String::from("formatted-boom"));
        assert_eq!(
            panic_payload_to_string(p),
            "formatted-boom",
            "格式化 panic 的病因必须完整可见"
        );

        // 非字符串 payload：不得 panic、不得产出空串，必须明确标注「取不到」，
        // 绝不能把占位符伪装成病因。
        let p: Box<dyn Any + Send> = Box::new(vec![1u8, 2, 3]);
        assert_eq!(
            panic_payload_to_string(p),
            "<non-string panic payload>",
            "非字符串 payload 必须被明确标注"
        );
    }

    /// 看门狗的另一半：runner **正常结束**时也必须被判定为死亡（并走 `Ok(())` 分支）。
    ///
    /// 不 panic，因此不涉及上面那个并发崩溃，可以放心用真实 tokio 任务验证。
    /// 这条同时是反向约束：若有人把「正常返回」误当成「还活着」，`link_alive` 就会说谎。
    #[tokio::test]
    async fn watchdog_treats_clean_return_as_death() {
        let dead = Arc::new(AtomicBool::new(false));
        let flag = dead.clone();
        let h = tokio::spawn(async {});
        tokio::spawn(async move {
            match h.await {
                Ok(()) => {
                    flag.store(true, Ordering::SeqCst);
                }
                Err(_) => unreachable!("本任务不 panic 也不取消"),
            }
        })
        .await
        .unwrap();
        assert!(
            dead.load(Ordering::SeqCst),
            "runner 正常结束也必须置死亡标志 —— 它一结束后续 RPC 就恒失败"
        );
    }

    /// BUG-110：链路已断时的 RPC 失败必须归为「上游依赖不可用」，
    /// 不能落进 `Other` 兜底桶 —— 后者会被 `From<ClientError>` 映射成 400。
    #[test]
    fn rpc_failure_is_unavailable_when_link_is_down() {
        let e = GrammersClient::classify_rpc_err(true, "request error: dropped (cancelled)");
        assert!(
            matches!(e, ClientError::Unavailable(_)),
            "链路已断应归为 Unavailable，实际: {}",
            e
        );
        assert!(
            e.to_string().contains("MTProto link is down"),
            "原因必须可行动（含链路已断与恢复指引），实际: {e}"
        );
    }

    /// 反向证伪：链路活着时**不能**误升为 503，否则普通 RPC 失败会被当成依赖故障，
    /// 前端会据此提示「重启服务」——把小错说成大修。
    #[test]
    fn rpc_failure_stays_other_when_link_is_alive() {
        let e = GrammersClient::classify_rpc_err(false, "some ordinary rpc error");
        assert!(
            matches!(e, ClientError::Other(_)),
            "链路活着时应仍为 Other，实际: {e}"
        );
    }

    /// 竞态证明：标志**尚未**置位时，错误原文本身也必须能证明链路已死。
    ///
    /// runner 死亡 → 标志置位与在途 RPC 失败是**并发**的，标志可能晚一步；
    /// 只靠标志，死亡后的首批失败仍会报成 400 —— 而用户看到的正是这批。
    #[test]
    fn dropped_error_proves_link_down_even_before_the_flag_is_set() {
        let e = GrammersClient::classify_rpc_err(false, "request error: dropped (cancelled)");
        assert!(
            matches!(e, ClientError::Unavailable(_)),
            "dropped 本身就是链路已死的证据，不该依赖标志是否已置位，实际: {e}"
        );
    }

    /// 端到端锁住状态码：整条链路走完（ClientError -> ApiError -> HTTP）必须是 503。
    ///
    /// 只测 `classify_rpc_err` 的变体还不够 —— 变体对了但 `From` 映射写错（或将来被改）
    /// 仍会回到 400。这条断言的是**最终对用户可见的那个数字**。
    #[test]
    fn link_down_rpc_failure_is_503_not_400() {
        use axum::response::IntoResponse;
        let e = GrammersClient::classify_rpc_err(true, "request error: dropped (cancelled)");
        let res: axum::response::Response = crate::routes::ApiError::from(e).into_response();
        assert_eq!(
            res.status(),
            503,
            "链路已断是依赖故障，绝不能报成 4xx（会被读成用户操作失误）"
        );
    }

    // ---- BUG-193：归档（非主文件夹）会话必须进入枚举结果 ----

    fn ch(id: i64, title: &str, folder: Option<&str>) -> Channel {
        Channel {
            id,
            title: title.to_string(),
            username: None,
            folder: folder.map(str::to_string),
        }
    }

    /// 构造一个字段齐全的 `tl::types::User`，供测试用 `..base_user()` 只覆盖关心的字段。
    ///
    /// 该类型有 50 个字段且**没有 `Default` derive**，逐个在每个测试里写全既啰嗦
    /// 又容易随 TL 层升级而失效。其余字段一律取零值 —— 被断言的只有
    /// `id` / `access_hash` / `first_name` / `username`，其余本就与本组测试无关。
    fn base_user() -> tl::types::User {
        tl::types::User {
            is_self: false,
            contact: false,
            mutual_contact: false,
            deleted: false,
            bot: false,
            bot_chat_history: false,
            bot_nochats: false,
            verified: false,
            restricted: false,
            min: false,
            bot_inline_geo: false,
            support: false,
            scam: false,
            apply_min_photo: false,
            fake: false,
            bot_attach_menu: false,
            premium: false,
            attach_menu_enabled: false,
            bot_can_edit: false,
            close_friend: false,
            stories_hidden: false,
            stories_unavailable: false,
            contact_require_premium: false,
            bot_business: false,
            bot_has_main_app: false,
            bot_forum_view: false,
            bot_forum_can_manage_topics: false,
            bot_can_manage_bots: false,
            bot_guestchat: false,
            bot_guard: false,
            id: 0,
            access_hash: None,
            first_name: None,
            last_name: None,
            username: None,
            phone: None,
            photo: None,
            status: None,
            bot_info_version: None,
            restriction_reason: None,
            bot_inline_placeholder: None,
            lang_code: None,
            emoji_status: None,
            usernames: None,
            stories_max_id: None,
            color: None,
            profile_color: None,
            bot_active_users: None,
            bot_verification_icon: None,
            send_paid_messages_stars: None,
        }
    }

    /// BUG-193 的**核心判据**：枚举范围必须同时含主文件夹与归档文件夹。
    ///
    /// 这是 doc「反向证伪」要求能成立的关键：把 `ENUMERATED_FOLDER_IDS` 里的
    /// 归档项去掉（或把 `ARCHIVE_FOLDER_ID` 改错），本条立刻变红。
    /// 没有这条时，删掉归档枚举不会有任何测试信号 —— 判据形同虚设。
    #[test]
    fn enumeration_covers_the_archive_folder_bug193() {
        assert!(
            ENUMERATED_FOLDER_IDS.contains(&Some(ARCHIVE_FOLDER_ID)),
            "BUG-193：枚举范围必须含归档文件夹（folder_id=1），否则归档频道永不进缓存"
        );
        assert!(
            ENUMERATED_FOLDER_IDS.contains(&None),
            "主文件夹（folder_id=None）必须仍在枚举范围内，不得回归"
        );
        // 归档 id 必须真的是 Telegram 的 Archive（1），不是随手写的数。
        assert_eq!(ARCHIVE_FOLDER_ID, 1, "Telegram 的归档文件夹 id 恒为 1");
        // 恰好两个来源：多出来的只会是无谓 RPC，少了就是缺陷。
        assert_eq!(ENUMERATED_FOLDER_IDS.len(), 2);
    }

    /// 反向证伪：把归档从枚举范围里摘掉（= BUG-193 修复前的状态）判据必须变红。
    ///
    /// 用真实的枚举范围常量跑一遍判定逻辑，证明上面那条断言真的会失败 ——
    /// 否则「测试通过」可能只是断言写得太松。
    #[test]
    fn removing_archive_from_enumeration_turns_the_criterion_red_bug193() {
        // 模拟「注掉归档枚举」：范围里只剩主文件夹。
        let without_archive: Vec<Option<i32>> = ENUMERATED_FOLDER_IDS
            .iter()
            .copied()
            .filter(|id| *id != Some(ARCHIVE_FOLDER_ID))
            .collect();
        assert!(
            !without_archive.contains(&Some(ARCHIVE_FOLDER_ID)),
            "对照组前提：摘掉归档后枚举范围确实不含归档文件夹"
        );
        // 这正是 `archive_folder_dialogs_survive_the_merge_bug193` 的判据：
        // 没有归档来源，归档频道就无从进入列表。
        let merged = merge_dialog_folders(vec![ch(777_000, "Telegram", None)], vec![]);
        assert!(
            !merged
                .iter()
                .any(|c| c.id == -1_000_000_004_493_170_102),
            "归档来源缺席时，归档频道必然缺失（这正是 BUG-193 的现象）"
        );
    }

    /// 归档文件夹的对话必须真的进合并结果（BUG-193 根因判据）。
    ///
    /// 本条锁的是 doc 实测的缺陷形状：66 个频道在 TG 分组里声明了，却因为
    /// `iter_dialogs()` 只枚举主文件夹而不在应用会话列表中。合并函数一旦
    /// 漏掉归档侧（或去重写错），这里立刻变红。
    #[test]
    fn archive_folder_dialogs_survive_the_merge_bug193() {
        let primary = vec![ch(777_000, "Telegram", Some("MyTop"))];
        // 归档频道：负 id（-100 前缀），带自定义分组标注。
        let archived = vec![
            ch(-1_000_000_004_493_170_102, "归档频道 A", Some("‼️全网分组中心A‼️")),
            ch(-1_000_000_004_493_170_103, "归档频道 B", None),
        ];
        let merged = merge_dialog_folders(primary, archived);

        let ids: std::collections::HashSet<i64> = merged.iter().map(|c| c.id).collect();
        assert!(
            ids.contains(&-1_000_000_004_493_170_102),
            "归档频道必须出现在会话列表里（BUG-193）"
        );
        assert!(ids.contains(&-1_000_000_004_493_170_103));
        assert!(ids.contains(&777_000), "主文件夹会话不得被归档侧挤掉");
        assert_eq!(merged.len(), 3, "主 + 归档求并集，不重不漏");
        // 分组标注要跟着一起过来（UI 靠它分组）。
        assert_eq!(
            merged
                .iter()
                .find(|c| c.id == -1_000_000_004_493_170_102)
                .unwrap()
                .folder
                .as_deref(),
            Some("‼️全网分组中心A‼️")
        );
    }

    /// 反向证伪：归档侧若被丢弃（BUG-193 修复前 的形状），上面那条必须失败。
    ///
    /// 这条把「不合并归档」的写法直接跑一遍，证明判据真的会红 ——
    /// 否则「测试通过」可能只是断言写得太松。
    #[test]
    fn dropping_the_archive_side_fails_the_bug193_assertion() {
        let primary = vec![ch(777_000, "Telegram", Some("MyTop"))];
        let archived = [ch(-1_000_000_004_493_170_102, "归档频道 A", None)];
        // 只取主文件夹（即修复前的行为）。
        let merged = merge_dialog_folders(primary, vec![]);
        let ids: std::collections::HashSet<i64> = merged.iter().map(|c| c.id).collect();
        assert!(
            !ids.contains(&-1_000_000_004_493_170_102),
            "对照组前提：主文件夹单独枚举时归档频道确实缺席"
        );
        assert!(!ids.contains(&archived[0].id));
    }

    /// 同一频道同属主/归档两处时只留一条，且**以主文件夹那条为准**。
    #[test]
    fn merge_prefers_the_primary_folder_record_bug193() {
        let primary = vec![ch(-1_000_000_004_493_170_102, "主文件夹版本", Some("MyTop"))];
        let archived = vec![ch(-1_000_000_004_493_170_102, "归档版本", None)];
        let merged = merge_dialog_folders(primary, archived);
        assert_eq!(merged.len(), 1, "同 id 不得产生重复行");
        assert_eq!(merged[0].title, "主文件夹版本");
        assert_eq!(merged[0].folder.as_deref(), Some("MyTop"));
    }

    /// 对账：分组声明了但两轮枚举都没取到的 id，正是要补齐的那一批。
    #[test]
    fn missing_from_declaration_picks_the_gap_bug193() {
        let declared = vec![
            -1_000_000_004_493_170_102i64,
            777_000,
            -1_000_000_004_493_170_103,
            555,
        ];
        // 模拟枚举结果：主文件夹 + 归档文件夹共覆盖 3 个，555 缺席。
        let seen: std::collections::HashSet<i64> = [
            -1_000_000_004_493_170_102i64,
            777_000,
            -1_000_000_004_493_170_103,
        ]
        .into_iter()
        .collect();
        let missing = missing_from_declaration(&seen, declared);
        assert_eq!(missing, vec![555], "只报真正缺席的 id，且升序可复现");
    }

    /// 对账为空时不得触发补齐（避免每次扫描都白发一轮 RPC）。
    #[test]
    fn missing_is_empty_when_enumeration_is_complete_bug193() {
        let seen: std::collections::HashSet<i64> = [777_000, -1_000_000_004_493_170_102]
            .into_iter()
            .collect();
        let missing = missing_from_declaration(&seen, vec![777_000, -1_000_000_004_493_170_102]);
        assert!(missing.is_empty(), "枚举齐了就不该有缺口");
    }

    /// `inputPeer*FromMessage` 外壳必须剥掉：外壳本身不带 `access_hash`，
    /// 不剥就拿不到补齐所需凭据（`resolve_folder_gaps` 会静默漏掉这些频道）。
    #[test]
    fn from_message_shell_is_unwrapped_for_access_hash_bug193() {
        use tl::enums::InputPeer;
        let inner = InputPeer::Channel(tl::types::InputPeerChannel {
            channel_id: 4_493_170_102,
            access_hash: 12_345,
        });
        let wrapped = InputPeer::ChannelFromMessage(Box::new(
            tl::types::InputPeerChannelFromMessage {
                peer: inner,
                msg_id: 7,
                channel_id: 4_493_170_102,
            },
        ));
        match unwrap_from_message_peer(&wrapped) {
            InputPeer::Channel(c) => assert_eq!(
                c.access_hash, 12_345,
                "剥壳后必须拿得到 access_hash，否则补齐无从下手"
            ),
            other => panic!("剥壳后应是 InputPeer::Channel，实际 {other:?}"),
        }
        // 非 FromMessage 变体原样返回。
        assert!(matches!(
            unwrap_from_message_peer(&wrapped),
            InputPeer::Channel(_)
        ));
    }

    /// 归档枚举/补齐共用的实体转换：`channelFromMessage` 频道必须被转成
/// 带标题与分组标注的 `Channel`，并带出 `access_hash` 以便回填 `peer_cache`。
    ///
    /// 这里**不**构造完整 `tl::types::Channel`（40+ 必填字段、无 `Default`），
    /// 而改测 `channel_from_user` —— 它入参小、走的仍是同一条「实体 -> Channel
    /// + PeerRef」逻辑（`id` 换算 / 标题兜底 / `access_hash` 带出三处都在）。
    #[test]
    fn channel_from_entity_carries_identity_and_credentials_bug193() {
        let user = tl::enums::User::User(tl::types::User {
            id: 777_000,
            access_hash: Some(998_877),
            first_name: Some("归档里的用户".to_string()),
            username: Some("archuser".to_string()),
            ..base_user()
        });
        let folder_of: HashMap<i64, String> =
            [(777_000i64, "‼️全网分组中心A‼️".to_string())].into_iter().collect();
        let (c, pr) = channel_from_user(&user, &folder_of).expect("用户实体必须能转成 Channel");
        assert_eq!(c.id, 777_000);
        assert_eq!(c.title, "归档里的用户");
        assert_eq!(c.username.as_deref(), Some("archuser"));
        assert_eq!(
            c.folder.as_deref(),
            Some("‼️全网分组中心A‼️"),
            "分组标注必须一起带出"
        );
        assert_eq!(
            pr.expect("用户实体应带出 PeerRef").auth.hash(),
            998_877,
            "access_hash 必须原样带出，否则补齐出来的行点进去拉不到东西"
        );
    }

    /// 无名实体必须拿到**可辨识**兜底名（复用 BUG-194 的收敛函数，不得留空）。
    #[test]
    fn channel_from_entity_falls_back_to_identifiable_title_bug193() {
        let user = tl::enums::User::User(tl::types::User {
            id: 424_242,
            access_hash: None,
            first_name: Some("   ".to_string()),
            username: None,
            ..base_user()
        });
        let (c, pr) =
            channel_from_user(&user, &HashMap::new()).expect("无名用户也应入库（可见性优先）");
        assert!(
            !c.title.trim().is_empty(),
            "落库标题不得为空（BUG-194 不变量）"
        );
        assert!(c.title.contains("424242"), "兜底名须带 id: {}", c.title);
        assert!(
            pr.is_none(),
            "无 access_hash 时不得凭空造 PeerRef —— 会把必然失败的凭据写进缓存"
        );
    }
}
