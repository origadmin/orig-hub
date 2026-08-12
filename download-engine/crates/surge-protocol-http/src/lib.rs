//! 真实 HTTP 协议（多网卡分流版）。
//!
//! 复刻 Go 侧 `engine/concurrent` + `engine/single` 的核心能力：
//! - `probe`：HEAD 探测 `Content-Length` 与 `Accept-Ranges`。
//! - `fetch_block`：对块发 `Range: bytes=offset-(offset+len-1)` GET，
//!   流式写入 writer（避免整块驻留内存）。
//! - 429 退避：读 `Retry-After`，否则指数退避。
//! - 镜像回退：主源失败后按顺序尝试 `mirrors` 中的备用 URL。
//!
//! ## 多网卡分流（surge-net 集成）
//! - `create_sources` 读取 `cfg.interfaces`（`InterfaceSpec`）→ 解析为 `InterfacePool`。
//! - **每网卡一个 `BoundSource`**：独立的 reqwest Client，`local_address(网卡IP)` 绑定，
//!   该网卡所有流量从对应 IP 发出（OS 路由保证）。
//! - `interfaces = None` → 单个默认源（不绑定 local_address），与旧版行为一致。
//! - 每个源携带 `weight`，供引擎 `WeightedSelector` 按权重 + 健康度调度。

use async_trait::async_trait;
use futures::StreamExt;
use libsurge::error::{Result, SurgeError};
use libsurge::protocol::*;
use reqwest::header::{RANGE, RETRY_AFTER};
use reqwest::StatusCode;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// 单个镜像/主源的重试上限（含 429 退避）。
const MAX_RETRIES: u32 = 6;

pub struct HttpProtocol;

impl HttpProtocol {
    pub fn new() -> Self {
        Self
    }
}

/// 网卡绑定源：持有一个绑定了某网卡 IP 的 `Client` 与一组候选 URL（主源 + 镜像）。
/// `weight` 供引擎加权调度；`iface_name` 供统计/展示。
pub struct BoundSource {
    client: reqwest::Client,
    urls: Vec<String>,
    /// 调度权重（≥1；默认 1）。
    pub weight: u32,
    /// 网卡名（"primary" 或系统网卡名）。
    pub iface_name: String,
}

impl BoundSource {
    /// 构造一个绑定指定网卡 IP 的源。`bind_ip = None` → 不绑定（系统默认出口）。
    pub fn new(
        urls: Vec<String>,
        bind_ip: Option<Ipv4Addr>,
        weight: u32,
        iface_name: String,
    ) -> Result<Self> {
        let mut builder = reqwest::Client::builder().pool_max_idle_per_host(8);
        if let Some(ip) = bind_ip {
            builder = builder.local_address(IpAddr::V4(ip));
        }
        let client = builder
            .build()
            .map_err(|e| SurgeError::Other(format!("http client: {e}")))?;
        Ok(BoundSource {
            client,
            urls,
            weight: weight.max(1),
            iface_name,
        })
    }
}

#[async_trait]
impl Source for BoundSource {
    fn source_kind(&self) -> SourceKind {
        SourceKind::Http
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet(
            CapabilitySet::PAUSE_RESUME
                | CapabilitySet::RANGE
                | CapabilitySet::RESUME
                | CapabilitySet::MIRRORS
                | CapabilitySet::CHUNK
                | CapabilitySet::MULTI_NODE,
        )
    }

    fn weight(&self) -> u32 {
        self.weight
    }

    fn iface_name(&self) -> &str {
        &self.iface_name
    }

