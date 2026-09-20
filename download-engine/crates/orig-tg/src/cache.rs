//! M2 缓存模块：过程态（任务）与字节清理。
//!
//! 边界（`docs/MEDIA-DESIGN.md` §0 / BUG-051）：
//! - **事实态** = `media_item.file_path`（有没有字节），归媒体库；
//! - **过程态** = `cache_task`，归本模块。
//!
//! 本模块不认剧集、不认 TG 会话语义，只负责「取字节」与「清字节」。
//! 清理铁律（唯一清理链，杜绝孤儿文件与悬空路径）：
//! - 清缓存（**保留条目**）：unlink → `file_path` 置空 → 复位 TG `downloaded`；
//! - 删条目（**连字节**）：unlink → 删行（见 `routes::delete_media_item`）。
//!
//! **只删自己产出的字节**：路径必须位于下载目录内；导入/扫描产生的外部文件永不删除。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::media::CachedBytesDetail;
// `spawn_cache_task`：重试要把复位后的任务交回**同一个** worker 入口，
// 不在本模块另起一套投递——否则「重试跑的」与「入队跑的」会分叉成两条执行路径。
use crate::routes::{parse_tg_ref, spawn_cache_task, ApiError};
use crate::state::AppState;
use crate::store::{CacheTask, TaskClearScope};

/// 缓存模块的独立路由组（`/api/cache/*`）。
///
/// `/api/tg/cache/*` 保留为兼容别名（旧前端仍在用），新代码一律走这里。
///
/// **端点收敛原则**：一个动词一个端点，差异走参数（`?scope=`），
/// 不靠「再加一个 URL」表达新需求——否则每个想到场景都会长出一个端点。
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        // —— 字节面（磁盘）——
        // 清理也遵循「先看清、再执行」：`preview` 只读，`clear` 才动手（BUG-059）。
        .route("/api/cache/stats", get(stats))
        .route("/api/cache/clear/preview", get(clear_preview))
        .route("/api/cache/clear", post(clear))
        .route("/api/cache/items/:id", delete(clear_item))
        // —— 记录面（任务时间线）——
        .route("/api/cache/tasks", delete(clear_tasks))
        .route("/api/cache/tasks/:id", delete(delete_task))
        // 重试是同一条记录的**状态复位**（不是新动词）：复用既有 handler，
        // 不另开 `/api/cache/tasks/retry` —— 那条路会让「每个场景一个端点」重新长出来。
        .route("/api/cache/tasks/:id/retry", post(retry_task))
}

/// 生效的下载目录（运行期设置覆盖 env 默认值）——缓存字节的**唯一可删区**。
pub async fn download_dir(st: &AppState) -> PathBuf {
    let raw = st
        .store
        .get_setting("download_dir")
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| st.config.download_dir.to_string_lossy().into_owned());
    PathBuf::from(raw)
}

/// 路径是否位于下载目录内（决定「能不能删」）。
///
/// 用 `canonicalize` 消除软链/相对路径差异；文件已不存在时退到父目录判定
/// （清缓存的幂等重入：文件没了也要能把 `file_path` 置空）。
pub fn inside_dir(dir: &Path, p: &str) -> bool {
    let Ok(d) = std::fs::canonicalize(dir) else {
        return false;
    };
    let path = Path::new(p);
    let probe = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    let Ok(c) = std::fs::canonicalize(&probe) else {
        return false;
    };
    c.starts_with(&d)
}

/// `DELETE /api/cache/items/:id` — 清缓存·单条：**只删字节，条目保留**
/// （回「仅入库」浏览态，可重新缓存）。
async fn clear_item(
    State(st): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let item = st
        .store
        .get_media_item(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "media item not found"))?;

    let Some(path) = item.file_path.clone() else {
        // 图片/未缓存条目：没有字节可清，语义不匹配（422 而非静默成功）。
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "item has no cached bytes",
        ));
    };
    let dir = download_dir(&st).await;
    if !inside_dir(&dir, &path) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "file is outside the cache dir: refuse to delete",
        ));
    }

    let _ = std::fs::remove_file(&path);
    st.store
        .set_item_file_path(id, None)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    // TG 来源：字节没了要同步复位 downloaded，否则「已缓存」状态说谎。
    reset_tg_flag(&st, &item.source, &item.ref_key).await;

    st.push_log(&format!("/api/cache/items/{id} cleared"));
    Ok(Json(json!({"ok": true, "cleared": true})))
}

