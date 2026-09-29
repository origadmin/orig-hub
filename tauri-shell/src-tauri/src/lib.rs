//! Orig Hub — Tauri v2 桌面外壳。
//!
//! 职责：
//! - 拉起/管理 orig-daemon sidecar（Rust 下载内核，HTTP REST + SSE on 9876）
//! - 单实例锁 + 系统托盘
//! - 向前端暴露 daemon 状态查询命令

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// 侧边进程名（与 tauri.conf.json externalBin 对应）。
const DAEMON_BIN: &str = "orig-daemon";
/// daemon **起始**监听端口（不是"一定在这个端口"）。
///
/// 19786（原 9876）：9876 常被 Windows 划进动态保留区，bind 恒 `WSAEACCES`(10013)，
/// daemon 起不来 → 整个 APP 没有后端，而现象看着像「TG 不显示 / 数据没了」（BUG-178）。
/// daemon 自己会在 bind 失败时顺延，并把实际端口写进端点文件 / 经 `/api/config` 下发；
/// 这里只作为扫描起点与兜底。
const DAEMON_PORT: u16 = 19786;
/// 端口扫描上限（与 daemon 侧 `PORT_SCAN_LIMIT` 同序）。
const PORT_SCAN_LIMIT: u16 = 64;

struct DaemonState {
    /// 由本外壳拉起的 daemon 子进程句柄（复用已运行实例时为 None）。
    child: Mutex<Option<CommandChild>>,
}

/// daemon 端点文件（daemon 把自己实际监听地址写在这里）。
///
/// 为什么不以常量端口为准（BUG-178）：端口可能顺延，壳若继续认 9876 就会连到一个
/// 不存在（或属于别人）的服务上。写文件是唯一真源，扫端口只是它缺失时的兜底。
fn daemon_endpoint_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("daemon.endpoint"))
}

/// 读端点文件里的端口。
fn read_daemon_endpoint(app: &tauri::AppHandle) -> Option<u16> {
    let text = std::fs::read_to_string(daemon_endpoint_path(app)?).ok()?;
    text.rsplit(':').next()?.trim().parse::<u16>().ok()
}

