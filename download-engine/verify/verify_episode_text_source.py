#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
orig-tg 内容文案单一真源契约验收（纯标准库，无第三方依赖）。

覆盖（用户报的「剧集里面视频标题无法修改 / 介绍没填充进视频 / 剧集和视频天差地远」）：
  ① 剧集详情里的分集标题/介绍 = **它所指向条目**的标题/介绍（逐字），不是分集行上的副本；
  ② 分集 PATCH 改标题/介绍 → **写穿到条目**（GET /api/media/items/:id 立刻是新值）；
  ③ 反向：改条目（媒体库卡片编辑）→ 剧集详情里的分集标题/介绍跟着变；
  ④ 改完之后「条目详情 / 条目列表 / 剧集详情」三处读数**逐字一致**（同一份数据，不是三份）；
  ⑤ 空值语义与条目一致：标题空白 = 不改（空标题不可表达），介绍空 = 显式清空；
  ⑥ 端点半径：不存在的分集 id → 404；非法槽位 → 422（写穿不会误伤别人）。

数据安全：只建**一次性剧集**（结束时删除），被借用条目的标题/介绍在开始时快照、
结束时**逐字还原并复核**。因此对真实库运行也是可逆的；更彻底的隔离实例用法见
`verify_shots/run_episode_text_verify.sh`。

断言只认「有值 + 具体值」，绝不使用「不等于旧值」——元素消失产生的 null 会让后者假阳性。

