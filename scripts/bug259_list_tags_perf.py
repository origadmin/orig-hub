#!/usr/bin/env python3
"""BUG-259 判据 4 性能实测：list_tags 的 SQL 序列代价 —— 旧实现（1 + 2N 条
逐标签 COUNT）vs 新实现（单条 LEFT JOIN 聚合）。

照 BUG-259.md「复现」节的只读副本方法：把真库 copy 到临时文件，在**副本**上
灌合成标签到目标规模（64 / 5000），用 sqlite3 的 set_trace_callback 精确数
语句数，并测量耗时。原库只被 copyfile 读一次，绝无写入。

用法：python scripts/bug259_list_tags_perf.py
产物：stdout 表格（耗时 / 语句数），供 BUG-259.md「验收证据」登记。
"""
import json
import os
import shutil
import sqlite3
import tempfile
import time

NEW_QUERY = """
SELECT t.id, t.name, t.color,
       COALESCE(ic.cnt, 0), COALESCE(sc.cnt, 0)
  FROM media_tag AS t
  LEFT JOIN (SELECT tag_id, COUNT(*) AS cnt
               FROM media_item_tag GROUP BY tag_id) AS ic
    ON ic.tag_id = t.id
  LEFT JOIN (SELECT tag_id, COUNT(*) AS cnt
               FROM media_series_tag GROUP BY tag_id) AS sc
    ON sc.tag_id = t.id
 ORDER BY t.name COLLATE NOCASE
"""


def measure(cur, impl: str):
    """跑一遍 list_tags 的 SQL 序列，返回 (耗时 ms, 语句数, 载荷字节数)。"""
    counter = {"n": 0}
    cur.connection.set_trace_callback(lambda sql: counter.__setitem__("n", counter["n"] + 1))
    t0 = time.perf_counter()
    if impl == "old":
        rows = cur.execute(
            "SELECT id,name,color FROM media_tag ORDER BY name COLLATE NOCASE"
        ).fetchall()
        out = []
        for tid, name, color in rows:
            ic = cur.execute(
                "SELECT COUNT(*) FROM media_item_tag WHERE tag_id=?", (tid,)
            ).fetchone()[0]
            sc = cur.execute(
                "SELECT COUNT(*) FROM media_series_tag WHERE tag_id=?", (tid,)
            ).fetchone()[0]
            out.append((tid, name, color, ic, sc))
    else:
        out = cur.execute(NEW_QUERY).fetchall()
    ms = (time.perf_counter() - t0) * 1000
    cur.connection.set_trace_callback(None)
    payload = len(json.dumps(out, ensure_ascii=False, default=str).encode())
    return ms, counter["n"], payload


def main():
    src = os.path.join(os.environ["APPDATA"], "com.origadmin.orighub", "tg", "store.db")
    tmpdir = tempfile.mkdtemp(prefix="bug259_perf_")
    dst = os.path.join(tmpdir, "store.db")
    shutil.copyfile(src, dst)  # 只读副本：原库只读一次，永不写
    con = sqlite3.connect(dst)
    cur = con.cursor()
    print(f"copy: {dst}")
    try:
        for target in (64, 5000):
            have = cur.execute("SELECT COUNT(*) FROM media_tag").fetchone()[0]
            if have < target:
                cur.executemany(
                    "INSERT OR IGNORE INTO media_tag (name) VALUES (?)",
                    [("synthetic-%06d" % i,) for i in range(have, target)],
                )
                con.commit()
            n = cur.execute("SELECT COUNT(*) FROM media_tag").fetchone()[0]
            # 各跑三遍取最小值（降低首次页缓存噪声），语句数不受影响
            old = min(measure(cur, "old") for _ in range(3))
            new = min(measure(cur, "new") for _ in range(3))
            print(
                "N=%-6d old: %8.2f ms / %6d stmts | new: %8.2f ms / %d stmts | "
                "speedup=%6.1fx | payload old=%d B new=%d B"
                % (n, old[0], old[1], new[0], new[1], old[0] / new[0], old[2], new[2])
            )
    finally:
        con.close()
        shutil.rmtree(tmpdir, ignore_errors=True)
        print("copy deleted (只读副本，用完即焚)")


if __name__ == "__main__":
    main()
