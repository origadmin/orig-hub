//! 极简容量+TTL 缓存（无外部依赖）。
//!
//! 用途（BUG-028）：媒体元数据与缩略图在「播放器 seek / 续 Range / feed 重渲染」
//! 场景下被反复请求，而每次请求都要付出一次 `get_messages_by_id` RPC（实测 ~1.2s）。
//! 此缓存把热键的解析结果留存在内存中，命中即零 RPC。
//!
//! 语义：
//! - `get` 命中时把键移到队尾（LRU 刷新），过期条目视同未命中并清除；
//! - `insert` 超容量时淘汰队尾最久未用键；
//! - 全部操作持锁完成，临界区内无 await，锁为 `std::sync::Mutex`。

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Inner<K, V> {
    map: HashMap<K, (V, Instant)>,
    order: VecDeque<K>,
}

pub struct TtlLru<K, V> {
    cap: usize,
    ttl: Duration,
    inner: Mutex<Inner<K, V>>,
}

impl<K: Eq + Hash + Clone, V: Clone> TtlLru<K, V> {
    pub fn new(cap: usize, ttl: Duration) -> Self {
        Self {
            cap: cap.max(1),
            ttl,
            inner: Mutex::new(Inner {
                map: HashMap::new(),
                order: VecDeque::new(),
            }),
        }
    }

    /// 命中返回克隆值并刷新 LRU 顺序；过期即清除并返回 None。
    pub fn get(&self, key: &K) -> Option<V> {
        let mut g = self.inner.lock().ok()?;
        if let Some((v, at)) = g.map.get(key).cloned() {
            if at.elapsed() < self.ttl {
                // LRU 刷新：移到队尾
                if let Some(pos) = g.order.iter().position(|k| k == key) {
                    g.order.remove(pos);
                }
                g.order.push_back(key.clone());
                return Some(v);
            }
            g.map.remove(key);
        }
        None
    }

    /// 插入/覆盖，超容量淘汰最久未用键。
    pub fn insert(&self, key: K, value: V) {
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if !g.map.contains_key(&key) {
            g.order.push_back(key.clone());
        }
        g.map.insert(key, (value, Instant::now()));
        while g.order.len() > self.cap {
            let evict = g.order.pop_front();
            if let Some(k) = evict {
                g.map.remove(&k);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn hit_and_lru_eviction() {
        let c: TtlLru<i64, &'static str> = TtlLru::new(2, Duration::from_secs(60));
        c.insert(1, "a");
        c.insert(2, "b");
        assert_eq!(c.get(&1), Some("a"));
        // 插入第 3 个键 → 淘汰最久未用的 2（1 刚被 get 刷新过）
        c.insert(3, "c");
        assert_eq!(c.get(&2), None);
        assert_eq!(c.get(&1), Some("a"));
        assert_eq!(c.get(&3), Some("c"));
    }

    #[test]
    fn ttl_expiry() {
        let c: TtlLru<i64, u8> = TtlLru::new(4, Duration::from_millis(1));
        c.insert(1, 7);
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(c.get(&1), None);
    }

    #[test]
    fn overwrite_does_not_grow() {
        let c: TtlLru<i64, u8> = TtlLru::new(2, Duration::from_secs(60));
        c.insert(1, 1);
        c.insert(1, 2);
        c.insert(2, 3);
        c.insert(3, 4); // 淘汰 1（1 只 insert 未 get，顺序最老）
        assert_eq!(c.get(&1), None);
        assert_eq!(c.get(&2), Some(3));
        assert_eq!(c.get(&3), Some(4));
    }
}
