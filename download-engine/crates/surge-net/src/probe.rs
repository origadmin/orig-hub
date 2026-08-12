//! 网卡探测：枚举系统网卡 + 主网卡（默认路由）识别。
//!
//! ## 实现（跨平台，零原生依赖）
//! - `if-addrs`：枚举所有网卡地址（name + IPv4 + is_loopback）
//! - Windows：额外解析 `route print` 找默认路由（0.0.0.0 行）→ 主网卡；
//!   非 Windows：主网卡 = 第一个 up 非回环非虚拟网卡（启发式）
//! - 虚拟网卡启发式：名称含 Virtual/VMware/VirtualBox/TAP/TUN/WSL/vEthernet/Hyper-V 等
//!
//! ## 说明
//! `if-addrs` 只返回**已配置地址**的接口（隐含 is_up）。默认路由识别
//! Windows 用 route print（UTF-8 输出，可靠）；这是主网卡语义的唯一准确来源。

use serde::Serialize;
use std::net::Ipv4Addr;

/// 网卡探测结果（只读快照，供 pool 解析与 REST /api/interfaces 展示）。
#[derive(Debug, Clone, Serialize)]
pub struct NetInterface {
    pub name: String,
    pub ip: Ipv4Addr,
    pub is_up: bool,
    pub is_default: bool,
    pub is_virtual: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_mbps: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("no network interface available")]
    NoInterface,
    #[error("probe failed: {0}")]
    Other(String),
}

/// 虚拟网卡名称启发式（命中即视为虚拟）。
const VIRTUAL_HINTS: &[&str] = &[
    "virtual", "vmware", "virtualbox", "vbox", "tap", "tun", "wsl", "vethernet",
    "hyper-v", "hyperv", "loopback", "docker", "zerotier", "tailscale", "wg", "ppp",
];

fn is_virtual_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    VIRTUAL_HINTS.iter().any(|h| lower.contains(h))
}

/// 枚举系统网卡（含主网卡标记）。
pub fn list_interfaces() -> Result<Vec<NetInterface>, ProbeError> {
    let ifaces = if_addrs::get_if_addrs().map_err(|e| ProbeError::Other(e.to_string()))?;
    let mut out: Vec<NetInterface> = Vec::new();
    for ifa in ifaces {
        let ip = match ifa.addr.ip() {
            std::net::IpAddr::V4(v4) => v4,
            _ => continue, // 只关心 IPv4（local_address 绑定用）
        };
        out.push(NetInterface {
            name: ifa.name.clone(),
            ip,
            is_up: true,
            is_default: false,
            is_virtual: is_virtual_name(&ifa.name),
            speed_mbps: None,
        });
    }
    if out.is_empty() {
        return Err(ProbeError::NoInterface);
    }
    mark_primary(&mut out);
    Ok(out)
}

/// 主网卡：is_default 的第一个；找不到 → 第一个 up 网卡；再找不到 → 错误。
pub fn primary_interface() -> Result<NetInterface, ProbeError> {
    let all = list_interfaces()?;
    if let Some(i) = all.iter().find(|i| i.is_default) {
        return Ok(i.clone());
    }
    if let Some(i) = all.iter().find(|i| i.is_up) {
        return Ok(i.clone());
    }
    Err(ProbeError::NoInterface)
}

/// 主网卡标记：
/// - Windows：`route print` 里 `0.0.0.0 ... 0.0.0.0 <网关> <metric>` 行对应的接口名
///   （网络目标 0.0.0.0 + 掩码 0.0.0.0 = 默认路由；取 metric 最小行）
/// - 非 Windows：第一个非回环非虚拟网卡（启发式）
fn mark_primary(list: &mut [NetInterface]) {
    #[cfg(windows)]
    {
        // route print 返回接口 IP → 按 IP 匹配网卡
        if let Some(ip) = default_route_iface_ip() {
            if let Some(i) = list.iter_mut().find(|i| i.ip == ip) {
                i.is_default = true;
                return;
            }
        }
        // 回退：第一个非回环非虚拟
        if let Some(i) = list.iter_mut().find(|i| !i.ip.is_loopback() && !i.is_virtual) {
            i.is_default = true;
            return;
        }
        if let Some(i) = list.iter_mut().find(|i| !i.ip.is_loopback()) {
            i.is_default = true;
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(i) = list.iter_mut().find(|i| !i.ip.is_loopback() && !i.is_virtual) {
            i.is_default = true;
            return;
        }
        if let Some(i) = list.iter_mut().find(|i| !i.ip.is_loopback()) {
            i.is_default = true;
        }
    }
}

/// Windows：解析 `route print` 找默认路由接口 IP。
/// 输出示例（本地化后仍是英文列名）：
/// ```text
/// IPv4 Route Table
/// ===========================================================================
/// Active Routes:
/// Network Destination        Netmask          Gateway       Interface  Metric
///           0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.5     35
/// ```
#[cfg(windows)]
fn default_route_iface_ip() -> Option<Ipv4Addr> {
    let out = std::process::Command::new("route")
        .arg("print")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut best: Option<(u32, Ipv4Addr)> = None;
    for line in text.lines() {
        let t = line.trim();
        if !t.starts_with("0.0.0.0") {
            continue;
        }
        // 行格式：目标 掩码 网关 接口 metric（空白分隔，接口是 IPv4）
        let fields: Vec<&str> = t.split_whitespace().collect();
        if fields.len() < 5 || fields[0] != "0.0.0.0" || fields[1] != "0.0.0.0" {
            continue;
        }
        let Ok(iface_ip) = fields[3].parse::<Ipv4Addr>() else {
            continue;
        };
        let metric: u32 = fields[4].parse().unwrap_or(u32::MAX);
        if best.map_or(true, |(m, _)| metric < m) {
            best = Some((metric, iface_ip));
        }
    }
    best.map(|(_, ip)| ip)
}

#[cfg(not(windows))]
fn default_route_iface_name() -> Option<String> {
    None
}

/// 把接口 IP 字符串解析为 Ipv4Addr（route print 结果是 IP，不是名字）。
/// 此函数供 pool 解析时用：Windows 主网卡按 IP 匹配。
pub fn parse_ipv4(s: &str) -> Option<Ipv4Addr> {
    s.parse().ok()
}
