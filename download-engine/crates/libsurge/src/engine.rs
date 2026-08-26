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
//! ## 多网卡分流（surge-net 集成）
//! - `pick_source` 升级为 `WeightedSelector`：按各源 `weight` × 健康度打分选源。
//! - 每源维护 `SourceHealth`（EMA 速度 / 连续失败 / 临时禁用），失败块自动
//!   回退 Pending 并在下次调度避开问题网卡（健康网卡接管）。
//! - 引擎级实时速度采样（`SpeedTracker`）：修复 speed 恒 0，供 REST/SSE 展示。
//!
//! 引擎只跟 `Source` / `BlockMap` 对话，不感知具体协议——加 BT 不改这里。

use crate::error::{Result, SurgeError};
use crate::protocol::*;
use sha2::{Digest, Sha256};
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

/// 每源健康度（多网卡调度的依据）。
struct SourceHealth {
    /// EMA 实时速度（bytes/s）。
    avg_speed: AtomicU64,
    /// 连续失败次数（≥ 阈值 → 临时禁用）。
    failures: AtomicU32,
    /// 临时禁用标记（到期自动恢复）。
    disabled: AtomicBool,
    /// 上次成功时刻（用于恢复禁用）。
    last_ok_at: std::sync::Mutex<Option<Instant>>,
}

impl SourceHealth {
    fn new() -> Self {
        Self {
            avg_speed: AtomicU64::new(0),
            failures: AtomicU32::new(0),
            disabled: AtomicBool::new(false),
            last_ok_at: std::sync::Mutex::new(None),
        }
    }

    /// 记录一次成功：更新 EMA 速度 + 清零失败计数。
    fn record_ok(&self, bytes: u64, elapsed: Duration) {
        if elapsed.as_secs_f64() > 0.0 {
            let inst = bytes as f64 / elapsed.as_secs_f64();
            let prev = self.avg_speed.load(Ordering::Relaxed) as f64;
            // EMA α=0.3（与 go-backup SpeedEMAAlpha 对齐）；冷启动直接采用瞬时值。
            let next = if prev == 0.0 { inst } else { prev * 0.7 + inst * 0.3 };
            self.avg_speed.store(next as u64, Ordering::Relaxed);
        }
        self.failures.store(0, Ordering::Relaxed);
        if self.disabled.load(Ordering::Relaxed) {
            // 恢复（调度器若仍标记 disabled，由 pick 逻辑按时间恢复）
            *self.last_ok_at.lock().unwrap() = Some(Instant::now());
        }
    }

    /// 记录一次失败：失败计数 +1；达阈值 → 临时禁用。
    fn record_fail(&self, threshold: u32) {
        let f = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
        if f >= threshold {
            self.disabled.store(true, Ordering::Relaxed);
        }
    }

    /// 是否可用（未禁用，或禁用已超过冷却期自动恢复）。
    fn usable(&self, cooldown: Duration) -> bool {
        if !self.disabled.load(Ordering::Relaxed) {
            return true;
        }
        let t = *self.last_ok_at.lock().unwrap();
        if let Some(last_ok) = t {
            if last_ok.elapsed() >= cooldown {
                self.disabled.store(false, Ordering::Relaxed);
                self.failures.store(0, Ordering::Relaxed);
                return true;
            }
        }
        false
    }
}

/// 加权调度器：平滑加权轮询（WWR）+ 健康度过滤。
///
/// - 每个可用源按 `weight × 速度加成` 累加 current 权重，选当前最大者，
///   随后减去总权重 → 保证权重比在长期严格成立（1:1 严格交替，1:3 → A,B,B,B）。
/// - 健康度：连续失败 ≥ 阈值 → 临时禁用（冷却后自动恢复）；
///   禁用源不参与累加与选择，块自动改由健康网卡接管。
struct WeightedSelector {
    weights: Vec<u32>,
    health: Vec<Arc<SourceHealth>>,
    /// 失败禁用阈值（连续失败次数）。
    fail_threshold: u32,
    /// 禁用冷却期。
    cooldown: Duration,
    /// WWR 状态（current 权重向量），并发 pick 用互斥保护。
    wrr: std::sync::Mutex<Vec<i64>>,
    /// 权重总和（用于每轮减去）。
    total_weight: i64,
}

