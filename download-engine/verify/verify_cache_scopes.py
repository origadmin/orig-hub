"""orig-tg 缓存清理契约验证（BUG-059：「清除缓存文件」从全清动作改成选择驱动的清理中心）。

必须对**独立端口**运行（默认 9878，mock 构建 + `ORIG_TG_MOCK=1`）—— 本脚本会
**真的删文件**（这正是要验的能力），绝不能指向 9877 的真实实例（BUG-023 的教训）。

覆盖：
  1. 预览结构完整（total / orphan / external / stale / failed / byChat / items）
  2. 预览读数与 `/api/cache/stats` 及**磁盘实占**三方一致（逐字）
  3. 预览零副作用（调用前后条目 `filePath` 与占用快照逐字未变）
  4. 端点半径：空 / 非法 / 越界 id、未知 scope、0 天一律 422 或无害（removed=0）
  5. 孤儿档：只删「磁盘有、库里无」；**下载中的 `.part` 不算孤儿**
  6. 外部文件永不删（`scope=all` 下 `skipped` 计数增加且文件仍在）
  7. **「全部」档 = 全部缓存条目，不含孤儿** —— 孤儿只认独立档（这是按钮命名的依据：
     叫「全部缓存条目」不是「全部缓存字节」，否则清完孤儿仍在就是谎报）
  8. 集合档：只清所选，其它条目的 `filePath` 逐字未变
  9. 陈旧档：阈值生效（早于 N 天的删掉、**未到期的一条不删**）
  10. `bytesFreed` 与磁盘实际释放量逐字一致

用法（服务已由 run_cache_clear_verify.sh 拉起）：
  ORIG_TG_BASE=http://127.0.0.1:9878 \
  ORIG_TG_DOWNLOAD_DIR=<隔离下载目录> \
  python verify_cache_scopes.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("ORIG_TG_BASE", "http://127.0.0.1:9878")
CHAT = -1001234567890  # 占位频道 id（mock 客户端不需要真实 peer）
DL = os.environ.get("ORIG_TG_DOWNLOAD_DIR", "")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))
    return cond


def req(method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def authorize():
    s, b = req("POST", "/api/tg/start", {"phone": "+10000000000"})
    assert s == 200, f"start failed: {s} {b}"
    s, b = req("POST", "/api/tg/code", {"phone": "+10000000000", "code": "00000"})
    assert s == 200 and b.get("phase") == "Authorized", f"code failed: {s} {b}"


def tasks():
    # `/api/cache/tasks` 只有 DELETE（动词唯一）；**全量列表**在 `/api/tg/cache/tasks/all`
    # （`/api/tg/cache/tasks` 是「当前唯一任务」的读视图，不是列表）。路径写错会拿到 405。
    s, b = req("GET", "/api/tg/cache/tasks/all")
    assert s == 200, f"tasks failed: {s} {b}"
    return b.get("tasks", [])


def wait_status(tid, want, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for t in tasks():
            if t["id"] == tid:
                if t["status"] == want:
                    return t
                if t["status"] in ("failed", "cancelled", "interrupted"):
                    raise AssertionError(f"task {tid} ended as {t['status']}: {t.get('error')}")
        time.sleep(0.25)
    raise AssertionError(f"task {tid} never reached {want}")


def enqueue(message_ids, group_id=None):
    body = {"chatId": CHAT, "messageIds": message_ids}
    if group_id is not None:
        body["groupId"] = group_id
    s, b = req("POST", "/api/tg/cache/tasks", body)
    assert s == 200, f"enqueue failed: {s} {b}"
    return b


def stats():
    s, b = req("GET", "/api/cache/stats")
    assert s == 200, f"stats failed: {s} {b}"
    return b


def preview(older_days=None):
    q = f"?olderThanDays={older_days}" if older_days else ""
    s, b = req("GET", f"/api/cache/clear/preview{q}")
    assert s == 200, f"preview failed: {s} {b}"
    return b


def items():
    s, b = req("GET", "/api/media/items?page=1&page_size=500")
    assert s == 200, f"items failed: {s} {b}"
    return b.get("items", b) if isinstance(b, dict) else b


def file_path_map():
    """{id: filePath} 快照 —— 断言用它逐字比对，比「条目数」严格得多。"""
    out = {}
    for it in items():
        out[it["id"]] = it.get("filePath")
    return out


def disk_usage(root):
    """目录实占（排除下载中的临时文件，与后端口径一致）。"""
    files = 0
    total = 0
    for dirpath, _dirs, fns in os.walk(root):
        for fn in fns:
            if fn.endswith(".part") or fn.endswith(".tmp"):
                continue
            p = os.path.join(dirpath, fn)
            try:
                total += os.path.getsize(p)
                files += 1
            except OSError:
                continue
    return files, total


def clear(query):
    return req("POST", f"/api/cache/clear{query}")


def touch_old(path, days):
    """把文件 mtime 拨到 N 天前（陈旧档的靶子）。"""
    when = time.time() - days * 86400
    os.utime(path, (when, when))


def main():
    assert DL, "ORIG_TG_DOWNLOAD_DIR 必须指向隔离下载目录"
    os.makedirs(DL, exist_ok=True)
    authorize()

    print("### 准备：缓存 3 条（产生真实字节与条目 file_path）")
    t = enqueue([101, 102, 103], group_id=777)
    wait_status(t["id"], "done")
    snap = file_path_map()
    cached = {k: v for k, v in snap.items() if v and os.path.abspath(v).startswith(os.path.abspath(DL))}
    check("准备：缓存产生 ≥3 条带字节的条目", len(cached) >= 3, f"cached={len(cached)}")

    # ---------- 1. 预览结构 + 三方一致 ----------
    print("### 阶段 1：预览契约（结构 / 三方一致 / 零副作用）")
    pv = preview()
    for key in ("total", "orphan", "external", "stale", "failed", "byChat", "items"):
        check(f"1a 预览含 `{key}`", key in pv, f"keys={sorted(pv.keys())[:8]}")
    st = stats()
    check(
        "1b 预览 total 与 /api/cache/stats 逐字一致",
        pv["total"]["count"] == st["files"] and pv["total"]["bytes"] == st["bytes"],
        f"preview={pv['total']} stats=files:{st['files']},bytes:{st['bytes']}",
    )
    du_files, du_bytes = disk_usage(DL)
    check(
        "1c 预览 total+orphan 与磁盘实占逐字一致（三方一致）",
        pv["total"]["bytes"] + pv["orphan"]["bytes"] == du_bytes
        and pv["total"]["count"] + pv["orphan"]["count"] == du_files,
        f"preview total+orphan={pv['total']['bytes'] + pv['orphan']['bytes']}"
        f"/{pv['total']['count'] + pv['orphan']['count']} disk={du_bytes}/{du_files}",
    )
    titles = [x.get("title") for x in pv.get("items", [])]
    check("1d 预览明细带标题（认得出删的是哪几条）", bool(titles) and all(t for t in titles),
          f"sample={titles[:2]}")

    before_fp, before_st = file_path_map(), stats()
    preview()
    preview(7)
    after_fp, after_st = file_path_map(), stats()
    check("1e 预览零副作用（filePath 与占用快照逐字未变）",
          before_fp == after_fp and before_st == after_st,
          f"changed={[k for k in before_fp if before_fp.get(k) != after_fp.get(k)]}")

    # ---------- 2. 端点半径 ----------
    print("### 阶段 2：端点半径（非法输入不得产生任何删除）")
    fp_before = file_path_map()
    for q, why in (
        ("?ids=", "空集合 = 没选任何东西，不能当成全清"),
        ("?ids=abc", "非法 id 不得静默跳过"),
        ("?ids=0", "0 不是合法条目 id"),
        ("?ids=-1", "负数不是合法条目 id"),
        ("?scope=everything", "未知档不得回落到全清"),
        ("?olderThanDays=0", "0 天会清掉刚下的东西"),
    ):
        s, b = clear(q)
        check(f"2a `{q}` → 422（{why}）", s == 422, f"status={s} body={b}")
    s, b = clear("?ids=999999999")
    check(
        "2b 越界 id → 200 但 removed=0（不误伤）",
        s == 200 and b.get("removed") == 0 and b.get("hit") == 0,
        f"status={s} body={b}",
    )
    s, b = clear("?scope=stale&olderThanDays=365")
    check("2c 阈值大到无命中 → removed=0", s == 200 and b.get("removed") == 0, f"body={b}")
    check("2d 半径测试全程未清掉任何字节", file_path_map() == fp_before,
          f"changed={[k for k in fp_before if fp_before.get(k) != file_path_map().get(k)]}")

    # ---------- 3. 孤儿档 ----------
    print("### 阶段 3：孤儿档（磁盘有、库里无）")
    orphan1 = os.path.join(DL, "orphan-a.mp4")
    sub = os.path.join(DL, "sub")
    os.makedirs(sub, exist_ok=True)
    orphan2 = os.path.join(sub, "orphan-b.mp4")
    part = os.path.join(DL, "inflight.mp4.part")
    for p, size in ((orphan1, 2048), (orphan2, 4096), (part, 999)):
        with open(p, "wb") as f:
            f.write(b"x" * size)

    pv = preview()
    check("3a 孤儿计数=2（.part 不算孤儿）", pv["orphan"]["count"] == 2,
          f"orphan={pv['orphan']}")
    s, b = clear("?scope=orphan")
    check("3b 孤儿档 removed=2 且 bytesFreed=6144",
          s == 200 and b.get("removed") == 2 and b.get("bytesFreed") == 2048 + 4096, f"body={b}")
    check("3c 孤儿文件已不在磁盘", not os.path.exists(orphan1) and not os.path.exists(orphan2))
    check("3d 下载中的 .part 必须留下（删它等于打断下载）", os.path.exists(part))
    check("3e 孤儿档不动条目（缓存条目的 filePath 未变）", file_path_map() == fp_before,
          f"changed={[k for k in fp_before if fp_before.get(k) != file_path_map().get(k)]}")
    check("3f 复扫孤儿=0（幂等）", preview()["orphan"]["count"] == 0)
    os.remove(part)

    # ---------- 4. 外部文件永不删 ----------
    print("### 阶段 4：外部文件永不删")
    outside_dir = os.path.join(os.path.dirname(os.path.abspath(DL)), "outside")
    os.makedirs(outside_dir, exist_ok=True)
    outside = os.path.join(outside_dir, "outside.mp4")
    with open(outside, "wb") as f:
        f.write(b"y" * 1234)
    s, b = req("POST", "/api/media/items",
               {"items": [{"path": outside, "title": "外部文件", "kind": "video"}]})
    assert s == 200, f"import failed: {s} {b}"
    pv = preview()
    check("4a 外部文件被识别（不参与清理）", pv["external"]["count"] >= 1, f"external={pv['external']}")

    # 4a-2 备料孤儿，验证「全部」档**不含孤儿**。
    # 这一对断言自带牙：文件是本测试**刚建出来**的（4a-2 复验其存在，排除空跑），
    # 经 `scope=all` 后必须仍在（4b-2），最后只能被**孤儿档**清掉（4e）——
    # 若「全部」档悄悄开始扫孤儿，4b-2 必败；若孤儿档失效，4e 必败。
    keep_a = os.path.join(DL, "orphan-keep-a.mp4")
    keep_b = os.path.join(DL, "orphan-keep-b.mp4")
    for p, size in ((keep_a, 512), (keep_b, 768)):
        with open(p, "wb") as f:
            f.write(b"z" * size)
    check("4a-2 备料：2 个孤儿已在磁盘（下面两条断言因此不可能空跑）",
          os.path.exists(keep_a) and os.path.exists(keep_b) and preview()["orphan"]["count"] == 2,
          f"orphan={preview()['orphan']}")

    s, b = clear("?scope=all")
    check("4b 全清后外部文件仍在磁盘", os.path.exists(outside), f"exists={os.path.exists(outside)}")
    check("4b-2 全清后**孤儿仍在磁盘**（「全部」= 全部缓存条目，孤儿只认独立档）",
          os.path.exists(keep_a) and os.path.exists(keep_b),
          f"a={os.path.exists(keep_a)} b={os.path.exists(keep_b)}")
    check("4c 全清时外部文件计入 skipped", s == 200 and b.get("skipped", 0) >= 1, f"body={b}")
    check("4d 全清后缓存条目字节已释放", stats()["files"] == 0, f"stats={stats()}")
    s, b = clear("?scope=orphan")
    check("4e 孤儿档补清 removed=2（被留下的孤儿确实由独立档收拾）",
          s == 200 and b.get("removed") == 2 and not os.path.exists(keep_a),
          f"body={b} a_exists={os.path.exists(keep_a)} b_exists={os.path.exists(keep_b)}")

    # ---------- 5/6. 集合档 + 陈旧档（重新备料） ----------
    print("### 阶段 5：集合档（只清所选）")
    t2 = enqueue([201, 202, 203], group_id=778)
    wait_status(t2["id"], "done")
    snap2 = {k: v for k, v in file_path_map().items()
             if v and os.path.abspath(v).startswith(os.path.abspath(DL))}
    ids = sorted(snap2.keys())
    check("5a 备料：≥3 条缓存条目", len(ids) >= 3, f"ids={ids}")
    pick = ids[:2]
    keep = ids[2:]
    s, b = clear(f"?ids={','.join(str(i) for i in pick)}")
    check("5b 集合档 removed=2", s == 200 and b.get("removed") == 2, f"body={b}")
    fp_after = file_path_map()
    check("5c 所选条目 filePath 已置空",
          all(fp_after.get(i) is None for i in pick), f"picked={[(i, fp_after.get(i)) for i in pick]}")
    check("5d 其它条目 filePath **逐字未变**（集合差集）",
          all(fp_after.get(i) == snap2[i] for i in keep),
          f"others={[(i, fp_after.get(i)) for i in keep]}")
    check("5e 所选条目的文件已从磁盘消失",
          all(not os.path.exists(snap2[i]) for i in pick))

    print("### 阶段 6：陈旧档（阈值必须精确生效）")
    fresh_id = keep[0]
    stale_id = keep[-1] if len(keep) > 1 else keep[0]
    touch_old(snap2[stale_id], 40)
    pv = preview(30)
    check("6a 预览：早于 30 天的只有 1 条", pv["stale"]["count"] == 1, f"stale={pv['stale']}")
    s, b = clear("?scope=stale&olderThanDays=30")
    check("6b 陈旧档 removed=1（未到期的一条不删）",
          s == 200 and b.get("removed") == 1, f"body={b}")
    check("6c 陈旧文件已删 / 新文件仍在",
          not os.path.exists(snap2[stale_id])
          and (fresh_id == stale_id or os.path.exists(snap2[fresh_id])),
          f"stale_exists={os.path.exists(snap2[stale_id])}")

    # ---------- 7. bytesFreed 与磁盘释放量一致 ----------
    print("### 阶段 7：bytesFreed 与磁盘释放量一致")
    # **必须重新备料**：前面几档已把字节清空，若不备料这里就是「0 == 0」的空断言
    # （空断言会给出假绿 —— 与「不等于旧值」同一类缺陷）。
    t3 = enqueue([301, 302], group_id=779)
    wait_status(t3["id"], "done")
    _f, before_bytes = disk_usage(DL)
    pv = preview()
    check(
        "7z 备料非空（bytesFreed 断言必须有可比对的非零值）",
        pv["total"]["count"] >= 2 and before_bytes > 0,
        f"count={pv['total']['count']} dirBytes={before_bytes}",
    )
    s, b = clear("?scope=all")
    _f2, after_bytes = disk_usage(DL)
    freed = before_bytes - after_bytes
    check(
        "7a 全清 removed = 预览 total.count",
        b.get("removed") == pv["total"]["count"],
        f"removed={b.get('removed')} preview={pv['total']}",
    )
    check(
        "7b bytesFreed = 磁盘实际释放量**逐字相等**（且非零）",
        b.get("bytesFreed") == freed and freed > 0,
        f"reported={b.get('bytesFreed')} measured={freed}",
    )
    check("7c 全清后预览归零（条目仍在库、只是没有字节）",
          preview()["total"]["count"] == 0 and preview()["orphan"]["count"] == 0)

    print(f"\n### 汇总：PASS={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        for f in FAIL:
            print(f"  FAIL: {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
