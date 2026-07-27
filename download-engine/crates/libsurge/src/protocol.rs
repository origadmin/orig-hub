//! 协议插件契约 —— 迁移设计核心抽象层（v2：Source / BlockMap 模型）。
//!
//! ## 关键演进：为支持 HTTP+BT 混合下载
//! 早期单体 `Downloader`（一个下载器跑完整个任务）无法表达「同一个文件，
//! HTTP 镜像 + BT 种子同时下」。v2 改为：
//!
//! - **`Block`**：文件被切分为固定逻辑块。统合 HTTP 的 Range 切片 与 BT 的 piece
//!   —— 二者都是「往文件某个 offset 写一段连续字节」。
//! - **`Source`**：一种获取字节的方式（HTTP 镜像 / BT swarm / FTP / Mock）。
//!   统一接口 = 给我一个 `Block`，我把这段字节流式写入 writer。
//! - **`BlockMap`**：任务级完成位图。续传 = 「哪些块已完成」，天然跨协议
//!   （HTTP 下了一半的块，剩下可由 BT 补；反之亦然）。
//! - **`Protocol`**：从 URL 创建一个 `Source` 集合。混合任务返回多种 `Source`
//!   （HTTP 主源 + 镜像 + BT swarm 源），引擎调度器把 pending 块分派给可用源。
//!
//! 引擎（[`crate::engine`]）只跟 `Source`/`BlockMap` 对话，不知道背后是哪种协议。

use crate::error::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::AsyncWrite;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// 协议能力标志位（对标 Go 的 `1 << iota` 能力枚举）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilitySet(pub u32);

impl CapabilitySet {
    pub const PAUSE_RESUME: u32 = 1 << 0;
    /// 支持任意 offset 随机读取：HTTP Range / BT piece 都满足。
    pub const RANGE: u32 = 1 << 1;
    pub const RESUME: u32 = 1 << 2;
    /// 支持多镜像 / 多节点并发取不同块。
    pub const MIRRORS: u32 = 1 << 3;
    /// 可把单文件切成多块并发下载。
    pub const CHUNK: u32 = 1 << 4;
    /// BT DHT 寻址能力。
    pub const DHT: u32 = 1 << 5;
    /// BT 多 peer 并行。
    pub const MULTI_NODE: u32 = 1 << 6;
    /// BT 做种 / 长效保活（Surge 产品特性）。
    pub const PINNING: u32 = 1 << 7;
    /// 仅支持顺序整文件流（如部分 FTP，无 REST/Range）。只能作 fallback 整文件源。
    pub const STREAM_ONLY: u32 = 1 << 8;

    pub fn has(&self, flag: u32) -> bool {
        self.0 & flag != 0
    }
    pub fn empty() -> Self {
        CapabilitySet(0)
    }
}

/// 下载状态机（与 orig-hub `engine/types` 的 status 词对齐：
/// idle / queued / downloading / paused / completed / error / cancelled）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    Idle,
    Queued,
    Downloading,
    Paused,
    Completed,
    Error,
    Cancelled,
}

/// 探测得到的元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metadata {
    pub total_size: u64,
    pub supports_range: bool,
    pub supports_resume: bool,
    pub filename: Option<String>,
}

/// 解析后的 URL。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedUrl {
    pub raw: String,
    pub scheme: String,
    pub path: String,
    pub query: HashMap<String, String>,
}

/// 下载配置。
#[derive(Debug, Clone)]
pub struct DownloadConfig {
    pub destination: Option<PathBuf>,
    pub block_size: u64,
    pub max_concurrency: u32,
    /// 镜像源 URL（HTTP 协议用；BT 协议忽略）。
    pub mirrors: Vec<String>,
}

/// 块：文件被切分为固定逻辑块。统合 HTTP Range 切片 与 BT piece。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub index: u32,
    pub offset: u64,
    pub len: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockState {
    Pending,
    Assigned,
    Done,
    Failed,
}

/// 块映射：任务级完成位图，承载断点续传（跨协议）。
#[derive(Debug, Clone)]
pub struct BlockMap {
    pub total: u64,
    pub block_size: u64,
    pub blocks: Vec<BlockState>,
}

impl BlockMap {
    pub fn new(total: u64, block_size: u64) -> Self {
        let bs = if block_size == 0 { 1 << 20 } else { block_size };
        let n = ((total + bs - 1) / bs) as usize;
        Self {
            total,
            block_size: bs,
            blocks: vec![BlockState::Pending; n.max(1)],
        }
    }

    /// 返回下一个 pending 块的索引（无则 None = 全部完成）。
    pub fn next_pending(&self) -> Option<u32> {
        self.blocks
            .iter()
            .position(|s| *s == BlockState::Pending)
            .map(|i| i as u32)
    }

    pub fn pending_count(&self) -> u32 {
        self.blocks
            .iter()
            .filter(|s| **s == BlockState::Pending)
            .count() as u32
    }

    /// 已 Done 块的累计字节数（用于进度）。
    pub fn done_bytes(&self) -> u64 {
        let mut b = 0u64;
        for (i, s) in self.blocks.iter().enumerate() {
            if *s == BlockState::Done {
                let off = (i as u64) * self.block_size;
                let len = if off + self.block_size > self.total {
                    self.total - off
                } else {
                    self.block_size
                };
                b += len;
            }
        }
        b
    }

    pub fn all_done(&self) -> bool {
        self.blocks.iter().all(|s| *s == BlockState::Done)
    }

