//! Orig Hub — Tauri v2 桌面外壳。
//!
//! 职责：
//! - 拉起/管理 surge-daemon sidecar（Rust 下载内核，HTTP REST + SSE on 9876）
//! - 单实例锁 + 系统托盘
//! - 向前端暴露 daemon 状态查询命令

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// 侧边进程名（与 tauri.conf.json externalBin 对应）。
const DAEMON_BIN: &str = "surge-daemon";
/// daemon 默认监听端口。
const DAEMON_PORT: u16 = 9876;

struct DaemonState {
    /// 由本外壳拉起的 daemon 子进程句柄（复用已运行实例时为 None）。
    child: Mutex<Option<CommandChild>>,
}

/// 检查 daemon 端口是否已有服务在跑。
fn daemon_alive() -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{DAEMON_PORT}").parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
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
#[tauri::command]
fn ensure_daemon(app: tauri::AppHandle, state: tauri::State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    if daemon_alive() {
        return Ok(serde_json::json!({"started": false, "reason": "already-running"}));
    }
    let child = spawn_daemon(&app)?;
    *state.child.lock().unwrap() = Some(child);
    Ok(serde_json::json!({"started": true, "port": DAEMON_PORT}))
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
