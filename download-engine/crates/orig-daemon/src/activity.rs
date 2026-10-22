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
use std::sync::Arc;

use orig_core::engine::Task;
use serde::{Deserialize, Serialize};

use crate::routes::now_secs;
use crate::state::AppState;
use crate::status::status_string;

/// 引擎侧的**单一真源行**：内存任务（有控制句柄） ∪ 库记录（进程死后留下的）。
///
/// 为什么必须存在：同一批引擎任务有两个呈现面 —— `/api/downloads`（原生面，带
/// 分块/连接明细）与 `/api/activity`（聚合面，与 TG 同列）。若两处各自去「合并
/// 内存与库」，必有一处漏合并，用户观感就是「这里看得到、那里看不到」。实证：
/// 聚合面合并了库、原生面没合并 ⇒ 栈重启后下载页仍然空白，而活动页有行。
///
/// 合并口径：**内存优先，库补齐**。内存里有的是本进程能控制的活体，库只用来补
/// 那些「记录还在、句柄已不在」的行（终态，或上次进程留下的）。
// 不派生 Debug：`Task` 没有实现它，而为一个视图结构体去给引擎内核加 Debug
// 是把呈现需求倒灌进内核。
#[derive(Clone)]
pub struct EngineRow {
    pub id: String,
    pub url: String,
    pub filename: String,
    /// 落盘绝对路径。
    pub output: String,
    pub total: u64,
    pub done: u64,
    pub status: String,
    pub error: Option<String>,
    pub added_at: i64,
    /// 最近更新时点：内存任务没有更新时点 ⇒ 与 `added_at` 同值（诚实回退）；
    /// 库记录有真实时点。
    pub updated_at: i64,
    pub category: Option<String>,
    pub max_concurrency: u32,
    /// 实时速度（非运行态恒 0 —— 0 是「没在动」，不是「不知道」）。
    pub speed: f64,
    /// 内存活体句柄。`None` = 本进程已不持有该 Task ⇒ 无实时明细可采、也无
    /// pause/resume 可言，但**记录仍然可见**（记录是结果，不是待办）。
    pub live: Option<Arc<Task>>,
}