/// 缓存字节的清理范围（`?scope=`）——**动词唯一、差异走参数**。
///
/// 与任务记录侧的 [`TaskClearScope`] 同构：不靠「再加一个 URL」表达新场景，否则
/// 「清孤儿」「清陈旧的」「清失败残留」会各自长出一个端点（必然无限叠加）。
/// 用户勾选的**具体集合**是另一维（`?ids=`），两者互斥。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearScope {
    /// 下载目录内**全部**已缓存字节（默认档，兼容无参的 `POST /api/cache/clear`）。
    All,
    /// 孤儿：磁盘上有、但库里没有任何条目指向的文件（历史版本留下的残渣）。
    Orphan,
    /// 陈旧：文件最后修改时间早于 `olderThanDays` 天（默认 30）。
    Stale,
    /// 故障残留：`failed` / `cancelled` / `interrupted` 任务涉及过的消息所占字节。
    Failed,
}

impl ClearScope {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "all" => Some(Self::All),
            "orphan" => Some(Self::Orphan),
            "stale" => Some(Self::Stale),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Orphan => "orphan",
            Self::Stale => "stale",
            Self::Failed => "failed",
        }
    }
}

/// 陈旧档的默认年龄阈值（天）。
const DEFAULT_STALE_DAYS: u64 = 30;
/// 孤儿扫描的文件数上限：宁可截断并如实标注，也不把一个巨大的下载目录扫成超时。
const ORPHAN_SCAN_LIMIT: usize = 20_000;
/// 预览明细的条数上限（聚合数字不受此限）。
const PREVIEW_ITEM_LIMIT: usize = 200;

/// `?olderThanDays=`：**非法即 422**，不静默回落到默认值 —— 静默回落会让
/// 「清 7 天前的」实际清成「30 天前的」，而界面显示成功。
fn parse_days(raw: Option<&String>) -> Result<u64, ApiError> {
    let Some(v) = raw else {
        return Ok(DEFAULT_STALE_DAYS);
    };
    let n: u64 = v.trim().parse().map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid olderThanDays: expected a positive integer",
        )
    })?;
    if n == 0 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "olderThanDays must be >= 1",
        ));
    }
    Ok(n)
}

/// 一次清理的累计结果（如实回报，不吞不合并）。
#[derive(Default, Clone, Copy)]
struct Purged {
    removed: u64,
    skipped: u64,
    bytes: u64,
}

impl Purged {
    fn add(&mut self, p: Purged) {
        self.removed += p.removed;
        self.skipped += p.skipped;
        self.bytes += p.bytes;
    }
}

/// 清掉**一条**条目的字节：删除文件 → 置空 `file_path` → 复位 TG `downloaded`。
///
/// 集合档与分档共用同一实现，避免「某条路忘了复位 TG 标记」这类分支漂移
/// （清字节却仍显示「已缓存」是最难查的一类不一致）。
async fn purge_item(st: &Arc<AppState>, dir: &Path, it: &CachedBytesDetail) -> Purged {
    if !inside_dir(dir, &it.file_path) {
        // 外部文件（导入/扫描贴进来的）不是缓存产出的字节，永不删除，只如实计数。
        return Purged {
            skipped: 1,
            ..Default::default()
        };
    }
    let bytes = std::fs::metadata(&it.file_path).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&it.file_path);
    let _ = st.store.set_item_file_path(it.id, None).await;
    reset_tg_flag(st, &it.source, &it.ref_key).await;
    Purged {
        removed: 1,
        skipped: 0,
        bytes,
    }
}

/// 缓存工作集（带标题）——预览与清理共用同一份清单，两边读数才可能逐字一致。
async fn list_items(st: &Arc<AppState>) -> Result<Vec<CachedBytesDetail>, ApiError> {
    st.store
        .list_cached_items_detail()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))
}

/// 从条目来源里取频道号（只有 TG 来源有频道概念）。
fn chat_of(source: &str, ref_key: &str) -> Option<i64> {
    if source != "tg" {
        return None;
    }
    parse_tg_ref(ref_key).map(|(c, _)| c)
}

