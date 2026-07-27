//! 守护进程配置：下载目录、并发数、鉴权 token、端口。
//!
//! 加载顺序（对齐 orig-hub `internal/config` 的「配置存储」语义）：
//!   1. 环境变量（优先，便于容器/CI 覆盖）
//!   2. `download-engine.toml` 简单 `key = "value"` 行
//!
//! 下载目录三层解析见 [`resolve_output`]：
//!   请求 output_path → 配置 download_dir → 平台默认目录（~/Downloads）

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// 默认下载目录（来自配置/环境变量）。为空时回退平台默认目录。
    pub download_dir: Option<PathBuf>,
    /// 默认并发连接数（对齐 orig-hub `max_connections` 缺省 8）。
    pub max_connections: u32,
    /// Bearer token；为空表示不鉴权（对齐 orig-hub：token 空则不校验）。
    pub token: Option<String>,
    /// 监听端口（对齐 orig-hub daemon 缺省 9876）。
    pub port: u16,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            download_dir: None,
            max_connections: 8,
            token: None,
            port: 9876,
        }
    }
}

impl Config {
    /// 加载配置：环境变量优先，其次 `download-engine.toml`。
    pub fn load() -> Self {
        let mut cfg = Config::default();

        if let Ok(d) = std::env::var("SURGE_DOWNLOAD_DIR") {
            if !d.is_empty() {
                cfg.download_dir = Some(PathBuf::from(d));
            }
        }
        if let Ok(m) = std::env::var("SURGE_MAX_CONNECTIONS") {
            if let Ok(v) = m.parse() {
                cfg.max_connections = v;
            }
        }
        if let Ok(t) = std::env::var("SURGE_TOKEN") {
            if !t.is_empty() {
                cfg.token = Some(t);
            }
        }
        if let Ok(p) = std::env::var("PORT") {
            if let Ok(v) = p.parse() {
                cfg.port = v;
            }
        }

        if let Ok(txt) = std::fs::read_to_string("download-engine.toml") {
            for line in txt.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    let k = k.trim();
                    let v = v.trim().trim_matches('"').to_string();
                    match k {
                        "download_dir" => {
                            if !v.is_empty() {
                                cfg.download_dir = Some(PathBuf::from(v));
                            }
                        }
                        "max_connections" => {
                            if let Ok(n) = v.parse() {
                                cfg.max_connections = n;
                            }
                        }
                        "token" => {
                            if !v.is_empty() {
                                cfg.token = Some(v);
                            }
                        }
                        "port" => {
                            if let Ok(n) = v.parse() {
                                cfg.port = n;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        cfg
    }
}

/// 平台默认下载目录（对齐 orig-hub：~/Downloads）。
pub fn default_download_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Downloads");
    }
    if let Ok(prof) = std::env::var("USERPROFILE") {
        return PathBuf::from(prof).join("Downloads");
    }
    PathBuf::from(".")
}

/// 三层解析：请求 dir → 配置 download_dir → 平台默认目录（~/Downloads）。
/// 仅当三者皆空才落到当前目录（极端兜底）。
pub fn resolve_output(req_dir: Option<&str>, cfg: &Config, filename: &str) -> PathBuf {
    let base = req_dir
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| cfg.download_dir.clone())
        .unwrap_or_else(default_download_dir);
    base.join(filename)
}
