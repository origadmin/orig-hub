//! orig-tg 服务共享状态。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;

use crate::config::Config;
use crate::login::Client;
use crate::store::{CacheTask, Store};

/// 内存环形日志缓冲（诊断用，不持久化）。容量上限防内存增长。
pub struct RingLog {
    inner: Mutex<VecDeque<String>>,
    cap: usize,
}

impl RingLog {
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Mutex::new(VecDeque::new()),
            cap,
        }
    }

    /// 追加一行（带时间戳前缀 `[epoch_secs] `）。
    pub fn push(&self, line: impl AsRef<str>) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut q = self.inner.lock().unwrap();
        if q.len() >= self.cap {
            q.pop_front();
        }
        q.push_back(format!("[{ts}] {}", line.as_ref()));
    }

    /// 返回最近 `lines` 条（新→旧）。
    pub fn recent(&self, lines: usize) -> Vec<String> {
        let q = self.inner.lock().unwrap();
        q.iter().rev().take(lines).cloned().collect()
    }

    /// 总条数。
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

/// TG 可用性——**只有两态**，不存在「假装可用」的第三态。
///
/// 取代此前的 `api_mode: &'static str`（`"real"` / `"dummy"`）。旧字段是个**纯展示标签**：
/// 没有任何代码据它分支，所以「凭证齐全但 MTProto 连不上 → 换假客户端继续对外服务」
/// 对系统其余部分完全不可见，前端只能读到一个看似正常的会话，最终表现为「登录丢失」
/// （BUG-023）。现在把不可用连同原因变成类型的一部分，并让所有 TG 能力显式 503。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    /// 凭证齐备且 MTProto 已连接就绪。
    Ready,
    /// 不可用，携带可读原因（下发前端用于显示，而不是静默当作未登录）。
    Unavailable(String),
}

impl Availability {
    /// 是否可用。
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready)
    }

    /// 不可用原因；可用时为 `None`。
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Ready => None,
            Self::Unavailable(r) => Some(r.as_str()),
        }
    }

    /// 诊断标签（`/api/tg/diag` 的 `mode` 字段）。
    pub fn label(&self) -> &'static str {
        if self.is_ready() {
            "ready"
        } else {
            "unavailable"
        }
    }
}

pub struct AppState {
    /// 底层 MTProto 客户端抽象：真实客户端，或不可用时的[诚实空对象](crate::unavailable)。
    pub client: Arc<dyn Client>,
    /// 服务配置。
    pub config: Config,
    /// 诊断环形日志（`/api/tg/logs` 读取）。
    pub logs: RingLog,
    /// 监控存储（频道/消息/游标）。
    pub store: Store,
    /// TG 可用性（`Ready` / `Unavailable(原因)`）。
    pub availability: Availability,
    /// 是否运行在测试 mock 客户端之上。
    ///
    /// 生产构建（默认特性集）**恒为 false**：`mock` 模块被 `#[cfg(feature = "mock")]`
    /// 编译排除。该字段在 `/api/tg/diag` 显式暴露，避免合成数据被误当真实数据。
    pub mock: bool,
    /// 会话缓存是否正在后台全量扫描（GET dialogs 据此返回 `scanning`，前端轮询）。
    pub dialog_scanning: AtomicBool,
    /// 缓存任务快照（读路径缓存，见 `refresh_cache_tasks`）。
    ///
    /// **读走内存、写后刷新**：`GET /api/tg/cache/tasks` 是前端 1s 轮询的高频读，
    /// 每次都打 SQLite（ORDER BY 排序）既浪费又与下载 worker 的写争用同一连接。
    /// 快照由「唯一写者」在每次 DB 变更后同步刷新（`refresh_cache_tasks`），
    /// 读方 clone `Arc` 即返回——零 DB、零锁竞争（RwLock 读锁纳秒级）。
    cache_tasks: Arc<RwLock<Arc<Vec<CacheTask>>>>,
    /// 缓存 worker 单飞门禁：同一时刻至多一个 worker 协程在跑（进程内判定；
    /// DB 侧 `has_running_cache_task` 是跨请求的慢判定，两者配合防双跑）。
    cache_worker_alive: AtomicBool,
    /// 节流留痕用的「上次记录时刻」表（BUG-106）。
    ///
    /// 缩略图这类高频路径一页就是几十个请求，链路一断会灌进几十上百条**内容相同**
    /// 的日志 —— 环形日志被冲掉，真正的病因反而找不到了。按 key 节流，
    /// 保证「出了事一定留痕」的同时不制造日志风暴。
    log_throttle: Mutex<HashMap<String, Instant>>,
}

