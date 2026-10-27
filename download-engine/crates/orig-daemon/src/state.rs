//! 守护进程共享状态。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use orig_core::engine::Task;
use orig_core::protocol::SseEvent;
use orig_core::registry::Registry;
use tokio::process::Child;
use tokio::sync::{broadcast, Mutex};

use crate::config::Config;
use crate::task_store::{EngineTaskRecord, TaskStore};

/// orig-tg 监听端口。**唯一真源**：拉起子进程时注入、聚合层拉取时引用，
/// 两处必须同源，否则「启在 9877、拉 9876」这类分叉又会重新长出来。
///
/// 默认 19787（原 9877）：9877 落在 Windows 动态保留区时**没有任何监听者但 bind
/// 恒失败**（`WSAEACCES` 10013），服务永远起不来且原因看着像「进程自杀」（BUG-178）。
/// 仍可被子进程同名 env `ORIG_TG_PORT` 覆盖；且真起不来时 daemon 会顺延选端口，
/// 并把实际端口经 `/api/config` 下发 —— 前端不得再各自硬编码。
pub const TG_PORT: u16 = 19787;

/// 端口顺延扫描上限（避开保留区时的候选个数）。
const PORT_SCAN_LIMIT: u16 = 64;

/// 端口探测超时。无人监听时 connect 立即 ECONNREFUSED，这里的超时只是兜底
/// （防火墙静默丢包等极端情况不该挂住 `/api/config`）。
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// `tg_stop` 后等待子进程真正退出的上限（BUG-106）。
///
/// 目的是让 OS 释放 9877，避免紧接着的 `tg_start` 误判「端口有人」而跳过拉起。
/// kill 后正常退出是毫秒级；这里给足余量，超时也不阻塞调用方。
const TG_STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// 拉起后等待子进程**真正开始监听**的上限。
///
/// 为什么必须等（BUG-177）：`spawn()` 成功 ≠ 服务可用。实测本机 orig-tg 起来后
/// 立刻 `bind 127.0.0.1:9877 failed: os error 10013`（端口落在 Windows 保留区内）
/// 就退了 —— 而旧实现 `spawn()` 一返回就 `Ok(true)`，于是 `/api/config` 报
/// `tg_enabled=true` 而进程列表里根本没有 orig-tg：**「已开启但未连接」这个不该
/// 存在的状态就是这么来的**。等不到监听者就如实报错。
///
/// ⚠️ 这个窗口**必须覆盖 orig-tg 的冷启动**（BUG-227）。orig-tg 的启动顺序是
/// 「先连 MTProto（`build_client`）→ 再 bind HTTP」，所以「到开始监听」的耗时 =
/// 网络登录耗时，**不是**本机进程启动耗时。同一二进制实测：**5.10 s / 6.96 s**
/// （走 socks5 代理，需等 MTProto 协商完盐与 future salts），抖动全在网络侧。
/// 原值 5 s 恰好落在实测区间内 ⇒ 已就绪的进程被 daemon 判死并 kill，
/// 用户看到的是「TG 服务未能启动，模块已隐藏」——**不是端口冲突，是窗口太短**。
/// 30 s 给足慢链路余量；真正的失败仍然快速失败：子进程退出即刻中止（见下方循环）。
const TG_START_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

/// TG 托管巡检周期：daemon 是 orig-tg 的**唯一所有者**，开启却没在服务是 daemon
/// 的失职，必须自愈而不是等用户去点开关。
const TG_SUPERVISE_INTERVAL: Duration = Duration::from_secs(15);

/// 两次真正 spawn 之间的最小间隔：避免二进制缺失等**永久失败**下每 15s 起一个
/// 立刻就死的进程（进程风暴）。探测本身是廉价的本机 connect，不受此限制。
const TG_SPAWN_COOLDOWN: Duration = Duration::from_secs(60);

/// 两次「因链路断而重启」之间的最小间隔（BUG-178）。
///
/// 比 spawn 冷却长得多：MTProto 可能因网络抖动、Telegram 限流而短暂不可用，
/// 每 15s 重启一次只会把服务打得更不可用。5 分钟给足「网络自己恢复」的窗口，
/// 又远短于「用户手动重启应用」的平均耗时 —— 这正是要做自动化的理由。
const TG_LINK_RESTART_COOLDOWN: Duration = Duration::from_secs(300);

/// 判定「链路真断了」需要的**连续**巡检轮数（BUG-351）。
///
/// 为什么必须连续：`/api/tg/session` 的 `available` 是 orig-tg 自己维护的瞬时可用
/// 性 —— MTProto 抖动（代理重连 / bad salt / Telegram 限流）都会让它短暂 false。
/// 一次 false 就 `tg_restart()`（杀进程 + 重 spawn）是最重的处置：会话重建、
/// 缓存队列 re-queue（`cache queue resumed after restart`）、用户看到「TG 莫名挂了」。
/// 实测该判据在真机上造成 477 次重启（每 5 分钟一次，冷却只限速不改判据）。
/// 连续 3 轮 × 15s = 覆盖约 45s 的持续不可用窗口，抖动期不再重启，真断仍自愈。
const TG_LINK_DOWN_CONFIRMS: u32 = 3;

/// orig-tg 监听端口。
///
/// 默认 [`TG_PORT`]；可被 `ORIG_TG_PORT` 覆盖 —— 与注入子进程的同名 env **同源**
/// （见 [`AppState::tg_start_on`]），于是「迁移端口」只需一处 env，不会又长出
/// 「启在 A 端口、拉 B 端口」的分叉。
pub fn tg_port() -> u16 {
    std::env::var("ORIG_TG_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(TG_PORT)
}

/// 探测 127.0.0.1:{port} 是否已有监听者。
///
/// 为什么需要它（BUG-091）：orig-tg 可能由**别的发起方**拉起 —— 上一轮 daemon 遗留、
/// 手动启动、开机自启 —— 此时本进程手里没有它的 `Child` 句柄，只查句柄会得出
/// 「没在跑」，于是再 spawn 一个：要么 9877 bind 失败，要么跑出双进程。
/// 端口连得上就说明已有一个实例在服务，判为「已在运行」。
pub async fn tg_port_has_listener(port: u16) -> bool {
    // 目标是本机回环，`TcpStream::connect` 不走系统代理（不像 reqwest 会继承 HTTP_PROXY）。
    match tokio::time::timeout(
        PORT_PROBE_TIMEOUT,
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    {
        Ok(Ok(_stream)) => true,
        // 连不上（ECONNREFUSED）或超时 —— 都当作没有监听者。
        Ok(Err(_)) | Err(_) => false,
    }
}

/// 该端口在本机是否**可以绑定**（不只是「现在没人监听」）。
///
/// 为什么必须真 bind 一次（BUG-178 的物理根因）：Windows 的 Hyper-V / WSL 会预留
/// 一段动态端口区间（`netsh int ipv4 show excludedportrange tcp` 可见），落在区间内的
/// 端口**没有任何监听者，但 bind 一律 `WSAEACCES`（10013）**。于是
/// `tg_port_has_listener` 返回 false（看着空着），daemon 判定「可以拉起」，spawn 出的
/// orig-tg 立刻 `bind failed: os error 10013` 退出 —— 服务永远起不来，而现象看着像
/// 「进程自杀」。判据必须是「能不能绑」，不是「有没有人占」。
pub async fn port_bindable(port: u16) -> bool {
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => {
            drop(l);
            true
        }
        Err(_) => false,
    }
}

/// 从 `start` 起找第一个**可绑定**端口（最多扫 [`PORT_SCAN_LIMIT`] 个）。
///
/// 找不到返回 None：宁可如实报「本机没有可用端口」，也不要拿一个注定失败的端口
/// 去 spawn —— 那正是「已开启但永远不在线」的由来。
pub async fn select_bindable_port(start: u16) -> Option<u16> {
    for offset in 0..PORT_SCAN_LIMIT {
        let p = start.saturating_add(offset);
        if p == 0 {
            break;
        }
        if port_bindable(p).await {
            return Some(p);
        }
    }
    None
}

/// daemon 端点文件：把**实际**监听地址写给桌面壳。
///
/// 为什么需要它（BUG-178）：daemon 端口可能顺延（保留区），壳与前端都不得再猜
/// 9876。写文件是唯一真源，壳读它；`/api/config` 的 `port` 是同一真源的 HTTP 面。
///
/// 可被 `ORIG_DAEMON_ENDPOINT_FILE` 覆盖：dev 栈与 release 壳共用同一数据根时，
/// 两者的端点文件若同名就会互相覆盖 —— 后写的一方把对方的端口顶掉，于是壳连到
/// dev 的实例（或反之）。分离文件名是「共用库、互不影响」的必要条件。
pub fn daemon_endpoint_file() -> PathBuf {
    if let Ok(p) = std::env::var("ORIG_DAEMON_ENDPOINT_FILE") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    tg_data_dir().join("daemon.endpoint")
}

/// 写出 daemon 实际端点（`127.0.0.1:<port>`）。失败只记日志：它是壳的加速器，
/// 不是 daemon 自身可用的前提（壳会退化成端口扫描）。
pub fn write_daemon_endpoint(port: u16) {
    let path = daemon_endpoint_file();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[daemon] cannot create {}: {e}", parent.display());
            return;
        }
    }
    if let Err(e) = std::fs::write(&path, format!("127.0.0.1:{port}")) {
        eprintln!("[daemon] cannot write {}: {e}", path.display());
    }
}

