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

DAEMON_PORT = 19786
TG_PORT = 19787
VITE_PORT = 5180
VITE_DIR = REPO / "tauri-shell"
ENGINE_DIR = REPO / "download-engine"
VITE_LOG = Path(os.environ.get("TEMP", str(REPO))) / "orighub-vite.log"

# 四处副本（与 sync-sidecars.sh 的清单一致；这里只用于展示指纹，不做写入）。
COPIES = (
    "download-engine/target/release/orig-daemon.exe",
    "download-engine/target/release/orig-daemon-x86_64-pc-windows-msvc.exe",
    "download-engine/target/release/orig-tg.exe",
    "download-engine/target/release/orig-tg-x86_64-pc-windows-msvc.exe",
    "tauri-shell/src-tauri/target/debug/orig-tg.exe",
    "tauri-shell/src-tauri/target/release/orig-tg.exe",
)


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
    try:
        proc = subprocess.Popen(
            ["cmd", "/c", "npm", "run", "dev"],
            cwd=str(VITE_DIR),
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
        print(f"起 orig-daemon（ORIG_TG_DATA={data_dir}）")
        proc = ds.start_daemon(data_dir, DAEMON_PORT)
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


def do_build(only_tg: bool) -> int:
    # 顺序不可换：运行中的 exe 锁着文件，先构建会直接失败。
    print("① 停掉正在运行的 dev 进程（释放 exe 文件锁）")
    do_stop()
    time.sleep(1.0)

    print()
    print("② 构建")
    pkgs = ["-p", "orig-tg"] if only_tg else ["-p", "orig-daemon", "-p", "orig-tg"]
    rc = run_cmd(["cargo", "build", "--release", *pkgs], ENGINE_DIR)
    if rc != 0:
        print(f"  构建失败（exit {rc}）")
        return rc

    print()
    print("③ 同步四处副本（含陈旧检测）")
    bash = shutil_which_bash()
    if bash is None:
        print("  跳过：找不到 bash。手动执行 sh scripts/sync-sidecars.sh")
    else:
        rc = run_cmd([bash, "scripts/sync-sidecars.sh"], REPO)
        if rc != 0:
            print(f"  同步失败（exit {rc}）—— 若提示被占用，先 dev_stack.py stop")
            return rc

    print()
    print("④ 新产物指纹")
    for rel in COPIES:
        fp = file_fingerprint(REPO / rel)
        if fp:
            print(f"    {fp['sha12']}  {fp['size']:>10,}B  {fmt_time(fp['mtime'])}  {rel}")
    print()
    print("构建完成。起栈：dev_stack.py start")
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
