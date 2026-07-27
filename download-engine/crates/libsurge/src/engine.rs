//! 下载任务引擎：基于 `BlockMap` + `Source` 的并发调度。
//!
//! - 主循环 `run` 按 `max_concurrency` 拉起一组 worker；每个 worker 通过
//!   `claim_pending`（写锁内原子认领）领取 pending 块，独立打开文件句柄、
//!   按 `block.offset` seek 后调用 `Source::fetch_block` 填充，标记 Done 并广播进度。
//! - 并发安全：块间 offset 互不重叠，各 worker 写不同区间；`claim_pending` 保证
//!   同一块只会被一个 worker 认领。
//! - 续传：启动前若输出文件已存在，按已有长度恢复完成位图。
//! - 完成：全块 Done 后计算文件 sha256，随 `Completed` 事件下发。
//!
//! 引擎只跟 `Source` / `BlockMap` 对话，不感知具体协议——加 BT 不改这里。

use crate::error::{Result, SurgeError};
use crate::protocol::*;
use sha2::{Digest, Sha256};
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

/// 一次下载任务：块映射 + 源集合 + 输出文件 + 控制句柄。
pub struct Task {
    pub id: String,
    pub output: PathBuf,
    /// 完成位图（RwLock：续传恢复 + 并发 worker 共享写）。
    pub block_map: RwLock<BlockMap>,
    pub sources: Vec<Box<dyn Source>>,
    pub control: Arc<Control>,
    pub events: tokio::sync::broadcast::Sender<SseEvent>,
    pub protocol_name: String,
    pub downloaded: Arc<AtomicU64>,
    /// 并发 worker 数（来自 DownloadConfig.max_concurrency）。
    pub max_concurrency: u32,
    /// 完成时的 sha256（供 history / Progress 暴露，用于校验与续传）。
    pub final_hash: std::sync::RwLock<Option<String>>,
}

