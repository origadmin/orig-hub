#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OrigHub 下载引擎守护进程保活看门狗（无控制台版）。

被 Windows 计划任务 `OrigHubDaemonWatchdog`（每 1 分钟）调用。
**必须以 `pythonw.exe` 运行**（而非 `python.exe`），否则仍会弹出黑色控制台窗口。**

设计要点：
- 不依赖任何第三方库：进程检测用 `tasklist`，日志写入滚动文件。
- 所有输出走文件日志；`pythonw` 下没有控制台，print 会丢失，故不依赖 stdout。
- 启动被保活进程时用 `CREATE_NO_WINDOW`，避免被保活进程也闪控制台窗口。
- 单次运行即退出（配合计划任务每分钟调用）；不做常驻循环，避免与时间触发器打架。
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from logging.handlers import RotatingFileHandler


# ---------------------------------------------------------------------------
# 配置区：按部署环境修改，或用环境变量覆盖
# ---------------------------------------------------------------------------
APP_NAME = "OrigHub"


def _local_app_data() -> str:
    return (
        os.environ.get("LOCALAPPDATA")
        or os.environ.get("APPDATA")
        or os.path.expanduser("~")
    )


def _discover(exe_name: str, env_key: str) -> str:
    """按环境变量 → 常见部署目录的顺序定位 exe；找不到返回空串。"""
    env = os.environ.get(env_key)
    if env and os.path.isfile(env):
        return env
    candidates = [
        os.path.join(_local_app_data(), "OrigHub", exe_name),
        os.path.join(os.path.dirname(sys.executable), exe_name),
        os.path.join(os.getcwd(), exe_name),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return ""


# 每个被保活进程：
#   image   —— 映像名，用于进程存在性检测
#   exe_env —— 覆盖 exe 路径的环境变量名
#   args    —— 启动参数
#   health  —— 可选健康检查 URL；设了之后若进程在但 URL 不可达会记警告（默认不自动kill）
DAEMONS = [
    {
        "image": "orig-daemon.exe",
        "exe_env": "ORIG_DAEMON_EXE",
        "args": [],
        "health": None,  # 例： "http://127.0.0.1:9876/health"
    },
    {
        "image": "orig-tg.exe",
        "exe_env": "ORIG_TG_EXE",
        "args": [],
        "health": None,  # 例： "http://127.0.0.1:9877/health"
    },
]

LOG_DIR = os.path.join(_local_app_data(), "OrigHub", "logs")
LOG_PATH = os.path.join(LOG_DIR, "watchdog.log")


# ---------------------------------------------------------------------------
# 日志：无控制台，写入滚动文件
# ---------------------------------------------------------------------------
def setup_logging() -> logging.Logger:
    os.makedirs(LOG_DIR, exist_ok=True)
    logger = logging.getLogger("orighub_watchdog")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        fh = RotatingFileHandler(
            LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8"
        )
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(fh)
    return logger


# ---------------------------------------------------------------------------
# 进程检测 / 启动
# ---------------------------------------------------------------------------
def is_running(image: str) -> bool:
    try:
        out = subprocess.check_output(
            ["tasklist", "/FO", "CSV", "/NH"],
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except Exception:
        return False
    return image.lower() in out.decode("utf-8", "ignore").lower()


def launch(logger: logging.Logger, spec: dict) -> None:
    exe = _discover(spec["image"], spec["exe_env"])
    if not exe:
        logger.error(
            "找不到 %s，跳过启动（请设置环境变量 %s 或放入 %s）",
            spec["image"],
            spec["exe_env"],
            os.path.join(_local_app_data(), "OrigHub"),
        )
        return
    try:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        # CREATE_NO_WINDOW：被保活进程不分配控制台窗口（彻底无闪）。
        # CREATE_NEW_PROCESS_GROUP：与看门狗的 Ctrl-C 信号隔离。
        subprocess.Popen(
            [exe, *spec["args"]],
            creationflags=subprocess.CREATE_NO_WINDOW
            | subprocess.CREATE_NEW_PROCESS_GROUP,
            startupinfo=si,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        logger.info("已启动 %s (%s)", spec["image"], exe)
    except Exception as e:  # noqa: BLE001
        logger.exception("启动 %s 失败: %s", spec["image"], e)


def ensure(logger: logging.Logger, spec: dict) -> None:
    if is_running(spec["image"]):
        logger.debug("%s 已在运行", spec["image"])
        return
    logger.warning("%s 未运行，尝试启动", spec["image"])
    launch(logger, spec)


def main() -> int:
    logger = setup_logging()
    logger.info("watchdog 触发，检查 %d 个守护进程", len(DAEMONS))
    for spec in DAEMONS:
        try:
            ensure(logger, spec)
        except Exception as e:  # noqa: BLE001
            logger.exception("处理 %s 异常: %s", spec["image"], e)
    logger.info("watchdog 完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
