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
/// daemon 默认监听端口。
const DAEMON_PORT: u16 = 9876;

struct DaemonState {
    /// 由本外壳拉起的 daemon 子进程句柄（复用已运行实例时为 None）。
    child: Mutex<Option<CommandChild>>,
}

/// 检查 daemon 是否真正可用：TCP 能连上且 GET /health 返回 200。
/// 只做端口连通性检查会漏掉"进程活着但 handler 已坏"的情况（前端 Failed to fetch）。
fn daemon_alive() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{DAEMON_PORT}").parse().unwrap(),
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
    let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{DAEMON_PORT}\r\nConnection: close\r\n\r\n");
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

/// 用 Tauri sidecar 拉起 daemon（阻塞直到端口就绪或超时）。
fn spawn_daemon(app: &tauri::AppHandle) -> Result<CommandChild, String> {
    let sidecar = app
        .shell()
        .sidecar(DAEMON_BIN)
        .map_err(|e| format!("sidecar resolve failed: {e}"))?;
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    // 等待端口就绪（最多 5s）
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if daemon_alive() {
            return Ok(child);
        }
        std::thread::sleep(Duration::from_millis(100));
        // 消费子进程输出，避免管道阻塞
        let _ = rx.try_recv();
    }
    Err("daemon did not become ready within 5s".into())
}

/// 前端查询：daemon 是否存活 + 端口。
#[tauri::command]
fn daemon_status(state: tauri::State<'_, DaemonState>) -> serde_json::Value {
    let alive = daemon_alive();
    let owned = state.child.lock().unwrap().is_some();
    serde_json::json!({
        "alive": alive,
        "port": DAEMON_PORT,
        "managed": owned,
    })
}

/// 前端命令：确保 daemon 运行（幂等）。
/// 若端口被占用但 /health 不可用（进程活着但 handler 坏了），
/// 先杀掉旧实例再拉起新实例，避免前端 Failed to fetch。
#[tauri::command]
fn ensure_daemon(app: tauri::AppHandle, state: tauri::State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    eprintln!("[ensure_daemon] called");
    let alive = daemon_alive();
    let mut need_kill = false;
    if alive {
        // 仅当 9876 上的监听进程确为本外壳对应的 orig-daemon 时才复用；
        // 否则（如改名前残留的旧 surge-daemon）杀掉并重新拉起，避免“还是旧的”。
        if port_owner_is_daemon() {
            eprintln!("[ensure_daemon] alive=true, reusing our daemon");
            return Ok(serde_json::json!({"started": false, "reason": "already-running"}));
        }
        eprintln!("[ensure_daemon] alive=true but owner mismatch, will kill stale");
        need_kill = true;
    } else {
        eprintln!("[ensure_daemon] alive=false, checking port");
        // 端口被占但 health 不可用 → 杀掉旧 daemon（无论是否由本外壳托管）
        let port_busy = TcpStream::connect_timeout(
            &format!("127.0.0.1:{DAEMON_PORT}").parse().unwrap(),
            Duration::from_millis(300),
        )
        .is_ok();
        if port_busy {
            eprintln!("[ensure_daemon] port busy, will kill owner");
            need_kill = true;
        }
    }
    if need_kill {
        eprintln!("[ensure_daemon] killing port owner");
        kill_port_owner(DAEMON_PORT);
        // 等端口释放
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if TcpStream::connect_timeout(
                &format!("127.0.0.1:{DAEMON_PORT}").parse().unwrap(),
                Duration::from_millis(200),
            )
            .is_err()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // 无论是否释放都继续尝试拉起；若没杀掉则 spawn 会失败报错
    }
    eprintln!("[ensure_daemon] spawning daemon");
    let child = spawn_daemon(&app)?;
    eprintln!("[ensure_daemon] daemon spawned ok");
    *state.child.lock().unwrap() = Some(child);
    Ok(serde_json::json!({"started": true, "port": DAEMON_PORT}))
}

