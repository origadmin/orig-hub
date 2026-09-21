//! 媒体资料库（Media Library）——用户可管理的**内容目录**层。
//!
//! 与 `media_message`（TG 同步下来的原始消息流水）职责分离：
//!   - `media_message`：流水账，随频道同步自动增删，用户不直接编辑。
//!   - 本模块：资料库，用户显式导入/整理的内容（本地文件 + TG 条目），
//!     支持 **剧集（series/episode）**、**标签（tag）**、**图片管理**。
//!
//! 表结构见 `migrate()`。所有写入均通过 `Store`（同一 SQLite 连接）完成。

use std::collections::{HashMap, HashSet};
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

/// 文案切分回填的**一次性**标记键（`app_setting`）。
const ITEM_TEXT_SPLIT_MIG: &str = "mig.item_text_split_v1";

/// 分集文案并入条目的一次性迁移标记（见 [`collapse_episode_text`]）。
const EPISODE_TEXT_MIG: &str = "mig.episode_text_to_item_v1";

/// 求某条 TG 引用（`"<chat_id>:<message_id>"`）在流水表里的原始 caption。
///
/// 回填优先用它而不是 `title`：流水里的 caption 是最全的原文，
/// 而 `title` 只是当年某次写入的产物（可能已被截断）。
async fn caption_of_ref(conn: &Connection, ref_key: &str) -> libsql::Result<Option<String>> {
    let Some((chat, msg)) = ref_key.split_once(':') else {
        return Ok(None);
    };
    let (Ok(chat_id), Ok(message_id)) = (chat.trim().parse::<i64>(), msg.trim().parse::<i64>())
    else {
        return Ok(None);
    };
    let stmt = conn
        .prepare("SELECT caption FROM media_message WHERE channel_id = ?1 AND message_id = ?2")
        .await?;
    let mut rows = stmt.query(params![chat_id, message_id]).await?;
    match rows.next().await? {
        Some(r) => {
            let c: Option<String> = r.get(0)?;
            Ok(c.filter(|c| !c.trim().is_empty()))
        }
        None => Ok(None),
    }
}

/// 一次性回填：把历史上塞进 `title` 的整段 caption 切成「标题 + 介绍」。
///
/// **为什么必须回填**：写入路径（`routes::import_cached_file` / `import_photo_item`）
/// 已经改用 [`split_caption`]，但那只救新数据。老行的 `title` 是整段原文
/// （标题行 + 正文 + 标签行），用户在媒体库与播放页看到的还是那一大坨 ——
/// 而同一条消息自动成剧后的剧集详情页却标题干净、介绍完整，正是
/// 「剧集正确、视频错误」的来源。数据不修，代码修得再对也看不见。
///
/// **规则**（保守，宁少动不多动）：
/// - 标题：**只重切 `title` 里含换行的行**（那是整段原文的结构特征）；
///   已经切干净的行保留原值，用户手改过的标题不会被覆盖；
/// - 介绍：**只补空位**，已有值一律不动（用户可能编辑或刻意清空过）；
/// - 原文优先取 `media_message.caption`，缺失时退化为用 `title` 自身切分。
///
/// **一次性的理由**：「补空位」这一半若每次启动都跑，用户**主动清空**的介绍
/// 会被重新填回来 —— 那就成了无法表达的「我不要这段介绍」。故用标记键收口。
async fn backfill_item_text(conn: &Connection) -> libsql::Result<usize> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    )
    .await?;
    let stmt = conn
        .prepare("SELECT 1 FROM app_setting WHERE key = ?1")
        .await?;
    let mut rows = stmt.query(params![ITEM_TEXT_SPLIT_MIG]).await?;
    let already = rows.next().await?.is_some();
    drop(rows);
    if already {
        return Ok(0);
    }

    let candidates = {
        let stmt = conn
            .prepare(
                "SELECT id, source, ref, title, description FROM media_item
                  WHERE instr(title, char(10)) > 0 OR description IS NULL",
            )
            .await?;
        let mut rows = stmt.query(()).await?;
        let mut out: Vec<(i64, String, String, String, Option<String>)> = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?));
        }
        out
    };

    let mut fixed = 0usize;
    for (id, source, ref_key, cur_title, cur_desc) in candidates {
        let blob = cur_title.contains('\n');
        let text = if source == "tg" {
            caption_of_ref(conn, &ref_key)
                .await?
                .unwrap_or_else(|| cur_title.clone())
        } else {
            cur_title.clone()
        };
        let (t, d) = split_caption(&text);
        let next_title = if blob {
            // 首行为空（split_caption 返回 None）时保留原值，绝不写空标题。
            t.unwrap_or_else(|| cur_title.clone())
        } else {
            cur_title.clone()
        };
        let next_desc = match cur_desc.clone().filter(|s| !s.trim().is_empty()) {
            Some(v) => Some(v),
            None => d,
        };
        if next_title == cur_title && next_desc == cur_desc {
            continue;
        }
        conn.execute(
            "UPDATE media_item SET title = ?1, description = ?2 WHERE id = ?3",
            params![next_title, next_desc, id],
        )
        .await?;
        fixed += 1;
    }

    conn.execute(
        "INSERT OR REPLACE INTO app_setting (key, value) VALUES (?1, '1')",
        params![ITEM_TEXT_SPLIT_MIG],
    )
    .await?;
    Ok(fixed)
}

/// 一次性迁移：把分集行上的内容文案搬回条目，并腾空死列。
///
/// 背景：`media_episode` 曾有 `title` / `description` 两列，与 `media_item` 的同名列
/// 承载同一份文案，且由不同路径写入（编辑面板写分集、卡片编辑写条目、归档各写一份）。
/// 于是「剧集里的视频」和「媒体库里的同一个视频」可以显示不同名字、介绍一边有一边空。
/// 现在分集只表示**位置**，内容文案唯一归属条目，因此：
///
///   1. 条目介绍为空、分集有 → **填充进条目**（用户报的「介绍没填充进视频」正是这一格）；
///   2. 清空 `media_episode.title` / `description` —— 让「第二份副本」在数据上不可表达，
///      否则以后任何一次误读都会把分歧重新引回来。
///
/// 两列都有值时**以条目为准**（条目才是内容），并把分歧条数回报出来供日志留痕。
/// 用标记键收口：这是一次性搬运，不能每次启动都跑（否则用户清空过的介绍会被重新填回）。
async fn collapse_episode_text(conn: &Connection) -> libsql::Result<(usize, usize)> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    )
    .await?;
    let stmt = conn
        .prepare("SELECT 1 FROM app_setting WHERE key = ?1")
        .await?;
    let mut rows = stmt.query(params![EPISODE_TEXT_MIG]).await?;
    let already = rows.next().await?.is_some();
    drop(rows);
    if already {
        return Ok((0, 0));
    }

    // 1) 条目介绍为空、分集有 → 搬运。
    //    只搬介绍：标题这一列在条目上是 NOT NULL（永远有值），而分集上的标题一直只是
    //    条目标题的快照（合并路径写的就是 `item_title.or(ep_title)`、其它路径一律不写），
    //    所以「分集标题优先」没有依据，条目才是内容的名字。
    let filled = conn
        .execute(
            "UPDATE media_item SET
               description = (SELECT e.description FROM media_episode e
                               WHERE e.item_id = media_item.id
                                 AND COALESCE(e.description, '') <> '' LIMIT 1)
             WHERE COALESCE(description, '') = ''
               AND EXISTS (SELECT 1 FROM media_episode e
                            WHERE e.item_id = media_item.id
                              AND COALESCE(e.description, '') <> '')",
            (),
        )
        .await?;

    // 2) 两列都有值且不等 → 条目胜出，如实计数（留痕，不静默）。
    let diverged = {
        let stmt = conn
            .prepare(
                "SELECT COUNT(*) FROM media_episode e JOIN media_item i ON i.id = e.item_id
                  WHERE COALESCE(e.description, '') <> '' AND COALESCE(i.description, '') <> ''
                    AND e.description <> i.description",
            )
            .await?;
        let mut rows = stmt.query(()).await?;
        match rows.next().await? {
            Some(r) => r.get::<i64>(0)? as usize,
            None => 0,
        }
    };

    // 3) 腾空死列：此后没有任何读写路径会碰它们。
    conn.execute("UPDATE media_episode SET title = NULL, description = NULL", ())
        .await?;

    conn.execute(
        "INSERT OR REPLACE INTO app_setting (key, value) VALUES (?1, '1')",
        params![EPISODE_TEXT_MIG],
    )
    .await?;
    Ok((filled as usize, diverged))
}

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
    // 旧库兼容：media_episode 补**合并溯源**列（BUG-037）。
    //
    // 为什么存标题快照而不是来源剧集 id：合并会把源剧集**删除**，id 立刻悬空，
    // 前端就再也显示不出「这条原来是哪部剧的」。原始集号同理 —— 合并要重编集号
    // （位置必须在该季唯一有序），若不留下原号，用户就分不清搬过来的 `1-2` 与
    // 本地原有的 `1,2` 谁是谁。
    for (col, ty) in [
        ("origin_series_title", "TEXT"),
        ("origin_episode_no", "INTEGER"),
        // 合集范围（BUG-039）：一个文件含多集（如「1-2集合集」）时，
        // 记录占用区间的终点；NULL = 单集。槽位身份仍是起点 episode_no。
        ("episode_no_end", "INTEGER"),
    ] {
        let probe = conn
            .prepare(&format!(
                "SELECT 1 FROM pragma_table_info('media_episode') WHERE name = '{col}'"
            ))
            .await?;
        let exists = probe.query(()).await?.next().await?.is_some();
        if !exists {
            conn.execute(
                &format!("ALTER TABLE media_episode ADD COLUMN {col} {ty}"),
                (),
            )
            .await?;
        }
    }
    // 旧库兼容：media_item 补 description 列 —— 条目的「介绍位」。
    //
    // 为什么必须有：剧集侧一直有 title + description 两栏（详情页能读出剧名与简介），
    // 条目侧却只有 title。于是 caption 的正文无处安放，只能被塞进 title 里，
    // 表现就是「剧集正确、视频错误」：同一条消息，剧集详情页标题干净、介绍完整，
    // 点开视频却是一整段原文（标题 + 正文 + 标签行）。
    let probe = conn
        .prepare("SELECT 1 FROM pragma_table_info('media_item') WHERE name = 'description'")
        .await?;
    let exists = probe.query(()).await?.next().await?.is_some();
    if !exists {
        conn.execute("ALTER TABLE media_item ADD COLUMN description TEXT", ())
            .await?;
    }
    // 一次性回填历史行（见 `backfill_item_text`）。必须在补列**之后**。
    backfill_item_text(conn).await?;

    // 分集行上的内容文案搬进条目、死列腾空（见 `collapse_episode_text`）。
    // 必须在 `backfill_item_text` **之后**：先让条目的介绍位就位（含从 caption 切出来的），
    // 再处理「条目仍为空而分集有」的那一格，否则会互相覆盖。
    let (filled, diverged) = collapse_episode_text(conn).await?;
    if filled > 0 || diverged > 0 {
        eprintln!(
            "[media] episode text collapsed into items: filled={filled} item_wins={diverged}"
        );
    }
    // 同槽多来源（BUG-039）：同一 (season, episode_no) 槽位的主条目之外的
    // 备用来源。item_id 全表唯一（同一内容只会是某一集的来源，不会同时挂两集）。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_episode_source (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            episode_id INTEGER NOT NULL,
            item_id    INTEGER NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            UNIQUE(episode_id, item_id)
        )",
        (),
    )
    .await?;

    // ── BUG-044 规则级不变量：剧集分集与备用源**只能是视频** ──
    //
    // 「图片是浏览点，与视频无关」——播放一个视频永远不能播到一张图片。
    // 该不变量不能靠调用方逐个守（自动成剧、手动添加、合并、将来任何新写路径
    // 都会漏），而是用**触发器**在数据层表达：任何写路径试图把非视频条目挂成
    // 分集 / 备用源，数据库直接拒绝。条目不存在（kind 查不到 = NULL）同样拒绝：
    // 挂一个未知条目当分集与挂一张图片当分集是同一类错误状态。
    //
    // 先清历史脏数据（旧版本自动成剧曾把整组 TG 相册连同图片一起编成剧集），
    // 失去全部分集的剧集随之删除（纯图组从来不该是「剧集」）。
    let mut affected_series: Vec<i64> = Vec::new();
    {
        let stmt = conn
            .prepare(
                "SELECT DISTINCT series_id FROM media_episode
                  WHERE item_id IN (SELECT id FROM media_item WHERE kind NOT IN ('video','photo'))",
            )
            .await?;
        let mut rows = stmt.query(()).await?;
        while let Some(r) = rows.next().await? {
            affected_series.push(r.get(0)?);
        }
    }
    conn.execute(
        "DELETE FROM media_episode
          WHERE item_id IN (SELECT id FROM media_item WHERE kind NOT IN ('video','photo'))",
        (),
    )
    .await?;
    // 播放源**仍然只认 video**：图片可以进剧集（浏览位），但永远不能成为某个 GIF。
    conn.execute(
        "DELETE FROM media_episode_source
          WHERE item_id IN (SELECT id FROM media_item WHERE kind IS NOT 'video')",
        (),
    )
    .await?;
    for sid in affected_series {
        let empty = conn
            .prepare("SELECT COUNT(*) FROM media_episode WHERE series_id = ?1")
            .await?
            .query(params![sid])
            .await?
            .next()
            .await?
            .map(|r| r.get::<i64>(0).map(|n| n == 0))
            .transpose()?
            .unwrap_or(true);
        if empty {
            conn.execute("DELETE FROM media_series_tag WHERE series_id = ?1", params![sid])
                .await?;
            conn.execute("DELETE FROM media_series WHERE id = ?1", params![sid])
                .await?;
        }
    }
    // kind 必须反映实际构成（BUG-044 残留：只摘图片分集不重算 kind，幸存的
    // 混编 collection/album 分集已全视频，徽标却仍是「相集」——展示与事实脱节）。
    conn.execute(
        "UPDATE media_series SET kind = 'series'
          WHERE kind IS NOT 'series'
            AND EXISTS (SELECT 1 FROM media_episode e WHERE e.series_id = media_series.id)
            AND NOT EXISTS (
                SELECT 1 FROM media_episode e JOIN media_item i ON i.id = e.item_id
                 WHERE e.series_id = media_series.id AND i.kind NOT IN ('video','photo'))",
        (),
    )
    .await?;
    // 剧集是**通用归档容器**（用户在第 4 轮裁定）：所有缓存内容都进剧集 —— 单条视频、
    // 单张图片也成剧，因为只有剧集才有「标题 + 介绍 + 标签」的完整档案位。
    // 因此对分集放宽到 `video | photo`；图片作为**浏览位内容**入剧，
    // 播放序列在展示层排除非视频（播放永远与图片无关）。
    //
    // **唯一剩下的硬门是播放源**：`media_episode_source` 仍只接受 video ——
    // 「播放视频时播放到图片」这个错误从此在结构上不可表达，而不是靠展示层自觉。
    //
    // ⚠️ 退役的旧触发器必须**显式 DROP**：`CREATE TRIGGER IF NOT EXISTS` 只防「重复创建」，
    // 不会让**另一个名字**的旧触发器失效。第 4 轮把分集放宽到 video|photo 时新增了
    // `*_media_only_*`，但旧的 `trg_media_episode_video_only_ins/upd` 仍留在**已升级的库**里，
    // 它们在 `kind IS NOT 'video'` 时 ABORT —— 于是图片分集在老库上插入被拒，表现为
    // 「剧集建成却 0 分集」。全新库（单测）没有旧触发器，故只有「旧库→新代码」这条路径
    // 会踩坑；收敛只能靠 DROP，不能靠重建。
    conn.execute_batch(
        r#"
        DROP TRIGGER IF EXISTS trg_media_episode_video_only_ins;
        DROP TRIGGER IF EXISTS trg_media_episode_video_only_upd;
        "#,
    )
    .await?;
    for trigger_sql in [
        // 条件必须**显式判 NULL**：`kind` 为 NULL 有两种成因（条目不存在 / kind 列为空），
        // 而 `NULL NOT IN (...)` 求值为 NULL 而非真 —— 只写 NOT IN 会让「不存在的条目」
        // 堂而皇之成为分集（悬空外键）。两种成因都不合法，故 OR 并列。
        "CREATE TRIGGER IF NOT EXISTS trg_media_episode_media_only_ins
             BEFORE INSERT ON media_episode
             FOR EACH ROW
             WHEN (SELECT kind FROM media_item WHERE id = NEW.item_id) IS NULL
                  OR (SELECT kind FROM media_item WHERE id = NEW.item_id) NOT IN ('video','photo')
             BEGIN
                 SELECT RAISE(ABORT, 'episode item must be an existing video or photo item');
             END",
        "CREATE TRIGGER IF NOT EXISTS trg_media_episode_media_only_upd
             BEFORE UPDATE OF item_id ON media_episode
             FOR EACH ROW
             WHEN (SELECT kind FROM media_item WHERE id = NEW.item_id) IS NULL
                  OR (SELECT kind FROM media_item WHERE id = NEW.item_id) NOT IN ('video','photo')
             BEGIN
                 SELECT RAISE(ABORT, 'episode item must be an existing video or photo item');
             END",
        "CREATE TRIGGER IF NOT EXISTS trg_media_episode_source_video_only_ins
             BEFORE INSERT ON media_episode_source
             FOR EACH ROW
             WHEN (SELECT kind FROM media_item WHERE id = NEW.item_id) IS NOT 'video'
             BEGIN
                 SELECT RAISE(ABORT, 'episode source item must be a video item');
             END",
        "CREATE TRIGGER IF NOT EXISTS trg_media_episode_source_video_only_upd
             BEFORE UPDATE OF item_id ON media_episode_source
             FOR EACH ROW
             WHEN (SELECT kind FROM media_item WHERE id = NEW.item_id) IS NOT 'video'
             BEGIN
                 SELECT RAISE(ABORT, 'episode source item must be a video item');
             END",
    ] {
        conn.execute(trigger_sql,()).await?;
    }
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