/// 故障残留的 ref 集合：`failed` / `cancelled` / `interrupted` 任务涉及过的消息。
///
/// 判据是**任务状态**而不是「条目有没有字节」：用户说的「失败任务的残留」
/// 就是这些试过但没成的消息占的磁盘字节。
async fn failed_ref_keys(st: &Arc<AppState>) -> Result<HashSet<String>, ApiError> {
    let tasks = st
        .store
        .list_cache_tasks(2000)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let mut out = HashSet::new();
    for t in tasks {
        if matches!(t.status.as_str(), "failed" | "cancelled" | "interrupted") {
            for m in t.message_ids {
                out.insert(format!("{}:{}", t.chat_id, m));
            }
        }
    }
    Ok(out)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 文件年龄（天）。取不到时间戳时返回 0 = **不算陈旧**（宁可少删）。
fn age_days(path: &str, now: u64) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let Ok(modified) = meta.modified() else {
        return 0;
    };
    let Ok(at) = modified.duration_since(UNIX_EPOCH) else {
        return 0;
    };
    now.saturating_sub(at.as_secs()) / 86_400
}

/// 下载中的临时文件（`.part` / `.tmp`）**不算孤儿**：它们正被 worker 写着，
/// 删掉等于打断下载。判据只看后缀，不看年龄。
fn is_in_progress(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()),
        Some("part") | Some("tmp")
    )
}

/// 路径归一（比对用）：尽量 canonicalize，统一分隔符；Windows 下再折叠大小写
/// （NTFS 默认不区分，不折叠会把同一个文件当成「磁盘有、库里无」而误删）。
fn norm_path(p: &str) -> String {
    let s = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
        .replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// 递归列出缓存目录里的文件（跳过下载中的临时文件）。返回 `(文件, 是否被上限截断)`。
fn scan_cache_files(dir: &Path, limit: usize) -> (Vec<(PathBuf, u64)>, bool) {
    let mut out: Vec<(PathBuf, u64)> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    let mut truncated = false;
    'outer: while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            if out.len() >= limit {
                truncated = true;
                break 'outer;
            }
            let p = e.path();
            let Ok(meta) = e.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(p);
                continue;
            }
            if is_in_progress(&p) {
                continue;
            }
            out.push((p, meta.len()));
        }
    }
    (out, truncated)
}

