//! 媒体资料库（Media Library）——用户可管理的**内容目录**层。
//!
//! 与 `media_message`（TG 同步下来的原始消息流水）职责分离：
//!   - `media_message`：流水账，随频道同步自动增删，用户不直接编辑。
//!   - 本模块：资料库，用户显式导入/整理的内容（本地文件 + TG 条目），
//!     支持 **剧集（series/episode）**、**标签（tag）**、**图片管理**。
//!
//! 表结构见 `migrate()`。所有写入均通过 `Store`（同一 SQLite 连接）完成。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use libsql::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::store::Store;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ────────────────────────────── DDL ──────────────────────────────

/// 建表（幂等）。与 TG 流水表同库，表名统一 `media_*` 前缀但语义独立。
pub async fn migrate(conn: &Connection) -> libsql::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS media_item (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            source    TEXT NOT NULL,
            ref       TEXT NOT NULL,
            title     TEXT NOT NULL,
            kind      TEXT NOT NULL,
            file_path TEXT,
            poster    TEXT,
            size      INTEGER,
            duration  INTEGER,
            width     INTEGER,
            height    INTEGER,
            added_at  INTEGER NOT NULL,
            UNIQUE(source, ref)
        );
        CREATE TABLE IF NOT EXISTS media_series (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            description TEXT,
            kind        TEXT NOT NULL DEFAULT 'series',
            poster      TEXT,
            year        INTEGER,
            source_key  TEXT,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_episode (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            series_id  INTEGER NOT NULL,
            item_id    INTEGER NOT NULL,
            season     INTEGER NOT NULL DEFAULT 1,
            episode_no INTEGER NOT NULL DEFAULT 1,
            title      TEXT,
            UNIQUE(series_id, season, episode_no)
        );
        CREATE TABLE IF NOT EXISTS media_tag (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            name  TEXT NOT NULL UNIQUE,
            color TEXT
        );
        CREATE TABLE IF NOT EXISTS media_item_tag (
            item_id INTEGER NOT NULL,
            tag_id  INTEGER NOT NULL,
            PRIMARY KEY (item_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS media_series_tag (
            series_id INTEGER NOT NULL,
            tag_id    INTEGER NOT NULL,
            PRIMARY KEY (series_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_media_item_kind ON media_item(kind);
        CREATE INDEX IF NOT EXISTS idx_media_episode_series ON media_episode(series_id);
        "#,
    )
    .await?;
    // 旧库兼容：media_episode 补 description 列（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，
    // 用 pragma_table_info 判断列是否存在，避免重复 ALTER 报错）。
    let probe = conn
        .prepare("SELECT 1 FROM pragma_table_info('media_episode') WHERE name = 'description'")
        .await?;
    let exists = probe.query(()).await?.next().await?.is_some();
    if !exists {
        conn.execute("ALTER TABLE media_episode ADD COLUMN description TEXT", ())
            .await?;
    }
    // 旧库兼容：media_series 补 source_key 列（TG 自动成剧的幂等来源键）。
    let probe = conn
        .prepare("SELECT 1 FROM pragma_table_info('media_series') WHERE name = 'source_key'")
        .await?;
    let exists = probe.query(()).await?.next().await?.is_some();
    if !exists {
        conn.execute("ALTER TABLE media_series ADD COLUMN source_key TEXT", ())
            .await?;
    }
    // 幂等来源键的唯一索引（BUG-031）：TG 自动成剧用 `tg:group:{chat}:{group_id}` 去重。
    // 独立列而非塞进 description —— description 是用户可见的介绍字段，
    // 内部标记写进去会在剧集详情页直接显示出来。
    //
    // 必须在 `ALTER TABLE ... ADD COLUMN source_key` **之后**执行：旧库的 media_series
    // 没有该列，若把这条语句留在上面的 `execute_batch` 里，整批会在「旧库 + 新代码」
    // 首次启动时因为 `no such column: source_key` 报错 —— 而 `Store::open` 失败会让
    // 调用方回落到空库，表现得像「用户数据全没了」。建表批里只允许出现新旧库都存在的列。
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_media_series_source_key
             ON media_series(source_key) WHERE source_key IS NOT NULL",
        (),
    )
    .await?;
    Ok(())
}

// ────────────────────────────── 视图类型 ──────────────────────────────

/// 标签引用（挂在内容或剧集上的轻量结构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

/// 标签 + 使用计数（标签云/侧栏用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagView {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub item_count: i64,
    pub series_count: i64,
}

/// 内容条目（资料库行）。`poster` 为前端生成的 data-uri 缩略图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: i64,
    pub source: String,
    #[serde(rename = "ref")]
    pub ref_key: String,
    pub title: String,
    pub kind: String,
    pub file_path: Option<String>,
    pub poster: Option<String>,
    pub size: Option<i64>,
    pub duration: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub added_at: i64,
    pub tags: Vec<TagRef>,
    pub series_id: Option<i64>,
    pub series_title: Option<String>,
}

/// 剧集列表项（含分集数，卡片墙用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesView {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub kind: String,
    /// 剧集封面：显式设置优先，否则取首集封面（`cover_item_id` 对应条目的 `poster`）。
    pub poster: Option<String>,
    /// 首集内容 id：封面缺失时前端可回退到该条目的原图（图片类无需生成缩略）。
    pub cover_item_id: Option<i64>,
    /// 首集内容类型：前端据此决定能否直接把该条目当图片用
    /// （video 不能塞进 `<img src>`，需先抽帧）。
    pub cover_kind: Option<String>,
    pub year: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub episode_count: i64,
    pub season_count: i64,
    pub tags: Vec<TagRef>,
}

