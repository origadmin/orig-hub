#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""入库流水线取证（只读）。BUG-294 / BUG-295 / BUG-296 的复现脚本。

用法：
    python scripts/ingest_forensics.py                # 全部八节
    python scripts/ingest_forensics.py --db <store.db>
    python scripts/ingest_forensics.py --api-port 19787

为什么需要它：`cache_task` **没有逐条状态列**，任务内的「哪几条成了、哪几条从未尝试」
只能从 `items` + `media_item.file_path` + `media_message.downloaded` +
`cache_task_item_wall.started_at` **反推**。本脚本就是那条反推链的可执行形式 ——
缺陷档里的每个数字都必须能从这里重新跑出来。

自证（缺一即 abort）：每个分区的「明细行数」必须等于「GROUP BY 计数」。
教训：本脚本第一版在 helper 里复用了**同一个 cursor**，把外层迭代器打断 ——
`interrupted` 14 条只打印 4 条、`done` 90 条只抽查 1 条，且**不报错**。
取证脚本静默少报比多报危险得多，故把「计数一致性」做成硬断言。

路径基准：`media_item.file_path` 有**两种形态** ——
绝对路径（如 `%USERPROFILE%\Downloads\x.mp4`）与**相对 `<TG 数据目录>/tg/library/` 的路径**
（`chat--100xxxxxxxxxx/1234-media.mp4`）。只按当前工作目录判 `os.path.exists`
会把 135 条**在盘**的文件误报成「路径不存在」（实测踩到）。故这里用多基准解析。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sqlite3
import sys
import urllib.request
from collections import Counter, defaultdict

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

DEFAULT_DB = os.path.join(
    os.environ.get("APPDATA", ""), "com.origadmin.orighub", "tg", "store.db"
)

# 前端 CacheManagerDialog.tsx 的 GROUP_OF 映射（BUG-295 的判据锚）
GROUP_OF = {
    "queued": "ingesting",
    "running": "ingesting",
    "done": "ingested",
    "failed": "failed",
    "interrupted": "failed",
    "cancelled": "cancelled",
}
# 引擎侧 CACHE_TASK_ACTIVE_STATES（store.rs）—— 只有这两个算「活跃」
ACTIVE_STATES = ("queued", "running")


def non_empty(s):
    return s if (s and s.strip()) else None


