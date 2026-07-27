//! libsurge — Surge 下载内核核心（Rust 侧）。
//!
//! 定义协议插件总线：
//! - `Protocol` trait（从 URL 创建 `Source` 集合）
//! - `Source` trait（一种获取字节的方式：HTTP / BT / FTP / Mock）
//! - `BlockMap`（任务级完成位图，承载切片与跨协议续传）
//! - `engine::Task`（基于 BlockMap + Source 的调度循环）
//! - `SseEvent` / `CapabilitySet` / `Control` / 错误类型
//!
//! 引擎与 HTTP 层只依赖这些抽象，不感知具体协议实现（http / virtual / 未来 bittorrent）。

pub mod engine;
pub mod error;
pub mod protocol;
pub mod registry;

pub use error::{Result, SurgeError};
pub use protocol::*;
pub use registry::Registry;