/// 分集（剧集详情页用，内联条目摘要避免二次请求）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeView {
    pub id: i64,
    pub item_id: i64,
    pub season: i64,
    pub episode_no: i64,
    pub title: Option<String>,
    pub item_title: Option<String>,
    pub poster: Option<String>,
    pub duration: Option<i64>,
    pub kind: Option<String>,
    /// 单集介绍（问题3：每集介绍）。
    pub description: Option<String>,
}

/// 剧集详情 = 元数据 + 分集列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDetail {
    #[serde(flatten)]
    pub series: SeriesView,
    pub episodes: Vec<EpisodeView>,
}

/// 列表查询条件。
#[derive(Debug, Clone, Default)]
pub struct ItemQuery {
    /// 媒体类型过滤：video / photo / audio / file。
    pub kind: Option<String>,
    /// 标题关键词（LIKE 子串，已在外层做 % 包裹）。
    pub q: Option<String>,
    /// 标签 id 过滤。
    pub tag_id: Option<i64>,
    /// 仅返回属于该剧集的内容。
    pub series_id: Option<i64>,
    /// true = 仅返回**未归入任何剧集**的内容（散片）。
    pub unassigned: bool,
    /// 排序：recent（默认）/ title / duration / size。
    pub sort: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

// ────────────────────────────── 行映射 ──────────────────────────────

fn media_item_from_row(r: &Row) -> libsql::Result<MediaItem> {
    Ok(MediaItem {
        id: r.get(0)?,
        source: r.get(1)?,
        ref_key: r.get(2)?,
        title: r.get(3)?,
        kind: r.get(4)?,
        file_path: r.get(5)?,
        poster: r.get(6)?,
        size: r.get(7)?,
        duration: r.get(8)?,
        width: r.get(9)?,
        height: r.get(10)?,
        added_at: r.get(11)?,
        tags: Vec::new(),
        series_id: r.get(12)?,
        series_title: r.get(13)?,
    })
}

/// 内容行投影。
///
/// 归属用**标量子查询**而非 LEFT JOIN：一条内容可能被编入多个剧集
/// （例如同时属于「城市与科技」与某图集），JOIN 会让同一行在列表里出现多次，
/// 前端 `key=id` 冲突并出现重复卡片。子查询保证恒定一行一内容。
const ITEM_SELECT: &str = "
    SELECT i.id, i.source, i.ref, i.title, i.kind, i.file_path, i.poster,
           i.size, i.duration, i.width, i.height, i.added_at,
           (SELECT e.series_id FROM media_episode e WHERE e.item_id = i.id
             ORDER BY e.season, e.episode_no LIMIT 1) AS series_id,
           (SELECT s.title FROM media_episode e JOIN media_series s ON s.id = e.series_id
             WHERE e.item_id = i.id ORDER BY e.season, e.episode_no LIMIT 1) AS series_title
      FROM media_item i";

fn order_by(sort: Option<&str>) -> &'static str {
    match sort {
        Some("title") => "i.title COLLATE NOCASE ASC",
        Some("duration") => "COALESCE(i.duration, 0) DESC",
        Some("size") => "COALESCE(i.size, 0) DESC",
        Some("oldest") => "i.added_at ASC, i.id ASC",
        _ => "i.added_at DESC, i.id DESC",
    }
}

// ────────────────────────────── Store 扩展 ──────────────────────────────

impl Store {
    // ---- 内容（items） ----

