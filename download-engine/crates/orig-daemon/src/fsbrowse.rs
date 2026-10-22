//! 目录浏览端点（BUG-323 缺陷③）：让 **WEB（网页调试模式）** 也能像桌面壳一样挑目录。
//!
//! **为什么需要它**：设置页「默认下载目录 / 库根目录」的「浏览…」走
//! `@tauri-apps/plugin-dialog`（系统原生对话框），在纯浏览器里必然点不动
//! （`DirectoryPicker` 曾直接把它 `disabled={!inTauri}`）。于是同一产品出现
//! 两套可用性语义：桌面能挑、网页只能手敲 —— 正是 BUG-179 明令禁止的。
//!
//! **为什么不算新增能力**：桌面壳早已通过原生对话框遍历整个文件系统
//! （`capabilities/default.json` 里的 `dialog:allow-open`）。本端点只是把
//! 「挑目录」这条通路从原生 IPC 换成 HTTP，**不放大可达范围**；且它只读、
//! 只列子目录（不读文件内容、不写、不删）。
//!
//! 端点：
//!   GET /api/fs/dirs           -> 文件系统根（Windows 为盘符）+ 快捷锚点
//!   GET /api/fs/dirs?path=...  -> {path, parent, entries, roots}
//!
//! 错误一律带可读原因（`{code,message}`）：目录不存在 / 非绝对路径 / 不是目录 /
//! 无权访问 —— 前端必须能直出原因，不能把失败渲染成「这里没有子目录」。
//!
//! **远程部署提示**：daemon 支持 `host=0.0.0.0`（容器/远程管理）。本端点会暴露
//! 运行账户可读的目录树，对外暴露时必须与远程管理一并加鉴权（`token`）。

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::state::AppState;

/// 单次返回的子目录上限（Windows 系统目录可能上千个子项；兜底防呆）。
const MAX_ENTRIES: usize = 1000;

/// `GET /api/fs/dirs` 查询串。`path` 省略/空 = 列出文件系统根。
#[derive(Debug, Deserialize)]
pub struct ListDirsReq {
    pub path: Option<String>,
}

/// 一个可选中的子目录（只给名字与绝对路径；文件不参与）。
#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

/// 快捷锚点：`key` 是**语义键**（label 由前端给，daemon 不产出展示文案）。
#[derive(Debug, Serialize)]
pub struct DirRoot {
    /// default_download | home | current | library
    pub key: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ListDirsResp {
    /// 当前列出的目录；`null` = 正在列文件系统根。
    pub path: Option<String>,
    /// 上级目录；盘根 / 文件系统根为 `null`。
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    /// 是否因 `MAX_ENTRIES` 截断（截断必须显式告知，否则用户会以为目录就这么点）。
    pub truncated: bool,
    pub roots: Vec<DirRoot>,
}

fn err(code: StatusCode, key: &str, message: String) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"code": key, "message": message})))
}

/// `GET /api/fs/dirs` —— 只读目录浏览。
pub async fn list_dirs(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ListDirsReq>,
) -> Result<Json<ListDirsResp>, (StatusCode, Json<serde_json::Value>)> {
    let raw = q.path.unwrap_or_default().trim().to_string();
    let cfg = st.config.read().unwrap().clone();
    // 目录枚举是同步阻塞 IO（网络盘可能久挂）：丢阻塞池，别占 async worker。
    let out = tokio::task::spawn_blocking(move || browse(&raw, &cfg))
        .await
        .map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "browse_task_failed",
                "目录枚举任务异常".to_string(),
            )
        })?;
    out.map(Json)
}

/// 纯函数主体（可单测）：`raw` 为空 → 文件系统根；否则列出该目录的子目录。
fn browse(
    raw: &str,
    cfg: &Config,
) -> Result<ListDirsResp, (StatusCode, Json<serde_json::Value>)> {
    let roots = quick_roots(cfg);

    if raw.is_empty() {
        // 空请求 = 「此电脑」：Windows 列已存在盘符，其它平台列 `/`。
        let entries: Vec<DirEntry> = fs_roots()
            .into_iter()
            .map(|p| DirEntry {
                // 出口统一 `/`（用户 2026-10-22 报「`\` 和 `/` 使用混乱」）。
                // 盘符根的 name 就是路径本身、没有独立语义，故与 path 一并统一，
                // 避免同一屏出现「C:\」和「C:/」两种写法。
                name: orig_core::paths::to_wire(&p),
                path: orig_core::paths::to_wire(&p),
            })
            .collect();
        return Ok(ListDirsResp {
            path: None,
            parent: None,
            entries,
            truncated: false,
            roots,
        });
    }

    let dir = PathBuf::from(raw);
    if !dir.is_absolute() {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "not_absolute",
            format!("需要绝对路径：{}", orig_core::paths::to_wire_str(raw)),
        ));
    }
    if !dir.exists() {
        return Err(err(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("目录不存在：{}", orig_core::paths::to_wire(&dir)),
        ));
    }
    if !dir.is_dir() {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "not_a_directory",
            format!("不是目录：{}", orig_core::paths::to_wire(&dir)),
        ));
    }

    let read = std::fs::read_dir(&dir).map_err(|e| {
        err(
            StatusCode::FORBIDDEN,
            "unreadable",
            format!("无权读取目录 {}：{e}", orig_core::paths::to_wire(&dir)),
        )
    })?;

    let mut names: Vec<(String, PathBuf)> = Vec::new();
    for ent in read.flatten() {
        let p = ent.path();
        // 跟随符号链接判断（Windows 目录联接/junction 也要能进）。
        if !p.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.is_empty() {
            continue;
        }
        names.push((name, p));
    }
    // 大小写不敏感排序（Windows 资源管理器同序），前端不再自己排。
    names.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    let truncated = names.len() > MAX_ENTRIES;
    let entries: Vec<DirEntry> = names
        .into_iter()
        .take(MAX_ENTRIES)
        .map(|(name, p)| DirEntry {
            name,
            path: orig_core::paths::to_wire(&p),
        })
        .collect();

    // 上级：盘根（C:/）与文件系统根为 null —— 前端据此禁用「上一级」。
    let parent = dir
        .parent()
        .filter(|p| *p != dir.as_path() && !p.as_os_str().is_empty())
        .map(|p| orig_core::paths::to_wire(&p));

    Ok(ListDirsResp {
        path: Some(orig_core::paths::to_wire(&dir)),
        parent,
        entries,
        truncated,
        roots,
    })
}

