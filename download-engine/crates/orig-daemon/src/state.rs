//! 守护进程共享状态。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use orig_core::engine::Task;
use orig_core::protocol::SseEvent;
use orig_core::registry::Registry;
use tokio::process::Child;
use tokio::sync::{broadcast, Mutex};

use crate::config::Config;

/// 单个任务在 daemon 侧的元数据（引擎 Task 不含 url/filename/时间等展示字段）。
pub struct DownloadTask {
    pub task: Arc<Task>,
    pub url: String,
    pub filename: String,
    pub output: PathBuf,
    pub added_at: i64,
    pub max_concurrency: u32,
    /// 自动分类名（按设置 classify_rules 推导）；供状态接口随任务透传。
    pub category: Option<String>,
    /// 运行期错误（完成后若有错则写入，供状态接口暴露）。
    pub error: Mutex<Option<String>>,
}

pub struct AppState {
    pub registry: Registry,
    /// 进行中的任务：id -> DownloadTask（Arc 共享，控制句柄在 Task 内）。
    pub tasks: Mutex<HashMap<String, DownloadTask>>,
    pub events: broadcast::Sender<SseEvent>,
    /// daemon 配置（RwLock：设置页可运行时更新自动分类规则）。
    pub config: RwLock<Config>,
    /// orig-tg 子进程句柄（TG 可选插件）。None = 未启动 / 已退出。
    pub tg_child: Mutex<Option<Child>>,
}

impl AppState {
    pub fn new(registry: Registry, events: broadcast::Sender<SseEvent>, config: Config) -> Self {
        Self {
            registry,
            tasks: Mutex::new(HashMap::new()),
            events,
            config: RwLock::new(config),
            tg_child: Mutex::new(None),
        }
    }

    /// orig-tg 是否存活（句柄存在且未退出）；已退出自动清理句柄。
    pub async fn tg_is_running(&self) -> bool {
        let mut g = self.tg_child.lock().await;
        match g.as_mut() {
            Some(c) => {
                if c.try_wait().ok().flatten().is_some() {
                    *g = None;
                    false
                } else {
                    true
                }
            }
            None => false,
        }
    }

    /// 拉起 orig-tg 子进程（幂等）：注入主配置代理（custom 模式才传 `ORIG_TG_PROXY`）；
    /// 未 custom 则直连（不设该 env）。返回是否处于运行态。
    pub async fn tg_start(&self) -> std::io::Result<bool> {
        if self.tg_is_running().await {
            return Ok(true);
        }
        let cfg = self.config.read().unwrap().clone();
        let proxy_url = match cfg.proxy.mode {
            orig_core::protocol::ProxyMode::Custom => cfg.proxy.url.clone(),
            _ => None,
        };
        let mut cmd = tokio::process::Command::new(tg_binary_path());
        // 端口固定 9877，与 daemon 9876 分离。api_id/api_hash 从 `[tg]` 段显式注入，
        // 不依赖父进程环境继承，保证 Tauri/开机重启后 real 模式仍生效。
        cmd.env("PORT", "9877");
        cmd.kill_on_drop(true);
        // 会话与监控库必须落到稳定数据目录，免得 orig-tg 用 CWD 相对的默认路径，
        // 每次启动 CWD 变化就新生成会话 → 反复登录。目录在注入前先确保存在。
        let data_dir = tg_data_dir();
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            return Err(e);
        }
        cmd.env("ORIG_TG_SESSION", data_dir.join("tg/session.session"));
        cmd.env("ORIG_TG_DB", data_dir.join("tg/store.db"));
        if let Some(url) = proxy_url {
            cmd.env("ORIG_TG_PROXY", url);
        }
        if let Some(id) = &cfg.tg_api_id {
            if !id.is_empty() {
                cmd.env("ORIG_TG_API_ID", id);
            }
        }
        if let Some(h) = &cfg.tg_api_hash {
            if !h.is_empty() {
                cmd.env("ORIG_TG_API_HASH", h);
            }
        }
        let child = cmd.spawn()?;
        *self.tg_child.lock().await = Some(child);
        Ok(true)
    }

    /// 终止 orig-tg 子进程并清空句柄（幂等）。
    pub async fn tg_stop(&self) {
        let mut g = self.tg_child.lock().await;
        if let Some(c) = g.as_mut() {
            let _ = c.kill().await;
        }
        *g = None;
    }
}

/// 定位稳定数据目录：Windows 用 `%LocalAppData%\OrigHub`，否则 `$XDG_DATA_HOME` 或
/// `~/.local/share/orighub`。TG 会话/监控库统一落到该目录，与启动 CWD 无关。
pub fn tg_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ORIG_TG_DATA") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    if cfg!(windows) {
        if let Ok(app) = std::env::var("LOCALAPPDATA") {
            if !app.is_empty() {
                return PathBuf::from(app).join("OrigHub");
            }
        }
    } else if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("orighub");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".local/share/orighub");
        }
    }
    if let Ok(prof) = std::env::var("USERPROFILE") {
        if !prof.is_empty() {
            return PathBuf::from(prof).join(".local/share/orighub");
        }
    }
    // 兜底：相对路径也能用，但上游 daemon 侧一般已有稳定目录。
    PathBuf::from(".orighub")
}

/// 定位 orig-tg 可执行文件：`ORIG_TG_PATH` 优先，其次当前 exe 同目录，最后回退裸名。
pub fn tg_binary_path() -> PathBuf {
    if let Ok(p) = std::env::var("ORIG_TG_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "orig-tg.exe" } else { "orig-tg" };
            return dir.join(name);
        }
    }
    PathBuf::from("orig-tg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tg_data_dir_is_absolute_and_creatable() {
        // 注入可控的稳定目录，避免读写真实用户目录。
        let probe = std::env::temp_dir().join(format!("orighub-test-{}", std::process::id()));
        std::env::set_var("ORIG_TG_DATA", &probe);

        let dir = tg_data_dir();
        // 校验返回绝对路径且命中所注入的目录。
        assert!(dir.is_absolute(), "tg_data_dir() must be absolute");

        // 父目录可创建。
        let child = dir.join("tg/session.session");
        let parent = child.parent().unwrap();
        std::fs::create_dir_all(parent).unwrap();
        assert!(parent.is_dir(), "parent dir must be creatable");

        let _ = std::fs::remove_dir_all(&probe);
        std::env::remove_var("ORIG_TG_DATA");
    }
}