/// 构造出向 HTTP 客户端（聚合层读 orig-tg 用）。
///
/// 两点必须如此：
/// - `no_proxy()`：目标是本机 127.0.0.1。reqwest 默认继承系统/环境代理，
///   一旦 `HTTP_PROXY` 生效，本机端口会被绕去远端代理而永远连不上 ——
///   那会把「TG 侧不可用」变成**假故障**（正是 BUG-077 风险 4 的反面）。
/// - 短超时：9877 挂掉时 `/api/activity` 必须快速降级，不能挂住调用方。
fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 单个任务在 daemon 侧的元数据（引擎 Task 不含 url/filename/时间等展示字段）。
pub struct DownloadTask {
    pub task: Arc<Task>,
    pub url: String,
    pub filename: String,
    pub output: PathBuf,
    pub added_at: i64,
    pub max_concurrency: u32,
    /// 自动分类名（按设置 classify_rules 推导）；供状态接口随任务透传。
    pub category: Option<String>,
    /// 运行期错误（完成后若有错则写入，供状态接口暴露）。
    pub error: Mutex<Option<String>>,
}

pub struct AppState {
    /// daemon 实际监听端口（可能与配置不同：保留区顺延，见 `main::bind_with_fallback`）。
    ///
    /// 桌面壳与前端一律以这里为准（`GET /api/config` 的 `port` + 端点文件），
    /// 不得再各自硬编码 9876。
    pub port: u16,
    pub registry: Registry,
    /// 进行中的任务：id -> DownloadTask（Arc 共享，控制句柄在 Task 内）。
    ///
    /// ⚠️ 这是一个**进程内**的表：它只服务于正在跑的任务，不是记录真源。
    /// BUG-319 之前它就是唯一数据源，于是进程一没，下载行全丢。
    /// 现在记录真源是 [`Self::task_store`]（SQLite）；本表只装「本进程手里有
    /// 控制句柄的那些」，两者由 `activity::download_views` 合并后再对外。
    pub tasks: Mutex<HashMap<String, DownloadTask>>,
    /// 引擎任务持久化（BUG-319）。
    ///
    /// `None` = 库打不开（磁盘满 / 目录只读）—— 下载照样能跑，只是记录会丢。
    /// 持久化是可用性增强，不是服务前提，绝不因此阻断启动。
    pub task_store: Option<Arc<TaskStore>>,
    pub events: broadcast::Sender<SseEvent>,
    /// daemon 配置（RwLock：设置页可运行时更新自动分类规则）。
    pub config: RwLock<Config>,
    /// orig-tg 子进程句柄（TG 可选插件）。None = 未启动 / 已退出。
    pub tg_child: Mutex<Option<Child>>,
    /// TG 最近一次拉起/自愈失败的原因（BUG-177）。
    ///
    /// 入口级门控是「服务可用才显示 TG」，于是 TG 不可用时侧栏**没有** TG 入口；
    /// 若不把原因摆在设置页，用户只会以为「功能没了」。成功拉起后清空。
    pub tg_last_error: RwLock<Option<String>>,
    /// 上一次真正 spawn 的时刻（巡检退避用，见 `TG_SPAWN_COOLDOWN`）。
    pub tg_last_spawn: Mutex<Option<tokio::time::Instant>>,
    /// 上一次因链路断而重启的时刻（巡检退避用，见 `TG_LINK_RESTART_COOLDOWN`）。
    pub tg_last_restart: Mutex<Option<tokio::time::Instant>>,
    /// 连续判定「链路不可用」的轮数（BUG-351：达到 `TG_LINK_DOWN_CONFIRMS` 才重启）。
    pub tg_link_down_streak: AtomicU32,
    /// 自本进程启动以来，因链路断而重启 orig-tg 的次数（**对外可见**，BUG-351）。
    ///
    /// 界面此前只能看到瞬时 `tg_running`，于是「系统每 5 分钟自杀重启一次」在关于页
    /// 完全不可见 —— 用户看到的是「TG 莫名挂了」与「两个状态都是好的」并存。
    pub tg_link_restarts: AtomicU64,
    /// 最近一次因链路断而重启的**墙钟**（epoch 秒，供界面显示「最近重启时间」）。
    pub tg_last_link_restart_at: RwLock<Option<i64>>,
    /// 最近一次判定链路不可用时的原因（orig-tg 的 `unavailable_reason`；
    /// HTTP 探不到时记为 `session probe failed`）。
    pub tg_last_link_down_reason: RwLock<Option<String>>,
    /// 当前为 orig-tg 选定的端口（起点 `tg_port()`，不可绑定时顺延）。
    ///
    /// 为什么要在 state 里存（BUG-178）：端口不再是一个常量 —— 本机可能把默认端口
    /// 划进保留区，daemon 必须自己换一个，并把它作为**唯一真源**下发给前端。
    /// 存常量就等于让前端继续猜，猜错就是「服务在 19788、前端拉 19787」。
    pub tg_port: RwLock<u16>,
    /// 出向 HTTP 客户端（`/api/activity` 聚合层拉 orig-tg 用；见 `build_http_client`）。
    pub http: reqwest::Client,
    /// **上一次已成功同步给 orig-tg 的下载路径**（BUG-323）。
    ///
    /// 下载路径是整个引擎的唯一根（库根 = 其下 `library`），orig-tg 必须跟随。
    /// 记「上次成功的值」是为了：值未变一个 HTTP 都不发；发失败就不记账 ⇒
    /// 下一轮巡检自动重试（不依赖用户点任何按钮）。
    pub tg_synced_download_root: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(
        port: u16,
        registry: Registry,
        events: broadcast::Sender<SseEvent>,
        config: Config,
        task_store: Option<Arc<TaskStore>>,
    ) -> Self {
        Self {
            port,
            registry,
            tasks: Mutex::new(HashMap::new()),
            task_store,
            events,
            config: RwLock::new(config),
            tg_child: Mutex::new(None),
            tg_last_error: RwLock::new(None),
            tg_last_spawn: Mutex::new(None),
            tg_last_restart: Mutex::new(None),
            tg_link_down_streak: AtomicU32::new(0),
            tg_link_restarts: AtomicU64::new(0),
            tg_last_link_restart_at: RwLock::new(None),
            tg_last_link_down_reason: RwLock::new(None),
            tg_port: RwLock::new(tg_port()),
            http: build_http_client(),
            tg_synced_download_root: Mutex::new(None),
        }
    }

    /// 当前为 orig-tg 选定的端口（唯一真源，随 `/api/config` 下发）。
    pub fn tg_port_state(&self) -> u16 {
        *self.tg_port.read().unwrap()
    }

