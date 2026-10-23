//! SQLite 存储层：监控频道、入库媒体消息、增量同步游标。
//!
//! 本地单文件 SQLite（libsql 本地后端），供 `monitor` 后台任务增量拉取频道媒体入库、
//! `/api/tg/monitor` 路由查询，以及「下载/播放」定位已入库媒体。
//!
//! 采用与 grammers-session 相同的 libsql 本地后端（`core` feature），避免与 bundled
//! sqlite3 的 LNK2005 多重定义链接冲突。`libsql::Connection` 内部为 `Arc<dyn Conn + Send + Sync>`，
//! 是 `Clone + Send + Sync`，因此 `Store` 可直接经 `AppState` 的 `Arc` 多线程共享，无需额外锁。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use libsql::params::IntoParams;
use libsql::{params, Connection, Row};
use serde::Deserialize;
use serde::Serialize;
use serde::Deserializer;
use serde::Serializer;

use crate::login::Channel;

/// BUG-345：相册组 id（TG `group_id`，量级 ~1.4e16）**超过** JS
/// `Number.MAX_SAFE_INTEGER`（2^53-1 ≈ 9.007e15）。
///
/// 以 JSON **number** 过边界时，前端 `JSON.parse` 会把它化入相邻的可表示双精度
/// 浮点：活库实证 70 个组键缓存任务里 **62 个**的 `item_key`/`group_id` 比真值
/// 差 1（如 14337318082994317 → …316）。后果不是显示问题——去重键与相册身份
/// 对不上，「同一相册」在系统里分裂成两个身份（BUG-341 整组入库正好要把这个 id
/// 原样回传）。修法（让错误状态不可表达）：group_id 过界一律走**字符串**
/// （GitHub node_id 同款先例），反序列化保持宽容（string/number 都收），
/// 旧客户端（重部署窗口里的陈旧标签页）不被击。
///
/// 序列化点 ×4（`TgMedia` / `MonitorFilterHit` / `StoredMessage` / `CacheTask`）
/// 与反序列化点 ×1（`EnqueueCacheReq.group_id`）共用这两个函数。
pub fn serialize_group_id_opt<S: Serializer>(
    v: &Option<i64>,
    s: S,
) -> Result<S::Ok, S::Error> {
    match v {
        Some(g) => s.serialize_str(&g.to_string()),
        None => s.serialize_none(),
    }
}

pub fn deserialize_group_id_opt<'de, D>(d: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        Num(i64),
        Str(String),
    }
    match Option::<NumOrStr>::deserialize(d)? {
        None => Ok(None),
        Some(NumOrStr::Num(n)) => Ok(Some(n)),
        Some(NumOrStr::Str(s)) => s
            .trim()
            .parse::<i64>()
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
}

/// 监控中的频道（`monitored_channel` 行）。
#[derive(Debug, Clone, Serialize)]
pub struct MonitoredChannel {
    #[serde(rename = "channelId")]
    pub channel_id: i64,
    pub title: String,
    pub username: Option<String>,
    #[serde(rename = "addedAt")]
    pub added_at: i64,
    /// **自上次点开以来**新增的媒体条数（`message_id > last_read_message_id`）。
    ///
    /// 口径由用户 2026-10-19 裁定：「显示自上次点开以来新增条数」——不是
    /// 「库里一共有多少条」（那是累计量，对「有没有新东西」没有信息量），
    /// 也不是「本轮同步新增」（那只是服务端一次拉取的副产品，用户点开面板
    /// 之前它就已经被清零的下一轮覆盖）。故必须有**每频道已读游标**。
    #[serde(rename = "newCount")]
    pub new_count: i64,
    /// 回溯目标日期（unix 秒，0 = 该频道没有待回溯）。
    ///
    /// 2026-10-22 用户第 2 点：「频道数据只会加载一部分数据，不符合过滤筛选需求」。
    /// 回溯是**长跑**（每轮每频道只翻一页），所以进度必须能从列表里看见——
    /// 否则用户点了「回溯到 1 月」之后没有任何反馈，只会以为按钮没生效。
    #[serde(rename = "backfillUntil", default)]
    pub backfill_until: i64,
    /// 回溯游标（向旧翻到的最新消息号，0 = 还没开始翻/没有待回溯）。
    ///
    /// BUG-382：用户「无法确认上次回溯点」——只有目标日期（`backfillUntil`）
    /// 时，界面说得出「要回溯到哪」却说不出「已经回溯到哪」。游标是真值：
    /// 每翻一页 `advance_backfill` 推进一次。
    #[serde(rename = "backfillBeforeId", default)]
    pub backfill_before_id: i64,
    /// 增量同步游标（最新已同步消息号，0 = 从没同步过）。
    ///
    /// BUG-382：「最新」边界 —— 与回溯游标成对出现，用户才能同时回答
    /// 「最新到哪、历史到哪」。
    #[serde(rename = "lastMessageId", default)]
    pub last_message_id: i64,
    /// 库内**最老**已入库消息的日期（unix 秒；0 = 该频道还没有入库数据）。
    ///
    /// BUG-394：回溯表单的默认日期必须有真源 —— 没有它，展开表单只能给空白
    /// 输入框，用户凭记忆猜「回溯到几号」。取 `MIN(COALESCE(msg_date, created_at))`：
    /// `msg_date` 是消息真实日期、可能为 NULL（旧数据迁移前只有 created_at），
    /// 两者取其一即为该条消息的日期口径。空集落 0（BUG-388 同型坑：标量子查询
    /// 空集返 NULL，内层 COALESCE 包不住「没有行」）。
    #[serde(rename = "oldestMessageDate", default)]
    pub oldest_message_date: i64,
}

/// 文字筛选规则（`monitor_filter` 行）。
///
/// 用户 2026-10-19 裁定：「多次作为多条，不是单一过滤。一条相当于一条监控。」
/// ⇒ 每条规则是**并列的一个条目**，各自算自己的命中集合，**不合并**成
/// 「同一频道内多关键词 AND/OR」的复合条件。这样它读起来就是「一条虚拟监控频道」：
/// 有自己的名字、自己的命中数、自己的列表。
#[derive(Debug, Clone, Serialize)]
pub struct MonitorFilter {
    pub id: i64,
    pub label: String,
    pub keyword: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// 命中条数（跨全部监控频道，**只匹配 caption**）。
    ///
    /// 文件名不参与匹配（用户 2026-10-22 改判：「我们筛选的是内容不是文件名，
    /// 内容在消息中不在文件中」）。文件名是文件属性，用它凑命中率等于把不可读的
    /// 随机名当成内容匹配。
    pub hits: i64,
    /// **自上次点开该规则以来**新增的命中条数（BUG-330 / TGM-06）。
    ///
    /// 与 `MonitoredChannel::new_count` 同构：用户口径「筛选添加的就是我需要监听的
    /// **更新**内容」——只有总数时，「有没有新东西」在筛选层是断的。游标是
    /// **时间戳** `last_read_at`（unix 秒）：命中跨频道，message_id 跨频道不可比；
    /// 时间戳跨频道可比、单调，与命中定序同源（`COALESCE(msg_date, created_at)`）。
    /// 现算不另存计数列（存了就和真实行漂移，BUG-329 纪律）。
    #[serde(rename = "newHits")]
    pub new_hits: i64,
}

/// 筛选命中行：媒体消息 + 所属频道标题。
///
/// 与 [`MonitoredMessageHit`] 的区别：这里带出 `file_name`。
///
/// **注意：`file_name` 只用于显示，不参与匹配**（用户 2026-10-22 改判：
/// 「我们筛选的是内容不是文件名，内容在消息中不在文件中」）。带出它的唯一理由是
/// 命中行需要能看出「这是什么」——caption 可能为空，此时前端用文件名兜底显示。
/// 匹配条件见 [`Store::filter_messages`]：只有 `caption`。
#[derive(Debug, Clone, Serialize)]
pub struct MonitorFilterHit {
    #[serde(rename = "channelId")]
    pub channel_id: i64,
    #[serde(rename = "messageId")]
    pub message_id: i64,
    pub caption: Option<String>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
    pub downloaded: bool,
    #[serde(rename = "channelTitle")]
    pub channel_title: Option<String>,
    /// TG 相册分组 id（同组消息构成一个相册；无则单条）。前端据此「按组入库」而非按单条
    /// 扁平化——同一频道内的多相册必须各自成任务，保留相册结构（BUG-329 裁定①）。
    ///
    /// BUG-345：过 JSON 边界走**字符串**——group_id ~1.4e16 > 2^53，number 过界
    /// 会被前端 JSON.parse 化掉精度（活库 62/70 个组键任务被污染）。
    #[serde(
        rename = "groupId",
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_group_id_opt"
    )]
    pub group_id: Option<i64>,
    /// MIME 类型（BUG-330 / TGM-05：命中行预览的数据基础）。
    ///
    /// `filter_messages` 原先不取这两列 ⇒ 前端即使想展开也驱动不了
    /// `PhotoBlock`/`VideoBlock`/`MessageBubble`（store.rs `get_message` 一直取，
    /// 是 filter 查询漏了）。
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// 落盘路径（同上；无 = 未缓存，前端据此给「缺字节」态，BUG-080 判据）。
    #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

/// 已入库的媒体消息（`media_message` 行）。
#[derive(Debug, Clone, Serialize)]
pub struct StoredMessage {
    #[serde(rename = "channelId")]
    pub channel_id: i64,
    #[serde(rename = "messageId")]
    pub message_id: i64,
    pub caption: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub downloaded: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// 媒体类型：`photo` / `video` / `audio` / `file`（v0.4.0 新增列，旧行为 NULL）。
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// 消息在 Telegram 上的原始发布时间（Unix 秒，v0.4.0 新增列，旧行为 NULL）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
    /// 媒体时长（秒；视频/音频才有，v0.4.1 新增列，旧行为 NULL）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i64>,
    /// 已缓存文件的绝对路径（downloaded=1 时有值，v0.4.1 新增列，旧行为 NULL）。
    #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// TG 相册分组 id（同一相册共享同值，v0.4.2 新增列，旧行为 NULL）。
    /// BUG-345：过界走字符串（见 `serialize_group_id_opt`）。
    #[serde(
        rename = "groupId",
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_group_id_opt"
    )]
    pub group_id: Option<i64>,
}

/// 缓存库聚合行：媒体消息 + 所属频道标题（LEFT JOIN monitored_channel）。
#[derive(Debug, Clone, Serialize)]
pub struct StoredItem {
    #[serde(flatten)]
    pub msg: StoredMessage,
    /// 所属频道标题（频道已取消监控时为 None）。
    #[serde(rename = "channelTitle", skip_serializing_if = "Option::is_none")]
    pub channel_title: Option<String>,
}

/// 缓存库查询条件（全部可选，None = 不限）。
#[derive(Debug, Clone, Default)]
pub struct StoredQuery {
    /// 仅看已缓存（downloaded = 1）。
    pub downloaded_only: bool,
    /// 按媒体类型过滤（photo/video/audio/file）。
    pub media_type: Option<String>,
    /// 关键词：匹配 caption / 频道标题 / 落盘路径。
    pub q: Option<String>,
    /// 历史游标（exclusive）：只返回 message_id < before_id 的行。
    pub before_id: Option<i64>,
    /// 每页条数（内部 clamp 1..=200）。
    pub limit: u32,
}

/// 一条存量 `file_path` 撞名记录（BUG-100 检测面）。
///
/// `count` = 共享该路径的行数；> 1 即意味着清掉其中一条会打掉其余条的字节。
#[derive(Debug, Clone, Serialize)]
pub struct FilePathCollision {
    /// 来源表（`media_item` / `media_message`），决定后果落在哪一侧。
    pub table: String,
    /// 被多个条目共享的落盘路径。
    pub path: String,
    /// 共享该路径的行数。
    pub count: i64,
}

/// libsql 本地 SQLite 存储。
///
/// `pub`（而非 `pub(crate)`）：`organize` 模块的 plan/apply 对外只收 `&Store`，
/// 收 `pub(crate)` 会在该模块外泄漏一条「导不出去又用不上」的私有类型。
pub struct Store {
    /// `pub(crate)` 供 `media` 模块复用同一连接（资料库与 TG 流水同库）。
    pub(crate) conn: Connection,
    /// 打开时的数据库文件路径（`:memory:` 原样保留）。
    ///
    /// 字节所有权 P2：库根的解析链需要它——config.json 与默认库根都取
    /// `<TG 数据目录>/<...>`，而 TG 数据目录 = 数据库文件的父目录。
    pub(crate) db_path: PathBuf,
}

/// 批量清除任务记录的**范围**——动词只有一个（清除），可变的是范围。
///
/// 三档互斥，且**并集恰好是全集**（`success` ∪ `failed` ∪ 活跃 = 全部记录），
/// 因此不存在「要不要再加一档清空 X」的问题：任何新增诉求都先归到这三档之一。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskClearScope {
    /// 全部记录（含活跃任务——先置 cancelled 停 worker 再删）。
    All,
    /// 仅成功记录（`done`）。
    Success,
    /// 仅失败类记录（`failed` / `cancelled` / `interrupted`）。
    Failed,
}

impl TaskClearScope {
    /// SQL 谓词（作用于 `cache_task.status`）。
    pub fn predicate(self) -> &'static str {
        match self {
            Self::All => "1=1",
            Self::Success => "status = 'done'",
            Self::Failed => "status IN ('failed', 'cancelled', 'interrupted')",
        }
    }

    /// 从 query 串解析；无法识别返回 `None`（调用方回 422，不静默当成「全部」）。
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "all" | "" => Some(Self::All),
            "success" | "done" | "succeeded" => Some(Self::Success),
            "failed" | "failure" | "error" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// 缓存任务（`cache_task` 行）——服务端持有的下载任务状态。
///
/// 结构性要点：任务生命周期**不绑定 HTTP 请求**。此前缓存是「浏览器发一条同步
/// 下载请求、进度只存在前端 React state」，刷新/切页即丢（任务连同状态一起消失）。
/// 现在任务落库、由后台 worker 跑，前端只做**读视图**，刷新后重新读取即可恢复。
#[derive(Debug, Clone, Serialize)]
pub struct CacheTask {
    pub id: i64,
    #[serde(rename = "chatId")]
    pub chat_id: i64,
    /// 相册分组 id（单条缓存为 NULL）。
    /// BUG-345：过界走字符串（见 `serialize_group_id_opt`）。
    #[serde(
        rename = "groupId",
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_group_id_opt"
    )]
    pub group_id: Option<i64>,
    /// 去重键：`g:{chat}:{group}`（整组）或 `m:{chat}:{msg}`（单条）。
    #[serde(rename = "itemKey")]
    pub item_key: String,
    /// 任务覆盖的消息号（按缓存顺序）。
    #[serde(rename = "messageIds")]
    pub message_ids: Vec<i64>,
    pub total: i64,
    pub done: i64,
    /// `queued` | `running` | `done` | `cancelled` | `failed` | `interrupted`。
    pub status: String,
    /// 正在缓存的消息号（无则 None）。
    #[serde(rename = "currentId", skip_serializing_if = "Option::is_none")]
    pub current_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    /// 优先级（BUG-277）：越大越先跑；`0` = 未置顶（存量任务一律 0）。
    ///
    /// 语义**不是**抢占：它只决定「单飞 worker 跑完当前任务后**接哪一条**」，
    /// 正在跑的任务不受影响（BUG-257 不弃单）。置顶值由后端算（`max + 1`），
    /// 前端只表达意图（"top": true），不猜数值。
    pub priority: i64,
}

/// 任务是否处于「活跃」态（活跃态由 `cache_task_active_uniq` 保证同 key 唯一）。
pub const CACHE_TASK_ACTIVE_STATES: &str = "('queued', 'running')";

/// 按 `list_cache_tasks`/`get_cache_task` 的 SELECT 列顺序映射一行。
/// 列顺序：id, chat_id, group_id, item_key, items, total, done, status,
///         current_id, error, created_at, updated_at, priority
fn cache_task_from_row(r: &Row) -> libsql::Result<CacheTask> {
    let items: String = r.get(4)?;
    Ok(CacheTask {
        id: r.get(0)?,
        chat_id: r.get(1)?,
        group_id: r.get(2)?,
        item_key: r.get(3)?,
        message_ids: serde_json::from_str(&items).unwrap_or_default(),
        total: r.get(5)?,
        done: r.get(6)?,
        status: r.get(7)?,
        current_id: r.get(8)?,
        error: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        // 老库加列前的行由迁移补成 `DEFAULT 0`；这里再兜一层 `unwrap_or(0)`
        // （列缺失的极端情况不得让「读队列」整条失败）。
        priority: r.get(12).unwrap_or(0),
    })
}

/// `cache_task` 的 SELECT 列清单（与 `cache_task_from_row` 严格同序）。
const CACHE_TASK_COLS: &str = "id, chat_id, group_id, item_key, items, total, done, \
                               status, current_id, error, created_at, updated_at, priority";

/// 队列取序（BUG-277）：**置顶优先，同优先级仍是 FIFO**。
///
/// 为什么必须是**同一份常量**：`next_queued_task`（worker 收尾接续）与
/// `recover_queued_cache_tasks`（重启恢复）是同一条队列的两条入口，各写一遍
/// `ORDER BY` 就一定会漂移 —— 届时「运行中置顶有效、重启后失效」这种只在重启
/// 路径才出现的偏差，几乎不可能被复现（判据 2/3 都要按同一把尺子量）。
const CACHE_TASK_QUEUE_ORDER: &str = "priority DESC, id ASC";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 同 [`now`]，毫秒分辨率——条目级墙钟累计的时基（秒级分辨不出亚秒测试档）。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// v0.4.0 迁移：为已存在的 `media_message` 表补 `media_type` / `msg_date` 列。
///
/// 用 PRAGMA table_info 检查列名后再 ALTER（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS）。
/// 旧行两列为 NULL，前端按 mime_type 兜底判型；回补历史时 upsert 会把新值写回。
async fn migrate_media_message(conn: &Connection) -> libsql::Result<()> {
    let mut rows = conn.query("PRAGMA table_info(media_message)", ()).await?;
    let mut have_type = false;
    let mut have_date = false;
    let mut have_duration = false;
    let mut have_path = false;
    let mut have_group = false;
    let mut have_file_name = false;
    while let Some(r) = rows.next().await? {
        let name: String = r.get(1)?;
        if name == "media_type" {
            have_type = true;
        }
        if name == "msg_date" {
            have_date = true;
        }
        if name == "duration" {
            have_duration = true;
        }
        if name == "file_path" {
            have_path = true;
        }
        if name == "group_id" {
            have_group = true;
        }
        if name == "file_name" {
            have_file_name = true;
        }
    }
    if !have_type {
        conn.execute("ALTER TABLE media_message ADD COLUMN media_type TEXT", ())
            .await?;
    }
    if !have_date {
        conn.execute("ALTER TABLE media_message ADD COLUMN msg_date INTEGER", ())
            .await?;
    }
    if !have_duration {
        conn.execute("ALTER TABLE media_message ADD COLUMN duration INTEGER", ())
            .await?;
    }
    if !have_path {
        conn.execute("ALTER TABLE media_message ADD COLUMN file_path TEXT", ())
            .await?;
    }
    if !have_group {
        conn.execute("ALTER TABLE media_message ADD COLUMN group_id INTEGER", ())
            .await?;
    }
    // BUG-220：消息在 TG 上的原始文件名。入库队列的标题事实源此前只有 caption，
    // 而实测大量视频消息**没有 caption、只有文件名**（`妻善3.mp4`）⇒ 标题恒空 ⇒
    // 前端退回频道名。存下 file_name 后，标题链可 caption → file_name 回退。
    if !have_file_name {
        conn.execute("ALTER TABLE media_message ADD COLUMN file_name TEXT", ())
            .await?;
    }
    Ok(())
}

/// 迁移：为既有的 `cache_task` 补 `priority` 列（BUG-277）。幂等、不删数据。
///
/// **为什么用 `PRAGMA table_info` 探测而不是 `app_setting` 标记键**
/// （`media.rs` 的 `*_MIG` 是另一种先例，那里判的是「这段一次性数据搬运跑过没」）：
/// 标记键记的是「迁移跑过」，而加列要的判据是「列**现在**在不在」——两者会漂移：
/// 列在而标记丢失 ⇒ 再 `ALTER` 一次必然报错（启动即失败）；标记在而列被别的路径
/// 弄丢 ⇒ 静默少一列，取序 SQL 直接炸在运行时。加列的判据本来就在 schema 里，
/// 直接读它，就没有第二种真源，也不存在「标记写了但 ALTER 失败」的中间态。
///
/// `NOT NULL DEFAULT 0` 的存量语义：旧行一律 0 ⇒ 取序退化为 `id ASC`，
/// 与迁移前**逐字一致**（判据 6）。
async fn migrate_cache_task_priority(conn: &Connection) -> libsql::Result<()> {
    let mut rows = conn.query("PRAGMA table_info(cache_task)", ()).await?;
    let mut have_priority = false;
    while let Some(r) = rows.next().await? {
        let name: String = r.get(1)?;
        if name == "priority" {
            have_priority = true;
        }
    }
    if have_priority {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE cache_task ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
        (),
    )
    .await?;
    Ok(())
}

/// 迁移：为 `monitored_channel` 补「已读游标」列 `last_read_message_id`。
///
/// **为什么必须有这一列**：用户 2026-10-19 裁定的条数口径是「自上次点开以来新增」。
/// 没有每频道已读游标时，能算的只有两种假答案——「库里共几条」（累计量，对「有没有
/// 新东西」零信息）和「本轮同步加了几条」（服务端一次拉取的副产品，下一轮就被覆盖）。
///
/// **存量语义：现有库里的消息一律视为已读**（`= MAX(message_id)`）。
/// 若让旧行停在 0，升级后第一眼就是「438 条新内容」——那不是「自上次点开以来」，
/// 是「自开天辟地以来」，用户看到的第一屏就是假的。
async fn migrate_monitored_channel_last_read(conn: &Connection) -> libsql::Result<bool> {
    let mut rows = conn.query("PRAGMA table_info(monitored_channel)", ()).await?;
    let mut have = false;
    while let Some(r) = rows.next().await? {
        let name: String = r.get(1)?;
        if name == "last_read_message_id" {
            have = true;
        }
    }
    if have {
        return Ok(false);
    }
    conn.execute(
        "ALTER TABLE monitored_channel ADD COLUMN last_read_message_id INTEGER NOT NULL DEFAULT 0",
        (),
    )
    .await?;
    conn.execute(
        "UPDATE monitored_channel
            SET last_read_message_id = COALESCE(
                  (SELECT MAX(m.message_id) FROM media_message m
                    WHERE m.channel_id = monitored_channel.channel_id), 0)",
        (),
    )
    .await?;
    Ok(true)
}

/// 迁移：为 `monitor_filter` 补「已读游标」列 `last_read_at`（BUG-330 / TGM-06）。
///
/// 与 `migrate_monitored_channel_last_read` 同坑同解：存量行一律初始化为
/// **迁移时刻 now**（不是 0）。若停在 0，升级后每条既有规则的所有命中都算
/// 「新命中」——那不是「自上次点开以来」，是「自开天辟地以来」。
/// 新库走 schema 里的 `DEFAULT 0`，由 `add_filter` 在建规则时显式写 now
/// （新规则从「全已读」起算，与 BUG-329 新监控频道存量视为已读同口径）。
async fn migrate_monitor_filter_last_read(conn: &Connection) -> libsql::Result<bool> {
    let mut rows = conn.query("PRAGMA table_info(monitor_filter)", ()).await?;
    let mut have = false;
    while let Some(r) = rows.next().await? {
        let name: String = r.get(1)?;
        if name == "last_read_at" {
            have = true;
        }
    }
    if have {
        return Ok(false);
    }
    conn.execute(
        "ALTER TABLE monitor_filter ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0",
        (),
    )
    .await?;
    conn.execute(
        "UPDATE monitor_filter SET last_read_at = ?1",
        params![now()],
    )
    .await?;
    Ok(true)
}

/// 迁移：为 `sync_cursor` 补历史回溯两列（2026-10-22 用户第 2 点）。
///
/// `backfill_before_id` / `backfill_until` 默认 **0 = 不回溯**。这一点是刻意的：
/// 升级不能替用户决定「从今天开始往回拉三个月」——那会在用户毫无察觉的情况下
/// 打出几十轮 Telegram RPC，并把库里塞进他并不想要的历史。回溯必须由用户
/// 在界面上明确指定日期后才开始（`set_backfill`）。
async fn migrate_sync_cursor_backfill(conn: &Connection) -> libsql::Result<bool> {
    let mut rows = conn.query("PRAGMA table_info(sync_cursor)", ()).await?;
    let mut have_before = false;
    let mut have_until = false;
    while let Some(r) = rows.next().await? {
        let name: String = r.get(1)?;
        if name == "backfill_before_id" {
            have_before = true;
        }
        if name == "backfill_until" {
            have_until = true;
        }
    }
    drop(rows);
    if !have_before {
        conn.execute(
            "ALTER TABLE sync_cursor ADD COLUMN backfill_before_id INTEGER NOT NULL DEFAULT 0",
            (),
        )
        .await?;
    }
    if !have_until {
        conn.execute(
            "ALTER TABLE sync_cursor ADD COLUMN backfill_until INTEGER NOT NULL DEFAULT 0",
            (),
        )
        .await?;
    }
    Ok(!(have_before && have_until))
}

/// BUG-194 迁移：把 `dialog_cache` 里**存量**的空/纯空白标题行补成可辨识兜底名。///
/// 只改 `title` 为空的行 ⇒ 天然幂等（第二次执行影响 0 行），且已有 363 条
/// 有名会话一字不动（doc 验收：频道/群组部分不受影响、不回归）。
///
/// 与 `migrate_media_message` / `migrate_cache_task_priority` 同为「打开库时
/// 跑一次、不删数据」的幂等迁移；这里无需 `PRAGMA table_info` 判列，因为
/// 不新增列，只回填既有列的值。
async fn migrate_dialog_cache_blank_titles(conn: &Connection) -> libsql::Result<usize> {
    let mut rows = conn
        .query(
            "SELECT id FROM dialog_cache WHERE title IS NULL OR TRIM(title) = ''",
            (),
        )
        .await?;
    let mut ids = Vec::new();
    while let Some(r) = rows.next().await? {
        ids.push(r.get::<i64>(0)?);
    }
    let n = ids.len();
    for id in ids {
        // 逐行 UPDATE 而非一条 `IN (...)`：兜底名含各自的 id，需按行计算。
        conn.execute(
            "UPDATE dialog_cache SET title = ?1 WHERE id = ?2",
            params![crate::login::unnamed_dialog_title(id), id],
        )
        .await?;
    }
    Ok(n)
}

/// BUG-345 迁移：修复 group id 精度损失污染的**存量** `cache_task` 键。
///
/// 前端曾以 JSON number 收发 group_id（~1.4e16 > JS 2^53 ⇒ `JSON.parse` 丢 1），
/// 活库实证 70 个组键任务里 62 个的 `item_key`/`group_id` 比真值差 1。串界修复
/// （`serialize_group_id_opt`）后新任务恒真值，但存量污染键不修就会与真值**分裂
/// 成两个身份**——同一相册的旧任务再也按真键找不到（前端相册气泡/筛选整组入库
/// 都按真键比对）。修法：按任务首条消息在 `media_message` 里的**真** group_id
/// 重写 `item_key` 与 `group_id` 两列。
///
/// 口径：
///   - 真值取不到的行（首条消息已被清理 / 该行无组）**不动**——宁可保留旧键，
///     也不按猜测写一个身份；
///   - 单行 UPDATE 失败（如撞 `cache_task_active_uniq` 的极端并发）跳过并继续，
///     迁移不阻断启动（自愈性质，同 BUG-304 容错口径）；
///   - 幂等：修过的键再跑是 no-op（判据 = 键已等于真值键）。
async fn repair_group_key_precision(conn: &Connection) -> libsql::Result<usize> {
    let mut rows = conn
        .query(
            "SELECT id, chat_id, item_key, items FROM cache_task WHERE item_key LIKE 'g:%'",
            (),
        )
        .await?;
    // (task_id, chat_id, true_gid)
    let mut pending: Vec<(i64, i64, i64)> = Vec::new();
    while let Some(r) = rows.next().await? {
        let id: i64 = r.get(0)?;
        let chat_id: i64 = r.get(1)?;
        let item_key: String = r.get(2)?;
        let items: String = r.get(3)?;
        let mids: Vec<i64> = serde_json::from_str(&items).unwrap_or_default();
        let Some(first) = mids.first().copied() else {
            continue;
        };
        // 真值唯一来源：首条消息行里的 group_id（行不在 / 无组 ⇒ 不动）。
        let Some(tr) = conn
            .query(
                "SELECT group_id FROM media_message WHERE channel_id = ?1 AND message_id = ?2",
                params![chat_id, first],
            )
            .await?
            .next()
            .await?
        else {
            continue;
        };
        let true_gid: Option<i64> = tr.get(0).ok();
        let Some(true_gid) = true_gid else {
            continue;
        };
        if item_key != format!("g:{chat_id}:{true_gid}") {
            pending.push((id, chat_id, true_gid));
        }
    }
    let mut repaired = 0usize;
    for (id, chat_id, true_gid) in pending {
        let key = format!("g:{chat_id}:{true_gid}");
        match conn
            .execute(
                "UPDATE cache_task SET item_key = ?1, group_id = ?2 WHERE id = ?3",
                params![key, true_gid, id],
            )
            .await
        {
            Ok(_) => repaired += 1,
            Err(e) => {
                eprintln!(
                    "[store] BUG-345: skip repairing cache_task {id} (non-fatal): {e}"
                );
            }
        }
    }
    Ok(repaired)
}

/// 按 `list_messages`/`get_message` 的 SELECT 列顺序映射一行。
/// 列顺序：channel_id, message_id, caption, mime_type, size, downloaded, created_at,
///         media_type, msg_date, duration, file_path, group_id
/// 全局监控搜索命中：消息本体（拍平）+ 所属监控频道标题（前端按频道分组展示用）。
#[derive(Debug, Clone, Serialize)]
pub struct MonitoredMessageHit {
    #[serde(flatten)]
    pub message: StoredMessage,
    #[serde(rename = "channelTitle")]
    pub channel_title: Option<String>,
}

/// 关键词 → `LIKE` 模式（`%kw%`），转义 `\` / `%` / `_`。
///
/// 与 `search_messages` / `search_monitored_messages` 内联的转义规则**逐字相同**，
/// 抽出来只给筛选功能用（既有两条路径不动，避免「顺手统一」变成未审核的行为变更）。
fn like_pattern(q: &str) -> String {
    format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    )
}

fn stored_message_from_row(r: &Row) -> libsql::Result<StoredMessage> {
    Ok(StoredMessage {
        channel_id: r.get(0)?,
        message_id: r.get(1)?,
        caption: r.get(2)?,
        mime_type: r.get(3)?,
        size: r.get(4)?,
        downloaded: r.get::<i64>(5)? != 0,
        created_at: r.get(6)?,
        media_type: r.get(7)?,
        date: r.get(8)?,
        duration: r.get(9)?,
        file_path: r.get(10)?,
        group_id: r.get(11)?,
    })
}

/// 一条消息的两个**标题来源**（BUG-280）：caption 与 file_name 分开带回。
///
/// 为什么不再 COALESCE 成一个值：相册组里 caption 常只挂在靠后的一条消息上
/// （实测组 3373-3380 只有 3378 有），而靠前消息的 `file_name`（`manifest.mp4`）
/// 会在 first-match 选取时抢在真 caption 之前（BUG-280 根因）。调用方需要
/// 「caption 优先、全组都无 caption 才回退 file_name」的**两遍选取**，
/// 两个来源必须分别可读才排得了序。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MsgTitleSources {
    /// caption 的**首行**（队列行直接渲染这段文本；多行 caption 只取首行，
    /// 否则一整段原文会顶在队列标题上）。
    pub caption: String,
    /// 落盘文件名（无 caption 时的兜底，BUG-220）。
    pub file_name: String,
}

