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
        use std::process::Command;
        let pid = Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
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
        use std::process::Command;
        let out = Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
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
        .invoke_handler(tauri::generate_handler![daemon_status, ensure_daemon, stop_daemon])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