    /// 把下载路径推给 orig-tg（`PUT /api/tg/config {downloadDir}`），幂等。
    ///
    /// 下载路径是全部文件的唯一容器，orig-tg 的下载落点与库根都由它派生
    /// （BUG-323）—— 因此这条推送是「单一根」的落地动作，不是可选优化。
    pub async fn push_tg_download_root(&self, dir: &str) -> Result<(), String> {
        let url = format!("http://127.0.0.1:{}/api/tg/config", self.tg_port_state());
        let body = serde_json::json!({ "downloadDir": dir }).to_string();
        match self
            .http
            .put(&url)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => Ok(()),
            Ok(resp) => {
                let code = resp.status();
                let text = resp.text().await.unwrap_or_default();
                Err(format!(
                    "orig-tg rejected download dir update: {code} {}",
                    text.trim()
                ))
            }
            Err(e) => Err(format!("orig-tg unreachable while syncing download dir: {e}")),
        }
    }

    /// 需要时同步下载路径（值未变则零请求）。
    ///
    /// 供巡检调用：TG 起来了 / 用户改了目录 / 上次推送失败 —— 三种情况都会在下一轮
    /// 巡检里自然收敛。失败原因写日志，不静默。
    pub async fn sync_download_root_if_needed(&self) {
        let eff = {
            let cfg = self.config.read().unwrap();
            crate::config::effective_download_root(&cfg)
        };
        let want = eff.to_string_lossy().into_owned();
        {
            let last = self.tg_synced_download_root.lock().await;
            if last.as_deref() == Some(want.as_str()) {
                return;
            }
        }
        match self.push_tg_download_root(&want).await {
            Ok(()) => {
                *self.tg_synced_download_root.lock().await = Some(want);
            }
            Err(e) => {
                // 不记账 ⇒ 下一轮重试；同时留痕（用户可查 errors.log）。
                let msg = format!("[warn] sync download root to orig-tg failed: {e}");
                eprintln!("{msg}");
                append_error_log(&msg);
            }
        }
    }

    /// 写一条记录进持久化层（BUG-319）。
    ///
    /// 没有库（打开失败）时**静默跳过**：记录丢失的后果轻于服务不可用，
    /// 与 `open_log_file` 的「日志不能让主流程失败」同一口径。
    pub async fn persist(&self, r: &EngineTaskRecord) {
        if let Some(s) = &self.task_store {
            s.upsert(r).await;
        }
    }

    /// 只改一条记录的状态（不碰字节数，见 `TaskStore::set_status`）。
    pub async fn set_task_status(&self, id: &str, status: &str) {
        if let Some(s) = &self.task_store {
            s.set_status(id, status).await;
        }
    }

    /// 库里有没有这条记录。
    ///
    /// 终态行已让出内存句柄（见 `spawn_task` 收尾），只查内存会把终态行判成
    /// 「不存在」⇒ 它删不掉 —— 而终态行恰恰是用户最想清掉的那一行。
    pub async fn record_exists(&self, id: &str) -> bool {
        match &self.task_store {
            Some(s) => s.get(id).await.is_some(),
            None => false,
        }
    }

    /// 删掉一条记录（用户显式删除任务时）。
    pub async fn forget(&self, id: &str) {
        if let Some(s) = &self.task_store {
            s.remove(id).await;
        }
    }

    /// 由内存任务 + 调用方给定的读数构造一条持久化记录。
    ///
    /// 状态与字节数由调用方传入，本函数不猜：内存的 `progress()` 是瞬时快照，
    /// 而写库只在**状态迁移**与**终态**发生 —— 混在一起就会变成每轮询写一次。
    pub fn record_of(
        dt: &DownloadTask,
        status: &str,
        total: u64,
        downloaded: u64,
        updated_at: i64,
        error: Option<String>,
    ) -> EngineTaskRecord {
        EngineTaskRecord {
            id: dt.task.id.clone(),
            url: dt.url.clone(),
            filename: dt.filename.clone(),
            // 同 activity.rs：出参形态统一 `/`。
            output: orig_core::paths::to_wire(&dt.output),
            added_at: dt.added_at,
            updated_at,
            max_concurrency: dt.max_concurrency,
            category: dt.category.clone(),
            status: status.to_string(),
            downloaded,
            total,
            error,
        }
    }

    /// 为 orig-tg 选定端口：起点可用就沿用，不可用则顺延到第一个可绑定的（BUG-178）。
    ///
    /// 只在**拉起前**调用：探测是真 bind，不该混进读路径（`/api/config` 每调一次就
    /// bind 一次，既慢又会与子进程抢端口）。选定结果记进 `tg_port`。
    async fn tg_reselect_port(&self) -> u16 {
        let cur = self.tg_port_state();
        if port_bindable(cur).await {
            return cur;
        }
        match select_bindable_port(tg_port()).await {
            Some(next) => {
                *self.tg_port.write().unwrap() = next;
                next
            }
            // 一个都绑不上：如实留下起点，让 `tg_start_on` 去报真实错误。
            None => cur,
        }
    }

    /// **本进程自己拉起**的 orig-tg 是否存活（句柄存在且未退出）；已退出自动清理句柄。
    async fn tg_managed_alive(&self) -> bool {
        let mut g = self.tg_child.lock().await;
        match g.as_mut() {
            Some(c) => {
                if c.try_wait().ok().flatten().is_some() {
                    *g = None;
                    false
                } else {
                    true
                }
            }
            None => false,
        }
    }

    /// orig-tg 是否存活：**先**看本进程托管的子进程句柄（主路径），**再**探端口
    /// —— 后者覆盖「由别的发起方拉起、本进程没有句柄」的情形（BUG-091）。
    ///
    /// 两条路径的语义差别要清楚：托管路径是「我拉的孩子还在」，端口路径是
    /// 「这个端口上已经有人在服务」。后者为真时我们拿不到它的句柄，也就不能 kill
    /// （`tg_stop` 对外部实例无能为力，这是既有行为，不在本次修复范围）。
    pub async fn tg_is_running_on(&self, port: u16) -> bool {
        if self.tg_managed_alive().await {
            return true;
        }
        tg_port_has_listener(port).await
    }

    /// orig-tg 是否存活（端口取当前选定端口 [`Self::tg_port_state`]）。
    pub async fn tg_is_running(&self) -> bool {
        self.tg_is_running_on(self.tg_port_state()).await
    }

    /// 读取 TG 失败原因（只读，不清空）。
    ///
    /// 不做「读后即清」：`/api/config` 是被多处轮询的读端点（init / 设置页 / 开关回写），
    /// 读一次就清会让先到的轮询把后到的展示吃掉 —— 那正是「故障偶发不可见」。
    /// 清空的时机只有两个：拉起成功、或用户主动关闭 TG（见 [`Self::tg_start_on`] /
    /// [`Self::tg_stop`]）。
    pub fn tg_last_error(&self) -> Option<String> {
        self.tg_last_error.read().unwrap().clone()
    }

    /// 清空 TG 失败原因（拉起成功 / 主动关闭时调用）。
    fn clear_tg_last_error(&self) {
        *self.tg_last_error.write().unwrap() = None;
    }

    /// 记一次 TG 失败原因（只记录，不吞错：错误本身仍会向上传递给调用方）。
    ///
    /// 同时落 `logs/errors.log`（BUG-243）：内存里的 `tg_last_error` 会被下一次成功
    /// 拉起清空，重启后更是全无 —— 而「偶发故障」恰恰只在事后才有人来查。
    fn set_tg_last_error(&self, msg: impl Into<String>) {
        let msg = msg.into();
        append_error_log(&msg);
        *self.tg_last_error.write().unwrap() = Some(msg);
    }

    /// 拉起 orig-tg 子进程（幂等）：注入代理与凭据（解析规则见 [`resolve_tg_env`]，
    /// custom 代理优先，其次 config.json，都没有则不设 env = 直连）。返回是否处于运行态。
    ///
    /// 端口已被占用（不论是不是本进程拉起的）时**不 spawn**，直接返回 true。
    pub async fn tg_start_on(&self, port: u16) -> std::io::Result<bool> {
        if self.tg_is_running_on(port).await {
            return Ok(true);
        }
        let cfg = self.config.read().unwrap().clone();

        // 二进制缺失是**永久失败**：先拦截，给出可行动的明确信息，而不是 spawn 后才拿到
        // 一句笼统的 "exited without listening"（那会把「文件不存在」伪装成「进程自杀」）。
        let bin = tg_binary_path();
        if !bin.exists() {
            // 记一次「尝试时间」（BUG-244）：`TG_SPAWN_COOLDOWN` 的判定读的就是这个时刻，
            // 而它原来只在 `cmd.spawn()` **成功之后**才写 —— 于是走这条早退路径时冷却永远
            // 不生效，巡检每 15s 重试一次，注释里承诺的「永久失败不该每 15s 起一个进程」
            // 落空，表现是错误日志每 15s 追加一行。冷却必须覆盖**所有**失败路径。
            *self.tg_last_spawn.lock().await = Some(tokio::time::Instant::now());
            let msg = format!(
                "orig-tg binary not found at {}; the desktop app may need to be rebuilt/redeployed",
                bin.display()
            );
            self.set_tg_last_error(&msg);
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, msg));
        }

        let mut cmd = tokio::process::Command::new(&bin);
        // 端口由入参决定（起点 `TG_PORT`=19787，不可绑定时 `tg_reselect_port` 顺延）。
        // 凭据显式注入（不依赖父进程环境继承），保证 Tauri/开机重启后 real 模式仍生效；
        // `[tg]` 段为空时回退同目录 `tg/config.json`（BUG-094）。
        // 注意：orig-tg 只读 `ORIG_TG_PORT`（见 orig-tg/src/config.rs::load），
        // 注入 `PORT` 是错名、会被忽略；仅因 orig-tg 默认端口恰为 9877 才未暴露。
        cmd.env("ORIG_TG_PORT", port.to_string());
        cmd.kill_on_drop(true);
        // 会话与监控库必须落到稳定数据目录，免得 orig-tg 用 CWD 相对的默认路径，
        // 每次启动 CWD 变化就新生成会话 → 反复登录。目录在注入前先确保存在。
        let data_dir = tg_data_dir();
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            return Err(e);
        }
        cmd.env("ORIG_TG_SESSION", tg_session_path(&data_dir));
        cmd.env("ORIG_TG_DB", tg_db_path(&data_dir));
        // 凭据/代理：`download-engine.toml` 的 `[tg]`/`[proxy]` 段优先；缺失时回退
        // 同数据目录下的 `tg/config.json`（桌面壳写凭据的地方）—— 见 `resolve_tg_env`。
        let inject = resolve_tg_env(&cfg, &data_dir);
        if let Some(url) = &inject.proxy {
            cmd.env("ORIG_TG_PROXY", url);
        }
        if let Some(id) = &inject.api_id {
            cmd.env("ORIG_TG_API_ID", id);
        }
        if let Some(h) = &inject.api_hash {
            cmd.env("ORIG_TG_API_HASH", h);
        }
        if inject.api_id.is_none() || inject.api_hash.is_none() {
            // 只记「没拿到」，绝不打印任何字段值（凭据永不入日志）。
            eprintln!("[tg] no MTProto credentials resolved; orig-tg will start without api_id/api_hash");
        }
        // 子进程输出落文件（BUG-243）：此前是**继承 daemon 的 stdio**，而 daemon 由
        // `dev_services.py` / 桌面壳以 DEVNULL 启动 ⇒ orig-tg 的启动失败原因当场就丢了，
        // 只剩 daemon 一句笼统的 `tg_last_error`（用户于是只能看到「未能启动」而看不到
        // 为什么）。固定写到 `logs/orig-tg.log`，与关于页给出的路径同源。
        // 打不开就退回继承 stdio —— 日志不能阻断服务启动。
        match open_log_file("orig-tg.log") {
            Some(f) => match f.try_clone() {
                Ok(f2) => {
                    cmd.stdout(std::process::Stdio::from(f));
                    cmd.stderr(std::process::Stdio::from(f2));
                }
                Err(_) => {
                    cmd.stdout(std::process::Stdio::from(f));
                }
            },
            None => {}
        }
        let child = cmd.spawn()?;
        *self.tg_child.lock().await = Some(child);
        *self.tg_last_spawn.lock().await = Some(tokio::time::Instant::now());

        // BUG-177：`spawn()` 成功 ≠ 服务可用。等它真的开始监听，等到才算数。
        // 起不来（端口被占用 / 落在系统保留区 / 二进制缺陷）就**如实报错**并把原因
        // 记进 `tg_last_error` —— 绝不留一个「已开启但未连接」的幽灵状态。
        let deadline = tokio::time::Instant::now() + TG_START_WAIT_TIMEOUT;
        // 保留子进程退出码：区分「崩了（有退出码）」与「超时未监听（无退出码）」。
        let mut exit_status: Option<std::process::ExitStatus> = None;
        loop {
            if tg_port_has_listener(port).await {
                self.clear_tg_last_error();
                daemon_log(&format!("orig-tg started and listening on 127.0.0.1:{port}"));
                return Ok(true);
            }
            // 直接探子进程退出状态（保留退出码），不再经由 `tg_managed_alive` 丢弃它。
            let exited = {
                let mut g = self.tg_child.lock().await;
                match g.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(status)) => {
                            *g = None;
                            exit_status = Some(status);
                            true
                        }
                        _ => false,
                    },
                    None => true,
                }
            };
            if exited {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // 走到这里 = 拉起来了但没有服务。回收句柄，避免下一次 `tg_is_running_on`
        // 因句柄存在而误判（句柄存在 → 直接 return true 而不探端口）。
        let mut g = self.tg_child.lock().await;
        if let Some(c) = g.as_mut() {
            let _ = c.kill().await;
            let _ = tokio::time::timeout(TG_STOP_WAIT_TIMEOUT, c.wait()).await;
        }
        *g = None;
        // 失败原因分三档，信息量从「能行动」到「需排查」：
        //  1) 二进制缺失 -> 已在上面拦截；
        //  2) 进程起了但退出 -> 带上退出码与二进制路径，立刻能看出是崩了还是被信号杀；
        //  3) 端口绑不上 -> 明确是保留区/被占，daemon 下次会顺延端口。
        let msg = if let Some(status) = exit_status {
            format!(
                "orig-tg ({}) exited without listening on 127.0.0.1:{} (exit status: {:?})",
                bin.display(),
                port,
                status.code()
            )
        } else if port_bindable(port).await {
            format!(
                "orig-tg ({}) started but did not begin listening on 127.0.0.1:{} within {}s",
                bin.display(),
                port,
                TG_START_WAIT_TIMEOUT.as_secs()
            )
        } else {
            format!(
                "port 127.0.0.1:{port} is not bindable on this host (reserved by the OS or already in use); \
                 daemon will pick another port on the next attempt"
            )
        };
        self.set_tg_last_error(&msg);
        Err(std::io::Error::new(std::io::ErrorKind::Other, msg))
    }

    /// 拉起 orig-tg 子进程（端口在拉起前重新选定，见 [`Self::tg_reselect_port`]）。
    pub async fn tg_start(&self) -> std::io::Result<bool> {
        let port = self.tg_reselect_port().await;
        self.tg_start_on(port).await
    }

    /// 重启 orig-tg（**唯一执行者语义**：凭证变更 / 链路恢复都走这里）。
    ///
    /// 为什么要有它（BUG-178）：orig-tg 只在启动时连一次 Telegram，凭证补齐或网络
    /// 修好后必须重启才能生效。以前这个动作散在两处 —— 桌面壳 `ensure_tg`
    /// （`kill_port_owner` 硬杀 9877）与前端「重试连接」按钮 —— 于是 TG 进程有
    /// **两个主人**，互相杀。现在只留这一个入口：先停托管实例，再按当前选定端口拉起。
    pub async fn tg_restart(&self) -> std::io::Result<bool> {
        self.tg_stop().await;
        self.tg_start().await
    }

    /// TG 托管巡检（BUG-177）：daemon 是 orig-tg 的**唯一所有者**，
    /// 「开关开着但服务不在」是 daemon 的失职，必须自愈，而不是留给用户去点开关。
    ///
    /// 频率与退避：`TG_SUPERVISE_INTERVAL` 只做廉价的本机 connect 探测；
    /// 真正 spawn 受 `TG_SPAWN_COOLDOWN` 限制 —— 二进制缺失这类**永久失败**
    /// 不该变成每 15s 拉起一个立刻就死的进程。
    pub async fn tg_supervise(self: &Arc<Self>) {
        let mut holding = false;
        loop {
            tokio::time::sleep(TG_SUPERVISE_INTERVAL).await;

            // ---- 重部署握手（AI 触发；非自治）----
            // 收到 request：停 orig-tg，写 stopped（AI 可安全构建），进入 hold（抑制自愈）。
            if redeploy_signal_exists(REDEPLOY_REQ) {
                remove_redeploy_signal(REDEPLOY_REQ);
                daemon_log("redeploy request received — stopping orig-tg for build");
                eprintln!("[daemon] redeploy request — stopping orig-tg");
                self.tg_stop().await;
                write_redeploy_signal(REDEPLOY_STOPPED);
                daemon_log("orig-tg stopped; safe to build (write orighub-redeploy-built when done)");
                eprintln!("[daemon] orig-tg stopped; safe to build now (write orighub-redeploy-built when done)");
                holding = true;
                continue;
            }
            // 收到 built：重启 orig-tg（拾取新二进制），写 done，退出 hold。
            if holding && redeploy_signal_exists(REDEPLOY_BUILT) {
                remove_redeploy_signal(REDEPLOY_BUILT);
                daemon_log("redeploy built received — restarting orig-tg with new binary");
                eprintln!("[daemon] redeploy built — restarting orig-tg");
                match self.tg_restart().await {
                    Ok(true) => {
                        daemon_log("orig-tg restarted after redeploy");
                        eprintln!("[daemon] orig-tg restarted after redeploy");
                    }
                    Ok(false) => {}
                    Err(e) => {
                        daemon_log(&format!("failed to restart orig-tg after redeploy: {e}"));
                        eprintln!("[daemon] failed to restart orig-tg after redeploy: {e}");
                    }
                }
                write_redeploy_signal(REDEPLOY_DONE);
                holding = false;
                continue;
            }
            // hold 期间不自愈，避免与构建抢进程（exe 被锁会 os error 5）。
            if holding {
                continue;
            }

            let enabled = self.config.read().unwrap().tg_enabled;
            if !enabled {
                continue;
            }
            // 进程不在 → 拉起（短冷却）。
            if !self.tg_is_running().await {
                let can_spawn = {
                    let last = self.tg_last_spawn.lock().await;
                    match *last {
                        Some(t) => t.elapsed() >= TG_SPAWN_COOLDOWN,
                        None => true,
                    }
                };
                if !can_spawn {
                    continue;
                }
                match self.tg_start().await {
                    Ok(true) => {
                        daemon_log("orig-tg recovered (was down)");
                        eprintln!("[tg] supervise: orig-tg recovered");
                    }
                    Ok(false) => {}
                    Err(e) => eprintln!("[tg] supervise: failed to start orig-tg: {e}"),
                }
                continue;
            }
            // 进程在，但**链路断了** → 连续确认后才重启（长冷却）。
            //
            // 为什么必须由 daemon 做（BUG-178）：orig-tg 只在启动时连一次 Telegram，
            // 连不上就永远停在不可用态。以前这个动作是界面上的「重试连接」按钮 +
            // 桌面壳 `ensure_tg` 两条手动路径 —— 用户修好网络还得替系统点一下，
            // 那是把 daemon 的失职外包给用户。现在巡检自己收尾。
            //
            // 为什么必须**连续确认**（BUG-351）：一次瞬时 false 就重启是最重的处置
            // （会话重建 + 缓存队列 re-queue + 用户可见中断）；抖动期按 5 分钟冷却
            // 反复重启，实测 477 次。真断 = 连续 3 轮（约 45s）持续不可用。
            match self.tg_link_probe().await {
                Ok(()) => {
                    self.tg_link_down_streak.store(0, Ordering::SeqCst);
                    *self.tg_last_link_down_reason.write().unwrap() = None;
                    // BUG-323：TG 健康时顺手对齐下载路径。值未变 ⇒ 零请求；
                    // 上次推送失败（TG 刚回来）/ 用户刚改过目录 ⇒ 这里自然补上，
                    // 不需要用户点任何按钮。
                    self.sync_download_root_if_needed().await;
                    continue;
                }
                Err(reason) => {
                    let streak = self.tg_link_down_streak.fetch_add(1, Ordering::SeqCst) + 1;
                    *self.tg_last_link_down_reason.write().unwrap() = Some(reason.clone());
                    if !link_down_confirmed(streak) {
                        eprintln!(
                            "[tg] supervise: link down ({streak}/{TG_LINK_DOWN_CONFIRMS}) — waiting for confirmation: {reason}"
                        );
                        continue;
                    }
                    let can_restart = {
                        let last = self.tg_last_restart.lock().await;
                        match *last {
                            Some(t) => t.elapsed() >= TG_LINK_RESTART_COOLDOWN,
                            None => true,
                        }
                    };
                    if !can_restart {
                        continue;
                    }
                    eprintln!("[tg] supervise: telegram link is down, restarting orig-tg");
                    daemon_log("telegram link is down — restarting orig-tg");
                    *self.tg_last_restart.lock().await = Some(tokio::time::Instant::now());
                    match self.tg_restart().await {
                        Ok(true) => eprintln!("[tg] supervise: orig-tg restarted"),
                        Ok(false) => {}
                        Err(e) => eprintln!("[tg] supervise: failed to restart orig-tg: {e}"),
                    }
                    // 重启即处置完成：计数 + 记墙钟 + 重新从 0 累积（下次仍需连续确认）。
                    self.tg_link_down_streak.store(0, Ordering::SeqCst);
                    self.tg_link_restarts.fetch_add(1, Ordering::SeqCst);
                    *self.tg_last_link_restart_at.write().unwrap() =
                        Some(chrono_like_epoch_secs());
                }
            }
        }
    }

    /// 链路健康快照（**对外可见**，BUG-351）：`/api/config` 的 `tg_link` 字段。
    ///
    /// 「系统每 5 分钟重启一次 TG」此前在界面上完全不可见：`/api/config` 只有瞬时
    /// `tg_running`（重启窗口只有几百 ms），`tg_last_error` 又只记 spawn 失败。
    /// 没有这个字段，关于页就永远是两个绿点，与用户看到的「TG 莫名挂了」矛盾。
    pub fn tg_link_status(&self) -> serde_json::Value {
        let streak = self.tg_link_down_streak.load(Ordering::SeqCst);
        serde_json::json!({
            "link_down": streak > 0,
            "down_streak": streak,
            "confirms_required": TG_LINK_DOWN_CONFIRMS,
            "restarts": self.tg_link_restarts.load(Ordering::SeqCst),
            "last_restart_at": *self.tg_last_link_restart_at.read().unwrap(),
            "reason": self.tg_last_link_down_reason.read().unwrap().clone(),
        })
    }

    /// Telegram 链路是否健康（进程在跑时的**第二层**巡检，BUG-178）。
    ///
    /// 判据分三种，混淆它们就会误重启：
    ///   - `available=true` → 健康；
    ///   - 不可用但**没配凭证** → 也算健康（那是待用户去配置的**待办**，重启一百次也修不好，
    ///     重启只会让配置页刚填完就被顶掉）；
    ///   - 不可用且已配凭证 → 真断了，需要重启才能重连。
    /// HTTP 本身失败（进程在但已半死）同样按「要重启」处理。
    ///
    /// 返回 `Err(reason)` = 链路不可用且**值得重启**；`Ok(())` = 健康（含「没配凭证」
    /// 这种待办态 —— 重启一百次也修不好，还会把刚填完凭证的实例顶掉）。
    /// 原因随结果带出（BUG-351）：界面要能回答「为什么最近重启过」。
    async fn tg_link_probe(&self) -> Result<(), String> {
        let url = format!("http://127.0.0.1:{}/api/tg/session", self.tg_port_state());
        let resp = match self.http.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return Err(format!("session probe failed: {e}")),
        };
        // 走 `text()` + `serde_json`：daemon 不依赖 reqwest 的 `json` feature。
        let Ok(body) = resp.text().await else {
            return Err("session probe failed: unreadable body".to_string());
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
            return Err("session probe failed: unparsable body".to_string());
        };
        if tg_link_healthy_from(&v) {
            return Ok(());
        }
        Err(
            v.get("reason")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("telegram link unavailable")
                .to_string(),
        )
    }

    /// 终止 orig-tg 子进程并清空句柄（幂等）。
    ///
    /// 只能终止**本进程托管的**那个（`tg_child`）；对端口探测发现的外部实例无能为力，
    /// 调用方（`PUT /api/config/tg`）据此回 `tg_running=false` 时需注意这一前提。
    pub async fn tg_stop(&self) {
        let mut g = self.tg_child.lock().await;
        if let Some(c) = g.as_mut() {
            let _ = c.kill().await;
            // BUG-106：kill 之后**必须等它真正退出**，否则端口还没释放。
            //
            // 后续 `tg_start_on` 先探端口：`tg_port_has_listener(9877)` 若撞上这个
            // 「已 kill 但仍持端口」的将死进程，就会返回 true → **提前 return 且不拉起**
            // → `PUT /api/config/tg {enabled:true}` 回 `tg_running:true`，
            // 而进程列表里根本没有 orig-tg。实测该竞态让 TG 永久下线且无法通过开关恢复。
            //
            // `wait()` 同时回收僵尸进程句柄；超时不阻塞调用方（端口最终仍会释放）。
            let _ = tokio::time::timeout(TG_STOP_WAIT_TIMEOUT, c.wait()).await;
        }
        *g = None;
        // 主动关闭 = 用户意图，先前的失败原因不再相关（否则关掉再开还挂着旧错）。
        self.clear_tg_last_error();
        daemon_log("orig-tg stopped");
    }
}

