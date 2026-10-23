#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BUG-401 验收：/stream 回跳命中 206，而非重新直播首转（x-orig-stream: live）。

用法：
  python verify_bug401_stream_range.py --base http://127.0.0.1:19787 --item-id 1645

判据：
  - 对已转码 / 转码中的条目发 closed Range（bytes=START-END）⇒ 206 + Content-Range + ETag；
  - 若命中增长中 .part，x-orig-stream == part（不是 live）；
  - 对已完成代理的条目发 Range ⇒ 206 且 x-orig-stream == proxy。
  即回跳不应落到 live 分支重新拉整条流。

说明：请在「正在播放 / 已播放过」的条目上跑（代理或 .part 已存在）；
未播放的冷条目首拉必然是 live（200），不属于本判据范围。
"""
import argparse
import sys
import urllib.request
import urllib.error


def range_probe(base: str, item_id: int, start: int, end: int):
    url = f"{base}/api/media/items/{item_id}/stream"
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:19787")
    ap.add_argument("--item-id", required=True, type=int)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=1023)
    args = ap.parse_args()

    status, hdrs = range_probe(args.base, args.item_id, args.start, args.end)
    x = hdrs.get("x-orig-stream", "")
    ar = hdrs.get("accept-ranges", "")
    etag = hdrs.get("etag", "")
    cr = hdrs.get("content-range", "")

    print(
        f"status={status} x-orig-stream={x!r} accept-ranges={ar!r} "
        f"etag={etag!r} content-range={cr!r}"
    )

    # live 分支撒谎头已撤：live 不应再声明 accept-ranges。
    if x == "live" and ar:
        print("FAIL: live 分支仍谎称 accept-ranges（BUG-401 未修）")
        return 1

    ok = status == 206 and etag and cr and x in ("part", "proxy")
    if ok:
        print("PASS: Range 命中 206 + ETag + Content-Range，且未重新直播首转")
        return 0
    print("FAIL: 未满足 BUG-401 判据（期望 206 + 缓存验证头，x-orig-stream ∈ {part,proxy}）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