/// 取文本首行并 trim（空值/全空白归一为空串）。
fn first_line(s: Option<&str>) -> String {
    s.map(|v| v.split('\n').next().unwrap_or("").trim().to_string())
        .unwrap_or_default()
}

/// 受管根（管理模块多根模型，BUG-323 续 / 用户 2026-10-16 裁定）。
///
/// 下载模块**单根**（`download_root()` 即其生产者输出目录）；管理模块**多根**：
/// 受管根之并集。下载根恒为集合首项、`locked`（不可删）、默认 `primary`
/// （管理视图默认选中）；用户可增删其他根、并把 `primary` 旗移到任意根
/// （只改管理视图默认选中，**不动下载落点**）。
///
/// 存储：用户根集合持久化在 app_setting `managed_roots`（JSON 数组，每项
/// `{path, primary, locked}`）。下载根由 [`Store::download_root`] 派生、
/// 不在该数组里单独存（避免与 daemon 下发的 `download_dir` 双真源）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ManagedRoot {
    pub path: String,
    pub primary: bool,
    pub locked: bool,
}

impl Store {
    /// 打开（不存在则创建）数据库并建表。`path` 传 `":memory:"` 使用纯内存库。
    pub async fn open(path: impl AsRef<Path>) -> libsql::Result<Self> {
        let db_path = path.as_ref().to_path_buf();
        let conn = libsql::Builder::new_local(path).build().await?.connect()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS monitored_channel (
                channel_id INTEGER PRIMARY KEY,
                title      TEXT NOT NULL,
                username   TEXT,
                added_at   INTEGER NOT NULL,
                -- 「自上次点开以来新增」的已读游标（见 MonitoredChannel::new_count）。
                -- 老库没有这列，由 migrate_monitored_channel_last_read 幂等补上。
                last_read_message_id INTEGER NOT NULL DEFAULT 0
            );
            -- 文字筛选规则（每条 = 一条虚拟监控，用户 2026-10-19 裁定）。
            CREATE TABLE IF NOT EXISTS monitor_filter (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                label      TEXT NOT NULL,
                keyword    TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                -- 「自上次点开该规则以来新增」的已读游标（BUG-330 / TGM-06）。
                -- 老库没有这列，由 migrate_monitor_filter_last_read 幂等补上
                -- （存量初始化为迁移时刻 now——不初始化则升级后首屏全是假「新命中」）。
                last_read_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS media_message (
                channel_id INTEGER NOT NULL,
                message_id INTEGER NOT NULL,
                caption    TEXT,
                mime_type  TEXT,
                size       INTEGER,
                downloaded INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                media_type TEXT,
                msg_date   INTEGER,
                duration   INTEGER,
                file_path  TEXT,
                group_id   INTEGER,
                file_name  TEXT,
                PRIMARY KEY (channel_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS sync_cursor (
                channel_id      INTEGER PRIMARY KEY,
                last_message_id INTEGER NOT NULL DEFAULT 0,
                updated_at      INTEGER NOT NULL,
                -- 历史回溯（2026-10-22 用户第 2 点）：0 = 未开始/不回溯。
                -- `backfill_before_id` 是**向旧**翻页的游标（与 `last_message_id`
                -- 方向相反），`backfill_until` 是目标日期（unix 秒，0 = 不回溯）。
                -- 两个游标分开存：增量同步永远只向新，回溯永远只向旧，互不干扰。
                backfill_before_id INTEGER NOT NULL DEFAULT 0,
                backfill_until     INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS dialog_cache (
                id       INTEGER PRIMARY KEY,
                title    TEXT NOT NULL,
                username TEXT,
                folder   TEXT,
                init_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_setting (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cache_task (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id    INTEGER NOT NULL,
                group_id   INTEGER,
                item_key   TEXT    NOT NULL,
                items      TEXT    NOT NULL,
                total      INTEGER NOT NULL,
                done       INTEGER NOT NULL DEFAULT 0,
                status     TEXT    NOT NULL,
                current_id INTEGER,
                dir        TEXT,
                error      TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                -- BUG-277：置顶优先级。越大越先跑；存量/新入队一律 0 ⇒ 顺序不变。
                priority   INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX IF NOT EXISTS cache_task_active_uniq
                ON cache_task(item_key) WHERE status IN ('queued', 'running');
            -- BUG-276：条目级墙钟累计。**跨进程存活**是这张表存在的全部理由 ——
            -- 路由层的 `tokio::time::timeout` 量到的是「这一次尝试」，而 `Instant`
            -- 是进程本地时钟 ⇒ 进程一退，量到的东西就没了；启动恢复又会把任务重新
            -- 入队、重新起一次尝试 ⇒ 每重启一次白送一整个 `wall` 窗口。
            -- 语义：一个「条目」= 一个任务里的一条消息；累计值**不随重启清零**，
            -- 只随任务离开队列（终态 / 取消）回收。
            CREATE TABLE IF NOT EXISTS cache_task_item_wall (
                task_id    INTEGER NOT NULL,
                message_id INTEGER NOT NULL,
                -- 已**结束**的尝试累计烧掉的墙钟（毫秒）。
                accum_ms   INTEGER NOT NULL DEFAULT 0,
                -- 在途尝试的起始时间戳；NULL = 当前没有在途尝试。
                -- 崩在途中的那一次没有「结束事件」，它的时长**不会**并进 accum_ms，
                -- 但会因为 started_at 仍在而继续被算作「在途时长」—— 所以「崩掉」
                -- 不等于「免费重来」。
                started_at INTEGER,
                PRIMARY KEY (task_id, message_id)
            );
            "#,
        )
        .await?;
        // 旧库（v0.3.x）的 media_message 缺 media_type/msg_date：幂等补列，不删数据。
        migrate_media_message(&conn).await?;
        // BUG-341：相册组按 (channel_id, group_id) 的成员扩展查询（筛选命中整组
        // 入列、组级分页的 join）依赖它；无索引时每组一次全表扫。
        // **必须在 migrate_media_message 之后建**：group_id 是老库补的列，建在
        // 补列前 = 旧库每次启动都「no such column: group_id」直接打不开。
        conn.execute(
            "CREATE INDEX IF NOT EXISTS media_message_group_idx
                 ON media_message(channel_id, group_id)",
            (),
        )
        .await?;
        // 旧库的 cache_task 缺 priority：幂等补列，不删数据（BUG-277）。
        migrate_cache_task_priority(&conn).await?;
        // 旧库的 monitored_channel 缺 last_read_message_id：幂等补列 + 存量视为已读。
        migrate_monitored_channel_last_read(&conn).await?;
        // 旧库的 monitor_filter 缺 last_read_at（BUG-330 / TGM-06）：幂等补列 +
        // 存量初始化为迁移时刻 now（不初始化则升级后首屏全是假「新命中」）。
        migrate_monitor_filter_last_read(&conn).await?;
        // 旧库的 sync_cursor 缺回溯两列（2026-10-22 第 2 点）：幂等补列，
        // 默认 0 = 不回溯（升级后行为与升级前逐字一致，不擅自替用户开始回溯）。
        migrate_sync_cursor_backfill(&conn).await?;
        // BUG-194：存量 dialog_cache 里的空标题行回填为可辨识兜底名（幂等）。
        let healed = migrate_dialog_cache_blank_titles(&conn).await?;
        if healed > 0 {
            eprintln!("[store] BUG-194: backfilled {healed} blank dialog_cache titles");
        }
        // BUG-345：修复 group id 精度损失污染的存量 cache_task 键（JS 2^53 舍入，
        // 活库实证 62/70 个组键任务被污染差 1）。幂等；修不了的行跳过不阻断启动。
        let repaired_keys = repair_group_key_precision(&conn).await?;
        if repaired_keys > 0 {
            eprintln!(
                "[store] BUG-345: repaired {repaired_keys} cache_task key(s) corrupted by group-id precision loss"
            );
        }
        // 媒体资料库（内容/剧集/标签）：与 TG 流水同库、职责分离。
        crate::media::migrate(&conn).await?;
        let store = Self { conn, db_path };
        // BUG-304 / D18（用户 2026-10-14 拍板：视频=剧集，永远不存在未归档）：
        // 启动自愈 —— 把「零认领」条目补进剧集。三条入库路径里只有
        // `IngestCtx::ensure_series` 建剧（`register_media_item_t0` 与
        // `import_media_items` 不建，worker 走到第 k 条之前结束就留下永久孤儿，
        // 机制层见 BUG-296）⇒ 孤儿是**结构必然**，必须在每次启动时收敛，
        // 否则「未归档」只是被藏起来，没有被消灭。
        //
        // 失败**不阻断启动**：归集是自愈，不是字节搬运的前提（同 BUG-246 的
        // 「登记失败不阻断入队」容错口径）。
        match store.reconcile_unfiled_items().await {
            Ok((found, created, attached, skipped)) if found > 0 || skipped > 0 => {
                eprintln!(
                    "[store] BUG-304: filed {attached}/{found} episodic zero-claim item(s) into {created} series ({skipped} non-episodic left to their category)"
                );
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("[store] BUG-304: reconcile_unfiled_items failed (non-fatal): {e}");
            }
        }
        // D24-A / BUG-309（M2-T09 · T05 启动对账）：`media_blob.refcount` 是**可重算
        // 派生值**（blob-store-design C5）——崩溃 / 手工改库 / 跨版本升级都可能让它
        // 与「`media_item.content_hash` 的实际引用数」对不上。每次启动重算一次，
        // 使「删最后一个引用才回收字节」的前提在进程起点恒成立。
        // 失败**不阻断启动**（同 BUG-304 的容错口径）。
        //
        // 留痕**无条件打印**（含 0）：`if n > 0` 曾让「库里没有 blob 行」的新库 /
        // 旧库静默通过——而那正是迁移后第一次启动的真实状态，于是日志无法区分
        // 「对账跑了、0 行」与「没接上」（M2-T09 验收盲区）。0 也是证据。
        match store.recount_blobs().await {
            Ok(n) => {
                eprintln!("[store] BUG-309: recounted blob refcounts ({n} blob row(s))");
            }
            Err(e) => {
                eprintln!("[store] BUG-309: recount_blobs failed (non-fatal): {e}");
            }
        }
        Ok(store)
    }

    /// 查询首个结果行；无结果返回 `None`。
    pub(crate) async fn row_opt(&self, sql: &str, p: impl IntoParams) -> libsql::Result<Option<Row>> {
        let mut stmt = self.conn.prepare(sql).await?;
        match stmt.query_row(p).await {
            Ok(row) => Ok(Some(row)),
            Err(libsql::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    // ---- 监控频道 ----

    /// 添加/更新监控频道（同 id 幂等，更新标题/用户名）。
    ///
    /// 新行把已读游标初始化到**该频道当前最大 message_id**：加入监控那一刻库里的东西
    /// 都早于「上一次点开」，不该在加入后立刻变成一片「未读」。
    /// 冲突时**不动**游标 —— 用户读到哪就是哪，改个标题不该让他重看一遍。
    pub async fn add_channel(
        &self,
        channel_id: i64,
        title: &str,
        username: Option<&str>,
    ) -> libsql::Result<()> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO monitored_channel (channel_id, title, username, added_at, last_read_message_id)
                 VALUES (?1, ?2, ?3, ?4,
                         COALESCE((SELECT MAX(m.message_id) FROM media_message m
                                    WHERE m.channel_id = ?1), 0))
                 ON CONFLICT(channel_id) DO UPDATE
                   SET title = excluded.title, username = excluded.username",
                params![channel_id, title, username, t],
            )
            .await?;
        Ok(())
    }

    /// 列出全部监控频道（按添加时间正序），并带出各频道的未读条数。
    pub async fn list_channels(&self) -> libsql::Result<Vec<MonitoredChannel>> {
        let stmt = self
            .conn
            .prepare(
                "SELECT c.channel_id, c.title, c.username, c.added_at,
                        (SELECT COUNT(*) FROM media_message m
                          WHERE m.channel_id = c.channel_id
                            AND m.message_id > c.last_read_message_id),
                        /* BUG-388: COALESCE 必须包住整个标量子查询 —— 空集（该频道还没有
                           sync_cursor 行）的标量子查询返回 NULL，内层 COALESCE
                           包不住「没有行」，r.get::<i64> 读 NULL 即 Null value。 */
                        COALESCE((SELECT sc.backfill_until FROM sync_cursor sc
                          WHERE sc.channel_id = c.channel_id), 0),
                        COALESCE((SELECT sc.backfill_before_id FROM sync_cursor sc
                          WHERE sc.channel_id = c.channel_id), 0),
                        COALESCE((SELECT sc.last_message_id FROM sync_cursor sc
                          WHERE sc.channel_id = c.channel_id), 0),
                        /* BUG-394: 库内最老已入库消息日期（回溯表单默认值真源）。
                           COALESCE 包住整个标量子查询（空集返 NULL，BUG-388 同型）。 */
                        COALESCE((SELECT MIN(COALESCE(m.msg_date, m.created_at)) FROM media_message m
                          WHERE m.channel_id = c.channel_id), 0)
                 FROM monitored_channel c ORDER BY c.added_at",
            )
            .await?;
        let mut rows = stmt.query(()).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(MonitoredChannel {
                channel_id: r.get(0)?,
                title: r.get(1)?,
                username: r.get(2)?,
                added_at: r.get(3)?,
                new_count: r.get(4)?,
                backfill_until: r.get(5)?,
                backfill_before_id: r.get(6)?,
                last_message_id: r.get(7)?,
                oldest_message_date: r.get(8)?,
            });
        }
        Ok(out)
    }

    /// 取单个监控频道。
    pub async fn get_channel(&self, channel_id: i64) -> libsql::Result<Option<MonitoredChannel>> {
        let row = self
            .row_opt(
                "SELECT c.channel_id, c.title, c.username, c.added_at,
                        (SELECT COUNT(*) FROM media_message m
                          WHERE m.channel_id = c.channel_id
                            AND m.message_id > c.last_read_message_id),
                        /* BUG-388: COALESCE 必须包住整个标量子查询 —— 空集（该频道还没有
                           sync_cursor 行）的标量子查询返回 NULL，内层 COALESCE
                           包不住「没有行」，r.get::<i64> 读 NULL 即 Null value。 */
                        COALESCE((SELECT sc.backfill_until FROM sync_cursor sc
                          WHERE sc.channel_id = c.channel_id), 0),
                        COALESCE((SELECT sc.backfill_before_id FROM sync_cursor sc
                          WHERE sc.channel_id = c.channel_id), 0),
                        COALESCE((SELECT sc.last_message_id FROM sync_cursor sc
                          WHERE sc.channel_id = c.channel_id), 0),
                        /* BUG-394: 同 list_channels。 */
                        COALESCE((SELECT MIN(COALESCE(m.msg_date, m.created_at)) FROM media_message m
                          WHERE m.channel_id = c.channel_id), 0)
                 FROM monitored_channel c WHERE c.channel_id = ?1",
                params![channel_id],
            )
            .await?;
        match row {
            Some(r) => Ok(Some(MonitoredChannel {
                channel_id: r.get(0)?,
                title: r.get(1)?,
                username: r.get(2)?,
                added_at: r.get(3)?,
                new_count: r.get(4)?,
                backfill_until: r.get(5)?,
                backfill_before_id: r.get(6)?,
                last_message_id: r.get(7)?,
                oldest_message_date: r.get(8)?,
            })),
            None => Ok(None),
        }
    }

    /// 「点开」= 把已读游标推到该频道当前最大 message_id，未读计数随之归零。
    ///
    /// 用 `MAX(..., last_read_message_id)` 而不是直接赋值：消息被清理过（行删除）
    /// 时 `MAX()` 会变小，直接赋值等于把游标往回倒 ⇒ 已读过的旧消息重新变成「未读」。
    pub async fn mark_channel_read(&self, channel_id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "UPDATE monitored_channel
                    SET last_read_message_id = MAX(
                          COALESCE((SELECT MAX(m.message_id) FROM media_message m
                                     WHERE m.channel_id = ?1), 0),
                          last_read_message_id)
                  WHERE channel_id = ?1",
                params![channel_id],
            )
            .await?;
        Ok(())
    }

    /// 移除监控频道（保留已入库消息，用户仍可下载/播放）。
    pub async fn remove_channel(&self, channel_id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "DELETE FROM monitored_channel WHERE channel_id = ?1",
                params![channel_id],
            )
            .await?;
        self.conn
            .execute(
                "DELETE FROM sync_cursor WHERE channel_id = ?1",
                params![channel_id],
            )
            .await?;
        Ok(())
    }

    // ---- 媒体消息入库 ----

    /// 插入一条媒体消息（同 (channel_id, message_id) 幂等）。
    ///
    /// 冲突时回填 caption/mime/size/type/date/duration（旧行可能缺新列），
    /// 但保留 `downloaded` 标记、落盘路径与首次入库的 `created_at`。
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_message(
        &self,
        channel_id: i64,
        message_id: i64,
        caption: Option<&str>,
        mime_type: Option<&str>,
        size: Option<i64>,
        media_type: Option<&str>,
        msg_date: Option<i64>,
        duration: Option<i64>,
        group_id: Option<i64>,
        file_name: Option<&str>,
    ) -> libsql::Result<()> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO media_message
                   (channel_id, message_id, caption, mime_type, size, downloaded, created_at, media_type, msg_date, duration, group_id, file_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(channel_id, message_id) DO UPDATE SET
                   caption = excluded.caption,
                   mime_type = excluded.mime_type,
                   size = excluded.size,
                   media_type = COALESCE(excluded.media_type, media_message.media_type),
                   msg_date = COALESCE(excluded.msg_date, media_message.msg_date),
                   duration = COALESCE(excluded.duration, media_message.duration),
                   group_id = COALESCE(excluded.group_id, media_message.group_id),
                   file_name = COALESCE(excluded.file_name, media_message.file_name)",
                params![channel_id, message_id, caption, mime_type, size, t, media_type, msg_date, duration, group_id, file_name],
            )
            .await?;
        Ok(())
    }

    /// 消息 caption 批量取（BUG-232 v2）：按频道一次性取回 caption，
    /// 供任务列表在**服务端**拼出行标题。
    ///
    /// 为什么是这里、而不是壳按媒体库条目 by-ref 反查（v1 的错误修法）：
    /// caption 在**消息同步时**就已落 `media_message`，与任务成败无关 ——
    /// failed/queued 的任务同样有标题可显示；按媒体库条目查只覆盖已出成品的任务，
    /// 且把「一次 SQL」变成「每行一次 HTTP + 渲染期补数据」。
    /// 频道数是个位数（任务只跨少数频道），逐频道一次查询，不做 N 次行级查询。
    /// 该消息是否已有**标题来源**（caption 或 file_name 任一非空）。
    ///
    /// BUG-220：`ensure_message_rows` 原先只看「行是否存在」，而 caption 为空的
    /// 行早就存在 ⇒ 永远被跳过 ⇒ 新增的 file_name 补不上。本判据让自愈能识别
    /// 「有行但无标题」，把 file_name 补齐。
    pub async fn message_has_title(&self, channel_id: i64, message_id: i64) -> libsql::Result<bool> {
        let row = self
            .row_opt(
                "SELECT 1 FROM media_message WHERE channel_id = ?1 AND message_id = ?2 \
                 AND (caption IS NOT NULL AND caption <> '' OR file_name IS NOT NULL AND file_name <> '')",
                params![channel_id, message_id],
            )
            .await?;
        Ok(row.is_some())
    }

    /// 消息 caption 批量取（BUG-232 v2）：按频道一次性取回标题来源，
    /// 供任务列表在**服务端**拼出行标题。
    ///
    /// 为什么是这里、而不是壳按媒体库条目 by-ref 反查（v1 的错误修法）：
    /// caption 在**消息同步时**就已落 `media_message`，与任务成败无关 ——
    /// failed/queued 的任务同样有标题可显示；按媒体库条目查只覆盖已出成品的任务，
    /// 且把「一次 SQL」变成「每行一次 HTTP + 渲染期补数据」。
    /// 频道数是个位数（任务只跨少数频道），逐频道一次查询，不做 N 次行级查询。
    ///
    /// BUG-280：caption 与 file_name **分开返回**（见 [`MsgTitleSources`]），
    /// 由调用方做「caption 优先、file_name 兜底」的两遍选取；两者各取**首行**
    /// （队列标题渲染的是单行文本）。
    ///
    /// BUG-220：选取规则仍保留「无 caption 时回退 file_name」——回退发生在
    /// 调用方（`routes::cache_task_title`），这里只负责把两个来源都带回去。
    pub async fn message_captions_for_channels(
        &self,
        channels: &[i64],
    ) -> libsql::Result<std::collections::HashMap<(i64, i64), MsgTitleSources>> {
        let mut out = std::collections::HashMap::new();
        for ch in channels {
            let mut rows = self
                .conn
                .query(
                    "SELECT message_id, caption, file_name \
                     FROM media_message \
                     WHERE channel_id = ?1 \
                       AND (caption IS NOT NULL AND caption <> '' OR file_name IS NOT NULL AND file_name <> '')",
                    params![*ch],
                )
                .await?;
            while let Some(r) = rows.next().await? {
                let mid: i64 = r.get(0)?;
                let cap: Option<String> = r.get(1)?;
                let fname: Option<String> = r.get(2)?;
                out.insert(
                    (*ch, mid),
                    MsgTitleSources {
                        caption: first_line(cap.as_deref()),
                        file_name: first_line(fname.as_deref()),
                    },
                );
            }
        }
        Ok(out)
    }

    /// 按**任务实际涉及的消息**取标题来源（BUG-375）。
    ///
    /// 与 [`Self::message_captions_for_channels`] 的差别只有一个 `message_id IN (...)`，
    /// 但这一项决定了它能不能上轮询路径：
    ///
    /// - 旧查询把该频道**所有**有 caption/file_name 的消息全拉回来。实测 10 个频道
    ///   拉回 **3768 行**、耗时 **33ms** —— 而调用方（任务列表）只用其中几百行。
    /// - 新查询只取任务 `message_ids` 覆盖的那几百行，实测降到亚毫秒级。
    ///
    /// 为什么必须省这 33ms：BUG-375 把 `/api/tg/cache/tasks/all` 的读路径改成内存快照后，
    /// 这三条聚合被移到**写点**（`AppState::refresh_cache_tasks`）。33ms 每次写足以把
    /// 墙钟类用例推过阈值（实测 `wall_clock_accumulates_across_restarts…` 由 3 次重启
    /// 掉到 2 次）—— 写点开销必须低到不影响既有时序，否则「修读路径」会变成「拖慢写路径」。
    ///
    /// 分批（每批 400）防 SQLite 变量数上限；`media_message_group_idx` 覆盖
    /// `(channel_id, message_id)` 前缀，走索引。
    pub async fn message_captions_for_refs(
        &self,
        refs: &[(i64, i64)],
    ) -> libsql::Result<std::collections::HashMap<(i64, i64), MsgTitleSources>> {
        let mut out = std::collections::HashMap::new();
        if refs.is_empty() {
            return Ok(out);
        }
        // 按频道分组：每频道一条 `message_id IN (...)`（频道数是个位数～十位数）。
        let mut by_ch: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
        for (ch, mid) in refs {
            by_ch.entry(*ch).or_default().push(*mid);
        }
        for (ch, mut ids) in by_ch {
            ids.sort_unstable();
            ids.dedup();
            for batch in ids.chunks(400) {
                let placeholders = batch.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!(
                    "SELECT message_id, caption, file_name \
                     FROM media_message \
                     WHERE channel_id = ? AND message_id IN ({placeholders}) \
                       AND (caption IS NOT NULL AND caption <> '' OR file_name IS NOT NULL AND file_name <> '')"
                );
                let mut params: Vec<libsql::Value> = Vec::with_capacity(batch.len() + 1);
                params.push(ch.into());
                for m in batch {
                    params.push((*m).into());
                }
                let mut rows = self.conn.query(&sql, params).await?;
                while let Some(r) = rows.next().await? {
                    let mid: i64 = r.get(0)?;
                    let cap: Option<String> = r.get(1)?;
                    let fname: Option<String> = r.get(2)?;
                    out.insert(
                        (ch, mid),
                        MsgTitleSources {
                            caption: first_line(cap.as_deref()),
                            file_name: first_line(fname.as_deref()),
                        },
                    );
                }
            }
        }
        Ok(out)
    }

    /// 列出某频道已入库消息（新→旧）。
    ///
    /// `before_id` 为历史游标（exclusive）：`Some(id)` 只返回 message_id < id 的行，
    /// 用于聊天式滚到顶部加载更早的一页；`None` 从最新开始。
    pub async fn list_messages(
        &self,
        channel_id: i64,
        before_id: Option<i64>,
        limit: u32,
    ) -> libsql::Result<Vec<StoredMessage>> {
        let (sql, args): (&str, Vec<libsql::Value>) = match before_id {
            None => (
                "SELECT channel_id, message_id, caption, mime_type, size, downloaded, created_at, media_type, msg_date, duration, file_path, group_id
                 FROM media_message WHERE channel_id = ?1
                 ORDER BY message_id DESC LIMIT ?2",
                vec![channel_id.into(), (limit.max(1) as i64).into()],
            ),
            Some(before) => (
                "SELECT channel_id, message_id, caption, mime_type, size, downloaded, created_at, media_type, msg_date, duration, file_path, group_id
                 FROM media_message WHERE channel_id = ?1 AND message_id < ?2
                 ORDER BY message_id DESC LIMIT ?3",
                vec![channel_id.into(), before.into(), (limit.max(1) as i64).into()],
            ),
        };
        let stmt = self.conn.prepare(sql).await?;
        let mut rows = stmt.query(args).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(stored_message_from_row(&r)?);
        }
        Ok(out)
    }

    /// 监控内容查找：按 caption 子串筛**本地已同步**消息（新→旧，`before_id` 游标同 `list_messages`）。
    ///
    /// 只查本地——搜索是查询语义，不做网络回补（回补属浏览语义，把一次搜索放大成
    /// 拉全量历史不可接受）；未同步到的历史段落不保证命中，与列表的降级语义一致。
    /// caption 为 NULL（无文字媒体）不命中。`%`/`_` 按字面匹配（ESCAPE 转义）。
    pub async fn search_messages(
        &self,
        channel_id: i64,
        q: &str,
        before_id: Option<i64>,
        limit: u32,
    ) -> libsql::Result<Vec<StoredMessage>> {
        let pattern = format!(
            "%{}%",
            q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        );
        let (sql, args): (&str, Vec<libsql::Value>) = match before_id {
            None => (
                "SELECT channel_id, message_id, caption, mime_type, size, downloaded, created_at, media_type, msg_date, duration, file_path, group_id
                 FROM media_message WHERE channel_id = ?1 AND caption LIKE ?2 ESCAPE '\\'
                 ORDER BY message_id DESC LIMIT ?3",
                vec![
                    channel_id.into(),
                    pattern.into(),
                    (limit.max(1) as i64).into(),
                ],
            ),
            Some(before) => (
                "SELECT channel_id, message_id, caption, mime_type, size, downloaded, created_at, media_type, msg_date, duration, file_path, group_id
                 FROM media_message WHERE channel_id = ?1 AND caption LIKE ?2 ESCAPE '\\' AND message_id < ?3
                 ORDER BY message_id DESC LIMIT ?4",
                vec![
                    channel_id.into(),
                    pattern.into(),
                    before.into(),
                    (limit.max(1) as i64).into(),
                ],
            ),
        };
        let stmt = self.conn.prepare(sql).await?;
        let mut rows = stmt.query(args).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(stored_message_from_row(&r)?);
        }
        Ok(out)
    }

    /// 监控内容**全局**查找：跨**全部监控频道**按 caption 子串筛本地已同步消息
    /// （新→旧按消息时间）。与 `search_messages`（单频道）的差别只在两点——
    /// 不带 channel_id 过滤、JOIN `monitored_channel` 带出频道标题供分组展示。
    /// 同样只查本地：搜索是查询语义，不做网络回补。
    pub async fn search_monitored_messages(
        &self,
        q: &str,
        limit: u32,
    ) -> libsql::Result<Vec<MonitoredMessageHit>> {
        let pattern = format!(
            "%{}%",
            q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        );
        let stmt = self
            .conn
            .prepare(
                "SELECT m.channel_id, m.message_id, m.caption, m.mime_type, m.size, m.downloaded,
                        m.created_at, m.media_type, m.msg_date, m.duration, m.file_path, m.group_id,
                        c.title
                 FROM media_message m
                 JOIN monitored_channel c ON c.channel_id = m.channel_id
                 WHERE m.caption LIKE ?1 ESCAPE '\\'
                 ORDER BY COALESCE(m.msg_date, m.created_at) DESC, m.message_id DESC
                 LIMIT ?2",
            )
            .await?;
        let mut rows = stmt
            .query(params![pattern, limit.max(1) as i64])
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(MonitoredMessageHit {
                message: stored_message_from_row(&r)?,
                channel_title: r.get(12)?,
            });
        }
        Ok(out)
    }