    /// 返回第 idx 个块的几何信息（offset / len）。
    pub fn block_at(&self, idx: u32) -> Block {
        let bs = self.block_size;
        let offset = (idx as u64) * bs;
        let len = if offset + bs > self.total {
            self.total - offset
        } else {
            bs
        };
        Block {
            index: idx,
            offset,
            len,
        }
    }

    /// 设置某块状态（越界忽略）。
    pub fn set_state(&mut self, idx: u32, s: BlockState) {
        let i = idx as usize;
        if i < self.blocks.len() {
            self.blocks[i] = s;
        }
    }

    /// 由已有文件长度恢复完成位图（断点续传）。
    /// 仅当块区间完全落在已有长度内才标 Done（末块若部分写入则保留 Pending）。
    pub fn mark_done_by_len(&mut self, existing: u64) {
        if existing == 0 {
            return;
        }
        for (i, s) in self.blocks.iter_mut().enumerate() {
            let off = (i as u64) * self.block_size;
            let len = if off + self.block_size > self.total {
                self.total - off
            } else {
                self.block_size
            };
            if off + len <= existing {
                *s = BlockState::Done;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Http,
    Bittorrent,
    Ftp,
    Mock,
}

/// 源抽象：一种获取字节的方式。统一接口 = 给我一个 `Block`，
/// 我把这段字节流式写入 `writer`（避免整块驻留内存）。
///
/// - `HttpSource`：发 `Range: bytes=offset..offset+len` 请求。
/// - `BtSource`：把 block 映射到 piece(s)，向 swarm 请求并写入 offset。
/// - `FtpSource`：若支持 `REST` 则 Range，否则整文件流（仅作 fallback，见 `STREAM_ONLY`）。
/// - `MockSource`：由 seed 派生确定性字节（虚拟协议）。
#[async_trait]
pub trait Source: Send + Sync {
    fn source_kind(&self) -> SourceKind;
    fn capabilities(&self) -> CapabilitySet;
    async fn fetch_block(
        &self,
        block: &Block,
        token: &CancellationToken,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> Result<()>;
}

/// 协议插件：引擎总线上的扩展点。从 URL 创建一个 `Source` 集合。
#[async_trait]
pub trait Protocol: Send + Sync {
    fn name(&self) -> &'static str;
    fn schemes(&self) -> &[&'static str];

    async fn parse_url(&self, raw: &str) -> Result<ParsedUrl>;
    async fn probe(&self, url: &ParsedUrl) -> Result<Metadata>;
    fn capabilities(&self) -> CapabilitySet;

    /// 为该 URL 创建一组 `Source`。
    /// - HTTP 协议：主源 + 各镜像源（多个 `HttpSource`）。
    /// - BT 协议：一个 `BtSource`（内部管理 swarm）。
    /// - 混合任务：返回多种 `Source` 类型，调度器统一填块。
    async fn create_sources(
        &self,
        url: &ParsedUrl,
        cfg: &DownloadConfig,
    ) -> Result<Vec<Box<dyn Source>>>;
}

/// 进度快照（引擎内部，REST 层会再映射为 orig-hub 的 DownloadStatus 字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    pub id: String,
    pub status: DownloadStatus,
    pub downloaded: u64,
    pub total: u64,
    pub speed: u64,
    pub eta_sec: i64,
    pub protocol: String,
    /// 完成时的最终 sha256（续传/校验用）；进行中/失败时 None。
    #[serde(default)]
    pub hash_sha256: Option<String>,
}

/// 运行期控制句柄：暂停标志 + 恢复通知 + 取消令牌。
/// 由 `Task` 持有并共享给运行中的源，HTTP / UI 层通过它间接操控。
#[derive(Debug)]
pub struct Control {
    pub paused: AtomicBool,
    pub resume: Notify,
    pub cancel: CancellationToken,
}

impl Control {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            paused: AtomicBool::new(false),
            resume: Notify::new(),
            cancel: CancellationToken::new(),
        })
    }
}

/// SSE 事件（事件名与 data 字段；REST 层独立映射，二者互不耦合）。
#[derive(Debug, Clone, Serialize)]
pub enum SseEvent {
    Progress(Progress),
    Completed { id: String, hash_sha256: String, path: String },
    Error { id: String, message: String },
    Paused { id: String },
    Resumed { id: String },
    Deleted { id: String },
}

impl SseEvent {
    pub fn name(&self) -> &'static str {
        match self {
            SseEvent::Progress(_) => "progress",
            SseEvent::Completed { .. } => "completed",
            SseEvent::Error { .. } => "error",
            SseEvent::Paused { .. } => "paused",
            SseEvent::Resumed { .. } => "resumed",
            SseEvent::Deleted { .. } => "deleted",
        }
    }

    pub fn data_json(&self) -> String {
        match self {
            SseEvent::Progress(p) => serde_json::to_string(p).unwrap_or_default(),
            SseEvent::Completed { id, hash_sha256, path } => {
                serde_json::json!({"id": id, "hash_sha256": hash_sha256, "path": path}).to_string()
            }
            SseEvent::Error { id, message } => {
                serde_json::json!({"id": id, "message": message}).to_string()
            }
            SseEvent::Paused { id } => serde_json::json!({"id": id}).to_string(),
            SseEvent::Resumed { id } => serde_json::json!({"id": id}).to_string(),
            SseEvent::Deleted { id } => serde_json::json!({"id": id}).to_string(),
        }
    }
}