/// 由 `/api/tg/session` 的响应判定链路是否健康（纯函数，便于单测）。
///
/// 三种情况必须分开，混淆就会误重启（BUG-178）：
///   - `available=true` → 健康；
///   - 不可用但**没配凭证** → 健康（待用户去配置的**待办**；重启一百次也修不好，
///     还会把刚填完凭证、正要走登录流程的实例顶掉）；
///   - 不可用且已配凭证 → 真断了，必须重启才可能重连。
/// 连续 down 轮数是否达到「真断了」的阈值（纯函数，便于单测；BUG-351）。
///
/// 判据是 `streak >= TG_LINK_DOWN_CONFIRMS`：**达到**阈值即确认（第 3 轮就重启），
/// 不是「超过」—— 冷却已经在限速，再拖一轮只会让真故障的自愈更晚。
fn link_down_confirmed(streak: u32) -> bool {
    streak >= TG_LINK_DOWN_CONFIRMS
}

/// 当前墙钟（epoch 秒）。
///
/// daemon 不引 chrono（构建面越小越好），一个 `SystemTime` 换算足够：这个值的唯一
/// 用途是给界面显示「最近一次重启是什么时候」（BUG-351）。
fn chrono_like_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn tg_link_healthy_from(v: &serde_json::Value) -> bool {
    if v.get("available").and_then(|x| x.as_bool()).unwrap_or(false) {
        return true;
    }
    let configured = v
        .get("api_configured")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    !configured
}