    /// 列出全部文字筛选规则（按创建顺序），每条带自己的命中条数。
    ///
    /// 命中数逐条查一次：规则数是个位数（用户手建的），而把 keyword 塞进
    /// `LIKE '%' || keyword || '%'` 就丢了 `%`/`_` 的转义——规则里出现下划线时
    /// 会静默变成通配符，命中集合**多出用户没要的东西**。宁可多几条 SQL。
    pub async fn list_filters(&self) -> libsql::Result<Vec<MonitorFilter>> {
        let stmt = self
            .conn
            .prepare("SELECT id, label, keyword, created_at, last_read_at FROM monitor_filter ORDER BY id")
            .await?;
        let mut rows = stmt.query(()).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            let keyword: String = r.get(2)?;
            let last_read_at: i64 = r.get(4)?;
            let hits = self.count_filter_hits(&keyword).await?;
            let new_hits = self.count_filter_new_hits(&keyword, last_read_at).await?;
            out.push(MonitorFilter {
                id: r.get(0)?,
                label: r.get(1)?,
                keyword,
                created_at: r.get(3)?,
                hits,
                new_hits,
            });
        }
        Ok(out)
    }

    /// 单条规则的命中**单元**条数（跨全部监控频道；BUG-341：组内任一 member 的
    /// caption **或** file_name 匹配 ⇒ 整个相册算 1 个单元；无 group_id 的单条
    /// 消息算 1 个）。与 `filter_messages` 的呈现粒度同源——UI 显示组，计数就必须
    /// 数组，否则左栏「命中 200」与面板「25 个相册」永远对不上。
    async fn count_filter_hits(&self, keyword: &str) -> libsql::Result<i64> {
        let row = self
            .row_opt(
                "SELECT
                   (SELECT COUNT(DISTINCT m.channel_id || ':' || m.group_id)
                      FROM media_message m
                      JOIN monitored_channel c ON c.channel_id = m.channel_id
                     WHERE m.group_id IS NOT NULL
                       AND m.caption LIKE ?1 ESCAPE '\\')
                 + (SELECT COUNT(*)
                      FROM media_message m
                      JOIN monitored_channel c ON c.channel_id = m.channel_id
                     WHERE m.group_id IS NULL
                       AND m.caption LIKE ?1 ESCAPE '\\')",
                params![like_pattern(keyword)],
            )
            .await?;
        match row {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 自 `last_read_at` 以来**新增**的命中单元数（BUG-330 / TGM-06；BUG-341 起
    /// 按单元口径）。
    ///
    /// 单元的「新」判据 = **unit_date > last_read_at**，unit_date 取整组最新消息
    /// 时间（与 `filter_messages` 的定序同源）：组里来了新消息（哪怕它自己不匹配），
    /// 这个相册也是「有新东西」——用户看到的是组，不是当初匹配上的那一条。
    ///
    /// **秒粒度边界**（游标与 msg_date 同为 unix 秒）：与点开同一秒内到达的命中
    /// 落在 `>` 边界上不计 +N。消息本身仍在命中列表（费的只是徽标），且监控同步
    /// 30s 一轮、点击是离散动作，同秒碰撞罕见——取 `>` 而不是 `>=`，是为了
    /// 「点开时列表里已有的行一律不算新」（`>=` 会把刚看过的同秒行也算新）。
    async fn count_filter_new_hits(&self, keyword: &str, last_read_at: i64) -> libsql::Result<i64> {
        let row = self
            .row_opt(
                "SELECT COUNT(*) FROM (
                    SELECT g.channel_id, g.group_id
                      FROM (SELECT DISTINCT m.channel_id, m.group_id
                              FROM media_message m
                              JOIN monitored_channel c ON c.channel_id = m.channel_id
                             WHERE m.group_id IS NOT NULL
                               AND m.caption LIKE ?1 ESCAPE '\\') g
                     WHERE (SELECT MAX(COALESCE(x.msg_date, x.created_at))
                              FROM media_message x
                             WHERE x.channel_id = g.channel_id
                               AND x.group_id = g.group_id) > ?2
                    UNION ALL
                    SELECT m.channel_id, m.message_id
                      FROM media_message m
                      JOIN monitored_channel c ON c.channel_id = m.channel_id
                     WHERE m.group_id IS NULL
                       AND m.caption LIKE ?1 ESCAPE '\\'
                       AND COALESCE(m.msg_date, m.created_at) > ?2
                 )",
                params![like_pattern(keyword), last_read_at],
            )
            .await?;
        match row {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 新建（或复用）一条筛选规则，返回 id。
    ///
    /// 同关键词幂等：重复添加只更新显示名，不长出第二条一样的规则——否则用户看到
    /// 两个同名条目、命中数相同，会以为是 bug。
    pub async fn add_filter(&self, label: &str, keyword: &str) -> libsql::Result<i64> {
        if let Some(r) = self
            .row_opt(
                "SELECT id FROM monitor_filter WHERE keyword = ?1",
                params![keyword],
            )
            .await?
        {
            let id: i64 = r.get(0)?;
            self.conn
                .execute(
                    "UPDATE monitor_filter SET label = ?1 WHERE id = ?2",
                    params![label, id],
                )
                .await?;
            return Ok(id);
        }
        // BUG-189：`INSERT ... RETURNING id` 取新 id，不用连接级的 `last_insert_rowid()`
        //（共享连接下并发交错会拿到别人的 rowid）。
        //
        // `last_read_at = ?3`（= now）：新规则从「全已读」起算——创建规则不该把库里
        // **已有的**旧命中一夜之间变成「新命中」（与 BUG-329 新监控频道存量视为
        // 已读同口径：徽标说的是「自那以后的新东西」，不是「自开天辟地以来」）。
        let row = self
            .row_opt(
                "INSERT INTO monitor_filter (label, keyword, created_at, last_read_at)
                 VALUES (?1, ?2, ?3, ?3)
                 RETURNING id",
                params![label, keyword, now()],
            )
            .await?;
        match row {
            Some(r) => r.get(0),
            None => Err(libsql::Error::Misuse("insert monitor_filter returned no id".into())),
        }
    }

    /// 「点开某条规则」= 把已读游标推到**当前命中单元集合的最大 unit_date**，
    /// `new_hits` 随之归零（BUG-330 / TGM-06；BUG-341 起按单元口径）。
    ///
    /// **为什么不像 `mark_channel_read` 那样直接用墙钟 `now()`**：消息的
    /// `msg_date` 是 **TG 服务器时钟**，与本机墙钟有秒级时差是常态；时钟超前时
    /// （或测试里的未来日期），`now()` 置的游标**清不掉**这些行 ⇒ 徽标永远归不了零。
    /// 与频道侧同范式：推到**库里实际存在的最大 message_id**（那里抗时差），这里推到
    /// **当前命中集合里实际存在的最大 unit_date**——「点开」的语义是「列表里现在有
    /// 的我都看过了」，不是「墙钟走到哪了」。
    ///
    /// `MAX(last_read_at, …)` 只进不退：消息被清理（行删除）后命中集合变小，直接赋值
    /// 等于把已读的旧命中重新变成新的；重放/坏时钟同理。
    pub async fn mark_filter_read(&self, id: i64) -> libsql::Result<()> {
        let Some(r) = self
            .row_opt(
                "SELECT keyword FROM monitor_filter WHERE id = ?1",
                params![id],
            )
            .await?
        else {
            return Ok(());
        };
        let keyword: String = r.get(0)?;
        self.conn
            .execute(
                "UPDATE monitor_filter
                    SET last_read_at = MAX(last_read_at, COALESCE(
                          (SELECT MAX(u.unit_date) FROM (
                              SELECT (SELECT MAX(COALESCE(x.msg_date, x.created_at))
                                        FROM media_message x
                                       WHERE x.channel_id = g.channel_id
                                         AND x.group_id = g.group_id) AS unit_date
                                FROM (SELECT DISTINCT m.channel_id, m.group_id
                                        FROM media_message m
                                        JOIN monitored_channel c ON c.channel_id = m.channel_id
                                       WHERE m.group_id IS NOT NULL
                                         AND m.caption LIKE ?1 ESCAPE '\\') g
                              UNION ALL
                              SELECT COALESCE(m.msg_date, m.created_at)
                                FROM media_message m
                                JOIN monitored_channel c ON c.channel_id = m.channel_id
                               WHERE m.group_id IS NULL
                                 AND m.caption LIKE ?1 ESCAPE '\\'
                           ) u),
                          last_read_at))
                  WHERE id = ?2",
                params![like_pattern(&keyword), id],
            )
            .await?;
        Ok(())
    }

    /// 删除一条筛选规则（只删规则，不动已入库消息）。
    pub async fn remove_filter(&self, id: i64) -> libsql::Result<()> {
        self.conn
            .execute("DELETE FROM monitor_filter WHERE id = ?1", params![id])
            .await?;
        Ok(())
    }

    /// 某条筛选规则的命中列表（新→旧，BUG-330 / TGM-05 补预览字段与复合游标；
    /// BUG-341 起**命中单元 = 相册组**）。
    ///
    /// 匹配字段由用户 2026-10-19 裁定：**标题/说明（caption）+ 文件名（file_name）**。
    /// 只查本地已同步消息（查询语义，不做网络回补）；规则不存在返回空集而非报错。
    ///
    /// ## BUG-341：组是命中与分页的单位
    ///
    /// 旧实现逐条匹配：相册的组级 caption 只落在组内**一条**消息上（活库实证：
    /// 满员组 10 条仅 1 条带 caption）⇒ 每个相册只现 1 行、入库只传 1 个
    /// messageId，组结构与组内内容双丢失（用户「强调很多次」的缺陷）。
    ///
    /// 新语义：**组内任一 member 匹配 ⇒ 整组是一个命中单元，组内全部消息入列**；
    /// 无 `group_id` 的单条消息自成单元。分页随之改为**单元级**——游标落在
    /// 「光标消息所属的单元」之后，组永远不会被页边界切成两半（半截组 = 又一类
    /// 「显示单条错误数据」）。
    ///
    /// `before` = 复合游标 `(date, channel_id, message_id)`（上一页最后一行的
    /// 三元组；`date` = `COALESCE(msg_date, created_at)`）。三元组里真正定位的
    /// 只有 `(channel_id, message_id)`——后端据此解析该消息所属单元（有组取组、
    /// 无组取自身），`date` 仅在光标消息已不存在时兜底比较。
    /// `before = None` = 第一页（从最新开始）。
    ///
    /// `limit` 的语义随单元级分页改变：**每页单元数**（相册/单条），不再是消息数。
    pub async fn filter_messages(
        &self,
        filter_id: i64,
        limit: u32,
        before: Option<(i64, i64, i64)>,
    ) -> libsql::Result<Vec<MonitorFilterHit>> {
        let Some(r) = self
            .row_opt(
                "SELECT keyword FROM monitor_filter WHERE id = ?1",
                params![filter_id],
            )
            .await?
        else {
            return Ok(Vec::new());
        };
        let keyword: String = r.get(0)?;
        // 游标条件按「展开式」写而不用行值比较 `(a,b,c) < (?,?,?)`：判据要在旧版
        // libsql 上也能跑，且展开式在 EXPLAIN 下与行值等价。
        // 比较基准是**单元**三元组（unit_date, channel_id, COALESCE(group_id,
        // message_id)）——由 cursor_unit 从光标消息解析；消息不在了则退回传入的
        // (date, channel, message) 直接比（宁可重复半页，不可整页截空）。
        let cursor_sql = if before.is_some() {
            " AND (
                   u.unit_date < COALESCE((SELECT unit_date FROM cursor_unit), ?3)
                OR (u.unit_date = COALESCE((SELECT unit_date FROM cursor_unit), ?3)
                    AND u.channel_id < ?4)
                OR (u.unit_date = COALESCE((SELECT unit_date FROM cursor_unit), ?3)
                    AND u.channel_id = ?4
                    AND COALESCE(u.group_id, u.message_id)
                        < COALESCE((SELECT unit_key FROM cursor_unit), ?5))
               )"
        } else {
            ""
        };
        // 组级分支：先取「有 member 匹配」的组（DISTINCT 防同组多 member 匹配时
        // 重复成多个单元），unit_date 取**整组**最新消息时间（与 UI 显示的相册
        // 日期同源）；最终 join 再按 (channel_id, group_id) 展开全部成员。
        // 单条分支：无 group_id 且自身匹配，单元即消息自身。
        let sql = format!(
            "WITH hit_groups AS (
                SELECT DISTINCT m.channel_id, m.group_id
                  FROM media_message m
                  JOIN monitored_channel c ON c.channel_id = m.channel_id
                 WHERE m.group_id IS NOT NULL
                   AND m.caption LIKE ?1 ESCAPE '\\'
             ),
             hit_units AS (
                SELECT g.channel_id AS channel_id,
                       g.group_id   AS group_id,
                       NULL         AS message_id,
                       (SELECT MAX(COALESCE(x.msg_date, x.created_at))
                          FROM media_message x
                         WHERE x.channel_id = g.channel_id
                           AND x.group_id = g.group_id) AS unit_date
                  FROM hit_groups g
                UNION ALL
                SELECT m.channel_id, NULL, m.message_id,
                       COALESCE(m.msg_date, m.created_at)
                  FROM media_message m
                  JOIN monitored_channel c ON c.channel_id = m.channel_id
                 WHERE m.group_id IS NULL
                   AND m.caption LIKE ?1 ESCAPE '\\'
             ),
             cursor_unit AS (
                SELECT cu.channel_id AS channel_id,
                       cu.unit_date  AS unit_date,
                       COALESCE(cu.group_id, cu.message_id) AS unit_key
                  FROM (SELECT m.channel_id, m.group_id, m.message_id,
                               CASE WHEN m.group_id IS NOT NULL
                                    THEN (SELECT MAX(COALESCE(x.msg_date, x.created_at))
                                            FROM media_message x
                                           WHERE x.channel_id = m.channel_id
                                             AND x.group_id = m.group_id)
                                    ELSE COALESCE(m.msg_date, m.created_at)
                               END AS unit_date
                          FROM media_message m
                         WHERE m.channel_id = ?4 AND m.message_id = ?5) cu
             ),
             page_units AS (
                SELECT u.channel_id AS channel_id,
                       u.group_id   AS group_id,
                       u.message_id AS message_id,
                       u.unit_date  AS unit_date,
                       COALESCE(u.group_id, u.message_id) AS unit_key
                  FROM hit_units u
                 WHERE 1=1{cursor_sql}
                 ORDER BY u.unit_date DESC, u.channel_id DESC,
                          COALESCE(u.group_id, u.message_id) DESC
                 LIMIT ?2
             )
            SELECT m.channel_id, m.message_id, m.caption, m.file_name, m.media_type,
                   m.size, m.duration, m.msg_date, m.downloaded, c.title, m.group_id,
                   m.mime_type, m.file_path
              FROM page_units u
              JOIN media_message m
                ON m.channel_id = u.channel_id
               AND ((u.group_id IS NOT NULL AND m.group_id = u.group_id)
                 OR (u.group_id IS NULL AND m.message_id = u.message_id))
              JOIN monitored_channel c ON c.channel_id = m.channel_id
             ORDER BY u.unit_date DESC, u.channel_id DESC, u.unit_key DESC,
                      m.message_id DESC"
        );
        let stmt = self.conn.prepare(&sql).await?;
        // 参数恒为 5 个：SQL 里的 cursor_unit CTE 无条件引用 ?4/?5（无游标时它解析
        // 不到行 = 空集，而 cursor_sql 也不含比较条件）。无游标传 (0,0) 哨兵——
        // message_id 0 在 Telegram 不存在 ⇒ cursor_unit 恒空，绝不可能误中一行。
        let mut rows = match before {
            Some((d, c, m)) => {
                stmt.query(params![
                    like_pattern(&keyword),
                    limit.clamp(1, 500) as i64,
                    d,
                    c,
                    m
                ])
                .await?
            }
            None => {
                stmt.query(params![
                    like_pattern(&keyword),
                    limit.clamp(1, 500) as i64,
                    0i64,
                    0i64,
                    0i64
                ])
                .await?
            }
        };
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(MonitorFilterHit {
                channel_id: r.get(0)?,
                message_id: r.get(1)?,
                caption: r.get(2)?,
                file_name: r.get(3)?,
                media_type: r.get(4)?,
                size: r.get(5)?,
                duration: r.get(6)?,
                date: r.get(7)?,
                downloaded: r.get::<i64>(8)? != 0,
                channel_title: r.get(9)?,
                group_id: r.get(10)?,
                mime_type: r.get(11)?,
                file_path: r.get(12)?,
            });
        }
        Ok(out)
    }

    /// 取单条已入库消息。
    pub async fn get_message(
        &self,
        channel_id: i64,
        message_id: i64,
    ) -> libsql::Result<Option<StoredMessage>> {
        let row = self
            .row_opt(
                "SELECT channel_id, message_id, caption, mime_type, size, downloaded, created_at, media_type, msg_date, duration, file_path, group_id
                 FROM media_message WHERE channel_id = ?1 AND message_id = ?2",
                params![channel_id, message_id],
            )
            .await?;
        match row {
            Some(r) => Ok(Some(stored_message_from_row(&r)?)),
            None => Ok(None),
        }
    }

    /// 标记某条消息已下载并记录落盘路径。
    ///
    /// `file_path` 传 `None` 时仅置位 downloaded，保留已有路径。
    pub async fn mark_downloaded(
        &self,
        channel_id: i64,
        message_id: i64,
        file_path: Option<&str>,
    ) -> libsql::Result<()> {
        // upsert 语义：未监控频道（在线浏览）的消息库中无行，下载成功后也要入库，
        // 否则缓存状态只存在于前端内存，刷新即丢（「刷新无状态」根因之一）。
        self.conn
            .execute(
                "INSERT INTO media_message (channel_id, message_id, downloaded, file_path, created_at)
                 VALUES (?1, ?2, 1, ?3, ?4)
                 ON CONFLICT(channel_id, message_id) DO UPDATE SET
                    downloaded = 1,
                    file_path = COALESCE(?3, file_path)",
                params![channel_id, message_id, file_path, now()],
            )
            .await?;
        Ok(())
    }

    // ---- 运行时设置（key-value，覆盖 env 默认值；缓存下载目录等） ----

    /// 读设置项；不存在返回 None。
    pub async fn get_setting(&self, key: &str) -> libsql::Result<Option<String>> {
        let row = self
            .row_opt(
                "SELECT value FROM app_setting WHERE key = ?1",
                params![key],
            )
            .await?;
        Ok(row.map(|r| r.get::<String>(0)).transpose()?)
    }

    /// 写设置项（upsert）。
    pub async fn set_setting(&self, key: &str, value: &str) -> libsql::Result<()> {
        self.conn
            .execute(
                "INSERT INTO app_setting (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .await?;
        Ok(())
    }

    // ---- 单一受管根（byte-ownership P2；BUG-323 用户裁定 2026-10-16） ----
    //
    // 规则：**下载路径是所有文件的唯一容器与权限边界，库根从属于它**。
    // 库根因此不再是独立配置项，而是 `<下载路径>/library` 的派生值 ——
    // 「库根跑到下载路径之外」在结构上不可表达（用户：让错误状态不可表达）。

    /// 库根在**引擎工作区**下的子目录名。
    ///
    /// 2026-10-21 用户裁定「内部文件不入治理」：引擎自有物一律收进 `.orighub/`，
    /// 下载根顶层只留用户内容。这样「成品扫描」只需排除 `.` 开头的条目就是**结构性**
    /// 正确，不再依赖 `library`/`.orighub` 这种名字白名单 —— 白名单注定漏（实测
    /// 顶层一个 `_backup_store_before_move.db` 就漏进了文件管理）。
    pub const LIBRARY_SUBDIR: &str = orig_core::paths::LIBRARY_DIR_NAME;

    /// 引擎工作区子目录名（`<下载路径>/.orighub`，隐藏，不进库、不进成品扫描）。
    pub const ENGINE_SUBDIR: &str = orig_core::paths::ENGINE_DIR_NAME;

    /// 存量搬迁落点：旧默认下载目录（`<TG 数据目录>/downloads`）里的字节搬到这里。
    ///
    /// 为什么保留一个独立子目录而不是摊在下载根上：这些是**缓存成品**，
    /// 与归仓条目（`library/`）分属两个视图；摊平会让下载根一眼望去全是历史文件。
    pub const LEGACY_DOWNLOADS_SUBDIR: &str = "legacy-downloads";

    /// 下载路径（受管根 / 权限边界）。解析链：
    ///   1. env `ORIG_TG_DOWNLOAD_DIR`（容器/CI/sidecar 注入，最高优先）；
    ///   2. app_setting `download_dir`（daemon 下发 / `PUT /api/tg/config` 写入）；
    ///   3. 平台默认下载目录（`orig_core::paths::default_download_dir()`）。
    ///
    /// 与 `routes::effective_download_dir` 同源同序，两处都过 `expand_tilde`
    /// （用户可能手输 `~`，BUG-071 同款）。
    ///
    /// **BUG-323 复报（2026-10-19）**：返回值一律过 `normalize_dir` ——
    /// 活栈实测存量的 `download_dir` 是 `D://OrigDown`（双斜杠，无人输入过的形态），
    /// 而前缀比较/边界判定/DB 改写全是字符串语义 ⇒ 读取侧归一化让存量污染值
    /// 无需手工改库即恢复单一形态（`D:/OrigDown`）。
    ///
    /// **C 盘禁用（用户 2026-10-19 裁定）**：「禁止往C盘写入任何数据,所有内容应该写D盘」，
    /// 且明确「~/Downloads是默认设置,但是不使用,改用加载配置的D盘设置」。
    /// ⇒ 第三级只是**名义默认**：解析结果一旦落在禁用盘（`C:`），改取 D 盘内容根
    /// `orig_core::paths::content_root()` 并打日志。前两级是显式配置，若用户（或 env）
    /// 显式把路径填成 `C:`，同样照规则改道 —— 规则是「不往 C 盘写」，不是「尊重
    /// 一个填错的配置」。daemon 侧 `config::effective_download_root` 同一规则。
    pub async fn download_root(&self) -> PathBuf {
        let raw = if let Ok(v) = std::env::var("ORIG_TG_DOWNLOAD_DIR") {
            if v.trim().is_empty() {
                None
            } else {
                Some(v)
            }
        } else {
            None
        };
        let raw = match raw {
            Some(v) => v,
            None => match self.get_setting("download_dir").await {
                Ok(Some(v)) if !v.trim().is_empty() => v,
                _ => return self.default_content_root(),
            },
        };
        let norm = norm_root(&orig_core::paths::expand_tilde(raw.trim()));
        if orig_core::paths::is_forbidden_content_drive(&norm) {
            let redirected = self.default_content_root();
            tracing::warn!(
                target: "orig_tg::store",
                "download root {} is on a forbidden content drive; using {} instead \
                 (ruling: all content goes to the D: drive)",
                norm.display(),
                redirected.display()
            );
            return redirected;
        }
        norm
    }

    /// 名义默认值过禁用盘规则后的**实际内容根**（用户 2026-10-19 裁定）。
    fn default_content_root(&self) -> PathBuf {
        let d = norm_root(&orig_core::paths::default_download_dir());
        if orig_core::paths::is_forbidden_content_drive(&d) {
            orig_core::paths::content_root()
        } else {
            d
        }
    }

    /// 库根 = `<下载路径>/library` —— **派生值，不可独立配置**（BUG-323）。
    ///
    /// 已废的历史链：env `ORIG_TG_LIBRARY_DIR` → app_setting `library_dir` →
    /// config.json `libraryDir` → `<TG 数据目录>/library`。后三级都能把库根指到
    /// 下载路径之外（末级更是应用内部目录，Explorer 不显示），而 `media_item`
    /// 里已按旧根写死过绝对路径 ⇒ 归仓字节与用户可见的下载目录彻底分家。
    /// 用户 2026-10-16 裁定「库根跟下载走、所有文件不允许脱离下载路径、下载路径是
    /// 所有权限的限制路径」，故改为派生。
    ///
    /// env `ORIG_TG_LIBRARY_DIR` 保留为**运维覆盖**（容器/CI 里下载路径可能不在本机），
    /// 不是用户面配置：设置页不暴露、`PUT /api/tg/config` 拒绝写入。
    pub async fn library_root(&self) -> PathBuf {
        if let Ok(v) = std::env::var("ORIG_TG_LIBRARY_DIR") {
            if !v.trim().is_empty() {
                return norm_root(&orig_core::paths::expand_tilde(v.trim()));
            }
        }
        Self::default_library_root(&self.download_root().await)
    }

    /// 纯函数形式（供不可 async 的调用点与单测）：`<下载路径>/.orighub/library`。
    ///
    /// 库根住在引擎工作区之内 —— 下载根顶层只留用户内容（2026-10-21 裁定）。
    /// 派生规则本身在 `orig_core::paths::library_root_of`，daemon 侧调同一个函数。
    ///
    /// **派生后必须再归一化**（BUG-356/357 同款）：`download_root()` 返回的是正向
    /// 斜杠形态（`D:/OrigDown`），Windows 上对带 `/` 的基路径 `join` 会拼出混合分隔符
    /// （`D:/OrigDown\.orighub\library`）⇒ 与 daemon 侧 `config::library_root()` 的
    /// 字面形态不一致，而边界判定/前端「库根」行都按字符串比较。多一级 join 就多一次
    /// 混合斜杠的机会，故在这里统一。
    pub fn default_library_root(download_root: &Path) -> PathBuf {
        orig_core::paths::normalize_dir_path(&orig_core::paths::library_root_of(download_root))
    }

    /// 存量搬迁：`<下载路径>/library` → `<下载路径>/.orighub/library`。
    ///
    /// 幂等：目标已存在则什么都不做（宁可留着旧目录让人工判断，也不合并两份库）。
    /// 同卷 `rename` 是原子的、不搬字节；跨卷（用户把下载根换过盘）才退化为复制。
    ///
    /// 为什么必须在启动时做：库根的相对路径（`media_item.file_path` 是库根相对的）
    /// 只有在**整根一起移动**时才保持有效；漏搬会让整个媒体库指向不存在的文件。
    pub fn migrate_library_into_engine_dir(download_root: &Path) {
        let old = download_root.join(Self::LIBRARY_SUBDIR);
        let new = Self::default_library_root(download_root);
        if !old.is_dir() {
            return;
        }
        if new.exists() {
            // 两代落点并存：合并需要逐项冲突判定（同名不覆盖），不是启动期该做的
            // 静默动作 —— 留着旧目录并**明确告警**，别让它无声无息地消失。
            tracing::warn!(
                target: "orig_tg::store",
                "both library layouts exist ({} and {}); keeping both, merge manually",
                old.display(),
                new.display()
            );
            return;
        }
        if let Some(parent) = new.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::rename(&old, &new) {
            Ok(()) => tracing::info!(
                target: "orig_tg::store",
                "library moved into engine dir: {} -> {}",
                old.display(),
                new.display()
            ),
            Err(e) => tracing::warn!(
                target: "orig_tg::store",
                "library move failed ({} -> {}): {e}; keeping old location",
                old.display(),
                new.display()
            ),
        }
    }

    /// 完整受管根集合：下载根（locked，primary 取存储值或默认 true）+ 用户根。
    pub async fn managed_roots(&self) -> Vec<ManagedRoot> {
        // 出参形态必须与用户根一致（用户根在 `user_managed_roots` 里已被
        // `normalize_dir` 收敛成 `/`）。这里原来是 `to_string_lossy()` ⇒
        // 同一个 `managed_roots` 数组里下载根是 `D:\OrigDown`、用户根是
        // `D:/Other`，前端按字符串去重/比较全部失效（2026-10-22 报）。
        let download_root = orig_core::paths::to_wire(&self.download_root().await);
        let user_roots = self.user_managed_roots().await;
        // 任一用户根标 primary ⇒ 下载根降级为非 primary。
        let download_primary = !user_roots.iter().any(|r| r.primary);
        let mut roots = vec![ManagedRoot {
            path: download_root,
            primary: download_primary,
            locked: true,
        }];
        roots.extend(user_roots);
        roots
    }

    async fn user_managed_roots(&self) -> Vec<ManagedRoot> {
        let raw = match self.get_setting("managed_roots").await {
            Ok(Some(v)) => v,
            _ => return vec![],
        };
        serde_json::from_str::<Vec<ManagedRoot>>(&raw)
            .unwrap_or_default()
            .into_iter()
            .map(|mut r| {
                r.locked = false; // 用户根永不可 locked
                r.path = orig_core::paths::normalize_dir(&r.path); // BUG-323 复报：单一字面形态
                r
            })
            .collect()
    }

    async fn set_user_managed_roots(&self, roots: &[ManagedRoot]) -> Result<(), String> {
        let json = serde_json::to_string(roots).map_err(|e| e.to_string())?;
        self.set_setting("managed_roots", &json)
            .await
            .map_err(|e| e.to_string())
    }

    /// 新增受管根（去重；与下载根重复或与已登记根重复均幂等）。
    pub async fn add_managed_root(&self, path: &Path) -> Result<(), String> {
        let p = orig_core::paths::normalize_dir(
            &orig_core::paths::expand_tilde(&path.to_string_lossy()).to_string_lossy(),
        );
        if !Path::new(&p).is_absolute() {
            return Err("managed root must be an absolute path".into());
        }
        if paths_equal(Path::new(&p), &self.download_root().await) {
            return Ok(()); // 下载根已恒在集合里
        }
        let mut roots = self.user_managed_roots().await;
        if roots.iter().any(|r| paths_equal(Path::new(&r.path), Path::new(&p))) {
            return Ok(());
        }
        // 允许预创建（目录尚不存在也接受，便于先登记再导入）。
        let _ = tokio::fs::create_dir_all(&p).await;
        roots.push(ManagedRoot {
            path: p,
            primary: false,
            locked: false,
        });
        self.set_user_managed_roots(&roots).await
    }

    /// 删除受管根（locked/下载根 不可删；不存在则幂等）。
    pub async fn remove_managed_root(&self, path: &Path) -> Result<(), String> {
        let p = orig_core::paths::expand_tilde(&path.to_string_lossy())
            .to_string_lossy()
            .into_owned();
        // 下载根恒为 locked，不可删（显式拒绝，而非当未登记静默成功）。
        if paths_equal(Path::new(&p), &self.download_root().await) {
            return Err("the download root is locked and cannot be removed".into());
        }
        let mut roots = self.user_managed_roots().await;
        let before = roots.len();
        roots.retain(|r| !paths_equal(Path::new(&r.path), Path::new(&p)));
        if roots.len() == before {
            return Ok(()); // 未登记 → 幂等
        }
        // 删掉的若是 primary，managed_roots() 会自动令下载根回退 primary。
        self.set_user_managed_roots(&roots).await
    }

    /// 设置主根：把 `primary` 旗移到指定路径（必须是已登记受管根，含下载根）。
    pub async fn set_primary_root(&self, path: &Path) -> Result<(), String> {
        let p = orig_core::paths::expand_tilde(&path.to_string_lossy())
            .to_string_lossy()
            .into_owned();
        let download_root = self.download_root().await;
        let mut roots = self.user_managed_roots().await;
        let mut found = paths_equal(Path::new(&p), &download_root);
        for r in roots.iter_mut() {
            if paths_equal(Path::new(&r.path), Path::new(&p)) {
                r.primary = true;
                found = true;
            } else {
                r.primary = false;
            }
        }
        if !found {
            return Err("path is not a registered managed root".into());
        }
        self.set_user_managed_roots(&roots).await
    }


    /// 历史库根（BUG-323 之前的解析链末端）—— **仅供迁移识别**，不参与任何解析。
    ///
    /// 链：app_setting `library_dir` → config.json `libraryDir` → `<TG 数据目录>/library`。
    /// 三者皆空/不存在时返回 `None`。
    pub async fn legacy_library_root(&self) -> Option<PathBuf> {
        if let Ok(Some(v)) = self.get_setting("library_dir").await {
            if !v.trim().is_empty() {
                return Some(orig_core::paths::expand_tilde(v.trim()));
            }
        }
        if let Some(v) = Self::config_json_library_dir(&self.db_path) {
            return Some(v);
        }
        let base = self
            .db_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let p = base.join(Self::LIBRARY_SUBDIR);
        p.is_dir().then_some(p)
    }

    /// 读 config.json 的 `libraryDir`（缺文件/缺键/解析失败 → None，不阻断）。
    ///
    /// BUG-323：该键已**不再**参与库根解析（库根是下载路径的派生值），
    /// 保留读取只为让 [`Self::legacy_library_root`] 认出历史落点以便迁移。
    pub fn config_json_library_dir(db_path: &Path) -> Option<PathBuf> {
        let base = db_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let raw = std::fs::read_to_string(base.join("config.json")).ok()?;
        let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let dir = v.get("libraryDir")?.as_str()?.trim();
        if dir.is_empty() {
            return None;
        }
        Some(orig_core::paths::expand_tilde(dir))
    }

    /// 存量受管根迁移（BUG-323）：把**引擎自己写过的旧落点**里的字节**移动**进
    /// 下载路径，并把 DB 里仍指向旧落点的绝对路径改写过去。
    ///
    /// 为什么必须做：库根改为派生值后，旧根下的存量字节会整片失联 ——
    /// 「库根相对路径」的条目在新根下解析不到（等价字节缺失），绝对路径条目则被
    /// 权限闸门 403（`resolve_managed_path`）。规则落地不能以用户数据失联为代价。
    ///
    /// **不搬什么**：用户**外部导入**的引用（`POST /api/media/items` 里的本地路径）
    /// 不在此列 —— 那是用户自己的文件，引擎既不搬别人的东西，也不替用户搬家的账。
    ///
    /// 纪律：
    /// - **只移动、不留副本**（用户裁定「归仓用移动」+「无重复存储」）；
    /// - **绝不覆盖**目标已存在的同名项（跳过并计数，冲突交给用户判断）；
    /// - 同卷 `rename` 优先（瞬时、原子）；跨卷退化为 copy + **校验大小** + 删源；
    /// - 幂等：旧落点不存在/为空/与新落点互含 ⇒ 跳过，不做任何事；
    /// - 失败**不阻断启动**（返回 Err 由调用方记日志，源字节仍在原处）。
    pub async fn migrate_legacy_managed_roots(&self) -> Result<Option<LegacyMigration>, String> {
        let mut roots: Vec<RootMigration> = Vec::new();
        for (name, from, to) in self.legacy_managed_roots().await {
            if !from.is_dir() || paths_equal(&from, &to) {
                continue;
            }
            // 旧新互含时移动会自我吞噬（搬进去又搬出来）—— 直接跳过，交给人工判断。
            if crate::cache::path_within(&from, &to) || crate::cache::path_within(&to, &from) {
                continue;
            }
            let mut moved = 0usize;
            let mut skipped = 0usize;
            move_dir_contents(&from, &to, 0, &mut moved, &mut skipped)?;
            if moved == 0 && skipped == 0 {
                continue;
            }
            let rewritten = self.rewrite_path_prefix(&from, &to).await?;
            if skipped == 0 {
                // 全部搬走 ⇒ 收尾：移除旧目录（`remove_dir` **只对空目录成功**，
                // 有意外内容也不会被删）并清掉历史 setting。
                let _ = std::fs::remove_dir(&from);
                if name == "library" {
                    let _ = self.set_setting("library_dir", "").await;
                }
            }
            // 有跳过项时**保留**来源标记：下次启动重试（用户处理完同名冲突后自动收尾），
            // 静默丢弃冲突项等于替用户做减法。
            roots.push(RootMigration {
                name: name.to_string(),
                from: from.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
                moved,
                skipped,
                rewritten,
            });
        }
        if roots.is_empty() {
            return Ok(None);
        }
        Ok(Some(LegacyMigration { roots }))
    }

    /// 上次已知下载根（app_setting `last_download_root`）—— 变更检测与断点续迁的锚。
    async fn last_download_root(&self) -> Option<PathBuf> {
        match self.get_setting("last_download_root").await {
            Ok(Some(v)) if !v.trim().is_empty() => {
                Some(norm_root(&orig_core::paths::expand_tilde(v.trim())))
            }
            _ => None,
        }
    }

    async fn set_last_download_root(&self, p: &Path) {
        let _ = self
            .set_setting("last_download_root", &p.to_string_lossy())
            .await;
    }

    /// 下载根**运行中变更**的存量迁移（BUG-323 复报，2026-10-19）。
    ///
    /// 为什么必须做：`migrate_legacy_managed_roots` 只跑在 orig-tg **启动时**且只认
    /// 固定的历史落点。用户在设置里把下载路径从 A 改到 B 之后：
    /// - 库根**相对路径**记录（132 条实测）解析到空的 `<B>/library` ⇒ 整片失联；
    /// - 绝对路径记录被新边界闸门 403；
    /// 用户观感即「路径选了完全无效」（原话）。本函数补上「变更即迁移」。
    ///
    /// 迁移内容（旧根 A → 新根 B）：
    /// ① `<A>/.orighub/library`（现布局）与 `<A>/library`（旧布局）→ `<B>/.orighub/library`
    ///    （归仓字节；相对记录随之自动恢复）；
    /// ② `<A>/legacy-downloads` → `<B>/legacy-downloads`（旧搬迁落点里的缓存成品）；
    /// ③ A 顶层的**普通文件**（引擎下载成品）→ `<B>/legacy-downloads`；
    /// ④ DB 绝对路径前缀 A→B 改写（`media_item` / `media_message` / `cache_task`）。
    ///
    /// 不搬：`.orighub`（转码代理，可再生缓存，按需重转）与未知子目录（可能是用户
    /// 自己放的）—— 引擎不替用户搬家，也不偷用户的目录。
    ///
    /// 纪律与 `migrate_legacy_managed_roots` 相同：只移动、绝不覆盖、同卷 rename
    /// 优先、幂等。**断点续迁**：有同名冲突（skipped>0）时保留旧锚点，下次启动
    /// 或下次变更自动重试；用户处理完冲突后无需任何操作即收尾。
    pub async fn migrate_root_change(&self) -> Result<Option<RootMigration>, String> {
        let new_root = self.download_root().await;
        let new_s = new_root.to_string_lossy().into_owned();
        let Some(old_root) = self.last_download_root().await else {
            // 无锚点 = 升级后首跑 / 全新安装：只记账不迁移。
            // （存量由 `migrate_legacy_managed_roots` 在启动时按固定落点处理。）
            self.set_last_download_root(&new_root).await;
            return Ok(None);
        };
        if paths_equal(&old_root, &new_root) {
            // 等价但字面不同（如存量 `D://OrigDown` vs 归一化 `D:/OrigDown`）时
            // 同步锚点值，不触发迁移。
            self.set_last_download_root(&new_root).await;
            return Ok(None);
        }
        // 旧新互含时移动会自我吞噬 —— 跳过并记账，交给人工判断。
        if crate::cache::path_within(&old_root, &new_root)
            || crate::cache::path_within(&new_root, &old_root)
        {
            tracing::warn!(
                target: "orig_tg::store",
                "download root change {} -> {} skipped: roots contain each other",
                old_root.display(),
                new_root.display()
            );
            self.set_last_download_root(&new_root).await;
            return Ok(None);
        }
        let mut moved = 0usize;
        let mut skipped = 0usize;
        let mut touched = false;
        // ① 旧库根 → 新库根
        //
        // 2026-10-21「内部文件不入治理」把库根从 `<根>/library` 挪进
        // `<根>/.orighub/library`。所以**旧根上的库可能有两代落点**：
        // 新版 `.orighub/library`（本轮之后）与旧版 `library`（迁移前装机）。
        // 两个都要搬 —— 只认新版会让「升级前改过下载根」的用户整库失联
        // （相对路径记录在新根下解析不到 = 媒体库整片「无字节」）。
        let new_lib = self.library_root().await;
        for old_lib in [
            Self::default_library_root(&old_root),
            old_root.join(Self::LIBRARY_SUBDIR),
        ] {
            if old_lib.is_dir() && !paths_equal(&old_lib, &new_lib) {
                let before = moved + skipped;
                move_dir_contents(&old_lib, &new_lib, 0, &mut moved, &mut skipped)?;
                // `touched` 只认**真的搬/跳过过东西**：上一轮搬完会留下空目录，
                // 空目录不算「有迁移」——否则第二次调用照样报 Some，幂等判据失效。
                if moved + skipped > before {
                    touched = true;
                }
            }
        }
        // ② 旧 legacy-downloads → 新 legacy-downloads
        let old_ld = old_root.join(Self::LEGACY_DOWNLOADS_SUBDIR);
        let new_ld = new_root.join(Self::LEGACY_DOWNLOADS_SUBDIR);
        if old_ld.is_dir() && !paths_equal(&old_ld, &new_ld) {
            move_dir_contents(&old_ld, &new_ld, 0, &mut moved, &mut skipped)?;
            touched = true;
        }
        // ③ 旧根顶层的普通文件 → 新 legacy-downloads（跳过已知子目录与引擎工作区）
        if let Ok(rd) = std::fs::read_dir(&old_root) {
            for ent in rd.flatten() {
                let src = ent.path();
                let name = ent.file_name().to_string_lossy().into_owned();
                if name == Self::LIBRARY_SUBDIR
                    || name == Self::LEGACY_DOWNLOADS_SUBDIR
                    || name == Self::ENGINE_SUBDIR
                {
                    continue;
                }
                if !src.is_file() {
                    continue; // 未知子目录：不搬
                }
                let dst = new_ld.join(&name);
                if dst.exists() {
                    skipped += 1;
                    continue;
                }
                move_one(&src, &dst, false)?;
                moved += 1;
                touched = true;
            }
        }
        if !touched {
            // 旧根没有引擎写盘内容（纯记账场景）：直接更新锚点。
            self.set_last_download_root(&new_root).await;
            return Ok(None);
        }
        let rewritten = self.rewrite_path_prefix(&old_root, &new_root).await?;
        if skipped == 0 {
            self.set_last_download_root(&new_root).await;
        }
        // skipped>0 ⇒ 锚点保留旧值，下次启动/变更重试（见方法文档）。
        Ok(Some(RootMigration {
            name: "root-change".to_string(),
            from: old_root.to_string_lossy().into_owned(),
            to: new_s,
            moved,
            skipped,
            rewritten,
        }))
    }

    /// 引擎写过的**旧落点**清单：`(名字, 旧根, 新根)`（BUG-323）。
    ///
    /// 只列引擎自己写过的目录：① 旧库根（应用内部目录）；② 旧默认下载目录
    /// `<TG 数据目录>/downloads`。二者的共同点是「字节由引擎落盘」，故规则要求它们
    /// 住在下载路径之内；用户外部导入的引用不在此列。
    ///
    /// **刻意不含平台默认下载目录（`~/Downloads`）下的旧落点** —— 那两处由
    /// [`Self::migrate_platform_default_legacy_roots`] 单独处理。把它们混进来的
    /// 后果见 BUG-325：单测会把**真实家目录里的 24 GB 媒体**搬进 %TEMP% 夹具
    /// （`default_download_dir()` 在测试进程里同样解析到真家目录，测试无法把它
    /// 指到别处）。「可由单测触达」与「必须只由启动路径触达」必须分开。
    async fn legacy_managed_roots(&self) -> Vec<(&'static str, PathBuf, PathBuf)> {
        let dl = self.download_root().await;
        let mut out: Vec<(&'static str, PathBuf, PathBuf)> = Vec::new();
        if let Some(from) = self.legacy_library_root().await {
            out.push(("library", from, self.library_root().await));
        }
        let data_dir = self.data_dir();
        if !data_dir.as_os_str().is_empty() {
            let from = data_dir.join("downloads");
            if from.is_dir() {
                out.push((
                    "downloads",
                    from,
                    dl.join(Self::LEGACY_DOWNLOADS_SUBDIR),
                ));
            }
        }
        out
    }

    /// 平台默认下载目录（`~/Downloads`）下的**引擎旧落点**（BUG-323 复报）。
    ///
    /// `download_dir` 未配置时期，库根与缓存成品都落在它下面 —— 活栈实测 111 条
    /// 绝对路径指向 `~/Downloads/legacy-downloads`（33 文件 / 3.5 GB），132 条库根
    /// 相对记录的字节也在 `<它>/library`（211 文件 / 24 GB）下。只搬 `library` 与
    /// `legacy-downloads` 两个**引擎子目录**，不碰用户自己放在 Downloads 里的东西。
    ///
    /// 纯函数：默认目录由调用方注入 ⇒ **单测可传临时目录**，不触碰真实家目录
    /// （BUG-325 的根因正是这里直接调 `default_download_dir()`）。
    fn platform_default_legacy_roots(
        default_dir: &Path,
        dl: &Path,
        library_root: &Path,
    ) -> Vec<(&'static str, PathBuf, PathBuf)> {
        if paths_equal(default_dir, dl) {
            return Vec::new();
        }
        vec![
            (
                "default-library",
                default_dir.join(Self::LIBRARY_SUBDIR),
                library_root.to_path_buf(),
            ),
            (
                "default-downloads",
                default_dir.join(Self::LEGACY_DOWNLOADS_SUBDIR),
                dl.join(Self::LEGACY_DOWNLOADS_SUBDIR),
            ),
        ]
    }

    /// 把 **OS 下载目录**（`~/Downloads`）下的引擎旧落点搬进当前下载路径
    /// （BUG-323 复报 4，2026-10-19）。
    ///
    /// 只由**启动路径**（`main.rs`）调用。`os_download_dir()` 解析到真实家目录，
    /// 任何单测调用它都会动用户的数据（BUG-325 实测搬走 27.5 GB）——所以「可由
    /// 单测触达」的只有纯函数 [`Self::platform_default_legacy_roots`]。
    ///
    /// 为什么来源是 `~/Downloads` 而**不是** `default_download_dir()`：2026-10-19
    /// 用户裁定「禁止往C盘写入任何数据,所有内容应该写D盘」，内容默认根已改为
    /// `D:\OrigDown`；但装机存量的库根/缓存成品**物理上仍在 `~/Downloads`**
    /// （上一轮迁移放过去的），迁移必须能指名那个目录才能把字节搬出来。
    ///
    /// 纪律与 [`Self::migrate_legacy_managed_roots`] 完全相同：只移动不覆盖、
    /// 同卷 rename 优先、幂等、失败不阻断启动、有同名冲突时保留锚点下次重试。
    pub async fn migrate_platform_default_legacy_roots(
        &self,
    ) -> Result<Option<LegacyMigration>, String> {
        let dl = self.download_root().await;
        let library_root = self.library_root().await;
        // 指不到 OS 下载目录（非 Windows / 无家目录）⇒ 没有旧落点可认领。
        let Some(default_dir) = orig_core::paths::os_download_dir() else {
            return Ok(None);
        };
        let mut roots: Vec<RootMigration> = Vec::new();
        for (name, from, to) in Self::platform_default_legacy_roots(&default_dir, &dl, &library_root)
        {
            if !from.is_dir() || paths_equal(&from, &to) {
                continue;
            }
            // 旧新互含时移动会自我吞噬（搬进去又搬出来）—— 直接跳过，交给人工判断。
            if crate::cache::path_within(&from, &to) || crate::cache::path_within(&to, &from) {
                continue;
            }
            let mut moved = 0usize;
            let mut skipped = 0usize;
            move_dir_contents(&from, &to, 0, &mut moved, &mut skipped)?;
            if moved == 0 && skipped == 0 {
                continue;
            }
            let rewritten = self.rewrite_path_prefix(&from, &to).await?;
            if skipped == 0 {
                // 全部搬走 ⇒ 收尾：移除旧目录（`remove_dir` **只对空目录成功**，
                // 有意外内容也不会被删）。
                let _ = std::fs::remove_dir(&from);
            }
            // 有跳过项时**保留**来源标记：下次启动重试（用户处理完同名冲突后自动收尾），
            // 静默丢弃冲突项等于替用户做减法。
            roots.push(RootMigration {
                name: name.to_string(),
                from: from.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
                moved,
                skipped,
                rewritten,
            });
        }
        if roots.is_empty() {
            return Ok(None);
        }
        Ok(Some(LegacyMigration { roots }))
    }

    /// 把 DB 里以 `from` 为前缀的绝对路径改写成 `to` 前缀。
    ///
    /// 逐行处理而非 `UPDATE … LIKE` + `substr`：Windows 路径大小写不敏感、
    /// 分隔符可能混用，交给 Rust 侧判定才能精确到「分隔符边界」。
    /// `cache_task.dir` 一并改写：它是历史任务的落点记录，留着旧值会让
    /// 「界外路径」在库里继续存在（读路径虽不用它，但库里不该留下已搬迁的旧地址）。
    async fn rewrite_path_prefix(&self, from: &Path, to: &Path) -> Result<usize, String> {
        let from_s = from.to_string_lossy().into_owned();
        let to_s = to.to_string_lossy().into_owned();
        let mut n = 0usize;
        for (table, col) in [
            ("media_item", "file_path"),
            ("media_message", "file_path"),
            ("cache_task", "dir"),
        ] {
            let sql = format!("SELECT {col} FROM {table} WHERE {col} IS NOT NULL");
            let mut rows = self
                .conn
                .query(&sql, libsql::params![])
                .await
                .map_err(|e| e.to_string())?;
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            let mut pending: Vec<(String, String)> = Vec::new();
            while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
                let p: String = r.get(0).map_err(|e| e.to_string())?;
                if let Some(rest) = strip_prefix_ci(&p, &from_s) {
                    // 同一值可在多行重复（`cache_task.dir` 尤其常见）——
                    // 去重后一次 UPDATE 命中全部同值行，计数按**改写过的值**算。
                    if seen.insert(p.to_lowercase()) {
                        pending.push((p, format!("{to_s}{rest}")));
                    }
                }
            }
            drop(rows);
            for (old, new) in pending {
                self.conn
                    .execute(
                        &format!("UPDATE {table} SET {col} = ?1 WHERE {col} = ?2"),
                        libsql::params![new, old],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                n += 1;
            }
        }
        Ok(n)
    }

    /// 转码代理目录：`<下载路径>/.orighub/proxies`。
    ///
    /// 与库根同级但**刻意不进库**（BUG-208）：代理是可再生的派生缓存（源件删了
    /// 随时能重转），媒体库是唯一内容仓，派生物混进去会破坏「1 份存档」的计数
    /// 与清理语义（清理链让位于 library bytes 的裁定也不应被代理字节干扰）。
    ///
    /// **BUG-323**：落点由「TG 数据目录（应用内部）」迁到**下载路径之内** ——
    /// 用户裁定「所有文件不允许脱离下载路径」，代理同为媒体字节、不例外；
    /// `.orighub` 前缀保证它不出现在下载列表/成品扫描里（`files.rs::walk` 跳过
    /// `.` 开头的目录）。存量旧代理按需重转（可再生缓存）。
    pub async fn proxy_dir(&self) -> PathBuf {
        self.download_root()
            .await
            .join(Self::ENGINE_SUBDIR)
            .join("proxies")
    }

    /// 真实 TG 数据目录：库根（store.db 所在目录）。
    ///
    /// 与 `proxy_dir()`（其下 `proxies` 子目录）区分：ffmpeg 二进制探测、外部工具
    /// 落点等需要的是**数据目录本体**而非派生的代理缓存目录。BUG-278 修复点：此前
    /// 误把 `proxy_dir()` 传给 `resolve_ffmpeg_path`，使受支持的 `<数据目录>/bin`
    /// 落点退化为 `<数据目录>/proxies/bin`（恒空），ffmpeg 只能靠
    /// `%LocalAppData%\OrigHub\bin` 或 PATH 兜底。
    pub fn data_dir(&self) -> PathBuf {
        self.db_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    }

    // ---- 缓存库（跨频道聚合视图） ----

    /// 按频道返回已缓存清单：message_id → 落盘路径（downloaded = 1 且有路径）。
    /// 供前端 feed/缓存库合并统一缓存状态（DB 为唯一真相源，v0.4.3）。
    pub async fn list_downloaded(&self, channel_id: i64) -> libsql::Result<Vec<(i64, String)>> {
        let mut rows = self
            .conn
            .query(
                "SELECT message_id, file_path FROM media_message \
                 WHERE channel_id = ?1 AND downloaded = 1 AND file_path IS NOT NULL",
                params![channel_id],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            let id: i64 = r.get(0)?;
            let p: String = r.get(1)?;
            out.push((id, p));
        }
        Ok(out)
    }

    /// 存量 `file_path` 撞名清单（BUG-100 **检测面**，只读）。
    ///
    /// 判据就是「按 `file_path` 分组，count > 1」：这些行共享同一个磁盘文件，
    /// 清掉其中任一条会 unlink 掉其余条的字节，而其余条的状态字段不会复位。
    ///
    /// **只报不修**：自动修复意味着替用户决定删哪个文件/哪条记录，
    /// 这里只把清单暴露给启动对账日志与 `/api/tg/diag`，由人决定。
    /// 新落盘已由 `grammers::cache_filename` 带 chat/message 唯一后缀，
    /// 故存量会自然收敛（清掉重下即不再撞名），不需要迁移。
    pub async fn duplicate_file_paths(
        &self,
        limit: usize,
    ) -> libsql::Result<Vec<FilePathCollision>> {
        let mut out = Vec::new();
        // 两张表都要查：`media_item` 决定「条目能不能播」，`media_message` 决定
        // 「TG 流水能不能重新取字节」——只查一张会漏掉另一侧的死链。
        for table in ["media_item", "media_message"] {
            let sql = format!(
                "SELECT file_path, COUNT(*) AS c FROM {table} \
                 WHERE file_path IS NOT NULL AND file_path <> '' \
                 GROUP BY file_path HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT ?1"
            );
            let mut rows = self.conn.query(&sql, params![limit as i64]).await?;
            while let Some(r) = rows.next().await? {
                let path: String = r.get(0)?;
                let count: i64 = r.get(1)?;
                out.push(FilePathCollision {
                    table: table.to_string(),
                    path,
                    count,
                });
            }
        }
        // 多的排前面：撞得最狠的路径最该先看。
        out.sort_by(|a, b| b.count.cmp(&a.count));
        Ok(out)
    }

    // ---- 缓存任务（服务端任务态：刷新/切页/关浏览器都不再丢） ----

    /// 入队一个缓存任务；同 key 已有活跃任务时**复用既有任务**（幂等，不重复下载）。
    ///
    /// 返回 `(任务, 是否本次新建)`：只有新建时才允许起 worker，复用时 worker 已在跑。
    /// 返回 `None` 仅出现在极端并发下（撞唯一索引后既读不到活跃行），调用方按内部错误处理。
    ///
    /// BUG-189：用 `INSERT ... RETURNING id` 把「插入」与「取新 id」合并在**同一条语句**里。
    /// 旧写法「先 INSERT、再单独 `SELECT last_insert_rowid()`」存在连接级竞态 ——
    /// `last_insert_rowid()` 是**连接级且不区分表**的值，Store 用单一共享连接，并发交错时
    /// 会返回他人（甚至别的表）的 rowid（同 `media::create_series`/`create_tag` 的根因）。
    /// RETURNING 由 SQLite 在**同一语句内**返回本行 id，从根本上消除该窗口。
    pub async fn enqueue_cache_task(        &self,
        chat_id: i64,
        group_id: Option<i64>,
        item_key: &str,
        message_ids: &[i64],
        dir: &str,
    ) -> libsql::Result<Option<(CacheTask, bool)>> {
        // 先读活跃任务：命中即复用（正常路径，避免无谓的写入冲突）。
        // BUG-220：判据是「**消息集合重叠**」而非 item_key 相等 —— 同一批内容会经
        // `m:` / `g:` / `b:` 三条路径进来，key 字符串不等但消息重叠；只比 key 会让
        // 同一批消息被建多个任务（实测同一 8 条同时存在 g:/m:/b: 三个任务）。
        if let Some(t) = self
            .active_cache_task_covering(chat_id, message_ids)
            .await?
        {
            return Ok(Some((t, false)));
        }
        let items = serde_json::to_string(message_ids).unwrap_or_else(|_| "[]".to_string());
        let ts = now();
        // `cache_task_active_uniq`（partial unique）兜底并发：撞索引说明别人已插成功，回读即可。
        // BUG-189：插入与取 id 必须在**同一条语句**内完成（`RETURNING id`）—— 拆成两句时，共享
        // 单连接下两句之间的 `.await` 让出点会让 `last_insert_rowid()` 返回他人 rowid（实测 16 路
        // 并发拿到 14 个不同 id，8 与 16 各重复一次，见本文件回归测试）。
        let inserted = self
            .row_opt(
                "INSERT INTO cache_task \
                   (chat_id, group_id, item_key, items, total, done, status, dir, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 'queued', ?6, ?7, ?7)
                 RETURNING id",
                params![
                    chat_id,
                    group_id,
                    item_key,
                    items,
                    message_ids.len() as i64,
                    dir,
                    ts
                ],
            )
            .await;
        match inserted {
            Ok(Some(r)) => {
                let id: i64 = r.get(0)?;
                Ok(self.get_cache_task(id).await?.map(|t| (t, true)))
            }
            // 撞唯一索引 / 插入报错 / 极端并发下既读不到行：回读同 key 的活跃任务复用。
            _ => Ok(self.active_cache_task(item_key).await?.map(|t| (t, false))),
        }
    }

    /// **原任务重试**（BUG-078）：把终态记录复位为 `queued`，复用同一 id，由 worker 重跑。
    /// 只动终态（failed/cancelled/interrupted）；running/queued 不复位（避免双跑同一条）。
    /// 与 `enqueue_cache_task`（对终态会 `INSERT` 新行）区分——后者正是「重试却新建任务」的根因。
    pub async fn retry_cache_task(&self, id: i64) -> libsql::Result<Option<CacheTask>> {
        self.conn
            .execute(
                "UPDATE cache_task SET status='queued', done=0, error=NULL, updated_at=?1 \
                 WHERE id=?2 AND status NOT IN ('running','queued')",
                params![now(), id],
            )
            .await?;
        self.get_cache_task(id).await
    }

    /// 读同 key 的活跃任务（`queued`/`running`）。
    pub async fn active_cache_task(&self, item_key: &str) -> libsql::Result<Option<CacheTask>> {
        self.row_opt(
            &format!(
                "SELECT {CACHE_TASK_COLS} FROM cache_task \
                 WHERE item_key = ?1 AND status IN {CACHE_TASK_ACTIVE_STATES}"
            ),
            params![item_key],
        )
        .await?
            .map(|r| cache_task_from_row(&r))
            .transpose()
    }

    /// 查**覆盖了给定任一消息**的活跃任务（BUG-220 数据错乱修复）。
    ///
    /// 为什么不能只比 `item_key`：同一批内容会从三条入队路径进来，而 key 格式不同 ——
    /// 单条/相册是 `m:{chat}:{msg}` / `g:{chat}:{group}`（`routes.rs` 手工构造），
    /// 「缓存缺失 N 集」批量补缺是 `b:{chat}:{first}`。`item_key` 字符串不等 ⇒
    /// 旧的 `active_cache_task(item_key)` 完全命中不了 ⇒ **同一批消息被建多个任务**
    /// （实测同一 8 条消息同时存在 `g:` / `m:` / `b:` 三个任务，队列里重复且标题互相干扰）。
    ///
    /// 判据改为「消息集合是否重叠」，与 key 形态无关：任一消息已被活跃任务覆盖即复用。
    pub async fn active_cache_task_covering(
        &self,
        chat_id: i64,
        message_ids: &[i64],
    ) -> libsql::Result<Option<CacheTask>> {
        if message_ids.is_empty() {
            return Ok(None);
        }
        let placeholders = message_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT {CACHE_TASK_COLS} FROM cache_task \
             WHERE chat_id = ? AND status IN {CACHE_TASK_ACTIVE_STATES} \
               AND EXISTS (SELECT 1 FROM json_each(cache_task.items) \
                            WHERE json_each.value IN ({placeholders})) \
             ORDER BY id ASC LIMIT 1"
        );
        let mut params: Vec<libsql::Value> = Vec::with_capacity(message_ids.len() + 1);
        params.push(chat_id.into());
        for m in message_ids {
            params.push((*m).into());
        }
        let row = self.conn.query(&sql, params).await?;
        let mut rows = row;
        match rows.next().await? {
            Some(r) => Ok(Some(cache_task_from_row(&r)?)),
            None => Ok(None),
        }
    }

    /// BUG-308（D22-A②）：查一批消息在**历史认领**中的状态。
    ///
    /// 返回 `(message_id, exists, has_bytes)`：`media_item(source='tg', ref='{chat}:{msg}')`
    /// 是否已存在，以及它是否已有字节（`file_path IS NOT NULL`，与媒体库 `has_bytes`
    /// 同谓词）。入队前用它把「已入库」的重复入队拦下来 —— 旧去重只看**活跃任务**
    /// （queued/running），任务一旦终态，同一批消息可被再次入队，重复下载字节并新增
    /// 一条 cache_task 索引（用户口径：入库 = TG 插件下载的索引）。
    pub async fn claimed_messages(
        &self,
        chat_id: i64,
        message_ids: &[i64],
    ) -> libsql::Result<Vec<(i64, bool, bool)>> {
        let mut out = Vec::with_capacity(message_ids.len());
        for m in message_ids {
            let ref_key = format!("{chat_id}:{m}");
            let row = self
                .row_opt(
                    "SELECT file_path IS NOT NULL FROM media_item \
                     WHERE source = 'tg' AND ref = ?1",
                    params![ref_key],
                )
                .await?;
            match row {
                Some(r) => out.push((*m, true, r.get::<i64>(0)? != 0)),
                None => out.push((*m, false, false)),
            }
        }
        Ok(out)
    }

    /// BUG-308（D22-A②）：把「历史认领」的任务行复位重跑（补字节），**不新建行**。
    ///
    /// 只认**覆盖了给定任一消息**的最近一条任务（含终态）；复位为 `queued`、清 `done`
    /// 与 `error`，语义与 [`Store::retry_cache_task`] 同（复用同一 id、同一入库记录）。
    /// 找不到返回 `None`（调用方回退到常规入队）。
    pub async fn requeue_task_covering(
        &self,
        chat_id: i64,
        message_ids: &[i64],
    ) -> libsql::Result<Option<CacheTask>> {
        if message_ids.is_empty() {
            return Ok(None);
        }
        let placeholders = message_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT {CACHE_TASK_COLS} FROM cache_task \
             WHERE chat_id = ? \
               AND EXISTS (SELECT 1 FROM json_each(cache_task.items) \
                            WHERE json_each.value IN ({placeholders})) \
             ORDER BY id DESC LIMIT 1"
        );
        let mut params: Vec<libsql::Value> = Vec::with_capacity(message_ids.len() + 1);
        params.push(chat_id.into());
        for m in message_ids {
            params.push((*m).into());
        }
        let mut rows = self.conn.query(&sql, params).await?;
        let Some(r) = rows.next().await? else {
            return Ok(None);
        };
        let id: i64 = r.get(0)?;
        self.conn
            .execute(
                "UPDATE cache_task SET status='queued', done=0, error=NULL, updated_at=?1 \
                 WHERE id=?2",
                params![now(), id],
            )
            .await?;
        self.get_cache_task(id).await
    }

    /// 按条目查其缓存任务态（BUG-279）。
    ///
    /// 媒体库未缓存条目需要展示「排队 / 正在下 / 上次失败（原因）/ 被取消 /
    /// 已完成但无字节」，而旧 `active_cache_task` 只开放 `queued`/`running`。
    /// 本查询开放到**全部状态**，并覆盖两种去重键：
    ///   - 单条：`m:{chat}:{msg}` 精确匹配；
    ///   - 组/相册任务：`g:{chat}:%` 且 `items` JSON 数组包含 `{msg}`
    ///     （`message_ids` 实际存于 `items` 列，必须用 `json_each` 而非 LIKE）。
    /// 两路各取 `id` 最大者，再取二者中 `id` 更大者 = 最近一次尝试。
    pub async fn cache_task_for_item(
        &self,
        chat_id: i64,
        message_id: i64,
    ) -> libsql::Result<Option<CacheTask>> {
        let single = self
            .row_opt(
                &format!(
                    "SELECT {CACHE_TASK_COLS} FROM cache_task \
                     WHERE item_key = ?1 ORDER BY id DESC LIMIT 1"
                ),
                params![format!("m:{chat_id}:{message_id}")],
            )
            .await?
            .map(|r| cache_task_from_row(&r));
        let group = self
            .row_opt(
                &format!(
                    "SELECT {CACHE_TASK_COLS} FROM cache_task \
                     WHERE item_key LIKE ?1 \
                       AND EXISTS (SELECT 1 FROM json_each(items) \
                                   WHERE json_each.value = ?2) \
                     ORDER BY id DESC LIMIT 1"
                ),
                params![format!("g:{chat_id}:%"), message_id],
            )
            .await?
            .map(|r| cache_task_from_row(&r));
        match (single, group) {
            (Some(Ok(s)), Some(Ok(g))) => Ok(Some(if s.id >= g.id { s } else { g })),
            (Some(Ok(s)), _) => Ok(Some(s)),
            (_, Some(Ok(g))) => Ok(Some(g)),
            (Some(Err(e)), _) | (_, Some(Err(e))) => Err(e),
            (None, None) => Ok(None),
        }
    }

    /// 读单个任务。
    pub async fn get_cache_task(&self, id: i64) -> libsql::Result<Option<CacheTask>> {
        self.row_opt(
            &format!("SELECT {CACHE_TASK_COLS} FROM cache_task WHERE id = ?1"),
            params![id],
        )
        .await?
        .map(|r| cache_task_from_row(&r))
        .transpose()
    }

    /// 列出任务：活跃优先，其余新→旧（前端据此恢复「缓存中 n/N」）。
    ///
    /// BUG-277：活跃组内**置顶的行排在前面** —— 呈现序必须与执行序同向，
    /// 否则「点了置顶，它还躺在列表底下」，用户无法从界面判断置顶是否生效
    /// （判据 7 要求 DOM 顺序可核）。同优先级内保留原有的 `id DESC`，
    /// 存量列表的观感一字不变。
    pub async fn list_cache_tasks(&self, limit: u32) -> libsql::Result<Vec<CacheTask>> {
        let mut rows = self
            .conn
            .query(
                &format!(
                    "SELECT {CACHE_TASK_COLS} FROM cache_task \
                     ORDER BY CASE WHEN status IN {CACHE_TASK_ACTIVE_STATES} THEN 0 ELSE 1 END, \
                     priority DESC, id DESC \
                     LIMIT ?1"
                ),
                params![limit as i64],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(cache_task_from_row(&r)?);
        }
        Ok(out)
    }

    /// 各状态任务计数（缓存管理面板统计行）。
    /// 返回 `(status, n)`；未出现的状态由调用方按 0 补齐。
    pub async fn count_cache_tasks(&self) -> libsql::Result<Vec<(String, i64)>> {
        let mut rows = self
            .conn
            .query("SELECT status, COUNT(*) FROM cache_task GROUP BY status", ())
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push((r.get(0)?, r.get(1)?));
        }
        Ok(out)
    }

    /// 任务记录的**唯一批量清除入口**——范围由参数决定，不是靠堆按钮/堆端点。
    ///
    /// 三档范围（见 [`TaskClearScope`]）互斥且并集为全集：
    /// `success` ∪ `failed` ∪ `{queued,running}` = 全部记录。
    /// 只有 `all` 档会波及活跃任务（先置 `cancelled` 让 worker 在下一条目间隙退出），
    /// 另两档**永不误伤正在跑的任务**。返回删除行数。
    ///
    /// 此前的错误形态（BUG-051）：为「清除终态」和「清空全部」各写一个端点，
    /// 于是「清空失败」「清空成功」就会顺理成章地再加两个——动词被当成枚举对象，
    /// 面板必然无限叠加。正解是**动词只有一个**，范围是可组合的参数。
    pub async fn clear_cache_tasks(&self, scope: TaskClearScope) -> libsql::Result<u64> {
        let pred = scope.predicate();
        self.conn
            .execute(
                &format!(
                    "UPDATE cache_task SET status = 'cancelled', current_id = NULL, updated_at = ?1 \
                     WHERE ({pred}) AND status IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                params![now()],
            )
            .await?;
        let n = self
            .conn
            .execute(&format!("DELETE FROM cache_task WHERE {pred}"), ())
            .await?;
        Ok(n)
    }

    /// 删除**指定 id 集合**的任务记录 —— 缓存管理面板「删除所选」。
    ///
    /// 与 `delete_cache_task` 同一套纪律：活跃任务先置 `cancelled`（让 worker 在
    /// 下一条目间隙退出），再删行 —— 直接删行会让 worker 拿着不存在的 id 继续写进度。
    ///
    /// 为什么按 id 而不是再加一档 scope：范围（全部/成功/失败）是**看得见的筛选**，
    /// 而用户要的是「我勾了这几条」。选择本身才是诉求，枚举档位永远追不上
    /// （清空失败 / 清空成功 / 清空中断…）。点全选即等价于「全部」。
    pub async fn delete_cache_tasks_by_ids(&self, ids: &[i64]) -> libsql::Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        // 变长 IN 列表无法用绑定参数表达；id 全是 i64，拼接无注入面。
        let list = ids
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        self.conn
            .execute(
                &format!(
                    "UPDATE cache_task SET status = 'cancelled', current_id = NULL, updated_at = ?1 \
                     WHERE id IN ({list}) AND status IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                params![now()],
            )
            .await?;
        let n = self
            .conn
            .execute(&format!("DELETE FROM cache_task WHERE id IN ({list})"), ())
            .await?;
        Ok(n)
    }

    /// 删除**单条**任务记录（任何状态）——缓存管理面板「删除」。
    ///
    /// 活跃任务先置 `cancelled`（让 worker 在下一条目间隙退出），再删行；
    /// 直接删行会让 worker 拿着不存在的 id 继续写进度。返回是否命中该 id。
    pub async fn delete_cache_task(&self, id: i64) -> libsql::Result<bool> {
        self.conn
            .execute(
                &format!(
                    "UPDATE cache_task SET status = 'cancelled', current_id = NULL, updated_at = ?2 \
                     WHERE id = ?1 AND status IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                params![id, now()],
            )
            .await?;
        let n = self
            .conn
            .execute("DELETE FROM cache_task WHERE id = ?1", params![id])
            .await?;
        Ok(n > 0)
    }

    /// `queued` → `running`（worker 起跑时置位）。
    pub async fn mark_cache_task_running(&self, id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "UPDATE cache_task SET status = 'running', updated_at = ?2 \
                 WHERE id = ?1 AND status = 'queued'",
                params![id, now()],
            )
            .await?;
        Ok(())
    }

    // ── BUG-276：条目级墙钟累计（跨重启） ───────────────────────────────────

    /// 该条目**已经烧掉的墙钟**（毫秒）= 已结束尝试的累计 + 在途尝试的已耗时。
    ///
    /// 这是「每条目 30 分钟」这条死线的**唯一时基**。把它放在库里而不是进程里，
    /// 是因为缺陷原形把计时交给了 `tokio::time::timeout` + `Instant`：后者是
    /// 进程本地时钟，进程一退，已烧掉的时间随之蒸发，重启后的新尝试又拿到一整个
    /// 完整的 `wall` 窗口 ⇒ 「重启比 30min 频繁」的环境里这条死线**永不到期**。
    pub async fn item_wall_elapsed_ms(
        &self,
        task_id: i64,
        message_id: i64,
    ) -> libsql::Result<i64> {
        let mut rows = self
            .conn
            .query(
                "SELECT accum_ms, started_at FROM cache_task_item_wall \
                  WHERE task_id = ?1 AND message_id = ?2",
                params![task_id, message_id],
            )
            .await?;
        let Some(r) = rows.next().await? else {
            return Ok(0);
        };
        let accum: i64 = r.get(0)?;
        let started: Option<i64> = r.get(1)?;
        let inflight = started.map(|s| (now_ms() - s).max(0)).unwrap_or(0);
        Ok(accum.saturating_add(inflight))
    }

    /// 标记一次尝试开始：**只在没有在途尝试时**落时间戳（幂等）。
    ///
    /// 为什么是幂等而不是覆盖：一次尝试若崩在中途，它的 `started_at` 仍留在库里，
    /// 下一次尝试起点必须**接着上一次的起点**算（而不是重新起算），否则就退回了
    /// 「崩一次白赚一个 `wall`」的缺陷原形。
    pub async fn begin_item_wall_attempt(
        &self,
        task_id: i64,
        message_id: i64,
    ) -> libsql::Result<()> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO cache_task_item_wall \
                   (task_id, message_id, accum_ms, started_at) \
                 VALUES (?1, ?2, 0, NULL)",
                params![task_id, message_id],
            )
            .await?;
        self.conn
            .execute(
                "UPDATE cache_task_item_wall SET started_at = ?3 \
                  WHERE task_id = ?1 AND message_id = ?2 AND started_at IS NULL",
                params![task_id, message_id, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// 结束一次尝试：把在途时长并入累计并清掉时间戳。
    ///
    /// 超时掐断、下载报错、正常完成**三路都要调**——三者都真的烧掉了墙钟。
    /// 崩在中途的那一次没有结束事件 ⇒ 不计入 `accum_ms`，但它的 `started_at`
    /// 仍在 ⇒ 时长继续以「在途」形式累加（见 [`Store::item_wall_elapsed_ms`]）。
    pub async fn end_item_wall_attempt(
        &self,
        task_id: i64,
        message_id: i64,
    ) -> libsql::Result<()> {
        self.conn
            .execute(
                "UPDATE cache_task_item_wall \
                    SET accum_ms = accum_ms + MAX(0, ?3 - started_at), started_at = NULL \
                  WHERE task_id = ?1 AND message_id = ?2 AND started_at IS NOT NULL",
                params![task_id, message_id, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// 丢弃**整个任务**的条目累计（任务离开队列时回收，避免表随任务数单调增长）。
    pub async fn clear_task_item_walls(&self, task_id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "DELETE FROM cache_task_item_wall WHERE task_id = ?1",
                params![task_id],
            )
            .await?;
        Ok(())
    }

    /// 更新进度（已完成条数 + 正在处理的条目）。
    ///
    /// BUG-257：**只在活跃态时写入**。此前 WHERE 只有 `id`，于是任务被取消后，
    /// 仍在收尾的那次写入会把 `done` 继续往上加——用户点了取消，进度条却还在涨
    /// （「取消了却还在动」）。`finish_cache_task` 早有同款状态门，唯独这里漏了。
    ///
    /// 判据与 `finish_cache_task` 同源（`CACHE_TASK_ACTIVE_STATES`）：终态记录
    /// 是**事实**，不该再被一个迟到的 worker 改写。
    pub async fn update_cache_task_progress(
        &self,
        id: i64,
        done: i64,
        current_id: Option<i64>,
    ) -> libsql::Result<()> {
        self.conn
            .execute(
                &format!(
                    "UPDATE cache_task SET done = ?2, current_id = ?3, updated_at = ?4 \
                     WHERE id = ?1 AND status IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                params![id, done, current_id, now()],
            )
            .await?;
        Ok(())
    }

    /// 置终态；**仅在活跃态时生效**——已被取消的任务不会被 worker 事后改写成 done。
    pub async fn finish_cache_task(
        &self,
        id: i64,
        status: &str,
        error: Option<&str>,
    ) -> libsql::Result<()> {
        self.conn
            .execute(
                &format!(
                    "UPDATE cache_task SET status = ?2, error = ?3, current_id = NULL, updated_at = ?4 \
                     WHERE id = ?1 AND status IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                params![id, status, error, now()],
            )
            .await?;
        // BUG-276：任务离开队列 ⇒ 条目级墙钟累计失去载体，回收（否则表随任务数单调增长）。
        // 这也是「重试即重新计」的落点：重试会新起一个任务 id ⇒ 天然是干净的累计。
        self.clear_task_item_walls(id).await?;
        Ok(())
    }

    /// 请求取消：置终态 `cancelled`，worker 在下一条目间隙自行退出。
    /// 返回是否命中活跃任务（false = 任务已结束，无需取消）。
    pub async fn cancel_cache_task(&self, id: i64) -> libsql::Result<bool> {
        let n = self
            .conn
            .execute(
                &format!(
                    "UPDATE cache_task SET status = 'cancelled', current_id = NULL, updated_at = ?2 \
                     WHERE id = ?1 AND status IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                params![id, now()],
            )
            .await?;
        Ok(n > 0)
    }

    /// 任务是否仍活跃（worker 在每条目间隙检查，实现可取消）。
    pub async fn is_cache_task_active(&self, id: i64) -> libsql::Result<bool> {
        let Some(r) = self
            .row_opt("SELECT status FROM cache_task WHERE id = ?1", params![id])
            .await?
        else {
            return Ok(false);
        };
        let s: String = r.get(0)?;
        Ok(s == "queued" || s == "running")
    }

    /// 是否有 worker 正在跑（单飞判定：新入队任务若已有 worker，则留在队列等接续）。
    pub async fn has_running_cache_task(&self) -> libsql::Result<bool> {
        let Some(r) = self
            .row_opt("SELECT 1 FROM cache_task WHERE status = 'running' LIMIT 1", ())
            .await?
        else {
            return Ok(false);
        };
        let _: i64 = r.get(0)?;
        Ok(true)
    }

    /// 下一个该跑的排队任务（BUG-277）：**置顶优先，同优先级仍是最老的先跑**。
    ///
    /// 单飞 worker 跑完当前任务后调它接续。`priority` 全是 0 时（= 迁移前的行为）
    /// 排序退化为 `id ASC`，与旧实现逐字一致。
    pub async fn next_queued_task(&self) -> libsql::Result<Option<CacheTask>> {
        self.row_opt(
            &format!(
                "SELECT {CACHE_TASK_COLS} FROM cache_task \
                 WHERE status = 'queued' ORDER BY {CACHE_TASK_QUEUE_ORDER} LIMIT 1"
            ),
            (),
        )
        .await?
        .map(|r| cache_task_from_row(&r))
        .transpose()
    }

    /// 当前最大的任务优先级（BUG-277）：置顶 = 它 + 1。
    ///
    /// **必须由后端算**：前端拿不到全量队列（`/api/tg/cache/tasks` 只给一个当前任务
    /// + 20 条摘要），让它猜 max 就会出现两条任务撞到同一个 priority，届时顺序
    /// 又退回 id 排序 —— 用户点了置顶却没生效，正是本 BUG 的观感。
    pub async fn max_cache_task_priority(&self) -> libsql::Result<i64> {
        match self
            .row_opt("SELECT COALESCE(MAX(priority), 0) FROM cache_task", ())
            .await?
        {
            Some(r) => Ok(r.get(0).unwrap_or(0)),
            None => Ok(0),
        }
    }

    /// 设置任务优先级（BUG-277）。返回更新后的任务；id 不存在 ⇒ `None`。
    ///
    /// 只改 `priority` 一个标量：**不动 status、不动 done、不动字节**。
    /// 置顶因此天然「不抢占」——在跑的任务仍是 running，只是它之后的接续顺序变了。
    pub async fn set_cache_task_priority(
        &self,
        id: i64,
        priority: i64,
    ) -> libsql::Result<Option<CacheTask>> {
        let n = self
            .conn
            .execute(
                "UPDATE cache_task SET priority = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, priority, now()],
            )
            .await?;
        if n == 0 {
            return Ok(None);
        }
        self.get_cache_task(id).await
    }

    /// 当前应呈现给前端的**唯一**任务（设计裁定：无论多少缓存在排队，task 只返回一个结果）：
    /// running 优先 → 最老 queued → 最近一条已结束任务（供前端收尾展示/错误提示）。
    pub async fn current_cache_task(&self) -> libsql::Result<Option<CacheTask>> {
        // 1) running（理论上至多一个）
        if let Some(t) = self
            .row_opt(
                &format!(
                    "SELECT {CACHE_TASK_COLS} FROM cache_task \
                     WHERE status = 'running' ORDER BY id ASC LIMIT 1"
                ),
                (),
            )
            .await?
            .map(|r| cache_task_from_row(&r))
            .transpose()?
        {
            return Ok(Some(t));
        }
        // 2) 最老 queued
        if let Some(t) = self.next_queued_task().await? {
            return Ok(Some(t));
        }
        // 3) 最近一条已结束（done/failed/cancelled/interrupted）
        self.row_opt(
            &format!(
                "SELECT {CACHE_TASK_COLS} FROM cache_task \
                 WHERE status NOT IN {CACHE_TASK_ACTIVE_STATES} \
                 ORDER BY updated_at DESC, id DESC LIMIT 1"
            ),
            (),
        )
        .await?
        .map(|r| cache_task_from_row(&r))
        .transpose()
    }

    /// 启动时清理僵尸任务：**只降级 `running`**（BUG-257）。
    ///
    /// 降级本身是有依据的裁定（BUG-024 拒绝伪造的「缓存中」态）：进程被杀时正在传
    /// 字节的那条任务，它的 worker 永远不会回来，不降级前端就会看到一个永不推进的
    /// 「缓存中」——那是假状态。
    ///
    /// 但此前 WHERE 覆盖 `('queued','running')` **两者**，而 `queued` 的语义是
    /// 「还没开始」：它们从未传输过一个字节，把它们降级成 `interrupted`（=「中途被打断」）
    /// **没有依据**，且等于「重启即清空待办」——实测一次重启把 26 个 queued 全部作废。
    /// BUG-024 反对的是**假状态**，不是保留队列；`queued` 不是假状态，它就是排队。
    ///
    /// 现在只降级真正传输过字节的 `running`；`queued` 原样保留，由启动流程**重新入队**
    /// （`recover_queued_cache_tasks` → `spawn_cache_task`）。
    ///
    /// **降级时写入成因**（BUG-257 判据 5）：此前 `interrupted` 的 `error` 恒为 NULL，
    /// 界面只显示「已中断」，用户无法把它与「我刚重启过」联系起来，更不知道它可重试
    /// （它确实在 `RETRYABLE_STATES` 里）。写明成因，前端才能给出「可恢复」而非「卡住了」。
    /// 用固定文案而非拼接：原因只有一个来源（本次重启），拼可变内容等于制造第二真源。
    ///
    /// 返回被标记的条数。
    pub async fn mark_stale_cache_tasks(&self) -> libsql::Result<usize> {
        let n = self
            .conn
            .execute(
                "UPDATE cache_task SET status = 'interrupted', current_id = NULL, \
                 error = '应用重启：传输被中断，可重试继续', updated_at = ?1 \
                 WHERE status = 'running'",
                params![now()],
            )
            .await?;
        Ok(n as usize)
    }

    /// 启动时**可恢复**的排队任务（BUG-257）。
    ///
    /// 返回全部仍是 `queued` 的任务（按队列取序 = 置顶优先、同优先级 FIFO），
    /// 交给启动流程重新入队。
    /// 刻意**返回列表而不自己 spawn**：投递只有一个入口（`spawn_cache_task`），
    /// 单飞门禁也在那里——在 store 层另起一套投递就会绕过门禁、出现双跑。
    ///
    /// 「降级」与「恢复」是同一件事的两半：只降级不恢复，重启就是把队列清空；
    /// 只恢复不降级，前端会卡在永不推进的假「缓存中」。
    pub async fn recover_queued_cache_tasks(&self) -> libsql::Result<Vec<CacheTask>> {
        let stmt = self
            .conn
            .prepare(&format!(
                "SELECT {CACHE_TASK_COLS} FROM cache_task \
                 WHERE status = 'queued' ORDER BY {CACHE_TASK_QUEUE_ORDER}"
            ))
            .await?;
        let mut rows = stmt.query(()).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(cache_task_from_row(&r)?);
        }
        Ok(out)
    }


    /// 清除单条消息的本地缓存：删除落盘文件（存在才删，缺失忽略）并复位 downloaded/file_path。
    ///
    /// 返回是否确有缓存被清除（无缓存时 false，幂等）。仅删缓存副本，不动库中消息记录本身。
    pub async fn clear_downloaded(&self, channel_id: i64, message_id: i64) -> libsql::Result<bool> {
        let row = self
            .row_opt(
                "SELECT file_path FROM media_message \
                 WHERE channel_id = ?1 AND message_id = ?2 AND downloaded = 1",
                [channel_id, message_id],
            )
            .await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let path: Option<String> = row.get(0).ok();
        if let Some(p) = path {
            // 文件已被手动移动/删除时静默忽略：目标仍是复位状态
            let _ = std::fs::remove_file(&p);
        }
        self.conn
            .execute(
                "UPDATE media_message SET downloaded = 0, file_path = NULL \
                 WHERE channel_id = ?1 AND message_id = ?2",
                [channel_id, message_id],
            )
            .await?;
        Ok(true)
    }

    /// 跨频道聚合查询已入库媒体（新→旧），供缓存库列表与搜索。
    pub async fn list_stored(&self, q: &StoredQuery) -> libsql::Result<Vec<StoredItem>> {
        let mut where_clauses: Vec<String> = Vec::new();
        let mut args: Vec<libsql::Value> = Vec::new();
        if q.downloaded_only {
            // 已缓存行 + 其所在相册组的全部成员：组状态完整性（前端据此显示 已缓存 n/N / 继续 / 清除，
            // 避免「组内视频未缓存但行显示已缓存」的误标）。
            where_clauses.push(
                "(m.downloaded = 1 OR (m.group_id IS NOT NULL AND m.group_id IN (\
                 SELECT group_id FROM media_message WHERE group_id IS NOT NULL AND downloaded = 1)))"
                    .into(),
            );
        }
        if let Some(mt) = q.media_type.as_deref() {
            args.push(mt.into());
            where_clauses.push(format!("m.media_type = ?{}", args.len()));
        }
        if let Some(kw) = q.q.as_deref() {
            if !kw.trim().is_empty() {
                args.push(format!("%{}%", kw.trim()).into());
                let n = args.len();
                where_clauses.push(format!(
                    "(m.caption LIKE ?{n} OR c.title LIKE ?{n} OR m.file_path LIKE ?{n})"
                ));
            }
        }
        if let Some(before) = q.before_id {
            args.push(before.into());
            where_clauses.push(format!("m.message_id < ?{}", args.len()));
        }
        args.push((q.limit.max(1).min(200) as i64).into());
        let limit_idx = args.len();
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", where_clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT m.channel_id, m.message_id, m.caption, m.mime_type, m.size, m.downloaded,
                    m.created_at, m.media_type, m.msg_date, m.duration, m.file_path, m.group_id, c.title
             FROM media_message m
             LEFT JOIN monitored_channel c ON c.channel_id = m.channel_id{where_sql}
             ORDER BY m.message_id DESC LIMIT ?{limit_idx}"
        );
        let stmt = self.conn.prepare(&sql).await?;
        let mut rows = stmt.query(args).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(StoredItem {
                channel_title: r.get(12)?,
                msg: StoredMessage {
                    channel_id: r.get(0)?,
                    message_id: r.get(1)?,
                    caption: r.get(2)?,
                    mime_type: r.get(3)?,
                    size: r.get(4)?,
                    downloaded: r.get::<i64>(5)? != 0,
                    created_at: r.get(6)?,
                    media_type: r.get(7)?,
                    date: r.get(8)?,
                    duration: r.get(9)?,
                    file_path: r.get(10)?,
                    group_id: r.get(11)?,
                },
            });
        }
        Ok(out)
    }

    // ---- 增量同步游标 ----

    /// 取某频道已同步到的最大消息 id。
    pub async fn get_cursor(&self, channel_id: i64) -> libsql::Result<Option<i64>> {
        let row = self
            .row_opt(
                "SELECT last_message_id FROM sync_cursor WHERE channel_id = ?1",
                params![channel_id],
            )
            .await?;
        match row {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    /// 更新某频道增量游标。
    pub async fn set_cursor(&self, channel_id: i64, last_message_id: i64) -> libsql::Result<()> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO sync_cursor (channel_id, last_message_id, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(channel_id) DO UPDATE
                   SET last_message_id = excluded.last_message_id, updated_at = excluded.updated_at",
                params![channel_id, last_message_id, t],
            )
            .await?;
        Ok(())
    }

    // ---- 历史回溯游标（2026-10-22 用户第 2 点） ----

    /// 某频道的回溯进度 `(before_id, until_ts)`；两者皆 0 = 没有待回溯。
    pub async fn get_backfill(&self, channel_id: i64) -> libsql::Result<(i64, i64)> {
        let row = self
            .row_opt(
                "SELECT backfill_before_id, backfill_until FROM sync_cursor WHERE channel_id = ?1",
                params![channel_id],
            )
            .await?;
        match row {
            Some(r) => Ok((r.get(0)?, r.get(1)?)),
            None => Ok((0, 0)),
        }
    }

    /// 待回溯的频道 id（`backfill_until > 0`）。后台循环据此跳过绝大多数频道。
    pub async fn list_backfill_pending(&self) -> libsql::Result<Vec<i64>> {
        let mut rows = self
            .conn
            .query(
                "SELECT channel_id FROM sync_cursor WHERE backfill_until > 0 ORDER BY channel_id",
                (),
            )
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(r.get(0)?);
        }
        Ok(out)
    }

    /// 开始（或改期）回溯到 `until_ts`。
    ///
    /// `backfill_before_id` 归零 = 「下一轮重新算起点」：真正的起点在
    /// `monitor::run_backfill_pass` 里取**当前已同步到的最新 id**。这样
    /// 「首次开始」与「改了日期重跑」走同一条路径，不会漏掉中间那段。
    ///
    /// 不动 `last_message_id`：增量游标与回溯游标是两条独立的腿。
    pub async fn set_backfill(&self, channel_id: i64, until_ts: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "INSERT INTO sync_cursor
                     (channel_id, last_message_id, updated_at, backfill_before_id, backfill_until)
                 VALUES (?1, 0, ?2, 0, ?3)
                 ON CONFLICT(channel_id) DO UPDATE
                   SET backfill_before_id = 0,
                       backfill_until = excluded.backfill_until,
                       updated_at = excluded.updated_at",
                params![channel_id, now(), until_ts],
            )
            .await?;
        Ok(())
    }

    /// 向旧翻过一页后推进回溯游标。
    pub async fn advance_backfill(&self, channel_id: i64, before_id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "UPDATE sync_cursor SET backfill_before_id = ?2, updated_at = ?3
                  WHERE channel_id = ?1",
                params![channel_id, before_id, now()],
            )
            .await?;
        Ok(())
    }

    /// 结束回溯（到达目标日期 / 翻到频道最早一条 / 无法推进）：两列归零。
    pub async fn clear_backfill(&self, channel_id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "UPDATE sync_cursor
                    SET backfill_before_id = 0, backfill_until = 0, updated_at = ?2
                  WHERE channel_id = ?1",
                params![channel_id, now()],
            )
            .await?;
        Ok(())
    }

    // ---- 频道分组缓存（分页枚举加速） ----

    /// upsert 一条会话缓存（同 id 幂等，更新标题/用户名/分组）。
    ///
    /// BUG-194：标题经 `Channel::identified()` 收敛，**保证落库标题非空**。
    /// 存储层兜住不变量，使「`dialog_cache` 不存在空标题行」与调用方
    /// （grammers 枚举 / mock / 将来的新写入点）解耦。
    pub async fn upsert_dialog(&self, ch: &Channel) -> libsql::Result<()> {
        let t = now();
        let ch = ch.clone().identified();
        self.conn
            .execute(
                "INSERT INTO dialog_cache (id, title, username, folder, init_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE
                   SET title = excluded.title, username = excluded.username, folder = excluded.folder",
                params![ch.id, ch.title, ch.username.as_deref(), ch.folder.as_deref(), t],
            )
            .await?;
        Ok(())
    }

    /// 会话缓存总条数。
    pub async fn count_dialogs(&self) -> libsql::Result<i64> {
        let row = self
            .row_opt("SELECT COUNT(*) FROM dialog_cache", ())
            .await?;
        Ok(row.map(|r| r.get::<i64>(0).unwrap_or(0)).unwrap_or(0))
    }

    /// 分页读取会话缓存（按 id 正序），返回带分组映射的 Channel。
    pub async fn read_dialogs(&self, offset: i64, limit: u32) -> libsql::Result<Vec<Channel>> {
        let stmt = self
            .conn
            .prepare(
                "SELECT id, title, username, folder FROM dialog_cache
                 ORDER BY id LIMIT ?1 OFFSET ?2",
            )
            .await?;
        let mut rows = stmt
            .query(params![limit.max(1) as i64, offset.max(0)])
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(Channel {
                id: r.get(0)?,
                title: r.get(1)?,
                username: r.get(2)?,
                folder: r.get(3)?,
            });
        }
        Ok(out)
    }

    /// 清空会话缓存（仅清缓存表，不删除任何用户数据）。
    pub async fn clear_dialog_cache(&self) -> libsql::Result<()> {
        self.conn
            .execute("DELETE FROM dialog_cache", ())
            .await?;
        Ok(())
    }
}