/// 一条「已落盘字节」的引用：清理链的最小工作单元（条目 id + 归属 + 路径）。
///
/// 只描述字节，不描述剧集/分集——缓存模块不得认剧集（MEDIA-DESIGN §0）。
#[derive(Debug, Clone)]
pub struct CachedBytes {
    pub id: i64,
    /// 来源域：`tg` / `local` …
    pub source: String,
    pub ref_key: String,
    pub file_path: String,
}

/// 缓存工作集的**带标题**视图——清理预览要让人认得出「删的是哪几条」，
/// 只给 id 的清单等于让用户盲选（与「待拍板只给编号」同一类错误）。
#[derive(Debug, Clone, Serialize)]
pub struct CachedBytesDetail {
    pub id: i64,
    pub title: String,
    pub source: String,
    pub ref_key: String,
    pub file_path: String,
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
    /// 介绍（caption 首行之外的部分）。与剧集 `description` **同源同切法** ——
    /// 同一条 TG 消息自动成剧时，剧集与条目必须给出同一份「标题 + 介绍」，
    /// 否则用户在剧集详情页看到正确的名与简介、点开同一条视频却只有一整坨 caption
    /// （「剧集正确、视频错误」）。
    pub description: Option<String>,
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
    /// 内容标题 —— **取自条目**（`media_item.title`），不是分集自己的字段。
    ///
    /// 分集是「内容在剧集里的位置」（槽位），标题与介绍属于**内容**。
    /// 曾经的 `media_episode.title` / `media_episode.description` 两列是同一份
    /// 文案的第二份副本，两个写入路径各写一份 —— 于是同一个视频在剧集里叫旧名、
    /// 在媒体库里叫新名，介绍一边有一边空（用户报的「剧集和视频天差地远」）。
    /// 列还在（老库兼容），但**没有任何读写路径再碰它**。
    pub title: Option<String>,
    pub poster: Option<String>,
    pub duration: Option<i64>,
    pub kind: Option<String>,
    /// 内容介绍 —— 同样取自条目（`media_item.description`）。
    pub description: Option<String>,
    /// 合并溯源：来源剧集标题快照（源剧集已删除，故存快照而非 id）。None = 不是合并来的。
    pub origin_series_title: Option<String>,
    /// 合并溯源：并入目标前的原始集号。None = 不是合并来的。
    pub origin_episode_no: Option<i64>,
    /// 条目来源（local / tg）。同一内容从多个源进来时，用户靠它与 ref 分辨哪个该删。
    pub source: Option<String>,
    /// 条目来源标识（本地路径 / TG ref）。与 `source` 配对，是分辨「同名不同内容」
    /// 与「同内容多源」的唯一依据 —— 标题与文件名都不可靠。
    #[serde(rename = "ref")]
    pub ref_key: Option<String>,
    /// 合集范围（BUG-039）：该条目占用槽位的终点；NULL = 单集（如 1-2 集合集 → 1, end=2）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_no_end: Option<i64>,
    /// 同槽备用来源（BUG-039 冲突1）：同一集的其他缓存来源；主条目不在其中，切换即主备互换。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<SourceRef>,
    /// 这一集**当前有没有字节**（BUG-080）：`media_item.file_path IS NOT NULL`。
    ///
    /// 清缓存只删字节、留条目（清字节后条目回到「仅入库」态），条目仍会出现在剧集里 ——
    /// 没有这个布尔，前端无从分辨「有内容、点开能播」与「只剩记录、点了 404」，
    /// 于是清完缓存的分集在外观上与被伪装成可播的正常内容完全一致。
    /// **不新增列**：事实态已经由 `file_path` 表达，这里只是把它读出来。
    pub has_bytes: bool,
}

/// 备用来源引用（剧集详情里展示「N 源」并支持切换主源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub item_id: i64,
    pub title: Option<String>,
    pub kind: Option<String>,
}

/// 剧集详情 = 元数据 + 分集列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDetail {
    #[serde(flatten)]
    pub series: SeriesView,
    pub episodes: Vec<EpisodeView>,
}

/// 合并时被跳过的分集明细。
///
/// **必须回传**：跳过是合并里唯一「少搬了东西」的地方，静默吞掉会让用户以为
/// 全搬完了。带上条目标题，用户才能判断「跳掉的这条我是不是真的不需要」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSkipped {
    pub item_id: i64,
    /// 条目标题（缺失时回退到分集标题）。
    pub title: Option<String>,
    pub season: i64,
    /// 该条目在**源剧集**里的原始集号。
    pub episode_no: i64,
}

