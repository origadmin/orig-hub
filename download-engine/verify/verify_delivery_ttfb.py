#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_delivery_ttfb.py — 本地投递「首字节延迟（body TTFB）」A/B 自动化验收。

背景（BUG-033 / 播放卡顿）
--------------------------
`orig-tg` 的本地文件投递（`serve_local_file`，见 `crates/orig-tg/src/routes.rs`）
按「码率 × 余量」限速以防 Chromium abort-and-re-request 风暴。限速配额原先**每请求
从 0 起算**（`due = sent / bps`），块大小 `CHUNK = 1 MiB`，于是**响应头立即返回、
但 body 第一块要等 `1 MiB / bps`**（真实码率下 135–1000 ms）——每一次拖进度条 /
Chromium 的 abort-and-re-request 都会重付这笔 TTFB 代价，表现为「播放浏览卡顿异常严重」。

修复思路是给每个响应开头一段**初始突发信用**（`DELIVERY_BURST_SECS` 秒），
把速率曲线整体右移：开头对应字节立即可发（消除 TTFB），**稳态速率仍是 `bps`**
（BUG-033 的抑风暴结论不变）。本脚本即验证「A=旧行为（无突发）→ 首块慢」、
「B=修复（有突发）→ 首块快」，且 B 的稳态吞吐不得显著退化。

设计原则（硬性）
----------------
* **零生产风险**：库一律用**只读快照副本**；实例一律跑在非生产端口（默认 19879）。
  显式拒绝 `--port 9877`（以及 9876 daemon 端口）；显式拒绝 `--db` 指向
  `%APPDATA%\\com.origadmin.orighub`。默认从真实库做一致性快照到系统临时目录。
* **绝不误连他人实例**：启动前**先验端口空闲**（显式 `--port` 被占用即报错退出；用默认端口
  且被占用则自动改挑空闲端口），启动后**再验监听 socket 归属本进程**（netstat PID 比对）。
  否则会「读到别的 orig-tg 的数据却以为是自己二进制的测量」——这是本仓库真实出现过的
  静默混淆（bind 失败与就绪探测竞争）。
* **不硬编码 item id**：默认自动从副本库挑 **N 条真实落盘 video**
  （`kind='video' AND size≥20MiB AND duration>0`，按体积降序取前 N），
  并**排除** `file_path` 含 `test_videos` 的历史验收夹具（会污染码率统计）。
* **A/B**：支持两个二进制（`--binary A --binary B` 或 `--compare A B`），
  打印并排对照表 + 每条 `首块改善(ms)` / `吞吐变化(%)`；B 稳态吞吐相对 A 掉 >30%
  则结论行标 `WARN`。
* **判据**：`A 首块均值 ≥ 200ms` 且 `B 首块均值 ≤ 100ms` 且 `吞吐未退化 >30%` → `PASS`；
  否则 `FAIL` 且 `sys.exit(1)`。单二进制为基线采集模式（`BASELINE`，exit 0）。
* **清理**：任何退出路径都 kill 自起进程、删临时库副本，不留端口监听。

退出码
------
* `0` — PASS，或基线采集（BASELINE）。
* `1` — 断言失败（FAIL）；被测二进制确有回归。
* `2` — 环境/通道问题（二进制不存在、端口未就绪、无候选 item 等）。

用法
----
    # 基线采集（单二进制）
    python verify/verify_delivery_ttfb.py \
        --binary target/release/orig-tg.exe --label baseline

    # A/B 对照
    python verify/verify_delivery_ttfb.py --compare \
        target/release/orig-tg.exe target-fixed/release/orig-tg.exe --label fix

    # 用同一二进制 + 注入突发信用模拟「修复」，验证判据可判绿（无需重编）
    python verify/verify_delivery_ttfb.py --compare \
        target/release/orig-tg.exe target/release/orig-tg.exe \
        --b-env ORIG_TG_DELIVERY_BURST_SECS=4 --label burst-sim

    # 指定条目 / 端口 / 备份库 / 产物目录
    python verify/verify_delivery_ttfb.py --binary ... --items 394,408 --port 19880 \
        --db ./tmp/store.db --out ./tmp/ttfb.json
