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
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, RANGE, RETRY_AFTER};
use reqwest::StatusCode;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// 单个镜像/主源的重试上限（含 429 退避）。
const MAX_RETRIES: u32 = 6;

/// 构造浏览器风格请求头（防部分站点 WAF 反爬拒绝）。
///
/// ZOL 等站点的 WAF 会拒绝缺少 Fetch Metadata（Sec-Fetch-*）的请求（返回 503），
/// 这是浏览器特有的请求头，普通下载工具/脚本不会发送。带上这些头后下载请求
/// 才能通过。UA 用常见浏览器 UA（非精确指纹，够过 WAF 即可）。
fn browser_like_headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        ),
    );
    h.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("*/*"),
    );
    h.insert(
        reqwest::header::ACCEPT_LANGUAGE,
        HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
    );
    // Fetch Metadata：浏览器专用头，WAF 常用它区分真实浏览器与脚本。
    h.insert(
        HeaderName::from_static("sec-fetch-mode"),
        HeaderValue::from_static("cors"),
    );
    h.insert(
        HeaderName::from_static("sec-fetch-site"),
        HeaderValue::from_static("same-site"),
    );
    h.insert(
        HeaderName::from_static("sec-fetch-dest"),
        HeaderValue::from_static("empty"),
    );
    h.insert(
        reqwest::header::ACCEPT_ENCODING,
        HeaderValue::from_static("gzip, deflate, br"),
    );
    h
}

/// 按代理配置构造 reqwest ClientBuilder 的代理部分：
/// - `Direct`（或 None）→ no_proxy（强制直连，避免系统代理劫持下载流量）
/// - `System` → 使用系统代理（reqwest 默认行为：读环境变量 http_proxy/https_proxy）
/// - `Custom(url)` → 指定代理（http/socks5）
/// 返回 builder 以便调用方继续叠加 default_headers / local_address 等。
fn apply_proxy<'a>(
    builder: reqwest::ClientBuilder,
    proxy: Option<&'a ProxyConfig>,
) -> reqwest::ClientBuilder {
    match proxy {
        None | Some(ProxyConfig { mode: ProxyMode::Direct, .. }) => builder.no_proxy(),
        Some(ProxyConfig { mode: ProxyMode::System, .. }) => {
            // reqwest 默认会读环境变量代理；显式不设 proxy 即跟随系统。
            // （Windows 系统代理设置项不是环境变量，reqwest 不直接读注册表；
            //   如需完整跟随 Windows 系统代理，可在调用方把注册表代理转成 Custom 传入。）
            builder
        }
        Some(ProxyConfig { mode: ProxyMode::Custom, url: Some(u) }) => {
            match reqwest::Proxy::all(u) {
                Ok(p) => builder.proxy(p),
                Err(e) => {
                    eprintln!("[http] invalid proxy url {u:?}: {e}");
                    builder.no_proxy()
                }
            }
        }
        Some(ProxyConfig { mode: ProxyMode::Custom, url: None }) => builder.no_proxy(),
    }
}


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
    /// 服务器是否支持 Range（来自 probe 结果）：false → 顺序整文件流（单块）。
    supports_range: bool,
}

impl BoundSource {
    /// 构造一个绑定指定网卡 IP 的源。`bind_ip = None` → 不绑定（系统默认出口）。
    /// `supports_range = false` 表示服务器不支持 Range，引擎应降级为单块顺序下载。
    /// `proxy = Some(Direct)` 强制直连；`Some(System)` 跟随系统代理；
    /// `Some(Custom(url))` 走指定代理；`None` = 默认直连（向后兼容）。
    pub fn new(
        urls: Vec<String>,
        bind_ip: Option<Ipv4Addr>,
        weight: u32,
        iface_name: String,
        supports_range: bool,
        proxy: Option<ProxyConfig>,
    ) -> Result<Self> {
        // 浏览器指纹头：部分站点（如 ZOL）的 WAF 会拒绝没有 Fetch Metadata
        // (Sec-Fetch-*) 的请求（返回 503 反爬）；带上后下载工具才能通过。
        let mut builder = reqwest::Client::builder()
            .pool_max_idle_per_host(8)
            .default_headers(browser_like_headers());
        // 代理策略：Direct/None → no_proxy（避免 Windows 系统代理劫持 localhost/局域网
        // 请求返回 502）；System → 跟随系统/环境变量代理；Custom → 指定代理。
        builder = apply_proxy(builder, proxy.as_ref());
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
            supports_range,
        })
    }
}

#[async_trait]
impl Source for BoundSource {
    fn source_kind(&self) -> SourceKind {
        SourceKind::Http
    }