/// 一处「引擎写过的旧落点」的搬迁结果（BUG-323）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RootMigration {
    /// 旧落点的名字（`library` / `downloads`），只用于日志与回执。
    pub name: String,
    /// 旧根（迁移前）。
    pub from: String,
    /// 新根（下载路径之内）。
    pub to: String,
    /// 已移动的顶层条目数（目录按顶层计）。
    pub moved: usize,
    /// 因目标同名已存在而跳过的条目数（**绝不覆盖**）。
    pub skipped: usize,
    /// 被改写前缀的 DB 行数。
    pub rewritten: usize,
}

/// 存量受管根搬迁的汇总（BUG-323）。
///
/// 为什么是「多根」而不是「库根」：库根只是旧落点之一。同一个缺陷的另一个落点是
/// **旧默认下载目录** `<TG 数据目录>/downloads`（BUG-323 之前
/// `Config::default().download_dir` 的值），实测仍压着 33 个文件 / 3.5 GB 真实媒资
/// 且 26 条 `media_item` / 32 条 `media_message` / 18 条 `cache_task` 指向它。
/// 只搬库根 = 用户下过的片子整片变成「取不到」。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LegacyMigration {
    pub roots: Vec<RootMigration>,
}

impl LegacyMigration {
    /// 全部搬走的顶层条目数（日志一句话用）。
    pub fn moved(&self) -> usize {
        self.roots.iter().map(|r| r.moved).sum()
    }

