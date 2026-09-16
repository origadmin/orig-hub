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
                Ok(n) => {
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
pub async fn sync_once(state: &Arc<AppState>) -> Result<u64, String> {
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