/// 返回 9876 上的监听进程是否确为本外壳对应的 orig-daemon（按可执行文件名判断）。
/// 用于避免复用改名前残留的旧 daemon（如 surge-daemon）。
fn port_owner_is_daemon() -> bool {
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
                    .find(|l| l.contains("LISTENING") && l.contains(&format!(":{DAEMON_PORT}")))
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
            .args(["-ti", &format!("tcp:{DAEMON_PORT}")])
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

/// 侧边进程名（与 tauri.conf.json externalBin 对应）。
const TG_BIN: &str = "orig-tg";
/// orig-tg 默认监听端口。
const TG_PORT: u16 = 9877;

struct TgState {
    /// 由本外壳拉起的 orig-tg 子进程句柄（复用已运行实例时为 None）。
    child: Mutex<Option<CommandChild>>,
}

/// 检查 orig-tg 是否真正可用：TCP 连上且 GET /health 返回 200。
fn tg_alive() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{TG_PORT}").parse().unwrap(),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    stream.set_read_timeout(Some(Duration::from_millis(800))).ok();
    stream.set_write_timeout(Some(Duration::from_millis(800))).ok();
    let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{TG_PORT}\r\nConnection: close\r\n\r\n");
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

/// 检查 9877 上的服务是否为「可用且非合成」的实例。
///
/// 契约（orig-tg `/api/tg/diag`）：`available` + `mode` + `mock`。
/// 端口活着但 `available=false`（无凭证 / MTProto 连不上）或 `mock=true` 的实例一律视为无效，
/// 需要杀掉重拉 —— 否则用户会在一个「假装可用」的客户端上走登录，验证码永远收不到。
fn tg_service_real() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{TG_PORT}").parse().unwrap(),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok();
    stream.set_write_timeout(Some(Duration::from_millis(800))).ok();
    let req = format!("GET /api/tg/diag HTTP/1.1\r\nHost: 127.0.0.1:{TG_PORT}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    // BUG-023 后语义：`api_mode:"real"` 字符串已不存在，改用可用性契约判定。
    // mock=true 也判为无效 —— 合成实例绝不能被桌面壳当成可服务实例接受。
    let available = text.contains("\"available\":true") || text.contains("\"available\": true");
    let mock = text.contains("\"mock\":true") || text.contains("\"mock\": true");
    available && !mock
}

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

/// 拉起 orig-tg sidecar（凭证/路径全部注入 env），阻塞直到 health 就绪。
fn spawn_tg(app: &tauri::AppHandle) -> Result<CommandChild, String> {
    let cfg = read_tg_config(app)?.ok_or("not-configured")?;
    if cfg.api_id.trim().is_empty() || cfg.api_hash.trim().is_empty() {
        return Err("not-configured".into());
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tg");
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let dl_dir = data.join("downloads");
    std::fs::create_dir_all(&dl_dir).map_err(|e| e.to_string())?;

    let sidecar = app
        .shell()
        .sidecar(TG_BIN)
        .map_err(|e| format!("sidecar resolve failed: {e}"))?;
    let (mut rx, child) = sidecar
        .env("ORIG_TG_API_ID", cfg.api_id.trim())
        .env("ORIG_TG_API_HASH", cfg.api_hash.trim())
        .env(
            "ORIG_TG_SESSION",
            data.join("session.session").to_string_lossy().to_string(),
        )
        .env(
            "ORIG_TG_DB",
            data.join("store.db").to_string_lossy().to_string(),
        )
        .env(
            "ORIG_TG_DOWNLOAD_DIR",
            dl_dir.to_string_lossy().to_string(),
        )
        .env("ORIG_TG_PROXY", cfg.proxy.trim())
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        // 必须是「可用且非合成」才算就绪：凭证非法/网络不通时 orig-tg 会以
        // unavailable 态运行（诚实报 503），若只等 health 会假成功，
        // 用户将在不可用实例上走登录，验证码永远收不到。
        if tg_alive() && tg_service_real() {
            return Ok(child);
        }
        std::thread::sleep(Duration::from_millis(100));
        let _ = rx.try_recv();
    }
    Err("orig-tg did not become ready (available, non-mock) within 8s".into())
}

/// 前端查询：orig-tg 是否存活 + 端口 + 是否本壳托管。
#[tauri::command]
fn tg_status(state: tauri::State<'_, TgState>) -> serde_json::Value {
    serde_json::json!({
        "alive": tg_alive(),
        "port": TG_PORT,
        "managed": state.child.lock().unwrap().is_some(),
    })
}

/// 前端命令：保存配置并（重）启动 orig-tg。
#[tauri::command]
fn tg_save_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, TgState>,
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
    // 先停掉由本壳托管的实例与端口残留，再以新配置拉起。
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    kill_port_owner(TG_PORT);
    std::thread::sleep(Duration::from_millis(300));
    let child = spawn_tg(&app)?;
    *state.child.lock().unwrap() = Some(child);
    Ok(serde_json::json!({ "started": true, "port": TG_PORT }))
}

/// 前端命令：确保 orig-tg 运行（幂等）。未配置返回 Err("not-configured")。
#[tauri::command]
fn ensure_tg(app: tauri::AppHandle, state: tauri::State<'_, TgState>) -> Result<serde_json::Value, String> {
    if tg_alive() {
        if tg_service_real() {
            return Ok(serde_json::json!({ "started": false, "reason": "already-running" }));
        }
        // 端口活着但不可用/为合成实例（无凭证、连不上 TG 的残留等）→ 杀掉重拉，
        // 避免 APP 在不可用实例上走登录（验证码永远收不到）。
        eprintln!("[ensure_tg] alive but unavailable/mock, killing stale and respawning");
        kill_port_owner(TG_PORT);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if TcpStream::connect_timeout(
                &format!("127.0.0.1:{TG_PORT}").parse().unwrap(),
                Duration::from_millis(200),
            )
            .is_err()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    } else {
        // 端口残留（health 都不通的旧进程等）一律清掉，由壳统一托管。
        kill_port_owner(TG_PORT);
    }
    let child = spawn_tg(&app)?;
    *state.child.lock().unwrap() = Some(child);
    Ok(serde_json::json!({ "started": true, "port": TG_PORT }))
}

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
        .manage(TgState {
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
            tg_status,
            tg_save_config,
            ensure_tg
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
