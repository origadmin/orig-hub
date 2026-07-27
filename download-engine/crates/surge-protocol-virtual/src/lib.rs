//! 虚拟/模拟协议（默认加载）。
//!
//! 不依赖任何网络即可跑通全链路（HTTP API → 引擎 → 进度事件 → 状态），
//! 并验证切片 / 断点续传能力。URL 约定：
//!   mock:///demo.bin?size=104857600&chunks=8&seed=42&rate=10m
//! - size:  目标字节数
//! - chunks: 仅用于能力展示（块数由 BlockMap 按 block_size 推导）
//! - seed:  确定性随机种子（决定写入字节，使最终 sha256 可复现可断言）
//! - rate:  模拟速率（如 10m = 10 MiB/s；0/缺省 = 不限速）
//!
//! 实现 `Source`：每个 block 写入由 (seed, offset) 派生的确定性字节。
//! 无论以何种顺序/分块写入，最终文件字节与 sha256 完全一致 —— 续传安全。

use async_trait::async_trait;
use libsurge::error::{Result, SurgeError};
use libsurge::protocol::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

pub struct VirtualProtocol;

impl VirtualProtocol {
    pub fn new() -> Self {
        Self
    }
}

/// 按 (seed, offset) 确定性派生一个字节。与并发/流状态无关，保证
/// 无论以何种顺序/分块写入，最终文件字节与 sha256 完全一致（续传安全）。
fn pseudo_byte(seed: u64, offset: u64) -> u8 {
    let mut h = seed ^ (offset.wrapping_mul(0x9E3779B97F4A7C15));
    h ^= h >> 29;
    h = h.wrapping_mul(0xBF58476D1CE4E5B9);
    h ^= h >> 32;
    (h >> 56) as u8
}

fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect()
}

/// 解析 "10m" / "1k" / "512" 形式的速率字符串为字节/秒。
fn parse_rate(v: Option<&String>) -> u64 {
    let Some(s) = v else { return 0 };
    let (num, unit) = match s.trim().chars().next_back() {
        Some(c) if c.is_alphabetic() => {
            let n = &s[..s.len() - 1];
            (n.parse::<f64>().unwrap_or(0.0), c.to_ascii_lowercase())
        }
        _ => (s.parse::<f64>().unwrap_or(0.0), 'b'),
    };
    let mult = match unit {
        'k' => 1024.0,
        'm' => 1024.0 * 1024.0,
        'g' => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (num * mult) as u64
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 虚拟源：按 block 写入确定性字节。
struct MockSource {
    seed: u64,
    rate: u64,
    downloaded: Arc<AtomicU64>,
}

#[async_trait]
impl Source for MockSource {
    fn source_kind(&self) -> SourceKind {
        SourceKind::Mock
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet(
            CapabilitySet::PAUSE_RESUME
                | CapabilitySet::RANGE
                | CapabilitySet::RESUME
                | CapabilitySet::CHUNK,
        )
    }

    async fn fetch_block(
        &self,
        block: &Block,
        token: &CancellationToken,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> Result<()> {
        let mut off = block.offset;
        let end = block.offset + block.len;
        let mut buf = [0u8; 1 << 16];
        while off < end {
            if token.is_cancelled() {
                return Err(SurgeError::Cancelled);
            }
            let n = (end - off).min(buf.len() as u64) as usize;
            for i in 0..n {
                buf[i] = pseudo_byte(self.seed, off + i as u64);
            }
            writer.write_all(&buf[..n]).await?;
            off += n as u64;
            self.downloaded.fetch_add(n as u64, Ordering::SeqCst);
            if self.rate > 0 {
                let micros = (n as f64 / self.rate as f64) * 1_000_000.0;
                tokio::time::sleep(std::time::Duration::from_micros(micros as u64)).await;
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl Protocol for VirtualProtocol {
    fn name(&self) -> &'static str {
        "virtual"
    }

    fn schemes(&self) -> &[&'static str] {
        &["mock"]
    }

    async fn parse_url(&self, raw: &str) -> Result<ParsedUrl> {
        let body = raw.strip_prefix("mock://").unwrap_or(raw);
        let (path, query) = match body.split_once('?') {
            Some((p, q)) => (p.to_string(), parse_query(q)),
            None => (body.to_string(), HashMap::new()),
        };
        Ok(ParsedUrl {
            raw: raw.to_string(),
            scheme: "mock".into(),
            path,
            query,
        })
    }

    async fn probe(&self, url: &ParsedUrl) -> Result<Metadata> {
        let size = url
            .query
            .get("size")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1024);
        let filename = url.path.trim_start_matches('/').to_string();
        Ok(Metadata {
            total_size: size,
            supports_range: true,
            supports_resume: true,
            filename: Some(filename),
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet(
            CapabilitySet::PAUSE_RESUME
                | CapabilitySet::RANGE
                | CapabilitySet::RESUME
                | CapabilitySet::CHUNK,
        )
    }

    async fn create_sources(
        &self,
        url: &ParsedUrl,
        _cfg: &DownloadConfig,
    ) -> Result<Vec<Box<dyn Source>>> {
        let seed = url
            .query
            .get("seed")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(42);
        let rate = parse_rate(url.query.get("rate"));
        Ok(vec![Box::new(MockSource {
            seed,
            rate,
            downloaded: Arc::new(AtomicU64::new(0)),
        })])
    }
}

// 让未使用的 SurgeError 变体在迁移过程中保持被引用（避免告警噪音）。
#[allow(dead_code)]
fn _assert_error_variants() -> Result<()> {
    Err(SurgeError::Other("placeholder".into()))
}

// 避免部分辅助函数在未启用真实校验时的「未使用」告警。
#[allow(dead_code)]
fn _unused_helpers() {
    let _ = hex_encode(&[]);
    let _ = Sha256::new();
    let _ = broadcast::channel::<SseEvent>(1);
}
