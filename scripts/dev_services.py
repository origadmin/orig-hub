#!/usr/bin/env python3
"""Debug-mode service bootstrap (BUG-179).

用户规范（2026-09-29）：调试模式下 TG 与媒体库服务也必须正常 —— 调试与生产
是同一个产品。此前调试启动（cargo run / 验收脚本）不带 ORIG_TG_DATA，
数据目录回落 `%LOCALAPPDATA%/OrigHub`，与桌面壳的
`%APPDATA%/com.origadmin.orighub/tg`（真实数据：media_item=137）分裂，
于是「媒体库数据异常 / TG 数据获取异常」。

本脚本是调试模式**唯一启动入口**：

1. 选定数据目录（与生产同源）：
   `--data-dir` 显式指定 > `%APPDATA%/com.origadmin.orighub`（存在即用，与壳同源）
   > `%LOCALAPPDATA%/OrigHub`（引擎默认回落）。
2. 设 `ORIG_TG_DATA` 后启动 orig-daemon —— **daemon 是唯一启动者**，
   orig-tg 由它拉起并注入端口/会话/凭据（BUG-177/178 契约），脚本绝不自己碰 orig-tg。
3. 幂等：daemon 已健康（/health 200）则复用，不重复拉起。
4. 等待就绪后打印实际端口、tg_port、tg_running —— 全部来自 daemon `/api/config` 真源。

用法::

    python scripts/dev_services.py            # 启动（或复用）并等待就绪
    python scripts/dev_services.py --check    # 只探测，不启动（exit 0 = 就绪）
    python scripts/dev_services.py --stop     # 停止本脚本此前拉起的 daemon（按 pid 文件）

前端配合：vite dev 的初始 daemon 端口 = `VITE_DAEMON_PORT` ?? 19786（api/daemon.ts），
与引擎默认端口一致；被顺延时用 `VITE_DAEMON_PORT=<实际端口>` 覆盖。
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
HEALTH_TIMEOUT_S = 20.0


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


def start_daemon(data_dir: Path, port: int) -> subprocess.Popen | None:
    if not DAEMON_EXE.exists():
        print(
            f"[dev-services] daemon binary missing: {DAEMON_EXE}\n"
            "  build it first: cargo build --release -p orig-daemon -p orig-tg",
            file=sys.stderr,
        )
        return None
    env = os.environ.copy()
    env["ORIG_TG_DATA"] = str(data_dir)
    # daemon 端口由 download-engine.toml 的 `port` 或内置默认（19786）决定，
    # bind 失败时引擎自行顺延；这里不注入端口变量，避免与 toml 形成双真源。
    proc = subprocess.Popen(
        [str(DAEMON_EXE)],
        cwd=str(data_dir),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    PID_FILE.write_text(str(proc.pid), encoding="ascii")
    return proc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", help="override the TG/daemon data dir (ORIG_TG_DATA)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="expected daemon port")
    ap.add_argument("--check", action="store_true", help="probe only, do not start")
    ap.add_argument("--stop", action="store_true", help="stop the daemon started by this script")
    args = ap.parse_args()

    if args.stop:
        if PID_FILE.exists():
            pid = PID_FILE.read_text(encoding="ascii").strip()
            if pid.isdigit():
                subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)
                print(f"[dev-services] stopped pid {pid}")
            PID_FILE.unlink(missing_ok=True)
        else:
            print("[dev-services] no pid file; nothing to stop")
        return 0

    cfg = probe(args.port)
    if cfg is None and args.check:
        print(f"[dev-services] NOT READY: nothing healthy on {args.port}")
        return 1
    if cfg is None:
        data_dir = resolve_data_dir(args.data_dir)
        print(f"[dev-services] starting orig-daemon (ORIG_TG_DATA={data_dir})")
        proc = start_daemon(data_dir, args.port)
        if proc is None:
            return 2
        deadline = time.monotonic() + HEALTH_TIMEOUT_S
        while time.monotonic() < deadline:
            cfg = probe(args.port)
            if cfg is not None:
                break
            if proc.poll() is not None:
                print(f"[dev-services] daemon exited with {proc.returncode}", file=sys.stderr)
                return 3
            time.sleep(0.25)
        if cfg is None:
            print(f"[dev-services] daemon did not become healthy within {HEALTH_TIMEOUT_S}s", file=sys.stderr)
            return 4
        print(f"[dev-services] daemon started, pid {proc.pid}")
    else:
        print("[dev-services] reusing healthy daemon")

    print(
        json.dumps(
            {
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
        print("[dev-services] WARN: orig-tg not running; check tg_last_error", file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