/// `POST /api/cache/clear` —— 清理**缓存字节**的唯一端点。
///
/// 三种互斥的范围表达（与任务记录侧同构）：
/// - 无参 / `?scope=all`：下载目录内全部缓存字节（向后兼容）；
/// - `?scope=orphan|stale|failed`（陈旧档可带 `&olderThanDays=N`）：按档清理；
/// - `?ids=1,2,3`：按**集合**清理（用户在清理中心勾选的那几条）。
///
/// 不变量：**外部文件永不删**（`inside_dir` 判定，跳过并计数）；返回值如实报
/// `removed` / `skipped` / `bytesFreed`；**条目本身永不删除** —— 清字节后条目回到
/// 「仅入库」态、可重新缓存，删条目属媒体库域（BUG-051 的边界）。
pub async fn clear(
    State(st): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let dir = download_dir(&st).await;

    // —— 集合档：用户勾选的那几条 ——
    if let Some(raw) = q.get("ids") {
        let ids = parse_ids(raw)?;
        if ids.is_empty() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "ids provided but empty: nothing selected",
            ));
        }
        let items = list_items(&st).await?;
        let mut acc = Purged::default();
        let mut hit = 0u64;
        for it in items.iter().filter(|x| ids.contains(&x.id)) {
            hit += 1;
            let p = purge_item(&st, &dir, it).await;
            acc.add(p);
        }
        st.push_log(&format!(
            "/api/cache/clear ids={} hit={hit} removed={} skipped={} bytes={}",
            ids.len(),
            acc.removed,
            acc.skipped,
            acc.bytes
        ));
        return Ok(Json(json!({
            "ok": true,
            "scope": "ids",
            "selected": ids.len(),
            "hit": hit,
            "removed": acc.removed,
            "skipped": acc.skipped,
            "bytesFreed": acc.bytes,
        })));
    }

    let scope = ClearScope::parse(q.get("scope").map(String::as_str).unwrap_or("all")).ok_or_else(
        || {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid clear scope: expected all|orphan|stale|failed",
            )
        },
    )?;
    let days = parse_days(q.get("olderThanDays"))?;

    // —— 孤儿档：清的是磁盘上**没有条目指向**的文件，条目侧无行可改 ——
    if scope == ClearScope::Orphan {
        let items = list_items(&st).await?;
        let known: HashSet<String> = items.iter().map(|i| norm_path(&i.file_path)).collect();
        let (files, truncated) = scan_cache_files(&dir, ORPHAN_SCAN_LIMIT);
        let mut acc = Purged::default();
        for (p, size) in &files {
            let key = norm_path(&p.to_string_lossy());
            if known.contains(&key) {
                continue;
            }
            match std::fs::remove_file(p) {
                Ok(()) => {
                    acc.removed += 1;
                    acc.bytes += size;
                }
                Err(_) => acc.skipped += 1,
            }
        }
        st.push_log(&format!(
            "/api/cache/clear scope=orphan removed={} skipped={} bytes={} truncated={truncated}",
            acc.removed, acc.skipped, acc.bytes
        ));
        return Ok(Json(json!({
            "ok": true,
            "scope": "orphan",
            "removed": acc.removed,
            "skipped": acc.skipped,
            "bytesFreed": acc.bytes,
            "truncated": truncated,
        })));
    }

    // —— 全部 / 陈旧 / 故障残留：都在条目清单上过筛 ——
    let items = list_items(&st).await?;
    let failed_keys = if scope == ClearScope::Failed {
        failed_ref_keys(&st).await?
    } else {
        HashSet::new()
    };
    let now = now_secs();
    let mut acc = Purged::default();
    for it in items.iter() {
        let keep = match scope {
            ClearScope::All => true,
            ClearScope::Stale => age_days(&it.file_path, now) >= days,
            ClearScope::Failed => failed_keys.contains(&it.ref_key),
            ClearScope::Orphan => unreachable!("orphan 档已提前返回"),
        };
        if !keep {
            continue;
        }
        let p = purge_item(&st, &dir, it).await;
        acc.add(p);
    }
    st.push_log(&format!(
        "/api/cache/clear scope={} olderThanDays={days} removed={} skipped={} bytes={}",
        scope.as_str(),
        acc.removed,
        acc.skipped,
        acc.bytes
    ));
    Ok(Json(json!({
        "ok": true,
        "scope": scope.as_str(),
        "removed": acc.removed,
        "skipped": acc.skipped,
        "bytesFreed": acc.bytes,
        "olderThanDays": if scope == ClearScope::Stale { Some(days) } else { None },
    })))
}

/// `GET /api/cache/clear/preview` —— 清理的**只读预览**：先看清影响面，再决定动不动手。
///
/// 设置页那个按钮此前是「一按全清」，用户唯一的粒度就是「全清」；知道会释放多少、
/// 涉及哪几条、其中多少是孤儿、多少是外部文件不参与，是能不能按下确认的前提。
///
/// **本端点不产生任何删除**（不删文件、不改 `file_path`、不动任务）——只读，
/// 可以随便点、随便刷新。
pub async fn clear_preview(
    State(st): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let dir = download_dir(&st).await;
    let days = parse_days(q.get("olderThanDays"))?;
    let items = list_items(&st).await?;
    let failed_keys = failed_ref_keys(&st).await?;
    let now = now_secs();

    let (mut count, mut bytes) = (0u64, 0u64);
    let (mut external, mut external_bytes) = (0u64, 0u64);
    let (mut stale_count, mut stale_bytes) = (0u64, 0u64);
    let (mut failed_count, mut failed_bytes) = (0u64, 0u64);
    let mut by_chat: BTreeMap<i64, (u64, u64)> = BTreeMap::new();
    let mut detail = Vec::new();

    for it in items.iter() {
        // 文件可能已被手工删掉：`bytes` 记 0 而不是报错（预览必须容错，
        // 它面对的是随时在变的磁盘，不是一张静态表）。
        let size = std::fs::metadata(&it.file_path).map(|m| m.len()).unwrap_or(0);
        let inside = inside_dir(&dir, &it.file_path);
        let age = age_days(&it.file_path, now);
        let failed = failed_keys.contains(&it.ref_key);
        let chat = chat_of(&it.source, &it.ref_key);

        if inside {
            count += 1;
            bytes += size;
            if age >= days {
                stale_count += 1;
                stale_bytes += size;
            }
        } else {
            // 外部文件：**永不删除**，但仍要如实告诉用户「有 N 个不参与」，
            // 否则「全清之后占用没归零」会被当成清不干净。
            external += 1;
            external_bytes += size;
        }
        if failed {
            failed_count += 1;
            failed_bytes += size;
        }
        if let Some(c) = chat {
            let e = by_chat.entry(c).or_default();
            e.0 += 1;
            e.1 += size;
        }
        if detail.len() < PREVIEW_ITEM_LIMIT {
            detail.push(json!({
                "id": it.id,
                "title": it.title,
                "chatId": chat,
                "bytes": size,
                "ageDays": age,
                "inside": inside,
                "failed": failed,
            }));
        }
    }

    let known: HashSet<String> = items.iter().map(|i| norm_path(&i.file_path)).collect();
    let (files, truncated) = scan_cache_files(&dir, ORPHAN_SCAN_LIMIT);
    let (mut orphan_count, mut orphan_bytes) = (0u64, 0u64);
    for (p, size) in &files {
        if known.contains(&norm_path(&p.to_string_lossy())) {
            continue;
        }
        orphan_count += 1;
        orphan_bytes += size;
    }

    Ok(Json(json!({
        "ok": true,
        "downloadDir": dir.to_string_lossy(),
        "olderThanDays": days,
        "total": {"count": count, "bytes": bytes},
        "orphan": {"count": orphan_count, "bytes": orphan_bytes, "truncated": truncated},
        "external": {"count": external, "bytes": external_bytes, "removable": false},
        "stale": {"count": stale_count, "bytes": stale_bytes},
        "failed": {"count": failed_count, "bytes": failed_bytes},
        "byChat": by_chat
            .into_iter()
            .map(|(chat_id, (c, b))| json!({"chatId": chat_id, "count": c, "bytes": b}))
            .collect::<Vec<_>>(),
        "items": detail,
        "itemsTruncated": items.len() > PREVIEW_ITEM_LIMIT,
    })))
}