    /// 列表查询。所有过滤条件可选；`unassigned` 与 `series_id` 互斥（后者优先）。
    pub async fn list_media_items(&self, q: &ItemQuery) -> libsql::Result<Vec<MediaItem>> {
        let limit = if q.limit == 0 { 60 } else { q.limit.min(500) };
        let unassigned = if q.unassigned && q.series_id.is_none() {
            Some(1i64)
        } else {
            None
        };
        let sql = format!(
            "{ITEM_SELECT}
             WHERE (?1 IS NULL OR i.kind = ?1)
               AND (?2 IS NULL OR i.title LIKE '%' || ?2 || '%')
               AND (?3 IS NULL OR i.id IN (SELECT item_id FROM media_item_tag WHERE tag_id = ?3))
               AND (?4 IS NULL OR i.id IN (SELECT item_id FROM media_episode WHERE series_id = ?4))
               AND (?5 IS NULL OR i.id NOT IN (SELECT item_id FROM media_episode))
             ORDER BY {}
             LIMIT ?6 OFFSET ?7",
            order_by(q.sort.as_deref())
        );
        let stmt = self.conn.prepare(&sql).await?;
        let mut rows = stmt
            .query(params![
                q.kind.clone(),
                q.q.clone(),
                q.tag_id,
                q.series_id,
                unassigned,
                limit,
                q.offset,
            ])
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(media_item_from_row(&r)?);
        }
        self.attach_item_tags(&mut out).await?;
        Ok(out)
    }

    /// 统计满足同样过滤条件的总数（分页用）。
    pub async fn count_media_items(&self, q: &ItemQuery) -> libsql::Result<i64> {
        let unassigned = if q.unassigned && q.series_id.is_none() {
            Some(1i64)
        } else {
            None
        };
        let stmt = self
            .conn
            .prepare(
                "SELECT COUNT(*) FROM media_item i
                  WHERE (?1 IS NULL OR i.kind = ?1)
                    AND (?2 IS NULL OR i.title LIKE '%' || ?2 || '%')
                    AND (?3 IS NULL OR i.id IN (SELECT item_id FROM media_item_tag WHERE tag_id = ?3))
                    AND (?4 IS NULL OR i.id IN (SELECT item_id FROM media_episode WHERE series_id = ?4))
                    AND (?5 IS NULL OR i.id NOT IN (SELECT item_id FROM media_episode))",
            )
            .await?;
        let mut rows = stmt
            .query(params![
                q.kind.clone(),
                q.q.clone(),
                q.tag_id,
                q.series_id,
                unassigned,
            ])
            .await?;
        match rows.next().await? {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 批量回填条目标签（一次 IN 查询，避免 N+1）。
    async fn attach_item_tags(&self, items: &mut [MediaItem]) -> libsql::Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = items.iter().map(|i| i.id.to_string()).collect();
        let sql = format!(
            "SELECT it.item_id, t.id, t.name, t.color
               FROM media_item_tag it JOIN media_tag t ON t.id = it.tag_id
              WHERE it.item_id IN ({})
              ORDER BY t.name",
            ids.join(",")
        );
        let stmt = self.conn.prepare(&sql).await?;
        let mut rows = stmt.query(()).await?;
        let mut map: std::collections::HashMap<i64, Vec<TagRef>> =
            std::collections::HashMap::new();
        while let Some(r) = rows.next().await? {
            let item_id: i64 = r.get(0)?;
            map.entry(item_id).or_default().push(TagRef {
                id: r.get(1)?,
                name: r.get(2)?,
                color: r.get(3)?,
            });
        }
        for it in items.iter_mut() {
            if let Some(tags) = map.remove(&it.id) {
                it.tags = tags;
            }
        }
        Ok(())
    }

    /// 取单条内容。
    pub async fn get_media_item(&self, id: i64) -> libsql::Result<Option<MediaItem>> {
        let row = self
            .row_opt(&format!("{ITEM_SELECT} WHERE i.id = ?1"), params![id])
            .await?;
        match row {
            Some(r) => {
                let mut it = media_item_from_row(&r)?;
                let mut v = vec![it];
                self.attach_item_tags(&mut v).await?;
                it = v.remove(0);
                Ok(Some(it))
            }
            None => Ok(None),
        }
    }

    /// 新增/更新内容（按 `source`+`ref` 幂等）。返回行 id。
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_media_item(
        &self,
        source: &str,
        ref_key: &str,
        title: &str,
        kind: &str,
        file_path: Option<&str>,
        size: Option<i64>,
        duration: Option<i64>,
    ) -> libsql::Result<i64> {
        let t = now_secs();
        self.conn
            .execute(
                "INSERT INTO media_item (source, ref, title, kind, file_path, size, duration, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(source, ref) DO UPDATE SET
                   title = COALESCE(NULLIF(excluded.title, ''), media_item.title),
                   kind = excluded.kind,
                   file_path = COALESCE(excluded.file_path, media_item.file_path),
                   size = COALESCE(excluded.size, media_item.size),
                   -- duration 回填（BUG-031）：首次入库元数据缺 duration 时，后续重新缓存
                   -- 必须能补上（此前 DO UPDATE 不含该列，缺了就永远是 NULL）。
                   duration = COALESCE(excluded.duration, media_item.duration)",
                params![source, ref_key, title, kind, file_path, size, duration, t],
            )
            .await?;
        let row = self
            .row_opt(
                "SELECT id FROM media_item WHERE source = ?1 AND ref = ?2",
                params![source.to_string(), ref_key.to_string()],
            )
            .await?;
        match row {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 按 (source, ref) 反查条目 id（已缓存跳过时也要能归入剧集）。
    pub async fn item_id_by_ref(
        &self,
        source: &str,
        ref_key: &str,
    ) -> libsql::Result<Option<i64>> {
        let row = self
            .row_opt(
                "SELECT id FROM media_item WHERE source = ?1 AND ref = ?2",
                params![source.to_string(), ref_key.to_string()],
            )
            .await?;
        match row {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    /// 局部更新：标题 / 封面 / 时长 / 尺寸（None = 不改）。
    pub async fn update_media_item(&self, id: i64, patch: &ItemPatch) -> libsql::Result<bool> {
        let Some(existing) = self.get_media_item(id).await? else {
            return Ok(false);
        };
        let title = patch.title.clone().unwrap_or(existing.title);
        let poster = match patch.poster.clone() {
            Some(v) => v, // 显式 null（清空）或新值
            None => existing.poster,
        };
        let duration = patch.duration.or(existing.duration);
        let width = patch.width.or(existing.width);
        let height = patch.height.or(existing.height);
        let kind = patch.kind.clone().unwrap_or(existing.kind);
        self.conn
            .execute(
                "UPDATE media_item SET title = ?1, poster = ?2, duration = ?3,
                        width = ?4, height = ?5, kind = ?6 WHERE id = ?7",
                params![title, poster, duration, width, height, kind, id],
            )
            .await?;
        Ok(true)
    }

    /// 删除内容（同时清理标签关联与分集引用）。
    pub async fn delete_media_item(&self, id: i64) -> libsql::Result<()> {
        // 记下该条目所属剧集，删完清理空壳（BUG-031：此前只删分集行，
        // 剧集墙会留下一张 0 集的空卡片，点进去是「还没有分集」）
        let series_ids = self.series_ids_of_item(id).await?;
        self.conn
            .execute("DELETE FROM media_item_tag WHERE item_id = ?1", params![id])
            .await?;
        self.conn
            .execute("DELETE FROM media_episode WHERE item_id = ?1", params![id])
            .await?;
        self.conn
            .execute("DELETE FROM media_item WHERE id = ?1", params![id])
            .await?;
        for sid in series_ids {
            self.prune_empty_series(sid).await?;
        }
        Ok(())
    }

    /// 该条目归属的剧集 id 列表。
    pub async fn series_ids_of_item(&self, item_id: i64) -> libsql::Result<Vec<i64>> {
        let stmt = self
            .conn
            .prepare("SELECT DISTINCT series_id FROM media_episode WHERE item_id = ?1")
            .await?;
        let mut rows = stmt.query(params![item_id]).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(r.get(0)?);
        }
        Ok(out)
    }

    /// 剧集已无分集时删除该剧集（避免空壳残留）。
    pub async fn prune_empty_series(&self, series_id: i64) -> libsql::Result<bool> {
        let stmt = self
            .conn
            .prepare("SELECT COUNT(*) FROM media_episode WHERE series_id = ?1")
            .await?;
        let mut rows = stmt.query(params![series_id]).await?;
        let n: i64 = match rows.next().await? {
            Some(r) => r.get(0)?,
            None => 0,
        };
        if n > 0 {
            return Ok(false);
        }
        self.conn
            .execute("DELETE FROM media_series_tag WHERE series_id = ?1", params![series_id])
            .await?;
        self.conn
            .execute("DELETE FROM media_series WHERE id = ?1", params![series_id])
            .await?;
        Ok(true)
    }

    /// 按 `(source, ref)` 删除条目（级联清标签/剧集归属）。
    ///
    /// 用于 TG 缓存清除时的双向联动：缓存没了 → 媒体库不留死条目
    /// （否则下次缓存 upsert 又会出现，看起来像「删不掉」）。
    /// 返回是否真的删了行。
    pub async fn delete_media_item_by_ref(
        &self,
        source: &str,
        ref_key: &str,
    ) -> libsql::Result<bool> {
        let row = self
            .row_opt(
                "SELECT id FROM media_item WHERE source = ?1 AND ref = ?2",
                params![source.to_string(), ref_key.to_string()],
            )
            .await?;
        let Some(r) = row else { return Ok(false) };
        let id: i64 = r.get(0)?;
        self.delete_media_item(id).await?;
        Ok(true)
    }

    // ---- 剧集（series / episodes） ----

    /// 剧集列表（含分集数、季数、标签）。
    pub async fn list_series(&self) -> libsql::Result<Vec<SeriesView>> {
        let stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.title, s.description, s.kind, s.poster, s.year,
                        s.created_at, s.updated_at,
                        (SELECT COUNT(*) FROM media_episode e WHERE e.series_id = s.id),
                        (SELECT COUNT(DISTINCT e.season) FROM media_episode e WHERE e.series_id = s.id),
                        (SELECT e.item_id FROM media_episode e WHERE e.series_id = s.id
                          ORDER BY e.season, e.episode_no, e.id LIMIT 1),
                        (SELECT i.poster FROM media_episode e JOIN media_item i ON i.id = e.item_id
                          WHERE e.series_id = s.id AND i.poster IS NOT NULL
                          ORDER BY e.season, e.episode_no, e.id LIMIT 1),
                        (SELECT i.kind FROM media_episode e JOIN media_item i ON i.id = e.item_id
                          WHERE e.series_id = s.id
                          ORDER BY e.season, e.episode_no, e.id LIMIT 1)
                   FROM media_series s
                  ORDER BY s.updated_at DESC, s.id DESC",
            )
            .await?;
        let mut rows = stmt.query(()).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            let explicit: Option<String> = r.get(4)?;
            let cover_item_id: Option<i64> = r.get(10)?;
            let cover_poster: Option<String> = r.get(11)?;
            out.push(SeriesView {
                id: r.get(0)?,
                title: r.get(1)?,
                description: r.get(2)?,
                kind: r.get(3)?,
                poster: explicit.or(cover_poster),
                cover_item_id,
                cover_kind: r.get(12)?,
                year: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                episode_count: r.get(8)?,
                season_count: r.get(9)?,
                tags: Vec::new(),
            });
        }
        self.attach_series_tags(&mut out).await?;
        Ok(out)
    }

    async fn attach_series_tags(&self, list: &mut [SeriesView]) -> libsql::Result<()> {
        if list.is_empty() {
            return Ok(());
        }
        let stmt = self
            .conn
            .prepare(
                "SELECT st.series_id, t.id, t.name, t.color
                   FROM media_series_tag st JOIN media_tag t ON t.id = st.tag_id
                  ORDER BY t.name",
            )
            .await?;
        let mut rows = stmt.query(()).await?;
        let mut map: std::collections::HashMap<i64, Vec<TagRef>> =
            std::collections::HashMap::new();
        while let Some(r) = rows.next().await? {
            let sid: i64 = r.get(0)?;
            map.entry(sid).or_default().push(TagRef {
                id: r.get(1)?,
                name: r.get(2)?,
                color: r.get(3)?,
            });
        }
        for s in list.iter_mut() {
            if let Some(tags) = map.remove(&s.id) {
                s.tags = tags;
            }
        }
        Ok(())
    }

    /// 剧集详情（含分集，按季/集号排序）。
    pub async fn get_series(&self, id: i64) -> libsql::Result<Option<SeriesDetail>> {
        let all = self.list_series().await?;
        let Some(series) = all.into_iter().find(|s| s.id == id) else {
            return Ok(None);
        };
        let stmt = self
            .conn
            .prepare(
                "SELECT e.id, e.item_id, e.season, e.episode_no, e.title,
                        i.title, i.poster, i.duration, i.kind, e.description
                   FROM media_episode e
                   LEFT JOIN media_item i ON i.id = e.item_id
                  WHERE e.series_id = ?1
                  ORDER BY e.season ASC, e.episode_no ASC, e.id ASC",
            )
            .await?;
        let mut rows = stmt.query(params![id]).await?;
        let mut episodes = Vec::new();
        while let Some(r) = rows.next().await? {
            episodes.push(EpisodeView {
                id: r.get(0)?,
                item_id: r.get(1)?,
                season: r.get(2)?,
                episode_no: r.get(3)?,
                title: r.get(4)?,
                item_title: r.get(5)?,
                poster: r.get(6)?,
                duration: r.get(7)?,
                kind: r.get(8)?,
                description: r.get(9)?,
            });
        }
        Ok(Some(SeriesDetail { series, episodes }))
    }

    /// 新建剧集，返回 id。`source_key` 为幂等来源键（非 TG 自动成剧时为 None，
    /// 用户手动建的剧集不参与去重；它独立于 `description`，不污染用户可见的介绍字段）。
    pub async fn create_series(
        &self,
        title: &str,
        description: Option<&str>,
        kind: &str,
        year: Option<i64>,
        source_key: Option<&str>,
    ) -> libsql::Result<i64> {
        let t = now_secs();
        self.conn
            .execute(
                "INSERT INTO media_series (title, description, kind, year, source_key, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    title.to_string(),
                    description.map(str::to_string),
                    kind.to_string(),
                    year,
                    source_key.map(str::to_string),
                    t
                ],
            )
            .await?;
        let row = self
            .row_opt("SELECT last_insert_rowid()", ())
            .await?;
        match row {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 更新剧集元数据（None = 不改）。
    pub async fn update_series(&self, id: i64, patch: &SeriesPatch) -> libsql::Result<bool> {
        let Some(cur) = self.get_series(id).await? else {
            return Ok(false);
        };
        let s = cur.series;
        let title = patch.title.clone().unwrap_or(s.title);
        let description = patch.description.clone().or(s.description);
        let kind = patch.kind.clone().unwrap_or(s.kind);
        let poster = match patch.poster.clone() {
            Some(v) => v, // 显式 null → 清空，回退到自动推导的首集封面
            None => s.poster,
        };
        let year = patch.year.or(s.year);
        let t = now_secs();
        self.conn
            .execute(
                "UPDATE media_series SET title = ?1, description = ?2, kind = ?3,
                        poster = ?4, year = ?5, updated_at = ?6 WHERE id = ?7",
                params![title, description, kind, poster, year, t, id],
            )
            .await?;
        Ok(true)
    }

    /// 删除剧集（分集与标签关联一并清理；**内容条目本身保留**，仅解除归属）。
    pub async fn delete_series(&self, id: i64) -> libsql::Result<()> {
        self.conn
            .execute("DELETE FROM media_episode WHERE series_id = ?1", params![id])
            .await?;
        self.conn
            .execute("DELETE FROM media_series_tag WHERE series_id = ?1", params![id])
            .await?;
        self.conn
            .execute("DELETE FROM media_series WHERE id = ?1", params![id])
            .await?;
        Ok(())
    }

    /// 加入分集。同 (series, season, episode_no) 已存在则更新指向的条目。
    pub async fn add_episode(
        &self,
        series_id: i64,
        item_id: i64,
        season: i64,
        episode_no: i64,
        title: Option<&str>,
    ) -> libsql::Result<i64> {
        self.conn
            .execute(
                "INSERT INTO media_episode (series_id, item_id, season, episode_no, title)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(series_id, season, episode_no) DO UPDATE SET
                   item_id = excluded.item_id, title = excluded.title",
                params![series_id, item_id, season, episode_no, title.map(str::to_string)],
            )
            .await?;
        // 归属变更需刷新剧集时间戳，保证列表按最近整理排序。
        self.conn
            .execute(
                "UPDATE media_series SET updated_at = ?1 WHERE id = ?2",
                params![now_secs(), series_id],
            )
            .await?;
        let row = self
            .row_opt(
                "SELECT id FROM media_episode WHERE series_id = ?1 AND season = ?2 AND episode_no = ?3",
                params![series_id, season, episode_no],
            )
            .await?;
        match row {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 把多条内容按当前顺序批量追加为同一季的连续集号。
    pub async fn append_episodes(
        &self,
        series_id: i64,
        season: i64,
        item_ids: &[i64],
    ) -> libsql::Result<i64> {
        let stmt = self
            .conn
            .prepare(
                "SELECT COALESCE(MAX(episode_no), 0) FROM media_episode
                  WHERE series_id = ?1 AND season = ?2",
            )
            .await?;
        let mut rows = stmt.query(params![series_id, season]).await?;
        let mut next: i64 = match rows.next().await? {
            Some(r) => r.get(0)?,
            None => 0,
        };
        // 幂等（BUG-031）：同一**季**内跳过已收录条目 —— 重复缓存/重复入队不会把同一条目
        // 编成两集（此前会重复 add_episode，剧集里出现重复分集）。
        //
        // 去重粒度刻意与 `UNIQUE(series_id, season, episode_no)` 对齐（剧集 × 季），
        // 而不是整个剧集：条目「位置」的唯一性本来就按季定义，同一素材被用户显式放进
        // 另一季（如 S1 正片 + S2 回顾）是合法编排，不该被全局去重吞掉。
        let have = self.season_item_ids(series_id, season).await?;
        let mut added = 0;
        for id in item_ids {
            if have.contains(id) {
                continue;
            }
            next += 1;
            self.add_episode(series_id, *id, season, next, None).await?;
            added += 1;
        }
        Ok(added)
    }

    /// 该剧集**某一季**已收录的条目 id 集合（供追加去重；粒度同
    /// `UNIQUE(series_id, season, episode_no)`）。
    pub async fn season_item_ids(
        &self,
        series_id: i64,
        season: i64,
    ) -> libsql::Result<HashSet<i64>> {
        let stmt = self
            .conn
            .prepare("SELECT item_id FROM media_episode WHERE series_id = ?1 AND season = ?2")
            .await?;
        let mut rows = stmt.query(params![series_id, season]).await?;
        let mut out = HashSet::new();
        while let Some(r) = rows.next().await? {
            out.insert(r.get(0)?);
        }
        Ok(out)
    }

    /// 按 source_key 反查剧集（幂等建剧集：同一 TG 组不重复建）。
    pub async fn find_series_by_source_key(&self, key: &str) -> libsql::Result<Option<i64>> {
        let row = self
            .row_opt(
                "SELECT id FROM media_series WHERE source_key = ?1 LIMIT 1",
                params![key.to_string()],
            )
            .await?;
        match row {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    /// 移除分集（内容条目保留）。
    pub async fn remove_episode(&self, episode_id: i64) -> libsql::Result<()> {
        // 先取出归属与位置，删后重排该季后续集号（BUG-031：此前删中间一集会留下断层，
        // 出现 S1E1、S1E3 这种编号跳跃）。
        let info = {
            let stmt = self
                .conn
                .prepare("SELECT series_id, season, episode_no FROM media_episode WHERE id = ?1")
                .await?;
            let mut rows = stmt.query(params![episode_id]).await?;
            match rows.next().await? {
                Some(r) => Some((r.get::<i64>(0)?, r.get::<i64>(1)?, r.get::<i64>(2)?)),
                None => None,
            }
        };
        self.conn
            .execute("DELETE FROM media_episode WHERE id = ?1", params![episode_id])
            .await?;
        if let Some((sid, season, no)) = info {
            self.conn
                .execute(
                    "UPDATE media_episode SET episode_no = episode_no - 1
                      WHERE series_id = ?1 AND season = ?2 AND episode_no > ?3",
                    params![sid, season, no],
                )
                .await?;
            self.conn
                .execute(
                    "UPDATE media_series SET updated_at = ?2 WHERE id = ?1",
                    params![sid, now_secs()],
                )
                .await?;
            self.prune_empty_series(sid).await?;
        }
        Ok(())
    }

    /// 一批条目的 kind 集合（自动成剧时据此判定剧集类型：全视频=series、
    /// 全图片=album、混合=collection）。
    pub async fn kinds_of_items(&self, item_ids: &[i64]) -> libsql::Result<HashSet<String>> {
        let mut out = HashSet::new();
        for id in item_ids {
            let stmt = self
                .conn
                .prepare("SELECT kind FROM media_item WHERE id = ?1")
                .await?;
            let mut rows = stmt.query(params![*id]).await?;
            if let Some(r) = rows.next().await? {
                out.insert(r.get::<String>(0)?);
            }
        }
        Ok(out)
    }

    /// 更新分集标题 / 介绍（None = 不改，与 item/series 的 PATCH 语义一致）。
    pub async fn update_episode(
        &self,
        episode_id: i64,
        title: Option<&str>,
        description: Option<&str>,
    ) -> libsql::Result<bool> {
        let cur = self
            .row_opt(
                "SELECT title, description FROM media_episode WHERE id = ?1",
                params![episode_id],
            )
            .await?;
        let Some(r) = cur else {
            return Ok(false);
        };
        let cur_title: Option<String> = r.get(0)?;
        let cur_desc: Option<String> = r.get(1)?;
        let new_title = title.map(str::to_string).or(cur_title);
        let new_desc = description.map(str::to_string).or(cur_desc);
        let n = self
            .conn
            .execute(
                "UPDATE media_episode SET title = ?1, description = ?2 WHERE id = ?3",
                params![new_title, new_desc, episode_id],
            )
            .await?;
        Ok(n > 0)
    }

    // ---- 标签 ----

    /// 全部标签 + 使用计数。
    pub async fn list_tags(&self) -> libsql::Result<Vec<TagView>> {
        let stmt = self
            .conn
            .prepare("SELECT id, name, color FROM media_tag ORDER BY name COLLATE NOCASE")
            .await?;
        let mut rows = stmt.query(()).await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            let id: i64 = r.get(0)?;
            let name: String = r.get(1)?;
            let color: Option<String> = r.get(2)?;
            let item_count: i64 = self
                .count_one(
                    "SELECT COUNT(*) FROM media_item_tag WHERE tag_id = ?1",
                    params![id],
                )
                .await?;
            let series_count: i64 = self
                .count_one(
                    "SELECT COUNT(*) FROM media_series_tag WHERE tag_id = ?1",
                    params![id],
                )
                .await?;
            out.push(TagView {
                id,
                name,
                color,
                item_count,
                series_count,
            });
        }
        Ok(out)
    }

    async fn count_one(
        &self,
        sql: &str,
        p: impl libsql::params::IntoParams,
    ) -> libsql::Result<i64> {
        let mut rows = self.conn.prepare(sql).await?.query(p).await?;
        match rows.next().await? {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 新建标签（重名返回已存在的 id，便于前端幂等调用）。
    pub async fn create_tag(&self, name: &str, color: Option<&str>) -> libsql::Result<i64> {
        let row = self
            .row_opt(
                "SELECT id FROM media_tag WHERE name = ?1",
                params![name.to_string()],
            )
            .await?;
        if let Some(r) = row {
            return r.get(0);
        }
        self.conn
            .execute(
                "INSERT INTO media_tag (name, color) VALUES (?1, ?2)",
                params![name.to_string(), color.map(str::to_string)],
            )
            .await?;
        let row = self.row_opt("SELECT last_insert_rowid()", ()).await?;
        match row {
            Some(r) => r.get(0),
            None => Ok(0),
        }
    }

    /// 重命名标签 / 改色。
    pub async fn update_tag(&self, id: i64, name: Option<&str>, color: Option<&str>) -> libsql::Result<bool> {
        let row = self
            .row_opt("SELECT name, color FROM media_tag WHERE id = ?1", params![id])
            .await?;
        let Some(r) = row else { return Ok(false) };
        let cur_name: String = r.get(0)?;
        let cur_color: Option<String> = r.get(1)?;
        let new_name = name.map(str::to_string).unwrap_or(cur_name);
        let new_color = color.map(str::to_string).or(cur_color);
        self.conn
            .execute(
                "UPDATE media_tag SET name = ?1, color = ?2 WHERE id = ?3",
                params![new_name, new_color, id],
            )
            .await?;
        Ok(true)
    }

    /// 删除标签（关联一并解除）。
    pub async fn delete_tag(&self, id: i64) -> libsql::Result<()> {
        self.conn
            .execute("DELETE FROM media_item_tag WHERE tag_id = ?1", params![id])
            .await?;
        self.conn
            .execute("DELETE FROM media_series_tag WHERE tag_id = ?1", params![id])
            .await?;
        self.conn
            .execute("DELETE FROM media_tag WHERE id = ?1", params![id])
            .await?;
        Ok(())
    }

    /// 全量重设某内容的标签集合。
    pub async fn set_item_tags(&self, item_id: i64, tag_ids: &[i64]) -> libsql::Result<()> {
        self.conn
            .execute("DELETE FROM media_item_tag WHERE item_id = ?1", params![item_id])
            .await?;
        for tid in tag_ids {
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO media_item_tag (item_id, tag_id) VALUES (?1, ?2)",
                    params![item_id, *tid],
                )
                .await?;
        }
        Ok(())
    }

    /// 全量重设某剧集的标签集合。
    pub async fn set_series_tags(&self, series_id: i64, tag_ids: &[i64]) -> libsql::Result<()> {
        self.conn
            .execute(
                "DELETE FROM media_series_tag WHERE series_id = ?1",
                params![series_id],
            )
            .await?;
        for tid in tag_ids {
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO media_series_tag (series_id, tag_id) VALUES (?1, ?2)",
                    params![series_id, *tid],
                )
                .await?;
        }
        Ok(())
    }

    /// 资料库总览统计（首页概览条用）。
    pub async fn library_stats(&self) -> libsql::Result<LibraryStats> {
        Ok(LibraryStats {
            items: self.count_one("SELECT COUNT(*) FROM media_item", ()).await?,
            videos: self
                .count_one("SELECT COUNT(*) FROM media_item WHERE kind = 'video'", ())
                .await?,
            photos: self
                .count_one("SELECT COUNT(*) FROM media_item WHERE kind = 'photo'", ())
                .await?,
            audios: self
                .count_one("SELECT COUNT(*) FROM media_item WHERE kind = 'audio'", ())
                .await?,
            series: self.count_one("SELECT COUNT(*) FROM media_series", ()).await?,
            tags: self.count_one("SELECT COUNT(*) FROM media_tag", ()).await?,
            total_size: self
                .count_one("SELECT COALESCE(SUM(size), 0) FROM media_item", ())
                .await?,
        })
    }
}

/// 概览统计。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub items: i64,
    pub videos: i64,
    pub photos: i64,
    pub audios: i64,
    pub series: i64,
    pub tags: i64,
    pub total_size: i64,
}

/// 区分「字段缺省」与「显式 null」。
///
/// PATCH 语义要求：缺省 = 不改动；显式 `null` = 清空该字段。
/// 普通 `Option<T>` 无法区分二者（都反序列化为 `None`），
/// 因此这里把 `field: null` 映射成 `Some(None)`、字段缺省映射成 `None`。
fn nullable<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

/// 内容局部更新入参。
///
/// 目标 id 来自 URL 路径，**不在请求体里**——否则前端只发 `{poster}` 时
/// 反序列化会因缺 `id` 直接 422。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPatch {
    pub title: Option<String>,
    /// 封面：缺省=不改；`null`=清空；字符串=替换。
    #[serde(default, deserialize_with = "nullable")]
    pub poster: Option<Option<String>>,
    pub duration: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub kind: Option<String>,
}

/// 剧集局部更新入参（id 同样来自路径）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub kind: Option<String>,
    /// 封面：缺省=不改；`null`=清空（回退到自动推导的首集封面）。
    #[serde(default, deserialize_with = "nullable")]
    pub poster: Option<Option<String>>,
    pub year: Option<i64>,
}

// ────────────────────────────── 本地目录扫描 ──────────────────────────────

/// 扫描到的本地媒体文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: i64,
    /// 所在目录（相对扫描根，用于推断合集名）。
    pub dir: String,
}

const VIDEO_EXT: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "flv", "wmv", "mpg", "mpeg", "ts", "m2ts",
];
const PHOTO_EXT: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic"];
const AUDIO_EXT: &[&str] = &["mp3", "flac", "wav", "aac", "m4a", "ogg", "opus"];

