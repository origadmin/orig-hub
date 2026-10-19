#!/usr/bin/env python3
"""BUG-321 验收：引擎栈不再「挂在启动者的控制台上」，且消失后必须由监督者拉回。

用户规范（强制自动化验收）：不靠人手点浏览器，脚本必须自己抓真实状态码与日志，
并把断言结果落盘。本脚本跑在**真实运行栈**上（daemon + orig-tg + 监督者）。

用法::

    python scripts/verify_bug321_stack_supervisor.py              # 只读探活 + 日志轮次
    python scripts/verify_bug321_stack_supervisor.py --kill-test  # 附加：杀整树验自愈

断言（每条都做了验牙，见 docs/bugs/BUG-321.md）：

- A1 19786 在监听（daemon 活着）
- A2 tg 端口在监听（端口来自 /api/config 的 tg_port，禁硬编码）
- A3 /health == 200
- A4 /api/tg/diag：available=true 且 mock=false 且 session_phase=Authorized
- A5 监督者进程存活，且它是 daemon 的父进程（栈真的由监督者托管）
- A6 监督者日志里存在成对的 DOWN -> RECOVERED（真的自愈过，不是碰巧活着）
- A7（--kill-test）杀掉 daemon 整树后，30s 内两端口重新 UP
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEMP = Path(os.environ.get("TEMP", str(REPO)))
SUPERVISOR_LOG = TEMP / "orighub-dev-supervisor.log"
SUPERVISOR_PID_FILE = TEMP / "orighub-dev-supervisor.pid"
DAEMON_PORT = 19786
PASS, FAIL = [], []


def check(ok: bool, name: str, detail: str) -> None:
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")


def port_open(port: int) -> int | None:
    """返回占用该端口的 pid（Windows netstat），没人在听返回 None。"""
    out = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, encoding="gbk", errors="replace"
    ).stdout
    for line in out.splitlines():
        if "LISTENING" not in line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        addr, pid = parts[1], parts[-1]
        if addr.endswith(f":{port}") and pid.isdigit():
            return int(pid)
    return None


def http_json(url: str, timeout: float = 3.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None, None


def alive(pid: int) -> bool:
    """按进程存活判定，不只看 pid 文件 —— pid 文件被人删了不等于监督者没了
    （验牙时踩过：删了文件、进程还活着，A5a 误报 FAIL）。"""
    out = subprocess.run(
        ["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True, encoding="gbk", errors="replace"
    ).stdout
    return str(pid) in out


def log_counts() -> tuple[int, int]:
    """监督日志里 DOWN / RECOVERED 的累计条数（用于断言**本次**确实自愈过）。"""
    if not SUPERVISOR_LOG.exists():
        return 0, 0
    text = SUPERVISOR_LOG.read_text(encoding="utf-8", errors="replace")
    return text.count("DOWN port="), text.count("RECOVERED pid=")


def parent_of(pid: int) -> int | None:
    out = subprocess.run(
        ["wmic", "process", "where", f"ProcessId={pid}", "get", "ParentProcessId", "/value"],
        capture_output=True,
        text=True,
        encoding="gbk",
        errors="replace",
    ).stdout
    for line in out.splitlines():
        if line.startswith("ParentProcessId="):
            v = line.split("=", 1)[1].strip()
            return int(v) if v.isdigit() else None
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--kill-test", action="store_true", help="kill the whole engine stack and assert recovery")
    args = ap.parse_args()

    # 监督者自举后要 5s 才把栈拉起来 —— 不等就把「启动竞态」读成「栈没了」
    # （实测踩过：紧跟 --supervise 跑，A1 报无人监听但 A3 /health 却是 200）。
    dpid = None
    deadline = time.monotonic() + 25.0
    while time.monotonic() < deadline:
        dpid = port_open(DAEMON_PORT)
        if dpid:
            break
        time.sleep(1.0)
    check(dpid is not None, "A1", f"daemon port 19786 pid={dpid}" if dpid else "25s 内 19786 未起")

    status, cfg = http_json(f"http://127.0.0.1:{DAEMON_PORT}/api/config")
    tg_port = cfg.get("tg_port") if cfg else None
    check(
        isinstance(tg_port, int),
        "A2a",
        f"tg_port 来自 /api/config = {tg_port}（运行时真源，禁硬编码）"
        if isinstance(tg_port, int)
        else "取不到 /api/config",
    )
    tg_pid = port_open(tg_port) if isinstance(tg_port, int) else None
    check(tg_pid is not None, "A2b", f"tg port {tg_port} pid={tg_pid}" if tg_pid else f"{tg_port} 无人监听")

    status, body = http_json(f"http://127.0.0.1:{DAEMON_PORT}/health")
    check(status == 200, "A3", f"/health -> {status} {body}")

    _, diag = http_json(f"http://127.0.0.1:{tg_port}/api/tg/diag")
    if diag:
        check(
            diag.get("available") is True and diag.get("mock") is False,
            "A4a",
            f"available={diag.get('available')} mock={diag.get('mock')}",
        )
        check(diag.get("session_phase") == "Authorized", "A4b", f"session_phase={diag.get('session_phase')}")
    else:
        check(False, "A4a", "取不到 /api/tg/diag")
        check(False, "A4b", "取不到 /api/tg/diag")

    sup_pid = None
    if SUPERVISOR_PID_FILE.exists():
        v = SUPERVISOR_PID_FILE.read_text(encoding="ascii").strip()
        sup_pid = int(v) if v.isdigit() else None
    sup_alive = bool(sup_pid) and alive(sup_pid)
    check(sup_alive, "A5a", f"监督者进程 pid={sup_pid} 存活={sup_alive}")
    if sup_pid and dpid:
        check(
            parent_of(dpid) == sup_pid,
            "A5b",
            f"daemon {dpid} 的父 = {parent_of(dpid)}（应为监督者 {sup_pid}）",
        )
    else:
        check(False, "A5b", "无 daemon 或监督者，无法核对托管关系")

    base_down, base_rec = log_counts()
    check(base_down >= 1 and base_rec >= 1, "A6", f"监督日志累计 DOWN={base_down} RECOVERED={base_rec}")

    if args.kill_test:
        victim = port_open(DAEMON_PORT)
        if victim is None:
            check(False, "A7", "要杀的 daemon 不在，无法做自愈实验")
        else:
            subprocess.run(["taskkill", "/PID", str(victim), "/T", "/F"], capture_output=True)
            t0 = time.monotonic()
            died = port_open(DAEMON_PORT) is None
            check(died, "A7a", f"杀整树 pid={victim} 后 19786 立即 DOWN={died}")
            up_d, up_t = None, None
            deadline = time.monotonic() + 30.0
            while time.monotonic() < deadline:
                up_d = port_open(DAEMON_PORT)
                up_t = port_open(tg_port) if isinstance(tg_port, int) else None
                if up_d and up_t:
                    break
                time.sleep(1.0)
            secs = time.monotonic() - t0
            check(up_d is not None and up_t is not None, "A7b", f"{secs:.1f}s 后 19786={up_d} {tg_port}={up_t}")
            # A6b：必须是**本次**产生的自愈记录，否则历史日志会把这条喂成恒绿。
            now_down, now_rec = log_counts()
            check(
                now_down > base_down and now_rec > base_rec,
                "A6b",
                f"本次杀栈新增 DOWN+{now_down - base_down} RECOVERED+{now_rec - base_rec}",
            )

    total = len(PASS) + len(FAIL)
    print(f"\n{'ALL PASS' if not FAIL else 'HAS FAIL'}: {len(PASS)}/{total}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
