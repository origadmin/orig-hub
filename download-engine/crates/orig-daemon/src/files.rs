//! 文件事实读端点（BUG-299 M2-T00a）。
//!
//! **为什么需要它**：文件域（文件管理）此前的唯一数据源是「已登记媒体」
//! （`media_item`，orig-tg 侧），而 HTTP 下载的成品从不写 `media_item` ——
//! 受管下载根（`manual_download_root`）里躺着的 zip/exe/pdf/视频在文件域
//! **一条都看不见**。用户 2026-10-15 裁定「全量 = 共通 + 兼容性」：
//! 受管根下的成品与已登记媒体必须一视同仁（可见 / 打开目录 / 删除含字节联动）。
//!
//! **为什么是读端点而不是「完成即入库」**（BUG-299 任务表重排）：
//! ingest 写入 `media_item` 要跨进程写 orig-tg 的库（需 BUG-172 或等价决策），
//! 而**读通路没有这个依赖** —— 受管根就在 daemon 自己的配置里，FS 元数据
//! 当场可采。任务记录（`/api/downloads`）只在内存、重启即失，不能当枚举真源；
//! 真正的真源是**受管根目录本身**（用户手动放入的文件同样算成品，见出口判据 8）。
//!
//! 端点（均只读 + 删除；删除有受管根边界守卫，绝不接受根外路径）：
//!   GET    /api/files            -> {roots, files: [FileFact]}
//!   DELETE /api/files?path=...   -> {ok, path}（404 不存在 / 403 根外）
//!
//! wire 约定与 daemon 其余端点一致（snake_case；camelCase 是 orig-tg 媒体端点的约定）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use orig_core::protocol::DownloadStatus as CoreStatus;
use serde::Deserialize;
use serde::Serialize;

use crate::state::AppState;

/// 递归扫描深度上限（受管根下的分类子目录一层就够；再深的多是用户自己的
/// 归档目录，不属于「成品」范畴。3 层 = 根 + 分类层 + 一层余量）。
const MAX_DEPTH: usize = 3;

/// 单次枚举的文件数上限（受管根理论上可以是整个用户 Downloads；兜底防呆）。
const MAX_FILES: usize = 5000;

/// 下载引擎的临时/在写产物扩展名：枚举时排除（它们不是成品）。
const TEMP_EXTS: [&str; 5] = ["part", "tmp", "download", "crdownload", "orig-tmp"];

/// 一个受管成品的事实行（纯 FS 元数据 + 分类推导，无任何 `media_item` 语义）。
#[derive(Debug, Clone, Serialize)]
pub struct FileFact {
    /// 绝对路径（前端「打开目录 / 打开」都用它）。
    pub path: String,
    /// 文件名（展示名；不含目录）。
    pub name: String,
    /// 扩展名（小写、无点；无扩展名为空串）。
    pub ext: String,
    /// 自动分类名（daemon `classify` 规则的输出：Videos/Music/Images/Documents/Archives/Others）。
    /// 与侧栏 `category.*`、设置页 classify_rules 的值同源，前端不自己判类型。
    pub category: String,
    /// 前端行内图标/行为用的粗类型：video|photo|audio|doc|archive|other。
    pub kind: String,
    /// 字节数（0 = 空文件，行内照常显示并带「缺字节」标记——0 也是事实）。
    pub size: i64,
    /// mtime（unix 秒；取不到记 0，前端不显示 1970）。
    pub modified_at: i64,
}

/// `GET /api/files` 响应：受管根清单 + 成品事实行。
#[derive(Debug, Serialize)]
pub struct FilesResponse {
    /// 实际参与枚举的受管根（已去重、仅存在的目录）。
    pub roots: Vec<String>,
    pub files: Vec<FileFact>,
}

/// `DELETE /api/files` 请求：`?path=<绝对路径>`。
#[derive(Debug, Deserialize)]
pub struct DeleteFileReq {
    pub path: Option<String>,
}

/// 分类名 → 前端粗类型。分类名来自 daemon 的 `classify` 规则（用户可改），
/// 这里只认内置默认那组；用户自定义分类一律落 `other`（不猜）。
fn kind_of_category(category: &str) -> &'static str {
    match category {
        "Videos" => "video",
        "Music" => "audio",
        "Images" => "photo",
        "Documents" => "doc",
        "Archives" => "archive",
        _ => "other",
    }
}

