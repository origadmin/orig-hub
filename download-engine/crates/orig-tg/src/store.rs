//! SQLite 存储层：监控频道、入库媒体消息、增量同步游标。
//!
//! 本地单文件 SQLite（libsql 本地后端），供 `monitor` 后台任务增量拉取频道媒体入库、
//! `/api/tg/monitor` 路由查询，以及「下载/播放」定位已入库媒体。
//!
//! 采用与 grammers-session 相同的 libsql 本地后端（`core` feature），避免与 bundled
//! sqlite3 的 LNK2005 多重定义链接冲突。`libsql::Connection` 内部为 `Arc<dyn Conn + Send + Sync>`，
//! 是 `Clone + Send + Sync`，因此 `Store` 可直接经 `AppState` 的 `Arc` 多线程共享，无需额外锁。

use std::path::Path;
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

/// libsql 本地 SQLite 存储。
pub struct Store {
    /// `pub(crate)` 供 `media` 模块复用同一连接（资料库与 TG 流水同库）。
    pub(crate) conn: Connection,
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
}

/// 任务是否处于「活跃」态（活跃态由 `cache_task_active_uniq` 保证同 key 唯一）。
pub const CACHE_TASK_ACTIVE_STATES: &str = "('queued', 'running')";

/// 按 `list_cache_tasks`/`get_cache_task` 的 SELECT 列顺序映射一行。
/// 列顺序：id, chat_id, group_id, item_key, items, total, done, status,
///         current_id, error, created_at, updated_at
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
    })
}

/// `cache_task` 的 SELECT 列清单（与 `cache_task_from_row` 严格同序）。
const CACHE_TASK_COLS: &str = "id, chat_id, group_id, item_key, items, total, done, \
                               status, current_id, error, created_at, updated_at";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
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
    Ok(())
}

/// 按 `list_messages`/`get_message` 的 SELECT 列顺序映射一行。
/// 列顺序：channel_id, message_id, caption, mime_type, size, downloaded, created_at,
///         media_type, msg_date, duration, file_path, group_id
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

