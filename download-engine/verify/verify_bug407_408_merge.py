#!/usr/bin/env python3
"""BUG-407 / BUG-408 验收：合并剧集的「同集归并」必须按 hash 自动判定。

用户在 2026-10-23 定的规则（两档同源）：

- **BUG-407**：A 含 1,2,3、B 含 2,3,4 合并后必须是 **1,2,2,3,3,4**
  （同集多源归并、不同集各自保留），**不是**把 B 整体续编成 4,5,6。
- **BUG-408**：处置全自动、没有手动「保留 / 删除」——
  视频比 `content_hash`：相同 ⇒ 同一集记两个源；不同 ⇒ 两个不同类别各自成集；
  标题 / 总介绍 / 封面 / 年份取「有值侧」，空值不覆盖已有值。

## 为什么自带一个引擎实例

合并是**破坏性**操作（源剧集会被删掉）。本脚本绝不碰生产库：
它用 `ORIG_TG_DB` + `ORIG_TG_PORT` 起一个**隔离实例**（临时库 + 独立端口），
在里面造数据、跑合并、断言，然后连库带进程一起清掉。

## 用法

    python download-engine/verify/verify_bug407_408_merge.py
    python download-engine/verify/verify_bug407_408_merge.py --keep   # 留着临时库排查

退出码：0 = 全部 PASS；1 = 有 FAIL（或前置不成立）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
EXE = REPO / "download-engine" / "target" / "release" / "orig-tg.exe"
PORT = 19799
BASE = f"http://127.0.0.1:{PORT}"

PASS: list[str] = []
FAIL: list[str] = []


def check(ok: bool, name: str, detail: str) -> bool:
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    return ok


# 环回必须绕过本机 http_proxy（否则 127.0.0.1 会被代理接管 → 假 000）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(method: str, path: str, body: dict | None = None, timeout: float = 20.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return e.code, raw


def port_free(port: int) -> bool:
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def spawn(db: Path) -> subprocess.Popen:
    env = dict(os.environ)
    env["ORIG_TG_DB"] = str(db).replace("\\", "/")
    env["ORIG_TG_PORT"] = str(PORT)
    # 隔离实例不接真 TG：无 session 时引擎只提供本地媒体库能力，本用例也不需要 TG。
    env.pop("ORIG_TG_SESSION", None)
    env["RUST_LOG"] = "warn"
    # CREATE_NO_WINDOW：别在用户屏幕上闪控制台窗口
    creationflags = 0x08000000 if os.name == "nt" else 0
    return subprocess.Popen(
        [str(EXE)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def wait_health(proc: subprocess.Popen, secs: float = 40.0) -> bool:
    t0 = time.time()
    while time.time() - t0 < secs:
        if proc.poll() is not None:
            print(f"!! 引擎进程提前退出，exit={proc.returncode}")
            return False
        try:
            status, _ = http("GET", "/health", timeout=1.5)
            if status == 200:
                print(f"   引擎就绪，用时 {time.time() - t0:.1f}s")
                return True
        except Exception:
            pass
        time.sleep(0.3)
    print(f"!! 引擎 {secs}s 内未就绪")
    return False


def stop(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)


# ─────────────────────────── 造数据 ───────────────────────────


class Seed:
    """往**隔离**库里直写最小事实集（引擎已建好 schema 之后才能用）。"""

    def __init__(self, db: Path) -> None:
        self.c = sqlite3.connect(db)
        self.t = int(time.time())
        self._n = 0

    def series(self, title: str, description: str | None = None, year: int | None = None) -> int:
        cur = self.c.execute(
            "INSERT INTO media_series (title, description, kind, poster, year, source_key,"
            " created_at, updated_at) VALUES (?,?,'series',NULL,?,NULL,?,?)",
            (title, description, year, self.t, self.t),
        )
        return int(cur.lastrowid)

    def item(self, title: str, content_hash: str | None = None) -> int:
        self._n += 1
        cur = self.c.execute(
            "INSERT INTO media_item (source, ref, title, kind, file_path, poster, size,"
            " duration, added_at, description, source_title, content_hash)"
            " VALUES ('local',?,?,'video',NULL,NULL,NULL,NULL,?,NULL,?,?)",
            (f"seed:{self._n}", title, self.t, title, content_hash),
        )
        return int(cur.lastrowid)

    def episode(self, series_id: int, item_id: int, no: int, season: int = 1) -> int:
        cur = self.c.execute(
            "INSERT INTO media_episode (series_id, item_id, season, episode_no,"
            " episode_no_end, origin_series_title, origin_episode_no)"
            " VALUES (?,?,?,?,NULL,NULL,NULL)",
            (series_id, item_id, season, no),
        )
        return int(cur.lastrowid)

    def alt_source(self, episode_id: int, item_id: int) -> None:
        self.c.execute(
            "INSERT INTO media_episode_source (episode_id, item_id, created_at) VALUES (?,?,?)",
            (episode_id, item_id, self.t),
        )

    def commit(self) -> None:
        self.c.commit()
        self.c.close()


def shape(detail: dict) -> list[tuple[int, int, list[int]]]:
    """把剧集详情拍成可比较的 `(集号, 主条目, [备用源...])`（按集号排序）。"""
    rows = []
    for ep in detail.get("episodes", []):
        rows.append(
            (
                ep["episodeNo"],
                ep["itemId"],
                sorted(s["itemId"] for s in ep.get("sources", [])),
            )
        )
    rows.sort()
    return rows


# ─────────────────────────── 主流程 ───────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留临时库与引擎日志（排查用）")
    args = ap.parse_args()

    if not EXE.exists():
        print(f"!! 找不到 {EXE}\n   先跑：python scripts/dev/dev_stack.py build-tg")
        return 1
    if not port_free(PORT):
        print(f"!! 端口 {PORT} 已被占用（隔离实例需要独立端口）")
        return 1

    tmp = Path(tempfile.mkdtemp(prefix="orighub-bug407-"))
    db = tmp / "store.db"
    print(f"隔离实例：db={db} port={PORT}")

    proc = None
    try:
        # ── 第 1 段：让引擎建 schema ──
        proc = spawn(db)
        if not wait_health(proc):
            return 1
        stop(proc)
        proc = None

        # ── 第 2 段：直写事实集 ──
        s = Seed(db)

        # 场景 1（BUG-407 用户原例）：A=1,2,3 / B=2,3,4。
        # B 的第 2、3 集与 A 的第 2、3 集是**同一份文件**（hash 相同），第 4 集是新文件。
        a_series = s.series("场景1-目标A")
        b_series = s.series("场景1-源B")
        a_items = [s.item(f"A 第{n}集", f"hash-a{n}") for n in (1, 2, 3)]
        b_items = [
            s.item("B 第2集", "hash-a2"),   # 与 A 第 2 集同一文件
            s.item("B 第3集", "hash-a3"),   # 与 A 第 3 集同一文件
            s.item("B 第4集", "hash-b4"),   # 新文件
        ]
        for n, it in zip((1, 2, 3), a_items):
            s.episode(a_series, it, n)
        for n, it in zip((2, 3, 4), b_items):
            s.episode(b_series, it, n)

        # 场景 1b（用户 2026-10-23 追加裁定）：**两边都没有文件**（无 hash）⇒ 不合并。
        # 「没有 hash 说明没有文件，两边都是空，不存在合并。」
        n_series = s.series("场景1b-目标N")
        o_series = s.series("场景1b-源O")
        n_item = s.item("N 第1集")          # 无 hash
        o_item = s.item("O 第1集")          # 无 hash
        s.episode(n_series, n_item, 1)
        s.episode(o_series, o_item, 1)

        # 场景 2（BUG-408）：同槽但 hash 不同 ⇒ 差异视频 ⇒ 各自成集。
        c_series = s.series("场景2-目标C")
        d_series = s.series("场景2-源D")
        c_item = s.item("C 第1集", "hash-conflict-aaa")
        d_item = s.item("D 第1集", "hash-conflict-bbb")
        s.episode(c_series, c_item, 1)
        s.episode(d_series, d_item, 1)

        # 场景 3（BUG-408）：hash 相同、集号不同 ⇒ 同一视频 ⇒ 同一集。
        e_series = s.series("场景3-目标E")
        f_series = s.series("场景3-源F")
        e_item = s.item("E 第1集", "hash-same-zzz")
        f_item = s.item("F 第3集", "hash-same-zzz")
        s.episode(e_series, e_item, 1)
        s.episode(f_series, f_item, 3)

        # 场景 4（BUG-408）：元数据取有值侧。目标介绍是**空串**（不是 NULL）。
        g_series = s.series("场景4-目标G", "", None)
        h_series = s.series("场景4-源H", "源侧介绍", 2020)
        s.c.execute(
            "UPDATE media_series SET poster = '/covers/src.jpg' WHERE id = ?", (h_series,)
        )

        # 场景 5（BUG-103 正修）：源分集挂的备用源必须跟着搬进目标。
        i_series = s.series("场景5-目标I")
        j_series = s.series("场景5-源J")
        # I/J 的第 1 集是**同一个文件**（hash 相同）⇒ 归并为同一集，备用源随之搬运。
        i_item = s.item("I 第1集", "hash-i1")
        j_item = s.item("J 第1集", "hash-i1")
        j_alt = s.item("J 第1集-备用源")
        s.episode(i_series, i_item, 1)
        j_ep = s.episode(j_series, j_item, 1)
        s.alt_source(j_ep, j_alt)

        s.commit()

        # ── 第 3 段：起来跑合并 ──
        proc = spawn(db)
        if not wait_health(proc):
            return 1

        # ===== 场景 1：BUG-407 核心 =====
        st, rep = http("POST", f"/api/media/series/{a_series}/merge", {"sourceId": b_series})
        print(f"\n[场景1] merge -> {st} {rep}")
        if not check(st == 200, "场景1 合并成功", f"status={st}"):
            return 1
        want = [
            (1, a_items[0], []),
            (2, a_items[1], [b_items[0]]),
            (3, a_items[2], [b_items[1]]),
            (4, b_items[2], []),
        ]
        st, det = http("GET", f"/api/media/series/{a_series}")
        got = shape(det)
        print(f"[场景1] 合并后 (集号,主条目,[备用源]) = {got}")
        check(got == want, "场景1 1,2,2,3,3,4 同集多源", f"got={got} want={want}")
        check(
            rep.get("added") == 1,
            "场景1 只有第 4 集占新集号",
            f"added={rep.get('added')}",
        )
        check(
            rep.get("mergedSameEpisode") == 2,
            "场景1 两条同集归并",
            f"mergedSameEpisode={rep.get('mergedSameEpisode')}",
        )
        check(
            rep.get("sourcesAttached") == 2,
            "场景1 两条备用源真的落库",
            f"sourcesAttached={rep.get('sourcesAttached')}",
        )
        check(
            len(det.get("episodes", [])) == 4,
            "场景1 集数 4（不是 6）",
            f"episodes={len(det.get('episodes', []))}",
        )

        # ===== 场景 1b：无 hash ⇒ 绝不合并 =====
        st, rep = http("POST", f"/api/media/series/{n_series}/merge", {"sourceId": o_series})
        print(f"\n[场景1b] merge -> {st} {rep}")
        st, det = http("GET", f"/api/media/series/{n_series}")
        got = shape(det)
        print(f"[场景1b] 合并后 = {got}")
        check(
            got == [(1, n_item, []), (2, o_item, [])],
            "场景1b 两边都没文件 ⇒ 各自成集（不按集号瞎并）",
            f"got={got}",
        )
        check(
            rep.get("mergedSameEpisode") == 0,
            "场景1b 无同集归并",
            f"mergedSameEpisode={rep.get('mergedSameEpisode')}",
        )

        # ===== 场景 2：hash 冲突 ⇒ 各自成集 =====
        st, rep = http("POST", f"/api/media/series/{c_series}/merge", {"sourceId": d_series})
        print(f"\n[场景2] merge -> {st} {rep}")
        st, det = http("GET", f"/api/media/series/{c_series}")
        got = shape(det)
        print(f"[场景2] 合并后 = {got}")
        check(
            got == [(1, c_item, []), (2, d_item, [])],
            "场景2 hash 不同 ⇒ 两集各自保留",
            f"got={got}",
        )
        check(rep.get("mergedSameEpisode") == 0, "场景2 无同集归并", f"rep={rep.get('mergedSameEpisode')}")

        # ===== 场景 3：hash 相同 ⇒ 同一集（跨集号）=====
        st, rep = http("POST", f"/api/media/series/{e_series}/merge", {"sourceId": f_series})
        print(f"\n[场景3] merge -> {st} {rep}")
        st, det = http("GET", f"/api/media/series/{e_series}")
        got = shape(det)
        print(f"[场景3] 合并后 = {got}")
        check(
            got == [(1, e_item, [f_item])],
            "场景3 hash 相同 ⇒ 同一集多源（不新增集号）",
            f"got={got}",
        )
        check(rep.get("added") == 0, "场景3 added=0", f"added={rep.get('added')}")

        # ===== 场景 4：元数据取有值侧 =====
        st, _ = http("POST", f"/api/media/series/{g_series}/merge", {"sourceId": h_series})
        st, det = http("GET", f"/api/media/series/{g_series}")
        # `SeriesDetail` 把 `SeriesView` **flatten** 到顶层（不是 `{"series": {...}}`）。
        ser = det
        print(f"\n[场景4] 合并后 series = {ser}")
        check(ser.get("title") == "场景4-目标G", "场景4 标题保留目标侧", f"title={ser.get('title')}")
        check(
            ser.get("description") == "源侧介绍",
            "场景4 目标空串不挡住源侧介绍",
            f"description={ser.get('description')!r}",
        )
        check(ser.get("year") == 2020, "场景4 年份缺失侧继承", f"year={ser.get('year')}")
        check(
            ser.get("poster") == "/covers/src.jpg",
            "场景4 封面缺失侧继承",
            f"poster={ser.get('poster')}",
        )

        # ===== 场景 5：备用源随合并搬进目标（BUG-103 正修）=====
        st, rep = http("POST", f"/api/media/series/{i_series}/merge", {"sourceId": j_series})
        st, det = http("GET", f"/api/media/series/{i_series}")
        got = shape(det)
        print(f"\n[场景5] merge -> {st} {rep}\n[场景5] 合并后 = {got}")
        check(
            got == [(1, i_item, sorted([j_item, j_alt]))],
            "场景5 源主条目与其备用源都进目标同一集",
            f"got={got}",
        )
        st, orphan = http("GET", "/api/media/stats")
        print(f"[场景5] /api/media/stats -> {st} {orphan}")

        # 收尾：源剧集必须都没了
        for name, sid in (("B", b_series), ("D", d_series), ("F", f_series), ("H", h_series), ("J", j_series), ("O", o_series)):
            st, _ = http("GET", f"/api/media/series/{sid}")
            check(st == 404, f"源剧集 {name} 已删除", f"status={st}")

    finally:
        if proc is not None:
            stop(proc)
        if args.keep:
            print(f"\n临时目录保留：{tmp}")
        else:
            time.sleep(0.3)
            shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n===== {len(PASS)} PASS / {len(FAIL)} FAIL =====")
    if FAIL:
        for f in FAIL:
            print(f"  FAIL {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