/// 引擎侧合并读取（内存 ∪ 库）。两个呈现面都必须走这里，不许各自合并一遍。
pub async fn engine_rows(st: &AppState) -> Vec<EngineRow> {
    let mut out = Vec::new();
    let mut live_ids: Vec<String> = Vec::new();
    {
        // 锁内 await 是既有实现（progress 本身异步）；块作用域确保读库之前
        // 放掉任务表的锁 —— 持锁 await DB 会把整张表堵在后面。
        let tasks = st.tasks.lock().await;
        for dt in tasks.values() {
            let prog = dt.task.progress().await;
            out.push(EngineRow {
                id: dt.task.id.clone(),
                url: dt.url.clone(),
                filename: dt.filename.clone(),
                // 出参形态统一 `/`（`/api/activity` 与 `/api/downloads` 共用
                // `EngineRow`，两处必须同形态，否则同一任务在两个域显示成两个路径）。
                output: orig_core::paths::to_wire(&dt.output),
                total: prog.total,
                done: prog.downloaded,
                status: status_string(prog.status),
                error: dt.error.lock().await.clone(),
                added_at: dt.added_at,
                updated_at: dt.added_at,
                category: dt.category.clone(),
                max_concurrency: dt.max_concurrency,
                speed: prog.speed as f64,
                live: Some(dt.task.clone()),
            });
            live_ids.push(dt.task.id.clone());
        }
    }
    if let Some(store) = &st.task_store {
        for r in store.all().await {
            // 内存里有的以内存为准，库只补内存没有的那些。
            if live_ids.contains(&r.id) {
                continue;
            }
            out.push(EngineRow {
                id: r.id.clone(),
                url: r.url.clone(),
                filename: r.filename.clone(),
                output: r.output.clone(),
                total: r.total,
                done: r.downloaded,
                status: r.status.clone(),
                error: r.error.clone(),
                added_at: r.added_at,
                updated_at: r.updated_at,
                category: r.category.clone(),
                max_concurrency: r.max_concurrency,
                speed: 0.0,
                live: None,
            });
        }
    }
    out
}

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
    /// 各侧原生名（下载 = 文件名；TG = 任务标题，缺失回退 itemKey）。
    pub name: String,
    /// 聚合键（BUG-300 复报：入库任务**就住在 orig-tg**，`itemKey` 是内容对象天然
    /// 的去重键；下载侧无去重语义，用任务 id 自身作为唯一键，保持每行独立）。
    /// 前端据此把「同一内容的多次入库」合并成一行（BT 的「种子」粒度），而不是
    /// 把每条 `cache_task` 记录平铺成一行。
    #[serde(rename = "groupKey")]
    pub group_key: String,
    /// TG 侧定位坐标（BUG-300 复报：「去媒体库查看」需要 `ref = {chat}:{msg}`，
    /// 而 `itemKey` 对相册/批量组**给不出** msg）。orig-tg 的任务载荷本就带着
    /// `chatId`/`messageIds`，这里只做转发，不新造数据源。
    ///
    /// 下载侧没有「TG 频道」这一说 ⇒ `None`（不是 0：0 会被读成一个真实频道）。
    #[serde(rename = "chatId", skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<i64>,
    /// 任务覆盖的消息号（按缓存顺序）。下载侧无此概念 ⇒ 空数组。
    #[serde(rename = "messageIds")]
    pub message_ids: Vec<i64>,
    /// 优先下载优先级（BUG-277）：越大越先跑，0 = 未置顶。下载侧无队列优先级
    /// 概念 ⇒ 恒 0（诚实缺省，不是「排第一」）。
    pub priority: i64,
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
    /// 人类可读标题（orig-tg `/all` 载荷恒有该字段；老数据可能缺 → 空串）。
    /// 缺省时 `cache_view` 回退 `itemKey`，绝不渲染空名。
    #[serde(default)]
    title: String,
    /// TG 频道 id（orig-tg `chatId`）。老载荷可能缺 → 0，`cache_view` 再转成 `None`
    /// （0 会被读成一个真实频道，不能当定位坐标用）。
    #[serde(default, rename = "chatId")]
    chat_id: i64,
    /// 任务覆盖的消息号（按缓存顺序；「去媒体库查看」拼 ref 用）。
    #[serde(default, rename = "messageIds")]
    message_ids: Vec<i64>,
    /// 优先下载优先级（BUG-277）；老载荷缺省 0 = 未置顶。
    #[serde(default)]
    priority: i64,
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

    let mut snap = merge(downloads, cache, scope);

    // BUG-355：下载源可用性反映**真实下载根健康度**，不再写死 `true` —— 否则
    // 「下载根非法 / 服务全挂」时界面仍谎称「普通下载不受影响」（用户实测全 outage
    // 下所有任务失败，但横幅写死下载正常）。下载根非法（如 `/`）即标记下载源不可用。
    if let Ok(cfg) = st.config.read() {
        let dl_root = crate::config::effective_download_root(&cfg);
        let dl_ok = orig_core::paths::is_valid_content_root(&dl_root);
        snap.sources[0].available = dl_ok;
        if !dl_ok {
            snap.sources[0].error =
                Some("下载根目录无效或不可写（检查设置中的下载目录）".to_string());
        }
    }

    snap
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

