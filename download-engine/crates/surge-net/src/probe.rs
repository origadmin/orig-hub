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

/// 完整适配器（含未连接/无 IP 的物理网卡）。
/// 与 `list_interfaces`（只返回有 IP 的 up 网卡）互补：
/// - Windows：`GetAdaptersAddresses` 枚举全部适配器，附 OperStatus（up/down）与友好名；
/// - 非 Windows：退化为 `list_interfaces`（getifaddrs 语义）。
/// 用于 UI「所有网卡」视图，让用户看到断开/未启用的物理网卡（如 Wi-Fi 未连接）。
#[derive(Debug, Clone, Serialize)]
pub struct AdapterInfo {
    /// 适配器名（如 `以太网` / `WLAN`）。
    pub name: String,
    /// Windows 友好名（如 `Intel(R) Ethernet Connection (16) I219-V`），非 Windows 为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 主 IPv4（无则 None，表示未连接/无地址）。
    pub ip: Option<Ipv4Addr>,
    pub is_up: bool,
    pub is_default: bool,
    pub is_virtual: bool,
}

/// 枚举全部适配器（含断开/无 IP）。
#[cfg(windows)]
pub fn list_all_adapters() -> Result<Vec<AdapterInfo>, ProbeError> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH, GAA_FLAG_INCLUDE_PREFIX,
        IF_TYPE_SOFTWARE_LOOPBACK,
    };
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, AF_UNSPEC, SOCKADDR, SOCKADDR_IN,
    };

    // 先查所需缓冲区大小
    let mut size: u32 = 0;
    let ret = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            GAA_FLAG_INCLUDE_PREFIX,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if ret != ERROR_BUFFER_OVERFLOW {
        // 无适配器或其它错误
        return Ok(Vec::new());
    }

    let mut buf = vec![0u8; size as usize];
    let ret = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            GAA_FLAG_INCLUDE_PREFIX,
            std::ptr::null(),
            buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
            &mut size,
        )
    };
    if ret != ERROR_SUCCESS {
        return Err(ProbeError::Other(format!(
            "GetAdaptersAddresses failed: {ret}"
        )));
    }

    let mut out = Vec::new();
    let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !cur.is_null() {
        let a = unsafe { &*cur };
        let name = unsafe { wide_to_string(a.FriendlyName) }
            .unwrap_or_else(|| "unknown".to_string());
        let description = unsafe { wide_to_string(a.Description) };
        let is_up = a.OperStatus == 1; // IfOperStatusUp
        let is_virtual = is_virtual_name(&name)
            || is_virtual_name(description.as_deref().unwrap_or(""));
        let is_loopback = a.IfType == IF_TYPE_SOFTWARE_LOOPBACK;

        // 取第一个 IPv4 单播地址
        let mut ip: Option<Ipv4Addr> = None;
        let mut ua = a.FirstUnicastAddress;
        while !ua.is_null() && ip.is_none() {
            let sockaddr = unsafe { &*(*ua).Address.lpSockaddr as *const SOCKADDR };
            let family = unsafe { (*sockaddr).sa_family };
            if family == AF_INET as u16 {
                let sa_in = unsafe { &*(sockaddr as *const SOCKADDR_IN) };
                ip = Some(Ipv4Addr::from(unsafe { sa_in.sin_addr.S_un.S_addr }.to_ne_bytes()));
            }
            ua = unsafe { (*ua).Next };
        }

        if !is_loopback {
            out.push(AdapterInfo {
                name,
                description,
                ip,
                is_up,
                is_default: false,
                is_virtual,
            });
        }
        cur = unsafe { (*cur).Next };
    }

    // 主网卡标记：默认路由接口 IP
    if let Some(primary_ip) = default_route_iface_ip() {
        for a in out.iter_mut() {
            if a.ip == Some(primary_ip) {
                a.is_default = true;
                break;
            }
        }
    }
    Ok(out)
}

/// 枚举全部适配器（非 Windows 退化：只有有 IP 的 up 网卡）。
#[cfg(not(windows))]
pub fn list_all_adapters() -> Result<Vec<AdapterInfo>, ProbeError> {
    Ok(list_interfaces()?
        .into_iter()
        .map(|i| AdapterInfo {
            name: i.name,
            description: None,
            ip: Some(i.ip),
            is_up: i.is_up,
            is_default: i.is_default,
            is_virtual: i.is_virtual,
        })
        .collect())
}

/// 把 UTF-16 宽字符串转 String（GetAdaptersAddresses 的 FriendlyName/Description）。
#[cfg(windows)]
unsafe fn wide_to_string(ptr: *const u16) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
    if len == 0 {
        return None;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    Some(String::from_utf16_lossy(slice))
}