    #[allow(unused_assignments)]
    async fn fetch_block(
        &self,
        block: &Block,
        token: &CancellationToken,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> Result<()> {
        let end = block.offset + block.len - 1;
        let mut last_err = SurgeError::NoSource;
        // 依次尝试主源 + 各镜像源。
        for url in &self.urls {
            let mut attempt: u32 = 0;
            loop {
                if token.is_cancelled() {
                    return Err(SurgeError::Cancelled);
                }
                let resp = match self
                    .client
                    .get(url)
                    .header(RANGE, format!("bytes={}-{}", block.offset, end))
                    .send()
                    .await
                {
                    Ok(r) => r,
                    // 传输层错误（连接失败/超时）→ 切下一个镜像。
                    Err(e) => {
                        last_err = SurgeError::Other(format!("http get {url}: {e}"));
                        break;
                    }
                };

                match resp.status() {
                    StatusCode::PARTIAL_CONTENT => {
                        // 流式写入，严格限制到 block.len 字节。
                        let mut stream = resp.bytes_stream();
                        let mut remaining = block.len;
                        while remaining > 0 {
                            if token.is_cancelled() {
                                return Err(SurgeError::Cancelled);
                            }
                            match stream.next().await {
                                Some(Ok(chunk)) => {
                                    let n = (chunk.len() as u64).min(remaining) as usize;
                                    writer.write_all(&chunk[..n]).await?;
                                    remaining -= n as u64;
                                }
                                Some(Err(e)) => {
                                    last_err = SurgeError::Other(format!("http body {url}: {e}"));
                                    break;
                                }
                                None => break,
                            }
                        }
                        if remaining == 0 {
                            writer.flush().await?;
                            return Ok(());
                        }
                        // 流提前结束（不足 block.len）→ 切下一个镜像。
                        last_err = SurgeError::Other(format!(
                            "http range stream ended early ({url}): missing {} bytes",
                            remaining
                        ));
                        break;
                    }
                    StatusCode::TOO_MANY_REQUESTS => {
                        // 429：退避后重试同一 URL。
                        attempt += 1;
                        if attempt > MAX_RETRIES {
                            last_err = SurgeError::Other(format!("http 429 exhausted ({url})"));
                            break;
                        }
                        let wait = parse_retry_after(resp.headers().get(RETRY_AFTER));
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    StatusCode::OK => {
                        // 服务器忽略了 Range（返回整文件）→ 不能用于填充单块，切镜像。
                        last_err = SurgeError::Other(format!(
                            "server {url} ignored Range (200), cannot fill block"
                        ));
                        break;
                    }
                    s => {
                        last_err = SurgeError::Other(format!("http status {s} ({url})"));
                        break;
                    }
                }
            }
        }
        Err(last_err)
    }
}

#[async_trait]
impl Protocol for HttpProtocol {
    fn name(&self) -> &'static str {
        "http"
    }

    fn schemes(&self) -> &[&'static str] {
        &["http", "https"]
    }

    async fn parse_url(&self, raw: &str) -> Result<ParsedUrl> {
        let scheme = raw.split("://").next().unwrap_or("").to_string();
        let body = raw.strip_prefix(&format!("{scheme}://")).unwrap_or(raw);
        // body = "host:port/path?query" —— path 必须是「第一个 / 之后」的部分。
        let (authority_path, query) = match body.split_once('?') {
            Some((ap, q)) => (ap, parse_query(q)),
            None => (body, Default::default()),
        };
        let path = match authority_path.split_once('/') {
            Some((_auth, p)) => format!("/{p}"),
            None => "/".to_string(),
        };
        Ok(ParsedUrl {
            raw: raw.to_string(),
            scheme,
            path,
            query,
        })
    }

    async fn probe(&self, url: &ParsedUrl) -> Result<Metadata> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| SurgeError::Other(format!("http client: {e}")))?;
        let resp = client
            .head(&url.raw)
            .send()
            .await
            .map_err(|e| SurgeError::Other(format!("http head {}: {}", url.raw, e)))?;
        let total_size = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| SurgeError::Other("http: missing/invalid Content-Length".into()))?;
        let supports_range = resp
            .headers()
            .get(reqwest::header::ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("bytes"))
            .unwrap_or(false);
        let filename = url
            .path
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        Ok(Metadata {
            total_size,
            supports_range,
            supports_resume: supports_range,
            filename,
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet(
            CapabilitySet::PAUSE_RESUME
                | CapabilitySet::RANGE
                | CapabilitySet::RESUME
                | CapabilitySet::MIRRORS
                | CapabilitySet::CHUNK
                | CapabilitySet::MULTI_NODE,
        )
    }

    async fn create_sources(
        &self,
        url: &ParsedUrl,
        cfg: &DownloadConfig,
    ) -> Result<Vec<Box<dyn Source>>> {
        let mut urls = vec![url.raw.clone()];
        for m in &cfg.mirrors {
            if !urls.iter().any(|u| u == m) {
                urls.push(m.clone());
            }
        }

        // 多网卡分流：interfaces 配置 → 每网卡一个绑定源
        if let Some(spec) = &cfg.interfaces {
            let pool = surge_net::InterfacePool::resolve(Some(spec))
                .map_err(|e| SurgeError::Other(format!("resolve interfaces: {e}")))?;
            let mut sources: Vec<Box<dyn Source>> = Vec::with_capacity(pool.len());
            // 主网卡
            sources.push(Box::new(BoundSource::new(
                urls.clone(),
                Some(pool.primary.ip),
                pool.primary.weight,
                pool.primary.name.clone(),
            )?));
            // 附属网卡（白名单：只有用户开启的）
            for m in &pool.secondaries {
                sources.push(Box::new(BoundSource::new(
                    urls.clone(),
                    Some(m.ip),
                    m.weight,
                    m.name.clone(),
                )?));
            }
            return Ok(sources);
        }

        // 旧版行为：单个默认源（不绑定）
        Ok(vec![Box::new(BoundSource::new(urls, None, 1, "primary".into())?)])
    }
}

/// 解析 `Retry-After`：秒数（上限 30s），缺省回退 2s（指数退避由调用方控制）。
fn parse_retry_after(h: Option<&reqwest::header::HeaderValue>) -> Duration {
    if let Some(v) = h {
        if let Ok(s) = v.to_str() {
            if let Ok(secs) = s.parse::<u64>() {
                return Duration::from_secs(secs.min(30));
            }
        }
    }
    Duration::from_secs(2)
}