"""
from __future__ import annotations

import argparse
import atexit
import http.client
import json
import math
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

# ---------------------------------------------------------------------------
# 常量 / 阈值
# ---------------------------------------------------------------------------
DEFAULT_PORT = 19879
#: 生产端口：9877 = orig-tg 真实实例，9876 = orig-daemon。两者都显式拒绝。
PROD_PORTS = (9876, 9877)
#: 用户真实库所在目录（相对 %APPDATA%）。--db 指向其内部一律拒绝。
PROD_APPDATA_SUBDIR = Path("com.origadmin.orighub")
#: 生产 store.db 的规范相对位置。
PROD_DB_RELATIVE = Path("tg") / "store.db"

MIN_ITEM_SIZE_BYTES = 20 * 1024 * 1024  # 20 MiB
DEFAULT_TOP_N = 4
#: 服务端投递块大小（与 routes.rs `CHUNK` 对齐）——首块延迟 ≈ CHUNK / bps。
SERVER_CHUNK_BYTES = 1024 * 1024

DEFAULT_BUDGET_SECS = 3.0

#: 判据阈值（见模块 docstring）。
PASS_A_MIN_FIRST_MS = 200.0
PASS_B_MAX_FIRST_MS = 100.0
WARN_THROUGHPUT_DROP = 0.30  # >30% 视为退化

#: 这些 env 会改变限速语义，默认从子进程环境里剥离以保证可复现（可用 --a-env/--b-env 注入）。
DELIVERY_ENV_KEYS = ("ORIG_TG_DELIVERY_BPS", "ORIG_TG_DELIVERY_BURST_SECS")

READ_CHUNK = 64 * 1024
HOST = "127.0.0.1"

#: 仓库根（本文件位于 <repo>/download-engine/verify/），用于拒绝产物落仓。
REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFY_DIR = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------
@dataclass
class Item:
    """一条真实落盘 video 候选。"""

    id: int
    title: str
    file_path: str
    size: int
    duration: int

    def human_size(self) -> str:
        return "%.0fMiB" % (self.size / (1024.0 * 1024.0))


@dataclass
class CaseResult:
    """一次 Range 请求的测量结果。"""

    item_id: int
    scenario: str  # "open" | "seek"
    range_spec: str
    status: int
    header_ttfb_ms: float
    first_body_ms: float  # 可能为 nan（窗口内未收到 body）
    window_bytes: int
    elapsed_s: float
    content_range: str
    error: Optional[str] = None

    @property
    def throughput_mibps(self) -> float:
        if self.elapsed_s <= 0 or self.window_bytes <= 0:
            return 0.0
        return self.window_bytes / self.elapsed_s / (1024.0 * 1024.0)

    def to_dict(self) -> dict:
        return {
            "item_id": self.item_id,
            "scenario": self.scenario,
            "range_spec": self.range_spec,
            "status": self.status,
            "header_ttfb_ms": _round_or_none(self.header_ttfb_ms),
            "first_body_ms": _round_or_none(self.first_body_ms),
            "window_bytes": self.window_bytes,
            "elapsed_s": round(self.elapsed_s, 4),
            "throughput_mibps": round(self.throughput_mibps, 3),
            "content_range": self.content_range,
            "error": self.error,
        }


@dataclass
class RunResult:
    """一个二进制的一轮完整测量。"""

    label: str
    binary: str
    env_overrides: dict
    results: list = field(default_factory=list)

    def primary(self) -> list:
        """主路径（bytes=0-）的结果，按 item 顺序。"""
        return [r for r in self.results if r.scenario == "open" and not r.error]

    def by_item(self, item_id: int, scenario: str) -> Optional[CaseResult]:
        for r in self.results:
            if r.item_id == item_id and r.scenario == scenario:
                return r
        return None

    def mean_first_body_ms(self) -> float:
        vals = [r.first_body_ms for r in self.primary() if not math.isnan(r.first_body_ms)]
        return sum(vals) / len(vals) if vals else float("nan")


# ---------------------------------------------------------------------------
# 清理登记（任何退出路径都执行）
# ---------------------------------------------------------------------------
class Cleanup:
    """进程级清理登记：atexit + 信号钩子，保证不留监听 / 临时文件。"""

    def __init__(self) -> None:
        self._fns: list[Callable[[], None]] = []
        self._installed = False

    def register(self, fn: Callable[[], None]) -> None:
        self._fns.append(fn)

    def unregister(self, fn: Callable[[], None]) -> None:
        try:
            self._fns.remove(fn)
        except ValueError:
            pass

    def install(self) -> None:
        if self._installed:
            return
        self._installed = True
        atexit.register(self.run)
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, self._on_signal)
            except (ValueError, OSError):
                pass

    def _on_signal(self, *_a) -> None:  # pragma: no cover - 信号路径
        self.run()
        sys.exit(130)

    def run(self) -> None:
        for fn in reversed(self._fns):
            try:
                fn()
            except Exception:  # noqa: BLE001 - 清理失败不应掩盖主结果
                pass
        self._fns.clear()


CLEANUP = Cleanup()


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _round_or_none(v: float) -> Optional[float]:
    return None if v is None or math.isnan(v) else round(v, 1)


def _fail_env(msg: str, code: int = 2) -> "NoReturn":  # type: ignore[name-defined]
    print("[FATAL] " + msg, file=sys.stderr)
    CLEANUP.run()
    sys.exit(code)


def _real_appdata() -> Optional[Path]:
    ap = os.environ.get("APPDATA") or os.path.expandvars("%APPDATA%")
    if not ap or "%APPDATA%" in ap:
        return None
    return Path(ap)


def _is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def guard_port(port: int) -> None:
    """拒绝任何生产端口，避免误连真实实例。"""
    if port in PROD_PORTS:
        names = {9876: "orig-daemon", 9877: "orig-tg 真实实例"}
        _fail_env(
            "拒绝使用生产端口 %d（%s）。请改用隔离端口，例如 --port 19879。"
            % (port, names.get(port, "生产"))
        )


def guard_db(db: Optional[str]) -> None:
    """拒绝 --db 指向用户真实库目录。"""
    if not db:
        return
    ap = _real_appdata()
    if ap is None:
        return
    prod_dir = ap / PROD_APPDATA_SUBDIR
    if _is_inside(Path(db), prod_dir):
        _fail_env(
            "拒绝把 --db 指向用户真实库目录：%s\n"
            "       请让它指向一份**副本**（脚本默认会自动快照到系统临时目录）。"
            % prod_dir
        )


def guard_out(out: Path) -> None:
    """拒绝把产物写进仓库（与 tauri-shell/verify 的污染防线一致）。"""
    if _is_inside(out, REPO_ROOT):
        _fail_env(
            "拒绝把产物写进仓库目录：%s\n       请使用系统临时目录（默认）或仓外路径。"
            % out
        )


def default_real_db() -> Path:
    ap = _real_appdata()
    if ap is None:
        _fail_env("找不到 %APPDATA%，无法定位真实库；请用 --db 显式指定一份副本。")
    return ap / PROD_APPDATA_SUBDIR / PROD_DB_RELATIVE


# ---------------------------------------------------------------------------
# 端口（空闲判定 / 归属判定）
# ---------------------------------------------------------------------------
def port_is_free(port: int) -> bool:
    """不做 SO_REUSEADDR 的绑定试探：能绑上才算空闲（他人 LISTENING 会被拒）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((HOST, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def ephemeral_port() -> int:
    """向 OS 要一个空闲端口。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((HOST, 0))
        return int(s.getsockname()[1])
    finally:
        s.close()


def listening_pid(port: int) -> Optional[int]:
    """返回监听该端口的 PID；无法判定（非 Windows / netstat 不可用）返回 None。"""
    if os.name != "nt":
        return None
    try:
        # 注意：netstat 输出随系统 locale 变化（中文 Windows 常为 GBK），
        # 故按字节取回再宽松解码，避免 text=True 触发 UnicodeDecodeError。
        raw = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    suffix = ":%d" % port
    for line in text.splitlines():
        if "LISTENING" not in line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        if parts[1].endswith(suffix):
            try:
                return int(parts[-1])
            except ValueError:
                continue
    return None


def resolve_port(explicit: Optional[int]) -> int:
    """确定监听端口：显式端口必须空闲（否则报错）；默认端口被占用则自动改挑空闲端口。"""
    if explicit is not None:
        guard_port(explicit)
        if not port_is_free(explicit):
            _fail_env(
                "端口 %d 已被占用（可能有其它实例/队友在跑）。\n"
                "       换一个 --port，或省略 --port 让脚本自动挑空闲端口。" % explicit
            )
        return explicit
    guard_port(DEFAULT_PORT)
    if port_is_free(DEFAULT_PORT):
        return DEFAULT_PORT
    p = ephemeral_port()
    print("[setup] 默认端口 %d 被占用，自动改用空闲端口 %d" % (DEFAULT_PORT, p))
    return p


# ---------------------------------------------------------------------------
# 库快照（只读）
# ---------------------------------------------------------------------------
def snapshot_db(src: Path, dest: Path) -> None:
    """用 sqlite backup API 做一致性只读快照（正确处理 WAL）。"""
    if not src.exists():
        _fail_env("源库不存在：%s" % src)
    dest.parent.mkdir(parents=True, exist_ok=True)
    uri = "file:%s?mode=ro" % src.resolve().as_posix()
    con = sqlite3.connect(uri, uri=True)
    try:
        out = sqlite3.connect(str(dest))
        try:
            con.backup(out)
        finally:
            out.close()
    finally:
        con.close()


def pick_items(snapshot: Path, top_n: int, explicit_ids: Optional[list]) -> list:
    """从快照库挑候选 video 条目（见模块 docstring 的选择规则）。"""
    con = sqlite3.connect(str(snapshot))
    con.row_factory = sqlite3.Row
    try:
        if explicit_ids:
            q = (
                "select id,title,file_path,size,duration from media_item "
                "where id in (%s)" % ",".join("?" * len(explicit_ids))
            )
            rows = list(con.execute(q, explicit_ids))
        else:
            # 排除 test_videos 夹具；只取真实落盘、时长已知的较大视频。
            q = (
                "select id,title,file_path,size,duration from media_item "
                "where kind='video' "
                "  and file_path is not null and file_path <> '' "
                "  and size >= ? "
                "  and duration is not null and duration > 0 "
                "  and lower(file_path) not like '%test_videos%' "
                "order by size desc"
            )
            rows = list(con.execute(q, (MIN_ITEM_SIZE_BYTES,)))
    finally:
        con.close()

    items: list = []
    seen_paths: set = set()
    for r in rows:
        fp = str(r["file_path"])
        if not os.path.exists(fp):
            print("[select] 跳过（文件不存在）：id=%s %s" % (r["id"], fp))
            continue
        key = os.path.normcase(os.path.realpath(fp))
        if key in seen_paths:
            print("[select] 跳过（重复文件）：id=%s %s" % (r["id"], fp))
            continue
        seen_paths.add(key)
        items.append(
            Item(
                id=int(r["id"]),
                title=str(r["title"] or ""),
                file_path=fp,
                size=int(r["size"] or 0),
                duration=int(r["duration"] or 0),
            )
        )
        if not explicit_ids and len(items) >= top_n:
            break
    return items


# ---------------------------------------------------------------------------
# 隔离实例
# ---------------------------------------------------------------------------
class Server:
    """在隔离端口拉起 orig-tg（离线模式），退出时必定回收。"""

    def __init__(
        self,
        binary: str,
        port: int,
        db_path: Path,
        work_dir: Path,
        extra_env: dict,
    ) -> None:
        self.binary = binary
        self.port = port
        self.db_path = db_path
        self.work_dir = work_dir
        self.extra_env = dict(extra_env)
        self.proc: Optional[subprocess.Popen] = None
        self.log_path = work_dir / "orig-tg.log"
        self._logf = None
        self._kill_fn: Optional[Callable[[], None]] = None

    def build_env(self) -> dict:
        env = dict(os.environ)
        # 剥离会改变限速语义的 env，保证「二进制默认行为」可复现。
        for k in DELIVERY_ENV_KEYS:
            env.pop(k, None)
        env.update(self.extra_env)
        env.update(
            {
                "ORIG_TG_PORT": str(self.port),
                "ORIG_TG_DB": str(self.db_path),
                "ORIG_TG_OFFLINE": "1",
                "ORIG_TG_SESSION": str(self.work_dir / "isolated.session"),
                "ORIG_TG_DOWNLOAD_DIR": str(self.work_dir / "downloads"),
            }
        )
        return env

    def start(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._logf = open(self.log_path, "w", encoding="utf-8", errors="replace")
        try:
            self.proc = subprocess.Popen(
                [self.binary],
                env=self.build_env(),
                stdout=self._logf,
                stderr=subprocess.STDOUT,
                cwd=str(self.work_dir),
            )
        except OSError as e:
            _fail_env("启动失败：%s（%s）" % (self.binary, e))

        def _kill() -> None:
            self.stop()

        self._kill_fn = _kill
        CLEANUP.register(_kill)
        self._wait_ready()

    def _wait_ready(self, timeout_s: float = 40.0) -> None:
        deadline = time.perf_counter() + timeout_s
        while time.perf_counter() < deadline:
            # 先看自起进程是否已退出（bind 失败会立即退出并打印 [fatal] ... bind ... failed）。
            if self.proc is not None and self.proc.poll() is not None:
                rc = self.proc.returncode
                self.stop()
                _fail_env(
                    "实例提前退出（code=%s，常见原因：端口被占用）。日志尾部：\n%s"
                    % (rc, self._log_tail(2000))
                )
            try:
                c = http.client.HTTPConnection(HOST, self.port, timeout=1.5)
                c.request("GET", "/health")
                c.getresponse().read()
                c.close()
            except (OSError, http.client.HTTPException):
                time.sleep(0.25)
                continue
            # 就绪探测成功了，但必须确认应答者**是我们自己起的进程**——否则可能是
            # 他人实例占着同一端口、而我们的进程正死在 bind 上（竞态窗口）。用 netstat 比对 PID。
            if self.proc is None or self.proc.poll() is not None:
                rc = self.proc.returncode if self.proc else "?"
                self.stop()
                _fail_env(
                    "就绪探测成功但自起进程已退出（code=%s）——应答者非本进程。日志尾部：\n%s"
                    % (rc, self._log_tail(2000))
                )
            owner = listening_pid(self.port)
            if owner is not None and owner != self.proc.pid:
                foreign = owner
                self.stop()
                _fail_env(
                    "端口 %d 的监听者是 PID %d，而非本脚本启动的 PID %d——"
                    "拒绝把测量结果建立在他人实例上。请换 --port 或先释放该端口。"
                    % (self.port, foreign, self.proc.pid)
                )
            return
        self.stop()
        _fail_env("端口 %d 未就绪。日志尾部：\n%s" % (self.port, self._log_tail(2000)))

    def _log_tail(self, n: int) -> str:
        try:
            if self._logf:
                self._logf.flush()
            with open(self.log_path, encoding="utf-8", errors="replace") as f:
                return f.read()[-n:]
        except OSError:
            return "(日志不可读)"

    def stop(self) -> None:
        if self._kill_fn is not None:
            CLEANUP.unregister(self._kill_fn)
            self._kill_fn = None
        proc = self.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover
                pass
        self.proc = None
        if self._logf is not None:
            try:
                self._logf.close()
            except OSError:
                pass
            self._logf = None

    def port_is_free(self) -> bool:
        """确认端口已释放（无监听）。"""
        try:
            with socket.create_connection((HOST, self.port), timeout=0.5):
                return False
        except OSError:
            return True


# ---------------------------------------------------------------------------
# 测量
# ---------------------------------------------------------------------------
def measure_once(port: int, item: Item, scenario: str, range_spec: str, budget: float) -> CaseResult:
    """发一次 Range 请求，测：头 TTFB / body 首块 / 窗口字节 / Content-Range。"""
    conn = http.client.HTTPConnection(HOST, port, timeout=budget + 10.0)
    t0 = time.perf_counter()
    try:
        conn.request(
            "GET",
            "/api/media/items/%d/raw" % item.id,
            headers={"Range": "bytes=%s" % range_spec, "Accept-Encoding": "identity"},
        )
        resp = conn.getresponse()
        header_ttfb_ms = (time.perf_counter() - t0) * 1000.0
        status = resp.status
        content_range = resp.getheader("Content-Range") or ""
        first_body_ms = float("nan")
        nbytes = 0
        deadline = t0 + budget
        sock = conn.sock
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            if sock is not None:
                sock.settimeout(remaining)
            try:
                chunk = resp.read(READ_CHUNK)
            except (socket.timeout, TimeoutError):
                break
            if not chunk:
                break
            if math.isnan(first_body_ms):
                first_body_ms = (time.perf_counter() - t0) * 1000.0
            nbytes += len(chunk)
        elapsed = time.perf_counter() - t0
        conn.close()
        return CaseResult(
            item_id=item.id,
            scenario=scenario,
            range_spec=range_spec,
            status=status,
            header_ttfb_ms=header_ttfb_ms,
            first_body_ms=first_body_ms,
            window_bytes=nbytes,
            elapsed_s=elapsed,
            content_range=content_range,
        )
    except Exception as e:  # noqa: BLE001 - 单条失败不应中止整轮
        conn.close()
        return CaseResult(
            item_id=item.id,
            scenario=scenario,
            range_spec=range_spec,
            status=0,
            header_ttfb_ms=float("nan"),
            first_body_ms=float("nan"),
            window_bytes=0,
            elapsed_s=time.perf_counter() - t0,
            content_range="",
            error=repr(e),
        )


def run_binary(
    binary: str,
    label: str,
    port: int,
    snapshot: Path,
    work_dir: Path,
    items: list,
    budget: float,
    extra_env: dict,
) -> RunResult:
    """对单个二进制跑完所有 item × {open, seek} 并返回结果。"""
    if not os.path.exists(binary):
        _fail_env("二进制不存在：%s" % binary)
    run_dir = work_dir / ("run-" + label)
    run_dir.mkdir(parents=True, exist_ok=True)
    run_db = run_dir / "store.db"
    snapshot_db(snapshot, run_db)

    print("[run] label=%s binary=%s port=%d env=%s"
          % (label, binary, port, extra_env or "{}"))
    server = Server(binary, port, run_db, run_dir, extra_env)
    server.start()
    run = RunResult(label=label, binary=binary, env_overrides=dict(extra_env))
    try:
        for it in items:
            cases = [
                ("open", "0-"),
                ("seek", "%d-" % max(0, it.size // 2)),
            ]
            for scenario, spec in cases:
                r = measure_once(port, it, scenario, spec, budget)
                run.results.append(r)
    finally:
        server.stop()
        if not server.port_is_free():
            print("[warn] 端口 %d 在停进程后仍在监听（可能有残留实例）" % port)
    return run


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
def fmt_table(headers: list, rows: list) -> str:
    cols = len(headers)
    widths = [len(str(h)) for h in headers]
    for row in rows:
        for i in range(cols):
            widths[i] = max(widths[i], len(str(row[i])))
    line = "  ".join(str(headers[i]).ljust(widths[i]) for i in range(cols))
    out = [line, "-" * len(line)]
    for row in rows:
        out.append("  ".join(str(row[i]).ljust(widths[i]) for i in range(cols)))
    return "\n".join(out)


def _ms(v: float) -> str:
    return "-" if v is None or math.isnan(v) else "%.0f" % v


def print_run_table(run: RunResult, items: list) -> None:
    print()
    print("=== 明细 [%s] %s" % (run.label, run.binary))
    headers = ["item", "场景", "状态", "头TTFB(ms)", "首块(ms)", "3s内字节", "吞吐(MiB/s)", "Content-Range"]
    rows = []
    for it in items:
        for scenario in ("open", "seek"):
            r = run.by_item(it.id, scenario)
            if r is None:
                continue
            note = "bytes=0-" if scenario == "open" else "seek @%d" % (it.size // 2)
            if r.error:
                rows.append([it.id, note, "ERR", "-", "-", "-", "-", r.error[:40]])
            else:
                rows.append([
                    it.id,
                    note,
                    r.status,
                    _ms(r.header_ttfb_ms),
                    _ms(r.first_body_ms),
                    "{:,}".format(r.window_bytes),
                    "%.2f" % r.throughput_mibps,
                    r.content_range or "-",
                ])
    print(fmt_table(headers, rows))


def print_comparison(run_a: RunResult, run_b: RunResult, items: list) -> dict:
    """并排对照表 + 聚合。返回汇总 dict。"""
    print()
    print("=== A/B 对照（主路径 bytes=0-）")
    print("    A = %s [%s]" % (run_a.binary, run_a.label))
    print("    B = %s [%s]" % (run_b.binary, run_b.label))
    headers = ["item", "A首块(ms)", "B首块(ms)", "首块改善(ms)", "A吞吐", "B吞吐", "吞吐变化(%)"]
    rows = []
    a_first_vals, b_first_vals = [], []
    tp_ratios = []
    for it in items:
        ra = run_a.by_item(it.id, "open")
        rb = run_b.by_item(it.id, "open")
        if ra is None or rb is None or ra.error or rb.error:
            rows.append([it.id, "-", "-", "-", "-", "-", "-"])
            continue
        a_first, b_first = ra.first_body_ms, rb.first_body_ms
        if not math.isnan(a_first):
            a_first_vals.append(a_first)
        if not math.isnan(b_first):
            b_first_vals.append(b_first)
        improve = (a_first - b_first) if not (math.isnan(a_first) or math.isnan(b_first)) else float("nan")
        a_tp, b_tp = ra.throughput_mibps, rb.throughput_mibps
        delta = ((b_tp - a_tp) / a_tp * 100.0) if a_tp > 0 else float("nan")
        if a_tp > 0:
            tp_ratios.append(b_tp / a_tp)
        rows.append([
            it.id,
            _ms(a_first),
            _ms(b_first),
            _ms(improve),
            "%.2f" % a_tp,
            "%.2f" % b_tp,
            "-" if math.isnan(delta) else "%.0f%%" % delta,
        ])
    print(fmt_table(headers, rows))

    a_mean = sum(a_first_vals) / len(a_first_vals) if a_first_vals else float("nan")
    b_mean = sum(b_first_vals) / len(b_first_vals) if b_first_vals else float("nan")
    tp_ratio = sum(tp_ratios) / len(tp_ratios) if tp_ratios else float("nan")
    return {
        "a_mean_first_ms": a_mean,
        "b_mean_first_ms": b_mean,
        "throughput_ratio": tp_ratio,
        "n_a": len(a_first_vals),
        "n_b": len(b_first_vals),
    }


def verdict_ab(summary: dict) -> tuple:
    """返回 (status, warn, reason)。"""
    a_mean = summary["a_mean_first_ms"]
    b_mean = summary["b_mean_first_ms"]
    ratio = summary["throughput_ratio"]
    reasons = []
    ok = True

    if summary["n_a"] == 0 or summary["n_b"] == 0:
        return "FAIL", False, "A 或 B 无有效主路径样本"

    if math.isnan(a_mean) or a_mean < PASS_A_MIN_FIRST_MS:
        ok = False
        reasons.append("A首块均值=%.0fms < %.0fms（未复现旧行为）" % (a_mean, PASS_A_MIN_FIRST_MS))
    else:
        reasons.append("A首块均值=%.0fms >= %.0fms（旧行为已复现）" % (a_mean, PASS_A_MIN_FIRST_MS))

    if math.isnan(b_mean) or b_mean > PASS_B_MAX_FIRST_MS:
        ok = False
        reasons.append("B首块均值=%.0fms > %.0fms（未修复）" % (b_mean, PASS_B_MAX_FIRST_MS))
    else:
        reasons.append("B首块均值=%.0fms <= %.0fms（已修复）" % (b_mean, PASS_B_MAX_FIRST_MS))

    warn = False
    if math.isnan(ratio):
        reasons.append("吞吐 B/A 不可测")
    elif ratio < (1.0 - WARN_THROUGHPUT_DROP):
        warn = True
        ok = False
        reasons.append("吞吐 B/A=%.2f（相对 A 掉 >%.0f%%）" % (ratio, WARN_THROUGHPUT_DROP * 100))
    else:
        reasons.append("吞吐 B/A=%.2f（未退化 >%.0f%%）" % (ratio, WARN_THROUGHPUT_DROP * 100))

    status = "PASS" if ok else "FAIL"
    return status, warn, "；".join(reasons)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def parse_env_overrides(pairs: list) -> dict:
    out = {}
    for p in pairs:
        if "=" not in p:
            _fail_env("env 覆盖格式应为 KEY=VAL，收到：%s" % p)
        k, v = p.split("=", 1)
        out[k.strip()] = v
    return out


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(
        description="orig-tg 本地投递 body-TTFB A/B 验收",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--binary", action="append", default=[], metavar="PATH",
                    help="orig-tg 二进制路径（可给两次构成 A/B）")
    ap.add_argument("--compare", nargs=2, default=None, metavar=("A", "B"),
                    help="等价于 --binary A --binary B")
    ap.add_argument("--port", type=int, default=None,
                    help="隔离监听端口（默认 %d；被占用则自动改挑空闲端口；拒绝 9876/9877）"
                         % DEFAULT_PORT)
    ap.add_argument("--db", default=None, help="库路径（默认自动快照真实库副本）")
    ap.add_argument("--label", default=None, help="本轮标签（用于表格/产物名）")
    ap.add_argument("--items", default=None, help="逗号分隔的 item id（覆盖自动选条）")
    ap.add_argument("--top", type=int, default=DEFAULT_TOP_N, help="自动选条数量（默认 %d）" % DEFAULT_TOP_N)
    ap.add_argument("--budget", type=float, default=DEFAULT_BUDGET_SECS, help="每条观测窗口秒数（默认 3）")
    ap.add_argument("--out", default=None, help="JSON 产物路径（默认落系统临时目录）")
    ap.add_argument("--a-env", action="append", default=[], metavar="K=V", help="仅注入 A 的 env（可重复）")
    ap.add_argument("--b-env", action="append", default=[], metavar="K=V", help="仅注入 B 的 env（可重复）")
    ap.add_argument("--keep-temp", action="store_true", help="保留临时快照目录（排障用）")
    args = ap.parse_args(argv)

    CLEANUP.install()

    # ---- 参数守卫 ----
    port = resolve_port(args.port)
    guard_db(args.db)

    # ---- 解析二进制列表 ----
    if args.compare and args.binary:
        _fail_env("--compare 与 --binary 不能同时使用。")
    if args.compare:
        binaries = list(args.compare)
    else:
        binaries = list(args.binary)
    if not binaries:
        _fail_env("至少需要一个 --binary（或 --compare A B）。")
    if len(binaries) > 2:
        _fail_env("最多两个二进制（A/B）；收到 %d 个。" % len(binaries))
    for b in binaries:
        if not os.path.exists(b):
            _fail_env("二进制不存在：%s" % b)

    a_env = parse_env_overrides(args.a_env)
    b_env = parse_env_overrides(args.b_env)

    # ---- 准备快照库 ----
    tmp_root = Path(tempfile.mkdtemp(prefix="orighub-verify-ttfb-"))
    if not args.keep_temp:
        CLEANUP.register(lambda: shutil.rmtree(tmp_root, ignore_errors=True))

    if args.db:
        # 显式给的是一份「副本」；直接使用，但先做一致性快照避免并发写。
        src_db = Path(args.db)
        if not src_db.exists():
            _fail_env("--db 指定的库不存在：%s" % src_db)
        base_snapshot = tmp_root / "base-store.db"
        snapshot_db(src_db, base_snapshot)
        print("[setup] 使用 --db 的只读快照：%s" % src_db)
    else:
        src_db = default_real_db()
        base_snapshot = tmp_root / "base-store.db"
        snapshot_db(src_db, base_snapshot)
        print("[setup] 已快照真实库副本：%s -> %s" % (src_db, base_snapshot))

    # ---- 选条 ----
    explicit_ids = None
    if args.items:
        try:
            explicit_ids = [int(x.strip()) for x in args.items.split(",") if x.strip()]
        except ValueError:
            _fail_env("--items 需为逗号分隔整数：%s" % args.items)
    items = pick_items(base_snapshot, args.top, explicit_ids)
    if not items:
        _fail_env("未选出任何候选 video（size>=20MiB 且 duration>0 且非 test_videos）。")

    print()
    print("=== 候选条目（%d 条%s）"
          % (len(items), "，显式 --items" if explicit_ids else "，自动：体积降序 top-%d，排除 test_videos" % args.top))
    sel_rows = []
    for it in items:
        bps = max(it.size / max(it.duration, 1) * 6.0, 1024.0 * 1024.0)
        expected_ms = SERVER_CHUNK_BYTES / bps * 1000.0
        sel_rows.append([it.id, it.human_size(), "%.0fs" % it.duration,
                         "%.2f" % (it.size / max(it.duration, 1) / 1048576.0),
                         "%.2f" % (bps / 1048576.0),
                         "%.0f" % expected_ms, it.title[:36]])
    print(fmt_table(
        ["item", "体积", "时长", "码率MiB/s", "节流MiB/s", "预期首块ms", "标题"], sel_rows))

    # ---- 跑测量 ----
    label_base = args.label or ("baseline" if len(binaries) == 1 else "ab")
    runs = []
    for idx, binary in enumerate(binaries):
        if len(binaries) == 1:
            label, extra = label_base, a_env
        else:
            label = "%s-%s" % (label_base, "A" if idx == 0 else "B")
            extra = a_env if idx == 0 else b_env
        runs.append(run_binary(binary, label, port, base_snapshot,
                               tmp_root, items, args.budget, extra))

    for r in runs:
        print_run_table(r, items)

    # ---- 结论 ----
    result = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "mode": "ab" if len(runs) == 2 else "baseline",
        "port": port,
        "budget_s": args.budget,
        "source_db": str(src_db),
        "items": [
            {"id": it.id, "title": it.title, "file_path": it.file_path,
             "size": it.size, "duration": it.duration} for it in items
        ],
        "runs": [
            {"label": r.label, "binary": r.binary, "env_overrides": r.env_overrides,
             "results": [c.to_dict() for c in r.results]}
            for r in runs
        ],
        "verdict": {},
    }

    warn = False
    if len(runs) == 2:
        summary = print_comparison(runs[0], runs[1], items)
        status, warn, reason = verdict_ab(summary)
        result["verdict"] = {
            "status": status, "warn": warn, "reason": reason, **summary,
        }
        tag = " %s" % "WARN" if warn else ""
        print()
        print("CONCLUSION: %s%s  %s" % (status, tag, reason))
    else:
        status = "BASELINE"
        result["verdict"] = {
            "status": status,
            "reason": "单二进制基线采集（无 A/B，不断言）",
        }
        print()
        print("CONCLUSION: BASELINE  单二进制基线采集（label=%s，无 A/B 断言）" % runs[0].label)

    # ---- 写 JSON 产物（默认系统临时目录，拒绝落仓）----
    if args.out:
        out_path = Path(args.out)
    else:
        out_dir = Path(tempfile.gettempdir()) / "orighub-verify-ttfb"
        out_path = out_dir / ("ttfb_%s.json" % label_base.replace(os.sep, "_"))
    guard_out(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("[saved] %s" % out_path)

    CLEANUP.run()
    if status == "FAIL":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
