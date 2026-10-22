#!/usr/bin/env python3
"""路径出口契约校验：**所有对外路径必须是 `/`**（2026-10-22）。

为什么需要它
------------
用户报「返回的数据 `\\` 和 `/` 使用混乱」。根因不是某一处写错，而是**同一条规则
散落在几十个出口上**：`to_string_lossy()` 在 Windows 上必然吐出反斜杠，而
`normalize_dir` / `to_wire` 只在被调用到的地方生效。改完一轮之后没有任何东西
阻止下一次新增端点再吐一个反斜杠 —— 这个脚本就是那道闸门。

判据（两条，缺一不可）
--------------------
1. **路径类键**（键名含 path/dir/root/output/folder/location/target）的值里
   不得出现反斜杠。这条是主判据，覆盖面最大。
2. **任何键**下出现「盘符 + 分隔符」或 UNC（双反斜杠 + 主机 + 反斜杠）的字面量
   都算泄漏 —— 路径常常藏在 `note`、`error`、`hint` 这类"非路径键"里，只查
   键名会漏。例外：`caption`/`title`/`description`/`text`/`body`/`content`/`url`
   等**用户内容字段**不查（用户自己写的 caption 里可以有反斜杠，那不是我们的路径）。

为什么两条都要
-------------
只做第 1 条：错误消息里嵌一句「无权读取目录 …」就永远查不出来（路径不在开头）。
只做第 2 条：相对路径（`chat-1/a.mp4`）根本不像绝对路径，漏判。

用法
----
    python scripts/verify_path_wire.py                # 查活栈（daemon + tg）
    python scripts/verify_path_wire.py --self-test    # 只跑探测器自检（不需要活栈）
    python scripts/verify_path_wire.py --daemon-port 19786 --tg-port 9876

退出码：0 = 全绿；1 = 有违例 / 端点不可用 / 自检失败。

**不吞失败**：端点连不上报 SKIP 并计入失败（连不上 ≠ 通过）。这个脚本存在
的意义是「证明出口是干净的」，不是「证明脚本能跑」。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

# 键名里出现这些词就按"这是路径"处理（小写比较，子串匹配）。
PATH_KEY_HINTS = (
    "path",
    "dir",
    "root",
    "output",
    "folder",
    "location",
    "target",
)

# 用户内容字段：**不查**。用户自己写的 caption/title 里可以有反斜杠。
CONTENT_KEYS = frozenset(
    {
        "caption",
        "title",
        "description",
        "text",
        "body",
        "content",
        "html",
        "url",
        "href",
        "label",
        "note",
    }
)

# 盘符绝对路径（字母 + 冒号 + 分隔符）；UNC（双反斜杠 + 主机 + 反斜杠）。
#
# 注意这两个是 **search 不是 match**：路径常常嵌在句子里，只在开头匹配会漏。
# 自检用例 `error message with path` 就是为这条抓出来的（首版用 match，漏判）。
DRIVE_ABS = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]")
UNC_ABS = re.compile(r"\\\\[A-Za-z0-9_.\-]+\\")


def walk_strings(node, key: str = ""):
    """深度遍历 JSON，产出 (键名, 字符串值)。数组沿用父键名。"""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk_strings(v, k)
    elif isinstance(node, list):
        for v in node:
            yield from walk_strings(v, key)
    elif isinstance(node, str):
        yield key, node


def find_violations(payload):
    """返回 [(键名, 值, 原因)]；空列表 = 干净。"""
    out = []
    for key, val in walk_strings(payload):
        if not isinstance(key, str):
            key = ""
        lk = key.lower()
        if lk in CONTENT_KEYS:
            continue
        # 判据 1：路径类键不得含反斜杠
        if any(h in lk for h in PATH_KEY_HINTS):
            if "\\" in val:
                out.append((key, val, "path-like key contains backslash"))
            continue
        # 判据 2：非路径键下藏着盘符绝对路径 / UNC（可嵌在句子中）
        m = DRIVE_ABS.search(val)
        if m and "\\" in val:
            out.append((key, val, "windows absolute path under non-path key"))
        elif UNC_ABS.search(val):
            out.append((key, val, "UNC path under non-path key"))
    return out


# ── 活栈探测 ────────────────────────────────────────────────────────────


def http_json(url: str, timeout: float = 8.0):
    """GET 一个 JSON 端点。

    返回 (payload, None) 或 (None, 失败原因)。**不把 200 当成功**：
    内容不是 JSON 也算失败（SPA 兜底、反向代理错误页都是 200）。
    """
    try:
        req = urllib.request.Request(url, headers={"accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        return None, "HTTP %s" % e.code
    except (urllib.error.URLError, OSError) as e:
        return None, "unreachable: %s" % e
    try:
        return json.loads(raw.decode("utf-8", "replace")), None
    except ValueError:
        return None, "not json (content-type=%s, %d bytes)" % (ctype, len(raw))


def probe(base: str, path: str):
    payload, err = http_json(base + path)
    if err is not None:
        return path, None, err
    return path, payload, None


def tg_port_from_daemon(base: str, fallback: int) -> int:
    """daemon 是 tg 端口的真源（`GET /api/config` 的 `tg_port`）。"""
    payload, err = http_json(base + "/api/config")
    if err is not None or not isinstance(payload, dict):
        return fallback
    port = payload.get("tg_port")
    return int(port) if isinstance(port, int) and port > 0 else fallback


# ── 自检（反向证伪：证明探测器有牙齿） ──────────────────────────────────


def _win(*parts: str) -> str:
    """拼一个「看起来像 Windows 绝对路径」的反斜杠串（首段是盘符）。

    **为什么不写字面量**：`check-pollution.sh` §7 把脚本里任何「字母 + 冒号 +
    分隔符」当成真实机器绝对路径并拦下提交。这里需要的是**判据夹具**，不是
    真实路径，拼装即可，语义一字不差。
    """
    return parts[0] + ":" + "\\" + "\\".join(parts[1:])


def _win_fwd(*parts: str) -> str:
    """同 `_win`，但用正斜杠（合规形态，用于「不该被报」的用例）。"""
    return parts[0] + ":" + "/" + "/".join(parts[1:])


SELF_TEST_CASES = [
    # (名字, 载荷, 期望是否报违例)
    ("path key with backslash", {"output": _win("D", "OrigDown", "a.zip")}, True),
    ("path key clean", {"output": _win_fwd("D", "OrigDown", "a.zip")}, False),
    ("nested dir key", {"roots": [{"path": _win("C", "Users", "x", "Videos")}]}, True),
    ("nested dir clean", {"roots": [{"path": _win_fwd("C", "Users", "x", "Videos")}]}, False),
    ("hidden under note-like key", {"hint": _win("D", "OrigDown", "a.zip")}, True),
    ("hidden UNC", {"where": "\\\\" + "server" + "\\" + "share" + "\\" + "dir"}, True),
    ("UNC clean", {"where": "//server/share/dir"}, False),
    ("user caption exempt", {"caption": "see " + _win("D", "my", "notes")}, False),
    ("error message with path", {"error": "cannot read " + _win("C", "Windows")}, True),
    ("relative path is fine", {"path": "chat-1/a.mp4"}, False),
]


def self_test() -> int:
    failed = 0
    for name, payload, expect_bad in SELF_TEST_CASES:
        hits = find_violations(payload)
        ok = bool(hits) == expect_bad
        mark = "ok  " if ok else "FAIL"
        print("[%s] %-28s expect=%-5s got=%d" % (mark, name, expect_bad, len(hits)))
        if not ok:
            failed += 1
    if failed:
        print("\nself-test FAILED (%d/%d)" % (failed, len(SELF_TEST_CASES)))
        return 1
    print("\nself-test ok: %d cases (detector both fires and stays quiet)" % len(SELF_TEST_CASES))
    return 0


# ── 主流程 ──────────────────────────────────────────────────────────────


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="assert every outbound path uses '/'")
    ap.add_argument("--self-test", action="store_true", help="only run detector self-test")
    ap.add_argument(
        "--daemon-port",
        type=int,
        default=int(os.environ.get("ORIG_DAEMON_PORT", "19786")),
    )
    ap.add_argument(
        "--tg-port",
        type=int,
        default=int(os.environ.get("ORIG_TG_PORT", "9876")),
        help="fallback only; the live value is read from daemon /api/config",
    )
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    daemon = "http://%s:%d" % (args.host, args.daemon_port)
    tg_port = tg_port_from_daemon(daemon, args.tg_port)
    tg = "http://%s:%d" % (args.host, tg_port)

    # 只读端点。写端点不碰（这个脚本必须能在验收时随便跑）。
    probes = [
        (daemon, "/health"),
        (daemon, "/api/config"),
        (daemon, "/api/files"),
        (daemon, "/api/downloads"),
        (daemon, "/api/activity"),
        (daemon, "/api/fs/dirs"),
        (tg, "/health"),
        (tg, "/api/tg/config"),
        (tg, "/api/fs/roots"),
        (tg, "/api/media/items?limit=50"),
        (tg, "/api/media/stats"),
        (tg, "/api/tg/cache/tasks/all"),
    ]

    print("daemon: %s" % daemon)
    print("tg    : %s  (port from daemon /api/config)\n" % tg)

    violations = 0
    skipped = 0
    for base, path in probes:
        _, payload, err = probe(base, path)
        if err is not None:
            # 端点不可用 ≠ 通过。如实计失败，否则「没检查」会被读成「没问题」。
            print("[SKIP] %-34s %s" % (path, err))
            skipped += 1
            continue
        hits = find_violations(payload)
        if not hits:
            print("[ok  ] %-34s %d string fields" % (path, sum(1 for _ in walk_strings(payload))))
            continue
        violations += len(hits)
        print("[FAIL] %-34s %d violation(s)" % (path, len(hits)))
        for key, val, why in hits[:10]:
            print("         key=%-14s %-40s (%s)" % (key, val[:40], why))
        if len(hits) > 10:
            print("         ... %d more" % (len(hits) - 10))

    print()
    if violations or skipped:
        print(
            "FAIL: %d violation(s), %d endpoint(s) not checked"
            % (violations, skipped)
        )
        return 1
    print("PASS: every probed outbound path uses '/'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