用法：
  python3 verify/verify_episode_text_source.py [--base http://127.0.0.1:9877] [--evidence out.json]
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:9877"

EVIDENCE = []
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


def episode_of(detail, ep_id):
    for e in detail.get("episodes") or []:
        if e["id"] == ep_id:
            return e
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE, help="orig-tg 基址（默认 %s）" % DEFAULT_BASE)
    ap.add_argument("--evidence", default=None, help="证据 JSON 落盘路径（可选）")
    args = ap.parse_args()
    base = args.base

    stamp = str(int(time.time()))
    t2 = "改后标题-%s" % stamp
    t3 = "卡片改的标题-%s" % stamp
    d2 = "改后介绍：%s\n第二行也要在（多段文本不得被折叠）" % stamp

    series_id = None
    item_id = None
    saved = None

    try:
        # ---- 前置：一条视频内容 ----
        st, items = call(base, "GET", "/api/media/items?kind=video&limit=1")
        if st != 200:
            raise Fail("GET /api/media/items -> %s（orig-tg 是否在跑且已授权？）" % st)
        pool = (items or {}).get("items") or []
        if not pool:
            raise Fail("媒体库里没有视频内容，无法验证")
        item_id = pool[0]["id"]
        saved = {"title": pool[0].get("title"), "description": pool[0].get("description")}
        if not saved["title"]:
            raise Fail("借用的条目没有标题，快照失败")

        st, created = call(
            base,
            "POST",
            "/api/media/series",
            {"title": "verify-ep-text-%s" % stamp, "kind": "series"},
        )
        if st != 200 or not (created or {}).get("id"):
            raise Fail("创建剧集失败: %s %s" % (st, created))
        series_id = created["id"]

        st, app = call(
            base,
            "POST",
            "/api/media/series/%d/episodes/append" % series_id,
            {"itemIds": [item_id]},
        )
        check("前置：内容编入一次性剧集", st == 200 and (app or {}).get("added") == 1,
              "added=%s" % (app or {}).get("added"))

        st, det = call(base, "GET", "/api/media/series/%d" % series_id)
        ep = (det.get("episodes") or [None])[0]
        if not ep:
            raise Fail("剧集详情没有分集")
        ep_id = ep["id"]

        # ---- ① 剧集详情读到的就是条目的那一份 ----
        check(
            "① 剧集详情里的分集标题 = 条目标题（逐字）",
            ep.get("title") == saved["title"],
            "ep.title=%r item.title=%r" % (ep.get("title"), saved["title"]),
        )
        check(
            "① 分集字段里不再有第二套 itemTitle/itemDescription（同一份数据只有一个名字）",
            "itemTitle" not in ep and "itemDescription" not in ep,
            "keys=%s" % sorted(ep.keys()),
        )

        # ---- ② 分集 PATCH 写穿到条目 ----
        st, _ = call(
            base,
            "PATCH",
            "/api/media/episodes/%d" % ep_id,
            {"title": t2, "description": d2},
        )
        st2, one = call(base, "GET", "/api/media/items/%d" % item_id)
        check(
            "② 在剧集里改标题 → 条目标题真的变了（写穿，不是只改了个副本）",
            st == 200 and one.get("title") == t2,
            "status=%s item.title=%r" % (st, one.get("title")),
        )
        check(
            "② 同一次 PATCH 里的介绍也写进条目（逐字，含换行）",
            one.get("description") == d2,
            "item.description=%r" % (one.get("description") or "")[:60],
        )

        # ---- ④ 三处读数逐字一致 ----
        st, det2 = call(base, "GET", "/api/media/series/%d" % series_id)
        ep2 = episode_of(det2, ep_id)
        check(
            "④ 剧集详情与条目详情**逐字**一致（标题）",
            ep2.get("title") == t2 == one.get("title"),
            "series=%r item=%r" % (ep2.get("title"), one.get("title")),
        )
        check(
            "④ 剧集详情与条目详情**逐字**一致（介绍）",
            ep2.get("description") == d2 == one.get("description"),
            "series.len=%s item.len=%s"
            % (len(ep2.get("description") or ""), len(one.get("description") or "")),
        )
        st, lst = call(base, "GET", "/api/media/items?kind=video&limit=200")
        row = next((x for x in (lst or {}).get("items") or [] if x["id"] == item_id), None)
        check(
            "④ 条目**列表**里的标题也是同一个值（列表与详情不分叉）",
            row is not None and row.get("title") == t2,
            "list.title=%r" % (row or {}).get("title"),
        )

        # ---- ③ 反向：改条目 → 剧集详情跟着变 ----
        st, _ = call(base, "PATCH", "/api/media/items/%d" % item_id, {"title": t3})
        st2, det3 = call(base, "GET", "/api/media/series/%d" % series_id)
        ep3 = episode_of(det3, ep_id)
        check(
            "③ 改条目（媒体库卡片那一路）→ 剧集详情里的分集标题同步跟着变",
            st == 200 and ep3.get("title") == t3,
            "status=%s ep.title=%r" % (st, ep3.get("title")),
        )

        # ---- ⑤ 空值语义与条目一致 ----
        st, _ = call(base, "PATCH", "/api/media/episodes/%d" % ep_id, {"title": "   "})
        st2, one5 = call(base, "GET", "/api/media/items/%d" % item_id)
        check(
            "⑤ 空白标题 = 不改（空标题不可表达，旧值必须留住）",
            st == 200 and one5.get("title") == t3,
            "status=%s title=%r" % (st, one5.get("title")),
        )
        st, _ = call(base, "PATCH", "/api/media/episodes/%d" % ep_id, {"description": None})
        st2, one6 = call(base, "GET", "/api/media/items/%d" % item_id)
        check(
            "⑤ 介绍显式 null = 清空（可表达的意图，不是「不改」）",
            st == 200 and one6.get("description") is None,
            "status=%s desc=%r" % (st, one6.get("description")),
        )

        # ---- ⑥ 端点半径 ----
        st, _ = call(base, "PATCH", "/api/media/episodes/999999999", {"title": "不该生效"})
        check("⑥ 不存在的分集 id → 404（不是静默成功）", st == 404, "status=%s" % st)
        st, _ = call(base, "PATCH", "/api/media/episodes/%d" % ep_id, {"episodeNo": 0})
        check("⑥ 非法槽位 episodeNo=0 → 422", st == 422, "status=%s" % st)

    except Fail as e:
        check("前置条件满足", False, str(e))
    finally:
        # ---- 还原借用的条目（逐字）----
        if item_id is not None and saved is not None:
            try:
                st, _ = call(
                    base,
                    "PATCH",
                    "/api/media/items/%d" % item_id,
                    {"title": saved["title"], "description": saved["description"]},
                )
                st2, back = call(base, "GET", "/api/media/items/%d" % item_id)
                check(
                    "还原：借用条目的标题与介绍逐字回到原值",
                    back.get("title") == saved["title"]
                    and back.get("description") == saved["description"],
                    "title=%r" % back.get("title"),
                )
            except Fail as e:
                check("还原：借用条目", False, str(e))
        if series_id:
            try:
                st, _ = call(base, "DELETE", "/api/media/series/%d" % series_id)
                print("cleanup: series=%s status=%s" % (series_id, st))
            except Fail as e:
                print("cleanup failed: %s" % e)
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
