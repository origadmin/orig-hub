//! orig-tg 服务共享状态。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{Notify, RwLock};

use crate::config::Config;
use crate::login::Client;
use crate::store::{CacheTask, MsgTitleSources, Store};

/// 缓存任务快照的条数上限。
///
/// 与 `GET /api/tg/cache/tasks/all` 的契约一致（该端点历史上直接查库时的 limit
/// 也是 500）—— 否则「读改走快照」会顺带把条数砍到 50，界面少显示 450 条。
pub const CACHE_TASK_SNAPSHOT_LIMIT: u32 = 500;

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
    /// 任务标题来源快照（`(chat_id, message_id) -> caption/file_name`）。
    ///
    /// 与 `cache_tasks` 同一理由（BUG-375）：`/api/tg/cache/tasks/all` 在轮询读
    /// 路径上，标题不能再按频道逐条查库 —— 那既慢又与 worker 的写争用同一连接。
    ///
    /// 值是 `Option`：增量合并用「键在不在」区分「还没解析」与「解析过但无标题」，
    /// 见 [`Self::refresh_cache_tasks`] 与 [`Self::invalidate_cache_task_titles`]。
    cache_task_titles: Arc<RwLock<Arc<HashMap<(i64, i64), Option<MsgTitleSources>>>>>,
    /// 任务级组清单摘要快照（`task_id -> ManifestSummary`）。同上，读路径零 DB。
    cache_task_summaries: Arc<RwLock<Arc<HashMap<i64, crate::media::ManifestSummary>>>>,
    /// 缓存 worker 单飞门禁：同一时刻至多一个 worker 协程在跑（进程内判定；
    /// DB 侧 `has_running_cache_task` 是跨请求的慢判定，两者配合防双跑）。
    cache_worker_alive: AtomicBool,
    /// 增量同步单飞门禁（BUG-102）：同一时刻至多一轮 `monitor::sync_once` 在跑。
    ///
    /// **为什么必须单飞**：触发源有三路且可同时打向同一批频道——后台定时循环
    /// （`monitor::spawn`，默认 30s）、前端 60s 轮询 `POST /api/tg/monitor/sync`、
    /// 用户手动点击。此前 `sync_once` 全程无互斥，三路可并发推进同一批频道的游标，
    /// 而一轮同步并不便宜（翻页扫描 + 串行 upsert），于是 **Telegram RPC 预算被叠加
    /// 消耗**——正是本条要消除的浪费。
    ///
    /// 进程内判定（`AtomicBool`）即可：三个触发源全在同一进程，不存在跨进程并发。
    sync_inflight: AtomicBool,
    /// 节流留痕用的「上次记录时刻」表（BUG-106）。
    ///
    /// 缩略图这类高频路径一页就是几十个请求，链路一断会灌进几十上百条**内容相同**
    /// 的日志 —— 环形日志被冲掉，真正的病因反而找不到了。按 key 节流，
    /// 保证「出了事一定留痕」的同时不制造日志风暴。
    log_throttle: Mutex<HashMap<String, Instant>>,
    /// 缓存 worker 当前条目的字节进度（BUG-181）。
    ///
    /// 条目边界之间的下载（一条 200MB 视频可达数分钟）此前零呈现 —— `done`
    /// 计数冻结，对用户等价于「系统死了」。现在 grammers 每 chunk 累加到这里，
    /// 任务端点在序列化时注入 `itemBytes`/`itemBytesTotal`。原子读写，
    /// 高频读端点不碰锁。
    pub cache_dl: crate::login::DownloadProgress,
    /// 正在报字节的缓存任务 id（0 = 无）。序列化方据此判断注入是否归属当前任务，
    /// 防止「任务已切条目/已结束但旧字节仍在」的错配。
    pub cache_dl_task: std::sync::atomic::AtomicI64,
    /// 缓存任务的**取消令牌登记**（BUG-257）。
    ///
    /// 此前 `cancel_cache_task` 只改数据库状态，而 worker 只在**每条目之前**查一次
    /// 活跃性（`routes.rs` 的 `is_cache_task_active`）⇒ 取消对**在途条目完全无效**：
    /// 用户按了取消，唯一能打断在途 IO 的仍是 90s 空闲看门狗。这就是「卡住的资源
    /// 无法暂停」的根因——不是缺 pause/resume（那条铁律仍然成立），而是**取消够不着
    /// 在途 IO**。
    ///
    /// 令牌与任务 id 一一对应，由 worker 起跑时登记、终态时注销。取消方**先置标志
    /// 再落库**，于是「取消先到、worker 后起」的竞态也被覆盖：worker 起跑时读到的
    /// 已是置位的标志，不会替一条已取消的任务开跑。
    cache_cancels: Mutex<HashMap<i64, CacheCancel>>,
}