impl Task {
    /// 构造一个任务（返回 Arc，便于在 HTTP 层共享与跨线程控制）。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: String,
        output: PathBuf,
        total: u64,
        block_size: u64,
        sources: Vec<Box<dyn Source>>,
        events: tokio::sync::broadcast::Sender<SseEvent>,
        protocol_name: String,
        max_concurrency: u32,
    ) -> Arc<Self> {
        Arc::new(Self {
            id,
            output,
            block_map: RwLock::new(BlockMap::new(total, block_size)),
            sources,
            control: Control::new(),
            events,
            protocol_name,
            downloaded: Arc::new(AtomicU64::new(0)),
            max_concurrency,
            final_hash: std::sync::RwLock::new(None),
        })
    }

    pub async fn progress(&self) -> Progress {
        let bm = self.block_map.read().await;
        let (status, speed, eta) = if self.control.cancel.is_cancelled() {
            (DownloadStatus::Cancelled, 0u64, -1i64)
        } else if self.control.paused.load(Ordering::SeqCst) {
            (DownloadStatus::Paused, 0u64, -1i64)
        } else if bm.all_done() {
            (DownloadStatus::Completed, 0u64, 0i64)
        } else {
            (DownloadStatus::Downloading, 0u64, -1i64)
        };
        Progress {
            id: self.id.clone(),
            status,
            downloaded: self.downloaded.load(Ordering::SeqCst),
            total: bm.total,
            speed,
            eta_sec: eta,
            protocol: self.protocol_name.clone(),
            hash_sha256: self.final_hash.read().unwrap().clone(),
        }
    }

    /// 主循环：拉起并发 worker 池，全部完成后计算 sha256 并下发 Completed。
    pub async fn run(self: &Arc<Self>) -> Result<()> {
        // 断点续传：若输出文件已存在，按已有长度恢复完成位图。
        let existing = std::fs::metadata(&self.output).map(|m| m.len()).unwrap_or(0);
        if existing > 0 {
            self.block_map
                .write()
                .await
                .mark_done_by_len(existing);
            self.downloaded
                .store(self.block_map.read().await.done_bytes(), Ordering::SeqCst);
        }

        let token = self.control.cancel.clone();
        let concurrency = (self.max_concurrency.max(1)) as usize;
        let mut handles = Vec::with_capacity(concurrency);
        for _ in 0..concurrency {
            let self2 = Arc::clone(self);
            let token2 = token.clone();
            handles.push(tokio::spawn(async move { self2.worker(token2).await }));
        }

        // 收集第一个硬错误（其余 worker 也会自然退出）。
        let mut hard_err: Option<SurgeError> = None;
        for h in handles {
            if let Ok(Err(e)) = h.await {
                if hard_err.is_none() {
                    hard_err = Some(e);
                }
            }
        }
        if let Some(e) = hard_err {
            return Err(e);
        }

        // 全块完成：计算文件 sha256 作为校验。
        let hash = compute_sha256(&self.output)
            .await
            .unwrap_or_else(|_| "sha256-compute-failed".to_string());
        *self.final_hash.write().unwrap() = Some(hash.clone());
        self.events
            .send(SseEvent::Completed {
                id: self.id.clone(),
                hash_sha256: hash,
                path: self.output.to_string_lossy().into(),
            })
            .ok();
        Ok(())
    }

    /// 单个 worker：循环认领 pending 块并填充，直到无剩余或出错/取消。
    async fn worker(&self, token: CancellationToken) -> Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&self.output)
            .await?;

        loop {
            if token.is_cancelled() {
                return Err(SurgeError::Cancelled);
            }
            // 暂停：阻塞直到被 resume 唤醒。
            while self.control.paused.load(Ordering::SeqCst) {
                self.control.resume.notified().await;
                if token.is_cancelled() {
                    return Err(SurgeError::Cancelled);
                }
            }

            let idx = match self.claim_pending().await {
                Some(i) => i,
                None => return Ok(()), // 无更多 pending 块
            };
            let block = self.block_at(idx).await;

            match self.pick_source(&block) {
                Some(si) => {
                    file.seek(SeekFrom::Start(block.offset)).await?;
                    let r = self.sources[si].fetch_block(&block, &token, &mut file).await;
                    match r {
                        Ok(()) => {
                            self.block_map
                                .write()
                                .await
                                .set_state(idx, BlockState::Done);
                            let done = self.block_map.read().await.done_bytes();
                            self.downloaded.store(done, Ordering::SeqCst);
                            self.events
                                .send(SseEvent::Progress(self.progress().await))
                                .ok();
                        }
                        Err(e) => {
                            // 该块失败，回退为 Pending 待重试（源内部已含退避/镜像）。
                            self.block_map
                                .write()
                                .await
                                .set_state(idx, BlockState::Pending);
                            self.events
                                .send(SseEvent::Error {
                                    id: self.id.clone(),
                                    message: e.to_string(),
                                })
                                .ok();
                            return Err(e);
                        }
                    }
                }
                None => {
                    self.block_map
                        .write()
                        .await
                        .set_state(idx, BlockState::Pending);
                    self.events
                        .send(SseEvent::Error {
                            id: self.id.clone(),
                            message: "no available source".into(),
                        })
                        .ok();
                    return Err(SurgeError::NoSource);
                }
            }
        }
    }

    async fn block_at(&self, idx: u32) -> Block {
        self.block_map.read().await.block_at(idx)
    }

    /// 原子认领：在写锁内查找第一个 Pending 块并置为 Assigned，返回其索引。
    /// 写锁在方法返回即释放，绝不泄漏到调用方（避免读/写锁饥饿/死锁）。
    async fn claim_pending(&self) -> Option<u32> {
        let mut bm = self.block_map.write().await;
        let pos = bm.blocks.iter().position(|s| *s == BlockState::Pending)?;
        bm.blocks[pos] = BlockState::Assigned;
        Some(pos as u32)
    }

    /// 选择填充某块的源。
    /// Phase 1.5：按能力（RANGE/CHUNK）+ 实时速度打分；当前取第一个。
    fn pick_source(&self, _block: &Block) -> Option<usize> {
        if self.sources.is_empty() {
            None
        } else {
            Some(0)
        }
    }
}

/// 计算文件 sha256（十六进制小写）。
async fn compute_sha256(path: &PathBuf) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(hex_encode(&digest))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
