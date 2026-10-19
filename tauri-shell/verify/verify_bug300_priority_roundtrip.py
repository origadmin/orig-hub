#!/usr/bin/env python3
"""BUG-300 复报③：优先下载真实栈 roundtrip（orig-tg 19787）。

流程：选 1 个 cancelled 任务 → retry（→ queued）→ **立即** POST {top:true}
（趁 worker 还没把它抓起；被抓起会 422，换下一个任务重试）→ /all 验证 priority
持久化 → POST {priority:0} 取消置顶 → /all 验证归零 → 收尾取消。

**方法论要点（2026-10-15 两跑实证）**：
- 缓存字节的任务 retry 后 worker 亚秒级跑完 ⇒ queued 窗口极短，「先轮询看到
  queued 再置顶」必中竞态（第二跑实证：轮询看到 queued、POST 到达时已 running，
  守卫正确 422）。故置顶必须在 retry 后立即发，且 422-竞态要能换任务重试。
- 终态判据是「不留活跃任务、不留残留置顶」，不是某个具体终态：任务可能在收尾
  取消赶到前就自己跑完（done）。被取消任务的字节多已缓存（取消不清库内容），
  跑完只是把任务状态对齐到事实，media_item 计数不变（两跑后实测仍 542）。
- try/finally 保证任何异常路径都执行收尾，不留活跃任务。
"""
import pathlib
import json
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:19787"
OUT = []
USED = set()  # 已动过的任务 id，避免同一批反复翻态


def log(s):
    print(s)
    OUT.append(s)


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "{}")


def tasks():
    s, d = req("GET", "/api/tg/cache/tasks/all")
    assert s == 200, s
    return d["tasks"] if isinstance(d, dict) else d


def by_id(tid):
    return next((t for t in tasks() if t["id"] == tid), None)


def cancel(tid):
    s, v = req("DELETE", f"/api/tg/cache/tasks/{tid}")
    log(f"[cleanup] cancel id={tid} -> {s} {v}")
    return s


# ── 0. 基线 ──────────────────────────────────────────────────────────────
ts = tasks()
base_pinned = [(t["id"], t["priority"]) for t in ts if t.get("priority", 0) > 0]
candidates = sorted(
    (t for t in ts if t["status"] == "cancelled" and t["id"] not in USED),
    key=lambda t: t["id"],
)
log(f"[base] total={len(ts)} cancelled_candidates={len(candidates)} pinned={base_pinned}")
assert candidates, "no unused cancelled task to retry"

# ── 1. retry + 立即置顶（竞态重试：被 worker 抓起就换下一个）─────────────
pinned_id = None
pinned_val = None
picked = None
try:
    for cand in candidates[:5]:
        tid = cand["id"]
        USED.add(tid)
        s, v = req("POST", f"/api/cache/tasks/{tid}/retry")
        log(f"[retry] id={tid} -> {s} status={v.get('status')}")
        assert s == 200, v
        picked = tid
        # 立即置顶：此刻任务应仍是 queued（worker 的 spawn→取任务需要一次 DB 往返）
        s, v = req("POST", f"/api/tg/cache/tasks/{tid}/priority", {"top": True})
        if s == 200:
            pinned_id, pinned_val = tid, v["tasks"][0]["priority"]
            log(f"[top] id={tid} -> 200 priority={pinned_val}（置顶于 queued 窗口内）")
            break
        log(f"[top] id={tid} -> {s} {v}（worker 已抓起，换下一个任务）")
        assert s == 422 and "queued" in v.get("error", ""), v
        cancel(tid)
        picked = None
    assert pinned_id is not None, "5 个任务都没抢到 queued 窗口（缓存字节太快）"

    # ── 2. 持久化：/all 里就该带着这个 priority ──────────────────────────
    persisted = by_id(pinned_id)
    log(f"[top->persist] /all: id={pinned_id} status={persisted['status']} "
        f"priority={persisted['priority']}")
    assert persisted["priority"] == pinned_val, persisted
    assert pinned_val >= 1, pinned_val

    # ── 3. 取消置顶（已置顶任务任何状态都可撤，BUG-277）──────────────────
    s, v = req("POST", f"/api/tg/cache/tasks/{pinned_id}/priority", {"priority": 0})
    log(f"[unprefer] id={pinned_id} -> {s} body={v}")
    assert s == 200 and v["tasks"][0]["priority"] == 0, v
    back = by_id(pinned_id)
    log(f"[unprefer->persist] /all: priority={back['priority']}")
    assert back["priority"] == 0, back
finally:
    # ── 4. 收尾：动过的任务一律取消（404 = 已自己跑完，容忍）──────────────
    for tid in sorted(USED):
        t = by_id(tid)
        if t and t["status"] in ("queued", "running"):
            cancel(tid)

# ── 5. 终态判据：不留活跃任务、不留残留置顶 ────────────────────────────
time.sleep(0.5)
ts = tasks()
pinned = [(t["id"], t["priority"]) for t in ts if t.get("priority", 0) > 0]
active = [(t["id"], t["status"]) for t in ts if t["status"] in ("queued", "running")]
finals = {t["id"]: (t["status"], t.get("priority", 0)) for t in ts if t["id"] in USED}
log(f"[final] touched={finals} active={active or 'NONE'} pinned={pinned}")

TERMINAL = {"done", "failed", "cancelled", "interrupted"}
ok = (
    not active                                   # 不留活跃任务
    and all(st in TERMINAL for st, _ in finals.values())
    and all(p == 0 for _, p in finals.values())  # 动过的任务归零
    and pinned == base_pinned                    # 既有置顶原样
)
log(f"[result] {'PASS - prefer/unprefer roundtrip ok on live stack' if ok else 'FAIL - see final line'}")

# 产物路径由脚本位置推导（污染门禁 §7：脚本禁含机器绝对路径）：
# <repo>/tauri-shell/verify/<this>.py -> <repo>/verify_shots/bug300-ingest-aggregation/
SHOT_DIR = pathlib.Path(__file__).resolve().parents[3] / "verify_shots" / "bug300-ingest-aggregation"
SHOT_DIR.mkdir(parents=True, exist_ok=True)
with open(SHOT_DIR / "priority-roundtrip.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(OUT) + "\n")