    /// 全部跳过的顶层条目数。
    pub fn skipped(&self) -> usize {
        self.roots.iter().map(|r| r.skipped).sum()
    }

    /// 全部被改写的 DB 行数。
    pub fn rewritten(&self) -> usize {
        self.roots.iter().map(|r| r.rewritten).sum()
    }
}

/// 把解析出的根收敛成单一字面形态（BUG-323 复报 2026-10-19）。
///
/// 所有「根」的出口（download_root / library_root env 档 / 受管根集合）都必须过它，
/// 否则 `D://OrigDown` 与 `D:/OrigDown` 会在系统里各算一套。
fn norm_root(p: &Path) -> PathBuf {
    orig_core::paths::normalize_dir_path(p)
}

/// 路径相等（Windows 大小写不敏感，忽略尾分隔符与分隔符连排）。
///
/// `normalize_dir` 先折叠 `D://X` / `D:/X` / `D:\X` 的字面差（BUG-323 复报）——
/// 少了这一步，`D://OrigDown` 与 `D:/OrigDown` 会被判为两个不同的根，
/// 迁移/去重全部静默失效。
fn paths_equal(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> String {
        orig_core::paths::normalize_dir(&p.to_string_lossy()).to_lowercase()
    }
    norm(a) == norm(b)
}

/// 大小写不敏感地剥离前缀，返回剩余部分（**含分隔符**，便于直接拼接）。
///
/// 边界判定到分隔符：`C:\Downloads` 绝不吃掉 `C:\Downloads2`。
fn strip_prefix_ci(path: &str, prefix: &str) -> Option<String> {
    let mut pre = prefix.replace('/', "\\").to_lowercase();
    while pre.ends_with('\\') {
        pre.pop();
    }
    if pre.is_empty() {
        return None;
    }
    let hay = path.replace('/', "\\").to_lowercase();
    if !hay.starts_with(&pre) {
        return None;
    }
    // 用原始串取剩余部分（保留用户实际大小写与分隔符）；
    // 先确认切点在字符边界上，避免非 ASCII 转小写改变长度时切碎字符。
    if !path.is_char_boundary(pre.len()) {
        return None;
    }
    let rest = &path[pre.len()..];
    if rest.is_empty() || rest.starts_with(['\\', '/']) {
        Some(rest.to_string())
    } else {
        None
    }
}

/// 递归移动 `from` 下的内容到 `to`：**绝不覆盖**目标同名项，同卷 `rename` 优先。
///
/// 每层只做「不存在目标才搬」——冲突项留着并计数，由人判断，绝不替用户选一个删掉。
fn move_dir_contents(
    from: &Path,
    to: &Path,
    depth: usize,
    moved: &mut usize,
    skipped: &mut usize,
) -> Result<(), String> {
    const MAX_DEPTH: usize = 24;
    if depth > MAX_DEPTH {
        return Err(format!(
            "move_dir_contents: depth limit exceeded at {}",
            from.display()
        ));
    }
    std::fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    let rd = std::fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))?;
    for ent in rd {
        let ent = ent.map_err(|e| e.to_string())?;
        let src = ent.path();
        let dst = to.join(ent.file_name());
        let is_dir = src.is_dir();
        if dst.exists() {
            if is_dir && dst.is_dir() {
                move_dir_contents(&src, &dst, depth + 1, moved, skipped)?;
            } else {
                *skipped += 1;
            }
            continue;
        }
        move_one(&src, &dst, is_dir)?;
        *moved += 1;
    }
    Ok(())
}

/// 单次移动：同卷 `rename`（瞬时、原子）；跨卷退化为 copy + 校验大小 + 删源。
fn move_one(src: &Path, dst: &Path, is_dir: bool) -> Result<(), String> {
    // 目标父目录可能还不存在（如迁移 ③：旧根顶层文件 → 新根的 legacy-downloads，
    // 新根刚从零建）。rename 在 Windows 上会因目标目录不存在而失败，再退化到 copy
    // 同样失败 ⇒ 补一次建目录，同卷跨卷两条路都稳。
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    if is_dir {
        // 跨卷目录：逐层递归（内部仍 rename 优先），最后 `remove_dir` 只对空目录成功
        // ⇒ 未搬走的内容会让它保持原位，不会连带删除。
        let mut m = 0usize;
        let mut s = 0usize;
        move_dir_contents(src, dst, 0, &mut m, &mut s)?;
        std::fs::remove_dir(src).map_err(|e| format!("remove {}: {e}", src.display()))?;
        return Ok(());
    }
    let n = std::fs::copy(src, dst)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dst.display()))?;
    let src_len = std::fs::metadata(src).map_err(|e| e.to_string())?.len();
    if n != src_len {
        return Err(format!(
            "copy size mismatch {} -> {} ({n} != {src_len})",
            src.display(),
            dst.display()
        ));
    }
    std::fs::remove_file(src).map_err(|e| format!("remove {}: {e}", src.display()))?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn fixture_root() -> std::path::PathBuf {
    // 测试二进制的真身在 `<target>/debug/deps/<name>.exe` ⇒ 回溯三级即 `target` 根。
    // 这比环境变量可靠：cargo 只为 **integration test** 的编译注入
    // `CARGO_TARGET_TMPDIR`，`src/**` 里的 unit test 编译期与运行期都取不到
    // （2026-10-19 实测：`env!` 直接编译失败，`env::var` 运行期为空）。
    // target 在工作区内 ⇒ 夹具跟着工作区盘走，且本就是 gitignore 的构建产物区。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(target) = exe.ancestors().nth(3) {
            return target.join("tmp");
        }
    }
    std::env::temp_dir()
}

