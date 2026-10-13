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
use serde::Serialize;

use crate::login::Channel;

/// 监控中的频道（`monitored_channel` 行）。
#[derive(Debug, Clone, Serialize)]
pub struct MonitoredChannel {
    #[serde(rename = "channelId")]
    pub channel_id: i64,
    pub title: String,
    pub username: Option<String>,
    #[serde(rename = "addedAt")]
    pub added_at: i64,
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
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
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

/// BUG-194 迁移：把 `dialog_cache` 里**存量**的空/纯空白标题行补成可辨识兜底名。
///
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
                added_at   INTEGER NOT NULL
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
                updated_at      INTEGER NOT NULL
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
        // 旧库的 cache_task 缺 priority：幂等补列，不删数据（BUG-277）。
        migrate_cache_task_priority(&conn).await?;
        // BUG-194：存量 dialog_cache 里的空标题行回填为可辨识兜底名（幂等）。
        let healed = migrate_dialog_cache_blank_titles(&conn).await?;
        if healed > 0 {
            eprintln!("[store] BUG-194: backfilled {healed} blank dialog_cache titles");
        }
        // 媒体资料库（内容/剧集/标签）：与 TG 流水同库、职责分离。
        crate::media::migrate(&conn).await?;
        Ok(Self { conn, db_path })
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
    pub async fn add_channel(
        &self,
        channel_id: i64,
        title: &str,
        username: Option<&str>,
    ) -> libsql::Result<()> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO monitored_channel (channel_id, title, username, added_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(channel_id) DO UPDATE
                   SET title = excluded.title, username = excluded.username",
                params![channel_id, title, username, t],
            )
            .await?;
        Ok(())
    }

    /// 列出全部监控频道（按添加时间正序）。
    pub async fn list_channels(&self) -> libsql::Result<Vec<MonitoredChannel>> {
        let stmt = self
            .conn
            .prepare(
                "SELECT channel_id, title, username, added_at FROM monitored_channel ORDER BY added_at",
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
            });
        }
        Ok(out)
    }

    /// 取单个监控频道。
    pub async fn get_channel(&self, channel_id: i64) -> libsql::Result<Option<MonitoredChannel>> {
        let row = self
            .row_opt(
                "SELECT channel_id, title, username, added_at FROM monitored_channel WHERE channel_id = ?1",
                params![channel_id],
            )
            .await?;
        match row {
            Some(r) => Ok(Some(MonitoredChannel {
                channel_id: r.get(0)?,
                title: r.get(1)?,
                username: r.get(2)?,
                added_at: r.get(3)?,
            })),
            None => Ok(None),
        }
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

    // ---- 库根（byte-ownership P2：单一库根，一处管理） ----

    /// 库根解析链（byte-ownership I2）：
    ///   1. env `ORIG_TG_LIBRARY_DIR`（容器/CI/sidecar 注入，最高优先）；
    ///   2. app_setting `library_dir`（PUT /api/tg/config 持久化的运行期覆盖）；
    ///   3. config.json `libraryDir`（Tauri 壳管理的应用配置；引擎直接读
    ///      `<数据库文件父目录>/config.json`——生产布局里两者同在 TG 数据目录）；
    ///   4. 默认 `<TG 数据目录>/library`（与 downloads 同级，D7：库根默认与下载目录同级）。
    ///
    /// 前两级与 config.json 的值都过 `expand_tilde`（用户可能手输 `~`，BUG-071 同款）。
    pub async fn library_root(&self) -> PathBuf {
        if let Ok(v) = std::env::var("ORIG_TG_LIBRARY_DIR") {
            if !v.trim().is_empty() {
                return orig_core::paths::expand_tilde(v.trim());
            }
        }
        if let Ok(Some(v)) = self.get_setting("library_dir").await {
            if !v.trim().is_empty() {
                return orig_core::paths::expand_tilde(v.trim());
            }
        }
        if let Some(v) = Self::config_json_library_dir(&self.db_path) {
            return v;
        }
        Self::default_library_root(&self.db_path)
    }

    /// 默认库根：`<TG 数据目录>/library`。`:memory:`（单测）的父目录为空串，
    /// 退化为进程 CWD 下的 `library` —— 测试应显式 set_setting 覆盖。
    pub fn default_library_root(db_path: &Path) -> PathBuf {
        let base = db_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        base.join("library")
    }

    /// 转码代理目录：`<TG 数据目录>/proxies`。
    ///
    /// 与库根同级但**刻意不进库**（BUG-208）：代理是可再生的派生缓存（源件删了
    /// 随时能重转），媒体库是唯一内容仓，派生物混进去会破坏「1 份存档」的计数
    /// 与清理语义（清理链让位于 library bytes 的裁定也不应被代理字节干扰）。
    pub fn proxy_dir(&self) -> PathBuf {
        let base = self
            .db_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        base.join("proxies")
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

    /// 读 config.json 的 `libraryDir`（缺文件/缺键/解析失败 → None，不阻断）。
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn store(name: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("orig_tg_store_{}_{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Store::open(dir.join("store.db")).await.unwrap()
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

    /// P2 库根解析链：app_setting 覆盖 config.json，config.json 覆盖默认值；
    /// 默认值 = `<TG 数据目录>/library`（TG 数据目录 = 数据库文件的父目录）。
    /// env 档（`ORIG_TG_LIBRARY_DIR`）优先级最高但为进程级全局，测试无法并行
    /// 安全地注入，故不在此覆盖（生产读的是同一行代码路径）。
    #[tokio::test]
    async fn library_root_resolution_chain() {
        let dir = std::env::temp_dir()
            .join(format!("orig_tg_store_{}_", std::process::id()))
            .join("libroot_chain");
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("store.db");
        let s = Store::open(&db_path).await.unwrap();

        // 默认档：<db 父目录>/library。
        assert_eq!(
            s.library_root().await,
            Store::default_library_root(&db_path),
            "无 setting、无 config.json 时必须落到默认库根"
        );

        // config.json 档：写文件即可（每次调用现读，不需要重开库）。
        let cfg_dir = dir.join("lib-from-config");
        std::fs::write(
            dir.join("config.json"),
            format!(r#"{{ "libraryDir": "{}" }}"#, cfg_dir.to_string_lossy().replace('\\', "/")),
        )
        .unwrap();
        assert_eq!(
            s.library_root().await,
            cfg_dir,
            "config.json 的 libraryDir 必须覆盖默认值"
        );

        // app_setting 档：最高优先级（除 env 外）。
        let setting_dir = dir.join("lib-from-setting");
        s.set_setting("library_dir", setting_dir.to_string_lossy().as_ref())
            .await
            .unwrap();
        assert_eq!(
            s.library_root().await,
            setting_dir,
            "app_setting 必须覆盖 config.json 与默认值"
        );
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

    /// BUG-278：真实数据目录 = 库根（store.db 父目录），与派生的 proxy_dir 严格区分。
    #[tokio::test]
    async fn data_dir_is_library_root_not_proxy_dir_bug278() {
        let dir = std::env::temp_dir().join(format!("orig_tg_datadir_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = Store::open(dir.join("store.db")).await.unwrap();
        assert_eq!(s.data_dir(), dir);
        assert_eq!(s.proxy_dir(), dir.join("proxies"));
        assert_ne!(s.data_dir(), s.proxy_dir());
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