/// 拉起 orig-tg 时要注入的三个可选环境变量。
///
/// 抽成纯结构（不碰子进程）是为了让 BUG-094 的回退分支可被单测覆盖：
/// 拉起子进程需要真实二进制，不该进测试。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TgLaunchEnv {
    /// `ORIG_TG_API_ID`。None = 不注入。
    pub api_id: Option<String>,
    /// `ORIG_TG_API_HASH`。None = 不注入。
    pub api_hash: Option<String>,
    /// `ORIG_TG_PROXY`。None = 不注入（直连）。
    pub proxy: Option<String>,
}

/// `<数据目录>/tg/config.json` 里的可选凭据（桌面壳 `tg_save_config` 写出的那份）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TgFileCredentials {
    /// MTProto api_id（JSON 里可能是数字也可能是字符串，两种都收）。
    pub api_id: Option<String>,
    /// MTProto api_hash。
    pub api_hash: Option<String>,
    /// 出向代理 URL（如 `socks5://127.0.0.1:7897`）。
    pub proxy: Option<String>,
}

/// 取 JSON 标量为非空字符串：字符串与数字都收，其余类型/空串一律当缺失。
fn json_scalar_string(value: &serde_json::Value) -> Option<String> {
    let s = match value {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 尽力读取 `<data_dir>/tg/config.json` 的凭据。
///
/// **任何**失败（文件不存在 / 不可读 / JSON 非法 / 顶层不是对象 / 字段缺失）都返回
/// 全 `None`，绝不 panic —— 凭据缺失是可选插件的合法常态，不能因此让 daemon 起不来。
/// 敏感字段只在此函数内流转，不入日志、不入错误、不入响应。
pub fn load_tg_file_credentials(data_dir: &Path) -> TgFileCredentials {
    let path = data_dir.join("tg/config.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return TgFileCredentials::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return TgFileCredentials::default();
    };
    let Some(obj) = value.as_object() else {
        return TgFileCredentials::default();
    };
    TgFileCredentials {
        api_id: obj.get("api_id").and_then(json_scalar_string),
        api_hash: obj.get("api_hash").and_then(json_scalar_string),
        proxy: obj.get("proxy").and_then(json_scalar_string),
    }
}

/// 解析本次拉起 orig-tg 要注入的凭据与代理。
///
/// 优先级：
/// - api_id / api_hash：`[tg]` 段显式配置 〉 `<数据目录>/tg/config.json`
///   （BUG-094：`download-engine.toml` 常常没有 `[tg]` 段，而桌面壳把凭据写在
///   `app_data_dir()/tg/config.json`，两边不同源会让拉起的实例永远无凭据）。
/// - proxy：仅 `[proxy]` 段为 custom 时用段内 url；否则回落 config.json 的 `proxy`
///   —— 语义与既有「非 custom 即不注入」一致，只是把「没有」换成「去壳侧那份里找」。
///
/// 纯函数（除了一次尽力而为的文件读取），不产生副作用、不打印内容。
pub fn resolve_tg_env(cfg: &Config, data_dir: &Path) -> TgLaunchEnv {
    let file = load_tg_file_credentials(data_dir);
    let pick = |from_cfg: &Option<String>, from_file: &Option<String>| -> Option<String> {
        from_cfg
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| from_file.clone())
    };
    let proxy = match cfg.proxy.mode {
        orig_core::protocol::ProxyMode::Custom => cfg
            .proxy
            .url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        _ => file.proxy.clone(),
    };
    TgLaunchEnv {
        api_id: pick(&cfg.tg_api_id, &file.api_id),
        api_hash: pick(&cfg.tg_api_hash, &file.api_hash),
        proxy,
    }
}

/// 定位稳定数据目录：桌面壳的真实数据在 `%APPDATA%\com.origadmin.orighub`（Tauri `app_data_dir()`），
/// 引擎旧默认回落 `%LOCALAPPDATA%\OrigHub` 只是个**空壳库**（store.db ~0.5MB，无真实条目）。
/// 若默认回落到空壳库，会出现「布局渲染正常、媒体库数据为空/异常」——正是用户报告的
/// 「静态布局通过、实际没有修复」。故未设 `ORIG_TG_DATA` 时**优先选真正含库数据**的目录，
/// 保证任何启动路径（桌面壳 / 调试 / 直接跑二进制）都落到同一份真实数据，落实「调试=生产同源」。
pub fn tg_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ORIG_TG_DATA") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    if cfg!(windows) {
        // 候选目录：桌面壳真实目录优先于旧默认空壳库；最终选**含库数据**的那个。
        let candidates: Vec<PathBuf> = vec![
            std::env::var("APPDATA").ok().map(|a| PathBuf::from(a).join("com.origadmin.orighub")),
            std::env::var("LOCALAPPDATA").ok().map(|l| PathBuf::from(l).join("OrigHub")),
        ]
        .into_iter()
        .flatten()
        .collect();
        for c in &candidates {
            if c.join("tg").join("store.db").exists() {
                return c.clone();
            }
        }
        // 都没有真实数据：保持旧默认（首次冷启动在此建库，行为不变）
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return PathBuf::from(local).join("OrigHub");
            }
        }
    } else if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("orighub");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".local/share/orighub");
        }
    }
    if let Ok(prof) = std::env::var("USERPROFILE") {
        if !prof.is_empty() {
            return PathBuf::from(prof).join(".local/share/orighub");
        }
    }
    // 兜底：相对路径也能用，但上游 daemon 侧一般已有稳定目录。
    PathBuf::from(".orighub")
}

