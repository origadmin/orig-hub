#!/usr/bin/env python3
"""BUG-322 验收：引擎下载行必须在**两个呈现面**上一致，且停住的行能重试。

两件事，一件是缺口、一件是能力：

- **缺口（BUG-319 未真正修完）**：`GET /api/downloads`（下载页引擎行的真源）
  此前只读内存，`/api/activity`（聚合面）读内存 ∪ 库。栈一重启，聚合面有行、
  下载页空白 —— 同一个事实两个答案，用户看到的就是「全部下载数据丢失」。
- **能力（BUG-322）**：记录留下来却动不了 = 把结果变成遗迹。停住的行
  （interrupted / error / cancelled）必须能重试。

为什么动作必须后端下发（本脚本同时验这条）：前端若按 `status` 自己推按钮，
每加一个来源就要改一遍 UI；后端下发 `actions` 后，新来源只在 `actions_for`
声明一次。本脚本断言「行上的 actions 来自后端」而非「前端猜出来的」。

用法::

    python scripts/verify_bug322_engine_retry.py --supervised

断言：
- A1   入队后下载页真源（/api/downloads）看得到它，且 actions 来自后端
- A2   杀整树后栈真的没了（不是假杀）
- A3   栈回来后，**下载页真源**里那条行还在（本号核心缺口）
- A4   同一 id 在聚合面也在 —— 两个面必须同一份合并结果
- A5   取消后的行状态为 cancelled 且 actions 含 retry
- A6   POST retry 返回 200，且响应明说 resume=false（无真续传，不冒充「继续」）
- A7   retry 之后该行真的开始跑（downloading）
- A8   活体行 retry 返回 409（它还能被 pause，不需要重试）
- A9   不存在的 id 返回 404
- A10  已完成的行 retry 返回 409（重试它只会覆盖它自己）
- A11  清理后残留为 0（记录 + 落盘文件）

用 mock:// 协议（虚拟协议，零网络依赖）造任务，全部落在受管下载根下，
脚本结束前自行删除 —— 验收不许在用户机器上留垃圾。
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
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, str(e)


def list_downloads() -> list[dict]:
    """下载页引擎行的真源：`GET /api/downloads`。"""
    status, body = http("GET", f"{DAEMON}/api/downloads")
    return body if status == 200 and isinstance(body, list) else []


def activity_rows() -> list[dict]:
    # 端点默认 scope=active（只给在途），验收「记录在不在」必须显式要全集。
    status, body = http("GET", f"{DAEMON}/api/activity?scope=all")
    if status != 200 or not isinstance(body, dict):
        return []
    return [t for t in (body.get("tasks") or []) if t.get("kind") == "download"]


def find(rows: list[dict], tid: str) -> dict | None:
    for r in rows:
        if r.get("id") == tid or r.get("id") == f"dl:{tid}":
            return r
    return None


def enqueue(name: str, size_mb: int, rate: str) -> str | None:
    status, body = http(
        "POST",
        f"{DAEMON}/api/downloads",
        {
            "url": f"mock://{name}?size={size_mb * 1024 * 1024}&rate={rate}",
            "filename": name,
        },
    )
    if status == 201 and isinstance(body, dict):
        return body.get("id")
    print(f"    enqueue {name} -> {status} {body}")
    return None


def act(tid: str, action: str):
    return http("POST", f"{DAEMON}/api/downloads/{tid}?action={action}")


def retry(tid: str):
    return http("POST", f"{DAEMON}/api/downloads/{tid}/retry")


def post_delete(tid: str):
    return http("DELETE", f"{DAEMON}/api/downloads/{tid}")


def library_root() -> str:
    status, body = http("GET", f"{DAEMON}/api/files")
    if status == 200 and isinstance(body, dict):
        roots = body.get("roots") or []
        if roots:
            return str(roots[0]).replace(chr(92), "/").rstrip("/")
    return ""


def delete_file(path: str) -> None:
    if not path:
        return
    u = f"{DAEMON}/api/files?path=" + urllib.parse.quote(path, safe="")
    http("DELETE", u, timeout=15.0)


def port_pid(port: int) -> int | None:
    try:
        # netstat 在中文 Windows 上输出 GBK 字节，按 utf-8 严格解码会直接抛
        # UnicodeDecodeError 拿不到 stdout（端口行本身是 ASCII，用 replace 足够）。
        out = (
            subprocess.run(
                ["netstat", "-ano"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
            ).stdout
            or ""
        )
    except Exception:
        return None
    for line in out.splitlines():
        if f":{port} " in line and "LISTENING" in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                return int(parts[-1])
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--supervised", action="store_true", help="杀栈后由监督者拉回")
    args = ap.parse_args()

    created: list[str] = []

    # ── A1：入队一条慢任务 ──
    # 32 MiB @ 256 KiB/s ≈ 128 秒。必须**慢到足够操作**：用快源的话任务会在
    # 我们动手之前就跑完，于是取消拿到 404、重试拿到 409 —— 那是在验收自己的
    # 时序，不是在验收重试。
    slow = enqueue("bug322-slow.bin", 32, "256k")
    check(slow is not None, "A1a", f"入队慢任务 id={slow}")
    if slow:
        created.append(slow)
    row_now = find(list_downloads(), slow) if slow else None
    check(
        row_now is not None and row_now.get("status") == "downloading",
        "A1b",
        f"下载页真源看得到它：status={row_now.get('status') if row_now else None}",
    )
    acts = (row_now or {}).get("actions") or []
    check(
        "pause" in acts and "cancel" in acts,
        "A1c",
        f"行上的 actions 由后端下发且含 pause/cancel：{acts}",
    )

    # ── 先取消，造出一条「停住」的库记录 ──
    #
    # **必须在杀栈之前**：本号的核心对象是「记录还在、句柄已不在」的行。
    # 若先杀栈，重启会把在跑的任务重新入队进内存，于是下载页光靠内存就能看到它
    # —— 那条断言在撤掉库合并的验牙里仍然恒绿，等于没验到缺口（实测如此）。
    if slow:
        st, _b = act(slow, "cancel")
        print(f"    cancel -> {st}")
        time.sleep(2.0)  # 后台收尾落终态并让出句柄
    cancelled = find(list_downloads(), slow) if slow else None
    check(
        cancelled is not None and cancelled.get("status") == "cancelled",
        "A1d",
        f"取消后该行仍在且状态={cancelled.get('status') if cancelled else None}",
    )

    # ── A2/A3/A4：杀整树，验下载页真源（核心缺口）──
    victim = port_pid(19786)
    if victim:
        subprocess.run(["taskkill", "/PID", str(victim), "/T", "/F"], capture_output=True)
    time.sleep(1.5)
    down = http("GET", f"{DAEMON}/health")[0] is None
    check(down, "A2", f"杀整树 pid={victim} 后 daemon 真的没了={down}")

    if args.supervised:
        deadline = time.monotonic() + 90.0
        while time.monotonic() < deadline:
            if http("GET", f"{DAEMON}/health")[0] == 200:
                break
            time.sleep(1.0)
        time.sleep(3.0)
    else:
        print("    （无监督者模式：请自行拉回栈后按回车）")
        input()

    back = find(list_downloads(), slow) if slow else None
    check(back is not None, "A3", f"栈回来后下载页真源仍有该行：{back is not None}")
    if back:
        check(
            back.get("status") == "cancelled",
            "A3b",
            f"终态不该被重启改写：status={back.get('status')}（期望 cancelled）",
        )
    agg = find(activity_rows(), slow) if slow else None
    check(agg is not None, "A4", f"聚合面也看得到同一 id：{agg is not None}")

    # ── A5：停住的行必须能重试 ──
    a5row = back or cancelled
    c_acts = (a5row or {}).get("actions") or []
    check("retry" in c_acts, "A5", f"cancelled 行的 actions 含 retry：{c_acts}")

    # ── A6/A7：真重试 ──
    code, body = retry(slow) if slow else (None, None)
    resume_flag = body.get("resume") if isinstance(body, dict) else None
    check(
        code == 200 and resume_flag is False,
        "A6",
        f"POST retry -> {code} resume={resume_flag}（必须是 false：无真续传）",
    )
    time.sleep(1.5)
    after = find(list_downloads(), slow) if slow else None
    check(
        after is not None and after.get("status") == "downloading",
        "A7",
        f"retry 后该行真的在跑：status={after.get('status') if after else None}",
    )

    # ── A8：活体行不可重试 ──
    code8, _ = retry(slow) if slow else (None, None)
    check(code8 == 409, "A8", f"活体行 retry -> {code8}（必须 409）")

    # ── A9：不存在的 id ──
    code9, _ = retry("00000000-0000-0000-0000-000000000000")
    check(code9 == 404, "A9", f"不存在的 id retry -> {code9}（必须 404）")

    # ── A10：已完成的行不可重试 ──
    fast = enqueue("bug322-fast.bin", 1, "100m")
    if fast:
        created.append(fast)
    time.sleep(2.5)
    frow = find(list_downloads(), fast) if fast else None
    if frow and frow.get("status") != "completed":
        time.sleep(3.0)
        frow = find(list_downloads(), fast)
    code10, _ = retry(fast) if fast else (None, None)
    check(
        frow is not None and frow.get("status") == "completed" and code10 == 409,
        "A10",
        f"completed 行 status={frow.get('status') if frow else None} retry -> {code10}（必须 409）",
    )

    # ── A11：清理（验收不许留垃圾）──
    for tid in created:
        post_delete(tid)
    # 落盘文件按**枚举到的真实路径**删，不按拼出来的路径删：重复入队会让名字
    # 变成「x (1).bin」，拼路径就删不掉，验收自己反倒制造了残留。
    _st, fbody = http("GET", f"{DAEMON}/api/files")
    for f in fbody.get("files") if isinstance(fbody, dict) else []:
        if isinstance(f, dict) and "bug322" in (f.get("name") or ""):
            delete_file(f.get("path") or "")
    time.sleep(1.0)
    left = [t for t in list_downloads() if t.get("id") in created]
    _st2, fbody2 = http("GET", f"{DAEMON}/api/files")
    files_left = [
        f
        for f in (fbody2.get("files") if isinstance(fbody2, dict) else [])
        if isinstance(f, dict) and "bug322" in (f.get("name") or "")
    ]
    check(
        not left and not files_left,
        "A11",
        f"清理后残留记录={len(left)} 文件={len(files_left)}（必须都为 0）",
    )

    total = len(PASS) + len(FAIL)
    print(f"\n{'ALL PASS' if not FAIL else 'HAS FAIL'}: {len(PASS)}/{total}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
