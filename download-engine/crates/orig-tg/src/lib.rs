//! orig-tg —— orig-hub 的 Telegram 内容源独立服务（MTProto userbot sidecar）。
//!
//! 独立于 orig-daemon（9876），监听独立端口（默认 9877），经 HTTP 供主 daemon 调度。
//!
//! ## 可用性契约
//!
//! TG 只有**可用 / 不可用**两态（见 [`state::Availability`]），不存在「假装可用」：
//!
//! - 可用：凭证齐备 + MTProto 连接成功 → [`grammers::GrammersClient`]
//! - 不可用：凭证缺失或连接失败 → [`unavailable::UnavailableClient`]，
//!   所有 TG 能力返回 503 + 原因，故障对前端**可见**（BUG-023）
//!
//! [`mock`] 是**测试专用**的合成客户端，被 `#[cfg(feature = "mock")]` 编译排除在
//! 生产二进制之外 —— 它只会被显式选中（`ORIG_TG_MOCK=1` + 显式 `ORIG_TG_DB`），
//! 永远不会成为某个失败路径的兜底。

pub mod config;
pub mod grammers;
pub mod login;
/// 极简容量+TTL LRU（媒体元数据/缩略图缓存，BUG-028）。
pub mod lru;
pub mod media;
pub mod monitor;
pub mod routes;
pub mod state;
pub mod store;
/// 不可用时的诚实空对象（说真话，不产假数据）。
pub mod unavailable;

/// 测试用 mock 客户端（合成频道/消息/缩略图/下载）。
///
/// **只在 `--features mock` 构建中存在**：默认特性集下本模块不参与编译，
/// 生产二进制物理上不含任何合成数据实现，也就不可能被某条失败路径误选为兜底。
#[cfg(feature = "mock")]
pub mod mock;
