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

/// 桌面壳运行期 trace：**写文件**而不是只 eprintln。
///
/// release 构建带 `windows_subsystem = "windows"`（GUI 子系统、无控制台），
/// stderr 写入会被丢弃 —— 于是 daemon 生命周期这类关键事件在 release 下**完全不可见**，
/// 只能靠猜（2026-10-20 排查「APP 打开有问题」时踩到：stderr 空不代表没执行）。
/// 文件位置：`%TEMP%/orighub-shell-trace.log`（append，失败静默 —— trace 不能影响主流程）。
fn shell_trace(msg: &str) {
    eprintln!("{msg}");
    use std::io::Write;
    let path = std::env::temp_dir().join("orighub-shell-trace.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{stamp}] {msg}");
    }
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
///
/// ★ BUG-448：就绪等待的时限必须**大于 daemon 侧最长的启动阻塞**，否则「等得不够」
/// 会被读成「起不来」。原值是 5s，而 daemon 曾把 TG 插件拉起（上限
/// `TG_START_WAIT_TIMEOUT = 30s`，`state.rs:56`）挡在 `axum::serve` 之前 ⇒ 5 < 30，
/// 每次必然误判超时。daemon 侧已把插件移出就绪路径（`main.rs`），这里同时把
/// 时限提到 35s 作为**兜底**（防的是将来又有人在启动路径上加了慢动作）。
///
/// ★ 超时**必须杀掉子进程**。`CommandChild` 的 `Drop` 不杀进程：原实现返回 `Err`
/// 时只丢掉句柄，那个 daemon 会继续跑、稍后自己 bind 成功，而壳已不认识它
/// （`state.child` 仍是 `None`）；下次再 spawn 就变成两个 daemon 抢同一端口，
/// 后起者走 `bind_with_fallback` 的 `panic!`（`main.rs:46`）——用户看到「一开就死」。
const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(35);

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

    // 等待就绪：端点文件里的端口优先，其次扫起始段。
    let started = std::time::Instant::now();
    let deadline = started + DAEMON_READY_TIMEOUT;
    // 进度留痕的节流：每 500ms 一行，既能看到「等了多久」，又不会把日志刷满。
    let mut last_note = 0u64;
    while std::time::Instant::now() < deadline {
        if let Some(p) = read_daemon_endpoint(app) {
            if daemon_alive_on(p) {
                shell_trace(&format!(
                    "[ensure_daemon] daemon ready on {p} after {}ms",
                    started.elapsed().as_millis()
                ));
                return Ok((child, p));
            }
        }
        for offset in 0..PORT_SCAN_LIMIT {
            let p = DAEMON_PORT.saturating_add(offset);
            if p == 0 {
                break;
            }
            if daemon_alive_on(p) {
                shell_trace(&format!(
                    "[ensure_daemon] daemon ready on {p} after {}ms",
                    started.elapsed().as_millis()
                ));
                return Ok((child, p));
            }
        }
        // 消费子进程输出，避免管道阻塞（同时也是「进程是否已退出」的间接信号）
        let _ = rx.try_recv();
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if elapsed_ms >= last_note + 500 {
            last_note = elapsed_ms;
            shell_trace(&format!("[ensure_daemon] waiting for daemon… {elapsed_ms}ms"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // ★ 超时：先杀再报。不杀 = 留下一个「壳不认识但还活着」的 daemon。
    let pid = child.pid();
    match child.kill() {
        Ok(()) => shell_trace(&format!(
            "[ensure_daemon] spawn timeout after {}ms, killed pid={pid}",
            started.elapsed().as_millis()
        )),
        Err(e) => shell_trace(&format!(
            "[ensure_daemon] spawn timeout after {}ms, kill pid={pid} failed: {e}",
            started.elapsed().as_millis()
        )),
    }
    Err(format!(
        "daemon did not become ready within {}s (child killed)",
        DAEMON_READY_TIMEOUT.as_secs()
    ))
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
///
/// ★ BUG-448：`#[tauri::command(async)]` 不是装饰 —— 不加它，本函数在**主线程**执行，
/// 而它内部有 `spawn_daemon` 的就绪等待循环（`thread::sleep` × N 次 + 64 端口扫描）
/// 与 `netstat`/`tasklist` 进程 spawn。实测一次失败路径就冻结窗口 **5 秒**（旧时限），
/// 用户体感是「一开就死」。加上之后阻塞工作跑在运行时线程池，UI 照常响应。
#[tauri::command(async)]
fn ensure_daemon(app: tauri::AppHandle, state: tauri::State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    // 端口以 daemon 自己写下的为准（可能顺延），不是常量。
    let port = resolve_daemon_port(&app);
    let alive = daemon_alive_on(port);
    let busy = port_busy(port);
    let owner = if alive { port_owner_is_daemon_on(port) } else { None };
    shell_trace(&format!(
        "[ensure_daemon] port={port} alive={alive} busy={busy} owner={owner:?}"
    ));
    let mut need_kill = false;
    if alive {
        // 仅当该端口上的监听进程**确知**不是本外壳的 orig-daemon 时才杀。
        // `None`（判定不出）按「复用」处理：`/health` 已经 200，说明是本项目的
        // daemon；误杀健康实例会把 dev 栈/上一次 APP 的会话一起打断（实测事故，
        // 见 `port_owner_is_daemon_on` 文档），代价不对称。
        // 注意用上面算好的 `owner`，不再二次探测 —— 二次探测会让「同一决策读两个时刻」。
        match owner {
            Some(true) | None => {
                shell_trace(&format!("[ensure_daemon] reusing daemon on {port}"));
                return Ok(serde_json::json!({"started": false, "reason": "already-running", "port": port}));
            }
            Some(false) => {
                shell_trace(&format!(
                    "[ensure_daemon] alive but owner is not {DAEMON_BIN}, will kill stale"
                ));
                need_kill = true;
            }
        }
    } else if busy {
        // 端口被占但 health 不可用 → 杀掉占用者（无论是否由本外壳托管）
        shell_trace(&format!("[ensure_daemon] port {port} busy but unhealthy, will kill owner"));
        need_kill = true;
    }
    if need_kill {
        shell_trace(&format!("[ensure_daemon] killing port owner on {port}"));
        kill_port_owner(port);
        // 无论是否释放都继续尝试拉起；若没杀掉则 spawn 会失败报错
        wait_port_free(port);
    }
    shell_trace("[ensure_daemon] spawning daemon");
    let (child, actual) = spawn_daemon(&app)?;
    shell_trace(&format!("[ensure_daemon] daemon spawned ok on {actual}"));
    *state.child.lock().unwrap() = Some(child);
    Ok(serde_json::json!({"started": true, "port": actual}))
}

/// 前端探针：把消息写进壳侧 trace（`%TEMP%/orighub-shell-trace.log`）。
///
/// 存在理由：release 的 GUI 子系统丢弃 stderr，webview 内的 JS 报错也不外溢，
/// 「窗口在、进程活、界面白」这类问题在壳侧无法观测。前端在关键节点（入口脚本
/// 第一行、React 挂载后）调用它，壳就能知道 JS 到底跑到哪一步。
#[tauri::command]
fn shell_probe(msg: String) {
    shell_trace(&format!("[front] {msg}"));
}

/// 返回指定端口上的监听进程是否确为本外壳对应的 orig-daemon（按可执行文件名判断）。
///
/// **三态**：`Some(true)` = 是 daemon；`Some(false)` = 查到了、但不是；
/// `None` = **查不出**（取不到 pid，或系统工具不可用）。
///
/// 为什么必须三态（2026-10-20「APP 打开有问题」的根因修复）：
/// 旧实现用 `wmic` 取进程路径 —— wmic 自 Windows 11 22H2 起被微软弃用、默认不装，
/// 调用失败时旧实现返回 `false`，于是 `ensure_daemon` 把**健康的 daemon 判成
/// 「owner mismatch」并直接杀掉**。实测：打开 APP ⇒ dev 栈正在用的 daemon（19786）
/// 被 kill ⇒ 新 daemon 漂到 19787 ⇒ 端点文件被改写 ⇒ **APP 与 dev 同时不可用**
/// （用户报的「APP 打开有问题 / dev 挂」是同一根因的两个面）。
///
/// 现在改 `tasklist`（系统自带、无弃用风险），并把「查不出」与「不是」分开：
/// 查不出 ⇒ 交给调用方按「不杀」处理（`/health` 已 200，误杀代价远大于复用）。
fn port_owner_is_daemon_on(port: u16) -> Option<bool> {
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
            })?;
        // tasklist /FO CSV /NH：首列即映像名（"orig-daemon.exe"）。
        // 中文 Windows 的输出含 GBK 字节 ⇒ lossy 转换，避免整段丢弃。
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x0800_0000)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let first = text
            .lines()
            .next()?
            .split(',')
            .next()?
            .trim()
            .trim_matches('"')
            .to_string();
        // 「没有运行的任务匹配指定标准」等本地化提示行不是映像名 ⇒ 判定不了。
        if first.is_empty() || !first.to_lowercase().ends_with(".exe") {
            return None;
        }
        let stem = std::path::Path::new(&first)
            .file_stem()?
            .to_string_lossy()
            .to_string();
        Some(stem.eq_ignore_ascii_case(DAEMON_BIN))
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let out = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output()
            .ok()?;
        let pid = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()?
            .trim()
            .parse::<u32>()
            .ok()?;
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        Some(comm.trim().eq_ignore_ascii_case(DAEMON_BIN))
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
///
/// 桌面壳自 BUG-178 起不再自己拉起/杀死 orig-tg（进程生命周期归 daemon），
/// setup 阶段暂时没有调用点；保留它是配置读写的另一半（写侧 `write_tg_config`），
/// 免得下次要读时又去重拼一遍路径口径。
#[allow(dead_code)]
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

/// 桌面壳入口：装托盘、起 daemon、注册命令。
///
/// TG 配置读写提成独立函数（`read_tg_config` / `write_tg_config` / `tg_save_config`），
/// 好让 `setup` 阶段也能直接调用（BUG-094）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // BUG-446：release 壳「打开即无响应、WebView2 进程从未创建」在壳侧**完全不可观测**
    // （GUI 子系统丢弃 stderr，挂起时连一行日志都没有）。这两条 trace 是**判定边界**：
    //   有 `run() entered` 但**没有** `setup hook entered` ⇒ 主线程卡在
    //   `WebViewWindowBuilder::build()` 的 webview 创建里（tauri 2.11.5 在 setup
    //   **之前**创建配置窗口，见 `tauri::app::setup`）—— 即 WebView2 环境初始化，
    //   与本文件后续的 setup/托盘代码无关；反之则卡在启动更早的阶段。
    shell_trace("[shell] run() entered; building tauri app (windows are created before setup)");
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
            // BUG-446：能走到这里 = webview 已创建成功（tauri 先建窗口再跑 setup）。
            // 连它都没打印 ⇒ 挂起点在 WebView2 环境初始化，不在下面的托盘/命令注册。
            shell_trace(&format!(
                "[shell] setup hook entered (webview created); app_local_data_dir={:?}",
                app.path().app_local_data_dir().ok()
            ));
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
            shell_trace("[shell] setup complete (tray built)");

            Ok(())
        })
        .on_window_event(|app, event| {
            // BUG-452（2026-10-27 用户截图）：作为下载工具，点 X / 标题栏关闭应「最小化到托盘」，
            // 下载继续、托盘常驻、daemon 不杀。原实现缺 CloseRequested 处理 ⇒ 关最后窗口即
            // app.exit、托盘销毁、daemon 变孤儿（见 roadmap T-1「关窗不退出」）。
            //
            // 处理：拦截关闭、改 hide —— 进程不退出，前端与 daemon sidecar 继续存活。
            // 真正退出只走托盘「退出」菜单（app.exit(0) ⇒ RunEvent::ExitRequested，
            // 由 tauri-plugin-shell 的退出处理器杀掉托管的 sidecar）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                shell_trace(
                    "[on_window_event] CloseRequested → prevent_close + hide (tray resident, downloads continue)",
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            ensure_daemon,
            stop_daemon,
            tg_save_config,
            shell_probe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