/// 取消令牌 = **权威标志** + **唤醒源**，两者缺一不可（BUG-257）。
///
/// 为什么不能只用 `AtomicBool`：标志是权威但**不唤醒**——`select!` 里的等待方若只看
/// 标志，就得靠轮询才能察觉（凭空引入延迟与 CPU 抖动）。为什么不能只用 `Notify`：
/// 通知允许丢失（`notify_waiters()` 只唤醒**已在等**的等待方），而「置标志」与
/// 「进入等待」之间天然存在窗口。**标志判据 + `notify_one()` 补发许可**合起来才无洞：
/// 先到者置标志，后到者读标志；两者都到时 `notify_one()` 至少留一张许可给随后才注册的
/// 等待方，故不会睡死。
#[derive(Clone, Default)]
pub struct CacheCancel {
    /// 取消标志：`true` = 该任务已被要求停止。**唯一权威判据**。
    pub flag: Arc<AtomicBool>,
    /// 唤醒源：让 `select!` 的取消分支立刻被唤醒，而不是轮询。
    pub notify: Arc<Notify>,
}

impl CacheCancel {
    /// 置标志并唤醒等待方（幂等）。
    pub fn trip(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // 单飞模型下每个任务至多一个等待方，故 `notify_one` 足够；它的「无等待方时
        // 存一张许可」语义正是补上「先置标志、后注册等待」那个窗口的关键。
        self.notify.notify_one();
    }

    /// 已被要求停止否。
    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// 等待取消；已取消则**立即**返回（先看权威标志，再睡）。
    ///
    /// 循环体是必要的：`notify_one` 的许可可能被上一轮醒来消费，而标志仍未变
    /// （虚假唤醒），此时必须重新判据而不是误报取消。
    pub async fn wait(&self) {
        loop {
            if self.is_set() {
                return;
            }
            self.notify.notified().await;
        }
    }
}

/// 同步单飞守卫（BUG-102）：**持有即占住名额，Drop 即释放**。
///
/// 为什么是 RAII 而不是在 `sync_once` 末尾手写 `release_sync()`：`sync_once` 内部
/// 有多个 `?` 早返回（`list_channels` / `messages` / `upsert_message` 任一失败即返回），
/// 手写释放必然漏掉其中一条 —— 而漏掉的后果不是「多跑一轮」，而是**同步被永久焊死**
/// （标志再也回不到 false，之后所有触发源全部空转，TG 内容再也不更新，且没有任何报错）。
/// 这类「失败即静默永久失效」比原缺陷更难发现。`Drop` 覆盖所有出口：正常返回、
/// 早返回、panic、以及任务被取消（future drop）。
pub struct SyncGuard<'a> {
    owner: &'a AppState,
}

impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.owner.release_sync();
    }
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
            cache_task_titles: Arc::new(RwLock::new(Arc::new(HashMap::new()))),
            cache_task_summaries: Arc::new(RwLock::new(Arc::new(HashMap::new()))),
            cache_worker_alive: AtomicBool::new(false),
            sync_inflight: AtomicBool::new(false),
            log_throttle: Mutex::new(HashMap::new()),
            cache_dl: crate::login::DownloadProgress::default(),
            cache_dl_task: std::sync::atomic::AtomicI64::new(0),
            cache_cancels: Mutex::new(HashMap::new()),
        }
    }

    // ---- BUG-257：取消可达在途 IO ----

    /// 取（必要时登记）某任务的取消令牌。
    ///
    /// worker 起跑时调用；取消方也调同一个入口，故「取消先到」时令牌**已存在且已置位**，
    /// worker 随后读到的是置位的令牌，不会替已取消的任务开跑。
    pub fn cache_cancel(&self, task_id: i64) -> CacheCancel {
        let mut g = self.cache_cancels.lock().unwrap_or_else(|e| e.into_inner());
        g.entry(task_id).or_default().clone()
    }

    /// 请求取消某任务（**幂等**）：置标志 + 唤醒在途等待方。
    ///
    /// 对**不存在**的任务同样安全：登记一个已置位的令牌。若该任务之后才起跑，
    /// `cache_cancel` 会取到这张已置位的令牌并立刻退出——竞态方向只有一个，
    /// 不会漏取消。
    pub fn request_cache_cancel(&self, task_id: i64) {
        self.cache_cancel(task_id).trip();
    }

    /// 注销某任务的令牌（worker 到达终态时调用）。
    ///
    /// 不注销的后果是 token 表随任务数单调增长（进程内的小泄漏），而队列可能很长。
    pub fn clear_cache_cancel(&self, task_id: i64) {
        let mut g = self.cache_cancels.lock().unwrap_or_else(|e| e.into_inner());
        g.remove(&task_id);
    }

    /// 条目下载开始：绑定任务 id 并清零字节（总量由 client 在开流前设置）。
    pub fn cache_dl_begin(&self, task_id: i64) {
        self.cache_dl.reset();
        self.cache_dl_task
            .store(task_id, std::sync::atomic::Ordering::Relaxed);
    }

    /// 条目下载结束（成败皆然）：解绑任务 id，序列化方随之停报。
    pub fn cache_dl_end(&self) {
        self.cache_dl_task
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    /// 当前条目字节（仅当归属 `task_id` 时返回；否则 None）。
    pub fn cache_dl_progress(&self, task_id: i64) -> Option<(u64, u64)> {
        if self
            .cache_dl_task
            .load(std::sync::atomic::Ordering::Relaxed)
            == task_id
        {
            Some(self.cache_dl.load())
        } else {
            None
        }
    }

    /// 当前条目字节**连同最后推进时刻**（BUG-221，原子同拍读取）。
    ///
    /// 返回 `(bytes, total, last_ms)`，`last_ms == 0` 表示「绑定了但一个字节都还没推进」
    /// （此时不得算出停滞：还没起步不等于卡住）。归属判定与 `cache_dl_progress` 同口径：
    /// 字节不属于 `task_id` 时返回 None，防止旧条目的心跳错配到新任务上。
    pub fn cache_dl_progress_at(&self, task_id: i64) -> Option<(u64, u64, u64)> {
        if self
            .cache_dl_task
            .load(std::sync::atomic::Ordering::Relaxed)
            == task_id
        {
            Some(self.cache_dl.load_with_at())
        } else {
            None
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

    // ---- BUG-102：增量同步单飞（三路触发源并发打同一批频道） ----

    /// 尝试占住同步名额：返回 `Some` 表示本协程独家获得本轮同步的执行权，
    /// `None` 表示**已有一轮在跑**，调用方应立即放弃本轮（不得排队）。
    pub fn claim_sync(&self) -> Option<SyncGuard<'_>> {
        self.sync_inflight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| SyncGuard { owner: self })
    }

    /// 释放同步名额。
    pub fn release_sync(&self) {
        self.sync_inflight.store(false, Ordering::SeqCst)
    }

    /// 当前是否有一轮同步在跑（诊断/端点暴露用）。
    pub fn is_sync_running(&self) -> bool {
        self.sync_inflight.load(Ordering::SeqCst)
    }

    /// 从 DB 重建缓存任务快照（每次 DB 变更后由唯一写者调用）。
    ///
    /// BUG-375：一并重建**标题来源**与**组清单摘要**两个快照。
    ///
    /// 起因：`GET /api/tg/cache/tasks/all`（daemon `/api/activity` 的 cache 源每 5s
    /// 拉一次）原先每次都打三条 SQL，而它与下载 worker **共用同一条 libsql 连接** ——
    /// worker 一持写事务，读就排在后面等锁。实测同一请求 3.18s / 0.03s / **13.70s**
    /// （无写竞争时全三条合计仅 36ms），daemon 出向客户端总超时 4s ⇒ 大量请求被切成
    /// `request orig-tg: error sending request for url`，用户侧即「TG 入库任务暂时
    /// 无法读取 / 进度不动 / 卡顿」。而同文件的 `/api/tg/cache/tasks`（单任务端点）
    /// 早已改读 `cache_tasks` 内存快照、零 DB —— **快的那条的成果没有辐射到慢的那条**。
    ///
    /// 代价：每个写点多两三条只读聚合。写点本就是低频 DB 操作，把这份成本从
    /// **每次轮询**移到**每次写**是正确的方向。
    ///
    /// 但「写点」里有一条**高频**路径必须单独治：`run_one_cache_task` 下载循环内
    /// **每下载完一条目就刷一次**（`routes.rs` 两处 `done += 1` 之后）。若每次都
    /// 全量重查标题，实测 400 任务 / 4000 引用下标题查询 43ms ⇒ 单任务 10 条目
    /// 就要多 430ms，且全程占着那条唯一的 libsql 连接 —— 那等于把 BUG-375 的
    /// 等锁从读路径搬到了下载循环里。**修读路径不能变成拖慢下载。**
    ///
    /// 所以标题走**增量合并**：标题来源是 Telegram caption，一条消息解析过一次
    /// 就不会变（只有自愈补写才会变，那条路显式 [`Self::invalidate_cache_task_titles`]）。
    /// 只查快照里**还没解析过**的引用；稳态下（每条目刷新）新增引用为 0，
    /// 一条 SQL 都不打。`None` 值 = 「查过了，确实没有标题」，与「键不存在」
    /// （还没查）区分开 —— 否则无标题消息会被每次刷新反复查。
    pub async fn refresh_cache_tasks(&self) {
        let tasks = self
            .store
            .list_cache_tasks(CACHE_TASK_SNAPSHOT_LIMIT)
            .await
            .unwrap_or_default();
        // 标题来源：只取任务**实际涉及**的消息（BUG-375：旧的「按频道全扫」会把每个
        // 频道所有有标题的消息全拉回来 —— 实测 10 频道 3768 行 / 33ms，而任务列表只用
        // 其中几百行。写点不该背这个开销）。且只取**尚未解析过**的引用（增量合并）。
        let mut titles = self.cache_task_titles.read().await.clone();
        let mut refs: std::collections::HashSet<(i64, i64)> = tasks
            .iter()
            .flat_map(|t| t.message_ids.iter().map(move |m| (t.chat_id, *m)))
            .filter(|r| !titles.contains_key(r))
            .collect();
        if !refs.is_empty() {
            let fresh: Vec<(i64, i64)> = refs.drain().collect();
            let got = self
                .store
                .message_captions_for_refs(&fresh)
                .await
                .unwrap_or_default();
            let m = Arc::make_mut(&mut titles);
            // 查到的写入 `Some`，没查到的标记 `None`（解析过、无标题）——
            // 两者都不会在下次刷新被重复查。
            for r in &fresh {
                m.insert(*r, got.get(r).cloned());
            }
        }
        let summaries = self.store.task_manifest_summaries().await.unwrap_or_default();
        *self.cache_tasks.write().await = Arc::new(tasks);
        *self.cache_task_titles.write().await = titles;
        *self.cache_task_summaries.write().await = Arc::new(summaries);
    }

    /// 读快照（零 DB；clone Arc，无深拷贝）。
    pub async fn cache_tasks_snapshot(&self) -> Arc<Vec<CacheTask>> {
        self.cache_tasks.read().await.clone()
    }

    /// 读标题来源快照（零 DB）。
    ///
    /// 值为 `Option`：`None` = 「查过了，这条消息确实没有标题」，与「键不存在」
    /// （还没解析过）是两件事 —— 前者不再重查，后者下次刷新会查。
    pub async fn cache_task_titles_snapshot(
        &self,
    ) -> Arc<HashMap<(i64, i64), Option<MsgTitleSources>>> {
        self.cache_task_titles.read().await.clone()
    }

    /// 重新解析指定引用的标题并**写回快照**（BUG-375）。
    ///
    /// 唯一调用方是标题自愈 `backfill_message_titles`：它从 Telegram 补回 caption
    /// 并写库，而增量合并的快照里这些引用此前已被解析成「无标题」，不处理就永远
    /// 看不到补回来的标题。
    ///
    /// **为什么必须是「重新解析」而不是「打回未解析」**（本方法的第一版就是只
    /// `remove`，那是个真 bug）：只移除键的话，`/tasks/all` 读快照时这些引用不见了
    /// ⇒ 标题消失；下一轮 `spawn_title_selfheal` 看到无标题再去自愈，而
    /// `message_has_title` 已经为真 ⇒ 直接跳过、不写库、也就不再触发任何解析
    /// ⇒ **标题在下一次写点前永久不可见**。而写点可能几个小时都不来（全部任务终态时
    /// 没有任何 DB 写入）。所以这里当场查库并把结果写回快照，标题立即可见。
    pub async fn resolve_cache_task_titles(&self, refs: &[(i64, i64)]) {
        if refs.is_empty() {
            return;
        }
        let got = self
            .store
            .message_captions_for_refs(refs)
            .await
            .unwrap_or_default();
        let mut g = self.cache_task_titles.write().await;
        // `g` 是写 guard，`make_mut` 要的是里面的 `Arc` —— 解引用一次。
        let m = Arc::make_mut(&mut *g);
        for r in refs {
            m.insert(*r, got.get(r).cloned());
        }
    }

    /// 把指定引用的标题**打回未解析**（BUG-375）—— 只移除键，不查库。
    ///
    /// 与 [`Self::resolve_cache_task_titles`] 的分工（**别混用**）：
    /// - `invalidate` = 「下次刷新时重新查」。调用方**必须**容忍「直到下次写点
    ///   才可见」这段窗口，否则就该用 `resolve`。
    /// - `resolve` = 「现在就查并写回快照」。自愈补写走这条（生产里没人会接着刷）。
    ///
    /// 现役调用方只有规模实测测试的对照组（把全部引用打回未解析，量「全量重查」
    /// 的代价，用来证明稳态优化有牙）。**生产代码不要用它来做自愈后的失效** ——
    /// 那正是本方法第一版的 bug：标题等到下次写点才可见，而自愈又因「库里已有
    /// 标题」不再触发 ⇒ 永久看不到。
    pub async fn invalidate_cache_task_titles(&self, refs: &[(i64, i64)]) {
        if refs.is_empty() {
            return;
        }
        let mut g = self.cache_task_titles.write().await;
        // `g` 是写 guard，`make_mut` 要的是里面的 `Arc` —— 解引用一次。
        let m = Arc::make_mut(&mut *g);
        for r in refs {
            m.remove(r);
        }
    }

    /// 读组清单摘要快照（零 DB）。
    pub async fn cache_task_summaries_snapshot(
        &self,
    ) -> Arc<HashMap<i64, crate::media::ManifestSummary>> {
        self.cache_task_summaries.read().await.clone()
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

    // ── BUG-257：取消令牌（取消可达在途 IO 的判据） ─────────────────────

    /// 未取消时令牌是干净的，且 `wait()` 不会自己醒（否则等于「恒定已取消」）。
    #[tokio::test]
    async fn cache_cancel_starts_clear_and_wait_blocks_until_tripped() {
        let st = state().await;
        let c = st.cache_cancel(42);
        assert!(!c.is_set(), "新令牌不得一上来就是已取消");

        // 未取消时 wait 必须**继续等**（用超时证明它没返回）。
        let raced = tokio::time::timeout(std::time::Duration::from_millis(50), c.wait()).await;
        assert!(raced.is_err(), "未取消时 wait() 不得返回 —— 否则等于恒定已取消");

        c.trip();
        assert!(c.is_set());
        tokio::time::timeout(std::time::Duration::from_secs(5), c.wait())
            .await
            .expect("已取消时 wait() 必须立即返回（不得睡死）");
    }

    /// 核心时序保证：**先置标志、后注册等待**不得睡死（BUG-257 的取消竞态）。
    ///
    /// 这正是 `Notify` 单用的漏洞：先 `notify_one()` 时若还没有等待方，许可会被
    /// 存下来（`notify_one` 有许可语义），但若换成 `notify_waiters` 就会**永久丢失**。
    /// 本测试把「置位」排在「等待」之前，正面压住这个窗口——它就是「用户按了取消，
    /// worker 却永远等不到通知」的形态。
    #[tokio::test]
    async fn cache_cancel_does_not_lose_the_signal_when_trip_precedes_wait() {
        let st = state().await;
        let c = st.cache_cancel(7);
        c.trip(); // 先置位
        // 后等待：必须立刻返回，绝不能睡到看门狗那90s。
        tokio::time::timeout(std::time::Duration::from_secs(5), c.wait())
            .await
            .expect("先置位后等待必须立即返回 —— 信号不许丢");
    }

    /// 通过 AppState 取消（生产路径）与直接持有令牌是**同一个**判据。
    #[tokio::test]
    async fn request_cache_cancel_is_observable_through_the_registry() {
        let st = state().await;
        assert!(!st.cache_cancel(9).is_set());
        st.request_cache_cancel(9);
        assert!(
            st.cache_cancel(9).is_set(),
            "取消方与 worker 必须读到同一张令牌，否则取消对在途无效"
        );
    }

    /// 注销后重新取到的是**干净**令牌：新任务不得继承上一条任务的取消标志。
    /// 不注销或注销不干净，都会让「取消过一条」变成「之后每条都秒退」。
    #[tokio::test]
    async fn clear_cache_cancel_gives_the_next_task_a_clean_token() {
        let st = state().await;
        st.request_cache_cancel(11);
        assert!(st.cache_cancel(11).is_set());
        st.clear_cache_cancel(11);
        assert!(
            !st.cache_cancel(11).is_set(),
            "注销必须真的移除：新任务不得继承旧任务的取消标志"
        );
    }

    /// 取消一个**尚未起跑**的任务：令牌必须已经置位，这样 worker 起跑时立刻退出。
    /// 这是 cancel↔enqueue 竞态的方向性保证（取消先到也不能漏）。
    #[tokio::test]
    async fn cancelling_before_the_worker_starts_still_trips_the_token() {
        let st = state().await;
        // 任务还没起跑，此刻取消
        st.request_cache_cancel(13);
        // worker 随后才来取令牌：取到的必须是已置位的那张
        let c = st.cache_cancel(13);
        assert!(c.is_set(), "取消先到、worker 后起时不得漏取消");
        tokio::time::timeout(std::time::Duration::from_secs(5), c.wait())
            .await
            .expect("已取消的任务应在起跑判定处立即退出");
    }
}