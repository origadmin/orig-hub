#!/usr/bin/env python3
"""BUG-352 验收：真栈上「图片走缓存/入库链路必须落盘」。

判据（对新实现必真、对旧实现必假）：
  A1 入队一张**未下载**的 TG 图片后，任务能进入终态（done）；
  A2 `media_message.downloaded` 由 0 变 1；
  A3 `media_message.file_path` 非空 **且文件在磁盘上真实存在**（字节证据）；
  A4 该条目的 `media_item` 拿到字节（`file_path` 非空）。
  （日志指纹判据已删除：`push_log` 不落 `orig-tg.log`，旧实现上该判据恒真 = 恒绿。）

用法：
  python verify/_probe_bug352_photo_bytes.py            # 正常判据
  python verify/_probe_bug352_photo_bytes.py --legacy   # 反置（装回旧实现时应 FAIL）
"""
import json
import os
import sqlite3
import sys
import time
import urllib.request

TG = "http://127.0.0.1:19787"
DB = os.path.expandvars(r"%APPDATA%/com.origadmin.orighub/tg/store.db")
LEGACY = "--legacy" in sys.argv

fails = []


def check(name, ok, detail=""):
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name} — {detail}")
    if not ok:
        fails.append(name)


def http(method, path, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        TG + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def db():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def pick_photo():
    """挑一张当前**无字节**的 TG 图片（监控频道内，DB 已知 media_type=photo）。"""
    c = db()
    row = c.execute(
        "SELECT m.channel_id, m.message_id FROM media_message m "
        "JOIN monitored_channel ch ON ch.channel_id = m.channel_id "
        "WHERE m.media_type='photo' AND COALESCE(m.downloaded,0)=0 "
        "ORDER BY m.message_id DESC LIMIT 1"
    ).fetchone()
    c.close()
    return row


def main():
    pick = pick_photo()
    if not pick:
        print("no undownloaded photo in monitored channels; SKIP")
        return 2
    chat, msg = pick
    print(f"target: chat={chat} msg={msg}")

    c = db()
    before = c.execute(
        "SELECT COALESCE(downloaded,0), file_path FROM media_message "
        "WHERE channel_id=?1 AND message_id=?2", (chat, msg)).fetchone()
    c.close()
    print("before:", before)
    if before[0]:
        print("already downloaded; SKIP")
        return 2

    task = http("POST", "/api/tg/cache/tasks",
                {"chatId": chat, "messageIds": [msg]}, timeout=30)
    task_id = task.get("id")
    print("enqueued task:", task_id)

    # 轮询终态（队列可能排在其它任务之后）
    deadline = time.time() + 180
    status = task.get("status")
    while time.time() < deadline:
        time.sleep(3)
        tasks = http("GET", "/api/tg/cache/tasks/all").get("tasks", [])
        cur = next((t for t in tasks if t.get("id") == task_id), None)
        if cur:
            status = cur.get("status")
            if status in ("done", "failed", "cancelled", "interrupted"):
                break
        else:
            # 任务行可能已被清理：直接看 DB 事实
            c = db()
            row = c.execute(
                "SELECT COALESCE(downloaded,0), file_path FROM media_message "
                "WHERE channel_id=?1 AND message_id=?2", (chat, msg)).fetchone()
            c.close()
            if row and row[0]:
                status = "done"
                break
    print("final status:", status)

    c = db()
    after = c.execute(
        "SELECT COALESCE(downloaded,0), file_path FROM media_message "
        "WHERE channel_id=?1 AND message_id=?2", (chat, msg)).fetchone()
    item = c.execute(
        "SELECT i.id, i.kind, i.file_path FROM media_item i "
        "WHERE i.source='tg' AND i.ref=?1", (f"{chat}:{msg}",)).fetchone()
    c.close()
    print("after:", after)
    print("item:", item)

    a1 = status == "done"
    a2 = bool(after and after[0] == 1)
    path = after[1] if after else None
    exists = bool(path) and os.path.exists(path)
    a3 = exists and os.path.getsize(path) > 0 if exists else False
    a4 = bool(item and item[2])
    names = ["A1 任务终态=done", "A2 downloaded=1", "A3 落盘文件真实存在",
             "A4 条目拿到字节"]
    vals = [a1, a2, a3, a4]
    for n, v in zip(names, vals):
        check(n, v if not LEGACY else (not v),
              f"status={status} downloaded={after and after[0]} "
              f"path={'exists' if exists else (path or 'None')} "
              f"item={item and item[2]}")

    print("\nRESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
