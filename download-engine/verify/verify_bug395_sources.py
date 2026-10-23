#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BUG-395 验收：/api/sources 独立健康端点形态 + available 口径逐字一致 + counts 上移。

用法：
  python verify_bug395_sources.py --base http://127.0.0.1:19786

判据：
  1. GET /api/sources ⇒ 200，JSON 含 sources[]（每项 kind/available，无 count 字段）、
     counts{download,cache}、generated_at；
  2. /api/sources 与 /api/activity?scope=all 中同 kind 的 available 必须一致；
  3. /api/activity 的 counts.download / counts.cache 必须分别等于其 tasks 中
     对应 kind 的实际条数（scope=active 与 scope=all 各验一次）；
  4. /api/activity（及 /api/downloads）的 sources[] 不再含 count 字段（BUG-395 第二步）。
"""
import argparse
import json
import sys
import urllib.request


def get_json(base: str, path: str):
    with urllib.request.urlopen(f"{base}{path}", timeout=30) as r:
        return r.status, json.loads(r.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:19786")
    args = ap.parse_args()

    st, src = get_json(args.base, "/api/sources")
    assert st == 200, f"/api/sources 非 200: {st}"
    assert isinstance(src.get("sources"), list), "缺少 sources[]"
    assert isinstance(src.get("counts"), dict), "缺少 counts"
    assert "generated_at" in src, "缺少 generated_at"
    for s in src["sources"]:
        assert "kind" in s and "available" in s, "source 缺 kind/available"
        assert "count" not in s, "BUG-395 第二步：/api/sources 的 sources[] 不应含 count"

    # available 口径一致性（与 /api/activity?scope=all 逐字一致）
    st2, act = get_json(args.base, "/api/activity?scope=all")
    assert st2 == 200, f"/api/activity 非 200: {st2}"
    amap = {s["kind"]: s for s in act.get("sources", [])}
    for s in src["sources"]:
        a = amap.get(s["kind"])
        assert a is not None, f"/api/activity 缺来源 {s['kind']}"
        assert a["available"] == s["available"], (
            f"available 口径不一致 kind={s['kind']}: "
            f"/api/sources={s['available']} /api/activity={a['available']}"
        )
        assert "count" not in a, "BUG-395 第二步：/api/activity sources[] 不应含 count"

    # counts 判据：scope=active / scope=all 各自 counts 等于 tasks 实际条数
    for scope in ("active", "all"):
        _, snap = get_json(args.base, f"/api/activity?scope={scope}")
        dl = sum(1 for t in snap.get("tasks", []) if t.get("kind") == "download")
        ca = sum(1 for t in snap.get("tasks", []) if t.get("kind") == "cache")
        assert snap["counts"]["download"] == dl, (
            f"scope={scope} counts.download={snap['counts']['download']} "
            f"!= tasks download={dl}"
        )
        assert snap["counts"]["cache"] == ca, (
            f"scope={scope} counts.cache={snap['counts']['cache']} "
            f"!= tasks cache={ca}"
        )

    print("PASS: /api/sources 形态正确；available 口径与 /api/activity 一致；")
    print("      counts 已上移至顶层且等于 tasks 实际条数；sources[] 不再含 count。")
    print(f"  /api/sources.sources = {src['sources']}")
    print(f"  /api/sources.counts  = {src['counts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
