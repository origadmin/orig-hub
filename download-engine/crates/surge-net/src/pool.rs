//! 网卡池：请求级 interfaces 配置 → 任务级已解析白名单 + 权重分配。
//!
//! ## 白名单语义（需求 1）
//! - 主网卡：自动探测，**总参与**（不可关闭）。
//! - 附属网卡：用户显式开启（在 `secondaries` 中给权重）才进入 pool；
//!   **未开启的网卡不进 pool → 不创建 Client、不占连接、不出现在统计中**。
//! - 请求未传 interfaces（`None`）→ 仅主网卡 → 与旧版单 Client 行为一致（向后兼容）。
//!
//! ## 权重（需求 2）
//! - 正整数权重，缺省 1；`conn_split` 按权重分配并发连接数，默认 1:1 均衡。

use crate::probe::{list_interfaces, primary_interface};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::Ipv4Addr;

/// 权重类型：正整数（≥1）。
pub type Weight = u32;

/// 附属网卡配置：权重 + 该网卡专属 URL（URL↔网卡绑定）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SecondarySpec {
    /// 权重（≥1，缺省 1）。
    #[serde(default = "default_weight")]
    pub weight: Weight,
    /// 该网卡专属镜像 URL（可选）。缺省时回退主 URL。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn default_weight() -> Weight {
    1
}

/// 兼容两种 secondaries 值格式：数字（旧）或对象（新）。
/// 数字 → SecondarySpec { weight: n, url: None }。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SecondaryValue {
    Weight(Weight),
    Spec(SecondarySpec),
}

impl From<SecondaryValue> for SecondarySpec {
    fn from(v: SecondaryValue) -> Self {
        match v {
            SecondaryValue::Weight(w) => SecondarySpec {
                weight: w.max(1),
                url: None,
            },
            SecondaryValue::Spec(s) => SecondarySpec {
                weight: s.weight.max(1),
                url: s.url,
            },
        }
    }
}

/// 请求级网卡配置（REST body 可选字段 / 配置层）。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct InterfaceSpec {
    /// 主网卡权重（缺省 1）。
    #[serde(default)]
    pub primary_weight: Option<Weight>,
    /// 附属网卡启用列表：网卡名 → 权重或 {weight, url}。
    /// **只有出现在这里的网卡才会参与下载。**
    #[serde(default)]
pub secondaries: HashMap<String, SecondarySpec>,
}

/// 池成员：一个参与下载的网卡。
#[derive(Debug, Clone, Serialize)]
pub struct PoolMember {
    pub name: String,
    pub ip: Ipv4Addr,
    /// 已规范化权重（≥1）。
    pub weight: Weight,
    /// 该网卡专属 URL（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// 任务级网卡池（已解析、已过滤、不可变）。
#[derive(Debug, Clone, Serialize)]
pub struct InterfacePool {
    pub primary: PoolMember,
    pub secondaries: Vec<PoolMember>,
}

impl Default for InterfacePool {
    fn default() -> Self {
        Self {
            primary: PoolMember {
                name: "primary".into(),
                ip: Ipv4Addr::LOCALHOST,
                weight: 1,
                url: None,
            },
            secondaries: Vec::new(),
        }
    }
}

impl InterfacePool {
    /// 所有成员（主 + 附属），顺序稳定。
    pub fn members(&self) -> Vec<&PoolMember> {
        let mut v: Vec<&PoolMember> = Vec::with_capacity(1 + self.secondaries.len());
        v.push(&self.primary);
        v.extend(self.secondaries.iter());
        v
    }

