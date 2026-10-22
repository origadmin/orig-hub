#!/usr/bin/env python3
"""OrigHub dev 栈守护器 —— 让「服务又挂了」不再依赖 agent 会话的寿命。

## 为什么需要它（实测根因）

`dev_services.py --start` 已经用了 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`，
但 daemon 仍然会在启动成功后**几秒内无声消失**：日志最后一行是
`orig-daemon listening on http://127.0.0.1:19786`，没有 panic、没有 error、
没有 shutdown 记录。

`DETACHED_PROCESS` 只脱控制台，**不脱 job object**。agent 的每条 shell 命令都在一个
job 里，命令结束（或会话结束、后台任务被回收）时 job 关闭，`KILL_ON_JOB_CLOSE`
会把 job 里的所有进程一起杀掉——detached 的子进程也在内。于是：

- 用 `--start` 起 → 命令返回 → daemon 死；
- 用 `run_in_background` + `sleep 28800` 续命 → 任务一结束/被回收 → daemon 死。

用户侧的观感就是「服务又挂了，而且已经成了常态；结束后无法验收」。

## 本脚本怎么解决

两层：

1. **常驻守护（本进程）**：每 `--interval` 秒探一次 daemon / orig-tg / vite，
   掉哪个拉哪个，并把每轮结果写进状态文件与日志。
2. **脱离 job 的启动方式**：本进程**不能**由 agent 的 shell 直接拉起（那样它也在 job 里）。
   必须经 `scripts/launch_detached.ps1`（WMI `Win32_Process.Create`，父进程变成
   WmiPrvSE.exe，不在 agent 的 job 内）启动，之后会话结束也不受影响。

## 用法

    python scripts/stack_guard.py --status          # 只诊断，人话输出，不启动任何东西
    python scripts/stack_guard.py --once            # 修一轮（掉什么拉什么）后退出
    python scripts/stack_guard.py --daemon          # 常驻自愈（由 launch_detached.ps1 起）
    python scripts/stack_guard.py --stop            # 停守护（不动 daemon/vite 本身）

退出码：0 = 全部在线；1 = 有组件离线（`--once` 修完仍离线时返回 1）。
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import dev_services as ds  # noqa: E402  （同目录，复用它的 DETACHED 启动与探活逻辑）

DAEMON_PORT = 19786
TG_PORT = 19787
VITE_PORT = 5180
VITE_DIR = REPO / "tauri-shell"

STATE_FILE = Path(os.environ.get("TEMP", str(REPO))) / "orighub-stack-guard.json"
GUARD_LOG = Path(os.environ.get("TEMP", str(REPO))) / "orighub-stack-guard.log"
GUARD_LOCK = Path(os.environ.get("TEMP", str(REPO))) / "orighub-stack-guard.lock"
VITE_LOG = Path(os.environ.get("TEMP", str(REPO))) / "orighub-vite.log"

DETACHED = ds.DETACHED
NEW_GROUP = ds.NEW_GROUP


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    # 常驻时用 pythonw.exe 起（无控制台），此时 sys.stdout 是 None —— print 会抛
    # AttributeError 把守护打死。文件日志才是常驻形态的真出口。
    if sys.stdout is not None:
        try:
            print(line, flush=True)
        except (OSError, ValueError):
            pass
    try:
        with GUARD_LOG.open("a", encoding="utf-8", errors="replace") as f:
            f.write(line + "\n")
    except OSError:
        pass


def port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.6) -> bool:
    """TCP 连接判定。比 netstat 解析可靠：netstat 的本地地址列可能带 [::]，且需处理编码。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def http_ok(port: int, path: str = "/api/config", timeout: float = 2.0) -> bool:
    """不只看端口：还要确认它真的在应答（端口 LISTENING 但进程卡死也会占着端口）。"""
    return ds.http_get_json(f"http://127.0.0.1:{port}{path}", timeout=timeout) is not None


# ── 各组件 ────────────────────────────────────────────────────────────────


