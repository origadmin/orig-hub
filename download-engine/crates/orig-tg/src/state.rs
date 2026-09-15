//! orig-tg 服务共享状态。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::login::Client;
use crate::store::Store;

/// 内存环形日志缓冲（诊断用，不持久化）。容量上限防内存增长。
pub struct RingLog {
    inner: Mutex<VecDeque<String>>,
    cap: usize,
}

impl RingLog {
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Mutex::new(VecDeque::new()),
            cap,
        }
    }

    /// 追加一行（带时间戳前缀 `[epoch_secs] `）。
    pub fn push(&self, line: impl AsRef<str>) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut q = self.inner.lock().unwrap();
        if q.len() >= self.cap {
            q.pop_front();
        }
        q.push_back(format!("[{ts}] {}", line.as_ref()));
    }

    /// 返回最近 `lines` 条（新→旧）。
    pub fn recent(&self, lines: usize) -> Vec<String> {
        let q = self.inner.lock().unwrap();
        q.iter().rev().take(lines).cloned().collect()
    }

    /// 总条数。
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

pub struct AppState {
    /// 底层 MTProto 客户端抽象（骨架=内存占位；后续接入 grammers）。
    pub client: Arc<dyn Client>,
    /// 服务配置。
    pub config: Config,
    /// 诊断环形日志（`/api/tg/logs` 读取）。
    pub logs: RingLog,
    /// 监控存储（频道/消息/游标）。
    pub store: Store,
    /// 客户端真实度：`real`=grammers，`dummy`=内存占位（api_id/hash 未配置）。
    pub api_mode: &'static str,
}

impl AppState {
    pub fn new(client: Arc<dyn Client>, config: Config, api_mode: &'static str, store: Store) -> Self {
        Self {
            client,
            config,
            logs: RingLog::new(200),
            store,
            api_mode,
        }
    }

    pub fn push_log(&self, line: impl AsRef<str>) {
        self.logs.push(line);
    }
}