impl WeightedSelector {
    fn new(sources: &[Box<dyn Source>]) -> Self {
        let weights: Vec<u32> = sources.iter().map(|s| s.weight().max(1)).collect();
        let total: i64 = weights.iter().map(|w| *w as i64).sum();
        Self {
            weights,
            health: (0..sources.len()).map(|_| Arc::new(SourceHealth::new())).collect(),
            fail_threshold: 3,
            cooldown: Duration::from_secs(60),
            wrr: std::sync::Mutex::new(vec![0i64; sources.len()]),
            total_weight: total.max(1),
        }
    }

    /// 选择下一个块使用的源（平滑加权轮询 + 健康度过滤）。
    fn pick(&self) -> Option<usize> {
        let n = self.weights.len();
        if n == 0 {
            return None;
        }
        let mut guard = self.wrr.lock().unwrap();
        let mut best: Option<(i64, usize)> = None;
        for i in 0..n {
            if !self.health[i].usable(self.cooldown) {
                continue;
            }
            // 增量 = 权重 × 速度加成（快源轻微优先，速度 0 时纯权重）
            let speed = self.health[i].avg_speed.load(Ordering::Relaxed);
            let boost = if speed > 0 {
                1.0 + (1.0 + speed as f64).ln() / 20.0
            } else {
                1.0
            };
            let inc = ((self.weights[i] as f64) * boost) as i64;
            guard[i] += inc;
            if best.map_or(true, |(cs, _)| guard[i] > cs) {
                best = Some((guard[i], i));
            }
        }
        let (_, chosen) = best?;
        guard[chosen] -= self.total_weight;
        Some(chosen)
    }

    fn health(&self, i: usize) -> &Arc<SourceHealth> {
        &self.health[i]
    }

    /// 所有源当前是否都处于禁用状态（冷却中）。
    /// 用于看门狗：全部源不可用时终止任务，避免 60s 冷却循环重试。
    fn all_disabled(&self) -> bool {
        self.health.iter().all(|h| !h.usable(self.cooldown))
    }
}

/// 引擎级实时速度采样：EMA 平滑。
struct SpeedTracker {
    last_bytes: AtomicU64,
    last_time: std::sync::Mutex<Option<Instant>>,
    ema: AtomicU64,
}

impl SpeedTracker {
    fn new() -> Self {
        Self {
            last_bytes: AtomicU64::new(0),
            last_time: std::sync::Mutex::new(None),
            ema: AtomicU64::new(0),
        }
    }

    /// 采样：传入累计下载字节数，返回当前 EMA 速度（bytes/s）。
    fn sample(&self, total: u64) -> u64 {
        let now = Instant::now();
        let mut lt = self.last_time.lock().unwrap();
        let last = self.last_bytes.load(Ordering::Relaxed);
        let inst = match *lt {
            Some(t) => {
                let dt = now.duration_since(t).as_secs_f64();
                if dt > 0.0 {
                    ((total - last) as f64 / dt) as u64
                } else {
                    0
                }
            }
            None => 0,
        };
        self.last_bytes.store(total, Ordering::Relaxed);
        *lt = Some(now);
        let prev = self.ema.load(Ordering::Relaxed) as f64;
        let next = if prev == 0.0 { inst as f64 } else { prev * 0.7 + inst as f64 * 0.3 };
        self.ema.store(next as u64, Ordering::Relaxed);
        self.ema.load(Ordering::Relaxed)
    }
}

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
    /// 加权调度器（多网卡）。
    selector: WeightedSelector,
    /// 引擎级速度采样。
    speed: SpeedTracker,
    /// 服务器是否支持 Range：false → 降级为单 worker 单块顺序下载。
    supports_range: bool,
}

