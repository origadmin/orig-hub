#!/usr/bin/env python3
"""OrigHub dev 栈手动入口 —— 由人控制，跑完即退，不留常驻进程。

## 与正式二进制的边界（本文件是 dev-only）

- 本目录 `scripts/dev/` 只回答「开发/测试时怎么起一套能验收的栈」，不链接进
  `orig-daemon` / `orig-tg` / Tauri 壳，不改变它们的任何运行时行为。
- 正式产物仍由 `cargo build --release` + `scripts/sync-sidecars.sh` 产生；本脚本
  只把顺序串对：**停旧 → 构建 → 同步 → 起新 → 核对跑的是不是新编译**。
- 不常驻、不自愈、不监控。起完就退出，进程交给人管。

## 为什么必须「先停再构建」

Windows 上正在运行的 `.exe` 被文件锁占住：`cargo build --release` 链接
`target/release/orig-daemon.exe` 会直接失败（Access is denied），
`sync-sidecars.sh` 的 `cp -f` 也会失败。所以构建前必须先停。

## 为什么必须「起完再核对进程 vs 二进制」

进程启动时间早于 exe 的 mtime ⇒ 它跑的是**旧编译**。这不是理论：上一轮实测
「6:10 启动、6:15 构建」，整场验收验的全是旧码。本脚本每次 `start` 都打印这条
判定，把「新旧冲突」变成可见的一行字，而不是靠记忆。

## 用法（全部一次性执行后退出）

    python scripts/dev/dev_stack.py status      # 只读诊断，不启动/不杀任何东西
    python scripts/dev/dev_stack.py stop        # 停 dev 进程（daemon + orig-tg + vite）
    python scripts/dev/dev_stack.py start       # 起（已有健康实例则复用；--force 先停再起）
    python scripts/dev/dev_stack.py restart     # = stop + start
    python scripts/dev/dev_stack.py build       # stop → cargo build → sync → 打印指纹
    python scripts/dev/dev_stack.py build-tg    # 同上，但只重建 orig-tg（改引擎更快）

退出码：0 = 目标状态达成；1 = 未达成（原因打印在最后）。
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

DEV_DIR = Path(__file__).resolve().parent
SCRIPTS = DEV_DIR.parent
REPO = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

# 复用既有启动器的 DETACHED 常量、探活与 daemon 拉起逻辑，避免两套实现漂移。
import dev_services as ds  # noqa: E402

# dev 栈端口刻意与 release 壳错开（壳从 19786 起扫 64 个，见 lib.rs DAEMON_PORT）。
#
# 为什么不能用 19786：壳的 `ensure_daemon` 一旦在 19786 发现健康 daemon 就直接复用，
# 于是 release 壳连的是 dev 的实例；dev 一停，APP 跟着没后端（lib.rs 注释记录的
# 2026-10-20 事故）。29786 落在壳的扫描区间（19786–19849）之外，两边互不可见。
DAEMON_PORT = 29786
TG_PORT = 29787
VITE_PORT = 5180
VITE_DIR = REPO / "tauri-shell"
ENGINE_DIR = REPO / "download-engine"
VITE_LOG = Path(os.environ.get("TEMP", str(REPO))) / "orighub-vite.log"

# **关键隔离**：dev 的运行二进制放在 cargo 输出目录之外的专用副本目录。
# `cargo build` 只写 `download-engine/target/release/*`；dev 进程跑 `target/dev-stack/*`
# ⇒ 构建再也锁不到运行中的 dev 进程，dev 不必为每次构建停栈（BUG-453 根因修复）。
# daemon 从副本目录启动后，会经 `tg_binary_path()` 用 `current_exe().parent()` 找到同目录的
# orig-tg（state.rs:1243），整条 dev 链自洽，且与 release 副本（target/release）完全无关。
DEV_BIN_DIR = ENGINE_DIR / "target" / "dev-stack"
# cargo 产物名（含 Tauri externalBin 用的 triple 变体，一并同步进位，保证两套构建口径一致）。
ENGINE_EXES = (
    "orig-daemon.exe",
    "orig-daemon-x86_64-pc-windows-msvc.exe",
    "orig-tg.exe",
    "orig-tg-x86_64-pc-windows-msvc.exe",
)


def ensure_dev_bins(force: bool = False) -> list[tuple[str, bool, str | None]]:
    """把 cargo 产物复制到 dev 专用副本目录。返回 (文件名, 是否成功, 失败原因)。

    - 已有且不旧时跳过（除非 force）。
    - 运行中文件被锁（PermissionError）→ 跳过并记录，不视为失败（热更新路径稍后处理）。
    """
    DEV_BIN_DIR.mkdir(parents=True, exist_ok=True)
    out: list[tuple[str, bool, str | None]] = []
    for name in ENGINE_EXES:
        src = REPO / "download-engine/target/release" / name
        dst = DEV_BIN_DIR / name
        if not src.is_file():
            continue
        if not force and dst.is_file() and src.stat().st_mtime <= dst.stat().st_mtime + 1.0:
            continue
        try:
            shutil.copy2(src, dst)
            out.append((name, True, None))
        except (OSError, PermissionError) as e:
            out.append((name, False, str(e)))
    return out

# 四处副本（与 sync-sidecars.sh 的清单一致；这里只用于展示指纹，不做写入）。
COPIES = (
    "download-engine/target/release/orig-daemon.exe",
    "download-engine/target/release/orig-daemon-x86_64-pc-windows-msvc.exe",
    "download-engine/target/release/orig-tg.exe",
    "download-engine/target/release/orig-tg-x86_64-pc-windows-msvc.exe",
    "tauri-shell/src-tauri/target/debug/orig-tg.exe",
    "tauri-shell/src-tauri/target/release/orig-tg.exe",
)


def dev_runtime_env(data_dir: Path) -> dict[str, str]:
    """dev 栈相对 release 壳需要分离的运行态。

    **共用**（刻意不覆盖）：`ORIG_TG_DATA` 指向同一数据根 ⇒ `tg/store.db`、下载的
    媒体文件、`download-engine.toml` 两边看到的是同一份。dev 对真实数据调试，
    不会因为对着空壳库而把「数据为空」误判成「功能坏了」（state.rs 里记着这条教训）。

    **分离**（必须，否则互相踩）：

    - `ORIG_DAEMON_PORT` / `ORIG_TG_PORT`：壳从 19786 起扫，dev 必须错开。
    - `ORIG_DAEMON_ENDPOINT_FILE`：端点文件是壳的端口真源，同名会互相覆盖 ⇒ 连错实例。
    - `ORIG_ENGINE_TASKS_DB`：任务列表是运行态，共用会让 dev 的测试任务出现在
      release 列表里，进度也会互相覆盖。
    - `ORIG_TG_SESSION`：dev 与 release **共用真实会话** `tg/session.session`（同一份登录
      凭证），不做分离。避免 dev 永远停在 Anonymous、"TG 未绑定" 的假死态。
    - `ORIG_LOG_DIR`：日志同目录会交错追加，排障时分不清某行是谁写的。
    """
    return {
        "ORIG_DAEMON_PORT": str(DAEMON_PORT),
        "ORIG_TG_PORT": str(TG_PORT),
        "ORIG_DAEMON_ENDPOINT_FILE": str(data_dir / "daemon.dev.endpoint"),
        "ORIG_ENGINE_TASKS_DB": str(data_dir / "engine_tasks.dev.db"),
        "ORIG_TG_SESSION": str(data_dir / "tg" / "session.session"),
        "ORIG_LOG_DIR": str(data_dir / "logs" / "dev"),
    }


# ── 基础工具 ──────────────────────────────────────────────────────────────


def fmt_time(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def file_fingerprint(path: Path) -> dict | None:
    try:
        st = path.stat()
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return {"path": str(path), "mtime": st.st_mtime, "size": st.st_size, "sha12": h.hexdigest()[:12]}
    except OSError:
        return None


def port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.6) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def pid_on_port(port: int) -> int | None:
    """从 netstat 取监听该端口的 pid。Windows netstat 输出是 GBK。"""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"], capture_output=True, encoding="gbk", errors="replace"
        ).stdout
    except OSError:
        return None
    for line in out.splitlines():
        cols = line.split()
        if len(cols) < 5:
            continue
        local, state, pid = cols[1], cols[3], cols[4]
        if state == "LISTENING" and local.rsplit(":", 1)[-1] == str(port) and pid.isdigit():
            return int(pid)
    return None


def proc_start_time(pid: int) -> float | None:
    """进程创建时间（Unix 秒）。纯 ctypes，不依赖 psutil / wmic。

    wmic 在本机被安全策略列入黑名单，`Get-Process` 需要另起一个 shell，都不如
    OpenProcess + GetProcessTimes 直接。这个时间戳是「跑的是不是旧编译」的判据。
    """
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        ok = k32.GetProcessTimes(
            handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)
        )
        if not ok:
            return None
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        return ticks / 1e7 - 11644473600.0  # 1601-01-01 → Unix epoch
    finally:
        k32.CloseHandle(handle)


def proc_image(pid: int) -> str | None:
    """进程的可执行文件完整路径（用来确认它到底跑的是哪份副本）。"""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = k32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buf))
        if not k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return None
        return buf.value
    finally:
        k32.CloseHandle(handle)


def kill_tree(pid: int, label: str) -> bool:
    r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    ok = r.returncode == 0
    print(f"  {'停' if ok else '停不掉'} {label} pid={pid}")
    return ok


# ── 诊断 ──────────────────────────────────────────────────────────────────


def daemon_binary_is_stale() -> tuple[bool, str]:
    """dev 守护进程二进制是否比 orig-daemon 源码旧（与 collect() 同口径）。

    跑一份比源码旧的守护进程二进制意味着其中已修过的逻辑并未生效，可能复现
    已知且已修掉的引擎缺陷。因此 dev 栈不应起/复用一份比 orig-daemon 源码旧的
    守护进程——应先 build 再起。
    """
    deps = ["orig-daemon", "orig-core", "orig-net", "orig-protocol-http", "orig-protocol-virtual"]
    bin_path = REPO / "download-engine/target/release/orig-daemon.exe"
    if not bin_path.is_file():
        return True, "没有 release 产物（先 build）"
    bm = bin_path.stat().st_mtime
    newest = None
    for c in deps:
        d = REPO / "download-engine/crates" / c
        if not d.is_dir():
            continue
        for p in list(d.rglob("*.rs")) + list(d.rglob("Cargo.toml")):
            try:
                m = p.stat().st_mtime
            except OSError:
                continue
            if m > bm and (newest is None or m > newest[1]):
                newest = (p, m)
    if newest:
        rel = newest[0].relative_to(REPO)
        return True, f"产物比源码旧（{rel} 更新）⇒ 需要 build"
    return False, ""


def collect() -> dict:
    info: dict = {"daemon": {}, "tg": {}, "vite": {}, "copies": [], "warnings": []}

    for key, port, path in (("daemon", DAEMON_PORT, "/api/config"), ("tg", TG_PORT, "/api/tg/session")):
        pid = pid_on_port(port)
        entry = {"port": port, "pid": pid, "listening": pid is not None}
        if pid:
            entry["started_at"] = proc_start_time(pid)
            entry["image"] = proc_image(pid)
            exe = Path(entry["image"]) if entry.get("image") else None
            if exe and exe.is_file() and entry.get("started_at"):
                exe_mtime = exe.stat().st_mtime
                entry["exe_mtime"] = exe_mtime
                # 核心判据：exe 在进程启动之后被改写过 ⇒ 磁盘上是新编译，进程是旧的。
                entry["stale"] = exe_mtime > entry["started_at"] + 2.0
        info[key] = entry

    vpid = pid_on_port(VITE_PORT)
    info["vite"] = {"port": VITE_PORT, "pid": vpid, "listening": vpid is not None}

    cfg = ds.probe(DAEMON_PORT)
    info["daemon"]["healthy"] = cfg is not None
    if cfg is not None:
        info["daemon"]["tg_port"] = cfg.get("tg_port")
        info["daemon"]["tg_running"] = cfg.get("tg_running")
        info["daemon"]["tg_last_error"] = cfg.get("tg_last_error")

    for rel in COPIES:
        fp = file_fingerprint(REPO / rel)
        info["copies"].append({"rel": rel, "exists": fp is not None, **(fp or {})})

    # 源码是否比二进制新（与 sync-sidecars.sh 同口径：本 crate + 依赖 crate）。
    deps = {
        "orig-daemon": ["orig-daemon", "orig-core", "orig-net", "orig-protocol-http", "orig-protocol-virtual"],
        "orig-tg": ["orig-tg", "orig-core"],
    }
    for name, crates in deps.items():
        bin_path = REPO / f"download-engine/target/release/{name}.exe"
        if not bin_path.is_file():
            info["warnings"].append(f"{name}: 没有 release 产物（先 build）")
            continue
        bm = bin_path.stat().st_mtime
        newest = None
        for c in crates:
            d = REPO / "download-engine/crates" / c
            if not d.is_dir():
                continue
            for p in list(d.rglob("*.rs")) + list(d.rglob("Cargo.toml")):
                try:
                    m = p.stat().st_mtime
                except OSError:
                    continue
                if m > bm and (newest is None or m > newest[1]):
                    newest = (p, m)
        if newest:
            rel = newest[0].relative_to(REPO)
            info["warnings"].append(f"{name}: 产物比源码旧（{rel} 更新）⇒ 需要 build")

    return info


def print_status(info: dict) -> int:
    print(f"OrigHub dev 栈（{fmt_time(time.time())}）")
    print()
    for key, label, port in (("daemon", "orig-daemon", DAEMON_PORT), ("tg", "orig-tg", TG_PORT), ("vite", "vite", VITE_PORT)):
        e = info[key]
        if not e["listening"]:
            print(f"  [DOWN] {label:<12} :{port}")
            continue
        line = f"  [UP  ] {label:<12} :{port}  pid={e['pid']}"
        if e.get("started_at"):
            line += f"  启动于 {fmt_time(e['started_at'])}"
        print(line)
        if e.get("stale"):
            print(f"         ⚠ 跑的是旧编译：exe 在进程启动之后被改写过（exe mtime {fmt_time(e['exe_mtime'])}）")
        if key == "daemon":
            if not e.get("healthy"):
                print("         ⚠ 端口在监听但 /api/config 不应答 ⇒ 卡死的僵尸，用 restart 清掉")
            else:
                print(f"         tg_running={e.get('tg_running')} tg_port={e.get('tg_port')}")
                if e.get("tg_last_error"):
                    print(f"         tg_last_error={e['tg_last_error']}")

    print()
    print("  二进制副本：")
    for c in info["copies"]:
        if c["exists"]:
            print(f"    {c['sha12']}  {c['size']:>10,}B  {fmt_time(c['mtime'])}  {c['rel']}")
        else:
            print(f"    {'(缺失)':<12} {'':>11}  {'':19}  {c['rel']}")

    if info["warnings"]:
        print()
        print("  注意：")
        for w in info["warnings"]:
            print(f"    - {w}")

    down = [k for k in ("daemon", "tg", "vite") if not info[k]["listening"]]
    stale = [k for k in ("daemon", "tg") if info[k].get("stale")]
    # 「进程跑旧编译」与「exe 比源码旧」是两种不同的新旧冲突，都不能验收：
    #   前者 = exe 已更新但进程还是老的（restart 解决）；
    #   后者 = exe 本身就是老的，重启也没用（必须 build）。
    # 只判前者会让「产物比源码旧」被一句「可以验收」盖掉 —— 判据的洞。
    outdated = [w for w in info["warnings"] if "产物比源码旧" in w]
    print()
    if down:
        print(f"结论：{', '.join(down)} 离线。起栈：dev_stack.py start")
        return 1
    if outdated:
        print("结论：源码比产物新 —— 重启也没用，必须先 build（否则验的是旧代码）：")
        for w in outdated:
            print(f"  - {w}")
        return 1
    if stale:
        print(f"结论：{', '.join(stale)} 跑的是旧编译 —— 验收前必须 restart（否则验的是旧码）。")
        return 1
    print("结论：三项在线，产物与源码一致，且进程跑的就是磁盘上这份编译。可以验收。")
    return 0


# ── 动作 ──────────────────────────────────────────────────────────────────


def do_stop(quiet: bool = False) -> int:
    if not quiet:
        print("停止 dev 进程（不动正式壳 orig-hub.exe）：")
    stopped = 0
    # 先杀 daemon（连带 orig-tg，它是 daemon 的子进程）。
    pid = pid_on_port(DAEMON_PORT)
    if pid:
        kill_tree(pid, "orig-daemon(+orig-tg)")
        stopped += 1
    else:
        # daemon 不在但 orig-tg 残留：单独清。
        tpid = pid_on_port(TG_PORT)
        if tpid:
            kill_tree(tpid, "orig-tg(残留)")
            stopped += 1
    vpid = pid_on_port(VITE_PORT)
    if vpid:
        kill_tree(vpid, "vite")
        stopped += 1
    ds.PID_FILE.unlink(missing_ok=True)
    if not quiet:
        print("  已停 %d 个进程" % stopped if stopped else "  没有需要停的进程")
    return 0


def ensure_vite() -> tuple[bool, str]:
    if port_listening(VITE_PORT):
        return True, "已在跑"
    if not VITE_DIR.is_dir():
        return False, f"目录不存在 {VITE_DIR}"
    log_handle = VITE_LOG.open("a", encoding="utf-8", errors="replace", buffering=1)
    # 端口必须随世界一起下发，否则 vite 里的前端仍按**默认** 19786/19787 去连，
    # 而 dev 世界跑在 29786/29787 ⇒ 界面显示「媒体服务未运行」，一条命令起来的栈
    # 实际不可用（这是「dev 环境无法保证」的第二个成因）。
    # 真源 = daemon 的 `/api/config.tg_port`（orig-tg 端口可能被顺延，不能写死）。
    env = os.environ.copy()
    env["VITE_DAEMON_PORT"] = str(DAEMON_PORT)
    cfg = None
    try:
        cfg = ds.probe(DAEMON_PORT)
    except Exception:  # noqa: BLE001 - daemon 未起时只退化为默认端口
        cfg = None
    # `tg_port` 在 daemon 尚未接管 orig-tg 时是 None（实测 dev start 后一段时间内如此），
    # 此时必须退回本世界的规范端口 —— 否则前端保留默认 19787，而 orig-tg 跑在 29787，
    # 界面就是「媒体服务未运行」。
    env["VITE_TG_PORT"] = str((cfg or {}).get("tg_port") or TG_PORT)
    try:
        proc = subprocess.Popen(
            ["cmd", "/c", "npm", "run", "dev"],
            cwd=str(VITE_DIR),
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            creationflags=ds.DETACHED | ds.NEW_GROUP,
        )
    finally:
        log_handle.close()
    deadline = time.monotonic() + 45.0
    while time.monotonic() < deadline:
        if port_listening(VITE_PORT):
            return True, f"已启动 pid={proc.pid}"
        time.sleep(0.5)
    return False, f"45s 内未监听，见 {VITE_LOG}"


def do_start(force: bool, with_vite: bool) -> int:
    # ★ 最高规则护栏（会话隔离，BUG-474 衍生）：dev 守护进程二进制比 orig-daemon 源码旧时，
    # 跑旧二进制 = 其中已修的逻辑没生效，可能复现已知缺陷。
    # 注意：只判 orig-daemon（守护进程本体）；前端/纯 orig-tg 改动不会触发本护栏。
    stale, why = daemon_binary_is_stale()
    if stale:
        print("⚠ 护栏：dev 守护进程二进制比源码旧，其中已修的逻辑不会生效。")
        print(f"   {why}")
        print("   请先运行：")
        print("     python scripts/dev/dev_stack.py build")
        return 1
    # BUG-453：dev 跑在 cargo 输出目录之外的副本目录，构建不再锁住运行中的 dev 进程。
    ds.DAEMON_EXE = DEV_BIN_DIR / "orig-daemon.exe"
    # 一条命令必须自足：副本目录缺二进制时（干净检出/首次运行/目录被清）先构建，
    # 否则 `start` 只会打印「二进制缺失，先跑 build」而退出 —— 这正是「dev 环境
    # 无法保证」的成因之一：命令本身不能把环境带到可用态。
    if not all((DEV_BIN_DIR / n).is_file() for n in ("orig-daemon.exe", "orig-tg.exe")):
        print("dev 副本缺二进制 ⇒ 先构建，保证一条命令即可起栈")
        rc = do_build(False)
        if rc != 0:
            return rc
    ensure_dev_bins()
    pid = pid_on_port(DAEMON_PORT)
    cfg = ds.probe(DAEMON_PORT)
    if pid and cfg is not None and not force:
        print(f"已有健康实例 pid={pid}，复用（要换新编译请用 restart）")
    else:
        if pid:
            print(f"端口 {DAEMON_PORT} 上已有实例 pid={pid}（{'强制替换' if force else '不应答，清理僵尸'}）")
            kill_tree(pid, "orig-daemon(+orig-tg)")
            time.sleep(1.0)
        data_dir = ds.resolve_data_dir(None)
        env_extra = dev_runtime_env(data_dir)
        print(f"起 orig-daemon（ORIG_TG_DATA={data_dir}）")
        print(
            f"  端口 {DAEMON_PORT}/{TG_PORT}（壳在 19786 起扫，互不可见）；"
            f"运行态分离：endpoint={Path(env_extra['ORIG_DAEMON_ENDPOINT_FILE']).name} "
            f"tasks={Path(env_extra['ORIG_ENGINE_TASKS_DB']).name} "
            f"session={Path(env_extra['ORIG_TG_SESSION']).name}"
        )
        proc = ds.start_daemon(data_dir, DAEMON_PORT, extra_env=env_extra)
        if proc is None:
            print("  失败：二进制缺失，先跑 dev_stack.py build")
            return 1
        if ds.wait_healthy(DAEMON_PORT, ds.HEALTH_TIMEOUT_S) is None:
            print(f"  失败：{ds.HEALTH_TIMEOUT_S:.0f}s 内未健康，见 {ds.LOG_FILE}")
            return 1
        print(f"  已健康 pid={proc.pid}")

    if with_vite:
        ok, detail = ensure_vite()
        print(f"vite: {detail}")
        if not ok:
            print(f"  见 {VITE_LOG}")

    print()
    return print_status(collect())


def run_cmd(cmd: list[str], cwd: Path) -> int:
    print(f"$ {' '.join(cmd)}   (cwd={cwd.name})")
    r = subprocess.run(cmd, cwd=str(cwd))
    return r.returncode


def _copy_dev_exe(name: str, max_retry: float = 30.0) -> bool:
    """把 target/release 的新 exe 复制进 dev 副本目录；运行中文件被锁时按 0.3s 间隔重试。

    返回是否成功写入。race 处理：daemon 的 tg_supervise 在 kill 后要先 sleep
    `TG_SUPERVISE_INTERVAL` 再检测，本函数趁窗口期反复尝试，确保新 orig-tg.exe 落盘。
    """
    src = REPO / "download-engine/target/release" / name
    dst = DEV_BIN_DIR / name
    if not src.is_file():
        return False
    deadline = time.monotonic() + max_retry
    last_err = None
    while time.monotonic() < deadline:
        try:
            shutil.copy2(src, dst)
            return True
        except (OSError, PermissionError) as e:
            last_err = str(e)
            # 文件被运行进程锁住 → 先放倒占用者再试（仅 dev 端口 29787 的 orig-tg）。
            tpid = pid_on_port(TG_PORT)
            if tpid:
                kill_tree(tpid, "orig-tg(锁住副本)")
            time.sleep(0.3)
    print(f"    ⚠ 复制 {name} 失败（{last_err}）；daemon 下次重启会拾取旧 exe，必要时 dev restart")
    return False


def do_build(only_tg: bool) -> int:
    # BUG-453：dev 进程不再为构建停栈。cargo 写 target/release，dev 跑 target/dev-stack，
    # 二者物理分离；仅当 daemon 本体二进制变更（极少见）才重启 dev daemon。
    print("① 构建（dev 进程不停止：cargo 写 target/release，dev 跑 target/dev-stack）")
    pkgs = ["-p", "orig-tg"] if only_tg else ["-p", "orig-daemon", "-p", "orig-tg"]
    rc = run_cmd(["cargo", "build", "--release", *pkgs], ENGINE_DIR)
    if rc != 0:
        print(f"  构建失败（exit {rc}）")
        return rc

    print()
    print("② 同步 release 外部二进制（仅用于 release app 打包，不碰 dev 进程）")
    bash = shutil_which_bash()
    if bash is None:
        print("  跳过：找不到 bash。release 打包前请手动执行 sh scripts/sync-sidecars.sh")
    else:
        run_cmd([bash, "scripts/sync-sidecars.sh"], REPO)

    dpid = pid_on_port(DAEMON_PORT)
    if dpid:
        print()
        print("③ dev daemon 在线 ⇒ 热更新（kill orig-tg → 复制新 exe → daemon 自愈重启）")
        # 先确保 daemon 副本目录存在且 daemon 本体到位（若 daemon 未变则跳过）。
        _copy_dev_exe("orig-daemon.exe")
        _copy_dev_exe("orig-daemon-x86_64-pc-windows-msvc.exe")
        ok = _copy_dev_exe("orig-tg.exe") and _copy_dev_exe("orig-tg-x86_64-pc-windows-msvc.exe")
        # 等 daemon 的 tg_supervise 重启 orig-tg（受 TG_SUPERVISE_INTERVAL 与 60s 冷却约束）。
        deadline = time.monotonic() + 75.0
        back = False
        while time.monotonic() < deadline:
            if pid_on_port(TG_PORT):
                back = True
                break
            time.sleep(1.0)
        print(f"   orig-tg 自愈：{'已恢复↑' if back else '超时未恢复（daemon 会按冷却重试）'}")
        if not ok:
            print("   ⚠ orig-tg 副本未更新；如要立刻生效：dev_stack.py restart")
        # daemon 本体是否变更？（极少）变更则必须重启 dev daemon。
        src = REPO / "download-engine/target/release/orig-daemon.exe"
        dst = DEV_BIN_DIR / "orig-daemon.exe"
        if src.is_file() and dst.is_file() and file_fingerprint(src)["sha12"] != file_fingerprint(dst)["sha12"]:
            print("   daemon 二进制已变更 ⇒ 重启 dev daemon（dev 唯一会整段重启的情形）")
            do_stop()
            ensure_dev_bins(force=True)
            # 重启时连同 vite 一起恢复（脚本统一管理 dev 进程，不应让 vite 掉线）。
            do_start(force=False, with_vite=True)
    else:
        print()
        print("③ dev daemon 未运行 ⇒ 仅同步副本目录，start 即生效")
        ensure_dev_bins(force=True)

    print()
    print("④ 新产物指纹（target/release）")
    for rel in COPIES:
        fp = file_fingerprint(REPO / rel)
        if fp:
            print(f"    {fp['sha12']}  {fp['size']:>10,}B  {fmt_time(fp['mtime'])}  {rel}")
    print()
    print("构建完成。dev 进程未被杀（如有旋转，见上面③）。起栈：dev_stack.py start")
    return 0


def shutil_which_bash() -> str | None:
    from shutil import which

    return which("bash")


# ── 入口 ──────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description="OrigHub dev 栈手动入口（dev-only，跑完即退，不常驻不监控）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("status", help="只读诊断：端口 / 进程 / 二进制指纹 / 新旧判定")
    sub.add_parser("stop", help="停 dev 进程（daemon + orig-tg + vite），不动正式壳")
    p_start = sub.add_parser("start", help="起 dev 栈（已有健康实例则复用）")
    p_start.add_argument("--force", action="store_true", help="先停掉已有实例再起")
    p_start.add_argument("--no-vite", action="store_true", help="只起后端，不起 vite")
    sub.add_parser("restart", help="= stop + start（换新编译用这个）")
    sub.add_parser("build", help="stop → cargo build → sync → 打印指纹")
    sub.add_parser("build-tg", help="同上，但只重建 orig-tg")

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return 2

    if args.cmd == "status":
        return print_status(collect())
    if args.cmd == "stop":
        return do_stop()
    if args.cmd == "start":
        return do_start(force=args.force, with_vite=not args.no_vite)
    if args.cmd == "restart":
        do_stop()
        print()
        return do_start(force=True, with_vite=True)
    if args.cmd == "build":
        return do_build(only_tg=False)
    if args.cmd == "build-tg":
        return do_build(only_tg=True)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