/// 调试日志根目录（**单一路径真源**，BUG-243）：`<数据目录>/logs`。
///
/// 与 `tg_data_dir()` 同源 ⇒ 调试/生产/壳三方看到的是同一个目录，用户按
/// 设置-关于里给出的路径就能直接翻到日志，不需要问「日志在哪」。
///
/// 可被 `ORIG_LOG_DIR` 覆盖：dev 与 release 共用数据根时，若日志也同目录，
/// 两边的 `orig-tg.log` 会交错追加 —— 文件不会损坏（追加写），但排障时无法分辨
/// 某一行是谁写的，会把 release 的失败读成 dev 的、或反之。
pub fn log_dir() -> PathBuf {
    if let Ok(p) = std::env::var("ORIG_LOG_DIR") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    tg_data_dir().join("logs")
}

/// MTProto 会话文件路径（默认 `<数据目录>/tg/session.session`）。
///
/// **可被 `ORIG_TG_SESSION` 覆盖，且外部值优先。** 覆盖能力是「共用媒体库、
/// 互不影响」的硬前提：会话文件没有文件锁，两个 orig-tg 同时写入会损坏它；
/// 即便不损坏，同一 auth key 双连接也会被 Telegram 服务端互踢。因此 dev 栈必须
/// 用独立的会话文件（独立登录一次），不能与 release 共用。
///
/// 注意方向：这里是**读**外部 env 再**写**给子进程。此前是无条件覆盖，等于把
/// 外部配置静默丢弃 —— 那种实现下「设了 env 也不生效」，排查时极易误判成
/// 「env 没传进去」。
fn tg_session_path(data_dir: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("ORIG_TG_SESSION") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    data_dir.join("tg/session.session")
}

/// 媒体条目库路径（默认 `<数据目录>/tg/store.db`）。
///
/// 可被 `ORIG_TG_DB` 覆盖。默认不设 ⇒ dev 与 release 指向**同一个** store.db，
/// 这正是「库共用」想要的：dev 对真实数据调试，不会因为对着空壳库而把
/// 「数据为空」误判成「功能坏了」。
fn tg_db_path(data_dir: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("ORIG_TG_DB") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    data_dir.join("tg/store.db")
}

/// 单个日志文件的滚动上限（8 MiB，只留一代 `.1`）。
///
/// 为什么不无限追加：诊断价值集中在**最近一段**，而无限增长会持续吃用户磁盘 ——
/// 与「日志不得影响整体下载/播放」这条硬约束相悖。
const LOG_FILE_CAP_BYTES: u64 = 8 * 1024 * 1024;

