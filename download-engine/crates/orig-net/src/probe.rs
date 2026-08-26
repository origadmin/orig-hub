//! 网卡探测：枚举系统网卡 + 主网卡（默认路由）识别。
//!
//! ## 实现（跨平台）
//! - `if-addrs`：枚举所有网卡地址（name + IPv4 + is_loopback）——跨平台基础
//! - Windows：`GetAdaptersAddresses` 枚举全部适配器（含断开/无 IP，OperStatus + 友好名）；
//!   主网卡用 `route print` 解析默认路由（0.0.0.0 行，metric 最小）
//! - Linux：`rtnetlink`（netlink socket）枚举全部链路（RTM_GETLINK，含 down/无 IP，
//!   IFF_UP 判定 connected），IPv4 地址关联（RTM_GETADDR），默认路由识别
//!   （RTM_GETROUTE，dst 0.0.0.0/0，table main，priority 最小）；无需 root
//! - macOS/BSD：退化为 if-addrs（只有有 IP 的 up 网卡）+ 启发式主网卡
//! - 虚拟网卡启发式：名称含 Virtual/VMware/VirtualBox/TAP/TUN/WSL/vEthernet/Hyper-V 等

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
    // Linux 容器/虚拟化/隧道前缀
    "br-", "veth", "virbr", "docker0", "lxc", "cni", "flannel", "cali", "cilium",
    "kube", "vxlan", "gretap", "ip6tnl", "sit@", "dummy", "tunl", "erspan",
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
/// - Linux：rtnetlink 默认路由（dst 0.0.0.0/0）的 oif 网卡
/// - 其它：第一个非回环非虚拟网卡（启发式）
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
        fallback_primary(list);
    }
    #[cfg(target_os = "linux")]
    {
        // rtnetlink 默认路由 oif → 按名字匹配（list_all_adapters 里已标记 is_default）
        if let Ok(all) = list_all_adapters() {
            if let Some(def) = all.iter().find(|a| a.is_default) {
                if let Some(i) = list.iter_mut().find(|i| i.name == def.name) {
                    i.is_default = true;
                    return;
                }
            }
        }
        fallback_primary(list);
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        fallback_primary(list);
    }
}

/// 回退：第一个非回环非虚拟 → 第一个非回环。
fn fallback_primary(list: &mut [NetInterface]) {
    if let Some(i) = list.iter_mut().find(|i| !i.ip.is_loopback() && !i.is_virtual) {
        i.is_default = true;
        return;
    }
    if let Some(i) = list.iter_mut().find(|i| !i.ip.is_loopback()) {
        i.is_default = true;
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
#[cfg(not(any(windows, target_os = "linux")))]
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

/// 在 tokio 运行时内/外统一执行异步探测（rtnetlink 需要运行时）。
/// - 已在 tokio 上下文：`block_in_place` + 当前 handle（不 panic）
/// - 非 tokio 上下文：临时 current_thread runtime
#[cfg(target_os = "linux")]
fn block_on_rtnetlink<F, T>(fut: F) -> Result<T, ProbeError>
where
    F: std::future::Future<Output = Result<T, ProbeError>>,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| {
            handle
                .block_on(fut)
        }),
        Err(_) => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| ProbeError::Other(e.to_string()))?;
            rt.block_on(fut)
        }
    }
}

