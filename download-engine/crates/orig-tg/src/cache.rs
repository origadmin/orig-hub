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
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
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
        // 重试是同一条记录的**状态复位**（不是新动词）：复用既有 handler。
        .route("/api/cache/tasks/:id/retry", post(retry_task))
        // BUG-249：单条之外的**批量**动作（面板上几十条 failed 逐条点不动）。
        // 仍然遵守「一个动词一个端点，差异走参数」：`?ids=1,2,3` 是参数，
        // 不是「又一个场景又一个端点」——批量与单条最终调**同一个状态迁移内核**。
        // 路由顺序：matchit 静态段优先于参数段，故 `/api/cache/tasks/retry` 不会被
        // `/api/cache/tasks/:id`（仅 DELETE）吃掉；两者的方法也不冲突。
        .route("/api/cache/tasks/retry", post(retry_tasks))
        .route("/api/cache/tasks/cancel", post(cancel_tasks))
}

/// 生效的下载目录（运行期设置覆盖 env 默认值）——缓存字节的**唯一可删区**。
///
/// A leading `~` from the stored setting (user-typed) is expanded here, so the
/// literal tilde never reaches the filesystem (BUG-071).
/// 下载落点当前生效值（= 受管根 / 权限边界）。
///
/// BUG-323：**委托** [`crate::store::Store::download_root`]（env
/// `ORIG_TG_DOWNLOAD_DIR` > app_setting `download_dir` > 平台默认下载目录）。
/// 此前这里自成一条链（app_setting > `st.config.download_dir`），与
/// `routes::effective_download_dir` 各算一套 —— 下载路径是全部文件的唯一容器，
/// 只允许一处解析。
pub async fn download_dir(st: &AppState) -> PathBuf {
    st.store.download_root().await
}

// ---- 库根（byte-ownership P2：归仓移动 + 相对路径） ----

/// 库内条目路径 → 磁盘绝对路径（P2 的**唯一**解析器）。
///
/// `media_item.file_path` 自 P2 起存**库根相对路径**（归仓产出）；存量条目仍是
/// 绝对路径。规则：绝对 → 原样（存量兼容，一字不改）；相对 → join 库根。
/// **所有**读条目字节的路径都必须先过这一道——直接 stat 相对路径会把
/// 「文件在库里」误判成「文件没了」。
pub fn resolve_item_path(lib_root: &Path, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        lib_root.join(p)
    }
}

/// 词法归一化（**不触盘**）：折叠 `.` / `..`，保留盘符与根。
///
/// 供权限边界判定使用 —— 目标路径可能尚不存在（新落点），`canonicalize` 会失败，
/// 用它做边界会给「还没写盘的路径」假阴性，把正常写入判成越界。
pub fn lexical_normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            // 根之上的 `..` 直接丢弃（`/..` == `/`，Windows 上 `C:\..` == `C:\`）
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `child` 是否落在 `root` 之内（含 root 自身）。Windows 下大小写不敏感。
///
/// 用词法归一化后比较，不做符号链接解析（见 [`lexical_normalize`]）。
pub fn path_within(root: &Path, child: &Path) -> bool {
    let r = lexical_normalize(root);
    let c = lexical_normalize(child);
    if r.as_os_str().is_empty() {
        return false;
    }
    #[cfg(windows)]
    {
        let rs = r.to_string_lossy().to_lowercase();
        let cs = c.to_string_lossy().to_lowercase();
        let rs = rs.trim_end_matches(['\\', '/']);
        cs == rs
            || cs.starts_with(&format!("{rs}\\"))
            || cs.starts_with(&format!("{rs}/"))
    }
    #[cfg(not(windows))]
    {
        c.starts_with(&r)
    }
}

/// 路径是否落在**任一**受管根之内（管理模块多根模型，BUG-323 续）。
pub fn path_within_any(roots: &[PathBuf], path: &Path) -> bool {
    roots.iter().any(|r| path_within(r, path))
}

/// 受管路径解析（管理模块并集闸门）：[`resolve_item_path`] 之后必须落在**任一**
/// 受管根之内，越界返回 `None`（调用方一律 403/Forbidden）。
///
/// 与下载模块单根闸门 [`resolve_managed_path`] 平行：下载模块仍守 `download_root`
/// （下载单根），本函数给管理模块用，覆盖受管根之并集。
pub fn resolve_managed_path_union(roots: &[PathBuf], path: &str) -> Option<PathBuf> {
    let resolved = resolve_item_path(Path::new(""), path);
    if path_within_any(roots, &resolved) {
        Some(resolved)
    } else {
        None
    }
}

/// 受管路径解析（BUG-323 权限边界）：[`resolve_item_path`] 之后必须落在
/// **下载路径**之内，越界返回 `None`（调用方一律 403）。
///
/// 为什么边界是下载路径而不是库根：用户 2026-10-16 裁定「下载路径是所有权限的
/// 限制路径」—— 库根、代理、下载成品都同居其下；任何一条记录（含历史写入的
/// 绝对路径，例如旧库根 `…/AppData/…/tg/library/x.mp4`）指到界外即越界。
pub fn resolve_managed_path(download_root: &Path, lib_root: &Path, path: &str) -> Option<PathBuf> {
    let resolved = resolve_item_path(lib_root, path);
    if path_within(download_root, &resolved) {
        Some(resolved)
    } else {
        None
    }
}

/// 文件名安全片段：保留字母数字与 `-._`，其余（空格/斜体符号/路径分隔符…）
/// 折叠为 `-`，折叠产生的连续 `-` 不重复，掐头去尾，上限 40 字符。空结果返回 None。
///
/// 用于归仓命名（`<chatSlug>-<chatId>/<messageId>-<titleSlug>.<ext>`）——
/// 标题/caption 是任意用户文本，直接进文件名会出现非法字符或路径穿越。
pub fn slugify(s: &str) -> Option<String> {
    const MAX: usize = 40;
    let mut out = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        return None;
    }
    Some(out.chars().take(MAX).collect())
}

/// 归仓结果：`media_item.file_path` 该回填什么、文件实际在哪。
#[derive(Debug, Clone)]
pub struct HousedBytes {
    /// 回填 `media_item.file_path` 的规范值：归仓成功 = **库根相对路径**
    /// （正斜杠，跨平台稳定）；降级 = 原落盘**绝对路径**（I2 降级条款）。
    pub item_path: String,
    /// 实际落盘的绝对路径（`mark_downloaded` / 响应 `absolutePath` 用）。
    pub absolute_path: String,
}

/// 把下载完成的文件**移动**进库根（I2 归仓 = 移动，不拷贝）。
///
/// 命名 `<库根>/<chatSlug>-<chatId>/<messageId>-<titleSlug>.<ext>`——用**稳定标识**
/// （消息号 + 标题 slug）而非集号：集号会因移动/重编号漂移，消息号永不
/// （对设计 §4-P2 命名的有意偏离，理由 = 稳定性，文档已注明）。
/// 两步走：先 rename 到目标目录内的临时名（同卷原子），再 rename 到最终名
/// （原子发布）——最终名从不以半成品形态出现。
///
/// 降级（I2）：mkdir / rename 失败（跨盘、权限、源缺失）→ 文件**留在原位**，
/// 回填绝对路径，warn 日志——登记事实不回滚。
pub async fn house_downloaded_bytes(
    st: &AppState,
    chat_id: i64,
    message_id: i64,
    src: &str,
    title: Option<&str>,
) -> HousedBytes {
    let fallback = || HousedBytes {
        item_path: src.to_string(),
        absolute_path: src.to_string(),
    };
    let lib_root = st.store.library_root().await;
    // chatSlug 取频道标题（未监控频道退化 "chat"）；titleSlug 取 caption 首行。
    let chat_slug = st
        .store
        .list_channels()
        .await
        .ok()
        .and_then(|chs| {
            chs.into_iter()
                .find(|c| c.channel_id == chat_id)
                .map(|c| c.title)
        })
        .and_then(|t| slugify(&t))
        .unwrap_or_else(|| "chat".to_string());
    let title_slug = title
        .and_then(slugify)
        .unwrap_or_else(|| "media".to_string());
    let ext = Path::new(src)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let chat_dir = format!("{chat_slug}-{chat_id}");
    let final_name = format!("{message_id}-{title_slug}{ext}");
    match house_into(&lib_root, &chat_dir, &final_name, Path::new(src)).await {
        Ok(final_abs) => {
            let rel = format!("{}/{}", chat_dir.replace('\\', "/"), final_name);
            HousedBytes {
                item_path: rel,
                absolute_path: final_abs.to_string_lossy().into_owned(),
            }
        }
        Err(e) => {
            let msg = format!(
                "house_bytes: move into library root failed for {src} -> \
                 {chat_dir}/{final_name}: {e}; keeping original location (degraded, I2)"
            );
            tracing::warn!("{msg}");
            st.push_log(&format!("WARN {msg}"));
            fallback()
        }
    }
}

/// 归仓的纯磁盘动作（`house_downloaded_bytes` 的内核，测试直接驱动注入失败）：
/// `mkdir -p <root>/<chat_dir>` → `rename src -> tmp` → `rename tmp -> final`。
/// 任一步失败即原样返回错误（调用方降级），不留半成品：tmp 与 final 同目录，
/// rename 原子；tmp 残留只在「第二步失败」时可能存在，同名下次归仓会覆盖。
async fn house_into(
    lib_root: &Path,
    chat_dir: &str,
    final_name: &str,
    src: &Path,
) -> std::io::Result<PathBuf> {
    let target_dir = lib_root.join(chat_dir);
    let final_abs = target_dir.join(final_name);
    let tmp = target_dir.join(format!(
        ".incoming-{}{final_name}",
        now_secs_pid_suffix()
    ));
    tokio::fs::create_dir_all(&target_dir).await?;
    // 同卷移动；跨盘 rename 会整体失败 → 调用方降级（绝不静默拷贝出第二份，D1）。
    tokio::fs::rename(src, &tmp).await?;
    tokio::fs::rename(&tmp, &final_abs).await?;
    Ok(final_abs)
}

