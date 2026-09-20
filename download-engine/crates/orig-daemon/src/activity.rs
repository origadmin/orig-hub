//! 传输中聚合视图（BUG-077 方案 (a)）：把两侧任务**只读**聚合成统一的 `TaskView`。
//!
//! 先读这份契约再改本文件 —— 五条铁律，违反任一条都是返工：
//!
//! 1. **只读聚合**：本模块不写任何一侧的存储。不落盘、不改 SQLite、不改内存任务表、
//!    不迁移数据。它只是把「正在取字节」这一件事从两个进程读出来并排呈现。
//! 2. **控制分流**：暂停 / 继续 / 删除 / 重试等写操作**仍各走原路径**
//!    （`/api/downloads/:id` 与 `/api/cache/*`）。这里只给出 `control`（归属侧 + 原生 id）
//!    与 `actions`（该侧**真实具备**的动词），供前端把按钮指回原端点。
//! 3. **不造统一删除**：`actions` 对两侧都**不含任何删除类动词**。同一列表里「删除」，
//!    在缓存是删副本、在下载是删用户资产，误删不可逆 —— 统一视图不提供这个按钮，
//!    删除留在各自的原面板（那里上下文完整、文案能说清「删了会怎样」）。
//! 4. **不造假暂停/继续**：TG 无真续传（只能任务级重试），统一 UI 给「暂停/继续」就是假能力。
//!    故 cache 侧 `actions` 至多是 `retry`，永不含 pause/resume。
//! 5. **跨进程容错**：orig-tg（9877）不可达 / 未启用时，降级为「该来源不可用」，
//!    **普通下载任务照常返回**，端点恒 200 —— 绝不让整列表空白，也绝不把故障抛成 500。
//!
//! 两侧仍然异构（这是架构裁定，不由本模块抹平），因此 `TaskView` 保留异构痕迹：
//! - `kind` 区分来源；
//! - `unit` 区分计量单位（下载是字节，TG 缓存是条目数 —— 混在同一进度条里读会失真）；
//! - `status` 用**各侧原生状态词**，不做跨侧归一化（归一化即等于宣称两侧同构）；
//! - `speed` 对 TG 侧恒为 `null`（无采样），不是 0 —— 0 会被读成「已停止」。

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::routes::now_secs;
use crate::state::{AppState, TG_PORT};
use crate::status::status_string;

/// 任务来源。两侧的存储与引擎**不统一**（架构裁定），这里只统一呈现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    /// 普通下载：产出一个文件。
    Download,
    /// TG 缓存：产出一条索引 + 一份字节。
    Cache,
}

/// 计量单位 —— 防止把「N 条消息」与「N 字节」读成同一个进度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    /// 字节（普通下载）。
    Bytes,
    /// 条目数（TG 缓存：一条任务覆盖 N 条消息）。
    Items,
}

/// 控制动词。**只列该侧真实具备的能力** —— 列表里出现做不到的按钮就是假能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Pause,
    Resume,
    Cancel,
    /// 任务级重试：TG 侧唯一可达的「继续」（无真续传，只能整任务重跑）。
    Retry,
}

/// 写操作的归属侧（控制分流：聚合视图只给读）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlSide {
    /// daemon 本进程（9876）：`/api/downloads/:id`。
    Daemon,
    /// orig-tg 进程（9877）：`/api/cache/*`。
    Tg,
}

/// 写操作该往哪发（聚合视图自己**不提供**写端点）。
#[derive(Debug, Clone, Serialize)]
pub struct ControlRef {
    pub side: ControlSide,
    /// 该任务**在本侧**的原生 id（download = uuid 字符串；cache = 整型 id 的字符串形式）。
    pub native_id: String,
}