/// 扫描根集合：显式配置的 `download_dir` + 受管默认根（`manual_download_root`）。
///
/// 两者都纳入的理由：用户可能只配过其中一个（`download_dir` 为空时默认根才
/// 是落笔处的解析末端，见 `config::resolve_output` 的三层链）。按规范化路径
/// 去重（同一目录配两处不扫两遍）。
pub fn scan_roots(cfg: &crate::config::Config) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for cand in [
        cfg.download_dir.clone(),
        Some(crate::config::manual_download_root(cfg)),
    ]
    .into_iter()
    .flatten()
    {
        if !cand.is_dir() {
            continue;
        }
        let key = cand.canonicalize().unwrap_or_else(|_| cand.clone());
        if seen.insert(key) {
            out.push(cand);
        }
    }
    out
}

/// 活跃任务（下载中/排队/暂停/空闲/错误）的输出路径集合：枚举时排除。
/// 完成任务已不在写的也一并排除的意义 = 无（它的成品就在根里，该列出来）；
/// 真正要排除的是**还在写**的。
async fn active_outputs(st: &AppState) -> HashSet<PathBuf> {
    let tasks = st.tasks.lock().await;
    let mut out = HashSet::new();
    for dt in tasks.values() {
        let prog = dt.task.progress().await;
        let writing = matches!(
            prog.status,
            CoreStatus::Idle
                | CoreStatus::Queued
                | CoreStatus::Downloading
                | CoreStatus::Paused
        );
        if writing {
            out.insert(dt.output.clone());
        }
    }
    out
}

/// 是否应跳过的文件名（隐藏文件 + 引擎临时产物）。
fn skippable_name(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    TEMP_EXTS.contains(&ext.as_str())
}

fn to_fact(path: &Path, cfg: &crate::config::Config) -> Option<FileFact> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if skippable_name(&name) {
        return None;
    }
    let ext = name
        .rsplit('.')
        .next()
        .filter(|e| !e.is_empty() && *e != name)
        .unwrap_or("")
        .to_lowercase();
    let category = cfg.classify.classify(&name);
    let modified_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Some(FileFact {
        path: path.to_string_lossy().into_owned(),
        name,
        ext,
        kind: kind_of_category(&category).to_string(),
        size: meta.len() as i64,
        modified_at,
        category,
    })
}

/// 递归枚举一个根（深度受限）。目录读失败按「此处为空」处理（权限/占用都不是
/// 整个端点的失败理由——与 activity 聚合的跨进程容错同一立场）。
fn walk(root: &Path, cfg: &crate::config::Config, out: &mut Vec<FileFact>) {
    /// 受管根**根层**下由引擎自己管理的子目录名（BUG-323）。
    ///
    /// 2026-10-21 用户裁定「内部文件不入治理」之后，引擎自有物已全部收进 `.orighub/`
    /// （库根 = `.orighub/library`），根层不再有 `library` —— 真正的判据是
    /// **`.` 开头一律不进成品**（结构性规则）。这里保留两个名字只是**过渡期兜底**：
    /// 库根迁移失败（跨卷复制失败等）时旧目录仍可能在根层，别让它漏进文件管理。
    const ENGINE_OWNED_SUBDIRS: [&str; 2] = ["library", ".orighub"];

    fn rec(dir: &Path, depth: usize, cfg: &crate::config::Config, out: &mut Vec<FileFact>) {
        if depth > MAX_DEPTH || out.len() >= MAX_FILES {
            return;
        }
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return,
        };
        let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if out.len() >= MAX_FILES {
                return;
            }
            let is_dir = p.is_dir();
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            // 隐藏项（`.` 开头）一律不进成品；根层的引擎自有目录（library / .orighub）
            // 同样排除 —— 只认根层，用户自己在子目录里建的 `library` 不受影响。
            let skip = name.starts_with('.')
                || (depth == 0 && ENGINE_OWNED_SUBDIRS.contains(&name.as_str()));
            if is_dir {
                if !skip {
                    rec(&p, depth + 1, cfg, out);
                }
            } else if let Some(f) = to_fact(&p, cfg) {
                out.push(f);
            }
        }
    }
    rec(root, 0, cfg, out);
}