impl AppState {
    pub fn new(
        client: Arc<dyn Client>,
        config: Config,
        availability: Availability,
        mock: bool,
        store: Store,
    ) -> Self {
        Self {
            client,
            config,
            logs: RingLog::new(200),
            store,
            availability,
            mock,
            dialog_scanning: AtomicBool::new(false),
            cache_tasks: Arc::new(RwLock::new(Arc::new(Vec::new()))),
            cache_worker_alive: AtomicBool::new(false),
            log_throttle: Mutex::new(HashMap::new()),
        }
    }

    /// 尝试占住 worker 名额：返回 false 表示已有 worker 在跑（新任务留在队列等接续）。
    pub fn claim_cache_worker(&self) -> bool {
        self.cache_worker_alive
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// worker 退出时释放名额。
    pub fn release_cache_worker(&self) {
        self.cache_worker_alive.store(false, Ordering::SeqCst)
    }

    /// 从 DB 重建缓存任务快照（每次 DB 变更后由唯一写者调用）。
    pub async fn refresh_cache_tasks(&self) {
        let tasks = self.store.list_cache_tasks(50).await.unwrap_or_default();
        *self.cache_tasks.write().await = Arc::new(tasks);
    }

    /// 读快照（零 DB；clone Arc，无深拷贝）。
    pub async fn cache_tasks_snapshot(&self) -> Arc<Vec<CacheTask>> {
        self.cache_tasks.read().await.clone()
    }

    pub fn push_log(&self, line: impl AsRef<str>) {
        self.logs.push(line);
    }

    /// 节流留痕（BUG-106）：同一 `key` 在 `secs` 内只记一条。
    ///
    /// 用于高频路径（列表缩略图等）。**绝不静默吞错** —— 降级分支必须留痕，
    /// 否则「每次都失败但没人知道」又会变成下一个谜案；节流只是防止日志被冲垮。
    pub fn push_log_throttled(&self, key: &str, secs: u64, line: impl AsRef<str>) {
        let mut g = match self.log_throttle.lock() {
            Ok(g) => g,
            // 锁中毒：宁可不节流也要留痕（丢日志比多记几条更糟）。
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let due = match g.get(key) {
            Some(t) => now.duration_since(*t) >= Duration::from_secs(secs),
            None => true,
        };
        if due {
            g.insert(key.to_string(), now);
            self.logs.push(line);
        }
    }

    /// 读取后台扫描状态（Relaxed：仅作进度提示，无并发数据依赖）。
    pub fn is_scanning(&self) -> bool {
        self.dialog_scanning.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::store::Store;
    use crate::unavailable::UnavailableClient;

    async fn state() -> AppState {
        AppState::new(
            // UnavailableClient：link_alive() == false，正是「链路断了」的情形。
            Arc::new(UnavailableClient::new("test: link down")),
            Config::default(),
            Availability::Unavailable("test".to_string()),
            false,
            Store::open(":memory:").await.expect("in-memory store must open"),
        )
    }

    fn has(st: &AppState, needle: &str) -> bool {
        st.logs.recent(50).iter().any(|l| l.contains(needle))
    }

    /// BUG-106 的关键保证：**第一次一定留痕**。
    ///
    /// 节流是为了防日志风暴，绝不能变成「什么都不记」—— 那恰恰是本条的病根
    /// （错误在源头被销毁，只剩表象）。这条断言是防止有人把节流写成静默。
    #[tokio::test]
    async fn throttled_log_always_records_the_first_occurrence() {
        let st = state().await;
        st.push_log_throttled("thumb", 60, "FIRST-OCCURRENCE");
        assert!(
            has(&st, "FIRST-OCCURRENCE"),
            "首次失败必须留痕 —— 节流不得把第一条也吞掉"
        );
    }

    /// 风暴抑制：同一 key 在窗口内只记一条，但**不同 key 互不干扰**
    /// （缩略图被抑制时，messages 的失败仍必须可见）。
    #[tokio::test]
    async fn throttled_log_suppresses_burst_without_hiding_other_keys() {
        let st = state().await;
        st.push_log_throttled("thumb", 60, "T1");
        st.push_log_throttled("thumb", 60, "T2"); // 同 key 同窗口 → 抑制
        st.push_log_throttled("messages", 60, "M1"); // 不同 key → 记录

        assert!(has(&st, "T1"), "首条须留痕");
        assert!(!has(&st, "T2"), "同一 key 的连发须被抑制，避免冲垮环形日志");
        assert!(
            has(&st, "M1"),
            "不同 key 必须独立计数 —— 别让缩略图的风暴把消息失败也吞了"
        );
    }

    /// 不节流接口（低频路径）保持每条都记。
    #[tokio::test]
    async fn plain_push_log_records_every_line() {
        let st = state().await;
        st.push_log("A1");
        st.push_log("A2");
        assert!(has(&st, "A1") && has(&st, "A2"), "低频路径不得丢日志");
    }
}