/// 剧集合并结果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    /// 实际搬移的分集数。
    pub added: i64,
    /// 因「同季已有同一条目」而跳过的分集（同一份数据记录，非内容判定）。
    pub skipped: Vec<MergeSkipped>,
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
        description: r.get(14)?,
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
             WHERE e.item_id = i.id ORDER BY e.season, e.episode_no LIMIT 1) AS series_title,
           i.description
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
    ///
    /// `description` 与 `title` 是**同一份原文的两个字段**（见 [`split_caption`]）：
    /// 调用方必须一起传，否则条目只有标题没有介绍，播放页又只剩一坨原文。
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
        description: Option<&str>,
    ) -> libsql::Result<i64> {
        let t = now_secs();
        self.conn
            .execute(
                "INSERT INTO media_item (source, ref, title, kind, file_path, size, duration, added_at, description)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(source, ref) DO UPDATE SET
                   title = COALESCE(NULLIF(excluded.title, ''), media_item.title),
                   kind = excluded.kind,
                   file_path = COALESCE(excluded.file_path, media_item.file_path),
                   size = COALESCE(excluded.size, media_item.size),
                   -- duration 回填（BUG-031）：首次入库元数据缺 duration 时，后续重新缓存
                   -- 必须能补上（此前 DO UPDATE 不含该列，缺了就永远是 NULL）。
                   duration = COALESCE(excluded.duration, media_item.duration),
                   -- 介绍同样回填：早期入库的行没有介绍，重新缓存时补上。
                   description = COALESCE(NULLIF(excluded.description, ''), media_item.description)",
                params![source, ref_key, title, kind, file_path, size, duration, t, description],
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

    /// 显式写入 `file_path`（`None` = 置空）：清缓存与字节回填的**唯一入口**。
    ///
    /// 缺陷原形（BUG-051 / C3）：`upsert_media_item` 里是
    /// `file_path = COALESCE(excluded.file_path, media_item.file_path)`——
    /// 传 NULL 时**保留旧值**，于是「把字节清掉」这个语义根本无法表达，
    /// 清缓存后条目仍指向已删文件（悬空路径）。本函数不做 COALESCE：写什么就是什么。
    pub async fn set_item_file_path(
        &self,
        id: i64,
        file_path: Option<&str>,
    ) -> libsql::Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE media_item SET file_path = ?1 WHERE id = ?2",
                params![file_path, id],
            )
            .await?;
        Ok(n > 0)
    }

    /// 列出全部带本地字节的条目——清缓存的工作集（只动字节，不动事实）。
    pub async fn list_cached_items(&self) -> libsql::Result<Vec<CachedBytes>> {
        let mut rows = self
            .conn
            .query(
                "SELECT id, source, ref, file_path FROM media_item \
                 WHERE file_path IS NOT NULL",
                (),
            )
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(CachedBytes {
                id: r.get(0)?,
                source: r.get(1)?,
                ref_key: r.get(2)?,
                file_path: r.get(3)?,
            });
        }
        Ok(out)
    }

    /// 带标题的缓存工作集（清理预览明细的来源）。
    ///
    /// 与 [`Self::list_cached_items`] 同源同序，只多取 `title`：预览要给的是
    /// 「将释放 X、涉及这几条」，认不出条目就没法判断该不该删。
    pub async fn list_cached_items_detail(&self) -> libsql::Result<Vec<CachedBytesDetail>> {
        let mut rows = self
            .conn
            .query(
                "SELECT id, title, source, ref, file_path FROM media_item \
                 WHERE file_path IS NOT NULL ORDER BY id",
                (),
            )
            .await?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await? {
            out.push(CachedBytesDetail {
                id: r.get(0)?,
                title: r.get(1)?,
                source: r.get(2)?,
                ref_key: r.get(3)?,
                file_path: r.get(4)?,
            });
        }
        Ok(out)
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

    /// 局部更新：标题 / 介绍 / 封面 / 时长 / 尺寸（None = 不改）。
    ///
    /// 标题的空值语义与介绍**刻意不同**：介绍空 = 显式清空（可表达的意图），
    /// 而标题空 = **不可表达** —— 它的列是 NOT NULL，且是列表/卡片的主标识，
    /// 写成空串会让条目在一墙内容里变成一张认不出的卡。故空/纯空白标题一律视为
    /// 「不改」（保留旧值），而不是把旧值抹掉。调用方要拒绝时应在上层报 422，
    /// 不能指望这里静默兜住 —— 兜住的是数据，不是客户端的 bug。
    pub async fn update_media_item(&self, id: i64, patch: &ItemPatch) -> libsql::Result<bool> {
        let Some(existing) = self.get_media_item(id).await? else {
            return Ok(false);
        };
        let title = match patch.title.clone().filter(|t| !t.trim().is_empty()) {
            Some(v) => v,
            None => existing.title,
        };
        let description = match patch.description.clone() {
            Some(v) => v.filter(|s| !s.trim().is_empty()), // 显式 null / 空白 = 清空
            None => existing.description,
        };
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
                        width = ?4, height = ?5, kind = ?6, description = ?7 WHERE id = ?8",
                params![title, poster, duration, width, height, kind, description, id],
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

    // ---- 剧集（series / episodes） ----

    /// 剧集列表（含分集数、季数、标签）。
    pub async fn list_series(&self) -> libsql::Result<Vec<SeriesView>> {
        self.list_series_filtered(None).await
    }

    /// 列出剧集；`tag_id` 为 `Some` 时只返回带该标签的剧集。
    ///
    /// 过滤走**标量子查询**而非 `JOIN media_series_tag`：一部剧可有多个标签，
    /// JOIN 会按标签扇出重复行，把一部剧显示成多部。
    pub async fn list_series_filtered(&self, tag_id: Option<i64>) -> libsql::Result<Vec<SeriesView>> {
        let stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.title, s.description, s.kind, s.poster, s.year,
                        s.created_at, s.updated_at,
                        (SELECT COUNT(*) FROM media_episode e WHERE e.series_id = s.id),
                        (SELECT COUNT(DISTINCT e.season) FROM media_episode e WHERE e.series_id = s.id),
                        -- 封面条目：优先任一**图片集**（photo 文件即封面，免抽帧），回退首集。
                        COALESCE(
                          (SELECT e.item_id FROM media_episode e JOIN media_item i ON i.id = e.item_id
                            WHERE e.series_id = s.id AND i.kind = 'photo'
                            ORDER BY e.season, e.episode_no, e.id LIMIT 1),
                          (SELECT e.item_id FROM media_episode e WHERE e.series_id = s.id
                            ORDER BY e.season, e.episode_no, e.id LIMIT 1)),
                        (SELECT i.poster FROM media_episode e JOIN media_item i ON i.id = e.item_id
                          WHERE e.series_id = s.id AND i.poster IS NOT NULL
                          ORDER BY e.season, e.episode_no, e.id LIMIT 1),
                        -- cover_kind 与上面 COALESCE 选中的是同一条（同优先级结构）。
                        COALESCE(
                          (SELECT i.kind FROM media_episode e JOIN media_item i ON i.id = e.item_id
                            WHERE e.series_id = s.id AND i.kind = 'photo'
                            ORDER BY e.season, e.episode_no, e.id LIMIT 1),
                          (SELECT i.kind FROM media_episode e JOIN media_item i ON i.id = e.item_id
                            WHERE e.series_id = s.id
                            ORDER BY e.season, e.episode_no, e.id LIMIT 1))
                   FROM media_series s
                  WHERE (?1 IS NULL
                         OR s.id IN (SELECT series_id FROM media_series_tag WHERE tag_id = ?1))
                  ORDER BY s.updated_at DESC, s.id DESC",
            )
            .await?;
        let mut rows = stmt.query(params![tag_id]).await?;
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
                // 末列 `i.file_path IS NOT NULL` = `has_bytes`（BUG-080），不新增列：
                // 「有没有字节」就是 `file_path` 有没有值，再存一份布尔必会与之漂移。
                "SELECT e.id, e.item_id, e.season, e.episode_no,
                        i.title, i.poster, i.duration, i.kind, i.description,
                        e.origin_series_title, e.origin_episode_no, i.source, i.ref,
                        e.episode_no_end, i.file_path IS NOT NULL
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
                poster: r.get(5)?,
                duration: r.get(6)?,
                kind: r.get(7)?,
                description: r.get(8)?,
                origin_series_title: r.get(9)?,
                origin_episode_no: r.get(10)?,
                source: r.get(11)?,
                ref_key: r.get(12)?,
                episode_no_end: r.get(13)?,
                // SQLite 的 `IS NOT NULL` 是 0/1 整数，按整数读再转 bool —— 不对驱动做
                // 「INTEGER → bool」的隐式假设。
                has_bytes: r.get::<i64>(14).unwrap_or(0) != 0,
                sources: Vec::new(),
            });
        }
        // 备用来源（BUG-039）：一次查询补齐全部分集的来源列表（避免逐集 N+1）。
        let ids: Vec<i64> = episodes.iter().map(|e| e.id).collect();
        if !ids.is_empty() {
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT s.episode_id, s.item_id, i.title, i.kind
                   FROM media_episode_source s
                   LEFT JOIN media_item i ON i.id = s.item_id
                  WHERE s.episode_id IN ({placeholders})
                  ORDER BY s.created_at ASC, s.id ASC"
            );
            let stmt = self.conn.prepare(&sql).await?;
            let mut rows = stmt.query(ids).await?;
            let mut by_ep: std::collections::HashMap<i64, Vec<SourceRef>> =
                std::collections::HashMap::new();
            while let Some(r) = rows.next().await? {
                let ep_id: i64 = r.get(0)?;
                by_ep.entry(ep_id).or_default().push(SourceRef {
                    item_id: r.get(1)?,
                    title: r.get(2)?,
                    kind: r.get(3)?,
                });
            }
            for e in episodes.iter_mut() {
                if let Some(list) = by_ep.remove(&e.id) {
                    e.sources = list;
                }
            }
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
        // 名称空值 = 不可表达（同 `update_media_item`：NOT NULL + 主标识，空串会让
        // 剧集在墙上变成认不出的卡），空白一律按「不改」处理。
        let title = match patch.title.clone().filter(|t| !t.trim().is_empty()) {
            Some(v) => v,
            None => s.title,
        };
        // 介绍：Some(Some(x))=改成 x；Some(None)=显式清空；None=不改。
        let description = match &patch.description {
            Some(v) => v.clone(),
            None => s.description,
        };
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
    /// 剧集是否存在（合并前的存在性校验，避免「合并不存在的源」被当成成功）。
    pub async fn series_exists(&self, id: i64) -> libsql::Result<bool> {
        let stmt = self
            .conn
            .prepare("SELECT 1 FROM media_series WHERE id = ?1")
            .await?;
        let mut rows = stmt.query(params![id]).await?;
        Ok(rows.next().await?.is_some())
    }

    /// 合并剧集（BUG-037）：把 `source_id` 的**全部分集**搬到 `target_id` 末尾，再删除源剧集。
    ///
    /// ## 语义边界（刻意划死的）
    ///
    /// **只搬移与重编位置，不做任何内容判定。** 唯一允许的跳过依据是
    /// `item_id` 在目标**同季**已存在 —— 那是「同一条数据库记录」，属事实而非启发式。
    /// 以下情况**一律保留、绝不合并**，因为它们都可能是合法的独立观看项：
    ///
    /// - 文件名/标题相同但内容不同（分散保存时的常见情况）；
    /// - 同一内容从多个源进来（tg 缓存 + 本地导入 → 两条 item 记录）；
    /// - `1-2` 与 `1, 2` 并存（前者是并成单文件的版本，**重叠 ≠ 重复**）；
    /// - 每批都附带的预告。
    ///
    /// ## 集号
    ///
    /// 集号是**位置**而非身份：目标各季从现有 `MAX(episode_no)` 续编，源剧集的原始集号
    /// 写入 `origin_episode_no`、来源剧集标题写入 `origin_series_title`（快照，因为源剧集
    /// 会被删除）。这样重编后用户仍能分辨哪条是从哪儿并过来的。
    ///
    /// 全流程在 `BEGIN IMMEDIATE` 内；任何一步失败即 `ROLLBACK`，不留半成品。
    pub async fn merge_series(
        &self,
        target_id: i64,
        source_id: i64,
    ) -> libsql::Result<MergeReport> {
        // ── 读源分集（带条目标题：跳过明细要能让人认出是哪一条）──
        let stmt = self
            .conn
            .prepare(
                "SELECT e.item_id, e.season, e.episode_no, i.title
                   FROM media_episode e
                   LEFT JOIN media_item i ON i.id = e.item_id
                  WHERE e.series_id = ?1
                  ORDER BY e.season ASC, e.episode_no ASC, e.id ASC",
            )
            .await?;
        let mut rows = stmt.query(params![source_id]).await?;
        let mut src: Vec<(i64, i64, i64, Option<String>)> = Vec::new();
        while let Some(r) = rows.next().await? {
            src.push((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?));
        }
        drop(rows);

        // 源剧集标题快照（源稍后会被删，必须在事务里先取走）。
        let source_title: Option<String> = {
            let stmt = self
                .conn
                .prepare("SELECT title FROM media_series WHERE id = ?1")
                .await?;
            let mut rows = stmt.query(params![source_id]).await?;
            match rows.next().await? {
                Some(r) => Some(r.get(0)?),
                None => None,
            }
        };

        let mut report = MergeReport::default();
        self.conn.execute("BEGIN IMMEDIATE", ()).await?;

        let outcome: libsql::Result<()> = async {
            // 目标各季续编起点。
            let stmt = self
                .conn
                .prepare(
                    "SELECT season, COALESCE(MAX(episode_no), 0) FROM media_episode
                      WHERE series_id = ?1 GROUP BY season",
                )
                .await?;
            let mut rows = stmt.query(params![target_id]).await?;
            let mut next: HashMap<i64, i64> = HashMap::new();
            while let Some(r) = rows.next().await? {
                next.insert(r.get(0)?, r.get(1)?);
            }
            drop(rows);

            // 目标各季已有条目（去重**只**按 item_id）。
            let stmt = self
                .conn
                .prepare("SELECT season, item_id FROM media_episode WHERE series_id = ?1")
                .await?;
            let mut rows = stmt.query(params![target_id]).await?;
            let mut have: HashMap<i64, HashSet<i64>> = HashMap::new();
            while let Some(r) = rows.next().await? {
                have.entry(r.get(0)?).or_default().insert(r.get(1)?);
            }
            drop(rows);

            for (item_id, season, episode_no, item_title) in &src {
                if have.get(season).is_some_and(|s| s.contains(item_id)) {
                    report.skipped.push(MergeSkipped {
                        item_id: *item_id,
                        title: item_title.clone(),
                        season: *season,
                        episode_no: *episode_no,
                    });
                    continue;
                }
                let slot = next.entry(*season).or_insert(0);
                *slot += 1;
                // 刻意用纯 INSERT 而非 `add_episode`（后者带 ON CONFLICT DO UPDATE）：
                // 集号若算错，宁可撞唯一约束让整个事务回滚，也**绝不能静默覆盖**目标已有分集。
                self.conn
                    .execute(
                        "INSERT INTO media_episode
                           (series_id, item_id, season, episode_no,
                            origin_series_title, origin_episode_no)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            target_id,
                            *item_id,
                            *season,
                            *slot,
                            source_title.clone(),
                            *episode_no
                        ],
                    )
                    .await?;
                report.added += 1;
                have.entry(*season).or_default().insert(*item_id);
            }

            // 标签并集（目标原有标签一律保留）。
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO media_series_tag (series_id, tag_id)
                     SELECT ?1, tag_id FROM media_series_tag WHERE series_id = ?2",
                    params![target_id, source_id],
                )
                .await?;

            // 元数据**仅在目标缺失时继承**：不覆盖用户已设的介绍/年份/封面。
            self.conn
                .execute(
                    "UPDATE media_series SET
                       description = COALESCE(description, (SELECT description FROM media_series WHERE id = ?2)),
                       year        = COALESCE(year,        (SELECT year        FROM media_series WHERE id = ?2)),
                       poster      = COALESCE(poster,      (SELECT poster      FROM media_series WHERE id = ?2))
                     WHERE id = ?1",
                    params![target_id, source_id],
                )
                .await?;

            // 删源（分集已搬走、标签已并走）。
            self.conn
                .execute(
                    "DELETE FROM media_episode WHERE series_id = ?1",
                    params![source_id],
                )
                .await?;
            self.conn
                .execute(
                    "DELETE FROM media_series_tag WHERE series_id = ?1",
                    params![source_id],
                )
                .await?;
            self.conn
                .execute("DELETE FROM media_series WHERE id = ?1", params![source_id])
                .await?;

            self.conn
                .execute(
                    "UPDATE media_series SET updated_at = ?1 WHERE id = ?2",
                    params![now_secs(), target_id],
                )
                .await?;
            Ok(())
        }
        .await;

        match outcome {
            Ok(()) => {
                self.conn.execute("COMMIT", ()).await?;
                Ok(report)
            }
            Err(e) => {
                let _ = self.conn.execute("ROLLBACK", ()).await;
                Err(e)
            }
        }
    }

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
    ///
    /// 不收标题：分集的标题永远等于它指向条目的标题（见 [`EpisodeView::title`]）。
    pub async fn add_episode(
        &self,
        series_id: i64,
        item_id: i64,
        season: i64,
        episode_no: i64,
    ) -> libsql::Result<i64> {
        self.add_episode_ranged(series_id, item_id, season, episode_no, None)
            .await
    }

    /// 同 `add_episode`，但支持合集范围（BUG-039）：`episode_no_end` 记录该条目
    /// 占用槽位的终点（如 1-2 集合集：no=1, end=2）。NULL = 单集。
    pub async fn add_episode_ranged(
        &self,
        series_id: i64,
        item_id: i64,
        season: i64,
        episode_no: i64,
        episode_no_end: Option<i64>,
    ) -> libsql::Result<i64> {
        let end = episode_no_end.filter(|e| *e > episode_no);
        self.conn
            .execute(
                "INSERT INTO media_episode (series_id, item_id, season, episode_no, episode_no_end)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(series_id, season, episode_no) DO UPDATE SET
                   item_id = excluded.item_id, episode_no_end = excluded.episode_no_end",
                params![series_id, item_id, season, episode_no, end],
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
        let items: Vec<(i64, Option<(i64, i64)>)> =
            item_ids.iter().map(|id| (*id, None)).collect();
        self.append_episodes_ranged(series_id, season, &items).await
    }

    /// 带范围的批量追加（BUG-039）：每个条目可声明占用区间 `(item_id, Some(end))`，
    /// 未声明视为单集。槽位分配规则：
    ///   - 已声明区间的条目：区间不与任何已占/本轮已分配区间重叠 → 落在声明位；
    ///     否则回退到「最大终点之后」的下一个空闲位（只占用其声明宽度）。
    ///   - 未声明条目：依次排到最大终点之后。
    /// `COALESCE(episode_no_end, episode_no)` 让合集的终点参与「下一个可用位」计算，
    /// 避免 1-2 集合集之后把下一集编成 2（与合集第二集撞位）。
    pub async fn append_episodes_ranged(
        &self,
        series_id: i64,
        season: i64,
        items: &[(i64, Option<(i64, i64)>)],
    ) -> libsql::Result<i64> {
        // 占用快照：已占槽位的每一个号（含合集展开的中间号），声明区间的
        // 落位判定与「下一个可用位」都以它为准。
        let stmt = self
            .conn
            .prepare(
                "SELECT episode_no, COALESCE(episode_no_end, episode_no) FROM media_episode
                  WHERE series_id = ?1 AND season = ?2",
            )
            .await?;
        let mut rows = stmt.query(params![series_id, season]).await?;
        let mut occupied: HashSet<i64> = HashSet::new();
        let mut next: i64 = 0;
        while let Some(r) = rows.next().await? {
            let no: i64 = r.get(0)?;
            let end: i64 = r.get(1)?;
            for n in no..=end {
                occupied.insert(n);
            }
            next = next.max(end);
        }
        // 幂等（BUG-031）：同一**季**内跳过已收录条目 —— 重复缓存/重复入队不会把同一条目
        // 编成两集（此前会重复 add_episode，剧集里出现重复分集）。
        //
        // 去重粒度刻意与 `UNIQUE(series_id, season, episode_no)` 对齐（剧集 × 季），
        // 而不是整个剧集：条目「位置」的唯一性本来就按季定义，同一素材被用户显式放进
        // 另一季（如 S1 正片 + S2 回顾）是合法编排，不该被全局去重吞掉。
        let have = self.season_item_ids(series_id, season).await?;
        let mut added = 0;
        for (id, range) in items {
            if have.contains(id) {
                continue;
            }
            // 声明区间完整空闲才落声明位；否则回退到最大终点之后的下一空闲带
            // （保留声明宽度，合集不会被打成单集）。
            let (no, end_no) = match range {
                Some((s, e)) if s <= e && !((*s..=*e).any(|n| occupied.contains(&n))) => (*s, Some(*e)),
                Some((s, e)) if s <= e => {
                    let start = next + 1;
                    (start, Some(start + (e - s)))
                }
                _ => (next + 1, None),
            };
            self.add_episode_ranged(series_id, *id, season, no, end_no)
                .await?;
            for n in no..=end_no.unwrap_or(no) {
                occupied.insert(n);
            }
            next = next.max(end_no.unwrap_or(no));
            added += 1;
        }
        Ok(added)
    }

    /// 把条目挂为某集的**备用来源**（BUG-039 冲突1：同一集有多个缓存来源）。
    /// 槽位语义 = 位置，主条目只有一个；多出来的来源挂备用，不挤占位置。
    /// 幂等：已是备用源或已是主条目则不动。返回是否新挂。
    pub async fn attach_episode_source(&self, episode_id: i64, item_id: i64) -> libsql::Result<bool> {
        let primary: Option<i64> = self
            .row_opt(
                "SELECT item_id FROM media_episode WHERE id = ?1",
                params![episode_id],
            )
            .await?
            .map(|r| r.get::<i64>(0))
            .transpose()?;
        if primary == Some(item_id) {
            return Ok(false);
        }
        let changed = self
            .conn
            .execute(
                "INSERT INTO media_episode_source (episode_id, item_id, created_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(episode_id, item_id) DO NOTHING",
                params![episode_id, item_id, now_secs()],
            )
            .await?;
        Ok(changed > 0)
    }

    /// 主备切换：`item_id` 必须已是该集的备用源；原主条目降级为备用源。
    pub async fn switch_episode_source(&self, episode_id: i64, item_id: i64) -> libsql::Result<()> {        let primary: i64 = match self
            .row_opt(
                "SELECT item_id FROM media_episode WHERE id = ?1",
                params![episode_id],
            )
            .await?
        {
            Some(r) => r.get(0)?,
            None => return Err(libsql::Error::QueryReturnedNoRows),
        };
        if primary == item_id {
            return Ok(());
        }
        // 事务语义：删备用行 + 主条目转备用 + 主位换新 —— 三步同一事务，
        // 中途失败不能出现「两个主」或「主条目既不在主位也不在备用」。
        self.conn
            .execute("BEGIN IMMEDIATE", ())
            .await?;
        let res = async {
            self.conn
                .execute(
                    "DELETE FROM media_episode_source WHERE episode_id = ?1 AND item_id = ?2",
                    params![episode_id, item_id],
                )
                .await?;
            self.conn
                .execute(
                    "INSERT INTO media_episode_source (episode_id, item_id, created_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(episode_id, item_id) DO NOTHING",
                    params![episode_id, primary, now_secs()],
                )
                .await?;
            self.conn
                .execute(
                    "UPDATE media_episode SET item_id = ?2 WHERE id = ?1",
                    params![episode_id, item_id],
                )
                .await?;
            Ok::<(), libsql::Error>(())
        }
        .await;
        match res {
            Ok(()) => self.conn.execute("COMMIT", ()).await.map(|_| ()).map_err(|e| {
                let _ = self.conn.execute("ROLLBACK", ());
                e
            }),
            Err(e) => {
                let _ = self.conn.execute("ROLLBACK", ());
                Err(e)
            }
        }
    }

    /// 摘除备用源（只删关联行；条目本身保留在资料库，可再次挂到别集或当散片）。
    pub async fn detach_episode_source(&self, episode_id: i64, item_id: i64) -> libsql::Result<()> {
        self.conn
            .execute(
                "DELETE FROM media_episode_source WHERE episode_id = ?1 AND item_id = ?2",
                params![episode_id, item_id],
            )
            .await?;
        Ok(())
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

    /// 一批条目的 kind 集合（历史接口：诊断/统计用）。
    pub async fn kinds_of_items(&self, item_ids: &[i64]) -> libsql::Result<HashSet<String>> {
        let map = self.item_kinds(item_ids).await?;
        Ok(map.into_values().collect())
    }

    /// 一批条目的 `(id → kind)` 映射（BUG-044：成剧/编集前据此过滤非视频，
    /// 请求体里混入的图片在入口就被剔除，不靠触发器硬报错）。
    /// 不存在的条目不进映射 —— 调用方应把「查不到 kind」与「非视频」同等对待。
    pub async fn item_kinds(&self, item_ids: &[i64]) -> libsql::Result<HashMap<i64, String>> {
        let mut out = HashMap::new();
        for id in item_ids {
            let stmt = self
                .conn
                .prepare("SELECT kind FROM media_item WHERE id = ?1")
                .await?;
            let mut rows = stmt.query(params![*id]).await?;
            if let Some(r) = rows.next().await? {
                out.insert(*id, r.get::<String>(0)?);
            }
        }
        Ok(out)
    }

    /// 分集编辑：文本字段 + **槽位**（season / episode_no）。`None` = 不改该字段。
    ///
    /// 槽位语义（BUG-037「集号是位置而非身份」的延伸）：
    ///   - 集号**允许任意值**（2、3…不必从 1 连续）——用户手工编排的号不该被抹平；
    ///   - 目标槽被同剧另一条占用时 **对调**两者槽位，而不是报冲突或丢弃：
    ///     这正是「把第 3 集改成第 2 集」时用户的直觉结果（两条换个位置）。
    pub async fn update_episode(
        &self,
        episode_id: i64,
        edit: &EpisodeEdit,
    ) -> libsql::Result<bool> {
        self.conn.execute("BEGIN IMMEDIATE", ()).await?;
        let outcome: libsql::Result<bool> = async {
            let cur = self
                .row_opt(
                    "SELECT series_id, season, episode_no, item_id, episode_no_end
                       FROM media_episode WHERE id = ?1",
                    params![episode_id],
                )
                .await?;
            let Some(r) = cur else {
                return Ok(false);
            };
            let series_id: i64 = r.get(0)?;
            let cur_season: i64 = r.get(1)?;
            let cur_no: i64 = r.get(2)?;
            let item_id: i64 = r.get(3)?;
            let cur_end: Option<i64> = r.get(4)?;

            // 标题/介绍**写穿到条目** —— 分集行不持有内容文案的第二份副本。
            // 「分集改名」与「条目改名」从此是同一件事：改哪边都是改内容，
            // 于是剧集页、媒体库、播放页永远看到同一个名字与同一段介绍。
            // 空标题与空介绍沿用在条目上的语义：标题空 = 不改，介绍空 = 显式清空。
            let (cur_item_title, cur_item_desc): (Option<String>, Option<String>) = {
                let row = self
                    .row_opt(
                        "SELECT title, description FROM media_item WHERE id = ?1",
                        params![item_id],
                    )
                    .await?;
                match row {
                    Some(r) => (r.get(0)?, r.get(1)?),
                    // 条目已不存在（分集是悬空引用）：不写，也不报错 —— 槽位操作本身仍应成功。
                    None => (None, None),
                }
            };
            if let Some(cur_item_title) = cur_item_title {
                let next_title = match edit.title.clone().filter(|t| !t.trim().is_empty()) {
                    Some(v) => v,
                    None => cur_item_title,
                };
                // 介绍：Some(Some(x))=改成 x；Some(None)=显式清空；None=不改。
                // （match 引用再 clone：`edit` 后面的槽位逻辑还要用，不能整体被 move。）
                let next_desc = match &edit.description {
                    Some(v) => v.clone().filter(|s| !s.trim().is_empty()),
                    None => cur_item_desc,
                };
                self.conn
                    .execute(
                        "UPDATE media_item SET title = ?1, description = ?2 WHERE id = ?3",
                        params![next_title, next_desc, item_id],
                    )
                    .await?;
            }

            // 合集终点：Some(Some(n))=改为 n（必须 > 起点才合法，否则退回单集）；
            // Some(None)=改回单集；None=不改。终点随起点换位 —— 槽位身份是起点，
            // 但区间的**宽度**是这条内容的属性，换位时必须带走。
            let new_no = edit.episode_no.unwrap_or(cur_no);
            let end = match edit.episode_no_end {
                Some(Some(n)) if n > new_no => Some(n),
                Some(_) => None,
                None => cur_end.map(|e| e - cur_no + new_no).filter(|e| *e > new_no),
            };
            self.conn
                .execute(
                    "UPDATE media_episode SET episode_no_end = ?1 WHERE id = ?2",
                    params![end, episode_id],
                )
                .await?;

            let to = (
                edit.season.unwrap_or(cur_season),
                edit.episode_no.unwrap_or(cur_no),
            );
            self.place_episode_in_slot(series_id, episode_id, (cur_season, cur_no), to)
                .await?;
            Ok(true)
        }
        .await;

        match outcome {
            Ok(v) => {
                self.conn.execute("COMMIT", ()).await?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute("ROLLBACK", ()).await;
                Err(e)
            }
        }
    }

    /// 剧集内换位（`up` = 与同季上一集换位，`false` = 与下一集换位）。
    ///
    /// **只换两条、不重排全季**：集号允许不连续，重排成 1..N 会把用户改过的号
    /// （例如 2、3）无声抹平。返回 `Ok(false)` = 已在边界（没有相邻分集），
    /// 由调用方决定是否提示，而不是静默成功。
    pub async fn move_episode(&self, episode_id: i64, up: bool) -> libsql::Result<bool> {
        self.conn.execute("BEGIN IMMEDIATE", ()).await?;
        let outcome: libsql::Result<bool> = async {
            let cur = self
                .row_opt(
                    "SELECT series_id, season, episode_no FROM media_episode WHERE id = ?1",
                    params![episode_id],
                )
                .await?;
            let Some(r) = cur else {
                return Ok(false);
            };
            let series_id: i64 = r.get(0)?;
            let season: i64 = r.get(1)?;
            let no: i64 = r.get(2)?;

            // 相邻分集：同季内按集号取最近的一侧（(series, season, episode_no) 唯一，无需再 tie-break）
            let sql = if up {
                "SELECT episode_no FROM media_episode
                  WHERE series_id = ?1 AND season = ?2 AND episode_no < ?3
                  ORDER BY episode_no DESC LIMIT 1"
            } else {
                "SELECT episode_no FROM media_episode
                  WHERE series_id = ?1 AND season = ?2 AND episode_no > ?3
                  ORDER BY episode_no ASC LIMIT 1"
            };
            let nb = self.row_opt(sql, params![series_id, season, no]).await?;
            let Some(nr) = nb else {
                return Ok(false); // 边界：没有可换的邻居
            };
            let nb_no: i64 = nr.get(0)?;

            self.place_episode_in_slot(series_id, episode_id, (season, no), (season, nb_no))
                .await
        }
        .await;

        match outcome {
            Ok(v) => {
                self.conn.execute("COMMIT", ()).await?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute("ROLLBACK", ()).await;
                Err(e)
            }
        }
    }

    /// 把一条分集放到指定槽位；目标槽若被同剧另一条占用则**对调**两者槽位。
    /// 调用方必须已处于事务内。
    ///
    /// 为什么需要「哨兵」：`UNIQUE(series_id, season, episode_no)` 是**立即**约束，
    /// 两条 UPDATE 必然在中途撞车（第一条写下去时第二条还占着目标槽）。
    /// 故先把本条挪到一个空闲集号（`MIN(episode_no) - 1`，在任何季都空闲）让出槽位，
    /// 再让占用者落到本条的**原槽**，最后本条落到目标槽 —— 三步都不触碰被占用的槽。
    async fn place_episode_in_slot(
        &self,
        series_id: i64,
        episode_id: i64,
        from: (i64, i64),
        to: (i64, i64),
    ) -> libsql::Result<bool> {
        if from == to {
            return Ok(false);
        }
        let occupant = self
            .row_opt(
                "SELECT id FROM media_episode
                  WHERE series_id = ?1 AND season = ?2 AND episode_no = ?3 AND id <> ?4",
                params![series_id, to.0, to.1, episode_id],
            )
            .await?;
        match occupant {
            Some(o) => {
                let other_id: i64 = o.get(0)?;
                let sentinel: i64 = self
                    .count_one(
                        "SELECT COALESCE(MIN(episode_no), 1) - 1 FROM media_episode WHERE series_id = ?1",
                        params![series_id],
                    )
                    .await?;
                // ① 本条让出原槽
                self.conn
                    .execute(
                        "UPDATE media_episode SET episode_no = ?1 WHERE id = ?2",
                        params![sentinel, episode_id],
                    )
                    .await?;
                // ② 占用者搬到本条的原槽
                self.conn
                    .execute(
                        "UPDATE media_episode SET season = ?1, episode_no = ?2 WHERE id = ?3",
                        params![from.0, from.1, other_id],
                    )
                    .await?;
                // ③ 本条落到目标槽
                self.conn
                    .execute(
                        "UPDATE media_episode SET season = ?1, episode_no = ?2 WHERE id = ?3",
                        params![to.0, to.1, episode_id],
                    )
                    .await?;
            }
            None => {
                self.conn
                    .execute(
                        "UPDATE media_episode SET season = ?1, episode_no = ?2 WHERE id = ?3",
                        params![to.0, to.1, episode_id],
                    )
                    .await?;
            }
        }
        Ok(true)
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

    /// 从一批 TG 消息的 caption 中收集 `#标签`（按消息顺序、跨消息去重）。
    ///
    /// 读的是 `media_message.caption`（**真实 caption**），而不是 `media_item.title`
    /// —— 后者在 caption 为空时退化为落盘文件名，会让文件名里的 `#` 混成标签。
    /// `max` 为当次收集上限，防止个别刷屏消息带来成百上千标签。
    pub async fn collect_hash_tags(
        &self,
        chat_id: i64,
        message_ids: &[i64],
        max: usize,
    ) -> libsql::Result<Vec<String>> {
        let mut out: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for mid in message_ids {
            if out.len() >= max {
                break;
            }
            let row = self
                .row_opt(
                    "SELECT caption FROM media_message WHERE channel_id = ?1 AND message_id = ?2",
                    params![chat_id, *mid],
                )
                .await?;
            let Some(r) = row else { continue };
            let caption: Option<String> = r.get(0)?;
            let Some(caption) = caption else { continue };
            for t in extract_hash_tags(&caption) {
                if out.len() >= max {
                    break;
                }
                if seen.insert(t.to_lowercase()) {
                    out.push(t);
                }
            }
        }
        Ok(out)
    }

    /// 取本批消息里**第一条非空 caption**（按入队顺序）。
    ///
    /// 成剧时用它切出剧集标题与介绍（此前剧集名直接取频道名，真实标题从未被使用）。
    pub async fn first_caption(
        &self,
        chat_id: i64,
        message_ids: &[i64],
    ) -> libsql::Result<Option<String>> {
        for mid in message_ids {
            let row = self
                .row_opt(
                    "SELECT caption FROM media_message WHERE channel_id = ?1 AND message_id = ?2",
                    params![chat_id, *mid],
                )
                .await?;
            let Some(r) = row else { continue };
            let caption: Option<String> = r.get(0)?;
            if let Some(c) = caption.filter(|c| !c.trim().is_empty()) {
                return Ok(Some(c));
            }
        }
        Ok(None)
    }

    /// 把一批**标签名**并集式归档到剧集（不存在的标签自动创建）。
    ///
    /// 语义是 **union（自动合并）而非替换**：这是「多集/多部剧集标签自动合并去重」
    /// 的关键 —— 后续追加集数时，新集的标签并入旧集已归档的标签，既不清空用户手工
    /// 设过的标签，也不会产生重复关联（`media_series_tag` 主键 + `INSERT OR IGNORE`）。
    /// 返回**本次新增**的关联数（已存在的关联不计数），供日志如实回报。
    pub async fn add_series_tags_by_name(
        &self,
        series_id: i64,
        names: &[String],
    ) -> libsql::Result<usize> {
        let mut added = 0usize;
        for name in names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let tag_id = self.create_tag(name, None).await?;
            if tag_id == 0 {
                continue;
            }
            let n = self
                .conn
                .execute(
                    "INSERT OR IGNORE INTO media_series_tag (series_id, tag_id) VALUES (?1, ?2)",
                    params![series_id, tag_id],
                )
                .await?;
            added += n as usize;
        }
        Ok(added)
    }

    /// 把一批**标签名**并集式归档到内容条目（不存在的标签自动创建）。
    ///
    /// 语义与 `add_series_tags_by_name` 完全一致（union 不替换、主键 + IGNORE 去重），
    /// 但目标是 `media_item_tag` —— TG 单条缓存/纯图片组没有剧集可挂，
    /// caption 的 `#标签` 落到**内容**本身（BUG-045：标签收集与成剧解耦）。
    pub async fn add_item_tags_by_name(
        &self,
        item_id: i64,
        names: &[String],
    ) -> libsql::Result<usize> {
        let mut added = 0usize;
        for name in names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let tag_id = self.create_tag(name, None).await?;
            if tag_id == 0 {
                continue;
            }
            let n = self
                .conn
                .execute(
                    "INSERT OR IGNORE INTO media_item_tag (item_id, tag_id) VALUES (?1, ?2)",
                    params![item_id, tag_id],
                )
                .await?;
            added += n as usize;
        }
        Ok(added)
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
    /// 介绍：缺省=不改；`null`=**显式清空**（与剧集介绍同一契约 ——
    /// 介绍必须可清，否则设过一次就永远删不掉）。
    #[serde(default, deserialize_with = "nullable")]
    pub description: Option<Option<String>>,
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
    /// 介绍：缺省=不改；`null`=**显式清空**（介绍必须可清，否则设过就永远删不掉）。
    #[serde(default, deserialize_with = "nullable")]
    pub description: Option<Option<String>>,
    pub kind: Option<String>,
    /// 封面：缺省=不改；`null`=清空（回退到自动推导的首集封面）。
    #[serde(default, deserialize_with = "nullable")]
    pub poster: Option<Option<String>>,
    pub year: Option<i64>,
}

/// 分集局部更新入参：文本字段 + 槽位（season / episode_no）。`None` = 不改该字段。
///
/// 槽位刻意用 `Option<i64>` 而**不是** `Option<Option<i64>>`：这两列是 NOT NULL，
/// 不存在「清空」语义，只有「不改」与「改成某值」两态（与 poster 那种可空封面不同）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeEdit {
    /// 内容标题：缺省或纯空白 = 不改（与条目 PATCH 同一语义 —— 空标题不可表达）。
    /// 有值时**写穿到条目**，分集行不留副本。
    pub title: Option<String>,
    /// 介绍：缺省=不改；`null`/空白=**显式清空**（与剧集介绍同一契约），同样写穿到条目。
    #[serde(default, deserialize_with = "nullable")]
    pub description: Option<Option<String>>,
    pub season: Option<i64>,
    pub episode_no: Option<i64>,
    /// 合集范围终点：缺省=不改；`null`=改回单集；数字=改为该终点（必须 > episode_no）。
    #[serde(default, deserialize_with = "nullable")]
    pub episode_no_end: Option<Option<i64>>,
}

