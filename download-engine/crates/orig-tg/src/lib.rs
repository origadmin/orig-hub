//! orig-tg —— orig-hub 的 Telegram 内容源独立服务（MTProto userbot sidecar）。
//!
//! 独立于 orig-daemon（9876），监听独立端口（默认 9877），经 HTTP 供主 daemon 调度。

pub mod config;
pub mod grammers;
pub mod login;
pub mod monitor;
pub mod routes;
pub mod state;
pub mod store;