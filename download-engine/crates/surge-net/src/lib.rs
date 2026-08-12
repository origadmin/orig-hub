//! surge-net — 网卡枚举 / 主网卡探测 / 网卡池解析 / 权重分配。
//!
//! 职责（多网卡分流内核的数据基础）：
//! - 枚举系统网卡（名称 / IPv4 / up 状态 / 默认路由标记 / 虚拟网卡启发式）
//! - 探测「主网卡」= 有默认路由的 up 网卡（物理优先；缺省回退第一个 up）
//! - 把请求级 interfaces 配置解析为任务级 `InterfacePool`
//!   （白名单语义：**未开启的附属网卡不进 pool → 不创建 Client、不参与调度**）
//! - 权重归一化（GCD）+ 按权重分配并发连接数（conn_split）
//!
//! 平台实现：Windows 用 `windows` crate 的 GetAdaptersAddresses；
//! 其它平台用 `if-addrs`（无默认路由信息，主网卡按「第一个 up 非回环」启发式）。

pub mod pool;
pub mod probe;

pub use pool::{InterfacePool, InterfaceSpec, PoolMember, Weight};
pub use probe::{AdapterInfo, NetInterface, ProbeError, list_all_adapters, list_interfaces, primary_interface};