/// 文件系统根：Windows 逐盘符探测存在性；其它平台只有 `/`。
fn fs_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut out = Vec::new();
        for letter in b'A'..=b'Z' {
            let p = PathBuf::from(format!("{}:\\", letter as char));
            if p.exists() {
                out.push(p);
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        vec![PathBuf::from("/")]
    }
}

/// 快捷锚点（按语义给键，去重后只保留**存在**的目录）。
///
/// 顺序即前端展示顺序：系统下载目录在最前（设置页语境里它就是默认落点），
/// 其次主目录、当前配置值、受管库根。
fn quick_roots(cfg: &Config) -> Vec<DirRoot> {
    let mut out: Vec<DirRoot> = Vec::new();
    let mut push = |key: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            if !p.is_dir() {
                return;
            }
            let s = orig_core::paths::to_wire(&p);
            if out.iter().any(|r| r.path == s) {
                return;
            }
            out.push(DirRoot {
                key: key.to_string(),
                path: s,
            });
        }
    };
    push("default_download", Some(orig_core::paths::default_download_dir()));
    push("home", orig_core::paths::home_dir());
    push("current", cfg.download_dir.clone());
    push("library", cfg.library_dir.clone());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "orighub-fsbrowse-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn empty_path_lists_fs_roots_not_an_error() {
        let cfg = Config::default();
        let r = browse("", &cfg).unwrap();
        assert!(r.path.is_none());
        assert!(r.parent.is_none());
        assert!(!r.entries.is_empty(), "文件系统根不得为空");
        assert!(r.roots.iter().any(|x| x.key == "default_download"));
    }

    #[test]
    fn lists_only_subdirectories_sorted_case_insensitive() {
        let base = tmp_dir("list");
        std::fs::create_dir_all(base.join("beta")).unwrap();
        std::fs::create_dir_all(base.join("Alpha")).unwrap();
        std::fs::write(base.join("file.txt"), b"x").unwrap();

        let r = browse(base.to_str().unwrap(), &Config::default()).unwrap();
        let names: Vec<&str> = r.entries.iter().map(|e| e.name.as_str()).collect();
        // 文件不参与；目录按小写字典序
        assert_eq!(names, vec!["Alpha", "beta"]);
        // 上级 = 临时目录（`temp_dir()` 带尾分隔符、`Path::parent()` 不带 ⇒ 归一后比）
        let norm = |s: &str| s.trim_end_matches(['\\', '/']).to_lowercase();
        let parent = r.parent.clone().unwrap();
        assert_eq!(
            norm(&parent),
            norm(&std::env::temp_dir().to_string_lossy()),
            "parent: {parent}"
        );
        assert!(!r.truncated);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_dir_is_not_found_with_reason() {
        let cfg = Config::default();
        let (code, body) = browse("C:/definitely/not/here/xyz", &cfg).unwrap_err();
        assert_eq!(code, StatusCode::NOT_FOUND);
        // 原因必须可直出（BUG-176/318：失败不得渲染成「没有内容」）
        let msg = body.0["message"].as_str().unwrap();
        assert!(msg.contains("目录不存在"), "message: {msg}");
    }

    #[test]
    fn relative_path_rejected_422() {
        let cfg = Config::default();
        let (code, body) = browse("some/rel", &cfg).unwrap_err();
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body.0["code"], "not_absolute");
    }

    #[test]
    fn file_target_is_not_a_directory() {
        let base = tmp_dir("file");
        let f = base.join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        let (code, body) = browse(f.to_str().unwrap(), &Config::default()).unwrap_err();
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body.0["code"], "not_a_directory");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn quick_roots_skips_missing_and_dedups() {
        let mut cfg = Config::default();
        cfg.download_dir = Some(orig_core::paths::default_download_dir());
        let roots = quick_roots(&cfg);
        let keys: Vec<&str> = roots.iter().map(|r| r.key.as_str()).collect();
        // download_dir 与平台默认下载目录同值 ⇒ 去重后不得出两个
        assert_eq!(keys.iter().filter(|k| **k == "default_download").count(), 1);
        assert!(!keys.contains(&"current"), "同值必须去重：{keys:?}");
    }
}
