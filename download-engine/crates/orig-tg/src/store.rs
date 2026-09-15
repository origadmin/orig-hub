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
}

/// libsql 本地 SQLite 存储。
pub struct Store {
    conn: Connection,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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
                PRIMARY KEY (channel_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS sync_cursor (
                channel_id      INTEGER PRIMARY KEY,
                last_message_id INTEGER NOT NULL DEFAULT 0,
                updated_at      INTEGER NOT NULL
            );
            "#,
        )
        .await?;
        Ok(Self { conn })
    }

    /// 查询首个结果行；无结果返回 `None`。
    async fn row_opt(&self, sql: &str, p: impl IntoParams) -> libsql::Result<Option<Row>> {
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
    pub async fn upsert_message(
        &self,
        channel_id: i64,
        message_id: i64,
        caption: Option<&str>,
        mime_type: Option<&str>,
        size: Option<i64>,
    ) -> libsql::Result<()> {
        let t = now();
        self.conn
            .execute(
                "INSERT INTO media_message (channel_id, message_id, caption, mime_type, size, downloaded, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
                 ON CONFLICT(channel_id, message_id) DO NOTHING",
                params![channel_id, message_id, caption, mime_type, size, t],
            )
            .await?;
        Ok(())
    }

    /// 列出某频道已入库消息（新→旧）。
    pub async fn list_messages(
        &self,
        channel_id: i64,
        limit: u32,
    ) -> libsql::Result<Vec<StoredMessage>> {
        let stmt = self
            .conn
            .prepare(
                "SELECT channel_id, message_id, caption, mime_type, size, downloaded, created_at
                 FROM media_message WHERE channel_id = ?1
                 ORDER BY message_id DESC LIMIT ?2",
            )
            .await?;
        let mut rows = stmt.query(params![channel_id, limit.max(1) as i64]).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(StoredMessage {
                channel_id: r.get(0)?,
                message_id: r.get(1)?,
                caption: r.get(2)?,
                mime_type: r.get(3)?,
                size: r.get(4)?,
                downloaded: r.get::<i64>(5)? != 0,
                created_at: r.get(6)?,
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
                "SELECT channel_id, message_id, caption, mime_type, size, downloaded, created_at
                 FROM media_message WHERE channel_id = ?1 AND message_id = ?2",
                params![channel_id, message_id],
            )
            .await?;
        match row {
            Some(r) => Ok(Some(StoredMessage {
                channel_id: r.get(0)?,
                message_id: r.get(1)?,
                caption: r.get(2)?,
                mime_type: r.get(3)?,
                size: r.get(4)?,
                downloaded: r.get::<i64>(5)? != 0,
                created_at: r.get(6)?,
            })),
            None => Ok(None),
        }
    }

    /// 标记某条消息已下载。
    pub async fn mark_downloaded(&self, channel_id: i64, message_id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "UPDATE media_message SET downloaded = 1 WHERE channel_id = ?1 AND message_id = ?2",
                params![channel_id, message_id],
            )
            .await?;
        Ok(())
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
        s.upsert_message(1, 100, Some("hello"), Some("video/mp4"), Some(1234)).await.unwrap();
        s.upsert_message(1, 100, Some("dup"), Some("video/mp4"), Some(1234)).await.unwrap();
        s.upsert_message(1, 101, None, Some("image/jpeg"), None).await.unwrap();
        let msgs = s.list_messages(1, 10).await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].message_id, 101); // 新→旧
        s.mark_downloaded(1, 100).await.unwrap();
        assert!(s.get_message(1, 100).await.unwrap().unwrap().downloaded);
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
}