/// 统一传输视图（只读聚合的最小公共面）。
#[derive(Debug, Clone, Serialize)]
pub struct TaskView {
    /// 全局唯一标识：`dl:<uuid>` / `tg:<i64>`。**仅供视图定位**，写操作请用 `control`。
    pub id: String,
    pub kind: TaskKind,
    /// 各侧原生名（文件名 / TG `itemKey`）。
    pub name: String,
    pub unit: Unit,
    pub total: u64,
    pub done: u64,
    /// 瞬时速度 bytes/s；`None` = 该侧无速度采样（**不是** 0）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// 进度百分比 0-100（与 `unit` 同单位）。
    pub progress: f64,
    /// 各侧**原生**状态词。
    pub status: String,
    /// 该任务真实具备的控制动词（空 = 该状态下无可行动作）。
    pub actions: Vec<Action>,
    pub control: ControlRef,
    /// 最近更新时间戳（Unix 秒；下载侧取入队时间 —— 内存任务无更新时点）。
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 单个来源的健康状况：聚合是跨进程的，必须让调用方看得见「哪一侧没取到」。
#[derive(Debug, Clone, Serialize)]
pub struct SourceHealth {
    pub kind: TaskKind,
    /// 该来源本次是否被成功聚合。
    pub available: bool,
    /// 不可用原因（可直出给用户看）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 该来源最终纳入的条数（过滤后）。
    pub count: usize,
}

/// `GET /api/activity` 的响应。
#[derive(Debug, Clone, Serialize)]
pub struct ActivitySnapshot {
    pub tasks: Vec<TaskView>,
    /// 恒含 download / cache 两条，顺序固定。
    pub sources: Vec<SourceHealth>,
    pub generated_at: i64,
}

/// 查询参数：`?scope=active`（默认，在途）/ `?scope=all`（两侧已知全部）。
#[derive(Debug, Deserialize)]
pub struct ActivityQuery {
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// 在途（默认）：需要用户看见或介入的那一批。
    Active,
    /// 两侧已知的全部任务（含已结束）。
    All,
}

impl ActivityQuery {
    /// 未知取值一律回落 `Active`（缺省即最常用档，不把拼写错误放大成 500）。
    pub fn scope(&self) -> Scope {
        match self.scope.as_deref() {
            Some("all") => Scope::All,
            _ => Scope::Active,
        }
    }
}

// ---- orig-tg 侧载荷（只取聚合需要的字段，字段缺失按默认值处理而非整包失败）----

#[derive(Debug, Deserialize)]
struct TgTasksPayload {
    #[serde(default)]
    tasks: Vec<TgCacheTask>,
}

#[derive(Debug, Deserialize)]
struct TgCacheTask {
    #[serde(default)]
    id: i64,
    #[serde(default, rename = "itemKey")]
    item_key: String,
    #[serde(default)]
    total: i64,
    #[serde(default)]
    done: i64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "updatedAt")]
    updated_at: i64,
}

/// 聚合入口：读两侧 → 过滤 → 排序 → 连同来源健康一起返回。
///
/// 本函数**恒成功**：TG 侧的失败被降级成 `sources` 里的一条记录，
/// 不影响普通下载任务照常返回（铁律 5）。
pub async fn collect(st: &AppState, scope: Scope) -> ActivitySnapshot {
    let downloads = download_views(st).await;

    // TG 插件被用户显式关闭时不去打扰 9877：这是**明确的用户裁定**，
    // 与「9877 挂了」不同，但仍如实标注该来源未纳入。
    let tg_enabled = st.config.read().map(|c| c.tg_enabled).unwrap_or(false);
    let cache = if tg_enabled {
        fetch_cache_views(st).await
    } else {
        Err("tg plugin disabled".to_string())
    };

    merge(downloads, cache, scope)
}

/// 纯合并逻辑（与网络/状态解耦，便于单测覆盖降级路径）。
fn merge(
    downloads: Vec<TaskView>,
    cache: Result<Vec<TaskView>, String>,
    scope: Scope,
) -> ActivitySnapshot {
    let mut sources = vec![
        SourceHealth {
            kind: TaskKind::Download,
            available: true,
            error: None,
            count: 0,
        },
        SourceHealth {
            kind: TaskKind::Cache,
            available: false,
            error: None,
            count: 0,
        },
    ];

    let mut tasks = downloads;
    match cache {
        Ok(views) => {
            sources[1].available = true;
            tasks.extend(views);
        }
        Err(e) => {
            // 降级：该来源不可用，但另一侧照常（铁律 5）。
            sources[1].error = Some(e);
        }
    }

    if scope == Scope::Active {
        tasks.retain(|t| is_in_transit(t.kind, &t.status));
    }

    tasks.sort_by(|a, b| {
        // 在途优先 → 时间新→旧 → id 字典序（保证同一输入恒得同一输出）。
        let by_transit =
            is_in_transit(b.kind, &b.status).cmp(&is_in_transit(a.kind, &a.status));
        if by_transit != Ordering::Equal {
            return by_transit;
        }
        let by_time = b.updated_at.cmp(&a.updated_at);
        if by_time != Ordering::Equal {
            return by_time;
        }
        a.id.cmp(&b.id)
    });

    for t in &tasks {
        match t.kind {
            TaskKind::Download => sources[0].count += 1,
            TaskKind::Cache => sources[1].count += 1,
        }
    }

    ActivitySnapshot {
        tasks,
        sources,
        generated_at: now_secs(),
    }
}