/// 检查指定端口上的 daemon 是否真正可用：TCP 能连上且 GET /health 返回 200。
/// 只做端口连通性检查会漏掉"进程活着但 handler 已坏"的情况（前端 Failed to fetch）。
fn daemon_alive_on(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_millis(800)))
        .ok();
    // 最小 HTTP/1.1 GET /health，不引入额外依赖
    let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 512];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if n == 0 {
        return false;
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// 端口上是否有人监听（connect 探测，不含健康检查）。
fn port_busy(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// 解析 daemon 实际端口：端点文件优先（真源），否则从起始端口扫一个活着的。
fn resolve_daemon_port(app: &tauri::AppHandle) -> u16 {
    if let Some(p) = read_daemon_endpoint(app) {
        if daemon_alive_on(p) {
            return p;
        }
    }
    for offset in 0..PORT_SCAN_LIMIT {
        let p = DAEMON_PORT.saturating_add(offset);
        if p == 0 {
            break;
        }
        if daemon_alive_on(p) {
            return p;
        }
    }
    // 没有活着的：以端点文件（可能是上一次的）或起始端口作为"将要监听"的期望值。
    read_daemon_endpoint(app).unwrap_or(DAEMON_PORT)
}

/// 等端口真正释放（kill 之后）。
fn wait_port_free(port: u16) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if !port_busy(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 最小 HTTP POST（JSON 空体）：用于通知 daemon 重启它托管的 orig-tg。
///
/// 不引入 HTTP 客户端依赖：这里只需要一次本机回环调用。
fn http_post(path: &str, port: u16) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(500),
    )
    .map_err(|e| format!("connect daemon: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(3000)))
        .map_err(|e| e.to_string())?;
    let body = "{}";
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut out = String::new();
    stream.read_to_string(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// daemon 侧 TG 数据目录（BUG-094）。
///
/// daemon 的 `tg_data_dir()` 在未设 `ORIG_TG_DATA` 时回落 `%LOCALAPPDATA%\OrigHub`，
/// 与桌面壳真实会话目录 `app_data_dir()/tg` 分裂 —— 冷启动必然读不到已授权会话。
/// 这里把 `app_data_dir()` 注入给 daemon，让两边共用同一份会话与凭据。
///
/// **拼接口径（务必与 `orig-daemon::state::tg_data_dir()` 对齐）**：`tg_data_dir()`
/// 内部还会再 `join("tg/session.session")`，所以这里注入的是**父目录**
/// （`app_data_dir()`），**不是** `tg` 目录本身 —— 传成 `.../tg` 会拼出
/// `.../tg/tg/session.session`，那就是第三份分裂的会话。
fn daemon_tg_data_dir(app: &tauri::AppHandle) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    let s = dir.to_string_lossy().trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 用 Tauri sidecar 拉起 daemon（阻塞直到端口就绪或超时）。
///
/// 返回 `(子进程句柄, 实际端口)`：端口由 daemon 自己写在端点文件里，壳不猜。
fn spawn_daemon(app: &tauri::AppHandle) -> Result<(CommandChild, u16), String> {
    let sidecar = app
        .shell()
        .sidecar(DAEMON_BIN)
        .map_err(|e| format!("sidecar resolve failed: {e}"))?;
    // BUG-094：把壳侧的 TG 数据目录（父目录）交给 daemon，避免它自猜目录。
    let sidecar = match daemon_tg_data_dir(app) {
        Some(dir) => sidecar.env("ORIG_TG_DATA", dir),
        None => sidecar,
    };
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    // 等待就绪（最多 5s）：端点文件里的端口优先，其次扫起始段。
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if let Some(p) = read_daemon_endpoint(app) {
            if daemon_alive_on(p) {
                return Ok((child, p));
            }
        }
        for offset in 0..PORT_SCAN_LIMIT {
            let p = DAEMON_PORT.saturating_add(offset);
            if p == 0 {
                break;
            }
            if daemon_alive_on(p) {
                return Ok((child, p));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
        // 消费子进程输出，避免管道阻塞
        let _ = rx.try_recv();
    }
    Err("daemon did not become ready within 5s".into())
}

/// 前端查询：daemon 是否存活 + **实际**端口。
#[tauri::command]
fn daemon_status(app: tauri::AppHandle, state: tauri::State<'_, DaemonState>) -> serde_json::Value {
    let port = resolve_daemon_port(&app);
    let alive = daemon_alive_on(port);
    let owned = state.child.lock().unwrap().is_some();
    serde_json::json!({
        "alive": alive,
        "port": port,
        "managed": owned,
    })
}

/// 前端命令：确保 daemon 运行（幂等）。
/// 若端口被占用但 /health 不可用（进程活着但 handler 坏了），
/// 先杀掉旧实例再拉起新实例，避免前端 Failed to fetch。
#[tauri::command]
fn ensure_daemon(app: tauri::AppHandle, state: tauri::State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    eprintln!("[ensure_daemon] called");
    // 端口以 daemon 自己写下的为准（可能顺延），不是常量。
    let port = resolve_daemon_port(&app);
    let alive = daemon_alive_on(port);
    let mut need_kill = false;
    if alive {
        // 仅当该端口上的监听进程确为本外壳对应的 orig-daemon 时才复用；
        // 否则（如改名前残留的旧 surge-daemon）杀掉并重新拉起，避免“还是旧的”。
        if port_owner_is_daemon_on(port) {
            eprintln!("[ensure_daemon] alive=true on {port}, reusing our daemon");
            return Ok(serde_json::json!({"started": false, "reason": "already-running", "port": port}));
        }
        eprintln!("[ensure_daemon] alive=true but owner mismatch, will kill stale");
        need_kill = true;
    } else if port_busy(port) {
        // 端口被占但 health 不可用 → 杀掉占用者（无论是否由本外壳托管）
        eprintln!("[ensure_daemon] port {port} busy but unhealthy, will kill owner");
        need_kill = true;
    }
    if need_kill {
        eprintln!("[ensure_daemon] killing port owner");
        kill_port_owner(port);
        // 无论是否释放都继续尝试拉起；若没杀掉则 spawn 会失败报错
        wait_port_free(port);
    }
    eprintln!("[ensure_daemon] spawning daemon");
    let (child, actual) = spawn_daemon(&app)?;
    eprintln!("[ensure_daemon] daemon spawned ok on {actual}");
    *state.child.lock().unwrap() = Some(child);
    Ok(serde_json::json!({"started": true, "port": actual}))
}

/// 返回指定端口上的监听进程是否确为本外壳对应的 orig-daemon（按可执行文件名判断）。
/// 用于避免复用改名前残留的旧 daemon（如 surge-daemon）。
fn port_owner_is_daemon_on(port: u16) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let pid = Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：避免 GUI 主进程 spawn 控制台命令弹 Terminal 窗
            .output()
            .ok()
            .and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout);
                text.lines()
                    .find(|l| l.contains("LISTENING") && l.contains(&format!(":{port}")))
                    .and_then(|l| l.split_whitespace().last())
                    .and_then(|s| s.parse::<u32>().ok())
            });
        let pid = match pid {
            Some(p) => p,
            None => return false,
        };
        let out = Command::new("wmic")
            .args(["process", "where", &format!("ProcessId={pid}"), "get", "ExecutablePath"])
            .creation_flags(0x0800_0000)
            .output()
            .ok();
        if let Some(o) = out {
            let text = String::from_utf8_lossy(&o.stdout);
            for l in text.lines() {
                let t = l.trim();
                if t.to_lowercase().ends_with(".exe") {
                    if let Some(stem) = std::path::Path::new(t).file_stem() {
                        return stem.to_string_lossy().eq_ignore_ascii_case(DAEMON_BIN);
                    }
                }
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let out = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output()
            .ok();
        if let Some(o) = out {
            if let Some(pid) = String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .and_then(|l| l.trim().parse::<u32>().ok())
            {
                if let Ok(c) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
                    return c.trim().eq_ignore_ascii_case(DAEMON_BIN);
                }
            }
        }
        false
    }
}

/// 杀掉占用指定端口的进程（Windows: taskkill /PID，其他: kill）。
fn kill_port_owner(port: u16) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let out = Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output();
        if let Ok(out) = out {
            // 中文 Windows 的 netstat 输出含 GBK 字节，用 lossy 转换避免整段丢弃
            let text = String::from_utf8_lossy(&out.stdout);
                let mut pids = std::collections::HashSet::new();
                for line in text.lines() {
                    // 找 LISTENING 且本地端口匹配的行
                    if line.contains("LISTENING") && line.contains(&format!(":{port}")) {
                        if let Some(pid) = line.split_whitespace().last() {
                            if let Ok(pid) = pid.parse::<u32>() {
                                pids.insert(pid);
                            }
                        }
                    }
                }
                for pid in pids {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F"])
                        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                        .output();
                }
        }
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let out = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output();
        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if let Ok(pid) = line.trim().parse::<u32>() {
                    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
                }
            }
        }
    }
}

