//! 协议注册表：插件总线。编译期注册，引擎按 scheme 查找协议实现。

use crate::protocol::Protocol;
use std::sync::{Arc, RwLock};

pub struct Registry {
    protocols: RwLock<Vec<Arc<dyn Protocol>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            protocols: RwLock::new(Vec::new()),
        }
    }

    /// 注册一个协议实现（编译期调用）。
    pub fn register(&self, p: Arc<dyn Protocol>) {
        self.protocols.write().unwrap().push(p);
    }

    /// 按 scheme 查找第一个匹配的协议。HTTP 层据此分派下载请求。
    pub fn find_by_scheme(&self, scheme: &str) -> Option<Arc<dyn Protocol>> {
        self.protocols
            .read()
            .unwrap()
            .iter()
            .find(|p| p.schemes().contains(&scheme))
            .cloned()
    }

    pub fn list(&self) -> Vec<String> {
        self.protocols
            .read()
            .unwrap()
            .iter()
            .map(|p| p.name().to_string())
            .collect()
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}