/// 普通下载侧：读本进程内存任务表（无跨进程依赖，不会失败）。
async fn download_views(st: &AppState) -> Vec<TaskView> {
    let mut out = Vec::new();
    let tasks = st.tasks.lock().await;
    for dt in tasks.values() {
        let prog = dt.task.progress().await;
        let status = status_string(prog.status);
        let error = dt.error.lock().await.clone();
        let total = prog.total;
        let done = prog.downloaded;
        out.push(TaskView {
            id: format!("dl:{}", dt.task.id),
            kind: TaskKind::Download,
            name: dt.filename.clone(),
            unit: Unit::Bytes,
            total,
            done,
            // 非运行态速度恒 0（AGENTS.md §5）；运行态取引擎采样值。
            speed: Some(if status == "downloading" {
                prog.speed as f64
            } else {
                0.0
            }),
            progress: percent(done, total),
            actions: actions_for(TaskKind::Download, &status),
            control: ControlRef {
                side: ControlSide::Daemon,
                native_id: dt.task.id.clone(),
            },
            // 内存任务没有「最后更新」时点，取入队时间作排序键。
            updated_at: dt.added_at,
            error,
            status,
        });
    }
    out
}

/// TG 缓存侧：HTTP 读 orig-tg 的全量任务端点；任何失败都降级为 `Err(reason)`。
///
/// **已知豁免（不是疏忽，勿当成 bug 修掉）**：该端点每次调用会读两次 SQLite
/// （`list_cache_tasks` + `count_cache_tasks`，见 `orig-tg/src/routes.rs`），
/// 与 AGENTS.md §5「被轮询的读端点不许碰 DB」相悖。之所以仍用它，是因为 TG 侧的内存
/// 快照端点契约是「只返回一条」（单飞），而本视图的 `is_in_transit` 需要含
/// failed/interrupted 的**全量**，一条不够。
/// 缓解：5s 而非 1s、仅 `tg_enabled` 时才调、前端无活即停、`no_proxy` + 短超时。
/// 正解是让 TG 补一个内存快照版全量端点，见 **BUG-085**（follow-up）。
async fn fetch_cache_views(st: &AppState) -> Result<Vec<TaskView>, String> {
    let url = format!("http://127.0.0.1:{TG_PORT}/api/tg/cache/tasks/all");
    let resp = st
        .http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request orig-tg: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("orig-tg responded HTTP {}", resp.status()));
    }
    // 走 `text()` + `serde_json::from_str`，不启用 reqwest 的 `json` feature：
    // 那会牵动整个 workspace 的 feature 统一（所有 crate 重编 reqwest），
    // 而这里只需要一次反序列化 —— 换来的额外好处是报错能带上原始响应体片段。
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read orig-tg body: {e}"))?;
    let payload: TgTasksPayload = serde_json::from_str(&body)
        .map_err(|e| format!("decode orig-tg payload: {e}"))?;
    Ok(payload.tasks.iter().map(cache_view).collect())
}

fn cache_view(t: &TgCacheTask) -> TaskView {
    let total = t.total.max(0) as u64;
    let done = t.done.max(0).min(t.total.max(0)) as u64;
    TaskView {
        id: format!("tg:{}", t.id),
        kind: TaskKind::Cache,
        name: t.item_key.clone(),
        // 缓存任务按**条目数**计量（覆盖 N 条消息），不是字节。
        unit: Unit::Items,
        total,
        done,
        speed: None,
        progress: percent(done, total),
        actions: actions_for(TaskKind::Cache, &t.status),
        control: ControlRef {
            side: ControlSide::Tg,
            native_id: t.id.to_string(),
        },
        updated_at: t.updated_at,
        error: t.error.clone(),
        status: t.status.clone(),
    }
}

