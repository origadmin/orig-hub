#!/usr/bin/env python3
"""Debug-mode service bootstrap (BUG-179 / 测试增强 2026-10-16).

设计边界（用户裁定）：本脚本**不是**自治监督者。它只做两件事——
一次性把 daemon 拉起来（DETACHED，不挂在控制台），以及让 agent 经文件信号
请求 daemon 重启它的 orig-tg 子进程（用于更新）。**绝不**自己杀进程、绝不自治
自愈、绝不碰 vite（vite 是用户自己的 UI 工具，归用户）。

daemon 才是常驻进程，它自己负责：
  - 拉起并**自愈 orig-tg 子进程**（子进程挂了 5s 内拉回，BUG-321/177）；
  - 消费重部署信号（收到 request→停 orig-tg→写 stopped；收到 built→重启 orig-tg→写 done）；
  - 把生命周期提示落 `logs/orig-daemon.log`（daemon 是 windows_subsystem，无控制台）。

两种“挂掉”的处置（用户模型）：
  1) 开发 kill 了**整个 daemon** → daemon 无了，日志留「shutting down」或直接消失；
     用户**再启动一次**（`--start`）即可。这是 daemon 二进制更新的正常路径。
  2) 只是 **orig-tg 子进程**死了 → daemon 自动监听并重启（即“更新”也走这条：
     agent 写信号→daemon 停子进程→agent 构建→写信号→daemon 重启子进程拾取新二进制）。

用法::

    # 第一次（用户，建议提权，规避 Windows 端口排除区间）：
    python scripts/dev_services.py --start          # 拉起 daemon（DETACHED），然后退出

    # 之后每次代码更新：
    #   a) 只改了 orig-tg（最常见）：
    python scripts/dev_services.py --redeploy-request   # 写信号→daemon 停 orig-tg、回 stopped
    cargo build --release -p orig-tg                    # 构建
    sh scripts/sync-sidecars.sh                         # 同步四副本
    python scripts/dev_services.py --redeploy-done       # 写信号→daemon 重启 orig-tg、回 done
    #   b) 改了 daemon 自身：
    python scripts/dev_services.py --stop               # 停 daemon（连 orig-tg 树）
    cargo build --release -p orig-daemon -p orig-tg
    sh scripts/sync-sidecars.sh
    python scripts/dev_services.py --start              # 重启 daemon（自动拉起 orig-tg）

    python scripts/dev_services.py --status     # 只探测健康，exit 0=就绪
    python scripts/dev_services.py --stop       # 停 daemon（连 orig-tg 树）
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DAEMON_EXE = REPO / "download-engine" / "target" / "release" / "orig-daemon.exe"
DEFAULT_PORT = 19786
PID_FILE = Path(os.environ.get("TEMP", str(REPO))) / "orighub-dev-daemon.pid"
LOG_FILE = Path(os.environ.get("TEMP", str(REPO))) / "orighub-dev-daemon.log"
# 重部署握手信号（与 daemon 约定同一临时目录；daemon 才是消费者）：
#   agent 写 REQUEST → daemon 停 orig-tg、写 STOPPED（可安全构建）→
#   agent 构建 + sync → 写 BUILT → daemon 重启 orig-tg、写 DONE。
REDEPLOY_REQUEST = Path(os.environ.get("TEMP", str(REPO))) / "orighub-redeploy-request"
REDEPLOY_STOPPED = Path(os.environ.get("TEMP", str(REPO))) / "orighub-redeploy-stopped"
REDEPLOY_BUILT = Path(os.environ.get("TEMP", str(REPO))) / "orighub-redeploy-built"
REDEPLOY_DONE = Path(os.environ.get("TEMP", str(REPO))) / "orighub-redeploy-done"
REDEPLOY_TIMEOUT_S = 120.0
HEALTH_TIMEOUT_S = 20.0
DETACHED = getattr(subprocess, "DETACHED_PROCESS", 0x8)
NEW_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)


def daemon_base(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def http_get_json(url: str, timeout: float = 1.5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def resolve_data_dir(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    appdata = os.environ.get("APPDATA")
    cand = Path(appdata) / "com.origadmin.orighub" if appdata else None
    if cand and (cand / "tg").is_dir():
        return cand
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "OrigHub"
    raise SystemExit("[dev-services] cannot resolve a data dir; pass --data-dir")


def probe(port: int):
    return http_get_json(f"{daemon_base(port)}/api/config", timeout=1.5)


def free_port(port: int) -> None:
    """清理占着 daemon/orig-tg 规范端口的僵尸，避免新实例漂移到随机端口。

    只在本进程**启动 daemon 之前**用一次，不是自治杀进程。
    """
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True,
            encoding="gbk",
            errors="replace",
        ).stdout
        for line in out.splitlines():
            cols = line.split()
            if len(cols) < 5:
                continue
            local, state, pid = cols[1], cols[3], cols[4]
            if f":{port}" in local and state == "LISTENING" and pid.isdigit():
                subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True)
    except Exception:
        pass


def start_daemon(
    data_dir: Path, port: int, extra_env: dict[str, str] | None = None
) -> subprocess.Popen | None:
    if not DAEMON_EXE.exists():
        print(
            f"[dev-services] daemon binary missing: {DAEMON_EXE}\n"
            "  build it first: cargo build --release -p orig-daemon -p orig-tg",
            file=sys.stderr,
        )
        return None
    # 仅启动前清一次僵尸，确保落在规范端口（不漂移）。
    free_port(port)
    free_port(port + 1)
    env = os.environ.copy()
    env["ORIG_TG_DATA"] = str(data_dir)
    # dev 栈与 release 壳共用数据根时，运行态（端口/端点文件/任务库/会话）必须分开，
    # 否则两边互相覆盖：端点文件决定壳连谁，会话文件决定 TG 登录态，任务库决定列表。
    # 调用方显式给出，本函数不猜。
    if extra_env:
        env.update({k: str(v) for k, v in extra_env.items()})
    log_handle = LOG_FILE.open("a", encoding="utf-8", errors="replace", buffering=1)
    try:
        proc = subprocess.Popen(
            [str(DAEMON_EXE)],
            cwd=str(data_dir),
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            creationflags=DETACHED | NEW_GROUP,
        )
    finally:
        log_handle.close()
    PID_FILE.write_text(str(proc.pid), encoding="ascii")

    # 明确提示用户“启动了什么、归谁管、怎么停、怎么更新”（对应“启动内容要有明确提示”）。
    print(
        f"[dev-services] started orig-daemon pid={proc.pid} (DETACHED, not tied to this console)\n"
        f"  - it self-heals orig-tg: if orig-tg exits, daemon restarts it within ~15s\n"
        f"  - lifecycle log: {LOG_FILE}  (daemon is a windows-subsystem app, no console)\n"
        f"  - to STOP:       python scripts/dev-services.py --stop\n"
        f"  - to UPDATE orig-tg (no daemon restart):  --redeploy-request … build … --redeploy-done\n"
        f"  - to UPDATE daemon itself:                --stop … rebuild … --start\n"
        f"  - vite is YOUR tool: start it yourself (e.g. cd tauri-shell && npm run dev)"
    )
    return proc


def pid_alive(pid: int) -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"],
            capture_output=True,
            encoding="gbk",
            errors="replace",
        ).stdout
        return str(pid) in out
    except Exception:
        return False


def stop_daemon() -> None:
    """停 daemon（连 orig-tg 子进程树）；清理重部署信号，避免残留握手卡住。"""
    for f in (REDEPLOY_REQUEST, REDEPLOY_STOPPED, REDEPLOY_BUILT, REDEPLOY_DONE):
        f.unlink(missing_ok=True)
    if PID_FILE.exists():
        pid = PID_FILE.read_text(encoding="ascii", errors="ignore").strip()
        if pid.isdigit():
            subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)
            print(f"[dev-services] stopped daemon pid {pid} (and its orig-tg child)")
        PID_FILE.unlink(missing_ok=True)
    else:
        print("[dev-services] no pid file; is the daemon running? (it may have been killed directly)")


def wait_healthy(port: int, timeout_s: float) -> dict | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        cfg = probe(port)
        if cfg is not None:
            return cfg
        time.sleep(0.25)
    return None


def emit_status(port: int, cfg: dict | None) -> int:
    if cfg is None:
        print(json.dumps({"ready": False, "port": port}, ensure_ascii=False))
        return 1
    print(
        json.dumps(
            {
                "ready": True,
                "port": cfg.get("port"),
                "tg_port": cfg.get("tg_port"),
                "tg_enabled": cfg.get("tg_enabled"),
                "tg_running": cfg.get("tg_running"),
                "tg_last_error": cfg.get("tg_last_error"),
                "default_download_dir": cfg.get("default_download_dir"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if not cfg.get("tg_running"):
        print("[dev-services] WARN: orig-tg not running; check logs/orig-daemon.log", file=sys.stderr)
        return 5
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", help="override the TG/daemon data dir (ORIG_TG_DATA)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="expected daemon port")
    ap.add_argument("--start", action="store_true", help="start the daemon (DETACHED) then exit")
    ap.add_argument("--status", action="store_true", help="probe only, do not start (exit 0 = ready)")
    ap.add_argument("--stop", action="store_true", help="stop the daemon (and its orig-tg child)")
    ap.add_argument(
        "--redeploy-request",
        action="store_true",
        help="request redeploy: daemon stops orig-tg and writes stopped (safe to build)",
    )
    ap.add_argument(
        "--redeploy-done",
        action="store_true",
        help="notify build done: daemon restarts orig-tg and writes done",
    )
    args = ap.parse_args()

    # ---- redeploy 握手（agent 侧：只写文件；daemon 才是消费者）----
    if args.redeploy_request:
        if probe(args.port) is None:
            print("[dev-services] daemon not running; start it first (`--start`)", file=sys.stderr)
            return 9
        # 清掉上一轮残留的 STOPPED/DONE/BUILT，避免误判“已可构建”。
        REDEPLOY_STOPPED.unlink(missing_ok=True)
        REDEPLOY_DONE.unlink(missing_ok=True)
        REDEPLOY_BUILT.unlink(missing_ok=True)
        REDEPLOY_REQUEST.touch()
        deadline = time.monotonic() + REDEPLOY_TIMEOUT_S
        while time.monotonic() < deadline:
            if REDEPLOY_STOPPED.exists():
                REDEPLOY_STOPPED.unlink(missing_ok=True)
                print(json.dumps(
                    {"redeploy": "stopped", "engine": "down", "safe_to_build": True}, ensure_ascii=False
                ))
                return 0
            time.sleep(0.5)
        print("[dev-services] TIMEOUT: daemon did not acknowledge redeploy-request", file=sys.stderr)
        return 9

    if args.redeploy_done:
        if probe(args.port) is None:
            print("[dev-services] daemon not running; start it first (`--start`)", file=sys.stderr)
            return 10
        REDEPLOY_DONE.unlink(missing_ok=True)
        REDEPLOY_BUILT.touch()
        deadline = time.monotonic() + REDEPLOY_TIMEOUT_S
        while time.monotonic() < deadline:
            if REDEPLOY_DONE.exists():
                REDEPLOY_DONE.unlink(missing_ok=True)
                print(json.dumps({"redeploy": "done", "engine": "up"}, ensure_ascii=False))
                return 0
            time.sleep(0.5)
        print("[dev-services] TIMEOUT: daemon did not acknowledge redeploy-built", file=sys.stderr)
        return 10

    if args.stop:
        stop_daemon()
        return 0

    if args.status:
        return emit_status(args.port, probe(args.port))

    # 默认 / --start：起或复用 daemon（一次性，然后退出——本脚本不常驻）。
    cfg = probe(args.port)
    if cfg is None:
        data_dir = resolve_data_dir(args.data_dir)
        print(f"[dev-services] starting orig-daemon (ORIG_TG_DATA={data_dir})")
        proc = start_daemon(data_dir, args.port)
        if proc is None:
            return 2
        cfg = wait_healthy(args.port, HEALTH_TIMEOUT_S)
        if cfg is None:
            print(
                f"[dev-services] daemon did not become healthy within {HEALTH_TIMEOUT_S}s; "
                "see LOG_FILE",
                file=sys.stderr,
            )
            return 4
    else:
        print("[dev-services] reusing healthy daemon")
    return emit_status(args.port, cfg)


if __name__ == "__main__":
    sys.exit(main())