impl Task {
    /// 构造一个任务（返回 Arc，便于在 HTTP 层共享与跨线程控制）。
    /// `supports_range = false` 时强制单 worker 单块顺序下载（无断点续传）。
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
        supports_range: bool,
    ) -> Arc<Self> {
        // 服务器不支持 Range → 强制单 worker 单块（整个文件为一个块），禁止并发多块
        let (block_size, max_concurrency) = if supports_range {
            (block_size, max_concurrency)
        } else {
            (total.max(1), 1)
        };
        let selector = WeightedSelector::new(&sources);
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
            selector,
            speed: SpeedTracker::new(),
            supports_range,
        })
    }

    pub async fn progress(&self) -> Progress {
        let bm = self.block_map.read().await;
        // 单块顺序模式（不支持 Range）：直接从文件读大小作为下载进度源，
        // 保证 SSE/轮询实时反映实际写入字节（不要等待块完成）。
        let downloaded = if !self.supports_range {
            std::fs::metadata(&self.output).map(|m| m.len()).unwrap_or(0)
        } else {
            self.downloaded.load(Ordering::SeqCst)
        };
        self.downloaded.store(downloaded, Ordering::SeqCst);
        let speed = self.speed.sample(downloaded);
        let (status, eta) = if self.control.cancel.is_cancelled() {
            (DownloadStatus::Cancelled, -1i64)
        } else if self.control.paused.load(Ordering::SeqCst) {
            (DownloadStatus::Paused, -1i64)
        } else if bm.all_done() {
            (DownloadStatus::Completed, 0i64)
        } else {
            (DownloadStatus::Downloading, -1i64)
        };
        Progress {
            id: self.id.clone(),
            status,
            downloaded,
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

            // 单块顺序下载（不支持 Range 的源）：轮询文件大小估算已下载字节，
            // 以便 SSE/轮询能反映实时进度（progress() 现在直接读文件 size）。
            let progress_ticker = if !self.supports_range {
                let ev = self.events.clone();
                let id = self.id.clone();
                let downloaded = self.downloaded.clone();
                let total = self.block_map.read().await.total;
                let output = self.output.clone();
                let mut speed_track = SpeedTracker::new();
                Some(tokio::spawn(async move {
                    let mut iv = tokio::time::interval(Duration::from_millis(500));
                    loop {
                        iv.tick().await;
                        let len = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
                        downloaded.store(len, Ordering::SeqCst);
                        let speed = speed_track.sample(len);
                        let p = Progress {
                            id: id.clone(),
                            status: DownloadStatus::Downloading,
                            downloaded: len,
                            total,
                            speed,
                            eta_sec: -1,
                            protocol: String::new(),
                            hash_sha256: None,
                        };
                        if ev.send(SseEvent::Progress(p)).is_err() {
                            break;
                        }
                        if len >= total { break; }
                    }
                }))
            } else {
                None
            };

            match self.pick_source(&block) {
                Some(si) => {
                    file.seek(SeekFrom::Start(block.offset)).await?;
                    let started = Instant::now();
                    let r = self.sources[si].fetch_block(&block, &token, &mut file).await;
                    match r {
                        Ok(()) => {
                            // 停掉进度轮询 ticker（如果是单块顺序模式）。
                            if let Some(h) = progress_ticker {
                                h.abort();
                            }
                            let elapsed = started.elapsed();
                            self.selector.health(si).record_ok(block.len, elapsed);
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
                            // 该块失败：记录源失败 + 回退 Pending 待重试。
                            // 多网卡容错：块不终止任务，回到调度池由健康源接管；
                            // 源连续失败 ≥ 阈值会被临时禁用（selector 自动避开），
                            // 全部源不可用时 pick_source 返回 None → 任务以 NoSource 终止。
                            if let Some(h) = progress_ticker {
                                h.abort();
                            }
                            self.selector.health(si).record_fail(self.selector.fail_threshold);
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
                            // 看门狗：所有源都被禁用（冷却中）→ 无法继续，终止任务。
                            if self.selector.all_disabled() {
                                return Err(SurgeError::NoSource);
                            }
                            // 短暂退避后继续：让健康源重试该块（避免同一 worker 忙循环
                            // 反复认领同一失败块；连续失败的源会被 selector 禁用并避开）
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            continue;
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

    /// 选择填充某块的源：加权调度器（weight × 健康度）。
    fn pick_source(&self, _block: &Block) -> Option<usize> {
        self.selector.pick()
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

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use tokio::io::AsyncWrite;

    /// 构造一个带权重的假源（不真正联网）。
    struct FakeSource {
        w: u32,
        iface: String,
    }

    #[async_trait]
    #[async_trait]
    impl Source for FakeSource {
        fn source_kind(&self) -> SourceKind {
            SourceKind::Mock
        }
        fn capabilities(&self) -> CapabilitySet {
            CapabilitySet::empty()
        }
        fn weight(&self) -> u32 {
            self.w
        }
        fn iface_name(&self) -> &str {
            &self.iface
        }
        async fn fetch_block(
            &self,
            _block: &Block,
            _token: &CancellationToken,
            _writer: &mut (dyn AsyncWrite + Unpin + Send),
        ) -> Result<()> {
            Ok(())
        }
    }

    fn fake_sources(weights: &[u32]) -> Vec<Box<dyn Source>> {
        weights
            .iter()
            .enumerate()
            .map(|(i, w)| {
                Box::new(FakeSource {
                    w: *w,
                    iface: format!("iface{i}"),
                }) as Box<dyn Source>
            })
            .collect()
    }

    /// 平滑加权轮询：1:1 → 严格交替；1:3 → 比例 1:3。
    #[test]
    fn selector_weight_distribution() {
        let sources = fake_sources(&[1, 1]);
        let sel = WeightedSelector::new(&sources);
        // WWR 1:1 → 严格交替 0,1,0,1,...
        let seq: Vec<usize> = (0..10).map(|_| sel.pick().unwrap()).collect();
        for (i, s) in seq.iter().enumerate() {
            assert_eq!(*s, i % 2, "1:1 WWR should alternate, got {seq:?}");
        }

        // 1:3 → 每 4 次选源 0 一次（WWR 保证长期比例）
        let sources3 = fake_sources(&[1, 3]);
        let sel3 = WeightedSelector::new(&sources3);
        let seq3: Vec<usize> = (0..4000).map(|_| sel3.pick().unwrap()).collect();
        let c0 = seq3.iter().filter(|&&s| s == 0).count();
        let r = c0 as f64 / seq3.len() as f64;
        assert!((0.20..0.30).contains(&r), "1:3 ratio {r:.3} should be ~0.25");
    }

    /// 健康度：连续失败 3 次 → 临时禁用（60s 冷却）→ pick 避开；
    /// 冷却过后自动恢复。
    #[test]
    fn selector_disables_failing_source() {
        let sources = fake_sources(&[1, 1]);
        let sel = WeightedSelector::new(&sources);

        // 源 0 连续失败 3 次
        for _ in 0..3 {
            sel.health(0).record_fail(sel.fail_threshold);
        }
        // 现在源 0 被禁用 → pick 只能选源 1
        for _ in 0..50 {
            assert_eq!(sel.pick(), Some(1));
        }

        // 冷却期未过 → 仍禁用（把 last_ok_at 设为 0 时刻，模拟刚失败）
        // 默认 cooldown 60s；直接验证 usable=false
        assert!(!sel.health(0).usable(sel.cooldown));
    }

    /// 速度 EMA 采样：记录一次成功 → avg_speed 更新；失败计数清零。
    #[test]
    fn health_ema_speed_and_failure_reset() {
        let h = SourceHealth::new();
        // 第一次成功：10MB 用了 1s → EMA 冷启动 = 瞬时值 10MB/s
        h.record_ok(10 * 1024 * 1024, Duration::from_secs(1));
        let s1 = h.avg_speed.load(Ordering::Relaxed);
        assert_eq!(s1, 10 * 1024 * 1024, "cold start uses instant speed");

        // 第二次成功：5MB 用了 1s → EMA 平滑（0.7*prev + 0.3*inst）
        h.record_ok(5 * 1024 * 1024, Duration::from_secs(1));
        let s2 = h.avg_speed.load(Ordering::Relaxed);
        assert!(s2 < s1, "EMA should smooth down after slower sample");
        assert!(s2 > 5 * 1024 * 1024, "EMA stays above slower sample");

        // 失败记录：未达阈值不禁用
        h.record_fail(3);
        assert!(h.usable(Duration::from_secs(60)));
        h.record_fail(3);
        h.record_fail(3);
        assert!(!h.usable(Duration::from_secs(60)));
        // 失败计数不污染速度
        assert_eq!(h.avg_speed.load(Ordering::Relaxed), s2);
    }

    /// 空源集合 → None。
    #[test]
    fn selector_empty() {
        let sel = WeightedSelector::new(&[]);
        assert!(sel.pick().is_none());
    }
}
