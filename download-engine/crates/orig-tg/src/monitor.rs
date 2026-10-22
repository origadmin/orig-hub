//! 后台监控任务：定期增量拉取被监控频道的新媒体消息入库。
//!
//! 每个被监控频道维护一个 `sync_cursor`（已同步到的最大消息 id）。每轮同步：
//!   1. 读取该频道最近 `SYNC_LIMIT` 条媒体消息（新→旧）；
//!   2. 整窗口幂等 upsert 入库（v0.4.2：不只增量——重入库可回补旧行缺失的
//!      group_id/时长等新列，upsert 冲突时保留 downloaded/落盘路径）；
//!   3. 仅 `id > 游标` 的计入新增（added），并推进游标到本轮所见最大 id。
//!
//! 游标缺失（首次）视为 0，即首轮全量入库最近窗口。
//!
//! # 历史回溯（2026-10-22 用户第 2 点）
//!
//! 增量同步**只向新**，所以「频道数据只会加载一部分」是结构性边界，不是缺陷：
//! `messages(limit, None)` 永远只看最新 100 条，`sync_cursor` 也只记最大值。
//! 用户要按筛选下载就必须能覆盖更早的消息，于是另加一条**向旧**的腿：
//!
//!   - `sync_cursor.backfill_until`：目标日期（unix 秒，0 = 不回溯）；
//!   - `sync_cursor.backfill_before_id`：向旧翻页的游标（0 = 未开始）。
//!
//! [`run_backfill_pass`] **每轮每频道只翻一页**：回溯是长跑，把 RPC 摊到多个
//! tick 上，避免「点一下回溯三个月」瞬间打出上百个请求触发 flood-wait。
//! 两条腿共用同一把单飞门禁（[`sync_once`] / [`backfill_once`] 都走
//! `claim_sync`）——它们打的是同一个账号的同一个 RPC 预算，不能并行。
//!
//! 回溯**必须由用户明确指定日期**才启动（`Store::set_backfill`），升级不自动开始：
//! 否则会在用户毫无察觉的情况下塞进几十轮 RPC 和一堆他并不想要的历史数据。
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

/// 历史回溯每轮每频道拉取的条数。
///
/// 与增量窗口同量级（都受 `messages` clamp 上限 100 约束）。回溯是**慢**的：
/// 一轮只翻一页，把 RPC 摊到多个 tick 上，避免「用户点一下回溯三个月」瞬间
/// 打出上百个请求把账号打成 flood-wait。
const BACKFILL_LIMIT: u32 = 100;

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
            // 回溯排在增量**之后**（优先级更低）：新消息先入库，历史慢慢补。
            // 被挡下（Skipped）同样静默——那是「这一轮名额被别人用了」，不是失败。
            match backfill_once(&state).await {
                Ok(BackfillOutcome::Skipped) => {}
                Ok(BackfillOutcome::Ran { stored, done }) => {
                    if stored > 0 {
                        state.push_log(format!(
                            "monitor backfill: +{stored} media, {done} channel(s) finished"
                        ));
                    }
                }
                Err(e) => state.push_log(format!("monitor backfill failed: {e}")),
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

/// 单轮回溯的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackfillOutcome {
    /// 真的跑了一轮：`stored` = 本轮入库条数，`done` = 本轮走到终点的频道数。
    Ran { stored: u64, done: u64 },
    /// 已有同步/回溯在跑，本次被单飞挡下（**未发起任何 Telegram RPC**）。
    Skipped,
}

/// 单轮回溯：每个待回溯频道最多向旧翻**一页**。
///
/// 与 [`sync_once`] 共用同一把单飞门禁：两条腿打的是同一个账号的同一份
/// RPC 预算，并行只会更快触发 flood-wait。
pub async fn backfill_once(state: &Arc<AppState>) -> Result<BackfillOutcome, String> {
    let Some(_guard) = state.claim_sync() else {
        return Ok(BackfillOutcome::Skipped);
    };
    let (stored, done) = run_backfill_pass(state).await?;
    Ok(BackfillOutcome::Ran { stored, done })
}