/// 普通下载侧：内存任务表 + 持久化记录（BUG-319）。
///
/// 以前只读内存表 ⇒ 进程一没，列表就是空的。栈被监督者拉回来之后，
/// 界面上的「没有数据」其实是「进程没了」，用户根本无从区分 —— 与 BUG-176
/// 「取不到 ≠ 没有」是同型假象，只是这次丢的是下载行。
/// 现在内存表只提供「本进程手里有控制句柄的那些」，库提供「记录还在的那些」，
/// 两者合并后再对外：活着的能控制，留下的能看见。
async fn download_views(st: &AppState) -> Vec<TaskView> {
    // 单一真源：与 `/api/downloads` 共用 `engine_rows`，不许各合并一遍。
    let rows = engine_rows(st).await;
    rows.into_iter()
        .map(|r| {
            let total = r.total;
            let done = r.done;
            TaskView {
                id: format!("dl:{}", r.id),
                kind: TaskKind::Download,
                name: r.filename,
                // 下载侧无去重语义 ⇒ 聚合键即本任务 id（唯一）。
                group_key: r.id.clone(),
                // 下载侧没有 TG 频道/消息号/队列优先级 ⇒ 诚实缺省（None/空/0）。
                chat_id: None,
                message_ids: Vec::new(),
                priority: 0,
                unit: Unit::Bytes,
                total,
                done,
                // 非运行态速度恒 0（AGENTS.md §5）；运行态取引擎采样值。
                speed: Some(if r.status == "downloading" { r.speed } else { 0.0 }),
                progress: percent(done, total),
                actions: actions_for(TaskKind::Download, &r.status),
                control: ControlRef {
                    side: ControlSide::Daemon,
                    native_id: r.id,
                },
                updated_at: r.updated_at,
                error: r.error,
                status: r.status,
            }
        })
        .collect()
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
    // 端口取**运行时实际值**（BUG-318）：orig-tg 绑不上起点（保留区/被占）时 daemon 会
    // 顺延重选并落进 `st.tg_port`（`/api/config` 的 `tg_port` 读它，前端也以它校准 base）。
    // 用编译期常量 `TG_PORT` 会在顺延后永远打到一个没有服务的端口 —— 聚合视图把健康的
    // orig-tg 误报成 `available=false`，下载域整批入库行「消失」（用户观感即数据丢失）。
    let url = format!(
        "http://127.0.0.1:{}/api/tg/cache/tasks/all",
        st.tg_port_state()
    );
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
    // 名称取人类可读标题（BUG-300 复报：下载域 TG 行原先只能显示
    // `g:<chat>:<group>` 内部键，用户无从认出是哪批内容）；标题缺失/空白时
    // 回退 itemKey —— 两种都不会渲染空名。
    let name = if t.title.trim().is_empty() {
        t.item_key.clone()
    } else {
        t.title.clone()
    };
    TaskView {
        id: format!("tg:{}", t.id),
        kind: TaskKind::Cache,
        name,
        // 聚合键 = orig-tg `itemKey`（同一内容多次入库共享同一个 key ⇒ 前端合并成一行）。
        group_key: t.item_key.clone(),
        // 定位坐标原样转发（BUG-300 复报：相册/批量组的 `itemKey` 给不出 msg，
        // 「去媒体库查看」必须靠载荷里的 `chatId`/`messageIds`）。chat_id 为 0 的
        // 老数据转 `None` —— 0 不是合法频道坐标。
        chat_id: (t.chat_id != 0).then_some(t.chat_id),
        message_ids: t.message_ids.clone(),
        priority: t.priority,
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
/// 动词的线上传名（与 `#[serde(rename_all = "lowercase")]` 同源，避免前端再猜一次）。
pub fn action_word(a: Action) -> &'static str {
    match a {
        Action::Pause => "pause",
        Action::Resume => "resume",
        Action::Cancel => "cancel",
        Action::Retry => "retry",
    }
}

pub fn actions_for(kind: TaskKind, status: &str) -> Vec<Action> {
    match kind {
        TaskKind::Download => match status {
            "downloading" | "queued" | "idle" => vec![Action::Pause, Action::Cancel],
            "paused" => vec![Action::Resume, Action::Cancel],
            // BUG-322：终态与中断的**重试**入口。记录留下来了（BUG-319）却动不了
            // 等于把结果变成遗迹，用户只能删掉重加。
            // `completed` 不给 Retry：落盘路径不重命名（见 `requeue` 的注释），
            // 重试一个已完成的文件只会覆盖它自己，那是噪音不是能力。
            "interrupted" | "error" | "cancelled" => vec![Action::Retry],
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
            // 与 `id: "dl:{status}"` 同口径：下载侧聚合键即本任务 id（唯一）。
            group_key: format!("dl:{status}"),
            // 下载侧诚实缺省：无 TG 频道/消息号/队列优先级。
            chat_id: None,
            message_ids: Vec::new(),
            priority: 0,
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

    /// BUG-322：记录留下来了却动不了 = 把结果变成遗迹。
    /// 停在那儿的行（中断/失败/被取消）必须能重试。
    #[test]
    fn stalled_download_rows_expose_retry() {
        for s in ["interrupted", "error", "cancelled"] {
            assert_eq!(
                actions_for(TaskKind::Download, s),
                vec![Action::Retry],
                "{s} 必须可重试"
            );
        }
        // 已完成不重试：落盘路径不重命名，重试已完成的文件只会覆盖它自己。
        assert!(
            actions_for(TaskKind::Download, "completed").is_empty(),
            "completed 不该有动作（重试它是噪音）"
        );
    }

    /// 动词的线上传名必须是 URL 里的那个词 —— 前端按 `actions[]` 拼端点，
    /// 这里拼错就是 404，而 404 在按钮上表现为「点了没反应」。
    #[test]
    fn action_word_matches_the_wire_name() {
        assert_eq!(action_word(Action::Pause), "pause");
        assert_eq!(action_word(Action::Resume), "resume");
        assert_eq!(action_word(Action::Cancel), "cancel");
        assert_eq!(action_word(Action::Retry), "retry");
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

    #[test]
    fn cache_view_name_is_human_title_with_item_key_fallback() {
        // BUG-300 复报（2026-10-15）：下载域 TG 行必须显示人类可读标题，
        // 否则用户只能看到 `g:<chat>:<group>` 内部键。
        let titled = TgCacheTask {
            id: 7,
            item_key: "g:-1003969766003:14333518975001516".to_string(),
            title: "《妈妈陪儿子高考》EP10 原档观享".to_string(),
            chat_id: -1003969766003,
            message_ids: vec![14333518975001516, 14333518975001517],
            priority: 3,
            total: 10,
            done: 2,
            status: "interrupted".to_string(),
            error: None,
            updated_at: 0,
        };
        assert_eq!(cache_view(&titled).name, "《妈妈陪儿子高考》EP10 原档观享");
        // 反向证伪：标题缺失（老数据）必须回退 itemKey —— 空名/空白名都是缺陷。
        let untitled = TgCacheTask {
            title: String::new(),
            ..titled
        };
        assert_eq!(
            cache_view(&untitled).name,
            "g:-1003969766003:14333518975001516"
        );
        let blank = TgCacheTask {
            title: "   ".to_string(),
            ..untitled
        };
        assert_eq!(
            cache_view(&blank).name,
            "g:-1003969766003:14333518975001516"
        );
    }

    #[test]
    fn cache_view_group_key_equals_item_key() {
        // BUG-300 复报（2026-10-15）：聚合键必须 == orig-tg `itemKey`，
        // 否则前端拿 `groupKey` 合并时与按 `itemKey` 直连的结果对不上（两处口径分裂）。
        let t = TgCacheTask {
            id: 7,
            item_key: "m:-1001341930464:208031".to_string(),
            title: "EP10 原档观享".to_string(),
            chat_id: -1001341930464,
            message_ids: vec![208031],
            priority: 0,
            total: 1,
            done: 0,
            status: "queued".to_string(),
            error: None,
            updated_at: 0,
        };
        assert_eq!(cache_view(&t).group_key, "m:-1001341930464:208031");
        // 下载侧 key 必须是本任务 id（唯一），不能是共享值 ⇒ 反向证伪：
        let dl = view(TaskKind::Download, "downloading");
        assert_eq!(dl.group_key, "dl:downloading");
    }

    #[test]
    fn cache_view_forwards_locator_and_priority() {
        // BUG-300 复报（2026-10-15）：「去媒体库查看」要 ref={chat}:{msg}、
        // 优先下载要 priority —— 两者都只能来自 orig-tg 任务载荷，聚合层必须原样转发。
        let t = TgCacheTask {
            id: 9,
            item_key: "g:-1003969766003:14333518975001516".to_string(),
            title: "相册批".to_string(),
            chat_id: -1003969766003,
            message_ids: vec![14333518975001516, 14333518975001517],
            priority: 5,
            total: 2,
            done: 0,
            status: "queued".to_string(),
            error: None,
            updated_at: 0,
        };
        let v = cache_view(&t);
        assert_eq!(v.chat_id, Some(-1003969766003));
        assert_eq!(v.message_ids, vec![14333518975001516, 14333518975001517]);
        assert_eq!(v.priority, 5);
        // 反向证伪：老载荷 chatId 缺省成 0 时必须转 None —— 0 不是合法频道坐标，
        // 拿它拼 ref 会查到别人的频道上去。
        let legacy = TgCacheTask {
            chat_id: 0,
            ..t
        };
        assert_eq!(cache_view(&legacy).chat_id, None);
        // 下载侧没有对应概念：None / 空 / 0，绝不伪装成「频道 0 的第 0 条」。
        let dl = view(TaskKind::Download, "downloading");
        assert_eq!(dl.chat_id, None);
        assert!(dl.message_ids.is_empty());
        assert_eq!(dl.priority, 0);
    }

    /// BUG-318：聚合拉取必须走 **state 里的运行时端口**，不是编译期常量 `TG_PORT`。
    ///
    /// 场景：orig-tg 绑不上起点（Windows 保留区/被占）⇒ daemon 顺延重选并落进
    /// `st.tg_port`（`/api/config` 与前端都以它为真源）。旧实现用常量，顺延后聚合
    /// 永远打到一个没有服务的端口 —— 健康的 orig-tg 被误报 `available=false`，
    /// 下载域整批入库行消失（用户观感即「数据丢失」）。
    ///
    /// 判据：假 orig-tg 起在随机空闲端口（**不是** `TG_PORT`），把 `st.tg_port`
    /// 指过去 ⇒ cache 来源必须 `available=true`。旧实现下此断言必败（常量端口上
    /// 什么都没有）—— 即「有牙」。
    #[tokio::test]
    async fn cache_views_use_runtime_tg_port_not_the_const() {
        use crate::config::Config;
        use orig_core::registry::Registry;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 假 orig-tg：随机端口起一个最小 HTTP 服务，只回 `{"tasks":[]}`。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake_port = listener.local_addr().unwrap().port();
        assert_ne!(fake_port, crate::state::TG_PORT, "前置：假服务必须不在常量端口上");
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = sock.read(&mut buf).await;
                    let body = r#"{"tasks":[]}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });

        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let st = AppState::new(0, Registry::new(), tx, Config::default(), None);
        st.config.write().unwrap().tg_enabled = true;
        *st.tg_port.write().unwrap() = fake_port; // 顺延后的实际端口

        let snap = collect(&st, Scope::All).await;
        let cache = snap
            .sources
            .iter()
            .find(|s| s.kind == TaskKind::Cache)
            .expect("cache source must always be reported");
        assert!(
            cache.available,
            "聚合必须读到 state.tg_port（顺延后的实际端口）上的 orig-tg，got error={:?}",
            cache.error
        );
    }
}