/// 测试夹具根：**必须落在非禁用盘**上（用户 2026-10-19 裁定「禁止往C盘写入任何数据」）。
///
/// 为什么不能默认用系统临时目录：下载根一旦解析到 C: 会被改道到真实内容根
/// `D:\OrigDown`，于是「把夹具钉成下载路径」这个动作会静默指向**用户真实内容目录**。
/// 2026-10-19 实测两类事故：① 迁移类用例把 `chat--1`、`98-d.zip` 等夹具字节搬进了
/// `D:\OrigDown`（污染真实媒体库）；② 媒资清理类用例的删除动作会落在真实文件上
/// —— 比 ① 更糟，属于「测试动用户数据」。
///
/// 夹具根本身落在禁用盘（例如工作区就在 C:）时**直接 panic** —— 宁可测试红，
/// 也不许静默污染用户目录或假绿。
#[cfg(test)]
pub(crate) fn fixture_base(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = fixture_root().join(format!(
        "orig-tg-fixture-{tag}-{}-{nanos}",
        std::process::id()
    ));
    assert!(
        !orig_core::paths::is_forbidden_content_drive(&base),
        "fixture base {} is on a forbidden content drive; the C: drive ban redirects \
         every download root, so fixtures there would point at the real content root. \
         Run the tests through cargo from a workspace that is not on the C: drive.",
        base.display()
    );
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("fixture dir must be creatable");
    base
}

/// 带清理的夹具目录：离开作用域即整树删除（panic 时也删 —— unwind 会 drop）。
#[cfg(test)]
pub(crate) struct FixtureDir(std::path::PathBuf);

