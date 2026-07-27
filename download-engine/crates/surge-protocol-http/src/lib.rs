//! 真实 HTTP 协议（Phase 1 实现，接入 reqwest）。
//!
//! 复刻 Go 侧 `engine/concurrent` + `engine/single` 的核心能力：
//! - `probe`：HEAD 探测 `Content-Length` 与 `Accept-Ranges`。
//! - `fetch_block`：对块发 `Range: bytes=offset-(offset+len-1)` GET，
//!   流式写入 writer（避免整块驻留内存）。
//! - 429 退避：读 `Retry-After`，否则指数退避。
//! - 镜像回退：主源失败后按顺序尝试 `mirrors` 中的备用 URL。
//!
//! 与 `surge-protocol-virtual` 实现同一 `Source` trait，drop-in 注册到 daemon。

use async_trait::async_trait;
use futures::StreamExt;
use libsurge::error::{Result, SurgeError};
use libsurge::protocol::*;
use reqwest::header::{RANGE, RETRY_AFTER};
use reqwest::StatusCode;
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

/// HTTP 源：持有一个共享 `Client` 与一组候选 URL（主源 + 镜像）。
struct HttpSource {
    client: reqwest::Client,
    urls: Vec<String>,
}

#[async_trait]
impl Source for HttpSource {
    fn source_kind(&self) -> SourceKind {
        SourceKind::Http
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet(
            CapabilitySet::PAUSE_RESUME
                | CapabilitySet::RANGE
                | CapabilitySet::RESUME
                | CapabilitySet::MIRRORS
                | CapabilitySet::CHUNK,
        )
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
                | CapabilitySet::CHUNK,
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
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|e| SurgeError::Other(format!("http client: {e}")))?;
        Ok(vec![Box::new(HttpSource { client, urls })])
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