impl Store {
    /// 打开（不存在则创建）数据库并建表。`path` 传 `":memory:"` 使用纯内存库。
    pub async fn open(path: impl AsRef<Path>) -> libsql::Result<Self> {
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
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS cache_task_active_uniq
                ON cache_task(item_key) WHERE status IN ('queued', 'running');
            "#,
        )
        .await?;
        // 旧库（v0.3.x）的 media_message 缺 media_type/msg_date：幂等补列，不删数据。
        migrate_media_message(&conn).await?;
        // 媒体资料库（内容/剧集/标签）：与 TG 流水同库、职责分离。
        crate::media::migrate(&conn).await?;
        Ok(Self { conn })
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
    ) -> libsql::Result<()> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO media_message
                   (channel_id, message_id, caption, mime_type, size, downloaded, created_at, media_type, msg_date, duration, group_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(channel_id, message_id) DO UPDATE SET
                   caption = excluded.caption,
                   mime_type = excluded.mime_type,
                   size = excluded.size,
                   media_type = COALESCE(excluded.media_type, media_message.media_type),
                   msg_date = COALESCE(excluded.msg_date, media_message.msg_date),
                   duration = COALESCE(excluded.duration, media_message.duration),
                   group_id = COALESCE(excluded.group_id, media_message.group_id)",
                params![channel_id, message_id, caption, mime_type, size, t, media_type, msg_date, duration, group_id],
            )
            .await?;
        Ok(())
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

    // ---- 缓存任务（服务端任务态：刷新/切页/关浏览器都不再丢） ----

    /// 入队一个缓存任务；同 key 已有活跃任务时**复用既有任务**（幂等，不重复下载）。
    ///
    /// 返回 `(任务, 是否本次新建)`：只有新建时才允许起 worker，复用时 worker 已在跑。
    /// 返回 `None` 仅出现在极端并发下（撞唯一索引后既读不到活跃行），调用方按内部错误处理。
    pub async fn enqueue_cache_task(
        &self,
        chat_id: i64,
        group_id: Option<i64>,
        item_key: &str,
        message_ids: &[i64],
        dir: &str,
    ) -> libsql::Result<Option<(CacheTask, bool)>> {
        // 先读活跃任务：命中即复用（正常路径，避免无谓的写入冲突）。
        if let Some(t) = self.active_cache_task(item_key).await? {
            return Ok(Some((t, false)));
        }
        let items = serde_json::to_string(message_ids).unwrap_or_else(|_| "[]".to_string());
        let ts = now();
        // `cache_task_active_uniq`（partial unique）兜底并发：撞索引说明别人已插成功，回读即可。
        let inserted = self
            .conn
            .execute(
                "INSERT INTO cache_task \
                   (chat_id, group_id, item_key, items, total, done, status, dir, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 'queued', ?6, ?7, ?7)",
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
            Ok(_) => {
                let id = self.conn.last_insert_rowid();
                Ok(self.get_cache_task(id).await?.map(|t| (t, true)))
            }
            Err(_) => Ok(self.active_cache_task(item_key).await?.map(|t| (t, false))),
        }
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
    pub async fn list_cache_tasks(&self, limit: u32) -> libsql::Result<Vec<CacheTask>> {
        let mut rows = self
            .conn
            .query(
                &format!(
                    "SELECT {CACHE_TASK_COLS} FROM cache_task \
                     ORDER BY CASE WHEN status IN {CACHE_TASK_ACTIVE_STATES} THEN 0 ELSE 1 END, id DESC \
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

    /// 清除终态任务记录（缓存管理面板「清除记录」）。
    /// 活跃任务（queued/running）绝不清除。返回删除行数。
    pub async fn clear_finished_cache_tasks(&self) -> libsql::Result<u64> {
        let n = self
            .conn
            .execute(
                &format!(
                    "DELETE FROM cache_task WHERE status NOT IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                (),
            )
            .await?;
        Ok(n)
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

    /// 更新进度（已完成条数 + 正在处理的条目）。
    pub async fn update_cache_task_progress(
        &self,
        id: i64,
        done: i64,
        current_id: Option<i64>,
    ) -> libsql::Result<()> {
        self.conn
            .execute(
                "UPDATE cache_task SET done = ?2, current_id = ?3, updated_at = ?4 WHERE id = ?1",
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

    /// 最老的排队任务（worker 跑完当前任务后按 FIFO 接续）。
    pub async fn next_queued_task(&self) -> libsql::Result<Option<CacheTask>> {
        self.row_opt(
            &format!(
                "SELECT {CACHE_TASK_COLS} FROM cache_task \
                 WHERE status = 'queued' ORDER BY id ASC LIMIT 1"
            ),
            (),
        )
        .await?
        .map(|r| cache_task_from_row(&r))
        .transpose()
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

    /// 启动时清理僵尸任务：进程被杀/崩溃时残留的 queued/running 永远等不到 worker，
    /// 必须显式降级为 `interrupted`，否则前端会显示一个永不推进的「缓存中」（假状态）。
    /// 返回被标记的条数。
    pub async fn mark_stale_cache_tasks(&self) -> libsql::Result<usize> {
        let n = self
            .conn
            .execute(
                &format!(
                    "UPDATE cache_task SET status = 'interrupted', current_id = NULL, updated_at = ?1 \
                     WHERE status IN {CACHE_TASK_ACTIVE_STATES}"
                ),
                params![now()],
            )
            .await?;
        Ok(n as usize)
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
    pub async fn upsert_dialog(&self, ch: &Channel) -> libsql::Result<()> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO dialog_cache (id, title, username, folder, init_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE
                   SET title = excluded.title, username = excluded.username, folder = excluded.folder",
                params![ch.id, ch.title.clone(), ch.username.as_deref(), ch.folder.as_deref(), t],
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
        s.upsert_message(1, 100, Some("hello"), Some("video/mp4"), Some(1234), Some("video"), Some(1000), Some(95), Some(777))
            .await
            .unwrap();
        // 幂等 upsert：更新 caption，不新增行。
        s.upsert_message(1, 100, Some("dup"), Some("video/mp4"), Some(1234), Some("video"), Some(1000), None, None)
            .await
            .unwrap();
        s.upsert_message(1, 101, None, Some("image/jpeg"), None, Some("photo"), Some(1001), None, None)
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

    #[tokio::test]
    async fn stored_library_query() {
        let s = store("stored_lib").await;
        s.add_channel(1, "Movies", None).await.unwrap();
        s.upsert_message(1, 10, Some("ep1"), Some("video/mp4"), Some(100), Some("video"), Some(900), Some(60), None)
            .await
            .unwrap();
        s.upsert_message(1, 11, Some("ep2"), Some("video/mp4"), Some(200), Some("video"), Some(901), Some(120), None)
            .await
            .unwrap();
        s.upsert_message(2, 20, Some("song"), Some("audio/mpeg"), Some(30), Some("audio"), Some(902), Some(180), None)
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
}
