//! 守护进程共享状态。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use orig_core::engine::Task;
use orig_core::protocol::SseEvent;
use orig_core::registry::Registry;
use tokio::process::Child;
use tokio::sync::{broadcast, Mutex};

use crate::config::Config;

/// orig-tg 监听端口。**唯一真源**：拉起子进程时注入、聚合层拉取时引用，
/// 两处必须同源，否则「启在 9877、拉 9876」这类分叉又会重新长出来。
pub const TG_PORT: u16 = 9877;

/// 端口探测超时。无人监听时 connect 立即 ECONNREFUSED，这里的超时只是兜底
/// （防火墙静默丢包等极端情况不该挂住 `/api/config`）。
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// `tg_stop` 后等待子进程真正退出的上限（BUG-106）。
///
/// 目的是让 OS 释放 9877，避免紧接着的 `tg_start` 误判「端口有人」而跳过拉起。
/// kill 后正常退出是毫秒级；这里给足余量，超时也不阻塞调用方。
const TG_STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

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
    pub registry: Registry,
    /// 进行中的任务：id -> DownloadTask（Arc 共享，控制句柄在 Task 内）。
    pub tasks: Mutex<HashMap<String, DownloadTask>>,
    pub events: broadcast::Sender<SseEvent>,
    /// daemon 配置（RwLock：设置页可运行时更新自动分类规则）。
    pub config: RwLock<Config>,
    /// orig-tg 子进程句柄（TG 可选插件）。None = 未启动 / 已退出。
    pub tg_child: Mutex<Option<Child>>,
    /// 出向 HTTP 客户端（`/api/activity` 聚合层拉 orig-tg 用；见 `build_http_client`）。
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(registry: Registry, events: broadcast::Sender<SseEvent>, config: Config) -> Self {
        Self {
            registry,
            tasks: Mutex::new(HashMap::new()),
            events,
            config: RwLock::new(config),
            tg_child: Mutex::new(None),
            http: build_http_client(),
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

    /// orig-tg 是否存活（固定 `TG_PORT`）。
    pub async fn tg_is_running(&self) -> bool {
        self.tg_is_running_on(TG_PORT).await
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
        let mut cmd = tokio::process::Command::new(tg_binary_path());
        // 端口由入参决定（生产恒为 `TG_PORT`=9877，与 daemon 9876 分离）。
        // 凭据显式注入（不依赖父进程环境继承），保证 Tauri/开机重启后 real 模式仍生效；
        // `[tg]` 段为空时回退同目录 `tg/config.json`（BUG-094）。
        cmd.env("PORT", port.to_string());
        cmd.kill_on_drop(true);
        // 会话与监控库必须落到稳定数据目录，免得 orig-tg 用 CWD 相对的默认路径，
        // 每次启动 CWD 变化就新生成会话 → 反复登录。目录在注入前先确保存在。
        let data_dir = tg_data_dir();
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            return Err(e);
        }
        cmd.env("ORIG_TG_SESSION", data_dir.join("tg/session.session"));
        cmd.env("ORIG_TG_DB", data_dir.join("tg/store.db"));
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
        let child = cmd.spawn()?;
        *self.tg_child.lock().await = Some(child);
        Ok(true)
    }

    /// 拉起 orig-tg 子进程（固定 `TG_PORT`）。
    pub async fn tg_start(&self) -> std::io::Result<bool> {
        self.tg_start_on(TG_PORT).await
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
    }
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

/// 定位稳定数据目录：Windows 用 `%LocalAppData%\OrigHub`，否则 `$XDG_DATA_HOME` 或
/// `~/.local/share/orighub`。TG 会话/监控库统一落到该目录，与启动 CWD 无关。
pub fn tg_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ORIG_TG_DATA") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    if cfg!(windows) {
        if let Ok(app) = std::env::var("LOCALAPPDATA") {
            if !app.is_empty() {
                return PathBuf::from(app).join("OrigHub");
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
        AppState::new(Registry::new(), tx, Config::default())
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