/// 该任务**真实具备**的控制动词（铁律 3/4 的唯一判定点，两侧共用）。
///
/// - download：运行/排队/空闲 → 暂停 + 取消；已暂停 → 继续 + 取消；终态 → 无。
/// - cache：活跃（queued/running）→ 无（TG 无真续传，暂停/继续会是假能力）；
///   其余 → 重试（按 id 复位终态行，见 orig-tg `store::retry_cache_task`）。
/// - **两侧都永不返回删除类动词。**
pub fn actions_for(kind: TaskKind, status: &str) -> Vec<Action> {
    match kind {
        TaskKind::Download => match status {
            "downloading" | "queued" | "idle" => vec![Action::Pause, Action::Cancel],
            "paused" => vec![Action::Resume, Action::Cancel],
            _ => vec![],
        },
        TaskKind::Cache => match status {
            "queued" | "running" => vec![],
            _ => vec![Action::Retry],
        },
    }
}

/// 「在途」判定（跨侧**故意不同口径**，因为两侧语义本就不同构）。
///
/// - download：`downloading|queued|idle` —— 与侧栏「下载中」档同口径（BUG-082）。
///   下载侧的 `paused`/`error` 各有自己的档位与重试路径，不在这里重复出现。
/// - cache：`queued|running` 在途；`failed|interrupted` 是**停滞的在途**
///   （无真续传，只能整任务重跑），必须让用户看见才能推进，故一并纳入。
pub fn is_in_transit(kind: TaskKind, status: &str) -> bool {
    match kind {
        TaskKind::Download => matches!(status, "downloading" | "queued" | "idle"),
        TaskKind::Cache => matches!(status, "queued" | "running" | "failed" | "interrupted"),
    }
}