/// 按扩展名判定媒体类型；非媒体返回 None。
pub fn classify_ext(ext: &str) -> Option<&'static str> {
    let e = ext.to_ascii_lowercase();
    if VIDEO_EXT.contains(&e.as_str()) {
        return Some("video");
    }
    if PHOTO_EXT.contains(&e.as_str()) {
        return Some("photo");
    }
    if AUDIO_EXT.contains(&e.as_str()) {
        return Some("audio");
    }
    None
}

/// 递归扫描目录，返回其中可识别的媒体文件（按路径排序，稳定结果）。
/// `max` 限制返回条数，防止误扫超大目录。
pub fn scan_dir(root: &Path, max: usize) -> Result<Vec<ScannedFile>, std::io::Error> {
    let mut out = Vec::new();
    collect(root, root, &mut out, max)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn collect(
    root: &Path,
    dir: &Path,
    out: &mut Vec<ScannedFile>,
    max: usize,
) -> Result<(), std::io::Error> {
    if out.len() >= max {
        return Ok(());
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok(()), // 无权限/已删除目录：跳过而非中断整次扫描
    };
    for entry in rd.flatten() {
        if out.len() >= max {
            break;
        }
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect(root, &path, out, max)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_string();
        let Some(kind) = classify_ext(&ext) else {
            continue;
        };
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let rel_dir = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        out.push(ScannedFile {
            path: path.to_string_lossy().to_string(),
            name,
            kind: kind.to_string(),
            size: meta.len() as i64,
            dir: rel_dir,
        });
    }
    Ok(())
}

/// 扫描根目录下的顶层子目录名（用于「按文件夹自动建剧集」）。
pub fn top_level_dirs(root: &Path) -> Vec<(PathBuf, String)> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            out.push((path, name));
        }
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orig_tg_media_{}_{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("store.db");
        let _ = std::fs::remove_file(&p);
        p
    }

    async fn scalar_i64(conn: &libsql::Connection, sql: &str) -> i64 {
        let stmt = conn.prepare(sql).await.unwrap();
        let mut rows = stmt.query(()).await.unwrap();
        match rows.next().await.unwrap() {
            Some(r) => r.get(0).unwrap(),
            None => 0,
        }
    }

    /// 回归（BUG-031）：**旧库 + 新代码** 首次启动时 `Store::open` 必须成功。
    ///
    /// 缺陷原形：`CREATE UNIQUE INDEX ... ON media_series(source_key)` 被放在建表批里，
    /// 而 `source_key` 只在后面的 `ALTER TABLE` 才补上 —— 旧库执行整批时
    /// `no such column: source_key`，`open` 返回 Err，调用方回落空库，UI 表现为「数据全丢」。
    #[tokio::test]
    async fn legacy_db_migrates_without_failing_open() {
        let path = tmp_db("legacy");
        // 1) 造一个「上一版」的库：media_series 无 source_key、media_episode 无 description。
        {
            let conn = libsql::Builder::new_local(&path).build().await.unwrap().connect().unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE media_item (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ref TEXT NOT NULL,
                    title TEXT NOT NULL, kind TEXT NOT NULL, file_path TEXT, poster TEXT,
                    size INTEGER, duration INTEGER, width INTEGER, height INTEGER,
                    added_at INTEGER NOT NULL, UNIQUE(source, ref)
                );
                CREATE TABLE media_series (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
                    kind TEXT NOT NULL DEFAULT 'series', poster TEXT, year INTEGER,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE media_episode (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL,
                    item_id INTEGER NOT NULL, season INTEGER NOT NULL DEFAULT 1,
                    episode_no INTEGER NOT NULL DEFAULT 1, title TEXT,
                    UNIQUE(series_id, season, episode_no)
                );
                INSERT INTO media_item (source, ref, title, kind, added_at)
                    VALUES ('local', 'D:/x/a.mp4', 'a', 'video', 1);
                INSERT INTO media_series (title, kind, created_at, updated_at)
                    VALUES ('旧剧集', 'series', 1, 1);
                "#,
            )
            .await
            .unwrap();
        }

        // 2) 新代码打开旧库：必须成功（回归点），且旧数据仍在。
        let s = Store::open(&path)
            .await
            .expect("旧库必须能被新代码打开（迁移顺序错误会让整批建表失败）");

        assert_eq!(
            scalar_i64(&s.conn, "SELECT COUNT(*) FROM media_series").await,
            1,
            "迁移不得丢数据"
        );
        assert_eq!(
            scalar_i64(
                &s.conn,
                "SELECT COUNT(*) FROM pragma_table_info('media_series') WHERE name = 'source_key'"
            )
            .await,
            1,
            "source_key 列应被补齐"
        );
        assert_eq!(
            scalar_i64(
                &s.conn,
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index'
                   AND name = 'idx_media_series_source_key'"
            )
            .await,
            1,
            "唯一索引应在 ALTER 之后建成"
        );
        assert_eq!(
            scalar_i64(
                &s.conn,
                "SELECT COUNT(*) FROM pragma_table_info('media_episode') WHERE name = 'description'"
            )
            .await,
            1,
            "media_episode.description 列应被补齐"
        );

        // 3) 索引真的生效（幂等键唯一）：同 key 第二条必须被拒。
        s.create_series("A", None, "series", None, Some("tg:group:1:9"))
            .await
            .unwrap();
        assert!(
            s.create_series("B", None, "series", None, Some("tg:group:1:9"))
                .await
                .is_err(),
            "source_key 唯一索引应拒绝重复的 TG 组键"
        );

        // 4) 新库冷启动同样可用。
        let fresh = Store::open(tmp_db("fresh")).await.unwrap();
        fresh
            .create_series("C", None, "series", None, Some("tg:group:2:9"))
            .await
            .unwrap();
    }

    /// 追加分集的幂等粒度：**同季**去重，跨季允许。
    ///
    /// 前者防「重复缓存同一条消息 → 剧集里出现重复分集」（BUG-031 主诉）；
    /// 后者保护用户显式把同一素材编入另一季的合法编排。
    #[tokio::test]
    async fn append_episodes_dedups_within_season_only() {
        let s = Store::open(tmp_db("append")).await.unwrap();
        let a = s
            .upsert_media_item("local", "D:/x/a.mp4", "a", "video", Some("D:/x/a.mp4"), None, None)
            .await
            .unwrap();
        let b = s
            .upsert_media_item("local", "D:/x/b.mp4", "b", "video", Some("D:/x/b.mp4"), None, None)
            .await
            .unwrap();
        let sid = s.create_series("S", None, "series", None, None).await.unwrap();

        assert_eq!(s.append_episodes(sid, 1, &[a, b]).await.unwrap(), 2);
        // 同季重复追加：全部跳过，不产生重复分集。
        assert_eq!(s.append_episodes(sid, 1, &[a, b]).await.unwrap(), 0);
        assert_eq!(s.append_episodes(sid, 1, &[b, a]).await.unwrap(), 0);
        // 跨季：同一素材可在另一季出现。
        assert_eq!(s.append_episodes(sid, 2, &[a]).await.unwrap(), 1);

        let det = s.get_series(sid).await.unwrap().unwrap();
        assert_eq!(det.episodes.len(), 3, "S1 两集 + S2 一集");
        let mut nos: Vec<(i64, i64)> = det
            .episodes
            .iter()
            .map(|e| (e.season, e.episode_no))
            .collect();
        nos.sort();
        assert_eq!(nos, vec![(1, 1), (1, 2), (2, 1)], "集号应连续无跳号");
    }
}
