//! 后台监控任务：定期增量拉取被监控频道的新媒体消息入库。
//!
//! 每个被监控频道维护一个 `sync_cursor`（已同步到的最大消息 id）。每轮同步：
//!   1. 读取该频道最近 `SYNC_LIMIT` 条媒体消息（新→旧）；
//!   2. 整窗口幂等 upsert 入库（v0.4.2：不只增量——重入库可回补旧行缺失的
//!      group_id/时长等新列，upsert 冲突时保留 downloaded/落盘路径）；
//!   3. 仅 `id > 游标` 的计入新增（added），并推进游标到本轮所见最大 id。
//!
//! 游标缺失（首次）视为 0，即首轮全量入库最近窗口。拉取窗口外的更早消息
//! 如需全量回溯，可后续扩展游标从底部向上增量；当前对「频道持续更新」场景足够。
//!
//! **单飞（BUG-102）**：本模块的触发源有三路（后台定时循环、前端 60s 轮询
//! `POST /api/tg/monitor/sync`、用户手动点击），可同时打向同一批频道。
//! [`sync_once`] 用原子门禁保证同一时刻至多一轮在跑，被挡下的一方立即返回
//! [`SyncOutcome::Skipped`]，不排队、不重复发起 Telegram RPC。

use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;

/// 每频道每轮增量同步拉取的最大**媒体**条数（增量窗口，受 messages clamp 上限 100 约束）。
const SYNC_LIMIT: u32 = 100;

/// 启动后台监控循环。调用方负责把 `state` 包成 `Arc` 传入共享。
pub fn spawn(state: Arc<AppState>) -> tokio::task::JoinHandle<()> {
    let interval = Duration::from_secs(state.config.monitor_interval_secs.max(10));
    tokio::spawn(async move {
        // 消耗首个立即 tick；之后按间隔周期同步。
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            match sync_once(&state).await {
                // 被单飞挡下：说明另一路（前端轮询/手动点击）正在跑，本轮跳过即可。
                // 这不是错误，不记日志——否则每 tick 一条会把环形日志刷满。
                Ok(SyncOutcome::Skipped) => {}
                Ok(SyncOutcome::Ran { added: n }) => {
                    if n > 0 {
                        state.push_log(format!("monitor tick: +{n} media"));
                    }
                }
                Err(e) => state.push_log(format!("monitor tick failed: {e}")),
            }
        }
    })
}

/// 单轮同步：遍历被监控频道，增量拉取新消息入库。返回本轮新增消息总数。
///
/// 也作为 `/api/tg/monitor/sync` 手动触发入口复用。
///
/// **单飞（BUG-102）**：本函数有**三个并发触发源**——后台定时循环（`spawn`，
/// 默认 30s）、前端 60s 轮询 `POST /api/tg/monitor/sync`、用户手动点击。
/// 三路可同时打向同一批频道，而一轮同步并不便宜（翻页扫描最多 600 条原始消息
/// 再加逐条串行 upsert），并发会让 Telegram RPC 预算被叠加消耗。
/// 故此处用「占位成功才执行」的原子门禁：**已有同步在跑时直接返回
/// [`SyncOutcome::Skipped`]，既不排队也不重复发起 RPC**。
pub async fn sync_once(state: &Arc<AppState>) -> Result<SyncOutcome, String> {
    // 抢不到名额 = 已有同步在跑。**立即**返回，绝不排队：排队等于把并发的
    // 额外轮次推迟到当前轮之后照样执行一遍，RPC 预算照旧叠加。
    let Some(_guard) = state.claim_sync() else {
        return Ok(SyncOutcome::Skipped);
    };
    Ok(SyncOutcome::Ran {
        added: run_sync_pass(state).await?,
    })
}

/// 单轮同步的结果（BUG-102）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOutcome {
    /// 本协程抢到名额并**真的跑了一轮**：`added` 为本轮新增条数。
    Ran { added: u64 },
    /// 已有同步在跑，本次调用被单飞挡下（**未发起任何 Telegram RPC**）。
    Skipped,
}

impl SyncOutcome {
    /// 本次调用是否真的执行了一轮同步（false = 被单飞挡下）。
    pub fn started(&self) -> bool {
        matches!(self, SyncOutcome::Ran { .. })
    }
}