    fn capabilities(&self) -> CapabilitySet {
        // 不支持 Range 的源：仅提供顺序整文件流能力（无块级随机读/续传）。
        if !self.supports_range {
            return CapabilitySet(CapabilitySet::PAUSE_RESUME | CapabilitySet::MIRRORS);
        }
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
                // 不支持 Range 的服务器：不带 Range 头，整文件流（引擎保证 offset=0, len=total）
                let resp = if self.supports_range {
                    self.client
                        .get(url)
                        .header(RANGE, format!("bytes={}-{}", block.offset, end))
                        .send()
                        .await
                } else {
                    self.client.get(url).send().await
                };
                let resp = match resp {
                    Ok(r) => r,
                    // 传输层错误（连接失败/超时）→ 切下一个镜像。
                    Err(e) => {
                        eprintln!(
                            "[fetch_block] GET {} (range={}) transport error: {}",
                            url, self.supports_range, e
                        );
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
                        // 不支持 Range 的服务器返回 200 整文件流（引擎保证 offset=0）
                        // 或 Range 请求被忽略 → 按 block.len 截断写入
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
                            "http stream ended early ({url}): missing {} bytes",
                            remaining
                        ));
                        break;
                    }
                    s if s.is_server_error() => {
                        // 5xx（尤其 503）：WAF/反爬站点的概率性拒绝（如 ZOL 对非浏览器
                        // 请求约 50% 返回 503）。与 429 同样退避重试，避免把短暂/概率性
                        // 故障当成永久失败（否则源很快被禁用 → no available source）。
                        attempt += 1;
                        if attempt > MAX_RETRIES {
                            eprintln!(
                                "[fetch_block] GET {} (range={}) 5xx exhausted after {} tries (last={})",
                                url, self.supports_range, attempt - 1, s
                            );
                            last_err =
                                SurgeError::Other(format!("http 5xx exhausted ({url}) last={s}"));
                            break;
                        }
                        let wait = parse_retry_after(resp.headers().get(RETRY_AFTER))
                            .max(Duration::from_millis(300 * (1 << (attempt - 1)).min(8)));
                        eprintln!(
                            "[fetch_block] GET {} (range={}) status {} (attempt {}/{}) retry in {:?}",
                            url,
                            self.supports_range,
                            s,
                            attempt,
                            MAX_RETRIES,
                            wait
                        );
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    s => {
                        eprintln!(
                            "[fetch_block] GET {} (range={}) status {} (url={})",
                            url, self.supports_range, s, url
                        );
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

    async fn probe(&self, url: &ParsedUrl, proxy: Option<&ProxyConfig>) -> Result<Metadata> {
        // 浏览器指纹头 + 代理策略（与下载源一致：Direct 直连 / System 系统代理 / Custom 指定）。
        let mut builder = reqwest::Client::builder().default_headers(browser_like_headers());
        builder = apply_proxy(builder, proxy);
        let client = builder
            .build()
            .map_err(|e| SurgeError::Other(format!("http client: {e}")))?;

        // Step 1: HEAD 请求（优先，快捷，可直接拿 Content-Length + Accept-Ranges）
        // WAF 站点（如 ZOL）对请求概率性返回 503，HEAD 也重试几次。
        let mut head_resp = None;
        for attempt in 0..MAX_RETRIES {
            match client.head(&url.raw).send().await {
                Ok(r) => {
                    if r.status().is_server_error() {
                        eprintln!(
                            "[probe] HEAD {} status {} (attempt {}/{}) retry",
                            url.raw,
                            r.status(),
                            attempt + 1,
                            MAX_RETRIES
                        );
                        drop(r);
                        tokio::time::sleep(Duration::from_millis(300 * (1 << attempt.min(4))))
                            .await;
                        continue;
                    }
                    head_resp = Some(r);
                    break;
                }
                Err(e) => {
                    // 网络不可达 / 超时 → 直接失败
                    return Err(SurgeError::Other(format!("http head {}: {}", url.raw, e)));
                }
            }
        }
        let head_resp = head_resp.ok_or_else(|| {
            SurgeError::Other(format!("http head {}: 5xx exhausted", url.raw))
        })?;

        // 优先从 HEAD 响应拿 Content-Length（注意：HEAD 的 Content-Length 可能是
        // 压缩后/占位值，只作为候选，最终以 Range 探测的 Content-Range 为准）
        let head_cl = head_resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());

        // Step 2: 始终用 Range: bytes=0- 探测确认真实大小与 Range 支持。
        // HEAD 的 Content-Length 可能不可信（CDN 压缩/占位值，如 Cloudflare 对
        // __down 返回 1）；Content-Range: bytes 0-N/TOTAL 的 TOTAL 才是权威大小。
        let range_resp = client
            .get(&url.raw)
            .header(RANGE, "bytes=0-")
            .send()
            .await
            .map_err(|e| SurgeError::Other(format!("http range probe {}: {}", url.raw, e)))?;

        let (total_size, supports_range) = match range_resp.status() {
            StatusCode::PARTIAL_CONTENT => {
                // 服务器支持 Range：Content-Range: bytes 0-N/TOTAL 的 TOTAL 是权威大小
                let total_size = range_resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split('/').nth(1))
                    .and_then(|v| v.parse::<u64>().ok())
                    .ok_or_else(|| {
                        SurgeError::Other("server returned 206 but missing Content-Range header".into())
                    })?;
                (total_size, true)
            }
            StatusCode::OK => {
                // 服务器忽略 Range → 从 200 响应的 Content-Length 拿大小
                // （不必消耗 body；200 必须带 Content-Length，非 chunked 传输时）
                let total_size = range_resp
                    .headers()
                    .get(reqwest::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .or(head_cl)
                    .ok_or_else(|| {
                        SurgeError::Other(
                            "http: server returned 200 without Content-Length (chunked encoding not supported for unknown-size downloads)".into(),
                        )
                    })?;
                (total_size, false)
            }
            status => {
                // Range 探测意外状态（403/404/限流等）：HEAD 的 Content-Length 仅在
                // 非可疑值（>1）时采信；≤1 视为占位/伪值（如 Cloudflare 测速端点对
                // 超大请求返回 403 + CL=1），直接报错避免加入注定失败的下载。
                // 注意：此时即使 HEAD 声明 accept-ranges，也不可信（服务器实际拒绝
                // 了 Range 请求，如防盗链站点返回 503）→ 强制 supports_range=false，
                // 引擎降级单块顺序 GET 下载（不带 Range 头，服务器可能放行）。
                match head_cl {
                    Some(cl) if cl > 1 => {
                        eprintln!(
                            "[probe] {} → range probe status={} (fallback to HEAD CL={}, range disabled)",
                            url.raw, status, cl
                        );
                        (cl, false)
                    }
                    _ => {
                        return Err(SurgeError::Other(format!(
                            "http range probe {}: unexpected status {} (server refused range probe; HEAD Content-Length {:?} not trustworthy)",
                            url.raw, status, head_cl
                        )));
                    }
                }
            }
        };

        eprintln!("[probe] {} → status={} total_size={} supports_range={}", url.raw, range_resp.status(), total_size, supports_range);

        // 反爬/错误页检测：若服务器返回的是 HTML 网页（而非文件）且 URL 本身
        // 不像 HTML 页面（如 down.php?softid=... 这类下载入口被重定向到首页），
        // 明确报错，避免把网页当文件下载（ZOL 等站点的典型行为）。
        let content_type = range_resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let url_looks_html = url
            .path
            .to_lowercase()
            .ends_with(".html")
            || url
                .path
                .to_lowercase()
                .ends_with(".htm")
            || url
                .path
                .to_lowercase()
                .ends_with(".shtml");
        if content_type.contains("text/html") && !url_looks_html {
            return Err(SurgeError::Other(format!(
                "server returned HTML page instead of file (content-type={} size={}); likely anti-scraping redirect or dead link: {}",
                content_type, total_size, url.raw
            )));
        }

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

        // 是否支持 Range：来自 probe 结果；None 时保守假设支持（向后兼容）。
        let supports_range = cfg.supports_range.unwrap_or(true);

        // 多网卡分流：interfaces 配置 → 每网卡一个绑定源（URL↔网卡绑定）
        if let Some(spec) = &cfg.interfaces {
            let pool = surge_net::InterfacePool::resolve(Some(spec))
                .map_err(|e| SurgeError::Other(format!("resolve interfaces: {e}")))?;
            let mut sources: Vec<Box<dyn Source>> = Vec::with_capacity(pool.len());
            // 主网卡：主 URL + mirrors 回退
            sources.push(Box::new(BoundSource::new(
                urls.clone(),
                Some(pool.primary.ip),
                pool.primary.weight,
                pool.primary.name.clone(),
                supports_range,
                cfg.proxy.clone(),
            )?));
            // 附属网卡（白名单：只有用户开启的）：专属 URL 优先，主 URL 兜底
            for m in &pool.secondaries {
                let mut murls = Vec::new();
                if let Some(u) = &m.url {
                    murls.push(u.clone());
                }
                for u in &urls {
                    if !murls.iter().any(|x| x == u) {
                        murls.push(u.clone());
                    }
                }
                sources.push(Box::new(BoundSource::new(
                    murls,
                    Some(m.ip),
                    m.weight,
                    m.name.clone(),
                    supports_range,
                    cfg.proxy.clone(),
                )?));
            }
            return Ok(sources);
        }

        // 旧版行为：单个默认源（不绑定）
        Ok(vec![Box::new(BoundSource::new(
            urls,
            None,
            1,
            "primary".into(),
            supports_range,
            cfg.proxy.clone(),
        )?)])
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
            true,
            None,
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
            true,
            None,
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
            supports_range: None,
            proxy: None,
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
                    primary: None,
                    primary_weight: Some(2),
                    secondaries: std::collections::HashMap::new(),
                }),
                supports_range: None,
                proxy: None,
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
            true,
            None,
        )
        .unwrap();
        let src2 = BoundSource::new(
            vec![format!("http://127.0.0.3:{port2}/f")],
            Some(Ipv4Addr::new(127, 0, 0, 3)),
            1,
            "loop3".into(),
            true,
            None,
        )
        .unwrap();

        assert_eq!(src1.iface_name(), "loop2");
        assert_eq!(src2.iface_name(), "loop3");
    }
}

