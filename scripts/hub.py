#!/usr/bin/env python3
"""OrigHub 统一控制脚本（BUG-453）：一行命令管两个互不相关的世界。

两个世界彻底隔离（端口 / 数据根 / 二进制副本 / 端点文件 / 任务库 / 会话 / 日志）：

  dev（web）  ：daemon 29786 + orig-tg 29787 + vite 5180，运行二进制在
                `download-engine/target/dev-stack/`，与 cargo 输出目录分离 ⇒
                构建引擎不再杀 dev 进程。数据根与 release 共用一份（含下载库/媒体库），
                运行态（端点/任务/会话/日志）各自独立。
  release（app）：由 `tauri build` 产出的 `orig-hub.exe`，自带 bundled sidecar，
                默认 19786/19787，数据根 = Tauri app_data_dir。完全独立运行。

本脚本是所有 dev/release 进程的唯一管理者；AI 经它做一次构建/启停，绝不手工 taskkill。

用法（全部一次性执行后退出，不常驻）：

    python scripts/hub.py dev start [--force] [--no-vite]
    python scripts/hub.py dev stop
    python scripts/hub.py dev restart
    python scripts/hub.py dev build [build-tg]      # 不杀 dev 热更新
    python scripts/hub.py dev web start|stop|status
    python scripts/hub.py dev status

    python scripts/hub.py release build             # cargo + sync-sidecars + tauri build
    python scripts/hub.py release run               # 起 orig-hub.exe（DETACHED）
    python scripts/hub.py release stop
    python scripts/hub.py release status

    python scripts/hub.py status                    # dev + release + vite 总览
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / "dev"))

import dev_stack as dv  # noqa: E402  (dev 世界逻辑全在此模块；本脚本负责统一入口 + release 世界)

# release 世界常量
RELEASE_EXE = REPO / "tauri-shell" / "src-tauri" / "target" / "release" / "orig-hub.exe"
RELEASE_PORT = 19786
RELEASE_PID_FILE = Path(os.environ.get("TEMP", str(REPO))) / "orighub-release.pid"
DETACHED = getattr(subprocess, "DETACHED_PROCESS", 0x8)
NEW_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)


# ── 通用 Windows 进程工具（release 用；dev 复用 dev_stack 的）───────────────────────


def _netstat_listening_pid(port: int) -> int | None:
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
        if cols[3] == "LISTENING" and cols[1].rsplit(":", 1)[-1] == str(port) and cols[4].isdigit():
            return int(cols[4])
    return None


def _proc_name(pid: int) -> str | None:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, encoding="gbk", errors="replace",
        ).stdout
    except OSError:
        return None
    line = out.splitlines()[0] if out.splitlines() else ""
    return line.split(",")[0].strip().strip('"') or None


def _kill_tree(pid: int, label: str) -> None:
    r = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    print(f"  {'停' if r.returncode == 0 else '停不掉'} {label} pid={pid}")


def _find_proc_by_name(name: str) -> int | None:
    try:
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, encoding="gbk", errors="replace"
        ).stdout
    except OSError:
        return None
    for line in out.splitlines():
        cols = [c.strip().strip('"') for c in line.split(",")]
        if cols and cols[0].lower() == name.lower() and len(cols) > 1 and cols[1].isdigit():
            return int(cols[1])
    return None


def _probe(port: int) -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/config", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


# ── release 子命令 ────────────────────────────────────────────────────────────────


def release_stop() -> int:
    print("停 release app（不动 dev 进程）：")
    exe_pid = _find_proc_by_name("orig-hub.exe")
    if exe_pid:
        _kill_tree(exe_pid, "orig-hub.exe")
    # release daemon 在 19786；dev 在 29786，此处杀 19786 不影响 dev。
    dpid = _netstat_listening_pid(RELEASE_PORT)
    if dpid:
        _kill_tree(dpid, "release-daemon(19786)")
    RELEASE_PID_FILE.unlink(missing_ok=True)
    return 0


def release_run() -> int:
    if not RELEASE_EXE.is_file():
        print(f"[hub] release 产物缺失：{RELEASE_EXE}\n  先跑：python scripts/hub.py release build", file=sys.stderr)
        return 2
    if _netstat_listening_pid(RELEASE_PORT) or _find_proc_by_name("orig-hub.exe"):
        print("[hub] release app 已在运行（19786 监听或 orig-hub.exe 存在），跳过重复启动")
        return 0
    log = Path(os.environ.get("TEMP", str(REPO))) / "orighub-release.log"
    log_handle = log.open("a", encoding="utf-8", errors="replace", buffering=1)
    try:
        proc = subprocess.Popen(
            [str(RELEASE_EXE)], cwd=str(RELEASE_EXE.parent),
            stdout=log_handle, stderr=subprocess.STDOUT,
            creationflags=DETACHED | NEW_GROUP,
        )
    finally:
        log_handle.close()
    RELEASE_PID_FILE.write_text(str(proc.pid), encoding="ascii")
    print(f"[hub] 已启动 orig-hub.exe pid={proc.pid}（DETACHED）；日志 {log}")
    return 0


def release_build() -> int:
    # 编 release 前先停它自己的副本（19786 上的 daemon 与 orig-hub.exe 会被覆盖）；
    # 这一步只动 release 世界，dev（29786）毫发无损。
    print("① 停掉正在运行的 release app（释放它的 bundled sidecar 文件锁）")
    release_stop()
    time.sleep(1.0)

    print()
    print("② 构建引擎 release 二进制（写入 target/release，dev 跑 dev-stack 副本，不受影响）")
    rc = subprocess.run(
        ["cargo", "build", "--release", "-p", "orig-daemon", "-p", "orig-tg"],
        cwd=str(REPO / "download-engine"),
    ).returncode
    if rc != 0:
        print(f"  引擎构建失败（exit {rc}）")
        return rc

    print()
    print("③ 同步外部二进制到 externalBin 源 + 壳 target（release 打包需要）")
    bash = dv.shutil_which_bash()
    if bash is None:
        print("  跳过 sync-sidecars：找不到 bash。手动执行 sh scripts/sync-sidecars.sh")
    else:
        rc = subprocess.run([bash, "scripts/sync-sidecars.sh"], cwd=str(REPO)).returncode
        if rc != 0:
            print(f"  sync 失败（exit {rc}）")
            return rc

    print()
    print("④ tauri build（产物：tauri-shell/src-tauri/target/release/orig-hub.exe + 安装包）")
    # 必须走 cmd /c：Python 子进程环境里 npm 不在 PATH，但 Windows cmd 的 PATH 含 nodejs，
    # 与 dev_stack 里 `cmd /c npm run dev` 同理。
    rc = subprocess.run(
        "cmd /c npm run tauri build", cwd=str(REPO / "tauri-shell"), shell=True
    ).returncode
    if rc != 0:
        print(f"  tauri build 失败（exit {rc}）")
        return rc

    print()
    print("release 构建完成。运行：python scripts/hub.py release run")
    return 0


def release_status() -> int:
    alive = _probe(RELEASE_PORT)
    pid = _netstat_listening_pid(RELEASE_PORT)
    exe = _find_proc_by_name("orig-hub.exe")
    line = "[UP  ] release(orig-hub.exe)" if (alive or exe) else "[DOWN] release(orig-hub.exe)"
    if alive:
        line += f"  :{RELEASE_PORT}  daemon_pid={pid}"
    if exe and exe != pid:
        line += f"  app_pid={exe}"
    print(line)
    return 0 if (alive or exe) else 1


# ── dev 子命令（委托 dev_stack）──────────────────────────────────────────────────


def dev_web_start() -> int:
    ok, detail = dv.ensure_vite()
    print(f"vite: {detail}")
    return 0 if ok else 1


def dev_web_stop() -> int:
    vpid = dv.pid_on_port(dv.VITE_PORT)
    if vpid:
        dv.kill_tree(vpid, "vite")
    else:
        print("  vite 未运行")
    return 0


def dev_web_status() -> int:
    print("[UP  ] vite" if dv.pid_on_port(dv.VITE_PORT) else "[DOWN] vite")
    return 0


# ── 总览 ─────────────────────────────────────────────────────────────────────────


def do_status() -> int:
    print("=== OrigHub 总览 ===")
    dv.print_status(dv.collect())
    print()
    release_status()
    return 0


# ── 入口 ─────────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description="OrigHub 统一控制（dev + release，两世界互不相关）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = ap.add_subparsers(dest="world")

    d = sub.add_parser("dev", help="dev 世界（web：daemon+orig-tg+vite）")
    ds = d.add_subparsers(dest="cmd")
    p_start = ds.add_parser("start")
    p_start.add_argument("--force", action="store_true")
    p_start.add_argument("--no-vite", action="store_true")
    ds.add_parser("stop")
    ds.add_parser("restart")
    ds.add_parser("build")
    ds.add_parser("build-tg")
    ds.add_parser("status")
    dw = ds.add_parser("web", help="仅 vite")
    dws = dw.add_subparsers(dest="wcmd")
    dws.add_parser("start")
    dws.add_parser("stop")
    dws.add_parser("status")

    r = sub.add_parser("release", help="release 世界（app：orig-hub.exe）")
    rs = r.add_subparsers(dest="cmd")
    rs.add_parser("build")
    rs.add_parser("run")
    rs.add_parser("stop")
    rs.add_parser("status")

    sub.add_parser("status", help="dev + release 总览")

    args = ap.parse_args()
    if not args.world:
        ap.print_help()
        return 2

    if args.world == "dev":
        if args.cmd == "start":
            return dv.do_start(force=args.force, with_vite=not args.no_vite)
        if args.cmd == "stop":
            return dv.do_stop()
        if args.cmd == "restart":
            dv.do_stop()
            print()
            return dv.do_start(force=True, with_vite=True)
        if args.cmd == "build":
            return dv.do_build(only_tg=False)
        if args.cmd == "build-tg":
            return dv.do_build(only_tg=True)
        if args.cmd == "status":
            return dv.print_status(dv.collect())
        if args.cmd == "web":
            if args.wcmd == "start":
                return dev_web_start()
            if args.wcmd == "stop":
                return dev_web_stop()
            if args.wcmd == "status":
                return dev_web_status()
        return 2

    if args.world == "release":
        if args.cmd == "build":
            return release_build()
        if args.cmd == "run":
            return release_run()
        if args.cmd == "stop":
            return release_stop()
        if args.cmd == "status":
            return release_status()
        return 2

    if args.world == "status":
        return do_status()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