    /// 成员数。
    pub fn len(&self) -> usize {
        1 + self.secondaries.len()
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// 权重归一化（GCD 约分）：[1,2,4] → [1,2,4]；[4,8] → [1,2]；[1,1] → [1,1]。
    pub fn normalized_weights(&self) -> Vec<Weight> {
        let ws: Vec<Weight> = self.members().iter().map(|m| m.weight.max(1)).collect();
        let g = ws.iter().fold(ws[0], |acc, &w| gcd(acc, w));
        ws.iter().map(|w| w / g).collect()
    }

    /// 按权重把 total 连接数分给各成员（每成员 ≥1；余数按权重降序逐个 +1）。
    /// 返回与 `members()` 对齐的分配数组。
    pub fn conn_split(&self, total: u32) -> Vec<u32> {
        let ws = self.normalized_weights();
        let sum: u32 = ws.iter().sum();
        let total = total.max(ws.len() as u32); // 至少每成员 1 连
        let mut conns: Vec<u32> = ws
            .iter()
            .map(|w| ((total as u64 * *w as u64) / sum as u64) as u32)
            .collect();
        // 每成员保底 1
        for c in conns.iter_mut() {
            if *c == 0 {
                *c = 1;
            }
        }
        let mut used: u32 = conns.iter().sum();
        // 余数：按权重降序（稳定）逐个 +1
        let mut order: Vec<usize> = (0..ws.len()).collect();
        order.sort_by(|&a, &b| ws[b].cmp(&ws[a]).then(a.cmp(&b)));
        let mut i = 0;
        while used < total {
            conns[order[i % order.len()]] += 1;
            used += 1;
            i += 1;
        }
        conns
    }

    /// 从请求配置解析网卡池。
    /// - spec = None → 仅主网卡（旧版行为）
    /// - spec = Some → 主网卡强制加入 + 附属按白名单过滤（仅保留真实存在且 up 的）
    /// - 附属网卡名与主网卡重复 → 忽略
    pub fn resolve(spec: Option<&InterfaceSpec>) -> Result<InterfacePool, ResolveError> {
        let primary = primary_interface()?;
        let primary_ip = primary.ip;
        let primary = PoolMember {
            name: primary.name.clone(),
            ip: primary_ip,
            weight: spec
                .and_then(|s| s.primary_weight)
                .filter(|w| *w > 0)
                .unwrap_or(1),
            url: None,
        };

        let mut secondaries = Vec::new();
        if let Some(spec) = spec {
            if !spec.secondaries.is_empty() {
                let all = list_interfaces()?;
                // 按用户声明顺序（HashMap 无序 → 收集后按名字排序，保证确定性）。
                let mut names: Vec<&String> = spec.secondaries.keys().collect();
                names.sort();
                for name in names {
                    let sec = spec.secondaries.get(name).cloned().unwrap_or_default();
                    let w = sec.weight.max(1);
                    // 跳过与主网卡同名
                    if *name == primary.name {
                        continue;
                    }
                    // 按名字匹配（非 Windows）或 IP 匹配（Windows 主网卡按 IP 已确定）
                if let Some(ni) = all.iter().find(|i| i.name == *name) {
                        if ni.is_up {
                            // 跳过与主网卡同名（IP 可能不同，排除同名不同 IP 的重名网卡）
                            if ni.ip == primary_ip && ni.name == primary.name {
                                continue;
                            }
                            secondaries.push(PoolMember {
                                name: ni.name.clone(),
                                ip: ni.ip,
                                weight: w,
                                url: sec.url,
                            });
                        }
                    }
                    // 不存在/未启用 → 忽略（不报错）
                }
            }
        }

        Ok(InterfacePool { primary, secondaries })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("no primary interface: {0}")]
    NoPrimary(String),
    #[error("interface list failed: {0}")]
    List(String),
}

impl From<crate::probe::ProbeError> for ResolveError {
    fn from(e: crate::probe::ProbeError) -> Self {
        ResolveError::NoPrimary(e.to_string())
    }
}

fn gcd(a: Weight, b: Weight) -> Weight {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(primary_w: Weight, secs: &[(&str, Weight)]) -> InterfacePool {
        let mut secondaries = Vec::new();
        for (n, w) in secs {
            secondaries.push(PoolMember {
                name: n.to_string(),
                ip: Ipv4Addr::LOCALHOST,
                weight: *w,
                url: None,
            });
        }
        InterfacePool {
            primary: PoolMember {
                name: "primary".into(),
                ip: Ipv4Addr::LOCALHOST,
                weight: primary_w,
                url: None,
            },
            secondaries,
        }
    }

    #[test]
    fn normalized_weights_basic() {
        let p = pool(1, &[("a", 2), ("b", 4)]);
        assert_eq!(p.normalized_weights(), vec![1, 2, 4]);
        let p2 = pool(4, &[("a", 8)]);
        assert_eq!(p2.normalized_weights(), vec![1, 2]);
        let p3 = pool(1, &[]);
        assert_eq!(p3.normalized_weights(), vec![1]);
    }

    #[test]
    fn conn_split_equal() {
        // 1:1 默认均衡：total=8 → [4,4]
        let p = pool(1, &[("a", 1)]);
        assert_eq!(p.conn_split(8), vec![4, 4]);
    }

    #[test]
    fn conn_split_weighted() {
        // 1:2:1, total=9 → floor(9*1/4)=2, floor(9*2/4)=4, floor(9*1/4)=2 → 余1 → 最大权重者+1 → [2,5,2]
        let p = pool(1, &[("a", 2), ("b", 1)]);
        assert_eq!(p.conn_split(9), vec![2, 5, 2]);
    }

    #[test]
    fn conn_split_min_one() {
        // 权重差距极大也要保底 1：total=2, 1:100 → [1,1]（total 不足以按比例时保底）
        let p = pool(1, &[("a", 100)]);
        let c = p.conn_split(2);
        assert_eq!(c.len(), 2);
        assert!(c.iter().all(|&x| x >= 1));
        assert_eq!(c.iter().sum::<u32>(), 2);
    }

    #[test]
    fn conn_split_total_respected() {
        let p = pool(1, &[("a", 1), ("b", 1), ("c", 1)]);
        let c = p.conn_split(10);
        assert_eq!(c.iter().sum::<u32>(), 10);
        assert_eq!(c.len(), 4);
    }

    #[test]
    fn zero_weight_normalized_to_one() {
        let p = pool(0, &[("a", 0)]);
        assert_eq!(p.normalized_weights(), vec![1, 1]);
    }
}
