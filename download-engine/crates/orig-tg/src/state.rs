//! orig-tg 服务共享状态。

use std::sync::Arc;

use crate::config::Config;
use crate::login::Client;

pub struct AppState {
    /// 底层 MTProto 客户端抽象（骨架=内存占位；后续接入 grammers）。
    pub client: Arc<dyn Client>,
    /// 服务配置。
    pub config: Config,
}

impl AppState {
    pub fn new(client: Arc<dyn Client>, config: Config) -> Self {
        Self { client, config }
    }
}