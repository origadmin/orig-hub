//! orig-tg 独立服务配置。
//!
//! 加载顺序（对齐 orig-daemon）：
//!   1. 环境变量（优先，便于容器/CI/Tauri sidecar 注入）
//!   2. 默认值
//!
//! 关键项：监听端口（独立于 orig-daemon 的 9876）、Telegram api_id/api_hash、
//! 本地会话文件路径（等同密码凭证，须安全落盘）、下载落地目录。

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// 监听地址（默认 127.0.0.1，仅本机）。
    pub bind: String,
    /// 监听端口（默认 9877，独立于 orig-daemon 的 9876）。
    pub port: u16,
    /// Telegram app api_id（来自 my.telegram.org，用户账号凭证，非 Bot token）。
    pub api_id: Option<i32>,
    /// Telegram app api_hash（来自 my.telegram.org）。
    pub api_hash: Option<String>,
    /// MTProto 会话文件路径（持登录态；等同密码，须安全存储）。
    pub session_path: PathBuf,
    /// 监控存储 SQLite 数据库文件路径（频道/消息/游标）。
    pub db_path: PathBuf,
    /// 后台监控轮询间隔（秒，最小 10s）。定时增量拉取被监控频道的新媒体入库。
    pub monitor_interval_secs: u64,
    /// Telegram 媒体落地根目录（下载完成后交给 orig-core 归档）。
    pub download_dir: PathBuf,
    /// MTProto 出口socks5代理 URL（如 "socks5://127.0.0.1:7897"）；为空走直连。
    /// 国内网络直连 Telegram 常不可达，设置后取码/登录/下载均经该代理。
    pub proxy: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1".to_string(),
            port: 9877,
            api_id: None,
            api_hash: None,
            session_path: PathBuf::from("./tg.session"),
            db_path: PathBuf::from("./tg_store.db"),
            monitor_interval_secs: 30,
            download_dir: default_download_dir(),
            proxy: None,
        }
    }
}

/// 平台默认下载目录（对齐 orig-daemon：~/Downloads）。
pub fn default_download_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Downloads");
    }
    if let Ok(prof) = std::env::var("USERPROFILE") {
        return PathBuf::from(prof).join("Downloads");
    }
    PathBuf::from(".")
}

impl Config {
    /// 从环境变量加载（覆盖默认值）。
    pub fn load() -> Self {
        let mut cfg = Config::default();

        if let Ok(v) = std::env::var("ORIG_TG_PORT") {
            if let Ok(n) = v.parse() {
                cfg.port = n;
            }
        }
        if let Ok(v) = std::env::var("ORIG_TG_API_ID") {
            if let Ok(n) = v.parse() {
                cfg.api_id = Some(n);
            }
        }
        if let Ok(v) = std::env::var("ORIG_TG_API_HASH") {
            if !v.is_empty() {
                cfg.api_hash = Some(v);
            }
        }
        if let Ok(v) = std::env::var("ORIG_TG_SESSION") {
            if !v.is_empty() {
                cfg.session_path = PathBuf::from(v);
            }
        }
        if let Ok(v) = std::env::var("ORIG_TG_DB") {
            if !v.is_empty() {
                cfg.db_path = PathBuf::from(v);
            }
        }
        if let Ok(v) = std::env::var("ORIG_TG_MONITOR_INTERVAL") {
            if let Ok(n) = v.parse() {
                cfg.monitor_interval_secs = n;
            }
        }
        if let Ok(v) = std::env::var("ORIG_TG_DOWNLOAD_DIR") {
            if !v.is_empty() {
                // Expand a leading `~` typed by the user (BUG-071).
                cfg.download_dir = orig_core::paths::expand_tilde(&v);
            }
        }
        if let Ok(v) = std::env::var("ORIG_TG_PROXY") {
            if !v.is_empty() {
                cfg.proxy = Some(v);
            }
        }
        cfg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_listen_independently_from_daemon() {
        assert_eq!(Config::default().port, 9877);
        assert_eq!(Config::default().bind, "127.0.0.1");
    }

    /// BUG-071 migration: a legacy `ORIG_TG_DOWNLOAD_DIR=~/Downloads` must be
    /// expanded to a real absolute path, never kept as a literal tilde.
    #[test]
    fn legacy_tilde_download_dir_env_is_expanded() {
        let Some(home) = orig_core::paths::home_dir() else {
            return; // no home directory here: expansion is impossible by definition
        };
        unsafe {
            std::env::set_var("ORIG_TG_DOWNLOAD_DIR", "~/Downloads");
        }
        let cfg = Config::load();
        unsafe {
            std::env::remove_var("ORIG_TG_DOWNLOAD_DIR");
        }
        assert_eq!(cfg.download_dir, home.join("Downloads"));
        assert!(!cfg.download_dir.to_string_lossy().contains('~'));
    }

    #[test]
    fn env_overrides() {
        // 用临时环境变量注入验证覆盖逻辑（独立测试进程避免污染）
        unsafe {
            std::env::set_var("ORIG_TG_API_ID", "123456");
            std::env::set_var("ORIG_TG_PORT", "9999");
            std::env::set_var("ORIG_TG_PROXY", "socks5://127.0.0.1:7897");
        }
        let cfg = Config::load();
        assert_eq!(cfg.api_id, Some(123456));
        assert_eq!(cfg.port, 9999);
        assert_eq!(cfg.proxy.as_deref(), Some("socks5://127.0.0.1:7897"));
        unsafe {
            std::env::remove_var("ORIG_TG_API_ID");
            std::env::remove_var("ORIG_TG_PORT");
            std::env::remove_var("ORIG_TG_PROXY");
        }
    }
}