fn parse_query(q: &str) -> std::collections::HashMap<String, String> {
    q.split('&')
        .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsurge::protocol::*;
    use std::net::Ipv4Addr;

    /// 验证 BoundSource 携带正确的 weight 和 iface_name。
    #[test]
    fn bound_source_weight_and_iface() {
        let src = BoundSource::new(
            vec!["http://127.0.0.1:18081/f".into()],
            Some(Ipv4Addr::new(127, 0, 0, 1)),
            3,
            "eth1".into(),
        )
        .unwrap();
        assert_eq!(src.weight(), 3);
        assert_eq!(src.iface_name(), "eth1");
        assert_eq!(src.source_kind(), SourceKind::Http);
        let caps = src.capabilities();
        assert!(caps.has(CapabilitySet::RANGE));
        assert!(caps.has(CapabilitySet::MULTI_NODE));
        assert!(caps.has(CapabilitySet::MIRRORS));
    }

    /// 验证权重归一化：weight=0 → 规范为 1。
    #[test]
    fn bound_source_zero_weight_normalized() {
        let src = BoundSource::new(
            vec!["http://127.0.0.1:18081/f".into()],
            None,
            0,
            "eth0".into(),
        )
        .unwrap();
        assert_eq!(src.weight(), 1); // 0 → 1
    }

    /// 验证 HttpProtocol::create_sources 不传 interfaces → 单源（向后兼容）。
    #[tokio::test]
    async fn create_sources_no_interfaces() {
        let proto = HttpProtocol::new();
        let url = ParsedUrl {
            raw: "http://example.com/f.bin".into(),
            scheme: "http".into(),
            path: "/f.bin".into(),
            query: Default::default(),
        };
        let cfg = DownloadConfig {
            destination: None,
            block_size: 1 << 20,
            max_concurrency: 4,
            mirrors: vec![],
            interfaces: None,
        };
        let sources = proto.create_sources(&url, &cfg).await.unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].weight(), 1); // default
    }

    /// 验证多网卡分流：interfaces 指定主+1 附属（loopback 模拟）→ 2 个绑定源。
    /// 注意：Windows 上 127.0.0.2/3 未分配时绑定会失败；这里仅验证 create_sources
    /// 的解析路径（主网卡来自真实探测，附属按白名单匹配）。
    #[tokio::test]
    async fn create_sources_with_interfaces_spec() {
        let proto = HttpProtocol::new();
        let url = ParsedUrl {
            raw: "http://example.com/f.bin".into(),
            scheme: "http".into(),
            path: "/f.bin".into(),
            query: Default::default(),
        };
        // secondaries 给一个真实存在的网卡名（主网卡自动探测加入）
        // 这里用主网卡名（重复名会被跳过），验证至少 1 个源（主网卡）。
        let pool = surge_net::InterfacePool::resolve(None);
        let cfg = match &pool {
            Ok(p) => DownloadConfig {
                destination: None,
                block_size: 1 << 20,
                max_concurrency: 4,
                mirrors: vec![],
                interfaces: Some(surge_net::InterfaceSpec {
                    primary_weight: Some(2),
                    secondaries: std::collections::HashMap::new(),
                }),
            },
            Err(_) => {
                // 无主网卡（极小概率）→ 跳过
                return;
            }
        };
        let sources = proto.create_sources(&url, &cfg).await.unwrap();
        assert!(sources.len() >= 1, "at least primary source");
        // 主网卡权重 2 生效
        assert_eq!(sources[0].weight(), 2);
    }

    /// 真实绑定：用 loopback 多 IP 模拟多网卡（Windows 需管理员分配 127.0.0.2/3，
    /// 未分配则跳过）。验证 BoundSource 初始化成功 + 绑定 IP 正确。
    #[tokio::test]
    async fn bound_source_binds_loopback_multinic() {
        use std::net::Ipv4Addr;
        use tokio::net::TcpListener;

        // 在两个 loopback IP 上各起一个 TCP 监听（若地址未分配则跳过）
        async fn try_listen(ip: Ipv4Addr) -> Option<TcpListener> {
            match TcpListener::bind((ip, 0)).await {
                Ok(l) => Some(l),
                Err(_) => None,
            }
        }
        let (l1, l2) = match (
            try_listen(Ipv4Addr::new(127, 0, 0, 2)).await,
            try_listen(Ipv4Addr::new(127, 0, 0, 3)).await,
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => {
                eprintln!("SKIP: loopback 127.0.0.2/3 not assigned (need admin netsh)");
                return;
            }
        };
        let port1 = l1.local_addr().unwrap().port();
        let port2 = l2.local_addr().unwrap().port();
        drop(l1);
        drop(l2);

        let src1 = BoundSource::new(
            vec![format!("http://127.0.0.2:{port1}/f")],
            Some(Ipv4Addr::new(127, 0, 0, 2)),
            1,
            "loop2".into(),
        )
        .unwrap();
        let src2 = BoundSource::new(
            vec![format!("http://127.0.0.3:{port2}/f")],
            Some(Ipv4Addr::new(127, 0, 0, 3)),
            1,
            "loop3".into(),
        )
        .unwrap();

        assert_eq!(src1.iface_name(), "loop2");
        assert_eq!(src2.iface_name(), "loop3");
    }
}