/// 真正执行一轮回溯（调用方**必须**已持有 [`crate::state::SyncGuard`]）。
///
/// 每个频道每轮只翻一页，四类终点都会 `clear_backfill`：
/// 1. 拉不到更多消息（频道最早一条已入库）；
/// 2. 本页最旧一条的日期已早于目标日期；
/// 3. 游标没有向旧推进（`min_id >= before`）——这是**死循环防护**，
///    不是「慢」：继续跑只会把 RPC 预算烧在一个不动的窗口上；
/// 4. 用户主动取消（`DELETE /api/tg/monitor/backfill/:id`）。
async fn run_backfill_pass(state: &Arc<AppState>) -> Result<(u64, u64), String> {
    let pending = state
        .store
        .list_backfill_pending()
        .await
        .map_err(|e| e.to_string())?;
    let (mut stored, mut done) = (0u64, 0u64);
    for channel_id in pending {
        let (saved_before, until_ts) = state
            .store
            .get_backfill(channel_id)
            .await
            .map_err(|e| e.to_string())?;
        if until_ts <= 0 {
            continue;
        }
        // 起点：本轮第一次跑时取「已同步到的最新 id」，从它下面开始向旧翻。
        // 从没同步过就传 None —— `messages` 会从最新一页开始，方向仍是新→旧，
        // 只是起点由 Telegram 决定（等价于「先补最近一页，再一路往回」）。
        let before = if saved_before > 0 {
            Some(saved_before)
        } else {
            state
                .store
                .get_cursor(channel_id)
                .await
                .map_err(|e| e.to_string())?
                .filter(|c| *c > 0)
        };
        let items = state
            .client
            .messages(channel_id, BACKFILL_LIMIT, before)
            .await
            .map_err(|e| e.to_string())?;
        if items.is_empty() {
            state
                .store
                .clear_backfill(channel_id)
                .await
                .map_err(|e| e.to_string())?;
            state.push_log(format!(
                "backfill #{channel_id}: reached the oldest media message, done"
            ));
            done += 1;
            continue;
        }
        let page_len = items.len() as u64;
        let mut min_id = i64::MAX;
        let mut min_date = i64::MAX;
        for it in items {
            // 与增量同步同一条 upsert：冲突时只回补缺失列，不碰 downloaded。
            state
                .store
                .upsert_message(
                    channel_id,
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
            min_id = min_id.min(it.id);
            if let Some(d) = it.date {
                min_date = min_date.min(d);
            }
        }
        stored += page_len;
        if min_date != i64::MAX && min_date < until_ts {
            state
                .store
                .clear_backfill(channel_id)
                .await
                .map_err(|e| e.to_string())?;
            state.push_log(format!(
                "backfill #{channel_id}: reached target date (+{page_len} media), done"
            ));
            done += 1;
            continue;
        }
        if let Some(b) = before {
            if min_id >= b {
                state
                    .store
                    .clear_backfill(channel_id)
                    .await
                    .map_err(|e| e.to_string())?;
                state.push_log(format!(
                    "backfill #{channel_id}: cursor did not move (min_id {min_id} >= before {b}), stopped"
                ));
                done += 1;
                continue;
            }
        }
        state
            .store
            .advance_backfill(channel_id, min_id)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok((stored, done))
}

/// `YYYY-MM-DD` → 该日 **UTC** 00:00 的 unix 秒；非法输入返回 `None`。
///
/// 为什么用 UTC 而不是本地时区：回溯边界差几个小时对「补历史」没有影响，
/// 而引入时区就要处理夏令时（还要多一个依赖）。契约写死 UTC，
/// 前端按同一口径显示与回填（`input[type=date]` 的值本身就是日期，不含时区）。
pub fn parse_date_utc(s: &str) -> Option<i64> {
    let s = s.trim();
    let mut parts = s.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1970 {
        return None;
    }
    // 拒绝 2 月 31 日这类「数字合法、日期不存在」的输入：溢出到下个月会被
    // 用户读成「我明明填了 2-31，怎么从 3 月 3 号开始回溯」。
    let days = days_from_civil(y, m, d);
    if civil_from_days(days) != (y, m, d) {
        return None;
    }
    Some(days * 86_400)
}

/// 公历日期 → 距 1970-01-01 的天数（Howard Hinnant `days_from_civil`）。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// `days_from_civil` 的逆运算（仅用于校验日期真实存在）。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
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

/// 历史回溯的日期解析判据（2026-10-22 用户第 2 点）。
///
/// 只测**纯函数**：`run_backfill_pass` 的行为由 `sync_cursor` 的字段语义
/// 决定，而"日期怎么变成秒"是最容易悄悄错一天的地方（闰年、时区、非法日期），
/// 也是用户唯一会亲手输入的参数。
#[cfg(test)]
mod backfill_date_tests {
    use super::*;

    /// 已知日期的绝对值断言：**不是**用被测函数自己算期望值（那是自证循环）。
    /// 期望值由独立实现给出（`datetime.date(2026,10,22) - date(1970,1,1)`）。
    #[test]
    fn parse_date_utc_maps_known_dates() {
        assert_eq!(parse_date_utc("1970-01-01"), Some(0), "epoch 当天必须是 0");
        assert_eq!(parse_date_utc("1970-01-02"), Some(86_400), "次日 = 86400");
        assert_eq!(
            parse_date_utc("2024-02-29"),
            Some(1_709_164_800),
            "闰日必须算进去（2024 是闰年）"
        );
        assert_eq!(parse_date_utc("2026-10-22"), Some(1_792_627_200));
        // 首尾空白来自 `<input type=date>` 之外的粘贴输入，容忍但不改变语义。
        assert_eq!(parse_date_utc("  2026-10-22  "), Some(1_792_627_200));
    }

    #[test]
    fn parse_date_utc_rejects_garbage_and_impossible_dates() {
        for bad in [
            "",
            "2026",
            "2026-10",
            "2026-13-01",       // 月份越界
            "2026-02-31",       // 数字合法、日期不存在（不许溢出到 3 月）
            "2025-02-29",       // 平年没有 2-29
            "1969-12-31",       // 早于 epoch
            "2026-10-22T00:00", // 带时间：契约只收日期
            "x-y-z",
        ] {
            assert_eq!(parse_date_utc(bad), None, "必须拒绝 {bad:?}");
        }
    }

    /// 反向证伪：把日期判据的"存在性校验"去掉，`2026-02-31` 必须能被抓出来。
    ///
    /// 这条不是重复测试，它证明上一条有牙齿 —— 如果 `days_from_civil` /
    /// `civil_from_days` 的往返校验被删掉，`2026-02-31` 会静默变成 `2026-03-03`。
    #[test]
    fn days_from_civil_roundtrip_detects_overflow() {
        // 2 月 31 日算出来的天数，反解回来一定是 3 月 3 日 ⇒ 不相等 ⇒ 被拒。
        let days = days_from_civil(2026, 2, 31);
        assert_ne!(
            civil_from_days(days),
            (2026, 2, 31),
            "非法日期反解必须与原输入不同，否则存在性校验形同虚设"
        );
        // 合法日期必须逐字往返（否则所有合法输入都会被误拒）。
        for (y, m, d) in [(1970, 1, 1), (2024, 2, 29), (2026, 10, 22), (1999, 12, 31)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
    }
}