/// 分集换位方向（`POST /api/media/episodes/:id/move`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeMove {
    /// `"up"` = 与同季上一集换位；其余值一律按下移处理（前端只发这两个值）。
    pub dir: String,
}

/// 从 caption 解析**集号区间**（BUG-039 冲突2：一个文件含多集的合集视频）。
///
/// 返回 `Some((start, Some(end)))` = 合集区间；`Some((n, None))` = 单集；None = 无集号信号。
/// 识别形态（大小写/全半角不敏感，仅扫第一行——TG caption 的标题行在首行）：
///   - `EP01-02` / `ep1-2` / `EP 03~04`
///   - `第01-02集` / `第1~2集` / `第 3-4 集`
///   - `01-02集合集` / `1-2集`
///   - 单集：`EP07` / `第5集` / `#12`
/// 只在**整段命中**才算集号（如 `1990-2020` 年份区间不满足 ≤ 宽度约束会被拒）：
/// 区间宽度 ≤ 99 且 start ≥ 1，end > start 才是合集；`10-20` 之类歧义交给
/// 占用检测兜底（落位时若与已占区间冲突会自动回退，不会覆盖既有编排）。
/// 把 TG 的 caption 切成「**标题** + **介绍**」。
///
/// TG 频道的书写惯例就是首行标题、其后正文，此前却把整段 caption 塞进 `title`
/// （标题与介绍混在一起），剧集名更是直接取**频道名**（同频道多部剧集同名、
/// caption 里的真实标题从未被使用）。
///
/// 规则（内容无关，纯结构）：
/// - 首行 = 标题；其余非空行合并 = 介绍（`\n` 连接，保留内部换行）；
/// - 标题行的**行尾 `#标签` 不入标题**——标签有独立通道与展示位，重复占位是脏数据；
/// - 首行为空或剥完标签为空 ⇒ 没有标题（回退由调用方决定），整段退化为介绍；
/// - 标题过长截断到 [`MAX_TITLE_CHARS`]，避免一整段长文顶在标题上。
pub fn split_caption(caption: &str) -> (Option<String>, Option<String>) {
    const MAX_TITLE_CHARS: usize = 120;

    let mut lines = caption.lines();
    let first = lines.next().unwrap_or("").trim();
    let body = lines
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let body = (!body.is_empty()).then_some(body);

    let title = {
        let mut toks: Vec<&str> = first.split_whitespace().collect();
        while let Some(last) = toks.last() {
            if last.starts_with('#') {
                toks.pop();
            } else {
                break;
            }
        }
        toks.join(" ")
    };
    if title.is_empty() {
        return (None, body);
    }
    let title = title.chars().take(MAX_TITLE_CHARS).collect::<String>();
    (Some(title), body)
}