/// 真正执行一轮同步（调用方**必须**已持有 [`crate::state::SyncGuard`]）。
///
/// 独立成函数，是为了让「单飞判定」与「同步本体」在代码上分开：任何新增触发源
/// 只要走 [`sync_once`] 就自动受单飞保护，而不会绕过门禁直接打到 Telegram。
async fn run_sync_pass(state: &Arc<AppState>) -> Result<u64, String> {
    let channels = state.store.list_channels().await.map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for ch in channels {
        let cursor = state
            .store
            .get_cursor(ch.channel_id)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        // messages 已在 client 层过滤为纯媒体（纯文本/服务消息不返回）。
        let items = state
            .client
            .messages(ch.channel_id, SYNC_LIMIT, None)
            .await
            .map_err(|e| e.to_string())?;

        let mut new_max = cursor;
        let mut added = 0u64;
        for it in items {
            // 整窗口幂等 upsert：旧行冲突时仅回补缺失列（含 group_id），不触碰 downloaded。
            state
                .store
                .upsert_message(
                    ch.channel_id,
                    it.id,
                    it.caption.as_deref(),
                    it.mime_type.as_deref(),
                    it.size,
                    it.media_type.as_deref(),
                    it.date,
                    it.duration,
                    it.group_id,

                    it.file_name.as_deref(),
                )
                .await
                .map_err(|e| e.to_string())?;
            if it.id > cursor {
                new_max = new_max.max(it.id);
                added += 1;
            }
        }
        if new_max > cursor {
            state
                .store
                .set_cursor(ch.channel_id, new_max)
                .await
                .map_err(|e| e.to_string())?;
            state.push_log(format!(
                "monitor {}(#{}) +{added} media (cursor {cursor} -> {new_max})",
                ch.title, ch.channel_id
            ));
            total += added;
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    //! BUG-102 的行为级测试。
    //!
    //! **这里刻意不断言「存在某个标志位」** —— 那是机制假设，断言它只会制造假绿：
    //! 一个永远返回 `true` 的常量也能满足「标志存在」。真正的判据是**可观测后果**：
    //! N 个并发触发源打进来，Telegram 侧只应看到**一轮** `messages()` 拉取。
    //!
    //! 故夹具 [`CountingClient`] 记录两件真事：
    //! 1. `messages_calls`：`client.messages(...)` 被真实调用的次数（= RPC 批次）；
    //! 2. `peak_inflight`：`messages()` 执行体内的**并发峰值**。
    //!
    //! 两者都由真实调用驱动，无法靠「加个标志位」蒙混过去：没有单飞时
    //! `peak_inflight` 会随触发源数线性上升、`messages_calls` 也会翻倍。

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::config::Config;
    use crate::login::{
        Channel, Client, ClientError, DownloadOutcome, Folder, LoginPhase, MediaItem, MediaRange,
        MediaStream, SessionView, Thumbnail,
    };
    use crate::state::Availability;
    use crate::store::Store;

    /// 频道 id（测试用合成值，与真实 TG id 无关）。
    const CH: i64 = -100_777;
    /// 合成媒体消息 id。
    const MSG_ID: i64 = 42;

    /// 计数客户端：记录真实 `messages()` 调用次数与执行体内的并发峰值。
    struct CountingClient {
        messages_calls: AtomicUsize,
        inflight: AtomicUsize,
        peak_inflight: AtomicUsize,
        /// 单次 `messages()` 的模拟耗时：让并发调用**确实有时间重叠**。
        ///
        /// 必须有它：若 `messages()` 立即返回，即使没有单飞，8 个调用也可能被
        /// tokio 串行跑完，峰值停在 1 —— 测试恒过，正是「制造假绿」。
        /// 夹住这段时间才能让「无单飞 ⇒ 并发进入」真正暴露出来。
        hold: Duration,
    }

    impl CountingClient {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                messages_calls: AtomicUsize::new(0),
                inflight: AtomicUsize::new(0),
                peak_inflight: AtomicUsize::new(0),
                hold: Duration::from_millis(200),
            })
        }

        fn messages_calls(&self) -> usize {
            self.messages_calls.load(Ordering::SeqCst)
        }

        fn peak_inflight(&self) -> usize {
            self.peak_inflight.load(Ordering::SeqCst)
        }

        /// 进出 `messages()` 执行体时更新峰值。
        fn enter(&self) -> InflightGuard<'_> {
            let now = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_inflight.fetch_max(now, Ordering::SeqCst);
            InflightGuard { owner: self }
        }
    }

    /// 退出 `messages()` 执行体时减计数（`Drop` 保证早返回也一定归还）。
    struct InflightGuard<'a> {
        owner: &'a CountingClient,
    }

    impl Drop for InflightGuard<'_> {
        fn drop(&mut self) {
            self.owner.inflight.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[async_trait::async_trait]
    impl Client for CountingClient {
        async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::CodeRequired)
        }
        async fn submit_code(&self, _phone: &str, _code: &str) -> Result<LoginPhase, ClientError> {
            Ok(LoginPhase::Authorized)
        }
        async fn submit_password(
            &self,
            _phone: &str,
            _password: &str,
        ) -> Result<LoginPhase, ClientError> {
            Err(ClientError::Other("no 2FA in test".into()))
        }
        async fn view(&self) -> SessionView {
            SessionView {
                phase: LoginPhase::Authorized,
                phone: None,
                user_id: None,
            }
        }
        async fn dialogs(&self) -> Result<Vec<Channel>, ClientError> {
            Ok(vec![Channel {
                id: CH,
                title: "Counting Channel".to_string(),
                username: Some("counting".to_string()),
                folder: None,
            }])
        }
        async fn folders(&self) -> Result<Vec<Folder>, ClientError> {
            Ok(Vec::new())
        }
        async fn messages(
            &self,
            _chat_id: i64,
            _limit: u32,
            _before_id: Option<i64>,
        ) -> Result<Vec<MediaItem>, ClientError> {
            self.messages_calls.fetch_add(1, Ordering::SeqCst);
            let _guard = self.enter();
            // 模拟一轮真实拉取的耗时（翻页扫描远慢于此，这里只要足够让并发重叠）。
            tokio::time::sleep(self.hold).await;
            Ok(vec![MediaItem {
                id: MSG_ID,
                caption: Some("BUG-102 fixture".to_string()),
                mime_type: Some("video/mp4".to_string()),
                size: Some(1024),
                media_type: Some("video".to_string()),
                file_name: None,
                date: Some(1_700_000_000),
                duration: Some(30),
                group_id: None,
                has_media: true,
            }])
        }
        async fn thumb(
            &self,
            _chat_id: i64,
            _message_id: i64,
        ) -> Result<Option<Thumbnail>, ClientError> {
            Ok(None)
        }
        async fn media(
            &self,
            _chat_id: i64,
            _message_id: i64,
            _range: Option<MediaRange>,
        ) -> Result<MediaStream, ClientError> {
            Err(ClientError::MediaNotFound)
        }
        async fn download(
            &self,
            _chat_id: i64,
            _message_id: i64,
            _dir: &str,
            _progress: Option<&crate::login::DownloadProgress>,
        ) -> Result<DownloadOutcome, ClientError> {
            Err(ClientError::MediaNotFound)
        }
        async fn message_meta(
            &self,
            _chat_id: i64,
            _message_id: i64,
        ) -> Result<Option<MediaItem>, ClientError> {
            Ok(None)
        }
    }

    /// 构造带一个监控频道的 state（内存库 + 计数客户端）。
    async fn state_with_client(client: Arc<CountingClient>) -> Arc<AppState> {
        let store = Store::open(":memory:").await.expect("in-memory store");
        store
            .add_channel(CH, "Counting Channel", Some("counting"))
            .await
            .expect("seed monitored channel");
        Arc::new(AppState::new(
            client,
            Config::default(),
            Availability::Ready,
            false,
            store,
        ))
    }

    /// **BUG-102 核心判据**：并发 N 个触发源 → Telegram 侧只发生**一轮**拉取。
    ///
    /// 模拟真实的三路并发（后台定时循环 + 前端轮询 + 手动点击）同时打向同一批频道。
    /// 断言的是**可观测后果**而非机制：
    /// - `started` 恰好一个为真（其余被单飞挡下）；
    /// - `client.messages()` 真实调用次数 == 1（**一个 RPC 批次**，不是 N 个）；
    /// - `messages()` 执行体内并发峰值为 1（**从未真正并发执行过两轮**）。
    #[tokio::test]
    async fn concurrent_triggers_coalesce_into_one_sync_run() {
        const N: usize = 8;
        let client = CountingClient::new();
        let st = state_with_client(client.clone()).await;

        let handles: Vec<_> = (0..N)
            .map(|_| {
                let st = st.clone();
                tokio::spawn(async move { sync_once(&st).await })
            })
            .collect();

        let mut started = 0usize;
        let mut skipped = 0usize;
        for h in handles {
            match h.await.expect("sync task must not panic") {
                Ok(SyncOutcome::Ran { .. }) => started += 1,
                Ok(SyncOutcome::Skipped) => skipped += 1,
                Err(e) => panic!("sync_once must not error: {e}"),
            }
        }

        assert_eq!(
            started,
            1,
            "N 个并发触发源必须只有一轮真正执行（BUG-102 单飞）"
        );
        assert_eq!(skipped, N - 1, "其余触发源应全部被单飞挡下");
        assert_eq!(
            client.messages_calls(),
            1,
            "Telegram 侧只应发生一个 RPC 批次 —— 实测 {} 次，说明预算仍在叠加",
            client.messages_calls()
        );
        assert_eq!(
            client.peak_inflight(),
            1,
            "两轮同步的执行体从未同时进入（实测峰值 {}）",
            client.peak_inflight()
        );

        // 反向证伪：单飞不得把同步**焊死** —— 挡下本轮后，下一轮必须照常跑。
        let after = sync_once(&st).await.expect("subsequent sync must run");
        assert!(
            after.started(),
            "并发轮结束后必须能再次同步 —— 否则单飞把功能永久禁用了"
        );
        assert_eq!(
            client.messages_calls(),
            2,
            "后续那一轮应当真的发起一次新的拉取"
        );
    }

    /// 被挡下的一方**立即**返回，且不发起 RPC（验收要点 1 的端点语义）。
    ///
    /// 「立即」用超时证明：若实现改成「排队等前一轮跑完」，本测试会超时失败。
    #[tokio::test]
    async fn a_coalesced_caller_returns_immediately_without_new_rpc() {
        let client = CountingClient::new();
        let st = state_with_client(client.clone()).await;

        // 手动占住名额，模拟「已有一轮在跑」。
        let held = st.claim_sync().expect("first claim must win");

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            sync_once(&st),
        )
        .await
        .expect("被单飞挡下的调用必须立即返回，不得排队等待")
        .expect("must not error");

        assert_eq!(
            outcome,
            SyncOutcome::Skipped,
            "已有同步在跑时必须返回 Skipped（started=false）"
        );
        assert!(
            !outcome.started(),
            "started 必须为 false，否则前端会把「被挡下」误读成「同步了但没新内容」"
        );
        assert_eq!(
            client.messages_calls(),
            0,
            "被挡下的调用不得发起任何 Telegram RPC"
        );

        drop(held);
    }

    /// 失败路径**不得**吞掉名额：同步出错后下一轮仍须能跑。
    ///
    /// 这是 RAII 守卫存在的理由 —— 若在函数末尾手写释放，任何一个 `?` 早返回
    /// 都会让名额**永久泄漏**，症状是「同步从此静默失效、TG 内容再也不更新」。
    #[tokio::test]
    async fn a_failing_sync_does_not_permanently_wedge_the_gate() {
        let store = Store::open(":memory:").await.expect("in-memory store");
        let st = Arc::new(AppState::new(
            // UnavailableClient：`messages()` 必失败 ⇒ `run_sync_pass` 走 `?` 早返回。
            Arc::new(crate::unavailable::UnavailableClient::new("test: forced failure")),
            Config::default(),
            Availability::Unavailable("test".to_string()),
            false,
            store,
        ));
        // 造一个监控频道，让循环真的进入 `messages()` 并失败。
        st.store
            .add_channel(CH, "Failing Channel", None)
            .await
            .expect("seed monitored channel");

        let first = sync_once(&st).await;
        assert!(
            first.is_err(),
            "夹具前提：不可用客户端下同步必须失败，否则本测试无意义"
        );
        assert!(
            !st.is_sync_running(),
            "同步失败后名额必须归还 —— 否则后续所有触发源全部空转且无任何报错"
        );
    }
}