fn now_secs_pid_suffix() -> String {
    let ts = now_secs();
    format!("{}-{}", ts, std::process::id())
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

/// 磁盘字节真值（BUG-101）：`file_path` 只是数据库里的**承诺**，不是字节本身。
///
/// 三态而非布尔，是为了不重蹈 `inside_dir` 的覆辙——它在 canonicalize 失败时
/// 静默返回 `false`，把「判断不出来」和「确实不在目录内」混为一谈。
/// 这里同理：`Unknown` 必须能被区分，因为两种后续动作完全不同。
// BUG-132：`BytesPresence` 现在要随条目一起下发到前端（条目视图与分集视图共用同一判据），
// 故补 `Serialize`。`lowercase` → JSON 里是 `"present" / "missing" / "unknown"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BytesPresence {
    /// 文件存在且非空 → 可以走本地播放。
    Present,
    /// **确认**不在磁盘上（不存在 / 零字节 / 不是文件）→ 状态必须复位。
    Missing,
    /// stat 失败但**不是**「不存在」（权限、文件被独占、路径非法…）→ 判定失败。
    /// 既不声称可本地播，也**不**复位状态（不该为一次瞬态错误让条目重新走一遍下载）。
    Unknown,
}

/// 探测落盘字节是否真的可用（BUG-101）。
///
/// 用 `tokio::fs` 而非 `std::fs`：调用方都在 async 读路径上，同步 syscall 会占住运行时线程。
/// 成本是**每次一个 stat 系统调用**（微秒级、不碰 DB），一次列表至多 stat 该频道已缓存的行数；
/// 典型的几十行远低于一次 DB 查询，故不做批量上限裁剪——裁剪等于放行未校验项，
/// BUG-101（「已缓存」却 404）会原样复发。
pub async fn probe_cached_bytes(path: &str) -> BytesPresence {
    if path.trim().is_empty() {
        return BytesPresence::Missing;
    }
    match tokio::fs::metadata(path).await {
        // 零字节文件 = 下载写成半截就断了，与「文件没了」同样不可播。
        Ok(m) if m.is_file() && m.len() > 0 => BytesPresence::Present,
        Ok(_) => BytesPresence::Missing,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BytesPresence::Missing,
        Err(_) => BytesPresence::Unknown,
    }
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

    // BUG-109：删文件失败**不能**被吞掉再报 `cleared: true` —— 那是把失败说成成功。
    //
    // D24-A（BUG-309）：先 release（`clear_item_bytes` 一并置空 file_path/hash），
    // **只有归零才 unlink** —— 共享 blob 的其余条目不能因为清了一条就变死链。
    let orphan = st
        .store
        .clear_item_bytes(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if orphan.unwrap_or(true) {
        std::fs::remove_file(&path).map_err(|e| {
            st.push_log(&format!("/api/cache/items/{id}: remove_file failed: {e}"));
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to delete cache file: {e}"),
            )
        })?;
    }
    // TG 来源：字节没了要同步复位 downloaded，否则「已缓存」状态说谎。
    // 复位失败同样如实报错（否则条目会在下次 upsert 时复活 —— BUG-029）。
    if !reset_tg_flag(&st, &item.source, &item.ref_key).await {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cache bytes cleared but the downloaded flag could not be reset; \
             the entry may reappear on the next sync",
        ));
    }

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
    /// 删除或状态复位**失败**的条数（BUG-109）。
    ///
    /// 没有它之前，`purge_item` 无论成败都返回 `removed: 1` —— 用户看到
    /// 「已清理 N 项、释放 X 字节」，而文件其实还在磁盘上。
    /// 这正是本函数注释里点名的那类不一致：「清字节却仍显示『已缓存』」。
    failed: u64,
    bytes: u64,
}

impl Purged {
    fn add(&mut self, p: Purged) {
        self.removed += p.removed;
        self.skipped += p.skipped;
        self.failed += p.failed;
        self.bytes += p.bytes;
    }
}