/// 枚举全部受管成品（跨根去重：同一文件出现在两个根下只留第一条）。
pub async fn enumerate(st: &AppState) -> Vec<FileFact> {
    let cfg = st.config.read().unwrap().clone();
    let roots = scan_roots(&cfg);
    let active = active_outputs(st).await;
    let mut out: Vec<FileFact> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for root in &roots {
        let mut part: Vec<FileFact> = Vec::new();
        walk(root, &cfg, &mut part);
        for f in part {
            let p = PathBuf::from(&f.path);
            if active.contains(&p) {
                continue; // 还在写，不是成品
            }
            let key = p.canonicalize().unwrap_or(p);
            if seen.insert(key) {
                out.push(f);
            }
        }
    }
    out
}

/// GET /api/files — 受管下载根的成品事实行（只读）。
///
/// 恒 200：根不存在 = 空列表（「确认没有」与「不知道」的区分由 `roots` 字段
/// 承担——空 `roots` 才是「没有受管根」）。文件域据此把 downloads 成品与
/// 已登记媒体合并呈现（BUG-299 M2-T01a 的 FileListView 即消费者）。
pub async fn list_files(State(st): State<Arc<AppState>>) -> Json<FilesResponse> {
    let cfg = st.config.read().unwrap().clone();
    let roots = scan_roots(&cfg);
    let files = enumerate(&st).await;
    Json(FilesResponse {
        roots: roots
            .into_iter()
            .map(|r| r.to_string_lossy().into_owned())
            .collect(),
        files,
    })
}