def ensure_daemon() -> tuple[bool, str]:
    """daemon 是根：orig-tg 由它自己监督，所以这里只管 daemon。"""
    cfg = ds.probe(DAEMON_PORT)
    if cfg is not None:
        return True, "already healthy"
    if port_listening(DAEMON_PORT) and cfg is None:
        # 端口被占但不应答 = 卡死的僵尸，先清掉再起，否则新实例会漂到随机端口。
        log(f"daemon 端口 {DAEMON_PORT} 被占但不应答，清理僵尸")
        ds.free_port(DAEMON_PORT)
    data_dir = ds.resolve_data_dir(None)
    log(f"拉起 orig-daemon（ORIG_TG_DATA={data_dir}）")
    proc = ds.start_daemon(data_dir, DAEMON_PORT)
    if proc is None:
        return False, "启动失败：二进制缺失（先 cargo build --release -p orig-daemon -p orig-tg）"
    cfg = ds.wait_healthy(DAEMON_PORT, ds.HEALTH_TIMEOUT_S)
    if cfg is None:
        return False, f"{ds.HEALTH_TIMEOUT_S:.0f}s 内未健康，见 {ds.LOG_FILE}"
    return True, f"started pid={proc.pid}"


def ensure_tg() -> tuple[bool, str]:
    """orig-tg 由 daemon 监督（退出后 ~15s 自动重启），这里只观测不插手。"""
    if http_ok(TG_PORT, "/api/tg/session", timeout=1.5) or port_listening(TG_PORT):
        return True, "listening"
    cfg = ds.probe(DAEMON_PORT)
    if cfg is None:
        return False, "daemon 不在，orig-tg 无从拉起"
    err = cfg.get("tg_last_error")
    return False, f"未监听（daemon 在监督中，tg_last_error={err!r}）"


def ensure_vite() -> tuple[bool, str]:
    """vite 是前端 dev server。用 `cmd /c npm run dev` 起（Windows 上 npm 是 .cmd）。"""
    if port_listening(VITE_PORT):
        return True, "listening"
    if not VITE_DIR.is_dir():
        return False, f"目录不存在：{VITE_DIR}"
    log(f"拉起 vite（cwd={VITE_DIR}，日志 {VITE_LOG}）")
    log_handle = VITE_LOG.open("a", encoding="utf-8", errors="replace", buffering=1)
    try:
        proc = subprocess.Popen(
            ["cmd", "/c", "npm", "run", "dev"],
            cwd=str(VITE_DIR),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            creationflags=DETACHED | NEW_GROUP,
        )
    finally:
        log_handle.close()
    # vite 冷启动要预构建依赖，给足时间；但判定仍以端口为准。
    deadline = time.monotonic() + 45.0
    while time.monotonic() < deadline:
        if port_listening(VITE_PORT):
            return True, f"started pid={proc.pid}"
        time.sleep(0.5)
    return False, f"45s 内未监听，见 {VITE_LOG}"


CHECKS = (
    ("daemon", DAEMON_PORT, ensure_daemon),
    ("orig-tg", TG_PORT, ensure_tg),
    ("vite", VITE_PORT, ensure_vite),
)


def snapshot(repair: bool) -> dict:
    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "repair": repair, "components": {}}
    all_ok = True
    for name, port, fn in CHECKS:
        if repair:
            ok, detail = fn()
        else:
            ok = port_listening(port) and (http_ok(port, "/api/tg/session" if name == "orig-tg" else "/api/config") if name != "vite" else True)
            detail = "listening" if ok else "not listening"
        out["components"][name] = {"ok": ok, "port": port, "detail": detail}
        all_ok = all_ok and ok
    out["all_ok"] = all_ok
    return out


def write_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass


def print_status(state: dict) -> None:
    print(f"OrigHub dev 栈状态（{state['at']}）")
    for name, info in state["components"].items():
        mark = "OK  " if info["ok"] else "DOWN"
        print(f"  [{mark}] {name:<8} :{info['port']:<6} {info['detail']}")
    print()
    if state["all_ok"]:
        print("结论：三项全部在线，可以验收。")
        print(f"  前端 http://localhost:{VITE_PORT}")
    else:
        print("结论：有组件离线。修一轮：python scripts/stack_guard.py --once")
        print(f"  daemon 日志 {ds.LOG_FILE}")
        print(f"  vite   日志 {VITE_LOG}")
        tail = tail_lines(ds.LOG_FILE, 3)
        if tail:
            print("  daemon 日志最后几行：")
            for line in tail:
                print(f"    {line}")


def tail_lines(path: Path, n: int) -> list[str]:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            return [ln.rstrip() for ln in f.readlines()[-n:]]
    except OSError:
        return []


# ── 单实例与常驻 ──────────────────────────────────────────────────────────


def acquire_lock() -> bool:
    """独占打开一个 lock 文件。已存在且被占用 ⇒ 已有守护在跑，不再起第二个。"""
    try:
        fd = os.open(str(GUARD_LOCK), os.O_CREAT | os.O_EXCL | os.O_RDWR)
    except FileExistsError:
        # 可能是上次异常退出留下的陈旧文件：用 pid 存活判断区分。
        try:
            pid = int(GUARD_LOCK.read_text(encoding="ascii", errors="ignore").strip() or 0)
        except (OSError, ValueError):
            pid = 0
        if pid and ds.pid_alive(pid):
            return False
        GUARD_LOCK.unlink(missing_ok=True)
        try:
            fd = os.open(str(GUARD_LOCK), os.O_CREAT | os.O_EXCL | os.O_RDWR)
        except FileExistsError:
            return False
    os.write(fd, str(os.getpid()).encode("ascii"))
    os.close(fd)
    return True


def release_lock() -> None:
    try:
        pid = int(GUARD_LOCK.read_text(encoding="ascii", errors="ignore").strip() or 0)
        if pid == os.getpid():
            GUARD_LOCK.unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


def run_daemon(interval: float) -> int:
    if not acquire_lock():
        print("[stack-guard] 已有守护在跑（lock 被占用），本进程退出", file=sys.stderr)
        return 0
    log(f"守护启动 pid={os.getpid()} interval={interval:.0f}s")
    failures = 0
    try:
        while True:
            state = snapshot(repair=True)
            write_state(state)
            if state["all_ok"]:
                if failures:
                    log("已恢复：三项全部在线")
                failures = 0
            else:
                failures += 1
                down = [n for n, i in state["components"].items() if not i["ok"]]
                # 只在「首次掉线」与「每 10 次」打日志，避免刷爆文件（BUG-373 风暴的教训）。
                if failures == 1 or failures % 10 == 0:
                    log(f"离线（第 {failures} 轮）：{down} " + json.dumps(
                        {n: state["components"][n]["detail"] for n in down}, ensure_ascii=False
                    ))
            time.sleep(interval)
    except KeyboardInterrupt:
        log("收到中断，守护退出")
    finally:
        release_lock()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--status", action="store_true", help="只诊断，不启动任何东西")
    ap.add_argument("--once", action="store_true", help="修一轮（掉什么拉什么）后退出")
    ap.add_argument("--daemon", action="store_true", help="常驻自愈（须由 launch_detached.ps1 启动）")
    ap.add_argument("--stop", action="store_true", help="停守护（不杀 daemon / vite）")
    ap.add_argument("--interval", type=float, default=20.0, help="守护轮询间隔秒（默认 20）")
    args = ap.parse_args()

    if args.stop:
        try:
            pid = int(GUARD_LOCK.read_text(encoding="ascii", errors="ignore").strip() or 0)
        except (OSError, ValueError):
            pid = 0
        if pid and ds.pid_alive(pid):
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
            print(f"[stack-guard] 已停守护 pid {pid}（daemon / vite 未动）")
        else:
            print("[stack-guard] 没有在跑的守护")
        GUARD_LOCK.unlink(missing_ok=True)
        return 0

    if args.daemon:
        return run_daemon(args.interval)

    state = snapshot(repair=args.once)
    write_state(state)
    print_status(state)
    return 0 if state["all_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