/// 清掉**一条**条目的字节：删除文件 → 置空 `file_path` → 复位 TG `downloaded`。
///
/// 集合档与分档共用同一实现，避免「某条路忘了复位 TG 标记」这类分支漂移
/// （清字节却仍显示「已缓存」是最难查的一类不一致）。
///
/// byte-ownership I3（P2 起生效）：**库根内的字节一律跳过**——归仓产出视为有主，
/// 与导入/扫描的外部文件同档（「媒体库里的一切都可导出，暂存区里的一切都可丢弃」）。
async fn purge_item(st: &Arc<AppState>, dir: &Path, lib_root: &Path, it: &CachedBytesDetail) -> Purged {
    // 归仓字节：file_path 是库根相对路径；或（库根被配进下载目录内的极端配置）
    // 解析后落在库根内 —— 两种形态都不进清理工作集。
    let is_housed = !Path::new(&it.file_path).is_absolute();
    if is_housed || inside_dir(lib_root, &resolve_item_path(lib_root, &it.file_path).to_string_lossy()) {
        return Purged {
            skipped: 1,
            ..Default::default()
        };
    }
    if !inside_dir(dir, &it.file_path) {
        // 外部文件（导入/扫描贴进来的）不是缓存产出的字节，永不删除，只如实计数。
        return Purged {
            skipped: 1,
            ..Default::default()
        };
    }
    let bytes = std::fs::metadata(&it.file_path).map(|m| m.len()).unwrap_or(0);
    // BUG-109：两步都不能静默 —— 任一步失败，这条就**没有真正清掉**，
    // 却会被计成 removed，用户于是以为清理成功（而文件还在、条目仍显示已缓存）。
    //
    // D24-A（BUG-309）：删字节升级为「**删最后一个引用才回收**」。`clear_item_bytes`
    // 在**同一处**完成「release 旧 hash → 置空 file_path + content_hash」，并回传
    // 是否归零（`orphan`）—— 只有归零才真 unlink，共享 blob 的其余条目不会变死链
    // （BUG-100 的教训：共享必须计数）。release 与置空必须同处，分两处会双重计数。
    let orphan = match st.store.clear_item_bytes(it.id).await {
        Ok(o) => o,
        Err(e) => {
            st.push_log(&format!(
                "purge_item: clear_item_bytes failed for id={} hash={:?}: {e}",
                it.id, it.content_hash
            ));
            return Purged {
                removed: 0,
                skipped: 0,
                failed: 1,
                bytes: 0,
            };
        }
    };
    // 无 hash（存量未纳入）或归零 ⇒ 可回收字节；有 hash 且仍有其他引用 ⇒ 字节留给别人。
    let removed_file = if orphan.unwrap_or(true) {
        std::fs::remove_file(&it.file_path)
    } else {
        Ok(())
    };
    let mut failed = 0u64;
    if let Err(e) = &removed_file {
        failed = 1;
        st.push_log(&format!(
            "purge_item: remove_file failed for {} (id={}): {e}",
            it.file_path, it.id
        ));
    }
    // TG 来源的 downloaded 复位失败同样算失败：字节没了但标记还在，条目会「复活」。
    if !reset_tg_flag(st, &it.source, &it.ref_key).await {
        failed = 1;
    }
    if failed > 0 {
        return Purged {
            removed: 0,
            skipped: 0,
            failed,
            bytes: 0,
        };
    }
    Purged {
        removed: 1,
        skipped: 0,
        failed: 0,
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

/// 单个登记文件的磁盘字节：**是普通文件才有值**（BUG-136 起 `stats` 与
/// `clear/preview` 共用的唯一口径）。
///
/// 此前两处各写一套：`preview` 用 `metadata().map(len)`（目录也会算出一个长度），
/// `stats` 用 `metadata()` + `is_file()`（只数文件）。同一事实两套实现必然漂移，
/// 故收口到这一处。文件可能已被手工删掉：返回 `None` 而不是报错 —— 读数面对的
/// 是随时在变的磁盘，不是一张静态表。
fn file_len(path: &str) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
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
/// 删掉等于打断下载。判据看后缀，另加一条：落在内容寻址暂存区
/// `<下载目录>/.blobs/_tmp/` 下的任何文件都视为「正在写」（M2-T09，blob 无固定后缀）。
fn is_in_progress(p: &Path) -> bool {
    crate::blob::is_tmp_path(p)
        || matches!(
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
                // 内容寻址暂存区 `<下载目录>/.blobs/_tmp/` 永不纳入孤儿扫描：
                // 里面的文件正被 worker 写着，且 blob 无扩展名，靠 `is_in_progress`
                // 兜不住整棵子树 —— 直接剪枝。
                if p.file_name().and_then(|s| s.to_str()) == Some(crate::blob::TMP_DIR) {
                    continue;
                }
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
        let lib_root = st.store.library_root().await;
        let mut acc = Purged::default();
        let mut hit = 0u64;
        for it in items.iter().filter(|x| ids.contains(&x.id)) {
            hit += 1;
            let p = purge_item(&st, &dir, &lib_root, it).await;
            acc.add(p);
        }
        st.push_log(&format!(
            "/api/cache/clear ids={} hit={hit} removed={} skipped={} failed={} bytes={}",
            ids.len(),
            acc.removed,
            acc.skipped,
            acc.failed,
            acc.bytes
        ));
        return Ok(Json(json!({
            "ok": true,
            "scope": "ids",
            "selected": ids.len(),
            "hit": hit,
            "removed": acc.removed,
            "skipped": acc.skipped,
            "failed": acc.failed,
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
    // 孤儿判定以「条目解析后的绝对路径」为准：P2 起 `file_path` 存的是库根
    // 相对路径，直接 canonicalize 会落在 CWD 下必然失配，等于把归仓字节当孤儿
    // 全删 —— 这是本端点最危险的误删面，故 `known` 集必须先过
    // [`resolve_item_path`] 再归一。
    let lib_root = st.store.library_root().await;
    let items = list_items(&st).await?;
    let known: HashSet<String> = items
        .iter()
        .map(|i| norm_path(&resolve_item_path(&lib_root, &i.file_path).to_string_lossy()))
        .collect();
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
            "/api/cache/clear scope=orphan removed={} skipped={} failed={} bytes={} truncated={truncated}",
            acc.removed, acc.skipped, acc.failed, acc.bytes
        ));
        return Ok(Json(json!({
            "ok": true,
            "scope": "orphan",
            "removed": acc.removed,
            "skipped": acc.skipped,
            "failed": acc.failed,
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
    let lib_root = st.store.library_root().await;
    let mut acc = Purged::default();
    for it in items.iter() {
        let keep = match scope {
            ClearScope::All => true,
            // 相对路径 = 库根相对，`age_days` 直接 stat 必然取不到 mtime 而
            // 返回 0（不算陈旧 → 宁可少删）。先解析再取年龄，口径与归仓前一致。
            ClearScope::Stale => {
                let p = resolve_item_path(&lib_root, &it.file_path);
                age_days(&p.to_string_lossy(), now) >= days
            }
            ClearScope::Failed => failed_keys.contains(&it.ref_key),
            ClearScope::Orphan => unreachable!("orphan 档已提前返回"),
        };
        if !keep {
            continue;
        }
        let p = purge_item(&st, &dir, &lib_root, it).await;
        acc.add(p);
    }
    st.push_log(&format!(
        "/api/cache/clear scope={} olderThanDays={days} removed={} skipped={} failed={} bytes={}",
        scope.as_str(),
        acc.removed,
        acc.skipped,
        acc.failed,
        acc.bytes
    ));
    Ok(Json(json!({
        "ok": true,
        "scope": scope.as_str(),
        "removed": acc.removed,
        "skipped": acc.skipped,
        "failed": acc.failed,
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
    // P2：file_path 可能是库根相对路径——展示/判定一律先解析到绝对。
    let lib_root = st.store.library_root().await;

    for it in items.iter() {
        let absolute = resolve_item_path(&lib_root, &it.file_path);
        let absolute = absolute.to_string_lossy().into_owned();
        // 文件可能已被手工删掉：`bytes` 记 0 而不是报错（预览必须容错，
        // 它面对的是随时在变的磁盘，不是一张静态表）。
        let size = file_len(&absolute).unwrap_or(0);
        let inside = inside_dir(&dir, &absolute);
        let age = age_days(&absolute, now);
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

    let known: HashSet<String> = items
        .iter()
        .map(|i| {
            norm_path(
                &resolve_item_path(&lib_root, &i.file_path)
                    .to_string_lossy(),
            )
        })
        .collect();
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
/// 复位 TG 来源的 `downloaded` 标记。**返回是否真的复位成功**（BUG-109）。
///
/// 此前是 `let _ = ...clear_downloaded(...)` —— 失败被静默吞掉。这恰恰是 BUG-029 点名的
/// 症状成因：清了字节但 `downloaded` 没复位，**下次缓存 upsert 会让条目「复活」**，
/// 用户看到的就是「删不掉」。它比「文件没删掉」更隐蔽：磁盘上确实没了，
/// 但界面仍显示已缓存。故调用方必须据此如实报错，不能假装成功。
/// 由 `routes::delete_media_item` 复用（删条目与清字节共用同一条「复位失败即如实报错」
/// 规则，不写第二套）——故为 `pub(crate)`。
pub(crate) async fn reset_tg_flag(st: &Arc<AppState>, source: &str, ref_key: &str) -> bool {
    if source != "tg" {
        // 非 TG 来源本就没有 downloaded 标记需要复位。
        return true;
    }
    let Some((chat, msg)) = parse_tg_ref(ref_key) else {
        // source 标着 tg 却解析不出 (chat, msg) —— 数据异常，留痕并如实报失败。
        st.push_log(&format!(
            "reset_tg_flag: cannot parse tg ref {ref_key:?}; downloaded flag left set"
        ));
        return false;
    };
    match st.store.clear_downloaded(chat, msg).await {
        Ok(_) => true,
        Err(e) => {
            st.push_log(&format!(
                "reset_tg_flag: clear_downloaded({chat},{msg}) failed: {e} \
                 （字节已清但 downloaded 仍为 true → 条目可能复活）"
            ));
            false
        }
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

/// 单条**重试**的状态迁移内核（唯一真源）。
///
/// 单条端点 `POST /api/cache/tasks/:id/retry` 与批量端点 `POST /api/cache/tasks/retry?ids=`
/// 都调它——批量循环调用同一个内核，**绝不另写一份状态机**（AGENTS.md §2）。
pub(crate) async fn retry_task_kernel(
    st: &Arc<AppState>,
    id: i64,
) -> Result<CacheTask, ApiError> {
    let Some(task) = st
        .store
        .retry_cache_task(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found"));
    };
    st.refresh_cache_tasks().await;
    // 复位后的任务交回**同一个** worker 入口（见文件头 import 注释）。
    spawn_cache_task(st.clone(), task.id);
    st.push_log(&format!("/api/cache/tasks/{id}: retried (same id)"));
    Ok(task)
}

/// 单条**取消**的状态迁移内核（唯一真源）。
///
/// 调用方：`DELETE /api/tg/cache/tasks/:id`（`routes::cancel_cache_task_route`）与
/// 批量端点 `POST /api/cache/tasks/cancel?ids=`。
/// 返回 `false` = 该 id 不存在，或它不是活跃任务（已结束，没有可取消的动作）。
pub(crate) async fn cancel_task_kernel(st: &Arc<AppState>, id: i64) -> Result<bool, ApiError> {
    // BUG-257：**先置令牌，再落库**。
    //
    // 顺序是刻意的：令牌是「够得着在途 IO」的判据，DB 状态只是呈现面。若先落库再置令牌，
    // 两次 await 之间 worker 可能正好取到未置位的令牌继续跑；而「先置位」时即便 DB 写
    // 随后失败，用户看到的也只是「取消没生效」而不是「传输被掐断却仍显示在跑」。
    //
    // 对**尚未起跑**的任务同样有效：token 表里那张已置位的令牌会被 worker 起跑时取到，
    // 于是「取消先到、worker 后起」的竞态方向只有一个 —— 不会漏取消。
    st.request_cache_cancel(id);
    let hit = st
        .store
        .cancel_cache_task(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    if !hit {
        // 没有活跃任务可取消：撤回刚才的令牌置位，避免留下一个永不生效的标志。
        // （worker 若已注销过令牌，这次撤回是无操作，幂等。）
        st.clear_cache_cancel(id);
        return Ok(false);
    }
    st.refresh_cache_tasks().await;
    st.push_log(format!("/api/cache/tasks/{id}: cancel requested (in-flight transfer will abort)"));
    Ok(true)
}

/// `POST /api/cache/tasks/:id/retry` — **原任务重试**（BUG-078）。
///
/// 与「重试=重新入队」的区别：旧前端 `retry` 调 `enqueueCacheTask`，后端只对**活跃**
/// 任务幂等复用，终态任务会 `INSERT` 新行——于是列表里出现「一条失败 + 一条新 queued」，
/// 用户看到的就是「重试新建任务」。这里按 id 复位终态行（同一条、进度从 0 重跑），
/// 列表里仍是同一个 id，不再增生记录。状态迁移在 [`retry_task_kernel`]。
async fn retry_task(
    State(st): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<CacheTask>, ApiError> {
    Ok(Json(retry_task_kernel(&st, id).await?))
}

/// 批量动作的状态门（单条端点共用同一门，见各自端点的注释）。
///
/// - `Retry`：只有 `failed` / `cancelled` / `interrupted` 能被复位。
///   **`done` 不在内**，与前端单条按钮的判据**同源**——`tauri-shell/src/components/
///   CacheManagerDialog.tsx:76` 的 `RETRYABLE` 同样排除 `done`。端点必须与 UI 的
///   可操作性一致，否则会出现「界面上没有按钮、API 却接受」的判据分裂。
///   （`store::retry_cache_task` 的 `status NOT IN ('running','queued')` 是更宽的
///   **历史**判据、允许 `done`，但 UI 路径不可达；不要据此把 `done` 放进来。）
///   `done` 要重下走「重新入队」（`enqueue_cache_task`）：worker 对「已缓存且文件
///   存在」的条目本就幂等跳过，复位 `done` 只会让队列空转一圈再回到 `done`。
/// - `Cancel`：只有活跃态可取消；终态没有可取消的动作，含终态的整请求 422。
const RETRYABLE_STATES: [&str; 3] = ["failed", "cancelled", "interrupted"];
const CANCELLABLE_STATES: [&str; 2] = ["queued", "running"];

/// 批量动作的种类（决定状态门与内核，避免把校验写成两遍）。
#[derive(Clone, Copy)]
enum TaskBatchAction {
    Retry,
    Cancel,
}

impl TaskBatchAction {
    fn verb(self) -> &'static str {
        match self {
            Self::Retry => "retry",
            Self::Cancel => "cancel",
        }
    }

    fn allowed(self) -> &'static [&'static str] {
        match self {
            Self::Retry => &RETRYABLE_STATES,
            Self::Cancel => &CANCELLABLE_STATES,
        }
    }

    /// 真正动手：状态迁移一律走**单条内核**，批量不另写一份。
    async fn apply(self, st: &Arc<AppState>, id: i64) -> Result<(), ApiError> {
        match self {
            Self::Retry => retry_task_kernel(st, id).await.map(|_| ()),
            Self::Cancel => cancel_task_kernel(st, id).await.map(|_| ()),
        }
    }
}

/// `POST /api/cache/tasks/retry?ids=1,2,3` — 批量重试终态任务（BUG-249）。
async fn retry_tasks(
    State(st): State<Arc<AppState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, axum::response::Response> {
    batch_task_action(&st, &q, TaskBatchAction::Retry).await
}

/// `POST /api/cache/tasks/cancel?ids=1,2,3` — 批量取消活跃任务（BUG-249）。
async fn cancel_tasks(
    State(st): State<Arc<AppState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, axum::response::Response> {
    batch_task_action(&st, &q, TaskBatchAction::Cancel).await
}

/// 批量状态迁移的**唯一实现**：先整体校验，再整体执行。
///
/// 契约（用户裁定）：
///   - `ids` 缺失 / 空 / 非数字 / 非正数 ⇒ **422**，绝不静默 no-op；
///   - 请求里只要有**一条**状态不合法 ⇒ 整请求 **422**（body 含 `error` 与 `invalid`），
///     合法的那几条**不得被部分执行**——半执行会让「批量重试」变成薛定谔的操作，
///     用户从列表里数不出到底动了几条；
///   - 成功 ⇒ `{"ok": true, "ids": [<生效的 id>…]}`，顺序与请求一致；
///   - 请求里读不到的 id（越界）**不是非法**：沿用批量删除（`clear_tasks?ids=`）的口径，
///     它既不动手、也不报错，只是不出现在返回的 `ids` 里。
///
/// 预检只走 `get_cache_task` 逐条读状态（批量 N ≤ 1000，面板勾选量级），
/// 不引入任何**高频读**路径的 DB 查询。
async fn batch_task_action(
    st: &Arc<AppState>,
    q: &std::collections::HashMap<String, String>,
    action: TaskBatchAction,
) -> Result<Json<serde_json::Value>, axum::response::Response> {
    let ids = match batch_ids(q) {
        Ok(v) => v,
        Err(e) => return Err(e.into_response()),
    };
    let mut invalid: Vec<i64> = Vec::new();
    let mut targets: Vec<i64> = Vec::new();
    for id in &ids {
        let task = match st.store.get_cache_task(*id).await {
            Ok(t) => t,
            Err(e) => {
                return Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
                    .into_response())
            }
        };
        match task {
            None => {}
            Some(t) if action.allowed().contains(&t.status.as_str()) => targets.push(*id),
            Some(_) => invalid.push(*id),
        }
    }
    if !invalid.is_empty() {
        let body = Json(json!({
            "error": format!(
                "{} only applies to task(s) in state {}; invalid ids: {:?}",
                action.verb(),
                action.allowed().join("|"),
                invalid,
            ),
            "invalid": invalid,
        }));
        return Err((StatusCode::UNPROCESSABLE_ENTITY, body).into_response());
    }
    for id in &targets {
        if let Err(e) = action.apply(st, *id).await {
            return Err(e.into_response());
        }
    }
    Ok(Json(json!({"ok": true, "ids": targets})))
}

/// 批量端点的 `?ids=` 取值：缺失/空 ⇒ 422（不得静默 no-op）。
fn batch_ids(q: &std::collections::HashMap<String, String>) -> Result<Vec<i64>, ApiError> {
    let Some(raw) = q.get("ids") else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ids is required: expected ?ids=1,2,3",
        ));
    };
    let ids = parse_id_list(raw)?;
    if ids.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ids provided but empty: nothing selected",
        ));
    }
    Ok(ids)
}

// ---- BUG-277：队列优先级（置顶 / 取消置顶） ----

/// 置顶目标：显式数值，或「由后端取当前最大 + 1」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PriorityTarget {
    /// 显式优先级（取消置顶 = `Value(0)`）。
    Value(i64),
    /// 置顶：数值由后端算（`max(priority) + 1`），前端不猜。
    Top,
}

/// `POST /api/tg/cache/tasks/:id/priority` 与批量端点共用的一份 body。
///
/// `priority` 与 `top` **互斥**：两者都给或都不给 ⇒ 422（静默取一个会让
/// 「置顶」变成薛定谔的操作）。`ids` 只有批量端点用（单条端点给了也忽略，
/// 路径上的 id 才是真源 —— 两个真源必然分叉）。
#[derive(Debug, Deserialize)]
pub struct SetPriorityReq {
    pub priority: Option<i64>,
    pub top: Option<bool>,
    pub ids: Option<Vec<i64>>,
}

/// body → 置顶目标；不合法即 422（**不静默回落**）。
pub(crate) fn priority_target(req: &SetPriorityReq) -> Result<PriorityTarget, ApiError> {
    match (req.priority, req.top) {
        (Some(_), Some(_)) => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "priority and top are mutually exclusive: send exactly one",
        )),
        (None, None) => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "priority (integer >= 0) or top (true) is required",
        )),
        (None, Some(false)) => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "top=false is not a pin request: send priority instead",
        )),
        (None, Some(true)) => Ok(PriorityTarget::Top),
        (Some(v), None) if v < 0 => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "priority must be >= 0",
        )),
        (Some(v), None) => Ok(PriorityTarget::Value(v)),
    }
}

/// 「置顶」对谁有意义：**排队中的任务**。
///
/// 已置顶的任务（priority > 0）即使不再排队也**必须**允许取消置顶 ——
/// 否则用户点了置顶之后就再也撤销不掉（任务终态后按钮还在、点了却 422，
/// 那是界面与端点判据分裂，BUG-249 已吃过一次）。
/// 其余情形（终态且未置顶）置顶没有任何可观察效果，给 422 而不是假装成功。
const PRIORITY_REJECT_MSG: &str =
    "priority only applies to queued tasks (or to unpinning an already pinned one)";

fn prioritizable(t: &CacheTask) -> bool {
    t.status == "queued" || t.priority > 0
}

/// 单条**置顶 / 取消置顶**的状态迁移内核（唯一真源）。
///
/// 批量端点循环调它，批量不另写一份状态机（AGENTS.md §2）。
/// 返回 `(id, 生效后的 priority)`。
pub(crate) async fn set_task_priority_kernel(
    st: &Arc<AppState>,
    id: i64,
    target: PriorityTarget,
) -> Result<(i64, i64), ApiError> {
    let Some(task) = st
        .store
        .get_cache_task(id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found"));
    };
    if !prioritizable(&task) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            PRIORITY_REJECT_MSG,
        ));
    }
    let priority = match target {
        PriorityTarget::Value(v) => v,
        PriorityTarget::Top => st
            .store
            .max_cache_task_priority()
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
            + 1,
    };
    let Some(updated) = st
        .store
        .set_cache_task_priority(id, priority)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cache task not found"));
    };
    // **不 spawn、不抢占**（BUG-257 不弃单）：置顶只改一个标量，正在跑的 worker
    // 会在当前任务终态后按新顺序接续。这里若顺手起 worker，就会把「置顶」变成
    // 「插队执行」，单飞门禁也会凭空多出一个竞争者。
    st.refresh_cache_tasks().await;
    st.push_log(format!(
        "/api/tg/cache/tasks/{id}: priority set to {priority}"
    ));
    Ok((id, updated.priority))
}

