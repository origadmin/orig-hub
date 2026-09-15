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
        // 端口固定 9877，与 daemon 9876 分离；api_id/api_hash 等 ORIG_TG_* env 随父进程继承。
        cmd.env("PORT", "9877");
        cmd.kill_on_drop(true);
        if let Some(url) = proxy_url {
            cmd.env("ORIG_TG_PROXY", url);
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