/// 以追加方式打开 `logs/<name>`；超过上限先把现有文件滚成 `<name>.1`（只留一代）。
///
/// 打开失败一律返回 `None`：**日志永远不能让主流程失败**（磁盘满、目录只读都不能
/// 阻断下载/播放）。调用方把 `None` 当作「这次没记上」即可，不向上传播错误。
pub(crate) fn open_log_file(name: &str) -> Option<std::fs::File> {
    let dir = log_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let path = dir.join(name);
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_FILE_CAP_BYTES {
        let rolled = dir.join(format!("{name}.1"));
        let _ = std::fs::remove_file(&rolled);
        let _ = std::fs::rename(&path, &rolled);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

/// 守护进程自身生命周期日志（追加到 `logs/orig-daemon.log`）。
///
/// daemon 是 `windows_subsystem`，无控制台，所有「启动 / 子进程重启 / 停止 / 重部署」
/// 提示必须落文件才能被用户或 AI 读到 —— 对应「启动内容要有明确提示」「服务提示被杀」。
/// 失败（磁盘满等）静默返回，**绝不影响主流程**。
pub(crate) fn daemon_log(msg: &str) {
    if let Some(mut f) = open_log_file("orig-daemon.log") {
        let _ = f.write_all(format!("[orig-daemon] {msg}\n").as_bytes());
    }
}

/// 重部署握手信号（与 `scripts/dev_services.py` 约定同一临时目录）。
///
/// 协议（全由 AI 经 dev_services 触发，**非自治**）：
///   - `orighub-redeploy-request`  AI 写 → daemon 停 orig-tg、写 `…-stopped`（可安全构建）、进入 hold；
///   - `orighub-redeploy-built`    AI 写（构建后）→ daemon 重启 orig-tg（拾取新二进制）、写 `…-done`、退出 hold；
///   - hold 期间 daemon **抑制**对 orig-tg 的自愈，避免与 cargo build 抢进程（exe 被锁会 os error 5）。
///
/// daemon 自身（不是子进程）的二进制更新仍需「杀 daemon → 重建 → 用户重启」，
/// 对应「启动服务→开发 kill→服务提示被杀→用户再启动」。
const REDEPLOY_REQ: &str = "orighub-redeploy-request";
const REDEPLOY_BUILT: &str = "orighub-redeploy-built";
const REDEPLOY_STOPPED: &str = "orighub-redeploy-stopped";
const REDEPLOY_DONE: &str = "orighub-redeploy-done";

fn redeploy_signal_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(name)
}
fn redeploy_signal_exists(name: &str) -> bool {
    redeploy_signal_path(name).exists()
}
fn write_redeploy_signal(name: &str) {
    let _ = std::fs::write(redeploy_signal_path(name), b"");
}
fn remove_redeploy_signal(name: &str) {
    let _ = std::fs::remove_file(redeploy_signal_path(name));
}

/// 启动时清理遗留的重部署握手信号，避免上次 AI 崩溃留下的 `request` 让新 daemon 一开机就停 tg。
pub(crate) fn clear_stale_redeploy_signals() {
    for n in [REDEPLOY_REQ, REDEPLOY_BUILT, REDEPLOY_STOPPED, REDEPLOY_DONE] {
        remove_redeploy_signal(n);
    }
}

/// 把 Unix 秒格式化为 `YYYY-MM-DDTHH:MM:SSZ`（UTC）。
///
/// 不引日期库：本 crate 只需一个诊断时间戳，`civil_from_days`（Howard Hinnant
/// 的日历算法）十几行就够，不值得为日志加一个 chrono 依赖。
pub(crate) fn fmt_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    if mth <= 2 {
        y += 1;
    }
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// 当前 Unix 秒（本地小工具，避免与 `routes::now_secs` 形成跨模块耦合）。
fn epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 记录一条**核心错误**到 `logs/errors.log`（append-only，超限滚动一代）。
///
/// 「核心错误」= 用户可感知且事后需要排查的失败（服务拉不起来、链路断、端点拒绝），
/// **不是逐请求流水** —— 逐请求写盘会把日志变成 IO 热点，违背「不影响下载/播放性能」。
/// 因此本函数只在失败路径上被调用（当前唯一入口是 `set_tg_last_error`）。
pub(crate) fn append_error_log(msg: &str) {
    use std::io::Write;
    if let Some(mut f) = open_log_file("errors.log") {
        let _ = writeln!(f, "{} {}", fmt_utc(epoch_secs()), msg);
    }
}

/// 定位 orig-tg 可执行文件：`ORIG_TG_PATH` 优先，其次当前 exe 同目录，最后回退裸名。
pub fn tg_binary_path() -> PathBuf {
    if let Ok(p) = std::env::var("ORIG_TG_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "orig-tg.exe" } else { "orig-tg" };
            return dir.join(name);
        }
    }
    PathBuf::from("orig-tg")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一份最小 AppState（无托管子进程、默认配置）。
    fn test_state() -> AppState {
        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        AppState::new(0, Registry::new(), tx, Config::default(), None)
    }

    /// 借内核分配一个**当前空闲**的端口号（bind 后立刻释放）。
    async fn free_port() -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    }

    #[test]
    fn tg_data_dir_is_absolute_and_creatable() {
        // 注入可控的稳定目录，避免读写真实用户目录。
        let probe = std::env::temp_dir().join(format!("orighub-test-{}", std::process::id()));
        std::env::set_var("ORIG_TG_DATA", &probe);

        let dir = tg_data_dir();
        // 校验返回绝对路径且命中所注入的目录。
        assert!(dir.is_absolute(), "tg_data_dir() must be absolute");

        // 父目录可创建。
        let child = dir.join("tg/session.session");
        let parent = child.parent().unwrap();
        std::fs::create_dir_all(parent).unwrap();
        assert!(parent.is_dir(), "parent dir must be creatable");

        let _ = std::fs::remove_dir_all(&probe);
        std::env::remove_var("ORIG_TG_DATA");
    }

    /// 默认（无 `ORIG_TG_DATA`）必须落到**真正含库数据**的目录，
    /// 而不是盲目回落到空壳 `%LOCALAPPDATA%\OrigHub`。这是「静态布局通过、实际没修复」
    /// 的根因修复的回归护栏：引擎旧默认回落到空壳库，媒体库布局渲染正常但数据为空/异常。
    #[test]
    #[cfg(windows)]
    fn tg_data_dir_prefers_dir_with_data() {
        let base = std::env::temp_dir().join(format!("orighub-pref-{}-{}", std::process::id(), "x"));
        let real = base.join("appdata").join("com.origadmin.orighub");
        let legacy = base.join("local").join("OrigHub");
        std::fs::create_dir_all(real.join("tg")).unwrap();
        std::fs::create_dir_all(legacy.join("tg")).unwrap();
        // 仅 real 含 store.db → 应被优先选中，legacy 即使存在也不该被选中
        std::fs::write(real.join("tg").join("store.db"), b"x").unwrap();

        let prev_orig = std::env::var("ORIG_TG_DATA").ok();
        let prev_app = std::env::var("APPDATA").ok();
        let prev_local = std::env::var("LOCALAPPDATA").ok();
        std::env::remove_var("ORIG_TG_DATA");
        std::env::set_var("APPDATA", base.join("appdata"));
        std::env::set_var("LOCALAPPDATA", base.join("local"));

        let dir = tg_data_dir();

        if let Some(v) = prev_orig {
            std::env::set_var("ORIG_TG_DATA", v);
        } else {
            std::env::remove_var("ORIG_TG_DATA");
        }
        if let Some(v) = prev_app {
            std::env::set_var("APPDATA", v);
        } else {
            std::env::remove_var("APPDATA");
        }
        if let Some(v) = prev_local {
            std::env::set_var("LOCALAPPDATA", v);
        } else {
            std::env::remove_var("LOCALAPPDATA");
        }

        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(
            dir, real,
            "default resolution must prefer the dir that holds store.db, not the empty legacy dir"
        );
    }

    #[tokio::test]
    async fn port_probe_detects_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(
            tg_port_has_listener(port).await,
            "端口上有监听者时应探测为真"
        );
    }

    #[tokio::test]
    async fn port_probe_reports_false_when_idle() {
        let port = free_port().await; // 已释放，无人监听
        assert!(
            !tg_port_has_listener(port).await,
            "空闲端口不应被判为有监听者（否则会误判成 TG 已启动）"
        );
    }

    /// BUG-178：选端口必须**真能绑**，不能只看「有没有人监听」。
    ///
    /// 有牙：把起点端口占住，若实现直接返回起点（旧行为），返回值就是被占端口 → FAIL。
    #[tokio::test]
    async fn select_bindable_port_skips_occupied_port() {
        let taken = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = taken.local_addr().unwrap().port();

        let picked = select_bindable_port(port).await.expect("应当能找到可绑定端口");
        assert_ne!(
            picked, port,
            "起点端口被占用时必须顺延（修前恒返回起点 → 子进程 bind 失败）"
        );
        assert!(
            port_bindable(picked).await,
            "选出的端口必须真的可绑定：{picked}"
        );
    }

    /// BUG-178：拉起前重选端口要落地到 state（`/api/config` 的 `tg_port` 读它）。
    ///
    /// 有牙：起点被占时若 `tg_reselect_port` 不换端口，`tg_port_state()` 仍是被占端口。
    #[tokio::test]
    async fn reselect_port_moves_off_unbindable_start() {
        let taken = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = taken.local_addr().unwrap().port();
        // 起点从被占端口开始（`tg_port()` 读该 env）。
        std::env::set_var("ORIG_TG_PORT", port.to_string());

        let st = test_state();
        assert_eq!(st.tg_port_state(), port, "前置条件：初始端口取 env 起点");
        let picked = st.tg_reselect_port().await;
        assert_ne!(picked, port, "起点不可绑定时必须顺延");
        assert_eq!(st.tg_port_state(), picked, "选定结果必须落进 state（真源）");

        std::env::remove_var("ORIG_TG_PORT");
    }

    /// BUG-178：链路巡检的判据必须把「没配凭证」与「真断了」分开。
    ///
    /// 有牙：若实现只看 `available`，第一种（未配置）也会被判成不健康 → 用户每 5 分钟
    /// 被重启一次，配置页刚填的凭证永远走不完登录。
    #[test]
    fn link_health_distinguishes_missing_credentials_from_real_outage() {
        let unconfigured = serde_json::json!({"available": false, "api_configured": false});
        assert!(
            tg_link_healthy_from(&unconfigured),
            "未配置凭证是待办不是故障：不该触发自动重启"
        );
        let down = serde_json::json!({"available": false, "api_configured": true});
        assert!(
            !tg_link_healthy_from(&down),
            "已配凭证却连不上 = 真故障，必须重启才可能恢复"
        );
        let ok = serde_json::json!({"available": true, "api_configured": true});
        assert!(tg_link_healthy_from(&ok), "可用时不该重启");
    }

    /// BUG-351：链路 down 必须**连续确认**才重启 —— 一次瞬时 false 就杀进程是
    /// 最重的处置（会话重建 + 缓存队列 re-queue + 用户可见中断）。
    ///
    /// 有牙：若判据退回「一次 down 即重启」（`streak >= 1`），第 1/2 轮的断言立刻转红，
    /// 正是真机 477 次重启风暴的成因。
    #[test]
    fn link_down_requires_consecutive_confirmations() {
        assert!(
            !link_down_confirmed(0),
            "健康（streak=0）不该重启"
        );
        assert!(
            !link_down_confirmed(1),
            "第 1 轮 down 只可能是抖动：不该重启（BUG-351 的根因）"
        );
        assert!(
            !link_down_confirmed(TG_LINK_DOWN_CONFIRMS - 1),
            "未达阈值前一律继续确认"
        );
        assert!(
            link_down_confirmed(TG_LINK_DOWN_CONFIRMS),
            "达到阈值（持续约 45s 不可用）= 真断了，必须自愈"
        );
        assert!(link_down_confirmed(TG_LINK_DOWN_CONFIRMS + 5), "超过阈值同样确认");
    }

    /// BUG-351：链路重启必须**对外可见** —— 界面此前只有瞬时 `tg_running`，
    /// 于是「系统每 5 分钟重启一次」在关于页完全看不到。
    #[test]
    fn link_status_exposes_restart_history() {
        let st = test_state();
        let fresh = st.tg_link_status();
        assert_eq!(fresh["restarts"], 0, "刚启动：零重启");
        assert_eq!(fresh["link_down"], false, "刚启动：未判不可用");
        assert_eq!(
            fresh["confirms_required"], TG_LINK_DOWN_CONFIRMS,
            "阈值必须随状态下发，界面才能解释「为什么还没重启」"
        );

        // 模拟巡检：连续 2 轮 down（未达阈值）→ link_down=true 但仍未重启。
        st.tg_link_down_streak.store(2, Ordering::SeqCst);
        *st.tg_last_link_down_reason.write().unwrap() = Some("telegram link unavailable".into());
        let mid = st.tg_link_status();
        assert_eq!(mid["link_down"], true, "down 必须如实下发（不是等重启了才说）");
        assert_eq!(mid["down_streak"], 2);
        assert_eq!(mid["restarts"], 0, "未达阈值 ⇒ 还没重启过");

        // 处置完成：计一次重启 + 记墙钟 + 重新从 0 累积。
        st.tg_link_down_streak.store(0, Ordering::SeqCst);
        st.tg_link_restarts.fetch_add(1, Ordering::SeqCst);
        *st.tg_last_link_restart_at.write().unwrap() = Some(chrono_like_epoch_secs());
        let after = st.tg_link_status();
        assert_eq!(after["restarts"], 1, "重启次数必须累计并下发");
        assert!(after["last_restart_at"].as_i64().unwrap_or(0) > 0, "最近重启时间必须下发");
        assert_eq!(after["link_down"], false, "重启后重新累积 ⇒ 不再报 down");
    }

    /// BUG-091 的实测矛盾态：9877 确实在跑（外部/遗留实例），但本进程没有子进程句柄，
    /// `/api/config` 于是回 `tg_running=false` —— 用户点「启动 TG」会 spawn 出第二个。
    #[tokio::test]
    async fn start_skips_spawn_when_port_occupied_without_child_handle() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let st = test_state();
        assert!(
            st.tg_child.lock().await.is_none(),
            "前置条件：没有托管子进程句柄"
        );

        // 端口被占用 → 应判为「已在运行」……
        assert!(
            st.tg_is_running_on(port).await,
            "端口有监听者时必须判为运行中（修前只查句柄 → false）"
        );

        // ……且不得 spawn 第二个进程。
        assert_eq!(
            st.tg_start_on(port).await.unwrap(),
            true,
            "端口已占用时 tg_start 应返回 true 而不报错"
        );
        assert!(
            st.tg_child.lock().await.is_none(),
            "端口已占用时绝不能再 spawn 子进程（双进程 / bind 失败的根因）"
        );
    }

    /// BUG-094：造一个临时数据目录 + `tg/config.json`（假凭据），断言解析结果被采纳。
    #[test]
    fn tg_credentials_fall_back_to_config_json() {
        let dir = std::env::temp_dir().join(format!("orig-daemon-tgcred-{}", std::process::id()));
        let tg = dir.join("tg");
        std::fs::create_dir_all(&tg).unwrap();
        std::fs::write(
            tg.join("config.json"),
            r#"{"api_id":123456,"api_hash":"deadbeef","proxy":"socks5://127.0.0.1:7897"}"#,
        )
        .unwrap();

        // `download-engine.toml` 无 [tg] 段（Config::default() 即该形态）。
        let env = resolve_tg_env(&Config::default(), &dir);
        assert_eq!(env.api_id.as_deref(), Some("123456"), "api_id 应从 config.json 回退取得");
        assert_eq!(env.api_hash.as_deref(), Some("deadbeef"), "api_hash 应从 config.json 回退取得");
        assert_eq!(
            env.proxy.as_deref(),
            Some("socks5://127.0.0.1:7897"),
            "非 custom 代理模式下应回退 config.json 的 proxy"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// BUG-094：凭据文件缺失 / 非法时**不得 panic**，按「无凭据」继续。
    #[test]
    fn tg_credentials_missing_or_invalid_is_empty() {
        let dir = std::env::temp_dir().join(format!("orig-daemon-tgcred-miss-{}", std::process::id()));
        let tg = dir.join("tg");
        std::fs::create_dir_all(&tg).unwrap();

        // 1) 文件不存在
        let env = resolve_tg_env(&Config::default(), &dir);
        assert_eq!(env, TgLaunchEnv::default(), "文件缺失时不得 panic，应为全 None");

        // 2) JSON 非法
        std::fs::write(tg.join("config.json"), "{not-json").unwrap();
        let env = resolve_tg_env(&Config::default(), &dir);
        assert_eq!(env, TgLaunchEnv::default(), "JSON 非法时不得 panic，应为全 None");

        // 3) 字段缺失（合法 JSON 但没有凭据字段）
        std::fs::write(tg.join("config.json"), r#"{"other":1}"#).unwrap();
        let env = resolve_tg_env(&Config::default(), &dir);
        assert_eq!(env, TgLaunchEnv::default(), "字段缺失时不得 panic，应为全 None");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反向守卫：`[tg]` 段 / custom 代理一旦显式配置，必须**压过** config.json，
    /// 否则会把「用户在 toml 里改了凭据」悄悄改回旧值。
    #[test]
    fn explicit_config_wins_over_config_json() {
        let dir = std::env::temp_dir().join(format!("orig-daemon-tgcred-cfg-{}", std::process::id()));
        let tg = dir.join("tg");
        std::fs::create_dir_all(&tg).unwrap();
        std::fs::write(
            tg.join("config.json"),
            r#"{"api_id":123456,"api_hash":"deadbeef","proxy":"socks5://127.0.0.1:7897"}"#,
        )
        .unwrap();

        let mut cfg = Config::default();
        cfg.tg_api_id = Some("999".into());
        cfg.tg_api_hash = Some("fff".into());
        cfg.proxy.mode = orig_core::protocol::ProxyMode::Custom;
        cfg.proxy.url = Some("http://127.0.0.1:8080".into());

        let env = resolve_tg_env(&cfg, &dir);
        assert_eq!(env.api_id.as_deref(), Some("999"));
        assert_eq!(env.api_hash.as_deref(), Some("fff"));
        assert_eq!(env.proxy.as_deref(), Some("http://127.0.0.1:8080"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反向守卫：端口空闲 + 无句柄时才允许走 spawn 路径。
    /// 这里不真 spawn（那样依赖 orig-tg 二进制是否存在），只断言探测为「未运行」。
    #[tokio::test]
    async fn not_running_when_idle_port_and_no_child() {
        let port = free_port().await;
        let st = test_state();
        assert!(
            !st.tg_is_running_on(port).await,
            "端口空闲且无托管句柄时应判为未运行（放行 spawn）"
        );
    }
}