/// 批量置顶：一次请求改多条（BUG-249 先例：**禁止**前端循环调单条）。
///
/// 契约与批量重试/取消同源：
/// - `ids` 缺失 / 空 ⇒ 422（不得静默 no-op）；
/// - 任一条不可置顶 ⇒ **整请求 422**，合法的几条**不部分执行**；
/// - 读不到的 id（越界）沿用 BUG-249 口径：不动手、不报错，只是不出现在返回里；
/// - 同批 `top`：按 **id 升序**分配 `max+N … max+1` ⇒ 批内仍保持 FIFO
///   （先入队的先跑），否则「一起置顶」会把用户原本的顺序整个倒过来。
async fn set_tasks_priority_batch(
    st: &Arc<AppState>,
    ids: &[i64],
    target: PriorityTarget,
) -> Result<Vec<(i64, i64)>, ApiError> {
    if ids.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ids provided but empty: nothing selected",
        ));
    }
    let mut invalid: Vec<i64> = Vec::new();
    let mut targets: Vec<i64> = Vec::new();
    for id in ids {
        let task = st
            .store
            .get_cache_task(*id)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        match task {
            None => {}
            Some(t) if prioritizable(&t) => targets.push(*id),
            Some(_) => invalid.push(*id),
        }
    }
    if !invalid.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("{PRIORITY_REJECT_MSG}; invalid ids: {invalid:?}"),
        ));
    }
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    // 批内按 id 升序发号：先入队的拿到更大的 priority（= 先跑）。
    targets.sort_unstable();
    let base = match target {
        PriorityTarget::Value(_) => 0,
        PriorityTarget::Top => st
            .store
            .max_cache_task_priority()
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?,
    };
    let n = targets.len() as i64;
    let mut out = Vec::with_capacity(targets.len());
    for (i, id) in targets.iter().enumerate() {
        let priority = match target {
            PriorityTarget::Value(v) => v,
            PriorityTarget::Top => base + n - i as i64,
        };
        out.push(set_task_priority_kernel(st, *id, PriorityTarget::Value(priority)).await?);
    }
    st.push_log(format!(
        "/api/tg/cache/tasks/priority ids={} updated={}",
        ids.len(),
        out.len()
    ));
    Ok(out)
}

/// `POST /api/tg/cache/tasks/:id/priority`（body `{priority}` 或 `{top:true}`）
/// —— 单条置顶 / 取消置顶（BUG-277）。
pub async fn set_task_priority(
    State(st): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    body: Option<Json<SetPriorityReq>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let req = body.map(|b| b.0).unwrap_or(SetPriorityReq {
        priority: None,
        top: None,
        ids: None,
    });
    let target = priority_target(&req)?;
    let (tid, priority) = set_task_priority_kernel(&st, id, target).await?;
    Ok(Json(json!({"ok": true, "tasks": [{"id": tid, "priority": priority}]})))
}

/// `POST /api/tg/cache/tasks/priority`（body `{ids:[…], priority|top}`）
/// —— **批量**置顶 / 取消置顶（BUG-277 + BUG-249 的原子性纪律）：
/// 多选置顶必须**一个请求**完成，禁止前端循环调单条。
pub async fn set_tasks_priority(
    State(st): State<Arc<AppState>>,
    body: Option<Json<SetPriorityReq>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let req = body.map(|b| b.0).unwrap_or(SetPriorityReq {
        priority: None,
        top: None,
        ids: None,
    });
    let target = priority_target(&req)?;
    let Some(ids) = req.ids.clone() else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ids is required for the batch priority endpoint: expected {\"ids\":[1,2,3]}",
        ));
    };
    let updated = set_tasks_priority_batch(&st, &ids, target).await?;
    let tasks: Vec<serde_json::Value> = updated
        .iter()
        .map(|(id, priority)| json!({"id": id, "priority": priority}))
        .collect();
    Ok(Json(json!({"ok": true, "tasks": tasks})))
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