/// 前端命令：强制停止由本外壳管理的 daemon（未托管的不动）。
#[tauri::command]
fn stop_daemon(state: tauri::State<'_, DaemonState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// orig-tg sidecar（Telegram REST 服务，9877）：与 daemon 同模式由外壳托管。
// 凭证存 appDataDir/tg/config.json（APP 内配置一次，无需手动环境变量）；
// session/store/下载目录固定在 appDataDir/tg/ 下。
// ---------------------------------------------------------------------------

/// orig-tg 启动配置（APP 数据目录内，UI 配置一次）。
#[derive(serde::Serialize, serde::Deserialize)]
struct TgLaunchConfig {
    api_id: String,
    api_hash: String,
    #[serde(default = "default_tg_proxy")]
    proxy: String,
}

fn default_tg_proxy() -> String {
    "socks5://127.0.0.1:7897".into()
}

fn tg_config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tg")
        .join("config.json"))
}

/// 读取配置；文件不存在返回 None（= 未配置，前端出配置表单）。
fn read_tg_config(app: &tauri::AppHandle) -> Result<Option<TgLaunchConfig>, String> {
    let path = tg_config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

fn write_tg_config(app: &tauri::AppHandle, cfg: &TgLaunchConfig) -> Result<(), String> {
    let path = tg_config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// 前端命令：保存 Telegram 凭证（api_id / api_hash / 代理）。
///
/// **桌面壳不再自己拉起或杀死 orig-tg**（BUG-178）：进程生命周期归 daemon 独占 ——
/// 两个主人会互相 kill（壳的 `kill_port_owner` 曾直接杀掉 daemon 拉起的实例），
/// 而「谁去重启它」也就成了留给用户点的按钮，那是把系统的失职外包给用户。
///
/// 这里只做两件事：写 `tg/config.json`，然后请 daemon 重启它托管的实例
/// （凭证只在 orig-tg **启动时**读取，不重启等于改了个寂寞）。daemon 不在跑时
/// 只写文件 —— 它下次启动自然会带上新凭证。
#[tauri::command]
fn tg_save_config(
    app: tauri::AppHandle,
    api_id: String,
    api_hash: String,
    proxy: String,
) -> Result<serde_json::Value, String> {
    if api_id.trim().is_empty() || api_hash.trim().is_empty() {
        return Err("api_id / api_hash is empty".into());
    }
    write_tg_config(
        &app,
        &TgLaunchConfig {
            api_id: api_id.trim().into(),
            api_hash: api_hash.trim().into(),
            proxy: if proxy.trim().is_empty() { default_tg_proxy() } else { proxy.trim().into() },
        },
    )?;
    let port = resolve_daemon_port(&app);
    if !daemon_alive_on(port) {
        return Ok(serde_json::json!({ "saved": true, "restarted": false, "reason": "daemon-not-running" }));
    }
    match http_post("/api/tg/restart", port) {
        Ok(resp) => {
            let status = resp.lines().next().unwrap_or("").trim().to_string();
            // 409 = 插件未启用：凭证已存，启用开关时会带上。
            Ok(serde_json::json!({ "saved": true, "restarted": true, "daemon": status }))
        }
        Err(e) => Ok(serde_json::json!({ "saved": true, "restarted": false, "reason": e })),
    }
}

，好让 `setup` 阶段也能直接调用（BUG-094）。
///
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_single_instance::init(|app, _args, _cwd| {
                // 二次启动：聚焦已有主窗口
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }),
        )
        .manage(DaemonState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            // 系统托盘：显示主窗 / 退出
            use tauri::menu::{Menu, MenuItem};
            let show = MenuItem::with_id(app, "show", "显示 Orig Hub", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            let _ = _tray;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            ensure_daemon,
            stop_daemon,
            tg_save_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
