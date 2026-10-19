#!/usr/bin/env python3
"""BUG-319 验收：引擎下载任务必须跨进程存活（方案 A：落 SQLite + 启动恢复）。

用户规范（强制自动化验收）：不靠人手点界面，脚本自己抓真实状态码与真实栈行为。
本脚本跑在**真实运行栈**上（daemon + orig-tg + 脱离式监督者），并且真的把
引擎栈整树杀掉一次 —— 这正是用户撞上的那个场景。

用法::

    # 无监督者时用（脚本自己等栈回来）
    python scripts/verify_bug319_engine_persistence.py
    # 有监督者时（推荐：杀栈后由监督者拉回，脚本只验）
    python scripts/verify_bug319_engine_persistence.py --supervised

断言：

- A1  入队一条下载后，`/api/activity` 里看得到它（kind=download）
- A2  杀整树后栈真的没了（不是假杀）
- A3  栈回来之后，**那条下载行还在**（id 相同）—— 本号的核心
- A4  在跑的行被恢复为 downloading（重新入队）或 interrupted（重建失败也必须留）
- A5  暂停过的行恢复后仍是 paused（用户意图不因重启被改写）
- A6  删除是唯一让行消失的路径（删后不再出现）

用 mock:// 协议（虚拟协议，零网络依赖）造下载任务，不碰真实网络与用户文件。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DAEMON = "http://127.0.0.1:19786"
PASS, FAIL = [], []


def check(ok: bool, name: str, detail: str) -> None:
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")


def http(method: str, url: str, body: dict | None = None, timeout: float = 10.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return e.code, raw
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, str(e)


def activity() -> list[dict]:
    # `scope=active` 是端点默认（只给在途），暂停/完成的行按设计不在其中 ——
    # 验收「记录在不在」必须显式要全集，否则是把端点的默认门控当成行丢了。
    status, body = http("GET", f"{DAEMON}/api/activity?scope=all")
    if status != 200 or not isinstance(body, dict):
        return []
    tasks = body.get("tasks") or []
    return [t for t in tasks if t.get("kind") == "download"]


def row(dls: list[dict], tid: str) -> dict | None:
    for t in dls:
        if t.get("id") == f"dl:{tid}" or t.get("groupKey") == tid:
            return t
    return None


def port_pid(port: int) -> int | None:
    out = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, encoding="gbk", errors="replace"
    ).stdout
    for line in out.splitlines():
        if "LISTENING" not in line:
            continue
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(f":{port}") and parts[-1].isdigit():
            return int(parts[-1])
    return None


def enqueue(name: str, size: int) -> str | None:
    status, body = http(
        "POST",
        f"{DAEMON}/api/downloads",
        {"url": f"mock://{name}?size={size}", "filename": name},
    )
    if status == 201 and isinstance(body, dict):
        return body.get("id")
    print(f"    enqueue {name} -> {status} {body}")
    return None


def library_root() -> str:
    """受管下载根（落盘文件的清理需要它）。"""
    status, body = http("GET", f"{DAEMON}/api/files")
    if status == 200 and isinstance(body, dict):
        roots = body.get("roots") or []
        if roots:
            return str(roots[0]).replace(chr(92), "/").rstrip("/")
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--supervised",
        action="store_true",
        help="stack is guarded by dev_services.py --supervise; wait for it to come back",
    )
    args = ap.parse_args()

    # 前置：栈必须是活的
    if not http("GET", f"{DAEMON}/health")[0] == 200:
        print("FAIL 前置: daemon 不在，无法验收")
        return 2

    # ---- A1：入队两条（一条让它跑，一条先暂停）----
    # 尺寸刻意取小：这是验收夹具，不是压测。第一版用 512/256 MB，
    # 四次跑下来在库根留了 571 MB —— 验收不许把垃圾留在用户机器上。
    big = enqueue("bug319-running.bin", 64 * 1024 * 1024)
    paused = enqueue("bug319-paused.bin", 32 * 1024 * 1024)
    if paused:
        # 立刻暂停：暂停是用户意图，重启后必须还是暂停的
        http("POST", f"{DAEMON}/api/downloads/{paused}?action=pause")
        time.sleep(0.5)
        st = http("POST", f"{DAEMON}/api/downloads/{paused}?action=pause")[0]
        print(f"    pause {paused} -> {st}")

    dls = activity()
    r1 = row(dls, big) if big else None
    r2 = row(dls, paused) if paused else None
    check(r1 is not None, "A1a", f"入队的行在 /api/activity 可见 id={big}")
    check(r2 is not None and r2.get("status") == "paused", "A1b", f"暂停的行 status={r2 and r2.get('status')}")

    # ---- A2：杀整树 + 等它回来 ----
    #
    # 判据刻意**不依赖时序**：监督者最快 1s 内就能把栈拉回来，
    # 「杀完 1s 后端口还 UP 吗」测的是监督者的响应速度，不是本号要验的东西。
    # 本号要验的是「栈确实死过一次（内存表连同进程一起没了）又被重建」——
    # 于是看 19786 上的 pid 有没有变。
    victim = port_pid(19786)
    if victim:
        subprocess.run(["taskkill", "/PID", str(victim), "/T", "/F"], capture_output=True)
    if args.supervised:
        deadline = time.monotonic() + 60.0
        while time.monotonic() < deadline:
            p = port_pid(19786)
            if p and p != victim:
                break
            time.sleep(1.0)
        # 恢复是后台 spawn 的，给它把任务建起来的时间
        time.sleep(3.0)
    else:
        print("    （无监督者模式：请自行拉回栈后按回车）")
        input()
    reborn = port_pid(19786)
    check(
        victim is not None and reborn is not None and reborn != victim,
        "A2",
        f"栈被整树杀掉（pid={victim}）后被重建（pid={reborn}）—— 内存表必随旧进程一起消失",
    )

    alive = http("GET", f"{DAEMON}/health")[0] == 200
    check(alive, "A3pre", f"栈已回来={alive}")

    if not alive:
        print(f"\nHAS FAIL: {len(PASS)}/{len(PASS) + len(FAIL)}")
        return 1

    # ---- A3：行还在（本号核心）----
    dls = activity()
    r1b = row(dls, big) if big else None
    r2b = row(dls, paused) if paused else None
    check(r1b is not None, "A3a", f"杀栈前在跑的行仍在 id={big}（修前：整行消失）")
    check(r2b is not None, "A3b", f"杀栈前暂停的行仍在 id={paused}")

    # ---- A4：在跑的行被重新入队 ----
    #
    # 三种结果都算通过，但含义不同，必须分开讲清楚：
    #   - downloading：重建成功、正在续跑（最理想）；
    #   - completed：重建成功且本地源瞬间跑完了 —— 记录里必须有真实字节
    #     （done == total），否则「完成」只是个假状态；
    #   - interrupted：重建失败（源站失效等外部事实），记录仍在 —— 这也不算丢。
    if r1b:
        st = r1b.get("status")
        done, total = (r1b.get("done") or 0), (r1b.get("total") or 0)
        ok = st in ("downloading", "interrupted") or (st == "completed" and total > 0 and done == total)
        check(ok, "A4", f"恢复后 status={st} done={done}/{total}")
    else:
        check(False, "A4", "行不在，无从判断状态")

    # ---- A5：暂停的行恢复后仍是 paused（用户意图不被重启改写）----
    if r2b:
        st2 = r2b.get("status")
        check(st2 == "paused", "A5", f"暂停过的行恢复后 status={st2}（必须为 paused）")
    else:
        check(False, "A5", "行不在，无从判断状态")

    # ---- A6：删除是唯一让行消失的路径 ----
    if r1b:
        native = r1b.get("control", {}).get("nativeId") or big
        code = http("DELETE", f"{DAEMON}/api/downloads/{native}")[0]
        time.sleep(1.0)
        gone = row(activity(), big) is None
        check(gone, "A6", f"DELETE -> {code}，删除后行不再出现={gone}")
    else:
        check(False, "A6", "行不在，无从验证删除")

    # ---- 收尾：把自己造的东西全部清掉 ----
    #
    # 第一版留下 4 条任务记录 + 571 MB 文件 —— 那是**验收自己制造的数据丢失**，
    # 与本号要消灭的东西是同一类。夹具必须在脚本结束前消失：
    # 任务记录走 DELETE（库内行一起删），落盘文件走受管根的文件端点。
    for tid in (big, paused):
        if tid:
            http("DELETE", f"{DAEMON}/api/downloads/{tid}")
    root = library_root()
    if root:
        for name in ("bug319-running.bin", "bug319-paused.bin"):
            http("DELETE", f"{DAEMON}/api/files?path={urllib.parse.quote(f'{root}/{name}', safe='')}")
    leftover = [t for t in activity() if t.get("kind") == "download"]
    check(not leftover, "A7", f"验收结束后下载行残留 {len(leftover)} 条（夹具必须清干净）")

    total = len(PASS) + len(FAIL)
    print(f"\n{'ALL PASS' if not FAIL else 'HAS FAIL'}: {len(PASS)}/{total}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