/// 解析 `?ids=1,2,3`（**有序**、去重、空白容忍）。
///
/// 非法项**直接 422，不静默跳过** —— 默默忽略只会让「删除所选」少删几条，
/// 而界面显示成功，是最难查的一类不一致。重复项去重（勾选集合天然唯一，
/// 但参数是外部输入）。
///
/// 保序是给批量动作端点用的（BUG-249 契约：返回的 `ids` 与请求顺序一致）；
/// 既有 DELETE 端点要的是集合语义，由 [`parse_ids`] 在其上再做一次排序。
fn parse_id_list(raw: &str) -> Result<Vec<i64>, ApiError> {
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
        if !out.contains(&id) {
            out.push(id);
        }
    }
    if out.len() > MAX {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("too many ids (max {MAX})"),
        ));
    }
    Ok(out)
}

/// [`parse_id_list`] 的**集合**视图：去重 + 升序（批量删除端点的既有语义，一字未改）。
fn parse_ids(raw: &str) -> Result<Vec<i64>, ApiError> {
    let mut out = parse_id_list(raw)?;
    out.sort_unstable();
    Ok(out)
}

/// `GET /api/cache/stats` — 缓存占用（`files` / `bytes` / `external`）。
///
/// 「清除缓存文件」是释放磁盘的动作，**不知道占多少就是盲操作**——这是此前漏掉的必需项。
/// `bytes` 只统计真实存在的、**位于下载目录或库根内**的字节（P2 起归仓字节在库根下，
/// 同属本系统可清理的缓存）；`external` 是导入/扫描带进来的
/// 外部文件（永不删除，只如实计数）。
///
/// `external` 的形状与 `GET /api/cache/clear/preview` **逐字一致**（BUG-136）：
/// 此前这里是纯计数数字，那边是 `{count,bytes,removable}`，同一字段两种形状会让调用方
/// 无法复用读数；且这里一个字节都不累加，本地导入占着磁盘却不出现在任何数字里。
/// 字节口径复用 [`file_len`]，与 preview 同源，**不另写一套 stat 逻辑**。
async fn stats(
    State(st): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let dir = download_dir(&st).await;
    let lib_root = st.store.library_root().await;
    let items = st
        .store
        .list_cached_items()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    let (mut bytes, mut files, mut external, mut external_bytes) = (0u64, 0u64, 0u64, 0u64);
    for it in items {
        // P2 起条目路径可能是库根相对的：先解析再 stat，口径与 preview 一致。
        // 「内部」= 下载目录**或**库根（归仓字节也是本系统拥有的缓存字节，
        // 必须计入 bytes/files，否则清理中心会少报可释放空间）。
        let absolute = resolve_item_path(&lib_root, &it.file_path);
        let absolute_str = absolute.to_string_lossy().into_owned();
        // 与 `clear_preview` 共用 `file_len`：两处对同一文件的读数必须逐字一致。
        let size = file_len(&absolute_str);
        if !inside_dir(&dir, &absolute_str) && !inside_dir(&lib_root, &absolute_str) {
            external += 1;
            external_bytes += size.unwrap_or(0);
            continue;
        }
        if let Some(n) = size {
            bytes += n;
            files += 1;
        }
    }
    Ok(Json(json!({
        "ok": true,
        "files": files,
        "bytes": bytes,
        "external": {"count": external, "bytes": external_bytes, "removable": false},
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::state::Availability;
    use crate::store::Store;

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

    /// BUG-323 权限边界：受管路径解析必须把**下载路径之外**的路径判为越界。
    ///
    /// 含反向证伪：历史库根（应用内部 AppData）下的绝对路径 —— 正是存量
    /// `media_item.file_path` 的形态 —— 必须被拒，否则「所有文件不脱离下载路径」
    /// 只是口号。
    #[test]
    fn resolve_managed_path_rejects_outside_download_root_bug323() {
        let dl = Path::new("C:/Users/u/Downloads");
        let lib = dl.join("library");

        // 库内相对路径（归仓规范形态）→ 解析到库根下 ⇒ 界内
        assert!(resolve_managed_path(dl, &lib, "chat--1/2-a.mp4").is_some());
        // 下载路径内的绝对路径（下载成品）⇒ 界内
        assert!(resolve_managed_path(dl, &lib, "C:/Users/u/Downloads/a.mp4").is_some());
        // 下载路径自身 ⇒ 界内
        assert!(resolve_managed_path(dl, &lib, "C:/Users/u/Downloads").is_some());
        // 历史 AppData 库根下的绝对路径 ⇒ 界外，必须拒绝
        assert!(
            resolve_managed_path(
                dl,
                &lib,
                "C:/Users/u/AppData/Roaming/com.origadmin.orighub/tg/library/old.mp4"
            )
            .is_none(),
            "历史库根下的绝对路径必须判越界"
        );
        // 平行目录（前缀相同但不是子路径）：`Downloads2` 不是 `Downloads` 的下级
        assert!(resolve_managed_path(dl, &lib, "C:/Users/u/Downloads2/a.mp4").is_none());
        // 库根内的 `..` 只要**没越过下载根**就仍在界内 —— 边界是下载根，不是库根。
        // （`…/Downloads/library/../secret.mp4` 归一化 = `…/Downloads/secret.mp4`，
        // 仍在受管区里；把它算越界是**过度拦截**，会让正常写入被 403。）
        assert!(resolve_managed_path(dl, &lib, "../secret.mp4").is_some());
        // 真正穿出下载根的两条：相对 `..` 上溯、绝对路径里的 `..`。
        assert!(resolve_managed_path(dl, &lib, "../../secret.mp4").is_none());
        assert!(resolve_managed_path(dl, &lib, "C:/Users/u/Downloads/../secret.mp4").is_none());
    }

    /// 归一化保留盘符/根，折叠 `.` 与 `..`（大小写不敏感由 [`path_within`] 负责）。
    #[test]
    fn lexical_normalize_folds_dots() {
        assert_eq!(
            lexical_normalize(Path::new("C:/a/./b/../c")),
            PathBuf::from("C:/a/c")
        );
        // 根之上的 `..` 不再上溯
        assert_eq!(lexical_normalize(Path::new("/../a")), PathBuf::from("/a"));
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

    /// BUG-101 判据：只有「文件在且非空」才算可播；空路径与不存在一律 `Missing`。
    #[tokio::test]
    async fn probe_cached_bytes_needs_a_non_empty_file() {
        let dir = std::env::temp_dir().join(format!("orig_cache_probe_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("ok.mp4");
        std::fs::write(&ok, b"bytes").unwrap();

        assert_eq!(
            probe_cached_bytes(&ok.to_string_lossy()).await,
            BytesPresence::Present
        );
        // 零字节 = 写了一半就断，与「文件没了」同样不可播。
        let empty = dir.join("empty.mp4");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(
            probe_cached_bytes(&empty.to_string_lossy()).await,
            BytesPresence::Missing
        );
        assert_eq!(
            probe_cached_bytes(&dir.join("gone.mp4").to_string_lossy()).await,
            BytesPresence::Missing
        );
        assert_eq!(probe_cached_bytes("").await, BytesPresence::Missing);
        assert_eq!(probe_cached_bytes("   ").await, BytesPresence::Missing);
    }

    /// BUG-101 边界：目录不是文件，且**目录路径**不得被当成可用字节。
    #[tokio::test]
    async fn probe_cached_bytes_rejects_directories() {
        let dir = std::env::temp_dir().join(format!("orig_cache_probedir_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            probe_cached_bytes(&dir.to_string_lossy()).await,
            BytesPresence::Missing
        );
    }

    /// BUG-101 的三态设计要点：`Unknown` 必须与 `Missing` 分开——
    /// 前者只撤回「可本地播」的承诺，后者才会复位状态。三态必须真的互不相同。
    #[test]
    fn bytes_presence_has_three_distinct_states() {
        assert_ne!(BytesPresence::Present, BytesPresence::Missing);
        assert_ne!(BytesPresence::Missing, BytesPresence::Unknown);
        assert_ne!(BytesPresence::Present, BytesPresence::Unknown);
    }

    // ---- BUG-109：清理失败必须被如实计入 `failed`，不得再谎报 `removed` ----

    async fn state() -> Arc<AppState> {
        Arc::new(AppState::new(
            Arc::new(crate::unavailable::UnavailableClient::new("test")),
            Config::default(),
            Availability::Unavailable("test".to_string()),
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        ))
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        // 2026-10-19：夹具必须落在**非禁用盘**（`store::fixture_base`）—— 下载根解析到
        // C: 会被改道到真实内容根 `D:\OrigDown`，「钉下载根」会静默指向用户真实
        // 内容目录，清理类用例更会在真实文件上动手。
        let d = crate::store::fixture_base(&format!("cache-{tag}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// BUG-323：把 `dl` 钉成下载根，库根随之派生为 `<dl>/library`。
    ///
    /// 夹具**只允许落在非禁用盘的测试夹具根**上：库根已跟随下载根，夹具若不钉，
    /// 默认档会落到用户真实的 `~/Downloads`（测试往用户目录写文件本身就是事故）；
    /// 而钉在 C: 上又会被禁用盘规则改道到真实内容根 `D:\OrigDown`。两头都堵死。
    async fn pin_download_root(st: &AppState, dl: &std::path::Path) {
        assert!(
            dl.starts_with(crate::store::fixture_root()),
            "夹具只允许把下载根钉在非禁用盘的测试夹具根上，收到 {dl:?}"
        );
        st.store
            .set_setting("download_dir", dl.to_string_lossy().as_ref())
            .await
            .unwrap();
        assert_eq!(
            st.store.library_root().await,
            dl.join(crate::store::Store::LIBRARY_SUBDIR),
            "夹具前提：库根必须派生自下载根"
        );
    }

    /// 删不掉时必须计 `failed`，**不得**计入 `removed` / `bytes` ——
    /// 此前无论成败都返回 `removed: 1`，用户于是以为清理成功而文件还在。
    #[tokio::test]
    async fn purge_reports_failed_when_the_file_cannot_be_removed() {
        let dir = tmp_dir("purge_fail");
        let st = state().await;
        // lib_root 必须与下载目录**不同**：本条目路径在下载目录内但不在库根内，
        // 否则会命中 P2 的 housed-skip（库根内字节视为有主）而不进清理。
        let lib = dir.join("_lib");
        std::fs::create_dir_all(&lib).unwrap();
        // 路径在 dir 内（`inside_dir` 对不存在的文件退到父目录判定），
        // 但文件本身不存在 → `remove_file` 必然失败。
        let missing = dir.join("gone.mp4");
        let it = CachedBytesDetail {
            id: 1,
            title: "t".into(),
            source: "tg".into(),
            ref_key: "not-a-valid-tg-ref".into(),
            file_path: missing.to_string_lossy().into_owned(),
            content_hash: None,
        };
        let p = purge_item(&st, &dir, &lib, &it).await;
        assert_eq!(p.failed, 1, "删不掉必须计 failed");
        assert_eq!(p.removed, 0, "删不掉绝不能计入 removed —— 那正是谎报");
        assert_eq!(p.bytes, 0, "没删掉就不该报释放了字节");
        assert!(st.logs.recent(20).iter().any(|l| l.contains("purge_item")), "失败必须留痕");
    }

    /// 真删掉了才算 `removed` 与 `bytes`（反向约束：别把 failed 写反了把成功也算失败）。
    #[tokio::test]
    async fn purge_reports_removed_when_the_file_is_gone() {
        let dir = tmp_dir("purge_ok");
        let st = state().await;
        let lib = dir.join("_lib");
        std::fs::create_dir_all(&lib).unwrap();
        let f = dir.join("real.mp4");
        std::fs::write(&f, vec![0u8; 512]).unwrap();
        let it = CachedBytesDetail {
            id: 2,
            title: "t".into(),
            // 非 tg 来源：`reset_tg_flag` 直接返回 true，本案只验证字节删除这一半。
            source: "local".into(),
            ref_key: "x".into(),
            file_path: f.to_string_lossy().into_owned(),
            content_hash: None,
        };
        let p = purge_item(&st, &dir, &lib, &it).await;
        assert_eq!(p.removed, 1, "真删掉了必须计 removed");
        assert_eq!(p.failed, 0, "成功不应被误计为失败");
        assert_eq!(p.bytes, 512, "释放字节数须如实");
        assert!(!f.exists(), "文件必须真的被删掉");
    }

    // ── byte-ownership P2：库根解析与归仓移动 ─────────────────────────────

    /// 解析器是 P2 的唯一路径闸门：绝对路径原样（存量条目兼容，一字不改），
    /// 相对路径 join 库根（归仓条目的规范形式）。
    #[test]
    fn resolve_item_path_absolute_passthrough_and_relative_join() {
        let root = Path::new("/tmp/lib");
        // 绝对：原样返回，绝不 join。
        let abs = if cfg!(windows) { r"C:\cache\a.mp4" } else { "/cache/a.mp4" };
        assert_eq!(resolve_item_path(root, abs), PathBuf::from(abs));
        // 相对：join 库根；反斜杠由 Path::join 统一为平台分隔符。
        assert_eq!(resolve_item_path(root, "chat-1/10-title.mp4"), root.join("chat-1/10-title.mp4"));
    }

    /// 并集闸门（管理多根，BUG-323 续）：路径须落在**任一**受管根内，越界 None。
    #[test]
    fn resolve_managed_path_union_accepts_any_root_and_rejects_outside() {
        let roots: Vec<PathBuf> = if cfg!(windows) {
            vec![PathBuf::from(r"C:\Downloads"), PathBuf::from(r"D:\Media")]
        } else {
            vec![PathBuf::from("/downloads"), PathBuf::from("/media")]
        };
        // 落在第一根内 → Some。
        let inside1 = if cfg!(windows) { r"C:\Downloads\a.mp4" } else { "/downloads/a.mp4" };
        assert_eq!(
            resolve_managed_path_union(&roots, inside1),
            Some(PathBuf::from(inside1))
        );
        // 落在第二根内 → Some（证明是并集而非只看首根）。
        let inside2 = if cfg!(windows) { r"D:\Media\sub\b.mp4" } else { "/media/sub/b.mp4" };
        assert_eq!(
            resolve_managed_path_union(&roots, inside2),
            Some(PathBuf::from(inside2))
        );
        // 界外 → None（调用方须 403/Forbidden）。
        let outside = if cfg!(windows) { r"E:\Other\x.mp4" } else { "/other/x.mp4" };
        assert_eq!(resolve_managed_path_union(&roots, outside), None);
    }

    /// slugify 的文件名安全性：非法字符折叠为 `-`、连续折叠、掐头去尾、
    /// 截断到 40 字符；全非法输入必须返回 None（不能产出空文件名或全 `-`）。
    #[test]
    fn slugify_folds_illegal_chars_and_caps_length() {
        assert_eq!(slugify("Hello, World! 你好").as_deref(), Some("Hello-World-你好"));
        assert_eq!(slugify("a  //  b").as_deref(), Some("a-b"));
        assert_eq!(slugify("--edge--case--").as_deref(), Some("edge--case"), "字面 `-` 保留，只掐首尾");
        assert_eq!(slugify("a/b\\c").as_deref(), Some("a-b-c"), "路径分隔符必须被折叠，不能穿越");
        let long = slugify(&"x".repeat(100)).unwrap();
        assert_eq!(long.chars().count(), 40, "文件名片段必须截断");
        assert_eq!(slugify("///"), None, "全非法输入必须返回 None");
        assert_eq!(slugify(""), None);
    }

    /// 归仓主路径：文件**移动**进库根（源位置不再有副本），落在
    /// `<chatSlug>-<chatId>/<messageId>-<titleSlug>.<ext>`；回填值 = 库根相对
    /// 路径（正斜杠）。命名只依赖稳定标识 → **确定性**：同参再跑得到同一目标名。
    #[tokio::test]
    async fn house_moves_bytes_into_library_root_with_deterministic_name() {
        let dl = tmp_dir("house_ok");
        let st = state().await;
        // BUG-323：库根派生自下载根（`<下载根>/library`），`library_dir` 已无写入口。
        pin_download_root(&st, &dl).await;
        let lib = dl.join(crate::store::Store::LIBRARY_SUBDIR);

        let src = dl.join("download").join("src.mp4");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"video-bytes").unwrap();

        // 无频道记录 → chatSlug 退化 "chat"；caption 首行 "My EP 01" → slug。
        let chat_id = 42i64;
        let msg_id = 10i64;
        let housed = house_downloaded_bytes(&st, chat_id, msg_id, &src.to_string_lossy(), Some("My EP 01")).await;

        let expected_rel = format!("chat-{chat_id}/{msg_id}-My-EP-01.mp4");
        assert_eq!(housed.item_path, expected_rel, "回填值必须是库根相对路径");
        assert_eq!(
            Path::new(&housed.absolute_path),
            &lib.join(&expected_rel),
            "实际落盘 = 库根 + 相对路径（命名确定性）"
        );
        assert!(lib.join(&expected_rel).is_file(), "文件必须真的在库根下");
        assert!(!src.exists(), "归仓 = 移动，源位置不得留副本");

        // 确定性：另起一个源文件（同 chat/msg/标题），目标名必须与上次相同。
        let src2 = dl.join("download").join("src2.mp4");
        std::fs::write(&src2, b"second").unwrap();
        let housed2 = house_downloaded_bytes(&st, chat_id, msg_id, &src2.to_string_lossy(), Some("My EP 01")).await;
        assert_eq!(housed2.item_path, expected_rel, "同参输入必须产出同一目标名");
    }

    /// I2 降级条款：库根不可用（此处把 `<下载根>/library` 造成一个**文件**，
    /// mkdir 必败）时文件留在原位、回填绝对路径——登记事实不回滚，也不允许静默丢字节。
    #[tokio::test]
    async fn house_falls_back_to_original_location_when_library_root_unusable() {
        let dl = tmp_dir("house_fallback");
        let st = state().await;
        // 把派生的库根占成真实文件：create_dir_all(<下载根>/library) 会失败。
        std::fs::write(dl.join(crate::store::Store::LIBRARY_SUBDIR), b"occupant").unwrap();
        pin_download_root(&st, &dl).await;

        let src = dl.join("keep-here.mp4");
        std::fs::write(&src, b"bytes").unwrap();
        let housed = house_downloaded_bytes(&st, 7, 8, &src.to_string_lossy(), Some("t")).await;

        assert_eq!(housed.item_path, src.to_string_lossy(), "降级必须回填原绝对路径");
        assert_eq!(housed.absolute_path, src.to_string_lossy());
        assert!(src.exists(), "降级 = 文件留原位");
        assert!(st.logs.recent(20).iter().any(|l| l.contains("house_bytes")), "降级必须留痕");
    }

    // ── BUG-249：批量 retry / cancel（一动词一端点，差异走参数） ─────────────

    /// 造一条指定状态的任务（终态要先转 running —— `finish_cache_task` 只对活跃态生效）。
    ///
    /// BUG-220：消息号必须**随 key 变**。此前这里写死 `[11]`，于是同一 chat 里造的每条
    /// 任务都覆盖同一条消息 —— 入队去重（按消息重叠判据，BUG-220）会正确地把它们合并成
    /// 一条，测试随即拿到同一个 id 而崩。真实任务的消息各不相同，故按 key 末段取消息号。
    async fn seeded_task(st: &Arc<AppState>, key: &str, status: &str) -> i64 {
        let msg: i64 = key
            .rsplit(':')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(11);
        let (task, _created) = st
            .store
            .enqueue_cache_task(7, None, key, &[msg], "D:/dl")
            .await
            .expect("enqueue must succeed")
            .expect("task must be created");
        match status {
            "queued" => {}
            "running" => {
                st.store.mark_cache_task_running(task.id).await.unwrap();
            }
            terminal => {
                // done / failed / cancelled / interrupted 都要先从活跃态退出。
                st.store.mark_cache_task_running(task.id).await.unwrap();
                if terminal == "cancelled" {
                    assert!(st.store.cancel_cache_task(task.id).await.unwrap());
                } else {
                    st.store.finish_cache_task(task.id, terminal, None).await.unwrap();
                }
            }
        }
        let got = st.store.get_cache_task(task.id).await.unwrap().unwrap();
        assert_eq!(got.status, status, "夹具任务状态必须是 {status}");
        task.id
    }

    async fn status_of(st: &AppState, id: i64) -> String {
        st.store.get_cache_task(id).await.unwrap().unwrap().status
    }

    /// 调批量端点并解构为 `(状态码, JSON)`（`ApiError`/`Response` 都没有 Debug）。
    async fn batch_call(
        st: Arc<AppState>,
        retry: bool,
        ids: Option<&str>,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, serde_json::Value)> {
        let mut q = std::collections::HashMap::new();
        if let Some(v) = ids {
            q.insert("ids".to_string(), v.to_string());
        }
        let res = if retry {
            retry_tasks(State(st), Query(q)).await
        } else {
            cancel_tasks(State(st), Query(q)).await
        };
        match res {
            Ok(Json(v)) => Ok((StatusCode::OK, v)),
            Err(resp) => {
                let status = resp.status();
                let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
                    .await
                    .expect("body must be readable");
                Err((status, serde_json::from_slice(&bytes).expect("body must be JSON")))
            }
        }
    }

    /// 批量重试：终态集整体复位为 `queued`，返回的 `ids` 与请求**顺序一致**。
    #[tokio::test]
    async fn batch_retry_resets_every_terminal_task() {
        let st = state().await;
        // 占住单飞门禁：重试会把任务交回 worker，这里要的是「复位」这一步本身。
        assert!(st.claim_cache_worker(), "门禁初始必须空闲");
        let failed = seeded_task(&st, "m:7:1", "failed").await;
        let cancelled = seeded_task(&st, "m:7:2", "cancelled").await;
        let interrupted = seeded_task(&st, "m:7:3", "interrupted").await;

        // 故意乱序（并可含重复项）：返回必须**保序**、去重。
        let request = format!("{interrupted},{failed},{cancelled},{failed}");
        let (status, v) = batch_call(st.clone(), true, Some(&request))
            .await
            .expect("终态批量重试必须成功");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["ok"], true);
        assert_eq!(
            v["ids"],
            json!([interrupted, failed, cancelled]),
            "ids 必须与请求同序、去重，且不夹带别的 id"
        );
        for id in [failed, cancelled, interrupted] {
            assert_eq!(status_of(&st, id).await, "queued", "任务 {id} 必须复位为排队");
        }
    }

    /// 混合请求（含一条非终态）⇒ 整请求 422 + `invalid` 恰为那一条，
    /// 且**合法的那条也不许被部分执行**（半执行让用户数不出动了几条）。
    #[tokio::test]
    async fn batch_retry_rejects_the_whole_request_when_any_id_is_not_terminal() {
        let st = state().await;
        assert!(st.claim_cache_worker());
        let failed = seeded_task(&st, "m:7:11", "failed").await;
        let running = seeded_task(&st, "m:7:12", "running").await;

        let (status, v) = batch_call(st.clone(), true, Some(&format!("{failed},{running}")))
            .await
            .expect_err("含 running 必须整请求 422");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(v["invalid"], json!([running]), "invalid 必须恰为不合法的那条");
        assert!(
            v["error"].as_str().is_some_and(|s| !s.is_empty()),
            "422 body 必须带人类可读的 error，实得 {v}"
        );
        // 真实形态留痕（`cargo test ... -- --nocapture` 可见）：契约要求 error + invalid 同在。
        println!("BUG-249 422 body (mixed retry): {v}");
        assert_eq!(status_of(&st, failed).await, "failed", "合法的那条也不得被部分执行");
        assert_eq!(status_of(&st, running).await, "running", "活跃任务不得被打断");
    }

    /// `ids` 缺失 / 空 ⇒ 422（不得静默 no-op）。
    #[tokio::test]
    async fn batch_actions_reject_missing_or_empty_ids() {
        let st = state().await;
        for retry in [true, false] {
            let (status, v) = batch_call(st.clone(), retry, None)
                .await
                .expect_err("缺 ids 必须 422");
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert!(v["error"].as_str().is_some_and(|s| !s.is_empty()), "缺 ids 的 422 必须带 error");

            let (status, v) = batch_call(st.clone(), retry, Some(""))
                .await
                .expect_err("空 ids 必须 422");
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert!(v["error"].as_str().is_some_and(|s| !s.is_empty()), "空 ids 的 422 必须带 error");

            let (status, _v) = batch_call(st.clone(), retry, Some("1,x"))
                .await
                .expect_err("非数字 id 必须 422");
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "非法 id 不得被静默跳过");
        }
    }

    /// 批量取消：活跃态生效；含终态（这里用 `done`）⇒ 整请求 422；
    /// 越界 id 沿用批量删除口径（不报错、不进 `ids`）。
    #[tokio::test]
    async fn batch_cancel_takes_active_tasks_and_rejects_done() {
        let st = state().await;
        assert!(st.claim_cache_worker());
        let queued = seeded_task(&st, "m:7:21", "queued").await;
        let done = seeded_task(&st, "m:7:22", "done").await;

        let (status, v) = batch_call(st.clone(), false, Some(&format!("{queued},{done}")))
            .await
            .expect_err("含 done 必须整请求 422");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(v["invalid"], json!([done]));
        assert_eq!(status_of(&st, queued).await, "queued", "整请求失败 ⇒ 活跃任务不得被取消");

        // 合法集合：生效并回同一 id；越界 id（不存在）静默跳过，不进返回。
        let ghost = 999_999_i64;
        let (status, v) = batch_call(st.clone(), false, Some(&format!("{ghost},{queued}")))
            .await
            .expect("合法批量取消必须成功");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["ids"], json!([queued]), "越界 id 不生效也不报错（沿用批量删除口径）");
        assert_eq!(status_of(&st, queued).await, "cancelled");
    }

    /// 单条端点与批量端点共用同一内核：单条 retry 也把终态复位成 `queued`。
    #[tokio::test]
    async fn single_retry_route_shares_the_batch_kernel() {        let st = state().await;
        assert!(st.claim_cache_worker());
        let failed = seeded_task(&st, "m:7:31", "failed").await;
        let task = retry_task(State(st.clone()), AxumPath(failed))
            .await
            .expect("单条重试必须成功")
            .0;
        assert_eq!(task.id, failed, "单条重试复用同一 id（BUG-078）");
        assert_eq!(status_of(&st, failed).await, "queued");
    }

    /// 路由表能建起来：`/api/cache/tasks/retry`（静态段）与 `/api/cache/tasks/:id`
    /// （参数段，仅 DELETE）不得互相吃掉 —— axum/matchit 的路由冲突是**建表时 panic**，
    /// 这行断言是它的唯一守卫（BUG-249 的静态段注册顺序要求）。
    #[tokio::test]
    async fn cache_router_registers_batch_paths_without_conflict() {
        let st = state().await;
        // 整个应用路由（含 merge）也必须建得起来：冲突会在这里立刻 panic。
        let _ = crate::routes::router(st);
        let _ = router();
    }

    // ---- BUG-277：队列优先级（置顶 / 取消置顶） ----

    /// 建一个**文件库**（不是 `:memory:`），用于验证加列迁移与二次启动（判据 6）。
    fn priority_db(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("orig_priority_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        // 清掉可能被 **pid 复用**继承的旧库：本 helper 原先不删文件，Windows 回收 pid
        // 后新进程会打开上一轮留下的库 ⇒ `enqueue_cache_task` 命中旧行、`created=false`，
        // 本档「首次入队必须新建」随机红。与 store.rs tests 的 `store()` / media.rs 的
        // `tmp_db`（先 remove_file）同一纪律。
        let db = d.join("store.db");
        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_file(d.join("store.db-wal"));
        let _ = std::fs::remove_file(d.join("store.db-shm"));
        db
    }

    /// 单条置顶端点 → `(状态码, JSON)`，与 `batch_call` 同一手写解构
    /// （`ApiError` / `impl IntoResponse` 都没有 `Debug`）。
    async fn priority_call(
        st: Arc<AppState>,
        id: i64,
        body: serde_json::Value,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, serde_json::Value)> {
        let req: SetPriorityReq = serde_json::from_value(body).expect("body must deserialize");
        match set_task_priority(State(st), AxumPath(id), Some(Json(req))).await {
            Ok(Json(v)) => Ok((StatusCode::OK, v)),
            // `ApiError` 的字段是 routes 私有的，这里只能走它公开的实现
            // （`IntoResponse` → `{"error": …}`）取状态码与报文。
            Err(e) => Err(error_response(e).await),
        }
    }

    /// `ApiError` → `(状态码, JSON)`（同 `batch_call` 的手写解构）。
    async fn error_response(e: ApiError) -> (StatusCode, serde_json::Value) {
        let resp = e.into_response();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("body must be readable");
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
        (status, v)
    }

    /// 批量置顶端点 → `(状态码, JSON)`。
    async fn priority_batch_call(
        st: Arc<AppState>,
        body: serde_json::Value,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, serde_json::Value)> {
        let req: SetPriorityReq = serde_json::from_value(body).expect("body must deserialize");
        match set_tasks_priority(State(st), Some(Json(req))).await {
            Ok(Json(v)) => Ok((StatusCode::OK, v)),
            Err(e) => Err(error_response(e).await),
        }
    }

    /// 排队任务（按入队顺序返回 id），用于队列取序断言。
    async fn queued_ids(st: &Arc<AppState>) -> Vec<i64> {
        st.store
            .recover_queued_cache_tasks()
            .await
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect()
    }

    /// 判据 6：加列迁移**幂等** —— 二次启动不报错、不删数据，且存量任务
    /// `priority=0` ⇒ 取序与旧实现（`ORDER BY id ASC`）**逐字一致**。
    #[tokio::test]
    async fn priority_migration_is_idempotent_and_keeps_fifo_order_bug277() {
        let db = priority_db("migrate");
        let first = Store::open(&db).await.expect("first open must succeed");
        let mut ids = Vec::new();
        for k in 0..3 {
            let (t, created) = first
                .enqueue_cache_task(7, None, &format!("m:7:9{k}"), &[90 + k], "D:/dl")
                .await
                .unwrap()
                .unwrap();
            assert!(created);
            assert_eq!(t.priority, 0, "新入队任务默认 0（= 不置顶）");
            ids.push(t.id);
        }
        let before: Vec<i64> = first
            .recover_queued_cache_tasks()
            .await
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(before, ids, "首次启动：全 0 ⇒ 严格 id ASC");
        assert_eq!(
            first.next_queued_task().await.unwrap().map(|t| t.id),
            Some(ids[0])
        );
        drop(first);

        // 二次启动：列已存在 ⇒ 迁移必须跳过（不报错、不改写任何数据）。
        let second = Store::open(&db).await.expect("second open must not fail");
        let after: Vec<i64> = second
            .recover_queued_cache_tasks()
            .await
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(after, before, "二次启动后顺序必须一字不变（判据 6）");
        for id in &ids {
            let t = second.get_cache_task(*id).await.unwrap().unwrap();
            assert_eq!(t.priority, 0, "存量任务 priority 必须是 0");
        }
        // 三次启动同理（幂等不是「第二次恰好没事」）。
        drop(second);
        let third = Store::open(&db).await.expect("third open must not fail");
        let third_ids: Vec<i64> = third
            .recover_queued_cache_tasks()
            .await
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(third_ids, before);
    }

    /// 判据 2（向后兼容）：没人置顶时，取序与呈现都不变。
    #[tokio::test]
    async fn queue_stays_fifo_while_no_task_is_pinned_bug277() {
        let st = state().await;
        assert!(st.claim_cache_worker());
        let a = seeded_task(&st, "m:7:41", "queued").await;
        let b = seeded_task(&st, "m:7:42", "queued").await;
        let c = seeded_task(&st, "m:7:43", "queued").await;

        assert_eq!(queued_ids(&st).await, vec![a, b, c], "全 0 ⇒ id ASC");
        assert_eq!(st.store.next_queued_task().await.unwrap().map(|t| t.id), Some(a));
        // 显式设成同一个 0（= 取消置顶）也不得改变顺序。
        let (_status, _v) = priority_call(st.clone(), c, json!({"priority": 0}))
            .await
            .expect("取消置顶必须成功");
        assert_eq!(queued_ids(&st).await, vec![a, b, c]);
    }

    /// 判据 1 + 5：非队首置顶后**下一个必是它**；且**不抢占**当前任务
    /// （running 仍是那一条、字节与状态一字不动）。
    #[tokio::test]
    async fn pin_makes_the_task_next_and_never_preempts_the_running_one_bug277() {
        let st = state().await;
        assert!(st.claim_cache_worker());
        let running = seeded_task(&st, "m:7:51", "running").await;
        let a = seeded_task(&st, "m:7:52", "queued").await;
        let b = seeded_task(&st, "m:7:53", "queued").await;

        // 置顶最后一条（既非队首、也非当前）。
        let (status, v) = priority_call(st.clone(), b, json!({"top": true}))
            .await
            .expect("置顶排队任务必须成功");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["tasks"][0]["id"], json!(b));
        assert_eq!(v["tasks"][0]["priority"], json!(1), "置顶 = 当前最大 + 1");

        // 判据 1：下一个跑的必须是它。
        assert_eq!(
            st.store.next_queued_task().await.unwrap().map(|t| t.id),
            Some(b),
            "置顶后接续的必须是被置顶的那条（判据 1）"
        );
        // 判据 5：不抢占 —— 当前任务原样不动，且全库 running 仍 ≤ 1。
        let cur = st.store.current_cache_task().await.unwrap().unwrap();
        assert_eq!(cur.id, running, "呈现的当前任务仍是 running 那条（不被插队）");
        assert_eq!(cur.status, "running");
        assert!(st.store.has_running_cache_task().await.unwrap());
        let running_count = st
            .store
            .count_cache_tasks()
            .await
            .unwrap()
            .into_iter()
            .find(|(s, _)| s == "running")
            .map(|(_, n)| n)
            .unwrap_or(0);
        assert_eq!(running_count, 1, "单飞契约：running ≤ 1（判据 4/5）");
        assert_eq!(queued_ids(&st).await, vec![b, a], "恢复路径同款排序（判据 3）");

        // 再置顶 a ⇒ a 反而排到 b 前面（max+1 逐次递增，后点的不会覆盖先点的）。
        priority_call(st.clone(), a, json!({"top": true}))
            .await
            .expect("第二次置顶必须成功");
        assert_eq!(st.store.next_queued_task().await.unwrap().map(|t| t.id), Some(a));
        assert_eq!(queued_ids(&st).await, vec![a, b]);

        // 取消置顶 ⇒ 回到 FIFO。
        priority_call(st.clone(), a, json!({"priority": 0}))
            .await
            .expect("取消置顶必须成功");
        assert_eq!(st.store.next_queued_task().await.unwrap().map(|t| t.id), Some(b));
        priority_call(st.clone(), b, json!({"priority": 0}))
            .await
            .expect("取消置顶必须成功");
        assert_eq!(queued_ids(&st).await, vec![a, b], "取消后置顶前还原为 id ASC");
    }

    /// 判据 3（原子性）：批量置顶**一个请求**改多条；批内保持 FIFO
    /// （先入队的先跑），否则「一起置顶」会把用户原本的顺序整个倒过来。
    #[tokio::test]
    async fn batch_pin_is_one_request_and_keeps_fifo_within_the_batch_bug277() {
        let st = state().await;
        assert!(st.claim_cache_worker());
        let a = seeded_task(&st, "m:7:61", "queued").await;
        let b = seeded_task(&st, "m:7:62", "queued").await;
        let c = seeded_task(&st, "m:7:63", "queued").await;

        // 故意**乱序**提交 ids：批内顺序由后端按 id 定，不信任入参顺序。
        let (status, v) =
            priority_batch_call(st.clone(), json!({"ids": [c, a], "top": true}))
                .await
                .expect("批量置顶必须成功");
        assert_eq!(status, StatusCode::OK);
        let tasks = v["tasks"].as_array().expect("tasks array").clone();
        assert_eq!(tasks.len(), 2, "一次请求改两条（不是两次单条）");
        let got: std::collections::HashMap<i64, i64> = tasks
            .iter()
            .map(|t| {
                (
                    t["id"].as_i64().unwrap(),
                    t["priority"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(got.get(&a), Some(&2), "先入队的拿更大的 priority（批内 FIFO）");
        assert_eq!(got.get(&c), Some(&1));
        assert_eq!(got.get(&b), None, "没被选中的那条不动");
        assert_eq!(st.store.next_queued_task().await.unwrap().map(|t| t.id), Some(a));
        assert_eq!(queued_ids(&st).await, vec![a, c, b]);
    }

    /// 批量置顶的契约边界：`ids` 缺失 / 空 ⇒ 422；越界 id 沿用 BUG-249 口径
    /// （不动手、不报错、不进返回）；含不可置顶的终态 ⇒ 整请求 422，
    /// **合法的那条不得被部分执行**。
    #[tokio::test]
    async fn batch_pin_contract_matches_bug249_bug277() {
        let st = state().await;
        assert!(st.claim_cache_worker());
        let queued = seeded_task(&st, "m:7:71", "queued").await;
        let done = seeded_task(&st, "m:7:72", "done").await;

        let (_s, err) = priority_batch_call(st.clone(), json!({"top": true}))
            .await
            .expect_err("缺 ids 必须 422");
        assert_eq!(_s, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err["error"].as_str().is_some_and(|s| !s.is_empty()), "422 必须带 error");

        let (_s, _err) = priority_batch_call(st.clone(), json!({"ids": [], "top": true}))
            .await
            .expect_err("空 ids 必须 422");
        assert_eq!(_s, StatusCode::UNPROCESSABLE_ENTITY);

        // 越界 id：不动手、不报错，只不出现在返回里。
        let ghost = 999_999_i64;
        let (status, v) =
            priority_batch_call(st.clone(), json!({"ids": [ghost, queued], "top": true}))
                .await
                .expect("合法请求必须成功");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["tasks"].as_array().map(|a| a.len()), Some(1));
        assert_eq!(v["tasks"][0]["id"], json!(queued));

        // 含终态（未置顶）⇒ 整请求 422，且合法的那条不被改动。
        let before = st.store.get_cache_task(queued).await.unwrap().unwrap().priority;
        let (_s, err) =
            priority_batch_call(st.clone(), json!({"ids": [queued, done], "top": true}))
                .await
                .expect_err("含终态必须整请求 422");
        assert_eq!(_s, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            err["error"].as_str().is_some_and(|s| s.contains("invalid ids")),
            "422 必须点名哪几条不合法，实得 {err}"
        );
        assert_eq!(
            st.store.get_cache_task(queued).await.unwrap().unwrap().priority,
            before,
            "整请求失败 ⇒ 合法的那条不得被部分执行"
        );
    }

    /// 单条端点与批量端点共用同一内核；请求体本身的非法形态一律 422（不静默回落）。
    #[tokio::test]
    async fn priority_endpoint_rejects_malformed_requests_bug277() {
        let st = state().await;
        assert!(st.claim_cache_worker());
        let queued = seeded_task(&st, "m:7:81", "queued").await;
        let done = seeded_task(&st, "m:7:82", "done").await;

        for bad in [
            json!({}),
            json!({"priority": 1, "top": true}),
            json!({"top": false}),
            json!({"priority": -1}),
        ] {
            let (s, _) = priority_call(st.clone(), queued, bad.clone())
                .await
                .expect_err("非法 body 必须 422");
            assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "bad body = {bad}");
        }

        // 终态且未置顶 ⇒ 422（置顶对它没有任何可观察效果，不假装成功）。
        let (s, _) = priority_call(st.clone(), done, json!({"top": true}))
            .await
            .expect_err("终态任务置顶必须 422");
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
        // 但已置顶的任务即使终态也**必须**能取消置顶（否则置顶不可撤销）。
        let (s, _) = priority_call(st.clone(), queued, json!({"top": true}))
            .await
            .expect("置顶成功");
        assert_eq!(s, StatusCode::OK);
        st.store.finish_cache_task(queued, "done", None).await.unwrap();
        let (s, v) = priority_call(st.clone(), queued, json!({"priority": 0}))
            .await
            .expect("已置顶任务的取消置顶必须始终可用");
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["tasks"][0]["priority"], json!(0));

        // 不存在的 id ⇒ 404（不是 422：id 不存在的语义是「找不到」，不是「不合法」）。
        let (s, _) = priority_call(st.clone(), 999_999, json!({"top": true}))
            .await
            .expect_err("未知 id 必须 404");
        assert_eq!(s, StatusCode::NOT_FOUND);
    }
}
