#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
orig-tg 分集编排 + 剧集标签契约验收（纯标准库，无第三方依赖）。

覆盖（对应用户提出的 ③a / ③b）：
  ① 集号可编辑，且**允许任意值**（2、3、7… 不必从 1 连续）——用户手工编排的号不被抹平；
  ② 目标槽被同剧另一条占用时**对调**两条槽位（不是报冲突、不是丢弃）；
  ③ 剧集内换位**只动相邻两条**，不重排全季；
  ④ 边界位置换位如实回报 `moved=false`（不是静默成功）；
  ⑤ 文本字段与槽位可在同一次 PATCH 内一并生效；
  ⑥ 按标签筛剧集（TG `#标签` 归档到剧集后的可用面：筛剧集能筛到、控制组筛不到）。

全部操作落在**一次性剧集**上，结束时删除；不触碰既有数据。
断言只认「有值 + 具体值」，绝不使用「不等于旧值」——元素消失产生的 null 会让后者假阳性。

用法：
  python3 verify/verify_episode_edit.py [--base http://127.0.0.1:9877] [--evidence out.json]
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:9877"

# 本轮的「证据台账」：每次请求的真实状态码 + 响应体都落进来，供事后复核。
EVIDENCE = []
# 断言结果：(ok, name, detail)
CHECKS = []


class Fail(Exception):
    """无法继续的前置失败（区别于断言失败）。"""


def call(base, method, path, body=None):
    """发一次真实 HTTP 请求，返回 (status, parsed)。状态码与响应体一律记账。"""
    url = base.rstrip("/") + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
    except Exception as e:  # 连接层失败：如实记账，不伪装成 200
        EVIDENCE.append({"method": method, "path": path, "status": None, "error": str(e)})
        raise Fail("request failed: %s %s -> %s" % (method, path, e))
    try:
        parsed = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        parsed = raw
    EVIDENCE.append(
        {
            "method": method,
            "path": path,
            "status": status,
            "body": body,
            "response": parsed if not isinstance(parsed, str) else parsed[:400],
        }
    )
    return status, parsed


def check(name, ok, detail=""):
    CHECKS.append((bool(ok), name, detail))
    print("%s %s%s" % ("PASS" if ok else "FAIL", name, (" — " + detail) if detail else ""))
    return bool(ok)


def ep_map(detail):
    """剧集详情 → {episodeId: (season, episodeNo, itemId)}"""
    out = {}
    for e in detail.get("episodes") or []:
        out[e["id"]] = (e["season"], e["episodeNo"], e["itemId"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE, help="orig-tg 基址（默认 %s）" % DEFAULT_BASE)
    ap.add_argument("--evidence", default=None, help="证据 JSON 落盘路径（可选）")
    args = ap.parse_args()
    base = args.base

    stamp = str(int(time.time()))
    series_id = None
    tag_yes = None
    tag_no = None
    # ⑤ 会改一条真实内容的标题（分集改名 = 改所指向条目的标题，契约如此）。
    # 借用的条目必须先快照、结束**逐字还原** —— 验收脚本没有权力留下痕迹。
    borrowed = None
    borrowed_saved = None

    try:
        # ---- 前置：需要有 3 条内容可编排 ----
        st, items = call(base, "GET", "/api/media/items?limit=5")
        if st != 200:
            raise Fail("GET /api/media/items -> %s（orig-tg 是否在跑且已授权？）" % st)
        pool = [i["id"] for i in (items or {}).get("items") or []]
        if len(pool) < 3:
            raise Fail("媒体库内容不足 3 条（实得 %d），无法验证编排" % len(pool))
        a, b, c = pool[0], pool[1], pool[2]
        borrowed = a
        st, it0 = call(base, "GET", "/api/media/items/%d" % borrowed)
        borrowed_saved = {"title": (it0 or {}).get("title"), "description": (it0 or {}).get("description")}
        if st != 200 or not borrowed_saved["title"]:
            raise Fail("无法快照借用条目 %s，风险不可控，停止" % borrowed)

        # ---- 建一次性剧集 ----
        st, created = call(
            base,
            "POST",
            "/api/media/series",
            {"title": "verify-episode-edit-%s" % stamp, "kind": "series"},
        )
        if st != 200 or not (created or {}).get("id"):
            raise Fail("创建剧集失败: %s %s" % (st, created))
        series_id = created["id"]

        st, app = call(
            base,
            "POST",
            "/api/media/series/%d/episodes/append" % series_id,
            {"itemIds": [a, b, c]},
        )
        check("前置：3 条内容按序编入剧集", st == 200 and (app or {}).get("added") == 3, "added=%s" % (app or {}).get("added"))

        st, d = call(base, "GET", "/api/media/series/%d" % series_id)
        m = ep_map(d)
        # itemId -> episodeId
        by_item = {v[2]: k for k, v in m.items()}
        ea, eb, ec = by_item[a], by_item[b], by_item[c]
        check(
            "前置：集号从 1 起连续、顺序与追加顺序一致",
            [m[ea][1], m[eb][1], m[ec][1]] == [1, 2, 3],
            "nos=%s" % [m[ea][1], m[eb][1], m[ec][1]],
        )

        # ---- ① 集号可改成任意值（7），且不影响他人 ----
        st, _ = call(base, "PATCH", "/api/media/episodes/%d" % ea, {"episodeNo": 7})
        st2, d = call(base, "GET", "/api/media/series/%d" % series_id)
        m = ep_map(d)
        check(
            "① 集号可设为 7（不必从 1 连续），其余两集集号不受影响",
            st == 200 and m[ea][1] == 7 and m[eb][1] == 2 and m[ec][1] == 3,
            "status=%s a=%s b=%s c=%s" % (st, m[ea][1], m[eb][1], m[ec][1]),
        )

        # ---- ② 目标槽被占用 → 对调（b 想占 3，而 3 属于 c）----
        st, _ = call(base, "PATCH", "/api/media/episodes/%d" % eb, {"episodeNo": 3})
        st2, d = call(base, "GET", "/api/media/series/%d" % series_id)
        m = ep_map(d)
        check(
            "② 占用槽对调：b→3 且 c 被让到 2（不是报错、不是丢弃）",
            st == 200 and m[eb][1] == 3 and m[ec][1] == 2 and m[ea][1] == 7,
            "status=%s a=%s b=%s c=%s" % (st, m[ea][1], m[eb][1], m[ec][1]),
        )

        # 此刻 a=7 b=3 c=2
        # ---- ③ 换位 down：b(3) 与更大的 a(7) 对调 ----
        st, mv = call(base, "POST", "/api/media/episodes/%d/move" % eb, {"dir": "down"})
        st2, d = call(base, "GET", "/api/media/series/%d" % series_id)
        m = ep_map(d)
        check(
            "③ 下移只换相邻两条：b↔a 互换（a=3, b=7, c=2 不变）",
            st == 200 and (mv or {}).get("moved") is True and m[ea][1] == 3 and m[eb][1] == 7 and m[ec][1] == 2,
            "moved=%s a=%s b=%s c=%s" % ((mv or {}).get("moved"), m[ea][1], m[eb][1], m[ec][1]),
        )

        # 此刻 a=3 b=7 c=2
        # ---- ③ 换位 up：b(7) 与更小的 a(3) 对调 ----
        st, mv = call(base, "POST", "/api/media/episodes/%d/move" % eb, {"dir": "up"})
        st2, d = call(base, "GET", "/api/media/series/%d" % series_id)
        m = ep_map(d)
        check(
            "③ 上移对称：b↔a 换回（a=7, b=3, c=2）",
            st == 200 and (mv or {}).get("moved") is True and m[ea][1] == 7 and m[eb][1] == 3 and m[ec][1] == 2,
            "moved=%s a=%s b=%s c=%s" % ((mv or {}).get("moved"), m[ea][1], m[eb][1], m[ec][1]),
        )

        # ---- ④ 边界：c 已是最小集号，上移必须如实报 false 且原地不动 ----
        st, mv = call(base, "POST", "/api/media/episodes/%d/move" % ec, {"dir": "up"})
        st2, d = call(base, "GET", "/api/media/series/%d" % series_id)
        m = ep_map(d)
        check(
            "④ 边界换位如实回报 moved=false，且集号原地不动（c 仍为 2）",
            st == 200 and (mv or {}).get("moved") is False and m[ec][1] == 2 and m[ea][1] == 7 and m[eb][1] == 3,
            "moved=%s c=%s" % ((mv or {}).get("moved"), m[ec][1]),
        )

        # ---- ⑤ 文本 + 槽位同一次 PATCH 生效 ----
        st, _ = call(
            base,
            "PATCH",
            "/api/media/episodes/%d" % ea,
            {"title": "verify-title-%s" % stamp, "episodeNo": 5},
        )
        st2, d = call(base, "GET", "/api/media/series/%d" % series_id)
        m = ep_map(d)
        title = next((e.get("title") for e in (d.get("episodes") or []) if e["id"] == ea), None)
        check(
            "⑤ 同一次 PATCH 内 title 与 episodeNo 一并生效",
            st == 200 and m[ea][1] == 5 and title == "verify-title-%s" % stamp,
            "status=%s no=%s title=%s" % (st, m[ea][1], title),
        )

        # ---- ⑥ 按标签筛剧集（TG #标签 归档后的可用面）----
        st, t1 = call(base, "POST", "/api/media/tags", {"name": "verify-tag-yes-%s" % stamp})
        tag_yes = (t1 or {}).get("id")
        st2, t2 = call(base, "POST", "/api/media/tags", {"name": "verify-tag-no-%s" % stamp})
        tag_no = (t2 or {}).get("id")
        if not tag_yes or not tag_no:
            raise Fail("建标签失败: %s %s" % (t1, t2))

        st, _ = call(
            base, "PUT", "/api/media/series/%d/tags" % series_id, {"tagIds": [tag_yes]}
        )
        st2, hit = call(base, "GET", "/api/media/series?tagId=%d" % tag_yes)
        hit_ids = [s["id"] for s in (hit or {}).get("items") or []]
        st3, miss = call(base, "GET", "/api/media/series?tagId=%d" % tag_no)
        miss_ids = [s["id"] for s in (miss or {}).get("items") or []]
        st4, allr = call(base, "GET", "/api/media/series")
        all_ids = [s["id"] for s in (allr or {}).get("items") or []]

        check(
            "⑥ 打标后按该标签能筛到本剧集，且不带其他剧集的漏筛",
            st == 200 and st2 == 200 and series_id in hit_ids,
            "hit=%s contains_series=%s" % (len(hit_ids), series_id in hit_ids),
        )
        check(
            "⑥ 控制组：无剧集使用的标签筛出 0 条，且不含本剧集",
            st3 == 200 and miss_ids == [],
            "control=%s" % miss_ids,
        )
        check(
            "⑥ 无条件查询仍包含本剧集（筛选不是把数据藏起来）",
            st4 == 200 and series_id in all_ids,
            "all=%s contains=%s" % (len(all_ids), series_id in all_ids),
        )

    except Fail as e:
        check("前置条件满足", False, str(e))
    finally:
        # ---- 清理：无论成败都删掉本轮建的东西，不留垃圾 ----
        cleanup = []
        if borrowed is not None and borrowed_saved is not None:
            try:
                st, _ = call(
                    base,
                    "PATCH",
                    "/api/media/items/%d" % borrowed,
                    {
                        "title": borrowed_saved["title"],
                        "description": borrowed_saved["description"],
                    },
                )
                st2, back = call(base, "GET", "/api/media/items/%d" % borrowed)
                check(
                    "还原：借用条目的标题与介绍逐字回到原值",
                    back.get("title") == borrowed_saved["title"]
                    and back.get("description") == borrowed_saved["description"],
                    "title=%r" % back.get("title"),
                )
            except Fail as e:
                check("还原：借用条目", False, str(e))
        if series_id:
            try:
                st, _ = call(base, "DELETE", "/api/media/series/%d" % series_id)
                cleanup.append("series=%s status=%s" % (series_id, st))
            except Fail as e:
                cleanup.append("series delete failed: %s" % e)
        for tid in (tag_yes, tag_no):
            if tid:
                try:
                    st, _ = call(base, "DELETE", "/api/media/tags/%d" % tid)
                    cleanup.append("tag=%s status=%s" % (tid, st))
                except Fail as e:
                    cleanup.append("tag delete failed: %s" % e)
        print("cleanup: " + ("; ".join(cleanup) if cleanup else "nothing to clean"))

        # 复验清理：剧集必须真的没了
        if series_id:
            try:
                st, _ = call(base, "GET", "/api/media/series/%d" % series_id)
                check("清理：一次性剧集已删除（详情 404）", st == 404, "status=%s" % st)
            except Fail as e:
                check("清理：一次性剧集已删除（详情 404）", False, str(e))

    passed = sum(1 for ok, _, _ in CHECKS if ok)
    total = len(CHECKS)
    print("\n== %d/%d passed ==" % (passed, total))

    report = {
        "base": base,
        "checks": [{"ok": ok, "name": n, "detail": d} for ok, n, d in CHECKS],
        "passed": passed,
        "total": total,
        "evidence": EVIDENCE,
    }
    if args.evidence:
        with open(args.evidence, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print("evidence -> %s" % args.evidence)
    return 0 if passed == total and total > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
