//! 守护进程共享状态。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use libsurge::engine::Task;
use libsurge::protocol::SseEvent;
use libsurge::registry::Registry;
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
    /// 运行期错误（完成后若有错则写入，供状态接口暴露）。
    pub error: Mutex<Option<String>>,
}

pub struct AppState {
    pub registry: Registry,
    /// 进行中的任务：id -> DownloadTask（Arc 共享，控制句柄在 Task 内）。
    pub tasks: Mutex<HashMap<String, DownloadTask>>,
    pub events: broadcast::Sender<SseEvent>,
    pub config: Config,
}

impl AppState {
    pub fn new(registry: Registry, events: broadcast::Sender<SseEvent>, config: Config) -> Self {
        Self {
            registry,
            tasks: Mutex::new(HashMap::new()),
            events,
            config,
        }
    }
}