/// 从一条 caption 解析集号 —— 见 routes.rs worker 的对位解析。
pub fn parse_episode_range(caption: &str) -> Option<(i64, Option<i64>)> {
    let first_line = caption.lines().next().unwrap_or("");
    let t = first_line.trim();
    if t.is_empty() {
        return None;
    }
    let is_digit = |c: char| c.is_ascii_digit();
    // 提取字符串里 first..last 的连续数字段
    let nums = |s: &str| -> Vec<i64> {
        let mut out = Vec::new();
        let mut cur = String::new();
        for c in s.chars() {
            if is_digit(c) {
                cur.push(c);
            } else if !cur.is_empty() {
                out.push(cur.parse().unwrap_or(i64::MAX));
                cur.clear();
            }
        }
        if !cur.is_empty() {
            out.push(cur.parse().unwrap_or(i64::MAX));
        }
        out
    };
    let lower = t.to_lowercase();

    // 形态 A：`ep` 前缀（EP01-02 / ep07）
    if let Some(idx) = lower.find("ep") {
        let after = &lower[idx + 2..];
        let head_ok = idx == 0 || !is_digit(lower.chars().nth(idx - 1).unwrap_or(' '));
        let tail = after.chars().next().map(is_digit).unwrap_or(false);
        if head_ok && tail {
            let ns = nums(after);
            if ns.len() == 2 && ns[0] >= 1 && ns[1] > ns[0] && ns[1] - ns[0] <= 99 {
                return Some((ns[0], Some(ns[1])));
            }
            if ns.len() == 1 && ns[0] >= 1 {
                return Some((ns[0], None));
            }
        }
    }
    // 形态 B：`第X(-|~|到)Y集` / `第X集`
    if let Some(b) = t.find('第') {
        let after = &t[b + '第'.len_utf8()..];
        let end_ji = after.find('集');
        if let Some(ji) = end_ji {
            let seg = &after[..ji];
            let ns = nums(seg);
            if ns.len() == 2 && ns[0] >= 1 && ns[1] > ns[0] && ns[1] - ns[0] <= 99 {
                return Some((ns[0], Some(ns[1])));
            }
            if ns.len() == 1 && ns[0] >= 1 {
                return Some((ns[0], None));
            }
        }
    }
    // 形态 C：`NN-MM集合集` / `NN-MM集`（行首数字段 + 连接符 + 集）
    for sep in ['-', '~', '～', '—'] {
        if let Some(dash) = t.find(sep) {
            let before = &t[..dash];
            let after = &t[dash + sep.len_utf8()..];
            let tail_num: String = after.chars().take_while(|c| is_digit(*c)).collect();
            let head_num: String = before
                .chars()
                .rev()
                .take_while(|c| is_digit(*c))
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            let after_tail = &after[tail_num.len()..];
            if !head_num.is_empty() && !tail_num.is_empty() {
                let rest_ok = after_tail.starts_with("集合集")
                    || after_tail.starts_with("集")
                    || after_tail.starts_with("合集");
                let s: i64 = head_num.parse().unwrap_or(0);
                let e: i64 = tail_num.parse().unwrap_or(0);
                if rest_ok && s >= 1 && e > s && e - s <= 99 {
                    return Some((s, Some(e)));
                }
            }
        }
    }
    // 形态 D：`#12`（行内孤立的 # 数字）
    if let Some(h) = t.find('#') {
        let after = &t[h + 1..];
        let ds: String = after.chars().take_while(|c| is_digit(*c)).collect();
        if !ds.is_empty() {
            let n: i64 = ds.parse().unwrap_or(0);
            if n >= 1 {
                return Some((n, None));
            }
        }
    }
    None
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

/// 从 caption 文本中提取 `#标签`（通用 `#` 模式）。
///
/// 规则：
///   - `#` 必须是**词首**（行首，或前一字符非字母数字/下划线/`#`），
///     避免把 URL 片段（`http://x/a#b`）、`C#` 之类误判为标签；
///   - 标签体按 **Unicode** 字母数字判定，故 `#短剧` 与 `#abc` 同样成立（中文不生搬 ASCII 判定）；
///   - 允许词内下划线/连字符/点/间隔号（`#new_ep`、`#a-b`），但**剥掉结尾**这些字符
///     （`#tag.` / `#tag-` 是句子标点，不是标签的一部分）；
///   - **括号型标签**：`#《剧名》`、`#（剧名）`、`#(name)`、`#[name]` 取括号内文本为标签。
///     这是**超出 Telegram 链接器**的扩展：TG 只把 `#` 后紧跟字母数字/下划线视作标签，
///     `#《…》` 在 TG 里不成链接，但中文频道普遍这样标注剧名（实测 caption 里
///     `#《异世界男妓-瓦尔哈拉神枪馆》 EP-2` 是常见写法）。不扩展则这类标题**一个都提取不到**。
///     必须成对闭合才认（只有开括号则退回下面的裸标签规则），且不跨行；
///   - 按**大小写不敏感**去重，保留首次出现的写法（`#Action` 与 `#action` 视为同标签）；
///   - 单标签超过 32 字符直接丢弃（超长串多为噪声而非标签）。
pub fn extract_hash_tags(caption: &str) -> Vec<String> {
    const MAX_TAG_CHARS: usize = 32;
    /// 成对括号（开, 闭）——仅这些才触发括号型标签。
    const PAIRS: [(char, char); 4] = [('《', '》'), ('（', '）'), ('(', ')'), ('[', ']')];
    /// 允许出现在裸标签内部、但不算标签结尾的字符。
    const INNER: &str = "-._·";

    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut prev: Option<char> = None;
    let mut it = caption.chars().peekable();
    while let Some(c) = it.next() {
        if c != '#' {
            prev = Some(c);
            continue;
        }
        // 词首判定：闭合括号**不**阻断（`#《A》#B` 里第二个 `#` 应成标签）。
        let at_word_start = match prev {
            None => true,
            Some(p) => !(p.is_alphanumeric() || p == '_' || p == '#'),
        };
        if !at_word_start {
            prev = Some(c);
            continue;
        }

        let mut body = String::new();
        let mut last = c;

        // ① 括号型：先在**副本**上试探，只有成对闭合才真正消费游标，
        //    否则（只有开括号）不吞掉后续正文，退回裸标签规则。
        let mut trial = it.clone();
        let mut bracket_hit = false;
        if let Some(open) = trial.next() {
            if let Some((_, close)) = PAIRS.iter().find(|(o, _)| *o == open) {
                let mut inner = String::new();
                let mut closed = false;
                for n in trial.by_ref() {
                    if n == *close {
                        closed = true;
                        break;
                    }
                    if n == '\n' {
                        break;
                    }
                    inner.push(n);
                }
                if closed {
                    it = trial;
                    body = inner;
                    last = *close;
                    bracket_hit = true;
                }
            }
        }

        // ② 裸标签：Unicode 字母数字 + 下划线 + 内部连字符/点/间隔号
        if !bracket_hit {
            while let Some(&n) = it.peek() {
                if n.is_alphanumeric() || n == '_' || INNER.contains(n) {
                    body.push(n);
                    it.next();
                } else {
                    break;
                }
            }
            while body.ends_with(|ch: char| INNER.contains(ch)) {
                body.pop();
            }
            // 标签体末字符即下一个词的边界依据（`#tag#other` 的第二个 `#` 不算词首），
            // 故在 `body` 被 move 进 out 之前先取出来。
            if let Some(l) = body.chars().last() {
                last = l;
            }
        }

        let body = body.trim().to_string();
        let body = body.trim().to_string();
        if !body.is_empty() && body.chars().count() <= MAX_TAG_CHARS {
            if seen.insert(body.to_lowercase()) {
                out.push(body);
            }
        }
        prev = Some(last);
    }
    out
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
            .upsert_media_item("local", "D:/x/a.mp4", "a", "video", Some("D:/x/a.mp4"), None, None, None)
            .await
            .unwrap();
        let b = s
            .upsert_media_item("local", "D:/x/b.mp4", "b", "video", Some("D:/x/b.mp4"), None, None, None)
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

    /// ③b：#标签提取。判定必须是**词首 + Unicode 字母数字**，
    /// 否则 URL 片段 / `C#` 会被误当标签，而中文标签会被漏掉。
    #[test]
    fn extract_hash_tags_handles_cjk_and_rejects_non_tags() {
        // 正常：中英混合、多标签
        assert_eq!(
            extract_hash_tags("第3集 #短剧 #Action 更新了"),
            vec!["短剧".to_string(), "Action".to_string()]
        );
        // 大小写不敏感去重，保留首次写法
        assert_eq!(
            extract_hash_tags("#Action #action #ACTION"),
            vec!["Action".to_string()]
        );
        // 下划线允许
        assert_eq!(extract_hash_tags("#new_ep"), vec!["new_ep".to_string()]);
        // 结尾标点不吃进标签
        assert_eq!(
            extract_hash_tags("看这个 #推荐, 还有 #剧集。"),
            vec!["推荐".to_string(), "剧集".to_string()]
        );
        // 非词首的 `#` 不算标签：URL fragment / C# / 连续井号
        assert_eq!(extract_hash_tags("http://x/a#b"), Vec::<String>::new());
        assert_eq!(extract_hash_tags("C# 与 F#"), Vec::<String>::new());
        assert_eq!(extract_hash_tags("##"), Vec::<String>::new());
        // 裸 `#` 与空串
        assert_eq!(extract_hash_tags("# 只有井号"), Vec::<String>::new());
        assert_eq!(extract_hash_tags(""), Vec::<String>::new());
        // 超长（>32）丢弃
        let long = format!("#{}", "a".repeat(40));
        assert_eq!(extract_hash_tags(&long), Vec::<String>::new());
        // 行首（前面无字符）也算词首
        assert_eq!(extract_hash_tags("#开播"), vec!["开播".to_string()]);
        // 词内连字符/点保留，但结尾的被剥掉
        assert_eq!(
            extract_hash_tags("#异世界-瓦尔哈拉 与 #tag."),
            vec!["异世界-瓦尔哈拉".to_string(), "tag".to_string()]
        );
    }

    /// ③b：**括号型标签**（超出 TG 链接器的扩展）。
    ///
    /// 实测中文频道的真实 caption 形如
    /// `😀 #《异世界男妓-瓦尔哈拉神枪馆》 EP-2 … 关键词：#西瓜短剧 #AI短剧`，
    /// 若只认 TG 的 `#字母数字` 规则，剧名标签**一个都提不到**。
    #[test]
    fn extract_hash_tags_supports_bracketed_names() {
        // 实测原样式：书名号剧名 + 无空格连写的多个标签
        let real = "😀😀 #《异世界男妓-瓦尔哈拉神枪馆》 EP-2\n关键词：#西瓜短剧 #AI短剧 #熟女档案";
        assert_eq!(
            extract_hash_tags(real),
            vec![
                "异世界男妓-瓦尔哈拉神枪馆".to_string(),
                "西瓜短剧".to_string(),
                "AI短剧".to_string(),
                "熟女档案".to_string(),
            ]
        );
        // 相邻括号型标签（无空格连写）也要各自成标签
        assert_eq!(
            extract_hash_tags("#《甲》#《乙》"),
            vec!["甲".to_string(), "乙".to_string()]
        );
        // 其余括号对
        assert_eq!(extract_hash_tags("#（全角）"), vec!["全角".to_string()]);
        assert_eq!(extract_hash_tags("#(half)"), vec!["half".to_string()]);
        assert_eq!(extract_hash_tags("#[brack]"), vec!["brack".to_string()]);
        // 只有开括号、没闭合 → 不认括号型，且**不吞掉**后续正文（退回裸标签规则）
        assert_eq!(extract_hash_tags("#《没闭合\n下一行"), Vec::<String>::new());
        assert_eq!(
            extract_hash_tags("#《没闭合"),
            Vec::<String>::new(),
            "只有开括号时不应产出标签"
        );
        // 括号内为空 → 无标签
        assert_eq!(extract_hash_tags("#《》"), Vec::<String>::new());
        // 括号型与裸标签混排
        assert_eq!(
            extract_hash_tags("#《剧》 与 #裸标"),
            vec!["剧".to_string(), "裸标".to_string()]
        );
    }

    /// ③b：`#标签` 归档到剧集必须是 **union 自动合并 + 去重**，
    /// 而非替换 —— 否则追加集数时会把用户手工设过的标签清掉。
    #[tokio::test]
    async fn series_tags_merge_union_without_duplicates() {
        let s = Store::open(tmp_db("unique_tags")).await.unwrap();
        let sid = s.create_series("S", None, "series", None, None).await.unwrap();

        // 第一集带来 a/b
        assert_eq!(
            s.add_series_tags_by_name(sid, &["a".into(), "b".into()])
                .await
                .unwrap(),
            2
        );
        // 第二集带来 b/c：b 已存在不重复计入，仅 c 是新增
        assert_eq!(
            s.add_series_tags_by_name(sid, &["b".into(), "c".into()])
                .await
                .unwrap(),
            1
        );
        // 再次重复：0 新增
        assert_eq!(
            s.add_series_tags_by_name(sid, &["a".into(), "c".into()])
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            scalar_i64(&s.conn, "SELECT COUNT(*) FROM media_series_tag").await,
            3,
            "a/b/c 三个标签，无重复关联"
        );
        assert_eq!(
            scalar_i64(&s.conn, "SELECT COUNT(*) FROM media_tag").await,
            3,
            "同名标签复用同一行，不生副本"
        );

        // 同一批次内部的重复也要折叠
        let sid2 = s.create_series("S2", None, "series", None, None).await.unwrap();
        assert_eq!(
            s.add_series_tags_by_name(sid2, &["d".into(), "d".into()])
                .await
                .unwrap(),
            1
        );
        // 空白标签被忽略（不建空标签行）
        assert_eq!(
            s.add_series_tags_by_name(sid2, &["  ".into()]).await.unwrap(),
            0
        );
    }

    /// ③b：`collect_hash_tags` 读的是**真实 caption**，跨消息去重且带上限。
    #[tokio::test]
    async fn collect_hash_tags_reads_captions_and_caps() {
        let s = Store::open(tmp_db("collect_tags")).await.unwrap();
        s.upsert_message(
            100, 1, Some("第1集 #短剧 #推荐"), None, None, None, None, None, None,
        )
        .await
        .unwrap();
        s.upsert_message(
            100, 2, Some("#推荐 #新剧"), None, None, None, None, None, None,
        )
        .await
        .unwrap();
        // 无 caption 的消息只是跳过，不报错
        s.upsert_message(100, 3, None, None, None, None, None, None, None)
            .await
            .unwrap();

        let got = s.collect_hash_tags(100, &[1, 2, 3], 20).await.unwrap();
        assert_eq!(
            got,
            vec!["短剧".to_string(), "推荐".to_string(), "新剧".to_string()],
            "跨消息去重，保留首次出现顺序"
        );

        // 上限生效
        assert_eq!(s.collect_hash_tags(100, &[1, 2, 3], 2).await.unwrap().len(), 2);
    }

    /// BUG-039 冲突2：caption 集号区间解析——合集 / 单集 / 歧义拒绝。
    #[test]
    fn parse_episode_range_covers_real_captions() {
        // 合集：中英、全半角、连接符变体
        assert_eq!(parse_episode_range("EP01-02 集合集"), Some((1, Some(2))));
        assert_eq!(parse_episode_range("ep1-2"), Some((1, Some(2))));
        assert_eq!(parse_episode_range("第01-02集 高清"), Some((1, Some(2))));
        assert_eq!(parse_episode_range("第3~4集"), Some((3, Some(4))));
        assert_eq!(parse_episode_range("10-20集合集"), Some((10, Some(20))));
        // 单集
        assert_eq!(parse_episode_range("EP07 正片"), Some((7, None)));
        assert_eq!(parse_episode_range("第5集"), Some((5, None)));
        assert_eq!(parse_episode_range("#12 抢先"), Some((12, None)));
        // 歧义 / 无信号：年份区间、纯文本、空
        assert_eq!(parse_episode_range("1990-2020 经典回顾"), None, "年份区间宽度超限拒绝");
        assert_eq!(parse_episode_range("免费 AI 在线制作"), None);
        assert_eq!(parse_episode_range(""), None);
    }

    /// BUG-039 冲突2：带范围追加——合集落位 + 下一可用位从终点之后起算。
    #[tokio::test]
    async fn append_ranged_places_collections_and_skips_conflicts() {
        let s = Store::open(tmp_db("append_ranged")).await.unwrap();
        let sid = s.create_series("剧", None, "series", None, None).await.unwrap();
        // 分集条目必须是真实存在的视频条目（BUG-044 不变量要求 kind='video'）。
        let mut vids = Vec::new();
        for id in [101, 102, 103] {
            vids.push(
                s.upsert_media_item("tg", &format!("ref:{id}"), &format!("t{id}"), "video", None, None, None, None)
                    .await
                    .unwrap(),
            );
        }
        let [v1, v2, v3] = [vids[0], vids[1], vids[2]];

        // ① E1：声明 1-2 → 落 1..2
        let n = s
            .append_episodes_ranged(sid, 1, &[(v1, Some((1, 2)))])
            .await
            .unwrap();
        assert_eq!(n, 1);
        // ② E2（声明位被 ① 占用）→ 回退到终点之后：落 3..4
        let n = s
            .append_episodes_ranged(sid, 1, &[(v2, Some((1, 2)))])
            .await
            .unwrap();
        assert_eq!(n, 1);
        // ③ 单集 → 排到最大终点之后：落 5
        let n = s
            .append_episodes_ranged(sid, 1, &[(v3, None)])
            .await
            .unwrap();
        assert_eq!(n, 1);

        let detail = s.get_series(sid).await.unwrap().unwrap();
        let got: Vec<(i64, Option<i64>)> = detail
            .episodes
            .iter()
            .map(|e| (e.episode_no, e.episode_no_end))
            .collect();
        assert_eq!(
            got,
            vec![(1, Some(2)), (3, Some(4)), (5, None)],
            "合集保留宽度，后续编号从终点之后起算"
        );
        // 幂等：同条目重复追加不产生第二集
        let n = s
            .append_episodes_ranged(sid, 1, &[(v1, Some((1, 2)))])
            .await
            .unwrap();
        assert_eq!(n, 0, "已收录条目跳过");
    }

    /// BUG-044 规则级不变量：**剧集分集与备用源只能是视频**。
    /// 由数据库触发器表达 —— 任何写路径（自动成剧/手动/合并/未来新路径）
    /// 都无法把图片（或不存在的条目）挂成分集/备用源。
    #[tokio::test]
    async fn episode_slots_reject_non_media_items() {
        let s = Store::open(tmp_db("video_only")).await.unwrap();
        let sid = s.create_series("剧", None, "series", None, None).await.unwrap();
        let vid = s
            .upsert_media_item("tg", "ref:v", "video", "video", None, None, None, None)
            .await
            .unwrap();
        let pic = s
            .upsert_media_item("tg", "ref:p", "picture", "photo", None, None, None, None)
            .await
            .unwrap();
        let audio = s
            .upsert_media_item("tg", "ref:a", "sound", "audio", None, None, None, None)
            .await
            .unwrap();

        // 第 4 轮裁定：图片**可以**成为分集（浏览位）——它是剧集归档内容的一部分。
        assert!(
            s.add_episode(sid, pic, 1, 1).await.is_ok(),
            "图片应能成为分集"
        );
        // 音频仍不属于剧集（剧集容器只收 video / photo）
        assert!(
            s.add_episode(sid, audio, 1, 2).await.is_err(),
            "音频不得成为分集"
        );
        // 不存在的条目同样拒绝（kind 查不到 = NULL）
        assert!(
            s.add_episode(sid, 999_999, 1, 3).await.is_err(),
            "未知条目不得成为分集"
        );
        // 正常视频可以
        let ep = s.add_episode(sid, vid, 1, 2).await.unwrap();
        let det = s.get_series(sid).await.unwrap().unwrap();
        assert_eq!(det.episodes.len(), 2, "图片 1 集 + 视频 1 集");
        // 备用源只收 video：图片与未知条目都不得成为备用（播放源不可表达图片）
        assert!(s.attach_episode_source(ep, pic).await.is_err(), "图片不得成为备用源");
        assert!(s.attach_episode_source(ep, 999_999).await.is_err());
    }

    /// **旧库→新代码**迁移：升级库上新旧两套分集触发器并存时，`Store::open` 必须退役
    /// 旧的 `trg_media_episode_video_only_ins`。
    ///
    /// 这是第 4 轮放宽分集到 video|photo 后**唯一未被覆盖**的路径：其余单测都在全新库上跑，
    /// 那里只有新触发器，图片分集一路绿灯；而真实用户库是升级库，旧触发器仍在，图片分集
    /// 插入被 ABORT，剧集建成却 0 分集 —— 失败被伪装成成功。故本测试专门复刻升级库状态。
    #[tokio::test]
    async fn upgrade_drops_superseded_video_only_episode_trigger() {
        let path = tmp_db("legacy_trigger");
        // ① 全新库：只有 migrate() 建的新触发器
        drop(Store::open(&path).await.unwrap());
        // ② 复刻升级库：把旧的 video_only 触发器装回去（此时新旧并存，正是用户库现状）
        {
            let conn = libsql::Builder::new_local(&path)
                .build()
                .await
                .unwrap()
                .connect()
                .unwrap();
            conn.execute_batch(
                r#"
                CREATE TRIGGER trg_media_episode_video_only_ins
                     BEFORE INSERT ON media_episode
                     FOR EACH ROW
                     WHEN (SELECT kind FROM media_item WHERE id = NEW.item_id) IS NOT 'video'
                     BEGIN
                         SELECT RAISE(ABORT, 'episode item must be a video item');
                     END;
                "#,
            )
            .await
            .unwrap();
        }
        // ③ 迁移（Store::open 每次都会跑）必须把旧触发器退役掉
        let s = Store::open(&path).await.unwrap();
        let sid = s.create_series("剧", None, "series", None, None).await.unwrap();
        let pic = s
            .upsert_media_item("tg", "ref:up", "picture", "photo", None, None, None, None)
            .await
            .unwrap();
        assert!(
            s.add_episode(sid, pic, 1, 1).await.is_ok(),
            "升级库上图片也必须能成为分集（旧触发器没退役 → 这里必然失败）"
        );
    }

    /// 启动修复：只有**非法 kind**（既非 video 也非 photo）的分集会被摘除；
    /// 失去全部分集的剧集随之删除；残留的旧 kind 重算为 series。
    ///
    /// 第 4 轮裁定后**图片分集是合法内容**（浏览位），因此「纯图剧」不再被清除 ——
    /// 这正是本测试断言变化的原因：删的是 audio 这类根本不该进剧集的东西。
    #[tokio::test]
    async fn startup_repair_strips_illegal_episodes_only() {
        let path = tmp_db("repair");
        {
            let conn = libsql::Builder::new_local(&path).build().await.unwrap().connect().unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE media_item (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ref TEXT NOT NULL,
                    title TEXT NOT NULL, kind TEXT NOT NULL, file_path TEXT, poster TEXT,
                    size INTEGER, duration INTEGER, width INTEGER, height INTEGER, added_at INTEGER NOT NULL
                );
                CREATE TABLE media_series (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
                    description TEXT, kind TEXT NOT NULL, poster TEXT, year INTEGER,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE media_episode (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL,
                    item_id INTEGER NOT NULL, season INTEGER NOT NULL, episode_no INTEGER NOT NULL,
                    title TEXT, description TEXT,
                    UNIQUE(series_id, season, episode_no)
                );
                INSERT INTO media_item (source, ref, title, kind, added_at) VALUES
                    ('tg','r:1','v1','video',1), ('tg','r:2','p1','photo',2), ('tg','r:3','v2','video',3),
                    ('tg','r:4','a1','audio',4);
                INSERT INTO media_series (title, kind, created_at, updated_at) VALUES
                    ('混编剧','series',1,1), ('纯图剧','album',1,1), ('残留相集','collection',1,1),
                    ('音频剧','series',1,1);
                INSERT INTO media_episode (series_id, item_id, season, episode_no) VALUES
                    (1, 1, 1, 1), (1, 2, 1, 2),  -- 混编剧：视频 + 图片（都合法）
                    (2, 2, 1, 1),                -- 纯图剧：只有图片（合法，必须保留）
                    (3, 3, 1, 1),                -- 残留相集：只剩视频
                    (4, 4, 1, 1);                -- 音频剧：audio 分集非法
                "#,
            )
            .await
            .unwrap();
        }
        let s = Store::open(&path).await.unwrap();

        let series = s.list_series().await.unwrap();
        assert_eq!(series.len(), 3, "音频剧因非法分集被清空而删除；纯图剧必须幸存");
        let det = s
            .get_series(
                series
                    .iter()
                    .find(|x| x.title == "混编剧")
                    .expect("混编剧应幸存")
                    .id,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(det.episodes.len(), 2, "混编剧的视频集与图片集都在");
        assert_eq!(det.episodes[0].item_id, 1);
        assert_eq!(det.episodes[0].kind.as_deref(), Some("video"));
        // 残留相集：分集已全视频 → kind 重算为 series
        let repaired = series
            .iter()
            .find(|x| x.title == "残留相集")
            .expect("残留相集应幸存");
        assert_eq!(repaired.kind, "series", "全视频分集的 kind 应回归 series");
    }

    /// BUG-045：`#标签` 归档到**内容条目**（无剧集可挂时），union 语义与剧集版一致。
    #[tokio::test]
    async fn item_tags_union_without_duplicates() {
        let s = Store::open(tmp_db("item_tags")).await.unwrap();
        let item = s
            .upsert_media_item("tg", "ref:1", "t", "video", None, None, None, None)
            .await
            .unwrap();

        assert_eq!(
            s.add_item_tags_by_name(item, &["短剧".into(), "推荐".into()])
                .await
                .unwrap(),
            2
        );
        // 重复归档：已存在的不计数、不产生重复关联
        assert_eq!(
            s.add_item_tags_by_name(item, &["推荐".into(), "新标".into()])
                .await
                .unwrap(),
            1
        );
        // union 不替换：3 个关联、无重复
        assert_eq!(
            scalar_i64(
                &s.conn,
                &format!("SELECT COUNT(*) FROM media_item_tag WHERE item_id = {item}")
            )
            .await,
            3
        );
        let dupes = scalar_i64(
            &s.conn,
            &format!(
                "SELECT COUNT(*) FROM (SELECT tag_id FROM media_item_tag WHERE item_id = {item} \
                  GROUP BY tag_id HAVING COUNT(*) > 1)"
            ),
        )
        .await;
        assert_eq!(dupes, 0, "不应产生重复关联");
        // 空白名忽略
        assert_eq!(s.add_item_tags_by_name(item, &["  ".into()]).await.unwrap(), 0);
    }

    /// BUG-039 冲突1：备用源挂载 / 主备切换 / 摘除。
    #[tokio::test]
    async fn episode_sources_attach_switch_detach() {
        let s = Store::open(tmp_db("ep_sources")).await.unwrap();
        let sid = s.create_series("剧", None, "series", None, None).await.unwrap();
        // 分集/备用源必须是真实存在的视频条目（BUG-044 不变量要求 kind='video'）。
        let mut vids = Vec::new();
        for i in 0..3 {
            vids.push(
                s.upsert_media_item("tg", &format!("ref:{i}"), &format!("t{i}"), "video", None, None, None, None)
                    .await
                    .unwrap(),
            );
        }
        let (a, b) = (vids[0], vids[1]);
        let ep = s.add_episode(sid, a, 1, 1).await.unwrap();
        // 挂备用源
        assert!(s.attach_episode_source(ep, b).await.unwrap());
        assert!(!s.attach_episode_source(ep, b).await.unwrap(), "重复挂载幂等");
        assert!(!s.attach_episode_source(ep, a).await.unwrap(), "主条目本身不挂为备用");
        // 切主：b 上主位，a 转备用
        s.switch_episode_source(ep, b).await.unwrap();
        let detail = s.get_series(sid).await.unwrap().unwrap();
        let e0 = &detail.episodes[0];
        assert_eq!(e0.item_id, b, "新主条目");
        assert_eq!(e0.sources.len(), 1);
        assert_eq!(e0.sources[0].item_id, a, "原主条目降级为备用");
        // 摘除
        s.detach_episode_source(ep, a).await.unwrap();
        let detail = s.get_series(sid).await.unwrap().unwrap();
        assert!(detail.episodes[0].sources.is_empty());
    }

    /// 回归（BUG-051 / C3 + 唯一清理链）：清缓存必须能把 `file_path` 置空，
    /// 且**保留条目**；upsert 的 COALESCE 无法表达这个语义。
    #[tokio::test]
    async fn clear_cache_bytes_keeps_item_and_nulls_path() {
        let s = Store::open(tmp_db("clear_bytes")).await.unwrap();
        let dir = std::env::temp_dir().join(format!("orig_cache_dir_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("v.mp4");
        std::fs::write(&file, b"bytes").unwrap();

        let id = s
            .upsert_media_item("tg", "1:2", "v", "video", Some(&file.to_string_lossy()), Some(5), None, None)
            .await
            .unwrap();
        // 图片条目（无字节）不得出现在清缓存工作集里。
        let _pid = s
            .upsert_media_item("tg", "1:3", "p", "photo", None, None, None, None)
            .await
            .unwrap();

        let cached = s.list_cached_items().await.unwrap();
        assert_eq!(cached.len(), 1, "只有带字节的条目进入清缓存工作集");
        assert_eq!(cached[0].id, id);

        // 唯一置空入口：写 None 就是置空（不被 COALESCE 粘住）。
        assert!(s.set_item_file_path(id, None).await.unwrap());
        let item = s.get_media_item(id).await.unwrap().unwrap();
        assert!(item.file_path.is_none(), "file_path 必须置空");
        assert_eq!(item.title, "v", "条目必须保留");

        // 清缓存的字节面：文件由调用方删，条目仍在。
        std::fs::remove_file(&file).unwrap();
        assert!(!file.exists());
        assert!(s.list_cached_items().await.unwrap().is_empty());
        assert!(s.get_media_item(id).await.unwrap().is_some(), "清缓存不删条目");
    }

    /// caption 必须切成「标题 + 介绍」，且行尾标签不占标题位。
    #[test]
    fn split_caption_separates_title_and_body() {
        let (t, d) = split_caption("这是标题\n第一行介绍\n第二行介绍 #标签1");
        assert_eq!(t.as_deref(), Some("这是标题"));
        assert_eq!(d.as_deref(), Some("第一行介绍\n第二行介绍 #标签1"));

        // 行尾 #标签 不进标题（标签有独立通道与展示位，重复占位是脏数据）
        let (t2, d2) = split_caption("标题行 #a #b\n正文");
        assert_eq!(t2.as_deref(), Some("标题行"));
        assert_eq!(d2.as_deref(), Some("正文"));

        // 单行 caption：只有标题，没有介绍
        let (t3, d3) = split_caption("只有一行");
        assert_eq!(t3.as_deref(), Some("只有一行"));
        assert_eq!(d3, None);

        // 首行空 ⇒ 无标题，整段退化为介绍
        let (t4, d4) = split_caption("\n只有正文");
        assert_eq!(t4, None);
        assert_eq!(d4.as_deref(), Some("只有正文"));

        // 空 caption：两边都为空
        let (t5, d5) = split_caption("   ");
        assert_eq!(t5, None);
        assert_eq!(d5, None);
    }

    /// 剧集是通用归档容器 —— **图片也能成为分集**（浏览位），
    /// 但**播放源**仍然只收 video（播放时出现图片在结构上不可表达）。
    #[tokio::test]
    async fn photo_can_be_episode_but_never_a_source() {
        let s = Store::open(tmp_db("photo_episode")).await.unwrap();
        let photo = s
            .upsert_media_item("tg", "1:1", "cover", "photo", None, None, None, None)
            .await
            .unwrap();
        let video = s
            .upsert_media_item("tg", "1:2", "clip", "video", None, None, None, None)
            .await
            .unwrap();
        let sid = s
            .create_series("graph JarXC", None, "series", None, Some("tg:group:1:9"))
            .await
            .unwrap();

        // 图片入剧集：成功（此前触发器会 RAISE ABORT）
        assert_eq!(s.append_episodes(sid, 1, &[photo]).await.unwrap(), 1);
        assert_eq!(s.append_episodes(sid, 1, &[video]).await.unwrap(), 1);

        // 播放源只收 video：图片作为 source 必须被拒。
        let hit = s
            .conn
            .execute(
                "INSERT INTO media_episode_source (series_id, episode_id, item_id, is_primary)
                 SELECT ?1, id, ?2, 1 FROM media_episode WHERE series_id = ?1 AND item_id = ?2",
                params![sid, photo],
            )
            .await;
        assert!(hit.is_err(), "图片不得成为播放源");

        let n = s
            .row_opt("SELECT COUNT(*) FROM media_episode WHERE series_id = ?1", params![sid])
            .await
            .unwrap()
            .unwrap()
            .get::<i64>(0)
            .unwrap();
        assert_eq!(n, 2, "图片与视频同为该剧分集");
    }

    // ───────────── 条目文案：标题 / 介绍（「剧集正确、视频错误」的修） ─────────────

    /// 造一个「升级库」：`media_item` 是加 `description` 之前的结构（或已加列但行里没值），
    /// 且 `title` 存的是当年的**整段 caption** —— 这正是用户库里的样子。
    async fn seed_legacy_item(path: &Path, title: &str, description: Option<&str>) -> i64 {
        let conn = libsql::Builder::new_local(path)
            .build()
            .await
            .unwrap()
            .connect()
            .unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE media_item (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                source      TEXT NOT NULL,
                ref         TEXT NOT NULL,
                title       TEXT NOT NULL,
                kind        TEXT NOT NULL,
                file_path   TEXT,
                poster      TEXT,
                size        INTEGER,
                duration    INTEGER,
                width       INTEGER,
                height      INTEGER,
                added_at    INTEGER NOT NULL,
                description TEXT,
                UNIQUE(source, ref)
            );
            "#,
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO media_item (source, ref, title, kind, added_at, description)
             VALUES ('tg', '100:7', ?1, 'video', 1, ?2)",
            params![title, description],
        )
        .await
        .unwrap();
        conn.last_insert_rowid()
    }

    /// **旧库→新代码**迁移：历史行里 `title` 是整段 caption（标题行 + 正文 + 标签行），
    /// 升级后必须切成「标题 + 介绍」两栏。
    ///
    /// 为什么必须测：写入路径的修复（`import_cached_file` 等）**只救新数据**，而用户看到的
    /// 是老行 —— 剧集详情页标题干净、介绍完整，点开同一条视频却是一整坨原文。
    /// 数据不修，代码改得再对也看不见。
    #[tokio::test]
    async fn upgrade_splits_legacy_blob_title_into_title_and_description() {
        let path = tmp_db("legacy_blob_title");
        let id = seed_legacy_item(
            &path,
            "《某剧》EP1 原档\n剧情简介：\n她披着最乖巧温顺的皮。\n标签： #短剧 #推荐",
            None,
        )
        .await;

        let s = Store::open(&path).await.unwrap();
        let it = s.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(it.title, "《某剧》EP1 原档", "标题只留首行");
        assert_eq!(
            it.description.as_deref(),
            Some("剧情简介：\n她披着最乖巧温顺的皮。\n标签： #短剧 #推荐"),
            "正文进介绍位（与剧集 description 同一把尺子）"
        );
    }

    /// 迁移的两条保守规则：**标题只重切整段行、介绍只补空位**。
    /// 用户手改过的标题与写过的介绍一律不得被覆盖。
    #[tokio::test]
    async fn backfill_never_clobbers_edited_title_or_description() {
        let path = tmp_db("backfill_conservative");
        // title 已是干净标题（用户可能改过），description 是用户写的
        let id = seed_legacy_item(&path, "用户改过的标题", Some("用户写的介绍")).await;
        // 另一行：整段 title + 用户自己写的介绍 —— 标题要重切，介绍要保留
        let blob_id = {
            let conn = libsql::Builder::new_local(&path)
                .build()
                .await
                .unwrap()
                .connect()
                .unwrap();
            conn.execute(
                "INSERT INTO media_item (source, ref, title, kind, added_at, description)
                 VALUES ('tg', '100:8', '原标题\n原正文', 'video', 2, '用户自己写的介绍')",
                (),
            )
            .await
            .unwrap();
            conn.last_insert_rowid()
        };

        let s = Store::open(&path).await.unwrap();
        let a = s.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(a.title, "用户改过的标题", "已切干净的标题不得被动");
        assert_eq!(a.description.as_deref(), Some("用户写的介绍"), "已有介绍不得被覆盖");
        let b = s.get_media_item(blob_id).await.unwrap().unwrap();
        assert_eq!(b.title, "原标题");
        assert_eq!(
            b.description.as_deref(),
            Some("用户自己写的介绍"),
            "标题重切，但用户写的介绍仍然优先"
        );
    }

    /// 回填是**一次性**的：用户主动清空介绍后，重启不得把它填回来
    /// （否则「我不要这段介绍」成为无法表达的意图）。
    #[tokio::test]
    async fn backfill_runs_once_so_cleared_description_stays_cleared() {
        let path = tmp_db("backfill_once");
        let id = seed_legacy_item(&path, "标题\n正文", None).await;

        let s = Store::open(&path).await.unwrap();
        assert!(s.get_media_item(id).await.unwrap().unwrap().description.is_some());
        // 显式清空（nullable 契约：Some(None) = 置空）
        s.update_media_item(
            id,
            &ItemPatch {
                description: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        drop(s);

        let s2 = Store::open(&path).await.unwrap();
        assert!(
            s2.get_media_item(id).await.unwrap().unwrap().description.is_none(),
            "清空过的介绍不得被迁移重新填回"
        );
    }

    /// 条目介绍：写入 → 读回 → 重新入库保留旧值 → 显式清空。与剧集介绍同一契约。
    #[tokio::test]
    async fn item_description_roundtrip_and_clear() {
        let s = Store::open(&tmp_db("item_desc")).await.unwrap();
        let id = s
            .upsert_media_item("tg", "1:1", "标题", "video", None, None, None, Some("介绍"))
            .await
            .unwrap();
        assert_eq!(
            s.get_media_item(id).await.unwrap().unwrap().description.as_deref(),
            Some("介绍")
        );
        // 重新入库没带介绍：旧值保留（与 title 的 COALESCE 语义一致）
        let id2 = s
            .upsert_media_item("tg", "1:1", "标题2", "video", None, None, None, None)
            .await
            .unwrap();
        assert_eq!(id, id2, "同 (source,ref) 幂等");
        let it = s.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(it.title, "标题2");
        assert_eq!(it.description.as_deref(), Some("介绍"));
        // 显式清空
        s.update_media_item(
            id,
            &ItemPatch {
                description: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(s.get_media_item(id).await.unwrap().unwrap().description.is_none());
    }

    /// 空标题**不可表达**：PATCH 空/纯空白标题不得把标题抹成空串。
    ///
    /// 缺陷原形：`update_media_item` 直接 `patch.title.unwrap_or(existing.title)`，
    /// 于是 `{"title": ""}` 会把标题写成空串 —— 条目在一墙内容里变成认不出的卡。
    /// 介绍的空值语义相反（空 = 显式清空），两者不能共用一条规则。
    #[tokio::test]
    async fn empty_title_patch_keeps_previous_title() {
        let s = Store::open(&tmp_db("empty_title")).await.unwrap();
        let id = s
            .upsert_media_item("tg", "1:1", "原标题", "video", None, None, None, None)
            .await
            .unwrap();
        for bad in ["", "   ", "\n\t"] {
            s.update_media_item(
                id,
                &ItemPatch {
                    title: Some(bad.to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(
                s.get_media_item(id).await.unwrap().unwrap().title,
                "原标题",
                "空标题（{bad:?}）不得写入"
            );
        }
        // 正常改名照旧生效；标题旁的空格按原样保留（不替用户决定裁剪）
        s.update_media_item(
            id,
            &ItemPatch {
                title: Some("新标题".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(s.get_media_item(id).await.unwrap().unwrap().title, "新标题");
    }

    /// 「删除所选」只删勾中的那几条：活跃任务先停 worker 再删行，其余记录原样保留。
    #[tokio::test]
    async fn delete_cache_tasks_by_ids_removes_only_selected() {
        let s = Store::open(&tmp_db("del_task_ids")).await.unwrap();
        let mk = |key: &str| {
            let s = &s;
            let key = key.to_string();
            async move {
                s.enqueue_cache_task(1, None, &key, &[1, 2], "D:/tmp")
                    .await
                    .unwrap()
                    .unwrap()
                    .0
                    .id
            }
        };
        let (a, b, c) = (mk("k1").await, mk("k2").await, mk("k3").await);
        // 让 b 处于活跃态：挑中它是为了验证「先 cancelled 再删行」
        s.mark_cache_task_running(b).await.unwrap();

        let removed = s.delete_cache_tasks_by_ids(&[a, b]).await.unwrap();
        assert_eq!(removed, 2);
        assert!(s.get_cache_task(a).await.unwrap().is_none());
        assert!(s.get_cache_task(b).await.unwrap().is_none());
        assert!(s.get_cache_task(c).await.unwrap().is_some(), "未勾选的记录必须保留");

        // 空集合：不动任何东西（避免前端误发空选择就把记录清空）
        assert_eq!(s.delete_cache_tasks_by_ids(&[]).await.unwrap(), 0);
        assert!(s.get_cache_task(c).await.unwrap().is_some());
    }

    /// **内容文案单一真源**：分集 PATCH 改标题/介绍必须落到**条目**上，
    /// 且剧集详情读回来的就是条目那份（不是分集行里的第二份副本）。
    ///
    /// 缺陷原形（用户报「剧集里面视频标题无法修改、介绍没填充进视频」）：
    /// `media_episode` 与 `media_item` 各有一套 title/description，
    /// 编辑面板写分集、卡片编辑写条目 —— 同一个视频于是有两个名字、两份介绍，
    /// 剧集页与播放页读的还不是同一列。
    #[tokio::test]
    async fn episode_edit_writes_through_to_item() {
        let s = Store::open(tmp_db("ep_write_through")).await.unwrap();
        let sid = s.create_series("剧", None, "series", None, None).await.unwrap();
        let iid = s
            .upsert_media_item(
                "local",
                "D:/x/a.mp4",
                "原标题",
                "video",
                None,
                None,
                None,
                Some("原介绍"),
            )
            .await
            .unwrap();
        let ep = s.add_episode(sid, iid, 1, 1).await.unwrap();

        // 1) 分集 PATCH：标题 + 介绍一起改（前端分集编辑面板正是这样发的）
        let edit = EpisodeEdit {
            title: Some("新标题".to_string()),
            description: Some(Some("新介绍".to_string())),
            episode_no: Some(4),
            ..Default::default()
        };
        assert!(s.update_episode(ep, &edit).await.unwrap());

        // 2) 条目侧真的变了（而不是只写了个分集副本）
        let item = s.get_media_item(iid).await.unwrap().unwrap();
        assert_eq!(item.title, "新标题", "分集改名必须写穿到条目");
        assert_eq!(item.description.as_deref(), Some("新介绍"));

        // 3) 剧集详情读到的就是条目那份，逐字相等
        let det = s.get_series(sid).await.unwrap().unwrap();
        assert_eq!(det.episodes[0].title.as_deref(), Some("新标题"));
        assert_eq!(det.episodes[0].description.as_deref(), Some("新介绍"));
        assert_eq!(det.episodes[0].episode_no, 4, "槽位仍然生效");

        // 4) 分集行上**没有**第二份副本（「分歧状态」在数据上不可表达）
        let dup = scalar_i64(
            &s.conn,
            &format!(
                "SELECT COUNT(*) FROM media_episode
                  WHERE id = {ep} AND (title IS NOT NULL OR description IS NOT NULL)"
            ),
        )
        .await;
        assert_eq!(dup, 0, "分集行不得再持有 title/description 副本");
    }

    /// 反向：改**条目**（媒体库卡片编辑）后，剧集详情读到的标题/介绍同步跟着变。
    ///
    /// 「剧集和视频应该是一致的」在数据上是双向的：不是让两边各自维护、
    /// 而是两边本来就是同一个字段。
    #[tokio::test]
    async fn item_rename_shows_in_series_detail() {
        let s = Store::open(tmp_db("item_rename")).await.unwrap();
        let sid = s.create_series("剧", None, "series", None, None).await.unwrap();
        let iid = s
            .upsert_media_item("local", "D:/x/b.mp4", "旧名", "video", None, None, None, None)
            .await
            .unwrap();
        s.add_episode(sid, iid, 1, 1).await.unwrap();

        let patch = ItemPatch {
            title: Some("卡片改的名".to_string()),
            description: Some(Some("卡片填的介绍".to_string())),
            ..Default::default()
        };
        assert!(s.update_media_item(iid, &patch).await.unwrap());

        let det = s.get_series(sid).await.unwrap().unwrap();
        assert_eq!(det.episodes[0].title.as_deref(), Some("卡片改的名"));
        assert_eq!(det.episodes[0].description.as_deref(), Some("卡片填的介绍"));
    }

    /// 分集 PATCH 的空值语义必须与条目 PATCH **一致**：标题空 = 不改（不可表达），
    /// 介绍空 = 显式清空（可表达的意图）。写成两套语义正是「改了一边另一边不动」的来源。
    #[tokio::test]
    async fn episode_edit_empty_values_match_item_semantics() {
        let s = Store::open(tmp_db("ep_empty")).await.unwrap();
        let sid = s.create_series("剧", None, "series", None, None).await.unwrap();
        let iid = s
            .upsert_media_item("local", "D:/x/c.mp4", "名字", "video", None, None, None, Some("介绍"))
            .await
            .unwrap();
        let ep = s.add_episode(sid, iid, 1, 1).await.unwrap();

        // 标题给空白 = 不改；介绍给 null = 清空
        let edit = EpisodeEdit {
            title: Some("   ".to_string()),
            description: Some(None),
            ..Default::default()
        };
        assert!(s.update_episode(ep, &edit).await.unwrap());
        let item = s.get_media_item(iid).await.unwrap().unwrap();
        assert_eq!(item.title, "名字", "空白标题不得抹掉旧值");
        assert_eq!(item.description, None, "空介绍 = 显式清空");
    }

    /// **旧库→新代码**迁移：分集行上的内容文案并入条目，且死列被腾空。
    ///
    /// 迁移是**一次性**的（标记键收口）：否则用户主动清空的介绍会在每次启动时被填回来。
    #[tokio::test]
    async fn legacy_episode_text_collapses_into_item() {
        let path = tmp_db("ep_collapse");
        // 1) 造一个「分集行里有文案」的旧库：条目介绍为空、分集有介绍
        {
            let conn = libsql::Builder::new_local(&path).build().await.unwrap().connect().unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE media_item (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ref TEXT NOT NULL,
                    title TEXT NOT NULL, kind TEXT NOT NULL, file_path TEXT, poster TEXT,
                    size INTEGER, duration INTEGER, width INTEGER, height INTEGER,
                    added_at INTEGER NOT NULL, description TEXT, UNIQUE(source, ref)
                );
                CREATE TABLE media_series (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
                    kind TEXT NOT NULL DEFAULT 'series', poster TEXT, year INTEGER,
                    source_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE media_episode (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL,
                    item_id INTEGER NOT NULL, season INTEGER NOT NULL DEFAULT 1,
                    episode_no INTEGER NOT NULL DEFAULT 1, title TEXT, description TEXT,
                    UNIQUE(series_id, season, episode_no)
                );
                INSERT INTO media_item (source, ref, title, kind, added_at, description)
                    VALUES ('local', 'D:/x/legacy.mp4', '旧标题', 'video', 1, NULL);
                INSERT INTO media_series (title, kind, created_at, updated_at)
                    VALUES ('旧剧', 'series', 1, 1);
                INSERT INTO media_episode (series_id, item_id, season, episode_no, title, description)
                    VALUES (1, 1, 1, 1, '分集上的标题', '分集上的介绍');
                "#,
            )
            .await
            .unwrap();
        }

        // 2) 新代码打开 = 触发迁移
        let s = Store::open(&path).await.unwrap();
        let item = s.get_media_item(1).await.unwrap().unwrap();
        assert_eq!(item.title, "旧标题", "条目已有标题时不被分集快照覆盖");
        assert_eq!(
            item.description.as_deref(),
            Some("分集上的介绍"),
            "条目介绍为空时必须从分集补上（用户报的「介绍没填充进视频」）"
        );
        let left = scalar_i64(
            &s.conn,
            "SELECT COUNT(*) FROM media_episode WHERE title IS NOT NULL OR description IS NOT NULL",
        )
        .await;
        assert_eq!(left, 0, "迁移后分集行不得残留副本");

        // 3) 幂等且不回头：用户清空介绍后重启，不得被重新填回
        let patch = ItemPatch {
            description: Some(None),
            ..Default::default()
        };
        assert!(s.update_media_item(1, &patch).await.unwrap());
        drop(s);
        let s2 = Store::open(&path).await.unwrap();
        let again = s2.get_media_item(1).await.unwrap().unwrap();
        assert_eq!(again.description, None, "一次性迁移不得在下次启动把清空值填回");
    }
}
