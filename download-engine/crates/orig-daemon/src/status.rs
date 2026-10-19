//! REST 层使用的 `DownloadStatus` 结构：字段名/json tag 严格对齐 orig-hub
//! `internal/engine/types/models.go` 的 `DownloadStatus`，便于 Go 端无缝消费。

use orig_core::protocol::{ConnInfo, DownloadStatus as CoreStatus, Progress};
use serde::Serialize;

use crate::activity::{action_word, actions_for, EngineRow, TaskKind};

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
    /// 自动分类名（按设置 classify_rules 推导：Videos/Music/.../Others）。
    /// 前端据此在「全部文件」下按分类筛选。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 该行**真实具备**的控制动词（与 `TaskView.actions` 同名字段同语义，
    /// 由同一个 `actions_for` 计算）。
    ///
    /// 为什么必须下发：让前端只认 `actions[]` 而不认 `status`，新增来源（未来的
    /// 第 N 个协议/插件）就只需在 `actions_for` 里声明能力，前端零改动。前端按
    /// status 硬编码按钮则是每个来源改一遍 —— 那是把契约搬进 UI。
    #[serde(default)]
    pub actions: Vec<String>,
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
    /// 由单一真源行构造。
    ///
    /// `detail = None` ⇒ 本进程不持有活体句柄（终态，或上次进程留下的记录）⇒
    /// 无实时明细（分块/连接/位图）可采，只陈事实。
    ///
    /// 状态词取 `row.status` 而非引擎内部 `Progress.status`：库里会存
    /// `interrupted`（进程消失留下的），引擎的 `CoreStatus` **没有**这个枚举值，
    /// 从 Progress 反推就会把它吞成别的状态。
    pub fn from_row(row: &EngineRow, detail: Option<&Progress>, now: i64) -> Self {
        let (total, downloaded, speed, eta, supports_range) = match detail {
            Some(p) => (p.total, p.downloaded, p.speed as f64, p.eta_sec, p.supports_range),
            None => (row.total, row.done, 0.0, 0, false),
        };
        let progress = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let time_taken = if row.status == "completed" {
            now.saturating_sub(row.added_at)
        } else {
            0
        };
        let avg_speed = if time_taken > 0 {
            downloaded as f64 / time_taken as f64
        } else {
            0.0
        };
        Self {
            id: row.id.clone(),
            url: row.url.clone(),
            filename: row.filename.clone(),
            dest_path: Some(row.output.clone()),
            total_size: total,
            downloaded,
            progress,
            speed,
            status: row.status.clone(),
            error: row.error.clone(),
            eta,
            connections: row.max_concurrency,
            connections_detail: detail
                .map(|p| p.connections_detail.clone())
                .unwrap_or_default(),
            blocks: detail.map(|p| p.blocks.clone()).unwrap_or_default(),
            blocks_total: detail.map(|p| p.blocks_total).unwrap_or(0),
            blocks_done: detail.map(|p| p.blocks_done).unwrap_or(0),
            blocks_pending: detail.map(|p| p.blocks_pending).unwrap_or(0),
            block_source: detail.map(|p| p.block_source.clone()).unwrap_or_default(),
            supports_range,
            added_at: row.added_at,
            time_taken,
            avg_speed,
            category: row.category.clone(),
            actions: actions_for(TaskKind::Download, &row.status)
                .iter()
                .map(|a| action_word(*a).to_string())
                .collect(),
        }
    }

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
        category: Option<String>,
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
        let st = status_string(prog.status);
        DownloadStatus {
            id: id.to_string(),
            url: url.to_string(),
            filename: filename.to_string(),
            dest_path,
            total_size: total,
            downloaded,
            progress,
            speed: prog.speed as f64,
            status: st.clone(),
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
            category,
            // 与 `from_row` 同一真源：任何一条 DownloadStatus 出去都带真实动词，
            // 前端就不需要按 status 自己推按钮。
            actions: actions_for(TaskKind::Download, &st)
                .iter()
                .map(|a| action_word(*a).to_string())
                .collect(),
        }
    }
}