/// DELETE /api/files?path=<abs> — 删除受管成品（文件本体 + 任务记录）。
///
/// 守卫（个人文件安全红线，逐条都是必须）：
/// 1. `path` 必须存在于某个受管根之内（规范化后 starts_with）——根外一律 403；
/// 2. 必须是普通文件（目录/不存在 404）；
/// 3. 删除后同步清掉内存里指向同一文件的任务记录（否则下载域还挂着它的行）。
pub async fn delete_file(
    State(st): State<Arc<AppState>>,
    Query(q): Query<DeleteFileReq>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let raw = q.path.filter(|p| !p.trim().is_empty()).ok_or(StatusCode::BAD_REQUEST)?;
    let target = PathBuf::from(&raw);
    let meta = std::fs::metadata(&target).map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    let cfg = st.config.read().unwrap().clone();
    let roots = scan_roots(&cfg);
    let canon_target = target.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    let in_managed = roots.iter().any(|r| {
        r.canonicalize()
            .map(|c| canon_target.starts_with(c))
            .unwrap_or(false)
    });
    if !in_managed {
        return Err(StatusCode::FORBIDDEN);
    }
    std::fs::remove_file(&target).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // 同步清任务记录（内存态；按输出路径匹配，不分状态）。
    {
        let mut tasks = st.tasks.lock().await;
        let ids: Vec<String> = tasks
            .iter()
            .filter(|(_, dt)| dt.output == target)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            tasks.remove(&id);
        }
    }
    Ok(Json(serde_json::json!({"ok": true, "path": raw})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn cfg_with_dir(dir: &Path) -> Config {
        Config {
            download_dir: Some(dir.to_path_buf()),
            ..Config::default()
        }
    }

    fn touch(dir: &Path, name: &str, bytes: usize) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, vec![b'x'; bytes]).unwrap();
        p
    }

    /// 出口判据 7/8 的单元级牙齿：受管根下的 zip 必须被枚举，`.part` 临时产物必须被排除。
    #[test]
    fn enumerate_includes_zip_excludes_temp() {
        let root = std::env::temp_dir().join(format!("orig-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let sub = root.join("Archives");
        std::fs::create_dir_all(&sub).unwrap();
        touch(&root, "movie.mp4", 10);
        touch(&sub, "bundle.zip", 20);
        touch(&root, "half.part", 5);
        touch(&root, ".hidden.secret", 5);

        let cfg = cfg_with_dir(&root);
        let mut out = Vec::new();
        walk(&root, &cfg, &mut out);
        let names: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"bundle.zip"), "zip must be enumerated: {names:?}");
        assert!(names.contains(&"movie.mp4"), "video must be enumerated: {names:?}");
        assert!(!names.contains(&"half.part"), "temp product must be skipped: {names:?}");
        assert!(!names.iter().any(|n| n.contains("hidden")), "hidden must be skipped: {names:?}");
        let zip = out.iter().find(|f| f.name == "bundle.zip").unwrap();
        assert_eq!(zip.category, "Archives");
        assert_eq!(zip.kind, "archive");
        assert_eq!(zip.size, 20);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// BUG-323：受管根**根层**的引擎自有目录（`library` 库根 / `.orighub` 工作区）
    /// 必须被排除出「下载成品」—— 否则下载页会冒出媒体库文件（两个视图互相污染）；
    /// 用户自己在子目录里建的 `library` 不受影响（只认根层）。
    #[test]
    fn enumerate_excludes_engine_owned_root_subdirs_bug323() {
        let root = std::env::temp_dir().join(format!("orig-files-owned-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("library").join("chat--1")).unwrap();
        std::fs::create_dir_all(root.join(".orighub").join("proxies")).unwrap();
        std::fs::create_dir_all(root.join("Archive").join("library")).unwrap();
        touch(&root.join("library").join("chat--1"), "housed.mp4", 30);
        touch(&root.join(".orighub").join("proxies"), "p.mp4", 10);
        touch(&root.join("Archive").join("library"), "user.mp4", 20);
        touch(&root, "kept.mp4", 5);

        let cfg = cfg_with_dir(&root);
        let mut out = Vec::new();
        walk(&root, &cfg, &mut out);
        let names: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"kept.mp4"), "普通成品必须在: {names:?}");
        assert!(!names.contains(&"housed.mp4"), "根层库根不得进成品: {names:?}");
        assert!(!names.contains(&"p.mp4"), "根层 .orighub 不得进成品: {names:?}");
        assert!(
            names.contains(&"user.mp4"),
            "子目录里的同名 library 不受影响（只排除根层）: {names:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 分类推导：doc/other 两类 + 未知扩展名不猜。
    #[test]
    fn kind_mapping_covers_doc_and_other() {
        assert_eq!(kind_of_category("Documents"), "doc");
        assert_eq!(kind_of_category("Others"), "other");
        assert_eq!(kind_of_category("WhateverUserMadeUp"), "other");
    }

    /// 删除守卫：根外路径必须被拒（个人文件红线）。
    #[test]
    fn delete_rejects_outside_root() {
        let root = std::env::temp_dir().join(format!("orig-files-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let outside = std::env::temp_dir().join(format!("orig-files-out-{}.txt", std::process::id()));
        std::fs::write(&outside, b"nope").unwrap();
        let cfg = cfg_with_dir(&root);
        let outside_canon = outside.canonicalize().unwrap();
        let in_managed = cfg
            .download_dir
            .as_deref()
            .map(|r| r.canonicalize().map(|c| outside_canon.starts_with(c)).unwrap_or(false))
            .unwrap_or(false);
        assert!(!in_managed, "path outside managed root must be rejected");
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 扫描根去重：受管根 = 配置的 `download_dir` + 未配置时的默认根（平台默认下载目录）。
    ///
    /// BUG-323：`library_dir` 已与默认根无关（默认根恒为平台默认下载目录），
    /// 因此「同指一处」的情形由 **download_dir == 平台默认下载目录** 构造。
    #[test]
    fn scan_roots_dedups() {
        let root = std::env::temp_dir().join(format!("orig-files-roots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // 情形一：download_dir = 默认根（**过禁用盘规则后的实际值**，用户 2026-10-19
        // 裁定「~/Downloads是默认设置,但是不使用」）⇒ 两个来源同指一处 ⇒ 只扫一遍。
        // 注意不能再拿裸 `default_download_dir()` 构造「同指」：它落在 C: 上时
        // `manual_download_root` 会把它改道到 D 盘内容根，两个来源就此不同
        // （那正是规则本身，不是去重失效）。
        let def = crate::config::manual_download_root(&Config::default());
        let _ = std::fs::create_dir_all(&def);
        let cfg = Config {
            download_dir: Some(def.clone()),
            ..Config::default()
        };
        let roots = scan_roots(&cfg);
        assert_eq!(roots.len(), 1, "same dir from both sources must scan once: {roots:?}");
        assert_eq!(roots[0], def);

        // 情形二：配置了别的目录 ⇒ 配置目录与平台默认目录都要扫（去重不得误吞）。
        let cfg2 = Config {
            download_dir: Some(root.clone()),
            ..Config::default()
        };
        let roots2 = scan_roots(&cfg2);
        assert_eq!(roots2.len(), 2, "distinct roots must both be scanned: {roots2:?}");

        let _ = std::fs::remove_dir_all(&root);
    }
}