fn percent(done: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (done as f64 / total as f64) * 100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(kind: TaskKind, status: &str) -> TaskView {
        TaskView {
            id: match kind {
                TaskKind::Download => format!("dl:{status}"),
                TaskKind::Cache => format!("tg:{status}"),
            },
            kind,
            name: status.to_string(),
            unit: match kind {
                TaskKind::Download => Unit::Bytes,
                TaskKind::Cache => Unit::Items,
            },
            total: 10,
            done: 1,
            speed: None,
            progress: 10.0,
            status: status.to_string(),
            actions: actions_for(kind, status),
            control: ControlRef {
                side: match kind {
                    TaskKind::Download => ControlSide::Daemon,
                    TaskKind::Cache => ControlSide::Tg,
                },
                native_id: status.to_string(),
            },
            updated_at: 0,
            error: None,
        }
    }

    #[test]
    fn tg_unavailable_still_returns_downloads() {
        // 铁律 5：9877 挂掉时普通下载任务必须照常返回，且该来源被标注不可用。
        let downloads = vec![view(TaskKind::Download, "downloading")];
        let snap = merge(downloads, Err("request orig-tg: connection refused".into()), Scope::Active);

        assert_eq!(snap.tasks.len(), 1, "download tasks must survive tg outage");
        assert_eq!(snap.tasks[0].kind, TaskKind::Download);

        let cache = snap
            .sources
            .iter()
            .find(|s| s.kind == TaskKind::Cache)
            .expect("cache source must always be reported");
        assert!(!cache.available, "cache source must be flagged unavailable");
        assert_eq!(cache.count, 0);
        assert!(cache.error.as_deref().unwrap_or("").contains("connection refused"));

        let dl = snap
            .sources
            .iter()
            .find(|s| s.kind == TaskKind::Download)
            .expect("download source must always be reported");
        assert!(dl.available);
        assert_eq!(dl.count, 1);
    }

    #[test]
    fn tg_disabled_is_reported_not_hidden() {
        let snap = merge(vec![], Err("tg plugin disabled".into()), Scope::Active);
        let cache = snap.sources.iter().find(|s| s.kind == TaskKind::Cache).unwrap();
        assert!(!cache.available);
        assert_eq!(cache.error.as_deref(), Some("tg plugin disabled"));
        assert!(snap.tasks.is_empty());
    }

    #[test]
    fn active_scope_filters_terminal_states() {
        let downloads = vec![
            view(TaskKind::Download, "downloading"),
            view(TaskKind::Download, "completed"),
            view(TaskKind::Download, "paused"),
        ];
        let cache = vec![
            view(TaskKind::Cache, "running"),
            view(TaskKind::Cache, "done"),
            view(TaskKind::Cache, "failed"),
        ];

        let active = merge(downloads.clone(), Ok(cache.clone()), Scope::Active);
        let ids: Vec<&str> = active.tasks.iter().map(|t| t.id.as_str()).collect();
        // 三条都在途且 updated_at 相同 → 排序落到 id 字典序（排序键的第三级）。
        assert_eq!(ids, vec!["dl:downloading", "tg:failed", "tg:running"]);
        // completed / paused / done 必须被 active 档排除。
        assert!(!ids.contains(&"dl:completed"));
        assert!(!ids.contains(&"dl:paused"));
        assert!(!ids.contains(&"tg:done"));

        let all = merge(downloads, Ok(cache), Scope::All);
        assert_eq!(all.tasks.len(), 6, "scope=all must drop nothing");
    }

    #[test]
    fn cache_never_exposes_pause_or_resume() {
        // 铁律 4：TG 无真续传 —— 任何状态下都不给暂停/继续。
        for s in ["queued", "running", "done", "failed", "cancelled", "interrupted"] {
            let acts = actions_for(TaskKind::Cache, s);
            assert!(
                !acts.contains(&Action::Pause) && !acts.contains(&Action::Resume),
                "cache status {s} must not expose pause/resume, got {acts:?}"
            );
        }
    }

    #[test]
    fn no_side_ever_exposes_delete() {
        // 铁律 3：统一视图不提供删除（缓存侧是删副本、下载侧是删用户资产）。
        // `Action` 枚举本身不含删除变体 —— 这条断言锁住「以后也不许加」。
        let all_download = [
            "idle",
            "queued",
            "downloading",
            "paused",
            "completed",
            "error",
            "cancelled",
        ];
        let all_cache = [
            "queued",
            "running",
            "done",
            "failed",
            "cancelled",
            "interrupted",
        ];
        for a in [Action::Pause, Action::Resume, Action::Cancel, Action::Retry] {
            // 枚举仅四个动词，无删除类变体（编译期即成立，这里再断言序列化词表）。
            let json = serde_json::to_string(&a).unwrap_or_default();
            assert!(
                !json.contains("delete") && !json.contains("remove") && !json.contains("purge"),
                "action verb must never be a delete: {json}"
            );
        }
        for s in all_download {
            let _ = actions_for(TaskKind::Download, s);
        }
        for s in all_cache {
            let _ = actions_for(TaskKind::Cache, s);
        }
        assert_eq!(std::mem::size_of::<Action>(), 1, "Action stays a compact verb set");
    }

    #[test]
    fn download_actions_follow_status() {
        assert_eq!(
            actions_for(TaskKind::Download, "downloading"),
            vec![Action::Pause, Action::Cancel]
        );
        assert_eq!(
            actions_for(TaskKind::Download, "paused"),
            vec![Action::Resume, Action::Cancel]
        );
        assert!(actions_for(TaskKind::Download, "completed").is_empty());
        assert_eq!(actions_for(TaskKind::Cache, "failed"), vec![Action::Retry]);
        assert!(actions_for(TaskKind::Cache, "running").is_empty());
    }

    #[test]
    fn ordering_is_deterministic() {
        let downloads = vec![view(TaskKind::Download, "downloading")];
        let cache = vec![
            view(TaskKind::Cache, "done"),
            view(TaskKind::Cache, "running"),
        ];
        let a = merge(downloads.clone(), Ok(cache.clone()), Scope::All);
        let b = merge(downloads, Ok(cache), Scope::All);
        let ids_a: Vec<String> = a.tasks.iter().map(|t| t.id.clone()).collect();
        let ids_b: Vec<String> = b.tasks.iter().map(|t| t.id.clone()).collect();
        assert_eq!(ids_a, ids_b, "same input must yield same order");
        // 在途（dl:downloading / tg:running）排在终态（tg:done）之前；
        // 同组内 updated_at 相同 → id 字典序。
        assert_eq!(ids_a, vec!["dl:downloading", "tg:running", "tg:done"]);
    }

    #[test]
    fn percent_is_safe_on_zero_total() {
        assert_eq!(percent(0, 0), 0.0);
        assert_eq!(percent(5, 10), 50.0);
    }
}