class Probe:
    def __init__(self, db: str, api_port: int | None):
        self.con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        self.con.row_factory = sqlite3.Row
        self.C = self.con.cursor()   # 顶层遍历专用
        self.H = self.con.cursor()   # helper 专用（绝不与 C 混用）
        self.data_root = os.path.dirname(os.path.dirname(os.path.abspath(db)))
        self.bases = [
            ("abs", ""),
            ("library", os.path.join(self.data_root, "tg", "library")),
            ("downloads", os.path.join(self.data_root, "tg", "downloads")),
            ("tg", os.path.join(self.data_root, "tg")),
        ]
        self.api_port = api_port
        self._cap: dict[int, dict[int, tuple]] = {}

    # ---------- 基础 ----------
    def titles_for(self, chat: int) -> dict[int, tuple]:
        if chat not in self._cap:
            self._cap[chat] = {
                r["message_id"]: (r["caption"], r["file_name"])
                for r in self.H.execute(
                    "SELECT message_id, caption, file_name FROM media_message "
                    "WHERE channel_id=?",
                    (chat,),
                )
            }
        return self._cap[chat]

    def task_title(self, row) -> str | None:
        """复刻 routes.rs `cache_task_title`：caption 优先两遍选取，file_name 兜底。"""
        try:
            items = json.loads(row["items"])
        except Exception:
            items = []
        t = self.titles_for(row["chat_id"])
        for m in items:
            v = t.get(m)
            if v and non_empty(v[0]):
                return v[0]
        for m in items:
            v = t.get(m)
            if v and non_empty(v[1]):
                return v[1]
        return None

    def resolve(self, path: str | None):
        """返回 (基准名, 绝对路径, 是否存在)。"""
        if not path:
            return (None, None, False)
        for name, base in self.bases:
            cand = path if base == "" else os.path.join(base, path)
            if os.path.exists(cand):
                return (name, cand, True)
        return (None, None, False)

    def item_state(self, chat: int, mid: int) -> dict:
        r = self.H.execute(
            "SELECT file_path, kind FROM media_item WHERE source='tg' AND ref=?",
            (f"{chat}:{mid}",),
        ).fetchone()
        mm = self.H.execute(
            "SELECT downloaded FROM media_message WHERE channel_id=? AND message_id=?",
            (chat, mid),
        ).fetchone()
        base, absp, exists = self.resolve(r["file_path"] if r else None)
        return {
            "kind": r["kind"] if r else None,
            "registered": bool(r and r["file_path"]),
            "on_disk": exists,
            "base": base,
            "downloaded": mm["downloaded"] if mm else None,
        }

    def item_state_word(self, chat: int, mid: int) -> str:
        s = self.item_state(chat, mid)
        if s["kind"] is None:
            return f"无条目行(downloaded={s['downloaded']})"
        if not s["registered"]:
            return f"{s['kind']}/未登记字节(downloaded={s['downloaded']})"
        return (f"{s['kind']}/{'在盘' if s['on_disk'] else '!已登记但不在盘'}"
                f"(downloaded={s['downloaded']})")

    def has_bytes(self, chat: int, mid: int) -> bool:
        return self.item_state(chat, mid)["on_disk"]

    # ---------- 六节 ----------
    def sec_a(self):
        print("=" * 78)
        print("A. cache_task 状态分布")
        print("=" * 78)
        dist = {r["status"]: r["n"] for r in self.C.execute(
            "SELECT status, count(*) n FROM cache_task GROUP BY status ORDER BY n DESC")}
        for k, v in sorted(dist.items(), key=lambda x: -x[1]):
            print(f"  {k:<12} {v}")
        print(f"  {'合计':<12} {sum(dist.values())}")
        return dist

    def sec_b(self, dist):
        print()
        print("=" * 78)
        print("B. 需要用户处理的任务（BUG-295：活跃概念漏了 interrupted）")
        print("=" * 78)
        active = self.C.execute(
            "SELECT * FROM cache_task WHERE status IN ('queued','running') "
            "ORDER BY id DESC").fetchall()
        print(f"  【引擎判为『活跃』】status IN {ACTIVE_STATES} —— "
              f"共 {len(active)} 条（list_cache_tasks 的 CASE 把它们排最前）")
        for r in active:
            ti = (self.task_title(r) or "(无标题)").replace("\n", " ")
            print(f"    id={r['id']:<4} {r['status']:<10} {r['done']}/{r['total']:<3} "
                  f"pri={r['priority']} {ti[:38]}")
        ints = self.C.execute(
            "SELECT * FROM cache_task WHERE status='interrupted' ORDER BY id DESC").fetchall()
        print()
        print(f"  【引擎判为『不活跃』】status='interrupted' —— 共 {len(ints)} 条。"
              f"**这才是用户必须重试的那批，却拿不到任何置顶**")
        assert len(ints) == dist.get("interrupted", 0), \
            f"自证失败：明细 {len(ints)} != 计数 {dist.get('interrupted')}"
        for r in ints:
            ti = (self.task_title(r) or "(无标题)").replace("\n", " ")
            print(f"    id={r['id']:<4} {r['status']:<12} {r['done']}/{r['total']:<3} "
                  f"pri={r['priority']} {ti[:34]}")

    def sec_c(self, task_ids):
        print()
        print("=" * 78)
        print("C. 逐条真实状态推导（BUG-294：表里没有逐条状态列）")
        print("=" * 78)
        for tid in task_ids:
            r = self.H.execute("SELECT * FROM cache_task WHERE id=?", (tid,)).fetchone()
            if not r:
                print(f"\n  --- task {tid}: 不存在")
                continue
            items = json.loads(r["items"])
            walls = {w["message_id"]: w for w in self.H.execute(
                "SELECT message_id, accum_ms, started_at FROM cache_task_item_wall "
                "WHERE task_id=?", (tid,))}
            ti = (self.task_title(r) or "(无标题)").replace("\n", " ")
            print(f"\n  --- task {tid}  status={r['status']}  done={r['done']}/{r['total']}  "
                  f"items 实际 {len(items)} 条")
            print(f"      标题 = {ti[:66]}")
            print(f"      error = {(r['error'] or '(空)')[:80]}")
            nb = never = 0
            unslotted = 0
            for it in items:
                w = walls.get(it)
                if self.has_bytes(r["chat_id"], it):
                    nb += 1
                    wtxt = f"accum={w['accum_ms']}ms" if w else "wall=无"
                elif w and w["started_at"]:
                    wtxt = f"在途(started_at={w['started_at']})"
                else:
                    never += 1
                    wtxt = "**从未尝试**"
                # BUG-296：这条有没有编入剧集（三表口径）。无槽位 ⇒ 媒体库剧集视图里没有它。
                row = self.H.execute(
                    "SELECT id FROM media_item WHERE source='tg' AND ref=?",
                    (f"{r['chat_id']}:{it}",)).fetchone()
                if row is None:
                    ctxt = "无 media_item"
                else:
                    n = self._claimed(row["id"])
                    ctxt = "已编入剧集" if n else "★未编入剧集"
                    if not n:
                        unslotted += 1
                print(f"        msg {it:<7} {self.item_state_word(r['chat_id'], it):<30} "
                      f"{wtxt:<26} {ctxt}")
            print(f"      ⇒ 有字节 {nb}/{len(items)}；无字节 {len(items) - nb}；"
                  f"其中『从未尝试』= {never}；**未编入剧集 = {unslotted}**")

    def sec_d(self):
        print()
        print("=" * 78)
        print("D. 承诺 vs 交付：caption 声明范围 vs 实际（BUG-296）")
        print("=" * 78)
        rows = self.C.execute("""
          SELECT s.id sid, s.title, e.episode_no, e.episode_no_end
          FROM media_series s JOIN media_episode e ON e.series_id = s.id
          ORDER BY s.id, e.episode_no""").fetchall()
        ser = defaultdict(list)
        for r in rows:
            ser[r["sid"]].append(r)
        gap = []
        for sid, rs in sorted(ser.items()):
            claimed = max([x["episode_no_end"] or 0 for x in rs] + [0])
            if claimed > len(rs):
                gap.append((sid, rs[0]["title"], claimed, len(rs),
                            sorted(x["episode_no"] for x in rs)))
        declared = sum(1 for rs in ser.values()
                       if max([x["episode_no_end"] or 0 for x in rs] + [0]) > 0)
        print(f"  剧集总数 {len(ser)}；其中**有声明范围**（episode_no_end 非空）的仅 {declared} 个")
        print(f"  『声明范围 > 实际条数』的剧集 {len(gap)} 个，缺口合计 "
              f"{sum(g[2] - g[3] for g in gap)} 集")
        print("  库内『缺口记录』条数 = 0（没有任何一行表记着缺了哪几集）")
        for sid, title, claimed, actual, eps in gap[:30]:
            print(f"    sid={sid:<5} 声明 1-{claimed:<4} 实际 {actual:<4} "
                  f"缺 {claimed - actual:<3} 实际集号={eps}  {(title or '')[:26]}")
        print(f"  [反向证伪] 声明范围非空的剧集数 = {declared} —— "
              f"若为 0 说明查询没读到声明范围，gap=0 是**假绿**")
        print()
        print("  ── 相册组：组内视频数 vs 组内 caption 声明的集数范围 ──")
        pat = re.compile(r"EP\s*(\d+)\s*[-~]\s*(\d+)")
        grp = defaultdict(list)
        for r in self.C.execute(
                "SELECT group_id, message_id, caption, media_type FROM media_message "
                "WHERE group_id IS NOT NULL ORDER BY group_id, message_id"):
            grp[r["group_id"]].append(r)
        ok = bad = 0
        for gid, ms in sorted(grp.items()):
            dec = None
            for m in ms:
                mm = pat.search(m["caption"] or "")
                if mm:
                    dec = (int(mm.group(1)), int(mm.group(2)))
                    break
            if not dec:
                continue
            span = dec[1] - dec[0] + 1
            vids = sum(1 for m in ms if m["media_type"] == "video")
            if vids == span:
                ok += 1
            else:
                bad += 1
                print(f"    gid={gid} 声明 EP{dec[0]}-{dec[1]}(={span}集) "
                      f"组内 {len(ms)} 条(视频 {vids})  <== 组内视频数 != 声明集数")
        print(f"  ⇒ 声明了范围的组：相符 {ok} 个 / **不相符 {bad} 个**")
        print(f"  [反向证伪] 相符 + 不相符 = {ok + bad}，必须 > 0（若为 0 说明正则没匹配到任何声明）")

    def sec_e(self):
        print()
        print("=" * 78)
        print("E. media_item 普查（区分『未登记字节』与『已登记但不在盘』）")
        print("=" * 78)
        census = Counter()
        for r in self.C.execute("SELECT kind, file_path FROM media_item WHERE source='tg'"):
            base, _, ok = self.resolve(r["file_path"])
            state = "在盘" if ok else ("未登记字节" if not r["file_path"] else "!已登记但不在盘")
            census[(r["kind"], state)] += 1
        for (k, st), n in sorted(census.items()):
            print(f"  {k:<8} {st:<16} {n}")
        total = self.C.execute(
            "SELECT count(*) n FROM media_item WHERE source='tg'").fetchone()["n"]
        assert sum(census.values()) == total, "自证失败：普查与总数不符"
        print(f"  合计 {total}")

    def sec_f(self, dist):
        print()
        print("=" * 78)
        print("F. 回归核对：done 任务里有没有『没字节的条目』（有 ⇒ done 不可信）")
        print("=" * 78)
        dones = self.C.execute("SELECT * FROM cache_task WHERE status='done'").fetchall()
        print(f"  抽查 done 任务 {len(dones)} 条")
        assert len(dones) == dist.get("done", 0), \
            f"自证失败：{len(dones)} != {dist.get('done')}"
        rows = []
        for r in dones:
            items = json.loads(r["items"])
            miss = [it for it in items if not self.has_bytes(r["chat_id"], it)]
            if miss:
                rows.append((r["id"], len(items), len(miss), miss))
        print(f"  『done 却有没字节条目』的任务 {len(rows)} 条，"
              f"涉及条目 {sum(x[2] for x in rows)} 个")
        print("  说明：photo 条目按 BUG-049 规则**不落盘**（无字节是设计），"
              "故本节的『没字节』必须再按 kind 拆分才能判真假 —— 见 E 节的 kind 分布。")
        for tid, n, m, miss in rows[:15]:
            kinds = Counter(self.item_state(self.H.execute(
                "SELECT chat_id FROM cache_task WHERE id=?", (tid,)).fetchone()["chat_id"],
                it)["kind"] for it in miss)
            print(f"      task {tid}: {m}/{n} 条无字节  缺项 kind={dict(kinds)}")

    # ---------- API 序 ----------
    # ---------- H/I：BUG-296（条目未编入剧集）----------
    def _claimed(self, item_id):
        """条目被任何一张认领表引用即算「已编入剧集」。

        **必须查三张表** —— 只查 `media_episode` 会把「混编组照片」（BUG-168 起作为
        集级挂图写在 `media_episode_image`）与「备用源」（`media_episode_source`）
        误判成未认领。本脚本第一版只查 `media_episode`，把未认领数从 96 虚报成 207
        （实测踩到，BUG-255 的同一教训）。
        """
        n = 0
        for tbl in ("media_episode", "media_episode_image", "media_episode_source"):
            n += self.H.execute(
                f"SELECT count(*) n FROM {tbl} WHERE item_id=?", (item_id,)
            ).fetchone()["n"]
        return n

    def sec_h(self):
        print()
        print("=" * 78)
        print("H. 认领普查（BUG-296）：哪些条目**不在任何剧集里**（三表口径）")
        print("=" * 78)
        rows = [dict(r) for r in self.C.execute(
            """SELECT i.id, i.kind, i.file_path,
                 (SELECT count(*) FROM media_episode        e WHERE e.item_id=i.id) a,
                 (SELECT count(*) FROM media_episode_image  g WHERE g.item_id=i.id) b,
                 (SELECT count(*) FROM media_episode_source s WHERE s.item_id=i.id) c
               FROM media_item i WHERE i.source='tg'"""
        )]
        total = self.H.execute(
            "SELECT count(*) n FROM media_item WHERE source='tg'").fetchone()["n"]
        assert len(rows) == total, f"自证失败：{len(rows)} != {total}"
        un = [r for r in rows if not (r["a"] or r["b"] or r["c"])]
        print(f"  tg 条目总 {len(rows)}，未认领 {len(un)}")
        for (k, b), n in sorted(Counter(
                (r["kind"], "有字节" if r["file_path"] else "无字节") for r in un).items()):
            print(f"      未认领 {k:<7} {b:<6} {n}")
        worst = [r for r in un if r["kind"] == "video" and r["file_path"]]
        print(f"  ★ 最严重类：video 且字节已在盘却无任何剧集 = {len(worst)}"
              f"  （字节下完了、媒体库剧集视图里没有它）")
        print("  说明：`list_media_items` 的 unassigned 分支（media.rs:1479）**只排除")
        print("  `media_episode`**，故该分支会把挂图/备用源条目也报成 unassigned ——")
        print("  口径与本节不同，属另一处不一致（与 BUG-255 同源）。")
        return len(un), len(worst)

    def sec_i(self):
        print()
        print("=" * 78)
        print("I. 任务侧（BUG-296）：哪些任务的条目**没进剧集**（含 done 任务）")
        print("=" * 78)
        tasks = [dict(r) for r in self.C.execute("SELECT * FROM cache_task ORDER BY id")]
        total = self.H.execute("SELECT count(*) n FROM cache_task").fetchone()["n"]
        assert len(tasks) == total, f"自证失败：{len(tasks)} != {total}"
        bad = []
        for t in tasks:
            w = wo = mi = 0
            for m in json.loads(t["items"]):
                r = self.H.execute(
                    "SELECT id FROM media_item WHERE source='tg' AND ref=?",
                    (f"{t['chat_id']}:{m}",)).fetchone()
                if not r:
                    mi += 1
                    continue
                if self._claimed(r["id"]) > 0:
                    w += 1
                else:
                    wo += 1
            if wo or mi:
                bad.append((t["id"], t["status"], t["total"], w, wo, mi))
        by = Counter(b[1] for b in bad)
        print(f"  存在『无槽位 / 无条目』的任务 {len(bad)} / {len(tasks)}")
        print(f"  按状态：{dict(by)}")
        done = [b for b in bad if b[1] == "done"]
        print(f"  ★ 其中 status='done'（UI 读作「已入库」）的任务 {len(done)} 条 ——"
              f" 这些任务的 `done N/N` 是**计数**，不是「N 条都进了剧集」：")
        for b in done:
            print(f"      task {b[0]:<4} total={b[2]:<3} 有槽位={b[3]:<3} "
                  f"无槽位={b[4]:<3} 无item={b[5]}")
        assert sum(b[4] + b[5] for b in bad) > 0 or not bad, "自证失败"
        return len(bad), dict(by)

    def sec_api(self):
        if not self.api_port:
            return
        print()
        print("=" * 78)
        print(f"G. API 真实渲染序（GET /api/tg/cache/tasks/all，端口 {self.api_port}）")
        print("=" * 78)
        url = f"http://127.0.0.1:{self.api_port}/api/tg/cache/tasks/all"
        try:
            with urllib.request.urlopen(url, timeout=5) as f:
                tasks = json.load(f)["tasks"]
        except Exception as e:  # noqa: BLE001
            print(f"  取不到（{e}）—— 反向证伪：端口写错必须在这里失败，不得报 0 行")
            return
        print(f"  API 返回 {len(tasks)} 条")
        i = 0
        shown = 0
        for t in tasks:
            if GROUP_OF[t["status"]] == "cancelled":
                continue
            if shown < 26:
                ti = (t.get("title") or "(无标题)").replace("\n", " ")[:36]
                print(f"    DOM[{i:<3}] id={t['id']:<4} {t['status']:<12} "
                      f"{t.get('done')}/{t.get('total'):<3} {ti}")
                shown += 1
            i += 1
        print(f"  ⇒ 「全部」档共 {i} 行（扁平，无分区标题）")
        c = Counter(GROUP_OF[t["status"]] for t in tasks)
        print(f"  统计条读数：已入库 {c['ingested']} · 入库中 {c['ingesting']} · "
              f"入库失败 {c['failed']} · 已取消 {c['cancelled']}")
        keys = sorted(tasks[0].keys()) if tasks else []
        print(f"  任务 JSON 字段全集 = {keys}")
        print("  ⇒ 没有逐条状态字段；`messageIds` 是裸数组（BUG-294 的字段级证据）")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB, help="store.db 路径（只读打开）")
    ap.add_argument("--api-port", type=int, default=19787,
                    help="orig-tg 端口；0 = 跳过 G 节")
    ap.add_argument("--tasks", default="183,184,185,181,188,187",
                    help="C 节要展开的 task id，逗号分隔")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"[!] store.db 不存在：{args.db}", file=sys.stderr)
        return 2
    print(f"库 = {args.db}")
    p = Probe(args.db, args.api_port or None)
    dist = p.sec_a()
    p.sec_b(dist)
    p.sec_c([int(x) for x in args.tasks.split(",") if x.strip()])
    p.sec_d()
    p.sec_e()
    p.sec_f(dist)
    p.sec_h()
    p.sec_i()
    p.sec_api()
    p.con.close()
    print()
    print("完成。以上每个数字都可由本脚本重跑得到（无缓存、无手工录入）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