/// 复位 TG 侧的 `downloaded` 标记（TG 来源条目专用；其它来源无此状态）。
async fn reset_tg_flag(st: &Arc<AppState>, source: &str, ref_key: &str) {
    if source != "tg" {
        return;
    }
    if let Some((chat, msg)) = parse_tg_ref(ref_key) {
        let _ = st.store.clear_downloaded(chat, msg).await;
    }
}

/// `DELETE /api/cache/tasks/:id` — 删除**单条**任务记录（任何状态）。
///
/// 缺陷原形（BUG-051）：旧 `DELETE /api/tg/cache/tasks/:id` 只能「取消」活跃任务，
/// 对终态任务直接 404——面板里那条记录**永远删不掉**。
/// 活跃任务在这里也会被删（先置 cancelled 让 worker 退出，再删行）。
async fn delete_task(
    State(st): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let hit = st
        .store
        .delete_cache_task(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !hit {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found"));
    }
    st.refresh_cache_tasks().await;
    st.push_log(&format!("/api/cache/tasks/{id}: record deleted"));
    Ok(Json(json!({"ok": true})))
}

/// `POST /api/cache/tasks/:id/retry` — **原任务重试**（BUG-078）。
///
/// 与「重试=重新入队」的区别：旧前端 `retry` 调 `enqueueCacheTask`，后端只对**活跃**
/// 任务幂等复用，终态任务会 `INSERT` 新行——于是列表里出现「一条失败 + 一条新 queued」，
/// 用户看到的就是「重试新建任务」。这里按 id 复位终态行（同一条、进度从 0 重跑），
/// 列表里仍是同一个 id，不再增生记录。
async fn retry_task(
    State(st): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<CacheTask>, ApiError> {
    let Some(task) = st
        .store
        .retry_cache_task(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found"));
    };
    st.refresh_cache_tasks().await;
    spawn_cache_task(st.clone(), task.id);
    st.push_log(&format!("/api/cache/tasks/{id}: retried (same id)"));
    Ok(Json(task))
}

/// `DELETE /api/cache/tasks?scope=all|success|failed` 或 `?ids=1,2,3`
/// —— 批量清除任务记录的**唯一端点**。
///
/// 此前为「清除终态」和「清空全部」各开一个端点，于是「清空失败」「清空成功」就会顺理成章
/// 地再加两个——动词被当成枚举对象，必然无限叠加。现在**动词只有一个**，
/// 差异走参数，两种范围表达：
/// - `scope=` 整档（[`crate::store::TaskClearScope`]，三档并集为全集）；
/// - `ids=` 用户勾选的**具体集合**（面板的「全选 / 部分选择」）——选择本身是诉求，
///   枚举档位追不上（清空失败 / 清空成功 / 清空中断…）。两者互斥。
///
/// 活跃任务（queued/running）**只有 `scope=all` 或显式勾选到它**才会清除
/// （先置 cancelled 停 worker）；其余情况永不误伤正在跑的任务。
/// 非活跃类记录清的是历史，**不影响任何磁盘字节**。
pub async fn clear_tasks(
    State(st): State<Arc<AppState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(raw) = q.get("ids") {
        let ids = parse_ids(raw)?;
        if ids.is_empty() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "ids provided but empty: nothing selected",
            ));
        }
        let want = ids.len();
        let removed = st
            .store
            .delete_cache_tasks_by_ids(&ids)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        st.refresh_cache_tasks().await;
        st.push_log(&format!(
            "/api/cache/tasks ids={want} removed={removed}"
        ));
        return Ok(Json(
            json!({"ok": true, "removed": removed, "selected": want}),
        ));
    }
    let scope = TaskClearScope::parse(q.get("scope").map(String::as_str).unwrap_or("all"))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid clear scope: expected all|success|failed",
            )
        })?;
    let removed = st
        .store
        .clear_cache_tasks(scope)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    st.refresh_cache_tasks().await;
    st.push_log(&format!("/api/cache/tasks scope={scope:?} removed={removed}"));
    Ok(Json(json!({"ok": true, "removed": removed, "scope": match scope {
        TaskClearScope::All => "all",
        TaskClearScope::Success => "success",
        TaskClearScope::Failed => "failed",
    }})))
}