#[cfg(test)]
impl FixtureDir {
    pub(crate) fn new(tag: &str) -> Self {
        Self(fixture_base(tag))
    }
    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for FixtureDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store(name: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("orig_tg_store_{}_{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 清掉可能被 **pid 复用**继承的旧库：本 helper 原先不删文件，Windows 回收
        // pid 后新进程会打开上一轮留下的、仍带 `queued` 任务的库 ⇒ BUG-220 去重
        // 测试的「首个应新建」随机红（实测 62 个残留目录全部带 active 任务）。
        // 与 media.rs tests 的 `tmp_db`（先 remove_file）同一纪律。
        let db = dir.join("store.db");
        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_file(dir.join("store.db-wal"));
        let _ = std::fs::remove_file(dir.join("store.db-shm"));
        Store::open(db).await.unwrap()
    }

    #[tokio::test]
    async fn channel_crud() {
        let s = store("channel").await;
        s.add_channel(1, "Tech News", Some("technews")).await.unwrap();
        s.add_channel(2, "Media", None).await.unwrap();
        assert_eq!(s.list_channels().await.unwrap().len(), 2);
        // 幂等 upsert：更新标题不新增行。
        s.add_channel(1, "Tech News v2", Some("technews")).await.unwrap();
        assert_eq!(s.list_channels().await.unwrap().len(), 2);
        assert_eq!(s.get_channel(1).await.unwrap().unwrap().title, "Tech News v2");
        s.remove_channel(1).await.unwrap();
        assert!(s.get_channel(1).await.unwrap().is_none());
    }

    /// 未读计数 = `message_id > last_read_message_id` 的条数，点开即归零。
    ///
    /// 这条判据同时证伪三种假实现：
    /// - 「库里共几条」⇒ 点开后不会归零；
    /// - 「本轮同步加了几条」⇒ 不点开也会被下一轮清零；
    /// - 「读游标直接赋值 MAX」⇒ 消息被清理后游标会往回倒（见下一个测试）。
    #[tokio::test]
    async fn unread_count_follows_read_cursor() {
        let s = store("unread_cursor").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        for id in [10, 11, 12] {
            s.upsert_message(1, id, Some("x"), None, None, None, None, None, None, None)
                .await
                .unwrap();
        }
        assert_eq!(
            s.get_channel(1).await.unwrap().unwrap().new_count,
            3,
            "新入库的消息在点开前都应计为未读"
        );

        s.mark_channel_read(1).await.unwrap();
        assert_eq!(
            s.get_channel(1).await.unwrap().unwrap().new_count,
            0,
            "点开后未读必须归零 —— 否则徽标永远清不掉，等于没有这个功能"
        );

        s.upsert_message(1, 13, Some("y"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            s.get_channel(1).await.unwrap().unwrap().new_count,
            1,
            "点开之后再到的新消息才是「自上次点开以来新增」"
        );
    }

    /// 加入监控那一刻库里的存量**不算未读**（否则升级/新加频道第一眼就是几百条假新增）。
    #[tokio::test]
    async fn adding_a_channel_does_not_report_backlog_as_new() {
        let s = store("unread_backlog").await;
        // 消息先进库（历史残留 / 之前监控过又取消），再加监控。
        for id in [1, 2, 3, 4] {
            s.upsert_message(9, id, Some("old"), None, None, None, None, None, None, None)
                .await
                .unwrap();
        }
        s.add_channel(9, "Old Ch", None).await.unwrap();
        assert_eq!(
            s.get_channel(9).await.unwrap().unwrap().new_count,
            0,
            "加入监控前就在库里的内容不是「自上次点开以来新增」"
        );
    }

    /// 已读游标只进不退：消息被清理（行删除）后，已读的旧消息不得重新变成未读。
    #[tokio::test]
    async fn read_cursor_never_moves_backwards() {
        let s = store("unread_monotonic").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        for id in [100, 200, 300] {
            s.upsert_message(1, id, Some("x"), None, None, None, None, None, None, None)
                .await
                .unwrap();
        }
        s.mark_channel_read(1).await.unwrap();
        // 模拟清理：删掉最新那条（MAX 会从 300 掉到 200）。
        s.conn
            .execute(
                "DELETE FROM media_message WHERE channel_id = 1 AND message_id = 300",
                (),
            )
            .await
            .unwrap();
        s.mark_channel_read(1).await.unwrap();
        let cursor: i64 = s
            .row_opt(
                "SELECT last_read_message_id FROM monitored_channel WHERE channel_id = 1",
                (),
            )
            .await
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert_eq!(
            cursor, 300,
            "游标被回倒到 200 会让已读过的 201..300 重新变成「未读」"
        );
    }

    /// 筛选匹配字段 = **只有 caption（消息内容）**，文件名不参与。
    ///
    /// 用户 2026-10-22 改判原话：「我们筛选的是内容不是文件名,内容在消息中不在文件中。」
    /// 2026-10-19 曾裁定「caption 或 file_name 都算」，理由是 BUG-220「大量视频没有
    /// caption、只有文件名」。该理由在**显示**层仍成立（命中行要能看出是什么，故
    /// `MonitorFilterHit` 仍带出 file_name），但在**筛选**层不成立：文件名是文件属性，
    /// 不是内容；用它凑命中率等于把不可读的随机名（`C_DUM7FbyLchSjxK.mp4` 之类）
    /// 当成内容来匹配。
    ///
    /// 断言必须同时覆盖「file_name 命中的那条不在结果里」——只断言数量会漏：
    /// 把实现改回 `caption OR file_name` 时，若测试数据恰好只有一条命中，数量照样是 1。
    #[tokio::test]
    async fn filter_matches_caption_only() {
        let s = store("filter_match").await;
        s.add_channel(1, "剧集频道", Some("drama")).await.unwrap();
        s.add_channel(2, "另一个频道", None).await.unwrap();
        // ① 只有 caption 命中（应算）；② 只有 file_name 命中（不算）；③ 都不命中。
        s.upsert_message(1, 1, Some("第12集 完结"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        s.upsert_message(
            2,
            2,
            None,
            Some("video/mp4"),
            None,
            Some("video"),
            None,
            None,
            None,
            Some("短剧A_第12集.mp4"),
        )
        .await
        .unwrap();
        s.upsert_message(1, 3, Some("无关内容"), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let id = s.add_filter("第12集", "第12集").await.unwrap();
        let hits = s.filter_messages(id, 100, None).await.unwrap();
        assert_eq!(hits.len(), 1, "只有 caption 命中的那条算进来，file_name 命中的不算");
        assert_eq!(hits[0].message_id, 1, "命中的必须是 caption 那条");
        assert!(
            hits.iter().all(|h| h.message_id != 2),
            "file_name 命中的消息不得进结果（筛选的是内容，不是文件名）"
        );
        let titles: Vec<Option<String>> = hits.iter().map(|h| h.channel_title.clone()).collect();
        assert!(
            titles.iter().any(|t| t.as_deref() == Some("剧集频道")),
            "命中应带出来源频道标题（实测 {titles:?}）"
        );

        let listed = s.list_filters().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].hits, 1,
            "规则列表的命中数必须与实际命中一致，且不含文件名命中"
        );
    }

    /// 关键词里的 `%` / `_` 按字面匹配，不得变成通配符。
    #[tokio::test]
    async fn filter_escapes_like_wildcards() {
        let s = store("filter_escape").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        s.upsert_message(1, 1, Some("a_b 命名"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        s.upsert_message(1, 2, Some("axb 命名"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        let id = s.add_filter("下划线", "a_b").await.unwrap();
        let hits = s.filter_messages(id, 100, None).await.unwrap();
        assert_eq!(hits.len(), 1, "`_` 若当通配符会多命中 axb");
        assert_eq!(hits[0].message_id, 1);
    }

    /// 同关键词幂等：重复添加只更新显示名，不长出第二条一样的规则。
    #[tokio::test]
    async fn filter_add_is_idempotent_per_keyword() {
        let s = store("filter_idem").await;
        let a = s.add_filter("A", "关键词").await.unwrap();
        let b = s.add_filter("B", "关键词").await.unwrap();
        assert_eq!(a, b, "同关键词必须复用同一条规则");
        let listed = s.list_filters().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "B", "复用时应更新显示名");
        s.remove_filter(a).await.unwrap();
        assert!(s.list_filters().await.unwrap().is_empty());
    }

    /// 未监控频道的消息不参与筛选（口径：筛的是「监控内容」）。
    #[tokio::test]
    async fn filter_ignores_unmonitored_channels() {
        let s = store("filter_scope").await;
        s.add_channel(1, "监控中", None).await.unwrap();
        s.upsert_message(1, 1, Some("命中词"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        // 频道 2 未监控，但消息仍在库里（取消监控不删消息）。
        s.upsert_message(2, 2, Some("命中词"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        let id = s.add_filter("x", "命中词").await.unwrap();
        let hits = s.filter_messages(id, 100, None).await.unwrap();
        assert_eq!(hits.len(), 1, "只筛监控中的频道");
        assert_eq!(hits[0].channel_id, 1);
    }

    /// BUG-330 / TGM-06：`new_hits` = 自上次点开该规则以来新增；点开归零。
    ///
    /// 同时证伪两种假实现：①把总数当新命中（点开后不清零）；
    /// ②存量误判为新（建规则时把库里已有命中算成 +N——与 BUG-329 频道游标同坑）。
    ///
    /// **秒粒度说明**：游标是 unix 秒，与消息 `msg_date` 同粒度 ⇒ 「与点开同一秒内
    /// 到达的命中」落在边界上不计 +N（消息本身仍在命中列表里，费的只是徽标）。
    /// 监控同步 30s 一轮、用户点击是离散动作，同秒碰撞罕见；测试用**显式未来
    /// msg_date** 固化语义，不依赖墙钟竞速。
    #[tokio::test]
    async fn filter_new_hits_follows_read_cursor() {
        let s = store("filter_new_hits").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        s.upsert_message(1, 1, Some("纪录片 第一集"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        let id = s.add_filter("纪录片", "纪录片").await.unwrap();
        let listed = s.list_filters().await.unwrap();
        assert_eq!(listed[0].hits, 1);
        assert_eq!(
            listed[0].new_hits, 0,
            "建规则时库里已有的命中不算「新」——徽标说的是「自那以后的新东西」，不是「自开天辟地以来」"
        );
        // 显式未来 msg_date：不依赖墙钟（同秒到达在秒粒度游标下不可分辨）。
        let later = now() + 30;
        s.upsert_message(1, 2, Some("纪录片 第二集"), None, None, None, Some(later), None, None, None)
            .await
            .unwrap();
        assert_eq!(
            s.list_filters().await.unwrap()[0].new_hits,
            1,
            "建规则之后新到的命中才计为 +N"
        );
        s.mark_filter_read(id).await.unwrap();
        assert_eq!(s.list_filters().await.unwrap()[0].new_hits, 0, "点开后归零");
        let even_later = now() + 60;
        s.upsert_message(
            1,
            3,
            Some("纪录片 第三集"),
            None,
            None,
            None,
            Some(even_later),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            s.list_filters().await.unwrap()[0].new_hits,
            1,
            "点开之后再到的新命中才是「自上次点开以来新增」"
        );
    }

    /// 游标只进不退：旧/怪时间戳回写（时钟回拨、重放）不得把已读命中翻回「新」。
    #[tokio::test]
    async fn filter_read_cursor_only_moves_forward() {
        let s = store("filter_cursor_fwd").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        s.upsert_message(1, 1, Some("命中词"), None, None, None, None, None, None, None)
            .await
            .unwrap();
        let id = s.add_filter("x", "命中词").await.unwrap();
        // 未来时间戳（模拟坏时钟/重放）：mark 后必须保持未来值，不得被拉回。
        let future = now() + 10_000;
        s.conn
            .execute(
                "UPDATE monitor_filter SET last_read_at = ?1 WHERE id = ?2",
                params![future, id],
            )
            .await
            .unwrap();
        s.mark_filter_read(id).await.unwrap();
        let stored = s
            .row_opt(
                "SELECT last_read_at FROM monitor_filter WHERE id = ?1",
                params![id],
            )
            .await
            .unwrap()
            .unwrap()
            .get::<i64>(0)
            .unwrap();
        assert_eq!(
            stored, future,
            "MAX() 只进不退：未来游标不得被拉回（否则已读命中翻新）"
        );
        // 旧时间戳：mark 后必须推进到命中集合的最大日期（不是停在旧值）。
        s.conn
            .execute(
                "UPDATE monitor_filter SET last_read_at = ?1 WHERE id = ?2",
                params![1i64, id],
            )
            .await
            .unwrap();
        s.mark_filter_read(id).await.unwrap();
        let after = s
            .row_opt(
                "SELECT last_read_at FROM monitor_filter WHERE id = ?1",
                params![id],
            )
            .await
            .unwrap()
            .unwrap()
            .get::<i64>(0)
            .unwrap();
        assert!(after > 1, "点开后游标必须推进（实测 {after}）");
        assert_eq!(
            s.list_filters().await.unwrap()[0].new_hits,
            0,
            "推进后旧命中必须已读"
        );
    }

    /// BUG-330 / TGM-05：复合游标翻页无重复无跳过（message_id 跨频道不唯一）。
    #[tokio::test]
    async fn filter_hits_cursor_paginates_without_dupes() {
        let s = store("filter_page").await;
        s.add_channel(1, "甲频道", None).await.unwrap();
        s.add_channel(2, "乙频道", None).await.unwrap();
        // 同刻跨频道 3 对 + 两条其他日期的：date 相同的一批必须靠
        // (channel_id, message_id) 才能定出稳定全序。
        for mid in 1..=3i64 {
            s.upsert_message(1, mid, Some("命中词"), None, None, None, Some(500), None, None, None)
                .await
                .unwrap();
            s.upsert_message(2, mid, Some("命中词"), None, None, None, Some(500), None, None, None)
                .await
                .unwrap();
        }
        s.upsert_message(1, 10, Some("命中词"), None, None, None, Some(900), None, None, None)
            .await
            .unwrap();
        s.upsert_message(2, 10, Some("命中词"), None, None, None, Some(100), None, None, None)
            .await
            .unwrap();
        let id = s.add_filter("x", "命中词").await.unwrap();

        // 全量定序（date, channel_id, message_id 全降序）：
        //   (900,1,10) → (500,2,3) (500,2,2) (500,2,1) (500,1,3) (500,1,2) (500,1,1) → (100,2,10)
        let page1 = s.filter_messages(id, 2, None).await.unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(
            (page1[0].date, page1[0].channel_id, page1[0].message_id),
            (Some(900), 1, 10)
        );
        // 同刻跨频道：channel_id 降序 ⇒ ch2 的 m3 在 ch1 之前（原定序缺 channel_id，
        // 这两行的先后不确定，游标翻页必漏/重）。
        assert_eq!(
            (page1[1].date, page1[1].channel_id, page1[1].message_id),
            (Some(500), 2, 3)
        );

        let mut pages = page1.clone();
        let mut cursor = (
            page1[1].date.unwrap(),
            page1[1].channel_id,
            page1[1].message_id,
        );
        loop {
            let p = s.filter_messages(id, 2, Some(cursor)).await.unwrap();
            if p.is_empty() {
                break;
            }
            let last = p.last().unwrap();
            cursor = (last.date.unwrap(), last.channel_id, last.message_id);
            pages.extend(p);
            if pages.len() >= 8 {
                break;
            }
        }
        assert_eq!(pages.len(), 8, "8 条命中必须正好翻完（无跳过）");
        let mut keys: Vec<(i64, i64, i64)> = pages
            .iter()
            .map(|h| (h.date.unwrap(), h.channel_id, h.message_id))
            .collect();
        let uniq = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), uniq, "同一 (date, channel, message) 不得翻出两次");
        let mut prev: Option<(i64, i64, i64)> = None;
        for h in &pages {
            let k = (h.date.unwrap(), h.channel_id, h.message_id);
            if let Some(p) = prev {
                assert!(k < p, "定序必须严格递减，否则游标必漏/重：{p:?} → {k:?}");
            }
            prev = Some(k);
        }
    }

    /// BUG-330 / TGM-05：命中行带 `mime_type`/`file_path`（展开预览的数据基础）。
    #[tokio::test]
    async fn filter_hits_carry_preview_fields() {
        let s = store("filter_preview_fields").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        s.upsert_message(
            1,
            1,
            Some("命中词"),
            Some("video/mp4"),
            Some(123),
            Some("video"),
            Some(1000),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        s.mark_downloaded(1, 1, Some("D:/Verify/proxies/f.mp4"))
            .await
            .unwrap();
        let id = s.add_filter("x", "命中词").await.unwrap();
        let hits = s.filter_messages(id, 10, None).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].mime_type.as_deref(), Some("video/mp4"));
        assert_eq!(hits[0].file_path.as_deref(), Some("D:/Verify/proxies/f.mp4"));
    }

    /// BUG-345：group_id（活库实测 ~1.4e16 > JS `Number.MAX_SAFE_INTEGER`）
    /// 过 JSON 界必须是**字符串**——number 过界会被前端 `JSON.parse` 舍入成相邻
    /// 双精度（活库实证 70 个组键缓存任务里 62 个的 item_key 因此比真值差 1，
    /// 同一相册分裂成两个身份）。
    #[tokio::test]
    async fn group_id_crosses_json_as_string() {
        let hit = MonitorFilterHit {
            channel_id: -1004493170102,
            message_id: 4728,
            caption: None,
            file_name: None,
            media_type: None,
            size: None,
            duration: None,
            date: None,
            downloaded: false,
            channel_title: None,
            group_id: Some(14315949991671397),
            mime_type: None,
            file_path: None,
        };
        let v = serde_json::to_value(&hit).unwrap();
        assert_eq!(
            v.get("groupId").and_then(|g| g.as_str()),
            Some("14315949991671397"),
            "groupId 必须是 JSON 字符串：number 过界即丢精度（BUG-345）"
        );
    }

    /// BUG-345：存量污染键按**真** group_id 重写 `item_key` 与 `group_id` 两列
    /// （活库 62/70）；真值取不到的行不动；幂等（修过再跑 no-op）。
    #[tokio::test]
    async fn repairs_group_keys_corrupted_by_js_precision() {
        let s = store("bug345_key_repair").await;
        s.add_channel(-1004493170102, "麻豆短剧", None)
            .await
            .unwrap();
        for mid in 1..=3i64 {
            s.upsert_message(
                -1004493170102,
                mid,
                None,
                None,
                None,
                None,
                Some(1000 + mid),
                None,
                Some(14315949991671397),
                None,
            )
            .await
            .unwrap();
        }
        // 前端 number 过界后 …397 → …396（JS 双精度舍入），污染键照活库实证复刻。
        let (task, created) = s
            .enqueue_cache_task(
                -1004493170102,
                Some(14315949991671396),
                "g:-1004493170102:14315949991671396",
                &[1, 2, 3],
                ".",
            )
            .await
            .unwrap()
            .expect("task must be created");
        assert!(created, "首入队必须新建");
        let id = task.id;

        let repaired = repair_group_key_precision(&s.conn).await.unwrap();
        assert_eq!(repaired, 1, "正好一行污染键被修");
        let after = s.get_cache_task(id).await.unwrap().unwrap();
        assert_eq!(after.item_key, "g:-1004493170102:14315949991671397");
        assert_eq!(
            after.group_id,
            Some(14315949991671397),
            "group_id 列必须与键同源回到真值"
        );
        // 幂等：再跑一次 no-op。
        assert_eq!(repair_group_key_precision(&s.conn).await.unwrap(), 0);

        // 真值取不到的任务（首条消息不在库 / 无组）不动其键。
        let (orphan, _) = s
            .enqueue_cache_task(
                -1004493170102,
                Some(14315949991671396),
                "g:-1004493170102:14315949991671396",
                &[999],
                ".",
            )
            .await
            .unwrap()
            .expect("orphan task must be created");
        assert_eq!(repair_group_key_precision(&s.conn).await.unwrap(), 0);
        let orphan_after = s.get_cache_task(orphan.id).await.unwrap().unwrap();
        assert_eq!(orphan_after.item_key, "g:-1004493170102:14315949991671396");
    }

    /// BUG-341：相册组是命中单元——组内任一 member 匹配 ⇒ **整组入列**。
    ///
    /// 活库实证的缺陷形态：相册的组级 caption 只落在组内**一条**消息上（满员组
    /// 10 条仅 1 条带 caption）⇒ 旧逐条匹配实现每个相册只现 1 行、入库只传 1 个
    /// messageId，组结构与组内内容双丢失（用户「强调很多次」的缺陷）。
    #[tokio::test]
    async fn filter_group_hit_returns_whole_album() {
        let s = store("filter_group_album").await;
        s.add_channel(1, "相册频道", None).await.unwrap();
        // 10 条组内消息，只有 1 条带 caption（命中词）——活库里相册的真实形态。
        for mid in 1..=10i64 {
            let cap = if mid == 5 {
                Some("合集 命中词 特辑")
            } else {
                None
            };
            s.upsert_message(
                1,
                mid,
                cap,
                None,
                None,
                None,
                Some(1000 + mid),
                None,
                Some(77),
                None,
            )
            .await
            .unwrap();
        }
        let id = s.add_filter("合集", "命中词").await.unwrap();
        let hits = s.filter_messages(id, 100, None).await.unwrap();
        assert_eq!(hits.len(), 10, "组内任一 member 匹配 ⇒ 整组 10 条全部入列");
        assert!(
            hits.iter().all(|h| h.group_id == Some(77)),
            "入列的必须是整组成员（实测 {:?}）",
            hits.iter().map(|h| h.message_id).collect::<Vec<_>>()
        );
        // 计数按**单元**（相册）计：1 个相册 = 1，不是 10 条消息、也不是旧实现的 1 行。
        let listed = s.list_filters().await.unwrap();
        assert_eq!(listed[0].hits, 1, "命中数按单元（相册）计，与呈现粒度同源");
    }

    /// BUG-341：组级分页——`limit` 数**单元**不数消息；组永不被页边界切开
    /// （半截组 = 又一类「显示单条错误数据」）。
    #[tokio::test]
    async fn filter_group_pagination_never_splits_album() {
        let s = store("filter_group_page").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        // 两个相册（各 5 条，仅 1 条带命中 caption）+ 两条单条，全部同频道。
        for g in [10i64, 20] {
            for k in 1..=5i64 {
                let cap = if k == 1 { Some("命中词 组") } else { None };
                s.upsert_message(
                    1,
                    g + k,
                    cap,
                    None,
                    None,
                    None,
                    Some(2000 + g + k),
                    None,
                    Some(g),
                    None,
                )
                .await
                .unwrap();
            }
        }
        s.upsert_message(
            1,
            100,
            Some("命中词 单条A"),
            None,
            None,
            None,
            Some(3000),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        s.upsert_message(
            1,
            101,
            Some("命中词 单条B"),
            None,
            None,
            None,
            Some(2900),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let id = s.add_filter("x", "命中词").await.unwrap();

        // limit=1 个单元/页，四页必须正好翻完 4 个单元、12 条消息。
        let p1 = s.filter_messages(id, 1, None).await.unwrap();
        assert_eq!((p1.len(), p1[0].message_id), (1, 100), "最新单元 = 单条A");
        let p2 = s
            .filter_messages(id, 1, Some((3000, 1, 100)))
            .await
            .unwrap();
        assert_eq!((p2.len(), p2[0].message_id), (1, 101), "第二单元 = 单条B");
        let p3 = s
            .filter_messages(id, 1, Some((2900, 1, 101)))
            .await
            .unwrap();
        assert_eq!(
            p3.len(),
            5,
            "limit=1 数单元：第三单元是相册20，整组 5 条一起回（不被切成半截）"
        );
        assert!(p3.iter().all(|h| h.group_id == Some(20)));
        let last = p3.last().unwrap();
        let p4 = s
            .filter_messages(id, 1, Some((last.date.unwrap(), last.channel_id, last.message_id)))
            .await
            .unwrap();
        assert_eq!(p4.len(), 5, "第四单元 = 相册10 整组");
        assert!(p4.iter().all(|h| h.group_id == Some(10)));
        let last = p4.last().unwrap();
        let p5 = s
            .filter_messages(id, 1, Some((last.date.unwrap(), last.channel_id, last.message_id)))
            .await
            .unwrap();
        assert!(p5.is_empty(), "翻完必须正好为空（无重复无跳过）");
    }

    /// BUG-341：`+N 新命中` 按单元计——组里到了**新消息**（哪怕它自身不匹配），
    /// 整个相册单元也算「新」：用户看到的是组，不是当初匹配上的那一条。
    #[tokio::test]
    async fn filter_new_hits_counts_units() {
        let s = store("filter_group_new").await;
        s.add_channel(1, "Ch", None).await.unwrap();
        for k in 1..=3i64 {
            let cap = if k == 1 { Some("命中词 组") } else { None };
            s.upsert_message(
                1,
                k,
                cap,
                None,
                None,
                None,
                Some(1000 + k),
                None,
                Some(50),
                None,
            )
            .await
            .unwrap();
        }
        let id = s.add_filter("x", "命中词").await.unwrap();
        assert_eq!(
            s.list_filters().await.unwrap()[0].new_hits,
            0,
            "建规则时存量相册已读"
        );
        // 组里新到一条**自身不匹配**的消息：unit_date 前进 ⇒ 该单元算 +1 新。
        let later = now() + 30;
        s.upsert_message(1, 9, None, None, None, None, Some(later), None, Some(50), None)
            .await
            .unwrap();
        assert_eq!(
            s.list_filters().await.unwrap()[0].new_hits,
            1,
            "组内新消息让整个相册单元算新——用户看的是组"
        );
        s.mark_filter_read(id).await.unwrap();
        assert_eq!(s.list_filters().await.unwrap()[0].new_hits, 0, "点开后归零");
    }

    /// BUG-330 / TGM-06：老库升级后存量规则全为已读（不得一屏假「新命中」）。
    #[tokio::test]
    async fn filter_migration_backfills_existing_rows_as_read() {
        // 先造一个「老 schema」库：monitor_filter 没有 last_read_at。
        let dir = std::env::temp_dir().join(format!(
            "orig_tg_store_{}_filter_mig",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("store.db");
        let _ = std::fs::remove_file(&db);
        {
            let conn = libsql::Builder::new_local(&db)
                .build()
                .await
                .unwrap()
                .connect()
                .unwrap();
            conn.execute_batch(
                "CREATE TABLE monitor_filter (
                     id         INTEGER PRIMARY KEY AUTOINCREMENT,
                     label      TEXT NOT NULL,
                     keyword    TEXT NOT NULL,
                     created_at INTEGER NOT NULL
                 );
                 INSERT INTO monitor_filter (label, keyword, created_at)
                     VALUES ('老规则', '老词', 1);",
            )
            .await
            .unwrap();
        }
        // 正式开库：迁移补列 + 存量初始化为迁移时刻 now。
        let s = Store::open(&db).await.unwrap();
        s.add_channel(1, "Ch", None).await.unwrap();
        // 旧命中：msg_date=1（远古），必然早于迁移时刻。
        s.upsert_message(1, 1, Some("老词 命中"), None, None, None, Some(1), None, None, None)
            .await
            .unwrap();
        let listed = s.list_filters().await.unwrap();
        assert_eq!(listed.len(), 1, "存量规则必须在升级后仍在");
        assert_eq!(listed[0].hits, 1);
        assert_eq!(
            listed[0].new_hits, 0,
            "存量规则升级后不得把已有命中算成「新命中」（否则首屏全是假 +N）"
        );
    }

    #[tokio::test]
    async fn message_upsert_and_query() {
        let s = store("message").await;
        s.upsert_message(1, 100, Some("hello"), Some("video/mp4"), Some(1234), Some("video"), Some(1000), Some(95), Some(777), None)
            .await
            .unwrap();
        // 幂等 upsert：更新 caption，不新增行。
        s.upsert_message(1, 100, Some("dup"), Some("video/mp4"), Some(1234), Some("video"), Some(1000), None, None, None)
            .await
            .unwrap();
        s.upsert_message(1, 101, None, Some("image/jpeg"), None, Some("photo"), Some(1001), None, None, None)
            .await
            .unwrap();
        let msgs = s.list_messages(1, None, 10).await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].message_id, 101); // 新→旧
        assert_eq!(msgs[1].media_type.as_deref(), Some("video"));
        assert_eq!(msgs[1].date, Some(1000));
        // duration：首次入库写入；冲突 upsert 传 None 不清掉已有值。
        assert_eq!(msgs[1].duration, Some(95));
        // before_id 游标：只取 id < 101。
        let older = s.list_messages(1, Some(101), 10).await.unwrap();
        assert_eq!(older.len(), 1);
        assert_eq!(older[0].message_id, 100);
        assert!(s.list_messages(1, Some(100), 10).await.unwrap().is_empty());
        s.mark_downloaded(1, 100, Some(r#"C:\cache\video.mp4"#)).await.unwrap();
        let m = s.get_message(1, 100).await.unwrap().unwrap();
        assert!(m.downloaded);
        assert_eq!(m.file_path.as_deref(), Some(r#"C:\cache\video.mp4"#));
    }

    /// BUG-323（用户 2026-10-16 裁定）：库根**派生自下载路径**，不再是独立配置项。
    ///
    /// 判据含**反向证伪**：把历史两级配置（app_setting `library_dir` /
    /// config.json `libraryDir`）写到下载路径之外，库根也**不得**跟着跑出去 ——
    /// 否则「库根脱离下载路径」仍可表达，规则等于没落地。
    ///
    /// env 档（`ORIG_TG_LIBRARY_DIR` / `ORIG_TG_DOWNLOAD_DIR`）优先级最高，但为
    /// 进程级全局，测试无法并行安全地注入，故不在此覆盖（生产读的是同一行代码路径）。
    #[tokio::test]
    async fn library_root_follows_download_root_bug323() {
        let fx = FixtureDir::new("bug323_single_root");
        let dir = fx.path().to_path_buf();
        // 与 `store()` 同一纪律：清掉可能被 **pid 复用**继承的旧库/config.json。
        let _ = std::fs::remove_file(dir.join("store.db"));
        let _ = std::fs::remove_file(dir.join("store.db-wal"));
        let _ = std::fs::remove_file(dir.join("store.db-shm"));
        let _ = std::fs::remove_file(dir.join("config.json"));
        // 本进程若被注入过运维 env，先清掉，否则「默认档」断言不成立。
        unsafe {
            std::env::remove_var("ORIG_TG_LIBRARY_DIR");
            std::env::remove_var("ORIG_TG_DOWNLOAD_DIR");
        }
        let db_path = dir.join("store.db");
        let s = Store::open(&db_path).await.unwrap();

        // 下载路径未配置 → 名义默认过禁用盘规则后的内容根；库根 = 其下 `library`。
        // （用户 2026-10-19 裁定「~/Downloads是默认设置,但是不使用,改用加载配置的D盘设置」
        // ⇒ 名义默认在 C: 上时改取 D 盘内容根。）
        let expect_default = if orig_core::paths::is_forbidden_content_drive(
            &orig_core::paths::default_download_dir(),
        ) {
            orig_core::paths::content_root()
        } else {
            orig_core::paths::default_download_dir()
        };
        assert_eq!(
            s.library_root().await,
            Store::default_library_root(&expect_default),
            "未配置下载路径时库根必须是 名义默认(过禁用盘规则)/.orighub/library"
        );
        // 结构判据（2026-10-21「内部文件不入治理」）：库根必须住在引擎工作区之内。
        // 只断言字面值不够 —— 有人把 ENGINE_SUBDIR 改回普通名字，这条会一起漂。
        assert_eq!(
            s.library_root().await.file_name().and_then(|n| n.to_str()),
            Some(Store::LIBRARY_SUBDIR)
        );
        assert_eq!(
            s.library_root()
                .await
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str()),
            Some(Store::ENGINE_SUBDIR),
            "库根的父目录必须是引擎工作区 `.orighub`（下载根顶层只留用户内容）"
        );

        // 配置下载路径 → 库根**跟随**（不是并列、更不是各走各的）。
        let dl = dir.join("dl");
        s.set_setting("download_dir", dl.to_string_lossy().as_ref())
            .await
            .unwrap();
        assert_eq!(
            s.library_root().await,
            Store::default_library_root(&dl),
            "库根必须跟随下载路径"
        );
        assert!(
            !dl.join(Store::LIBRARY_SUBDIR).exists()
                && s.library_root().await != dl.join(Store::LIBRARY_SUBDIR),
            "库根不得留在下载根顶层（旧布局），否则内部目录会漏进成品扫描"
        );

        // 反向证伪：历史两级（app_setting / config.json）均不得再把库根带出下载路径。
        let outside = dir.join("outside-lib");
        s.set_setting("library_dir", outside.to_string_lossy().as_ref())
            .await
            .unwrap();
        std::fs::write(
            dir.join("config.json"),
            format!(
                r#"{{ "libraryDir": "{}" }}"#,
                outside.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        assert_eq!(
            s.library_root().await,
            Store::default_library_root(&dl),
            "历史两级配置不得把库根带出下载路径（BUG-323）"
        );
        assert!(
            !s.library_root().await.starts_with(&outside),
            "库根绝不允许落在下载路径之外"
        );

        // 代理（媒体字节）同规则：必须在下载路径之内。
        assert!(
            s.proxy_dir().await.starts_with(&dl),
            "代理目录必须落在下载路径之内（BUG-323）"
        );
    }

    /// BUG-323：存量库根迁移 —— 移动（不留副本）、遇同名**不覆盖**、DB 前缀改写、
    /// 重复调用不再搬字节。
    ///
    /// 这是规则落地的保命线：库根改为派生后，旧根下的存量字节若不跟随，
    /// 媒体库会整片显示「无字节」（相对路径解析到新根为空、绝对路径被闸门 403）。
    #[tokio::test]
    async fn migrates_legacy_library_root_bug323() {
        let fx = FixtureDir::new("bug323_migrate");
        let base = fx.path().to_path_buf();
        let old_root = base.join("appdata/tg/library");
        let dl = base.join("Downloads");
        let new_root = Store::default_library_root(&dl);
        std::fs::create_dir_all(old_root.join("chat--1")).unwrap();
        std::fs::create_dir_all(new_root.join("chat--1")).unwrap();
        // 旧根两项：`10-a.mp4` 在新根已有同名（内容不同 ⇒ 必须不覆盖）；
        // `11-b.mp4` 需被搬走。
        std::fs::write(old_root.join("chat--1/10-a.mp4"), b"OLD").unwrap();
        std::fs::write(old_root.join("chat--1/11-b.mp4"), b"MOVED").unwrap();
        std::fs::write(new_root.join("chat--1/10-a.mp4"), b"NEW").unwrap();

        let db = base.join("appdata/tg/store.db");
        let s = Store::open(&db).await.unwrap();
        s.set_setting("download_dir", dl.to_str().unwrap())
            .await
            .unwrap();
        s.set_setting("library_dir", old_root.to_str().unwrap())
            .await
            .unwrap();
        // 两条记录：一条**绝对**（旧库根下 ⇒ 需改写）、一条相对（库内规范形态 ⇒ 不动）。
        let abs_old = old_root.join("chat--1/11-b.mp4").to_string_lossy().into_owned();
        for (ref_key, path) in [("1", abs_old.clone()), ("2", "chat--1/11-b.mp4".to_string())] {
            s.conn
                .execute(
                    "INSERT INTO media_item (source, ref, title, kind, file_path, added_at) \
                     VALUES ('tg', ?1, 't', 'video', ?2, 0)",
                    libsql::params![ref_key, path],
                )
                .await
                .unwrap();
        }

        let m = s
            .migrate_legacy_managed_roots()
            .await
            .unwrap()
            .expect("must report a migration");
        assert_eq!(m.moved(), 1, "只搬未冲突的一项");
        assert_eq!(m.skipped(), 1, "同名项必须跳过");
        assert_eq!(m.rewritten(), 1, "只改写旧根下的绝对路径");
        assert_eq!(
            m.roots.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["library"],
            "本夹具只有库根一处旧落点"
        );
        assert_eq!(
            std::fs::read(new_root.join("chat--1/11-b.mp4")).unwrap(),
            b"MOVED",
            "字节必须被**移动**到新库根"
        );
        assert_eq!(
            std::fs::read(new_root.join("chat--1/10-a.mp4")).unwrap(),
            b"NEW",
            "同名冲突项绝不能被覆盖"
        );
        assert!(old_root.exists(), "有冲突项时旧目录不得被删");
        // DB：绝对路径已指到新根；相对路径原样保留
        let p1: String = s
            .conn
            .query(
                "SELECT file_path FROM media_item WHERE ref = '1'",
                libsql::params![],
            )
            .await
            .unwrap()
            .next()
            .await
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            paths_equal(Path::new(&p1), &new_root.join("chat--1/11-b.mp4")),
            "绝对路径必须改写到新库根，实际 = {p1}"
        );

        // 幂等：再跑一次不再搬任何字节、不再改任何路径
        let again = s.migrate_legacy_managed_roots().await.unwrap().unwrap();
        assert_eq!(again.moved(), 0, "重复调用不得再搬字节");
        assert_eq!(again.rewritten(), 0, "重复调用不得再改路径");
    }

    /// 2026-10-21「内部文件不入治理」：库根从 `<下载根>/library` 搬进
    /// `<下载根>/.orighub/library`，启动时整根 `rename`。
    ///
    /// 为什么必须是**整根**移动：`media_item.file_path` 是库根相对路径，只有根整体
    /// 挪位才继续解析得到；漏搬 = 整个媒体库「无字节」。
    /// 判据含幂等与「两代并存不静默合并」（合并要逐项冲突判定，不能启动期偷做）。
    #[test]
    fn library_moves_into_engine_dir_on_startup() {
        let base = fixture_base("lib_into_engine");
        let dl = base.join("dl");
        let old = dl.join(Store::LIBRARY_SUBDIR);
        let new = Store::default_library_root(&dl);
        std::fs::create_dir_all(old.join("chat--1")).unwrap();
        std::fs::write(old.join("chat--1/7-x.mp4"), b"BYTES").unwrap();

        Store::migrate_library_into_engine_dir(&dl);
        assert_eq!(
            std::fs::read(new.join("chat--1/7-x.mp4")).unwrap(),
            b"BYTES",
            "整根必须搬到 `.orighub/library`，相对路径才继续解析得到"
        );
        assert!(!old.exists(), "同卷 rename 后旧目录不得残留");

        // 幂等：再跑一次不报错、不动字节
        Store::migrate_library_into_engine_dir(&dl);
        assert_eq!(
            std::fs::read(new.join("chat--1/7-x.mp4")).unwrap(),
            b"BYTES"
        );

        // 两代并存：不静默合并（保留两侧，交人工判断）
        std::fs::create_dir_all(old.join("chat--1")).unwrap();
        std::fs::write(old.join("chat--1/8-y.mp4"), b"OLD").unwrap();
        Store::migrate_library_into_engine_dir(&dl);
        assert!(
            old.join("chat--1/8-y.mp4").exists(),
            "两代并存时不得静默搬/并（同名冲突无判据）"
        );
        assert!(
            !new.join("chat--1/8-y.mp4").exists(),
            "并存状态下不得把旧目录内容混进新根"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// BUG-323 复报（2026-10-19）：下载根**运行中变更**的迁移。
    ///
    /// 复报现象（活栈实证）：用户把下载路径改到 `D:\OrigDown` 后 ——
    /// 库根相对记录解析到空的 `<新根>/library`（失联）、绝对记录被边界闸门 403。
    /// `migrate_legacy_managed_roots` 只在启动时跑且只认固定落点，补不上这一刀。
    #[tokio::test]
    async fn migrates_root_change_moves_bytes_and_rewrites_db_bug323() {
        let fx = FixtureDir::new("bug323_root_change");
        let base = fx.path().to_path_buf();
        let old_root = base.join("oldroot");
        let new_root = base.join("newroot");
        let old_lib = Store::default_library_root(&old_root);
        // 旧根内容：库根一项、legacy-downloads 一项、顶层成品一个、未知子目录一个、
        // 引擎工作区一个（后两者**不得**被搬）。
        std::fs::create_dir_all(old_lib.join("chat--1")).unwrap();
        std::fs::write(old_lib.join("chat--1/11-b.mp4"), b"MOVED").unwrap();
        // 旧布局（2026-10-21 之前）的库根也在这个旧根上 —— 两代落点必须都搬，
        // 否则「升级前改过下载根」的用户整库失联。
        let old_lib_legacy = old_root.join(Store::LIBRARY_SUBDIR);
        std::fs::create_dir_all(old_lib_legacy.join("chat--1")).unwrap();
        std::fs::write(old_lib_legacy.join("chat--1/12-legacy.mp4"), b"OLDLAYOUT").unwrap();
        std::fs::create_dir_all(old_root.join(Store::LEGACY_DOWNLOADS_SUBDIR)).unwrap();
        std::fs::write(
            old_root.join(Store::LEGACY_DOWNLOADS_SUBDIR).join("99-c.zip"),
            b"LEGACY",
        )
        .unwrap();
        std::fs::write(old_root.join("98-d.zip"), b"TOP").unwrap();
        std::fs::create_dir_all(old_root.join("userdir")).unwrap();
        std::fs::write(old_root.join("userdir/mine.txt"), b"MINE").unwrap();
        std::fs::create_dir_all(old_root.join(Store::ENGINE_SUBDIR).join("proxies")).unwrap();
        std::fs::write(
            old_root.join(Store::ENGINE_SUBDIR).join("proxies/p.mp4"),
            b"PROXY",
        )
        .unwrap();

        let db = base.join("tg/store.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let s = Store::open(&db).await.unwrap();
        s.set_setting("download_dir", old_root.to_str().unwrap())
            .await
            .unwrap();
        s.set_setting("last_download_root", old_root.to_str().unwrap())
            .await
            .unwrap();
        let abs_old = old_lib.join("chat--1/11-b.mp4").to_string_lossy().into_owned();
        s.conn
            .execute(
                "INSERT INTO media_item (source, ref, title, kind, file_path, added_at) \
                 VALUES ('tg', '1', 't', 'video', ?1, 0)",
                libsql::params![abs_old],
            )
            .await
            .unwrap();

        // 用户改路径（= PUT /api/tg/config 的写入动作）
        s.set_setting("download_dir", new_root.to_str().unwrap())
            .await
            .unwrap();
        let m = s
            .migrate_root_change()
            .await
            .unwrap()
            .expect("root change must report a migration");

        // ① 库根字节搬到新库根；DB 绝对路径改写
        assert_eq!(m.moved, 4, "两代库根各 1 项 + legacy-downloads 1 项 + 顶层成品 1 项");
        assert_eq!(m.skipped, 0, "无同名冲突时不得跳过");
        let new_lib = Store::default_library_root(&new_root);
        assert_eq!(
            std::fs::read(new_lib.join("chat--1/11-b.mp4")).unwrap(),
            b"MOVED",
            "库根字节必须搬进新库根"
        );
        assert_eq!(
            std::fs::read(new_lib.join("chat--1/12-legacy.mp4")).unwrap(),
            b"OLDLAYOUT",
            "旧布局 `<旧根>/library` 的字节也必须一起搬（两代落点都认）"
        );
        let p1: String = s
            .conn
            .query("SELECT file_path FROM media_item WHERE ref = '1'", libsql::params![])
            .await
            .unwrap()
            .next()
            .await
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            paths_equal(Path::new(&p1), &new_lib.join("chat--1/11-b.mp4")),
            "绝对路径必须改写到新库根，实际 = {p1}"
        );
        // ② legacy-downloads 与顶层成品搬进新 legacy-downloads
        let new_ld = new_root.join(Store::LEGACY_DOWNLOADS_SUBDIR);
        assert_eq!(std::fs::read(new_ld.join("99-c.zip")).unwrap(), b"LEGACY");
        assert_eq!(std::fs::read(new_ld.join("98-d.zip")).unwrap(), b"TOP");
        // ③ 未知子目录与引擎工作区**不搬**（引擎不替用户搬家）
        assert!(
            old_root.join("userdir/mine.txt").exists(),
            "用户自放目录不得被搬动"
        );
        assert!(
            old_root.join(Store::ENGINE_SUBDIR).join("proxies/p.mp4").exists(),
            "转码代理是再生缓存，不随根变更搬迁"
        );
        // ④ 锚点更新为新的根
        assert_eq!(
            s.last_download_root().await,
            Some(new_root.clone()),
            "无冲突时锚点必须更新"
        );
        // ⑤ 幂等
        assert!(
            s.migrate_root_change().await.unwrap().is_none(),
            "第二次调用不得再迁移"
        );
    }

    /// BUG-323 复报（2026-10-19）：读取侧归一化 —— 存量 `download_dir` 存着
    /// 活栈实测的 `D://OrigDown`（双斜杠）时，读取即收敛为 `D:/OrigDown`。
    #[tokio::test]
    async fn download_root_folds_duplicate_separators_bug323() {
        let base = std::env::temp_dir()
            .join(format!("orig_tg_store_{}_", std::process::id()))
            .join("bug323_norm");
        let _ = std::fs::remove_dir_all(&base);
        let db = base.join("tg/store.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let s = Store::open(&db).await.unwrap();
        s.set_setting("download_dir", "D://OrigDown").await.unwrap();
        assert_eq!(
            s.download_root().await,
            PathBuf::from("D:/OrigDown"),
            "读取侧必须折叠重复分隔符（无需手工改库即恢复单一形态）"
        );
        // 库根从属于它，同样单一形态
        assert_eq!(
            s.library_root().await,
            Store::default_library_root(Path::new("D:/OrigDown"))
        );
    }

    /// BUG-323 复报（2026-10-19）：`paths_equal` 必须折叠分隔符连排，
    /// 否则 `D://X` 与 `D:/X` 会被判为两个根，去重/迁移/边界全部静默失效。
    #[test]
    fn paths_equal_folds_duplicate_separators_bug323() {
        assert!(paths_equal(Path::new("D://OrigDown"), Path::new("D:/OrigDown")));
        assert!(paths_equal(Path::new("D:\\OrigDown"), Path::new("D:/origdown")));
        assert!(!paths_equal(Path::new("D:/OrigDown2"), Path::new("D:/OrigDown")));
    }

    /// BUG-325：平台默认落点必须**只搬引擎子目录**，且默认目录与下载路径相同时
    /// 一项都不列。
    ///
    /// 这条测试是 BUG-325 的安全网：`platform_default_legacy_roots` 是**纯函数**
    /// （默认目录由参数注入），任何单测都无法通过它碰到真实家目录。回归判据：
    /// ① 两项且名字固定；② `~/Downloads` 顶层散落的用户文件不在列；
    /// ③ 默认目录 == 下载路径时为空（自己搬自己 = 自我吞噬）。
    #[test]
    fn platform_default_legacy_roots_lists_only_engine_subdirs_bug325() {
        let default_dir = Path::new("C:/Users/u/Downloads");
        let dl = Path::new("D:/OrigDown");
        let lib = Store::default_library_root(dl);
        let roots = Store::platform_default_legacy_roots(default_dir, dl, &lib);
        assert_eq!(
            roots.iter().map(|(n, _, _)| *n).collect::<Vec<_>>(),
            vec!["default-library", "default-downloads"],
            "只应有库根与缓存成品两项"
        );
        assert_eq!(
            roots[0].1,
            default_dir.join(Store::LIBRARY_SUBDIR),
            "来源必须是默认目录下的 library，不得是整个默认目录"
        );
        assert_eq!(roots[0].2, lib);
        assert_eq!(
            roots[1].1,
            default_dir.join(Store::LEGACY_DOWNLOADS_SUBDIR)
        );
        // 下载路径就是默认目录（用户没改路径）⇒ 无旧落点可搬
        assert!(
            Store::platform_default_legacy_roots(default_dir, default_dir, &lib).is_empty(),
            "默认目录与下载路径相同不得列出任何迁移项"
        );
        // 大小写/分隔符差异也算「相同」（`paths_equal` 折叠后比较）
        assert!(Store::platform_default_legacy_roots(
            Path::new("c:/users/u/downloads"),
            Path::new("C:\\Users\\u\\Downloads"),
            &lib
        )
        .is_empty());
    }

    /// BUG-323 第二处旧落点：**旧默认下载目录** `<数据目录>/downloads`。
    ///
    /// 这是同一缺陷的另一半：BUG-323 之前 `Config::default().download_dir` 指的是
    /// 这个应用内部目录，实测仍有 33 个文件 / 3.5 GB 真实媒资压在里面，且
    /// `media_item` / `media_message` / `cache_task` 三张表都有行指向它。
    /// 只搬库根 = 用户下过的片子整片变成「取不到」（绝对路径被权限闸门 403）。
    #[tokio::test]
    async fn migrates_legacy_downloads_root_bug323() {
        let fx = FixtureDir::new("bug323_downloads");
        let base = fx.path().to_path_buf();
        let data_dir = base.join("appdata/tg");
        let old_dl = data_dir.join("downloads");
        let dl = base.join("Downloads");
        let new_dl = dl.join(Store::LEGACY_DOWNLOADS_SUBDIR);
        std::fs::create_dir_all(&old_dl).unwrap();
        std::fs::write(old_dl.join("abc--1-2.mp4"), b"VIDEO").unwrap();
        std::fs::write(old_dl.join("photo--1_3.jpg"), b"PHOTO").unwrap();

        let db = data_dir.join("store.db");
        let s = Store::open(&db).await.unwrap();
        s.set_setting("download_dir", dl.to_str().unwrap())
            .await
            .unwrap();
        // 三张表各留一条指向旧下载目录的记录（`cache_task.dir` 是重复值的典型）。
        let abs = old_dl.join("abc--1-2.mp4").to_string_lossy().into_owned();
        s.conn
            .execute(
                "INSERT INTO media_item (source, ref, title, kind, file_path, added_at) \
                 VALUES ('tg', '1', 't', 'video', ?1, 0)",
                libsql::params![abs.clone()],
            )
            .await
            .unwrap();
        s.conn
            .execute(
                "INSERT INTO media_message (channel_id, message_id, file_path, downloaded, created_at) \
                 VALUES (1, 2, ?1, 0, 0)",
                libsql::params![abs.clone()],
            )
            .await
            .unwrap();
        for key in ["a:1", "b:2"] {
            s.conn
                .execute(
                    "INSERT INTO cache_task \
                       (chat_id, group_id, item_key, items, total, done, status, dir, created_at, updated_at) \
                     VALUES (1, NULL, ?1, '[]', 1, 1, 'done', ?2, 0, 0)",
                    libsql::params![key, old_dl.to_string_lossy().to_string()],
                )
                .await
                .unwrap();
        }

        let m = s
            .migrate_legacy_managed_roots()
            .await
            .unwrap()
            .expect("must report a migration");
        assert_eq!(
            m.roots.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["downloads"],
            "本夹具只有旧下载目录一处落点"
        );
        assert_eq!(m.moved(), 2, "两个文件都要搬");
        assert_eq!(
            m.rewritten(),
            3,
            "三张表各一条：media_item.file_path + media_message.file_path + cache_task.dir（后者的两行同值只算一次改写）"
        );
        assert_eq!(
            std::fs::read(new_dl.join("abc--1-2.mp4")).unwrap(),
            b"VIDEO",
            "字节必须落到 <下载路径>/legacy-downloads"
        );
        assert!(!old_dl.exists(), "全部搬走后旧目录必须移除（不留空壳）");
        // 新落点仍在下载路径之内（规则：所有文件不允许脱离下载路径）。
        assert!(new_dl.starts_with(&dl), "搬迁落点必须在下载路径之内");

        // 三张表都不再留旧地址
        for (table, col) in [
            ("media_item", "file_path"),
            ("media_message", "file_path"),
            ("cache_task", "dir"),
        ] {
            let n: i64 = s
                .conn
                .query(
                    &format!("SELECT count(*) FROM {table} WHERE {col} LIKE ?1"),
                    libsql::params![format!("%{}%", old_dl.to_string_lossy())],
                )
                .await
                .unwrap()
                .next()
                .await
                .unwrap()
                .unwrap()
                .get(0)
                .unwrap();
            assert_eq!(n, 0, "{table}.{col} 不得再指向旧下载目录");
        }
        // 幂等
        assert!(
            s.migrate_legacy_managed_roots().await.unwrap().is_none(),
            "重复调用不得再报迁移"
        );
    }

    /// 前缀剥离必须停在分隔符边界（`C:\Downloads` 不吃 `C:\Downloads2`）。
    #[test]
    fn strip_prefix_stops_at_separator() {
        assert_eq!(
            strip_prefix_ci(
                r"C:\Users\u\Downloads\library\a.mp4",
                r"C:\Users\u\Downloads\library"
            ),
            Some(r"\a.mp4".to_string())
        );
        assert_eq!(
            strip_prefix_ci(r"C:\Users\u\Downloads2\a.mp4", r"C:\Users\u\Downloads"),
            None,
            "平行目录（前缀相同但不是子路径）不得被当作命中"
        );
        assert_eq!(
            strip_prefix_ci(
                r"c:\users\u\downloads\library\a.mp4",
                r"C:\Users\u\Downloads\Library"
            ),
            Some(r"\a.mp4".to_string()),
            "Windows 路径大小写不敏感"
        );
        assert_eq!(strip_prefix_ci("a.mp4", r"C:\x"), None);
    }

    #[tokio::test]
    async fn stored_library_query() {
        let s = store("stored_lib").await;
        s.add_channel(1, "Movies", None).await.unwrap();
        s.upsert_message(1, 10, Some("ep1"), Some("video/mp4"), Some(100), Some("video"), Some(900), Some(60), None, None)
            .await
            .unwrap();
        s.upsert_message(1, 11, Some("ep2"), Some("video/mp4"), Some(200), Some("video"), Some(901), Some(120), None, None)
            .await
            .unwrap();
        s.upsert_message(2, 20, Some("song"), Some("audio/mpeg"), Some(30), Some("audio"), Some(902), Some(180), None, None)
            .await
            .unwrap();
        s.mark_downloaded(1, 10, Some(r#"C:\cache\ep1.mp4"#)).await.unwrap();

        // 全量聚合：3 条，新→旧，含频道标题（频道 2 未监控 → None）。
        let all = s
            .list_stored(&StoredQuery { limit: 50, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].msg.message_id, 20);
        assert_eq!(all[2].channel_title.as_deref(), Some("Movies"));
        assert_eq!(all[2].msg.duration, Some(60));

        // 仅已缓存。
        let done = s
            .list_stored(&StoredQuery { downloaded_only: true, limit: 50, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].msg.message_id, 10);

        // 按类型过滤。
        let vids = s
            .list_stored(&StoredQuery {
                media_type: Some("video".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(vids.len(), 2);

        // 关键词命中频道标题与 caption。
        let by_ch = s
            .list_stored(&StoredQuery { q: Some("Movies".into()), limit: 50, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(by_ch.len(), 2);
        let by_kw = s
            .list_stored(&StoredQuery { q: Some("ep1".into()), limit: 50, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(by_kw.len(), 1);

        // before_id 游标分页。
        let page2 = s
            .list_stored(&StoredQuery { before_id: Some(20), limit: 50, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(page2.len(), 2);
    }

    #[tokio::test]
    async fn cursor_roundtrip() {
        let s = store("cursor").await;
        assert!(s.get_cursor(1).await.unwrap().is_none());
        s.set_cursor(1, 500).await.unwrap();
        assert_eq!(s.get_cursor(1).await.unwrap(), Some(500));
        s.set_cursor(1, 600).await.unwrap();
        assert_eq!(s.get_cursor(1).await.unwrap(), Some(600));
    }

    #[tokio::test]
    async fn dialog_cache_crud() {
        let s = store("dialog_cache").await;
        assert_eq!(s.count_dialogs().await.unwrap(), 0);
        let mk = |id: i64, title: &str, folder: Option<&str>| Channel {
            id,
            title: title.to_string(),
            username: Some(format!("u{id}")),
            folder: folder.map(str::to_string),
        };
        s.upsert_dialog(&mk(1, "A", Some("News"))).await.unwrap();
        s.upsert_dialog(&mk(2, "B", None)).await.unwrap();
        s.upsert_dialog(&mk(3, "C", Some("Media"))).await.unwrap();
        assert_eq!(s.count_dialogs().await.unwrap(), 3);
        // 幂等 upsert：同 id 更新不新增。
        s.upsert_dialog(&mk(2, "B2", Some("News"))).await.unwrap();
        assert_eq!(s.count_dialogs().await.unwrap(), 3);
        // 分页读取带回 folder。
        let page = s.read_dialogs(0, 2).await.unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, 1);
        assert_eq!(page[1].folder.as_deref(), Some("News"));
        let page2 = s.read_dialogs(2, 10).await.unwrap();
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].id, 3);
        // 清缓存仅清 dialog_cache。
        s.clear_dialog_cache().await.unwrap();
        assert_eq!(s.count_dialogs().await.unwrap(), 0);
    }

    /// BUG-194 策略钉子：`dialog_cache` **永不**接受空标题行。
    ///
    /// 覆盖写入侧的不变量（空串、纯空白、None 全部被兜底成带 id 的可辨识名），
    /// 以及「有名会话一字不动」的不回归（doc 验收：279 条频道/群组不受影响）。
    #[tokio::test]
    async fn dialog_cache_never_stores_blank_title_bug194() {
        let s = store("dialog_cache_bug194").await;
        let raw = |id: i64, title: &str| Channel {
            id,
            title: title.to_string(),
            username: None,
            folder: None,
        };
        // 空串、纯空白、知名会话、以及一个频道（负 id）。
        s.upsert_dialog(&raw(100, "")).await.unwrap();
        s.upsert_dialog(&raw(101, "   ")).await.unwrap();
        s.upsert_dialog(&raw(-1004493170102, "麻豆短剧")).await.unwrap();
        s.upsert_dialog(&raw(777000, "Telegram")).await.unwrap();

        let all = s.read_dialogs(0, 100).await.unwrap();
        // 验收断言（doc）：空标题条数 = 0。
        let blanks = all.iter().filter(|c| c.title.trim().is_empty()).count();
        assert_eq!(blanks, 0, "dialog_cache 不得存在空标题行: {all:?}");
        assert_eq!(all.len(), 4);

        // 无名条目必须「可辨识」：两两不同，且都带自己的 id —— 否则 158 条
        // 全标成同一个「已删除账户」，用户依旧分辨不出来。
        let by_id = |id: i64| all.iter().find(|c| c.id == id).unwrap().title.clone();
        assert_ne!(by_id(100), by_id(101), "两条无名会话必须可区分");
        assert!(by_id(100).contains("100"), "兜底名须带 id: {}", by_id(100));
        assert!(by_id(101).contains("101"), "兜底名须带 id: {}", by_id(101));
        // 知名会话原样保留（不回归）。
        assert_eq!(by_id(777000), "Telegram");
        assert_eq!(by_id(-1004493170102), "麻豆短剧");

        // 幂等：重复 upsert 同一行仍非空，且不新增行。
        s.upsert_dialog(&raw(100, "")).await.unwrap();
        assert_eq!(s.count_dialogs().await.unwrap(), 4);
        let page = s.read_dialogs(0, 100).await.unwrap();
        assert_eq!(page.iter().filter(|c| c.title.trim().is_empty()).count(), 0);
    }

    /// BUG-194：存量空标题行被迁移幂等回填；第二次打开影响 0 行。
    #[tokio::test]
    async fn dialog_cache_backfill_is_idempotent_bug194() {
        let dir = std::env::temp_dir().join(format!(
            "orig_tg_store_bug194_backfill_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.db");

        // 先造一个「旧库」：绕过 upsert_dialog 直接写空标题，模拟 BUG-194 修复前。
        {
            let s = Store::open(&path).await.unwrap();
            s.conn
                .execute(
                    "INSERT INTO dialog_cache (id, title, username, folder, init_at)
                     VALUES (555, '', NULL, NULL, 0), (556, '  ', NULL, NULL, 0),
                            (777000, 'Telegram', NULL, NULL, 0)",
                    (),
                )
                .await
                .unwrap();
            assert_eq!(s.count_dialogs().await.unwrap(), 3);
        }

        // 重新打开 ⇒ 迁移跑过：两条空标题被补成可辨识名，知名行不动。
        let healed = {
            let s = Store::open(&path).await.unwrap();
            let all = s.read_dialogs(0, 100).await.unwrap();
            assert_eq!(all.iter().filter(|c| c.title.trim().is_empty()).count(), 0);
            assert_eq!(all.len(), 3, "回填不得增删行");
            let named = all.iter().find(|c| c.id == 777000).unwrap();
            assert_eq!(named.title, "Telegram", "有名会话不得被回填改动");
            let f = |id: i64| all.iter().find(|c| c.id == id).unwrap().title.clone();
            assert!(f(555).contains("555") && f(556).contains("556"));
            assert_ne!(f(555), f(556));
            // 第三次打开：幂等，影响 0 行。
            drop(s);
            migrate_dialog_cache_blank_titles_readonly(&path).await
        };
        assert_eq!(healed, 0, "回填必须幂等：第二次不应再改任何行");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 以独立连接跑一次回填迁移并返回受影响行数（用于断言幂等）。
    async fn migrate_dialog_cache_blank_titles_readonly(path: &Path) -> usize {
        let conn = libsql::Builder::new_local(path)
            .build()
            .await
            .unwrap()
            .connect()
            .unwrap();
        migrate_dialog_cache_blank_titles(&conn).await.unwrap()
    }

    /// BUG-193 存储层判据：**归档（非主文件夹）里的会话必须真的落进缓存**。
    ///
    /// doc 的验收口径是「`folders` 声明的 `channel_ids` 与 `dialog_cache`
    /// 取到的 id 集合**差集为空**」。这条测试就是那个差集判据的存储侧钉子：
    /// 先写入一个只有归档频道才有的 id，再断言它能被 `read_dialogs` 取回、
    /// 且带 `folder` 标注。
    ///
    /// 为什么钉在存储层而不是只钉枚举层：`dialog_cache.id` 是主键，写入路径若
    /// （将来）漏了某一类来源，这里会红；反之若有人「顺手」把归档会话过滤掉，
    /// 枚举层的单测未必覆盖得到落库这一步。
    #[tokio::test]
    async fn archived_folder_dialog_is_cached_bug193() {
        let s = store("dialog_cache_bug193_archive").await;
        // 归档频道的 id 形态：-1000000000000 - channel_id（负数，落在频道区间）。
        let archived_id: i64 = -1_000_000_004_493_170_102i64;
        let archived = Channel {
            id: archived_id,
            title: "归档里的频道".to_string(),
            username: Some("archivedchan".to_string()),
            folder: Some("‼️全网分组中心A‼️".to_string()),
        };
        // 主文件夹的一条，用来证明两者共存而不是互相覆盖。
        let primary = Channel {
            id: 777_000,
            title: "Telegram".to_string(),
            username: Some("telegram".to_string()),
            folder: Some("MyTop".to_string()),
        };
        s.upsert_dialog(&archived).await.unwrap();
        s.upsert_dialog(&primary).await.unwrap();

        // 归档那条必须真的在库里，且 folder 标注如实带回。
        let all = s.read_dialogs(0, 100).await.unwrap();
        let got = all
            .iter()
            .find(|c| c.id == archived_id)
            .expect("归档会话必须落进 dialog_cache（BUG-193）");
        assert_eq!(got.title, "归档里的频道");
        assert_eq!(got.folder.as_deref(), Some("‼️全网分组中心A‼️"));
        assert_eq!(got.username.as_deref(), Some("archivedchan"));

        // 主文件夹那条不回归（doc 验收：MyTop 保持 20/20 的同类判据）。
        let p = all.iter().find(|c| c.id == 777_000).unwrap();
        assert_eq!(p.folder.as_deref(), Some("MyTop"));

        // 幂等：重复写入不新增行，且 folder 标注不被冲掉。
        s.upsert_dialog(&archived).await.unwrap();
        assert_eq!(s.count_dialogs().await.unwrap(), 2);
        let again = s.read_dialogs(0, 100).await.unwrap();
        assert_eq!(
            again.iter().find(|c| c.id == archived_id).unwrap().folder.as_deref(),
            Some("‼️全网分组中心A‼️"),
            "重复 upsert 不得把归档会话的分组标注冲成 NULL"
        );

        // 对账判据的存储侧形态：声明集合与缓存集合差集为空。
        let declared = [archived_id, 777_000];
        let cached: std::collections::HashSet<i64> = all.iter().map(|c| c.id).collect();
        let missing: Vec<i64> = declared
            .iter()
            .copied()
            .filter(|id| !cached.contains(id))
            .collect();
        assert!(
            missing.is_empty(),
            "分组声明的会话必须全在缓存里，差集须为空（BUG-193）: {missing:?}"
        );
    }

    /// 缓存任务状态机：入队 → 复用 → 进度 → 终态 → 取消 → 僵尸降级。
    #[tokio::test]
    async fn cache_task_lifecycle() {
        let s = store("cache_task").await;

        // 入队：新建（created=true），初始 queued、done=0。
        let (t1, created) = s
            .enqueue_cache_task(7, Some(900), "g:7:900", &[11, 12, 13], "D:/dl")
            .await
            .unwrap()
            .unwrap();
        assert!(created);
        assert_eq!(t1.total, 3);
        assert_eq!(t1.done, 0);
        assert_eq!(t1.status, "queued");
        assert_eq!(t1.message_ids, vec![11, 12, 13], "消息号须原样保留顺序");

        // 复用：同 key 再入队返回同一任务（幂等，不产生第二条）。
        let (t2, created2) = s
            .enqueue_cache_task(7, Some(900), "g:7:900", &[11, 12, 13], "D:/dl")
            .await
            .unwrap()
            .unwrap();
        assert!(!created2, "活跃任务必须复用而非新建");
        assert_eq!(t2.id, t1.id);
        assert_eq!(s.list_cache_tasks(50).await.unwrap().len(), 1);

        // running + 进度。
        s.mark_cache_task_running(t1.id).await.unwrap();
        s.update_cache_task_progress(t1.id, 1, Some(12)).await.unwrap();
        let t = s.get_cache_task(t1.id).await.unwrap().unwrap();
        assert_eq!(t.status, "running");
        assert_eq!(t.done, 1);
        assert_eq!(t.current_id, Some(12));

        // 取消：置终态；worker 事后不能把它改写成 done（finish 仅对活跃态生效）。
        assert!(s.cancel_cache_task(t1.id).await.unwrap());
        s.finish_cache_task(t1.id, "done", None).await.unwrap();
        let t = s.get_cache_task(t1.id).await.unwrap().unwrap();
        assert_eq!(t.status, "cancelled", "取消后不得被 worker 覆盖为 done");
        assert!(!s.is_cache_task_active(t1.id).await.unwrap());
        // 已结束的任务再取消 → 未命中。
        assert!(!s.cancel_cache_task(t1.id).await.unwrap());

        // 终态后同 key 可再次入队（partial unique 只约束活跃态）。
        let (t3, created3) = s
            .enqueue_cache_task(7, Some(900), "g:7:900", &[11, 12, 13], "D:/dl")
            .await
            .unwrap()
            .unwrap();
        assert!(created3, "终态任务的 key 应可重新入队");
        assert_ne!(t3.id, t1.id);

        // 僵尸降级：重启后残留的活跃任务不得继续表现为活跃（否则前端永远显示「缓存中」）。
        s.mark_cache_task_running(t3.id).await.unwrap();
        assert_eq!(s.mark_stale_cache_tasks().await.unwrap(), 1);
        let t = s.get_cache_task(t3.id).await.unwrap().unwrap();
        assert_eq!(t.status, "interrupted");
        assert_eq!(t.current_id, None);

        // 列表：活跃优先，其余新→旧。
        let (a, _) = s
            .enqueue_cache_task(8, None, "m:8:21", &[21], "D:/dl")
            .await
            .unwrap()
            .unwrap();
        let list = s.list_cache_tasks(50).await.unwrap();
        assert_eq!(list[0].id, a.id, "活跃任务必须排在最前");
    }

    // ── BUG-257：重启恢复（queued 保留 + running 降级 + 重新入队） ─────────

    /// 造一条 `queued` 任务（入队即queued，从未起跑）。
    async fn queued_task(s: &Store, key: &str, msg: i64) -> CacheTask {
        s.enqueue_cache_task(7, None, key, &[msg], "D:/dl")
            .await
            .unwrap()
            .unwrap()
            .0
    }

    /// 判据 4 的核心：重启后 **`queued` 仍是 `queued`**，不得被降级（BUG-257）。
    ///
    /// 此前 `mark_stale_cache_tasks` 的 WHERE 覆盖 `('queued','running')`，实测一次
    /// 重启把 26 个 `queued` 全部作废——「重启即清空待办」。`queued` 从未传输过一个
    /// 字节，把它标成 `interrupted`（中途被打断）本就**没有依据**。
    #[tokio::test]
    async fn restart_keeps_queued_tasks_queued_instead_of_flattening_them() {
        let s = store("restart_queued").await;
        let a = queued_task(&s, "m:7:1", 1).await;
        let b = queued_task(&s, "m:7:2", 2).await;

        let n = s.mark_stale_cache_tasks().await.unwrap();
        assert_eq!(n, 0, "只有 running 该降级；纯 queued 队列不该产生任何 interrupted");

        for id in [a.id, b.id] {
            let t = s.get_cache_task(id).await.unwrap().unwrap();
            assert_eq!(
                t.status, "queued",
                "重启不得把排队任务降级 —— 用户排的队凭空消失"
            );
        }
    }

    /// 恢复清单：重启后交回启动流程重新入队的**正是**那些 `queued`，且按 FIFO 升序
    /// （单飞 worker 依赖「最老的先跑」接续，顺序错了就是先跑新的）。
    #[tokio::test]
    async fn recover_returns_the_queued_tasks_in_fifo_order() {
        let s = store("restart_recover").await;
        let a = queued_task(&s, "m:7:11", 11).await;
        let b = queued_task(&s, "m:7:12", 12).await;
        // 一条 running：降级成 interrupted，**不得**出现在恢复清单里。
        let c = queued_task(&s, "m:7:13", 13).await;
        s.mark_cache_task_running(c.id).await.unwrap();
        s.mark_stale_cache_tasks().await.unwrap();

        let recovered = s.recover_queued_cache_tasks().await.unwrap();
        let ids: Vec<i64> = recovered.iter().map(|t| t.id).collect();
        assert_eq!(
            ids,
            vec![a.id, b.id],
            "恢复清单 = 仍在排队的，按 id 升序（FIFO）"
        );
        assert!(
            !ids.contains(&c.id),
            "running 已被降级为 interrupted，不该再被当成待办重跑"
        );
        // 终态的 interrupted 仍是**可恢复**的（用户在 RETRYABLE_STATES 里，BUG-249）。
        assert_eq!(
            s.get_cache_task(c.id).await.unwrap().unwrap().status,
            "interrupted"
        );
    }

    /// 降级只碰 `running`：混编队列里 queued 存活、running 降级，两类互不干扰。
    /// 这是「重启前后 queued 计数差不超过正在运行的 1 条」那条判据的 store 侧守卫。
    #[tokio::test]
    async fn stale_downgrade_touches_only_the_running_task() {
        let s = store("restart_mixed").await;
        let q1 = queued_task(&s, "m:7:21", 21).await;
        let r1 = queued_task(&s, "m:7:22", 22).await;
        let q2 = queued_task(&s, "m:7:23", 23).await;
        s.mark_cache_task_running(r1.id).await.unwrap();

        assert_eq!(s.mark_stale_cache_tasks().await.unwrap(), 1, "只降级那1 条 running");
        assert_eq!(s.get_cache_task(q1.id).await.unwrap().unwrap().status, "queued");
        assert_eq!(s.get_cache_task(r1.id).await.unwrap().unwrap().status, "interrupted");
        assert_eq!(s.get_cache_task(q2.id).await.unwrap().unwrap().status, "queued");
    }

    /// BUG-257 附带修掉的读数泄漏：任务被取消后，**迟到的进度写不得再改写它**。
    ///
    /// `finish_cache_task` 早有 `status IN {CACHE_TASK_ACTIVE_STATES}` 状态门，
    /// 唯独 `update_cache_task_progress` 漏了——于是用户点了取消，进度条还在涨
    /// （「取消了却还在动」）。终态记录是**事实**，不该被迟到的 worker 改写。
    #[tokio::test]
    async fn progress_writes_stop_once_a_task_reaches_a_terminal_state() {
        let s = store("progress_guard").await;
        let t = queued_task(&s, "m:7:31", 31).await;
        s.mark_cache_task_running(t.id).await.unwrap();
        s.update_cache_task_progress(t.id, 2, Some(31)).await.unwrap();
        assert_eq!(
            s.get_cache_task(t.id).await.unwrap().unwrap().done,
            2,
            "活跃态下进度照常写入"
        );

        s.cancel_cache_task(t.id).await.unwrap();
        // 模拟 worker 收尾时那次迟到的写（真实路径：download 返回后才写）。
        s.update_cache_task_progress(t.id, 9, Some(99)).await.unwrap();
        let got = s.get_cache_task(t.id).await.unwrap().unwrap();
        assert_eq!(got.status, "cancelled", "状态不得被改写");
        assert_eq!(
            got.done, 2,
            "已取消任务的 done 不得继续增长 —— 取消后进度还在涨就是假的"
        );
        assert_eq!(got.current_id, None, "也不该再被写入正在处理的条目");
    }

    /// 回归（BUG-051 缓存管理）：终态记录**必须能删**，活跃任务也能删（先取消再删行），
    /// 「清空全部」必须连活跃任务一起清。
    #[tokio::test]
    async fn cache_task_delete_single_and_clear_all() {
        async fn mk_task(s: &Store, key: &str, msg: i64) -> CacheTask {
            s.enqueue_cache_task(9, None, key, &[msg], "D:/dl")
                .await
                .unwrap()
                .unwrap()
                .0
        }

        let s = store("cache_delete").await;

        let (t1, _) = s
            .enqueue_cache_task(9, None, "m:9:31", &[31], "D:/dl")
            .await
            .unwrap()
            .unwrap();
        let (t2, _) = s
            .enqueue_cache_task(9, None, "m:9:32", &[32], "D:/dl")
            .await
            .unwrap()
            .unwrap();
        // t1 置终态，t2 保持 queued（活跃）。
        s.finish_cache_task(t1.id, "done", None).await.unwrap();

        // 单删：终态记录可删（此前只能取消活跃任务，终态直接 404 → 永远删不掉）。
        assert!(s.delete_cache_task(t1.id).await.unwrap());
        assert!(s.get_cache_task(t1.id).await.unwrap().is_none());
        assert!(!s.delete_cache_task(t1.id).await.unwrap(), "重复删除未命中");

        // 活跃任务也能删：先置 cancelled 再删行，worker 不会继续写进度。
        assert!(s.delete_cache_task(t2.id).await.unwrap());
        assert!(s.get_cache_task(t2.id).await.unwrap().is_none());

        // —— 批量清除：动词只有一个，范围三档互斥且并集为全集 ——
        let ran = mk_task(&s, "m:9:33", 33).await;
        let ok = mk_task(&s, "m:9:34", 34).await;
        let bad = mk_task(&s, "m:9:35", 35).await;
        s.finish_cache_task(ok.id, "done", None).await.unwrap();
        s.finish_cache_task(bad.id, "failed", Some("boom"))
            .await
            .unwrap();
        assert_eq!(
            s.count_cache_tasks().await.unwrap().iter().map(|(_, n)| n).sum::<i64>(),
            3
        );

        // success 档：只删成功，**活跃任务不受伤**（这是「清除记录」与「清空全部」的分界线）。
        assert_eq!(s.clear_cache_tasks(TaskClearScope::Success).await.unwrap(), 1);
        assert!(s.get_cache_task(ok.id).await.unwrap().is_none());
        assert!(s.get_cache_task(ran.id).await.unwrap().is_some(), "活跃任务必须存活");
        assert!(s.get_cache_task(bad.id).await.unwrap().is_some());

        // failed 档：只删失败类，活跃任务同样不受伤。
        assert_eq!(s.clear_cache_tasks(TaskClearScope::Failed).await.unwrap(), 1);
        assert!(s.get_cache_task(bad.id).await.unwrap().is_none());
        assert!(s.get_cache_task(ran.id).await.unwrap().is_some());

        // all 档：连活跃任务一起清（先置 cancelled 停 worker，再删行）。
        assert_eq!(s.clear_cache_tasks(TaskClearScope::All).await.unwrap(), 1);
        assert!(s.get_cache_task(ran.id).await.unwrap().is_none());
        assert!(s.list_cache_tasks(50).await.unwrap().is_empty());
    }

    /// 三档范围必须互斥且穷尽——否则任何新需求都会变成「再加一档」。
    #[test]
    fn clear_scope_partitions_all_statuses() {
        let all = ["queued", "running", "done", "failed", "cancelled", "interrupted"];
        let in_scope = |scope: TaskClearScope, s: &str| match scope {
            TaskClearScope::All => true,
            TaskClearScope::Success => s == "done",
            TaskClearScope::Failed => matches!(s, "failed" | "cancelled" | "interrupted"),
        };
        for s in all {
            assert!(in_scope(TaskClearScope::All, s), "{s} 必须落在 all 档");
            let hits = [TaskClearScope::Success, TaskClearScope::Failed]
                .iter()
                .filter(|sc| in_scope(**sc, s))
                .count();
            assert!(hits <= 1, "{s} 不能同时属于两档（互斥）");
        }
        let mut total = 0u64;
        for s in all {
            if s == "done" {
                total += 1
            } else if ["failed", "cancelled", "interrupted"].contains(&s) {
                total += 1
            }
        }
        // 6 个状态中，终态 4 个（done + failed/cancelled/interrupted），由 success/failed 两档覆盖；
        // 活跃 2 个（queued/running）只有 all 档会动 —— 这就是「还有第 4 档吗」的答案。
        assert_eq!(total, 4, "success ∪ failed 覆盖全部终态");
        assert_eq!(TaskClearScope::parse("nonsense"), None, "未知范围必须报错，不能当全部");
        assert_eq!(TaskClearScope::parse("all"), Some(TaskClearScope::All));
        assert_eq!(TaskClearScope::parse("success"), Some(TaskClearScope::Success));
        assert_eq!(TaskClearScope::parse("failed"), Some(TaskClearScope::Failed));
    }

    /// BUG-100 检测面：同一 `file_path` 被多行占用时必须被报出来（**只报不修**）。
    ///
    /// 这正是「两个频道各发一个 `video_2024.mp4`」的存量形态：清掉一条会打掉另一条的字节，
    /// 而另一条的状态字段不会复位。两张表都要能查到。
    #[tokio::test]
    async fn duplicate_file_paths_reports_shared_paths_in_both_tables() {
        let s = store("dup_paths").await;

        // 各不相同的路径：不得误报。
        s.upsert_message(11, 1, Some("a"), Some("video/mp4"), Some(1), Some("video"), Some(1), None, None, None)
            .await
            .unwrap();
        s.mark_downloaded(11, 1, Some(r#"C:\cache\unique-a.mp4"#)).await.unwrap();
        assert!(
            s.duplicate_file_paths(20).await.unwrap().is_empty(),
            "唯一路径不得报撞名"
        );

        // 两个**不同频道**落到同一路径 = BUG-100 的存量撞名。
        s.upsert_message(11, 2, Some("b"), Some("video/mp4"), Some(1), Some("video"), Some(2), None, None, None)
            .await
            .unwrap();
        s.upsert_message(22, 3, Some("c"), Some("video/mp4"), Some(1), Some("video"), Some(3), None, None, None)
            .await
            .unwrap();
        s.mark_downloaded(11, 2, Some(r#"C:\cache\video_2024.mp4"#)).await.unwrap();
        s.mark_downloaded(22, 3, Some(r#"C:\cache\video_2024.mp4"#)).await.unwrap();

        // media_item 侧同样撞名（决定「条目能不能播」）。
        s.upsert_media_item("tg", "11:2", "b", "video", Some(r#"C:\cache\video_2024.mp4"#), None, None, None)
            .await
            .unwrap();
        s.upsert_media_item("tg", "22:3", "c", "video", Some(r#"C:\cache\video_2024.mp4"#), None, None, None)
            .await
            .unwrap();

        let dups = s.duplicate_file_paths(20).await.unwrap();
        let shared: Vec<&FilePathCollision> = dups
            .iter()
            .filter(|d| d.path == r#"C:\cache\video_2024.mp4"#)
            .collect();
        // 两张表各一条（同一路径在两表分别成组，不是合并计数）。
        assert_eq!(shared.len(), 2, "media_item 与 media_message 都要报: {dups:?}");
        assert!(shared.iter().all(|d| d.count == 2), "每组应为 2 行共享: {shared:?}");
        let tables: Vec<&str> = shared.iter().map(|d| d.table.as_str()).collect();
        assert!(tables.contains(&"media_item"));
        assert!(tables.contains(&"media_message"));
        // 唯一路径仍未被误报。
        assert!(!dups.iter().any(|d| d.path.contains("unique-a")));
    }

    /// 回归（BUG-189 第三处）：`enqueue_cache_task` 的「插入」与「取 id」必须在**同一条 SQL**
    /// 内完成。旧写法「先 INSERT、再单独 `SELECT last_insert_rowid()`」在共享单连接下，两句之间
    /// 的 `.await` 让出点会让并发请求交错，`last_insert_rowid()` 返回**他人的 rowid**，于是
    /// `get_cache_task(别人的 id)` 读到别人的行 —— 返回行的 `item_key` 与请求 key 不符。
    ///
    /// 本测试调用**真实** `enqueue_cache_task`（不绕过生产链）：16 路并发、各用不同 key，断言
    /// 「id 两两唯一」「返回行 item_key == 请求 key」「库中恰好 16 行」。旧代码下第 2 条断言会失败
    /// （这正是「拿到别人 id」的可观测证据）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn enqueue_cache_task_concurrent_ids_are_isolated() {
        const N: usize = 16;
        let s = std::sync::Arc::new(store("enqueue_race").await);
        // 所有任务在 barrier 对齐后**同时**发起，最大化「INSERT 与取 id 之间」的交错概率。
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(N));

        let mut handles = Vec::with_capacity(N);
        for i in 0..N {
            let s = std::sync::Arc::clone(&s);
            let barrier = std::sync::Arc::clone(&barrier);
            handles.push(tokio::spawn(async move {
                let key = format!("race:{i}");
                barrier.wait().await;
                let (t, created) = s
                    .enqueue_cache_task(1, None, &key, &[i as i64 + 1], "D:/dl")
                    .await
                    .unwrap()
                    .expect("并发入队不得返回 None");
                (key, t, created)
            }));
        }

        let mut results = Vec::with_capacity(N);
        for h in handles {
            results.push(h.await.unwrap());
        }

        // 1) 16 次新建必须拿到 16 个两两不同的 id。
        let mut ids: Vec<i64> = results.iter().map(|(_, t, _)| t.id).collect();
        ids.sort_unstable();
        let mut uniq = ids.clone();
        uniq.dedup();
        assert_eq!(uniq.len(), N, "16 次新建必须拿到 16 个不同 id，实际: {ids:?}");

        // 2) 每次返回行的 item_key 必须等于自己请求的 key —— 这才是真正抓住「拿到别人 id」的断言
        //    （旧代码下 get_cache_task(别人的 id) 会返回别人的行，key 就对不上）。
        for (key, t, _) in &results {
            assert_eq!(
                &t.item_key, key,
                "返回行 item_key 与请求 key 不符（拿到他人 id 的信号）: 请求 {key}, 实得 {}",
                t.item_key
            );
        }

        // 3) 库中恰好 16 行。
        assert_eq!(
            s.list_cache_tasks(100).await.unwrap().len(),
            N,
            "并发 16 个不同 key 应恰好落 16 行"
        );
    }

    /// BUG-220 数据错乱：同一批消息经**三种 key 形态**（`g:`/`m:`/`b:`）入队时，
    /// 必须复用同一个任务，而不是建出三个重复任务。旧实现只比 item_key 字符串，
    /// 三者互不相等 ⇒ 实测同一 8 条消息同时存在三个任务（队列重复、标题互相干扰）。
    #[tokio::test]
    async fn enqueue_dedupes_across_key_shapes_by_message_overlap_bug220() {
        let s = store("bug220dedup").await;
        let msgs = vec![3373_i64, 3374, 3375];
        // 1) 相册路径 `g:` 建任务。
        let (t1, created1) = s
            .enqueue_cache_task(-100, Some(555), "g:-100:555", &msgs, "D:/dl")
            .await
            .unwrap()
            .expect("g enqueue");
        assert!(created1, "首个应新建");
        // 2) 批量补缺路径 `b:` 传**同一批消息** ⇒ 必须复用，不得新建。
        let (t2, created2) = s
            .enqueue_cache_task(-100, None, "b:-100:3373", &msgs, "D:/dl")
            .await
            .unwrap()
            .expect("b enqueue");
        assert!(!created2, "b: 与 g: 覆盖同一批消息，必须复用");
        assert_eq!(t1.id, t2.id, "应指向同一个任务");
        // 3) 单条路径 `m:` 只带首条消息（重叠）⇒ 同样复用。
        let (t3, created3) = s
            .enqueue_cache_task(-100, None, "m:-100:3373", &[3373], "D:/dl")
            .await
            .unwrap()
            .expect("m enqueue");
        assert!(!created3, "m: 与 g: 消息重叠，必须复用");
        assert_eq!(t1.id, t3.id);
        // 库里该 chat 只应有 1 个活跃任务。
        assert_eq!(
            s.list_cache_tasks(50)
                .await
                .unwrap()
                .iter()
                .filter(|t| t.chat_id == -100 && t.status == "queued")
                .count(),
            1,
            "同一批消息只允许存在一个活跃任务"
        );
        // 4) 不重叠的消息 ⇒ 正常新建（去重不能误伤）。
        let (t4, created4) = s
            .enqueue_cache_task(-100, None, "m:-100:9999", &[9999], "D:/dl")
            .await
            .unwrap()
            .expect("unrelated enqueue");
        assert!(created4, "不重叠的消息必须能正常新建");
        assert_ne!(t1.id, t4.id);
    }

    /// BUG-279：按条目查任务态——单条（m:）精确匹配、组任务（g:）按 items JSON 包含，
    /// 两路取 id 最大者；开放到全部状态（含终态 failed/cancelled/done）。
    #[tokio::test]
    async fn cache_task_for_item_resolves_single_group_and_terminal_bug279() {
        let s = store("bug279").await;
        // 单条任务 m:7:21（chat 7, msg 21）。
        let (single, _) = s
            .enqueue_cache_task(7, None, "m:7:21", &[21], "D:/dl")
            .await
            .unwrap()
            .expect("single enqueue");
        // 组任务 g:7:900 覆盖 [11,12,13]。
        let (group, _) = s
            .enqueue_cache_task(7, Some(900), "g:7:900", &[11, 12,13], "D:/dl")
            .await
            .unwrap()
            .expect("group enqueue");

        // 单条精确匹配。
        let found = s.cache_task_for_item(7, 21).await.unwrap().expect("single");
        assert_eq!(found.id, single.id);

        // 组任务：msg 12 在 items 数组里 ⇒ 命中组任务。
        let found = s.cache_task_for_item(7, 12).await.unwrap().expect("group");
        assert_eq!(found.id, group.id);

        // 不存在的 msg ⇒ None（no-task）。
        assert!(s.cache_task_for_item(7, 999).await.unwrap().is_none());

        // 终态也开放：把组任务标 failed + 原因，仍能被查到（失败态展示用）。
        s.conn
            .execute(
                "UPDATE cache_task SET status='failed', error='boom' WHERE id=?",
                params![group.id],
            )
            .await
            .unwrap();
        let found = s
            .cache_task_for_item(7, 12)
            .await
            .unwrap()
            .expect("group failed");
        assert_eq!(found.status, "failed");
        assert_eq!(found.error.as_deref(), Some("boom"));

        // 重新尝试（同 key 更高 id 的新行）⇒ 取 max id（最近一次尝试）。
        let (group2, _) = s
            .enqueue_cache_task(7, Some(900), "g:7:900", &[12], "D:/dl")
            .await
            .unwrap()
            .expect("group re-enqueue");
        assert!(group2.id > group.id, "重试必须新建更高 id 的行");
        let found = s
            .cache_task_for_item(7, 12)
            .await
            .unwrap()
            .expect("group2");
        assert_eq!(found.id, group2.id, "必须取 id 更大（最近一次尝试）");
    }

    /// BUG-278：真实数据目录（store.db 父目录 = 程序数据：库文件/会话/凭据）
    /// 与派生的 proxy_dir（媒体字节）严格区分。
    /// BUG-323：代理落点已迁入**下载路径之内**（`<下载路径>/.orighub/proxies`）。
    /// BUG-388：`add_channel` 不建 `sync_cursor` 行，而 list_channels 的标量子
    /// 查询在**零匹配行**时返回 NULL（内层 COALESCE 包不住空集）——刚添加、还没
    /// 跑过同步的频道会让整个监控列表接口报 Null value。修复 = COALESCE 外移到
    /// 子查询整体之外，空集显式落 0。本测试钉住：无 cursor 行的频道必须能列出，
    /// 且三个游标字段为 0 而非 Err。
    #[tokio::test]
    async fn monitored_channel_list_without_cursor_row_bug388() {
        let s = store("bug388cursor").await;
        s.add_channel(-1003969766003, "黄果短剧|AICR短剧", None).await.unwrap();
        // 此刻 sync_cursor 没有该频道的行 —— 旧实现（COALESCE 在子查询内）
        // 在这里返回 Err(InvalidColumnType::Null)，列表整体不可用。
        let rows = s.list_channels().await.unwrap();
        assert_eq!(rows.len(), 1, "无 cursor 行的频道必须仍可列出");
        let ch = &rows[0];
        assert_eq!(ch.channel_id, -1003969766003);
        assert_eq!(ch.backfill_until, 0, "空集必须落 0（backfillUntil）");
        assert_eq!(ch.backfill_before_id, 0, "空集必须落 0（backfillBeforeId）");
        assert_eq!(ch.last_message_id, 0, "空集必须落 0（lastMessageId）");
        // row_opt 单频道路径同一断言（同一 SQL，两处都要活）。
        let one = s.get_channel(-1003969766003).await.unwrap().expect("row must exist");
        assert_eq!(one.last_message_id, 0);
        assert_eq!(one.backfill_before_id, 0);
    }

    #[tokio::test]
    async fn data_dir_is_library_root_not_proxy_dir_bug278() {
        let dir = std::env::temp_dir().join(format!("orig_tg_datadir_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = Store::open(dir.join("store.db")).await.unwrap();
        assert_eq!(s.data_dir(), dir);
        let proxy = s.proxy_dir().await;
        assert_eq!(
            proxy,
            s.download_root()
                .await
                .join(Store::ENGINE_SUBDIR)
                .join("proxies")
        );
        assert_ne!(s.data_dir(), proxy);
        assert!(
            proxy.starts_with(s.download_root().await),
            "BUG-323：代理目录必须在下载路径之内"
        );
    }

    /// BUG-220 + BUG-280：标题映射把 caption 与 file_name **分开**带回，
    /// 选取规则（caption 优先、无 caption 回退 file_name）由调用方两遍完成。
    ///
    /// 实测大量视频消息在 TG 上没有说明文案、只有文件名（`妻善3.mp4`）；此前标题链
    /// 只认 caption ⇒ 这类任务标题恒空 ⇒ 前端退回频道名（用户看到「又是频道名不是
    /// 内容」）。本测试钉住映射侧三态：caption 与 file_name 各自可读 / 无 caption 时
    /// file_name 仍在（供调用方兜底）/ 两者皆无不进标题表。
    #[tokio::test]
    async fn message_title_sources_are_split_caption_and_file_name_bug280() {
        let s = store("bug280title").await;
        s.upsert_message(7, 1, Some("有文案的标题"), Some("video/mp4"), Some(1), Some("video"), Some(1), None, None, Some("ignored.mp4")).await.unwrap();
        s.upsert_message(7, 2, None, Some("video/mp4"), Some(1), Some("video"), Some(1), None, None, Some("妻善3.mp4")).await.unwrap();
        s.upsert_message(7, 3, None, Some("video/mp4"), Some(1), Some("video"), Some(1), None, None, None).await.unwrap();
        let m = s.message_captions_for_channels(&[7]).await.unwrap();
        let s1 = m.get(&(7, 1)).expect("msg 1 must be in the map");
        assert_eq!(
            s1.caption, "有文案的标题",
            "有 caption 时必须用 caption，不能被文件名盖掉"
        );
        assert_eq!(
            s1.file_name, "ignored.mp4",
            "BUG-280：两个来源分开带回，排序交给调用方（此前被 COALESCE 吞掉）"
        );
        let s2 = m.get(&(7, 2)).expect("msg 2 must be in the map");
        assert_eq!(s2.caption, "", "无 caption ⇒ caption 为空串");
        assert_eq!(
            s2.file_name, "妻善3.mp4",
            "无 caption 时必须回退 file_name（这才是「显示内容」而非频道名）"
        );
        assert!(!m.contains_key(&(7, 3)), "既无 caption 也无 file_name 的消息不进标题表");
    }

    /// BUG-280：多行 caption 只取**首行**——队列行直接渲染这段文本，
    /// 整段原文（232 字符）顶在标题上不可读（实测任务 163）。
    #[tokio::test]
    async fn message_title_sources_take_first_line_only_bug280() {
        let s = store("bug280firstline").await;
        s.upsert_message(
            7,
            1,
            Some("首行标题\n第二行正文\n第三行标签 #短剧"),
            Some("video/mp4"),
            Some(1),
            Some("video"),
            Some(1),
            None,
            None,
            Some("ignored.mp4"),
        )
        .await
        .unwrap();
        let m = s.message_captions_for_channels(&[7]).await.unwrap();
        assert_eq!(
            m.get(&(7, 1)).map(|s| s.caption.as_str()),
            Some("首行标题"),
            "caption 多行时只取首行（队列标题是单行文本）"
        );
    }
}
