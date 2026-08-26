//! REST 层使用的 `DownloadStatus` 结构：字段名/json tag 严格对齐 orig-hub
//! `internal/engine/types/models.go` 的 `DownloadStatus`，便于 Go 端无缝消费。

use libsurge::protocol::{ConnInfo, DownloadStatus as CoreStatus, Progress};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DownloadStatus {
    pub id: String,
    pub url: String,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_path: Option<String>,
    pub total_size: u64,
    pub downloaded: u64,
    pub progress: f64,
    pub speed: f64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub eta: i64,
    pub connections: u32,
    /// 每个连接（源）的实时明细（BUG-002）。
    #[serde(default)]
    pub connections_detail: Vec<ConnInfo>,
    /// 分块位图（每块状态 0/1/2/3）；块过多时为空，改用下方计数（BUG-002）。
    #[serde(default)]
    pub blocks: Vec<u8>,
    #[serde(default)]
    pub blocks_total: u32,
    #[serde(default)]
    pub blocks_done: u32,
    #[serde(default)]
    pub blocks_pending: u32,
    /// 每块负责源下标（255 = 未分配）；与 blocks 同门控（BUG-002 增强：按网卡着色）。
    #[serde(default)]
    pub block_source: Vec<u8>,
    /// 是否支持 Range（决定是否分块并发；前端据此判断是否渲染块网格）。
    #[serde(default)]
    pub supports_range: bool,
    pub added_at: i64,
    pub time_taken: i64,
    pub avg_speed: f64,
}

/// 把引擎内部状态词映射为 orig-hub 的字符串词表。
pub fn status_string(s: CoreStatus) -> String {
    match s {
        CoreStatus::Idle => "idle",
        CoreStatus::Queued => "queued",
        CoreStatus::Downloading => "downloading",
        CoreStatus::Paused => "paused",
        CoreStatus::Completed => "completed",
        CoreStatus::Error => "error",
        CoreStatus::Cancelled => "cancelled",
    }
    .to_string()
}

impl DownloadStatus {
    pub fn from_progress(
        id: &str,
        url: &str,
        filename: &str,
        dest_path: Option<String>,
        added_at: i64,
        connections: u32,
        prog: &Progress,
        now: i64,
        error: Option<String>,
    ) -> Self {
        let total = prog.total;
        let downloaded = prog.downloaded;
        let progress = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let time_taken = if matches!(prog.status, CoreStatus::Completed) {
            now.saturating_sub(added_at)
        } else {
            0
        };
        let avg_speed = if time_taken > 0 {
            downloaded as f64 / time_taken as f64
        } else {
            0.0
        };
        DownloadStatus {
            id: id.to_string(),
            url: url.to_string(),
            filename: filename.to_string(),
            dest_path,
            total_size: total,
            downloaded,
            progress,
            speed: prog.speed as f64,
            status: status_string(prog.status),
            error,
            eta: prog.eta_sec,
            connections,
            connections_detail: prog.connections_detail.clone(),
            blocks: prog.blocks.clone(),
            blocks_total: prog.blocks_total,
            blocks_done: prog.blocks_done,
            blocks_pending: prog.blocks_pending,
            block_source: prog.block_source.clone(),
            supports_range: prog.supports_range,
            added_at,
            time_taken,
            avg_speed,
        }
    }
}