/// 解析 `?ids=1,2,3`。
///
/// 非法项**直接 422，不静默跳过** —— 默默忽略只会让「删除所选」少删几条，
/// 而界面显示成功，是最难查的一类不一致。重复项去重（勾选集合天然唯一，
/// 但参数是外部输入）。
fn parse_ids(raw: &str) -> Result<Vec<i64>, ApiError> {
    const MAX: usize = 1000;
    let mut out: Vec<i64> = Vec::new();
    for part in raw.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let id = p.parse::<i64>().map_err(|_| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                &format!("invalid id in ids: {p}"),
            )
        })?;
        if id <= 0 {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "ids must be positive integers",
            ));
        }
        out.push(id);
    }
    out.sort_unstable();
    out.dedup();
    if out.len() > MAX {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("too many ids (max {MAX})"),
        ));
    }
    Ok(out)
}

/// `GET /api/cache/stats` — 缓存占用（`files` / `bytes` / `external`）。
///
/// 「清除缓存文件」是释放磁盘的动作，**不知道占多少就是盲操作**——这是此前漏掉的必需项。
/// `bytes` 只统计真实存在的、**位于下载目录内**的字节；`external` 是导入/扫描带进来的
/// 外部文件（永不删除，只如实计数）。
async fn stats(
    State(st): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let dir = download_dir(&st).await;
    let items = st
        .store
        .list_cached_items()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let (mut bytes, mut files, mut external) = (0u64, 0u64, 0u64);
    for it in items {
        if !inside_dir(&dir, &it.file_path) {
            external += 1;
            continue;
        }
        if let Ok(m) = std::fs::metadata(&it.file_path) {
            if m.is_file() {
                bytes += m.len();
                files += 1;
            }
        }
    }
    Ok(Json(json!({"ok": true, "files": files, "bytes": bytes, "external": external})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_dir_accepts_child_and_rejects_sibling() {
        let base = std::env::temp_dir().join(format!("orig_cache_inside_{}", std::process::id()));
        let inner = base.join("cache");
        std::fs::create_dir_all(&inner).unwrap();
        let file = inner.join("a.mp4");
        std::fs::write(&file, b"x").unwrap();
        let outside = std::env::temp_dir().join(format!("orig_cache_outside_{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();

        assert!(inside_dir(&inner, &file.to_string_lossy()));
        assert!(!inside_dir(&inner, &outside.to_string_lossy()));
        // 文件已不存在：退到父目录判定，仍算目录内（清缓存可幂等重入）。
        assert!(inside_dir(&inner, &inner.join("gone.mp4").to_string_lossy()));
    }

    /// `?ids=` 解析：去重排序、空白容忍；非法项必须**报错**而不是被跳过。
    #[test]
    fn parse_ids_rejects_garbage_and_dedups() {
        // 用 `.ok()` 比较（ApiError 未实现 Debug，不影响断言表达力）
        assert_eq!(parse_ids("3, 1,2,1").ok(), Some(vec![1, 2, 3]));
        assert_eq!(parse_ids("").ok(), Some(Vec::<i64>::new()));
        assert!(parse_ids("1,x").is_err(), "非法 id 必须 422，不能静默丢弃");
        assert!(parse_ids("0").is_err(), "0 不是合法任务 id");
        assert!(parse_ids("-2").is_err(), "负数不是合法任务 id");
    }

    /// 清理档与阈值解析：**非法即报错**，绝不静默回落到「全清」或默认天数 ——
    /// 静默回落会让「只清 7 天前的」实际清掉刚下载的东西，而界面显示成功。
    #[test]
    fn clear_scope_and_days_parse_strictly() {
        assert_eq!(ClearScope::parse("all"), Some(ClearScope::All));
        assert_eq!(ClearScope::parse("orphan"), Some(ClearScope::Orphan));
        assert_eq!(ClearScope::parse("stale"), Some(ClearScope::Stale));
        assert_eq!(ClearScope::parse("failed"), Some(ClearScope::Failed));
        assert!(ClearScope::parse("everything").is_none(), "未知档必须 422，不能默认成全清");

        assert_eq!(parse_days(None).ok(), Some(DEFAULT_STALE_DAYS));
        assert_eq!(parse_days(Some(&"7".to_string())).ok(), Some(7));
        assert!(parse_days(Some(&"0".to_string())).is_err(), "0 天会清掉刚下的东西");
        assert!(parse_days(Some(&"abc".to_string())).is_err());
        assert!(parse_days(Some(&"-3".to_string())).is_err());
    }

    /// 孤儿扫描：递归子目录、跳过下载中的临时文件、被上限截断时如实标注。
    #[test]
    fn scan_skips_in_progress_and_walks_subdirs() {
        let base = std::env::temp_dir().join(format!("orig_cache_scan_{}", std::process::id()));
        let sub = base.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(base.join("a.mp4"), b"aa").unwrap();
        std::fs::write(sub.join("b.mp4"), b"bbbb").unwrap();
        std::fs::write(base.join("c.mp4.part"), b"partial").unwrap();
        std::fs::write(base.join("d.mp4.tmp"), b"tmp").unwrap();

        let (files, truncated) = scan_cache_files(&base, 100);
        let names: Vec<String> = files
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"a.mp4".to_string()));
        assert!(names.contains(&"b.mp4".to_string()), "子目录必须递归到");
        assert!(
            !names.iter().any(|n| n.ends_with(".part")),
            "下载中的 .part 不是孤儿，删它等于打断下载"
        );
        assert!(!names.iter().any(|n| n.ends_with(".tmp")));
        assert!(!truncated);

        let (capped, hit) = scan_cache_files(&base, 1);
        assert_eq!(capped.len(), 1, "上限必须生效");
        assert!(hit, "被上限截断要如实标注，不能静默少报");
    }

    /// 路径归一：同一文件的不同拼法必须折叠成同一个键，否则预览会虚报孤儿。
    #[test]
    fn norm_path_folds_separators_and_case_on_windows() {
        let base = std::env::temp_dir().join(format!("orig_cache_norm_{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let f = base.join("Mixed.mp4");
        std::fs::write(&f, b"x").unwrap();

        let a = norm_path(&f.to_string_lossy());
        let b = norm_path(&f.to_string_lossy().replace('/', "\\"));
        assert_eq!(a, b, "分隔符差异不得让同一个文件变成两个键");
        if cfg!(windows) {
            assert_eq!(a, norm_path(&f.to_string_lossy().to_uppercase()));
        }
    }

    /// 陈旧判据取不到时间戳时返回 0（= 不算陈旧）：宁可少删，不可误删。
    #[test]
    fn age_of_missing_file_is_zero() {
        let missing = std::env::temp_dir().join("orig_cache_definitely_missing.mp4");
        assert_eq!(age_days(&missing.to_string_lossy(), now_secs()), 0);
    }
}