/// Linux：rtnetlink 枚举全部适配器（等价 GetAdaptersAddresses）。
/// - RTM_GETLINK：全部接口（含 down） + flags（IFF_UP/IFF_LOOPBACK）
/// - RTM_GETADDR：按 ifindex 关联 IPv4 地址
/// - RTM_GETROUTE：默认路由（dst 0.0.0.0/0, table main）→ 主网卡
#[cfg(target_os = "linux")]
pub fn list_all_adapters() -> Result<Vec<AdapterInfo>, ProbeError> {
    block_on_rtnetlink(async {
        use futures::StreamExt;
        use rtnetlink::packet_route::{
            address::AddressAttribute,
            link::{LinkAttribute, LinkFlags},
            route::{RouteAttribute, RouteHeader, RouteMessage, RouteType},
            AddressFamily,
        };
        use rtnetlink::new_connection;

        let (conn, handle, _) = new_connection()
            .map_err(|e| ProbeError::Other(format!("netlink connect: {e}")))?;
        tokio::spawn(conn);

        // 1. 全部链路（含 down/无 IP）
        let mut links: Vec<(u32, String, LinkFlags, bool)> = Vec::new();
        let mut link_stream = handle.link().get().execute();
        while let Some(msg) = link_stream.next().await {
            let Ok(msg) = msg else { continue };
            let mut ifname = String::new();
            for attr in &msg.attributes {
                if let LinkAttribute::IfName(n) = attr {
                    ifname = n.clone();
                }
            }
            // loopback 过滤：flags 或名 lo
            let is_loopback = msg.header.flags.contains(LinkFlags::Loopback)
                || ifname == "lo";
            links.push((msg.header.index, ifname, msg.header.flags, is_loopback));
        }

        // 2. IPv4 地址按 ifindex 关联
        let mut addr_map: std::collections::HashMap<u32, Ipv4Addr> =
            std::collections::HashMap::new();
        let mut addr_stream = handle.address().get().execute();
        while let Some(msg) = addr_stream.next().await {
            let Ok(msg) = msg else { continue };
            if msg.header.family != AddressFamily::Inet {
                continue; // 只取 IPv4
            }
            let mut ip: Option<Ipv4Addr> = None;
            for attr in &msg.attributes {
                if let AddressAttribute::Address(std::net::IpAddr::V4(v4)) = attr {
                    ip = Some(*v4);
                    break;
                }
            }
            if let Some(ip) = ip {
                addr_map.insert(msg.header.index, ip);
            }
        }

        // 3. 默认路由（IPv4, table main, dst 0.0.0.0/0）→ 主网卡 ifindex
        let mut default_oif: Option<u32> = None;
        let mut best_prio: u32 = u32::MAX;
        let mut route_stream = handle
            .route()
            .get(RouteMessage::default())
            .execute();
        while let Some(msg) = route_stream.next().await {
            let Ok(msg) = msg else { continue };
            if msg.header.table != RouteHeader::RT_TABLE_MAIN
                || msg.header.kind != RouteType::Unicast
                || msg.header.destination_prefix_length != 0
            {
                continue;
            }
            // 确认 dst 0.0.0.0/0（无 Destination 属性 = 默认）
            let mut oif = None;
            let mut prio = 0u32;
            let mut has_dst = false;
            for attr in &msg.attributes {
                match attr {
                    RouteAttribute::Oif(o) => oif = Some(*o),
                    RouteAttribute::Priority(p) => prio = *p,
                    RouteAttribute::Destination(_) => has_dst = true,
                    _ => {}
                }
            }
            if has_dst {
                continue; // 有显式 dst 不是默认路由
            }
            if let Some(oif) = oif {
                if prio < best_prio {
                    best_prio = prio;
                    default_oif = Some(oif);
                }
            }
        }

        // 4. 组装
        let mut out: Vec<AdapterInfo> = Vec::new();
        for (idx, name, flags, is_loopback) in links {
            if is_loopback {
                continue;
            }
            let ip = addr_map.get(&idx).copied();
            let is_up = flags.contains(LinkFlags::Up);
            let is_virtual = is_virtual_name(&name);
            out.push(AdapterInfo {
                name,
                description: None,
                ip,
                is_up,
                is_default: Some(idx) == default_oif,
                is_virtual,
            });
        }
        Ok(out)
    })
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// Linux 实机/容器验证：枚举全部适配器，结构完整且主网卡存在。
    /// 需要 netlink 权限（普通用户即可，无需 root）。
    #[test]
    fn linux_list_all_adapters_ok() {
        let adapters = list_all_adapters().expect("list_all_adapters should work on linux");
        assert!(!adapters.is_empty(), "should have at least loopback-adjacent ifaces");
        // 主网卡（默认路由）必须存在
        assert!(
            adapters.iter().any(|a| a.is_default),
            "default-route interface should be marked: {adapters:?}"
        );
        // 非虚拟网卡至少有一个物理网卡
        assert!(
            adapters.iter().any(|a| !a.is_virtual),
            "at least one physical iface expected: {:?}",
            adapters
        );
    }

    /// Linux：list_interfaces（if-addrs）与 list_all_adapters（netlink）主网卡一致。
    #[test]
    fn linux_primary_consistent() {
        let a = list_all_adapters().expect("netlink adapters");
        let b = list_interfaces().expect("if-addrs interfaces");
        let a_primary = a.iter().find(|x| x.is_default).map(|x| x.name.clone());
        let b_primary = b.iter().find(|x| x.is_default).map(|x| x.name.clone());
        assert_eq!(a_primary, b_primary, "primary iface should agree");
    }
}



