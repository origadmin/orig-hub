"""BUG-135 / BUG-136 **反向证伪**（QA 独立版，跑在隔离 mock 实例上）。

与 `verify_bug_135_136.py`（工程师版）的分工：那份把契约跑一遍；这份专门找
「能把自己骗过去」的点，全部读**原始响应文本**，且每个证伪点都配对照组。

BUG-135 `DELETE /api/media/items/:id`
  A1 外部文件（下载目录之外）条目删除 → 用户的文件必须**仍在**（一个字节都不能删）
  A2 字节先于请求就丢了（用户在别处删过）的目录内条目 → 看服务端怎么说
      （文档声称「字节已不在」应算成功，实现是否一致，是本案的取证点）
  A3 ★ 清 TG 标记失败 **且条目带 download-dir 内的真实字节**（直接写库造出来，
      import 给 tg 条目造不出 path）→ 契约要 500 且条目还在；同时取证
      「响应自称 nothing was deleted」与「字节到底删没删」是否一致
  A4 500 后可重入：同一个 id 再删一次不得产生新的副作用
  A5 对照组：非 tg 来源 + **同样的**垃圾 ref → 必须能删（200），证 500 归因于
      tg 标记清不掉，而不是「带不可解析 ref 就拒删」
  A6 正向对照：tg 条目 + 可解析 ref + 目录内真实字节（写库造）→ 200 且字节真的没了
  A7 ★ 真失败：`CreateFileW(share=0)` 独占句柄（非 PowerShell、非伪造）→
      必须 200 + `bytesRemoved:false` + `bytesError` 非空 + 字节仍在盘 + WARN 留痕

BUG-136 `GET /api/cache/stats`
  B1 ★ 与 `GET /api/cache/clear/preview` 的 external **原始文本逐字一致**（含键顺序：
      解析成对象再比会漏掉顺序漂移）
  B2 stats 顶层字段集合不增不减（禁止新增 `total` 之类）
  B3 `bytes` 口径不变：孤儿字节（目录内、无条目背书）不得混进 `bytes`
  B4 外部多用例：存在 + 缺失 → count/bytes 两端同值，且 removable 恒 false
  B5 `--mode=dump`：只输出快照 JSON，用于与**修复前**实例做 before/after 比对

用法：
  ORIG_TG_BASE=http://127.0.0.1:9879 ORIG_TG_DOWNLOAD_DIR=... ORIG_TG_EXTERNAL_DIR=... \
    ORIG_TG_DB=<同一个隔离库> python download-engine/verify/verify_bug_135_136_falsify.py
  同上 + --mode=dump          # 只出快照（给修复前实例跑同样的 fixture）
"""

import ctypes
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("ORIG_TG_BASE", "http://127.0.0.1:9879")
DL = os.environ.get("ORIG_TG_DOWNLOAD_DIR", "")
EXT = os.environ.get("ORIG_TG_EXTERNAL_DIR", "")
QA_DB = os.environ.get("ORIG_TG_DB", "")
DUMP_MODE = "--mode=dump" in sys.argv

PASS, FAIL, OBSERVE = [], [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))
    return bool(cond)


def note(name, detail=""):
    OBSERVE.append(f"{name}: {detail}")
    print(f"  [NOTE] {name} -- {detail}")


def raw(method, path, body=None, timeout=60):
    """返回 (status, 响应原文) —— 不解析，便于逐字比对。"""
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def req(method, path, body=None):
    s, text = raw(method, path, body)
    try:
        return s, (json.loads(text) if text else None)
    except Exception:
        return s, {"raw": text}


def logs(lines=400):
    s, b = req("GET", f"/api/tg/logs?lines={lines}")
    assert s == 200, f"logs failed: {s}"
    if isinstance(b, list):
        return "\n".join(str(x) for x in b)
    if isinstance(b, dict):
        return "\n".join(str(x) for x in b.get("lines", []))
    return str(b)


def write_file(path, size):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"x" * size)
    return path


def import_item(**kw):
    s, b = req("POST", "/api/media/items", {"items": [kw]})
    assert s == 200 and b.get("count") == 1, f"import failed: {s} {b}"
    return b["ids"][0]


def j(p):
    return p.replace("\\", "/")


if not DL or not EXT:
    sys.exit("!! 需要 ORIG_TG_DOWNLOAD_DIR 与 ORIG_TG_EXTERNAL_DIR")
if os.path.abspath(DL) == os.path.abspath(EXT) or os.path.abspath(EXT).startswith(
    os.path.abspath(DL) + os.sep
):
    sys.exit("!! ORIG_TG_EXTERNAL_DIR 必须在下载目录之外")

# ══════════════════ BUG-136 fixture（固定尺寸，供 before/after 同值比对）══════════════════
print("\n### BUG-136 fixture")
ext_ok = write_file(j(os.path.join(EXT, "qa-outside-a.mp4")), 4096)
ext_gone = j(os.path.join(EXT, "qa-outside-gone.mp4"))
if os.path.exists(ext_gone):
    os.remove(ext_gone)
in_a = write_file(j(os.path.join(DL, "qa-inside-a.mp4")), 2048)
orphan = write_file(j(os.path.join(DL, "qa-orphan.mp4")), 8192)

import_item(source="local", path=ext_ok, title="qa-outside-a", kind="video")
import_item(source="local", path=ext_gone, title="qa-outside-gone", kind="video")
in_id = import_item(source="local", path=in_a, title="qa-inside-a", kind="video")

s_stats, raw_stats = raw("GET", "/api/cache/stats")
s_pv, raw_pv = raw("GET", "/api/cache/clear/preview")
assert s_stats == 200 and s_pv == 200, f"stats={s_stats} preview={s_pv}"
m1 = re.search(r'"external"\s*:\s*(\{[^}]*\}|-?\d+)', raw_stats)
m2 = re.search(r'"external"\s*:\s*(\{[^}]*\}|-?\d+)', raw_pv)
frag1 = m1.group(1) if m1 else "<absent>"
frag2 = m2.group(1) if m2 else "<absent>"
st = json.loads(raw_stats)
pv = json.loads(raw_pv)

if DUMP_MODE:
    print(
        "DUMP "
        + json.dumps(
            {
                "stats_external_raw": frag1,
                "preview_external_raw": frag2,
                "stats": {k: st.get(k) for k in ("ok", "files", "bytes", "external")},
                "preview_external": pv.get("external"),
                "preview_total": pv.get("total"),
                "preview_orphan": pv.get("orphan"),
                "stats_top_keys": sorted(st),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    sys.exit(0)

print(f"  stats.external 原文   = {frag1}")
print(f"  preview.external 原文 = {frag2}")
check("B1 ★ 两接口 external 原始文本逐字一致（含键顺序）", frag1 == frag2, f"stats={frag1} preview={frag2}")
check("B2 stats 顶层字段不增不减（无新增 total 之类）", set(st) == {"ok", "files", "bytes", "external"}, f"keys={sorted(st)}")
ext = st.get("external")
check(
    "B2b external 为对象且键集合 = {count,bytes,removable}",
    isinstance(ext, dict) and set(ext) == {"count", "bytes", "removable"},
    f"external={ext}",
)
check(
    "B3 bytes 口径不变：孤儿（目录内无条目背书 8192）不计入 bytes",
    st.get("bytes") == 2048 and st.get("files") == 1,
    f"bytes={st.get('bytes')} files={st.get('files')}",
)
check("B3b 孤儿仍在 preview.orphan 里（只是不进 bytes）", (pv.get("orphan") or {}).get("bytes") == 8192, f"orphan={pv.get('orphan')}")
check(
    "B4 外部多用例（存在 4096 + 缺失 0）→ count=2 bytes=4096",
    isinstance(ext, dict) and ext.get("count") == 2 and ext.get("bytes") == 4096,
    f"external={ext}",
)
check("B4b external.removable 恒 false", isinstance(ext, dict) and ext.get("removable") is False, f"{ext}")

# ══════════════════════════ BUG-135 反向证伪 ══════════════════════════
print("\n### BUG-135 反向证伪")

# A1 外部文件条目删除 → 用户的文件必须还在
user_id = import_item(source="local", path=ext_ok, title="qa-user-file", kind="video")
s, b = req("DELETE", f"/api/media/items/{user_id}")
check("A1a 外部文件条目删除 200", s == 200, f"status={s} body={b}")
check(
    "A1b ★ 用户的外部文件一个字节都没被删",
    os.path.exists(ext_ok) and b.get("bytesRemoved") is True and "bytesError" not in b,
    f"exists={os.path.exists(ext_ok)} body={b}",
)
check("A1c 条目已删（GET 404）", req("GET", f"/api/media/items/{user_id}")[0] == 404)

# A2 字节先就没了（用户在别处删过）的目录内条目
gone_path = write_file(j(os.path.join(DL, "qa-already-gone.mp4")), 256)
gone_id = import_item(source="local", path=gone_path, title="qa-already-gone", kind="video")
if os.path.exists(gone_path):
    os.remove(gone_path)
s, b = req("DELETE", f"/api/media/items/{gone_id}")
check("A2a 字节早已不在 → 仍 200 + removed:1", s == 200 and b.get("removed") == 1, f"status={s} body={b}")
note(
    "A2b 取证：字节本就不在时服务端如何表述",
    f"bytesRemoved={b.get('bytesRemoved')} bytesError={b.get('bytesError')!r} "
    f"（函数文档称『字节已不在』应与成功同档 → 期望 bytesRemoved=true 且无 bytesError）",
)

# tg 条目带真实字节需要直接写库：import 期为 tg 条目造不出 path（见 routes::import_media_items）
def forge_tg_item(ref_key, size, name):
    """写库造一个 source=tg 且带 download-dir 内字节的条目（import 接口做不到）。"""
    if not QA_DB:
        return None
    p = write_file(j(os.path.join(DL, name)), size)
    con = sqlite3.connect(QA_DB, timeout=15)
    try:
        s2, b2 = req("POST", "/api/media/items", {"items": [{"source": "tg", "ref": ref_key, "title": "qa-" + name, "kind": "video"}]})
        assert s2 == 200 and b2.get("count") == 1, f"tg import failed: {s2} {b2}"
        iid = b2["ids"][0]
        con.execute("UPDATE media_item SET file_path=?, size=? WHERE id=?", (os.path.abspath(p), size, iid))
        con.commit()
        return iid, p
    finally:
        con.close()


if not QA_DB:
    note("A3/A6 前置", "未给 ORIG_TG_DB，跳过需要写库造字节的 tg 用例")
else:
    # A6 正向对照：tg + 可解析 ref + 真实字节
    forged_ok = forge_tg_item("-1001234567890:1", 512, "qa-tg-ok.mp4")
    if forged_ok:
        ok_id, ok_path = forged_ok
        s, b = req("DELETE", f"/api/media/items/{ok_id}")
        check(
            "A6 ★ 正向对照：tg + 可解析 ref + 目录内字节 → 200 + removed:1 + bytesRemoved:true + 字节真的没了",
            s == 200 and b.get("removed") == 1 and b.get("bytesRemoved") is True and not os.path.exists(ok_path),
            f"status={s} body={b} file_exists={os.path.exists(ok_path)}",
        )

    # A3 ★ 顺序取证：tg + 不可解析 ref + 真实字节
    forged_bad = forge_tg_item("not-a-tg-ref", 777, "qa-tg-bad.mp4")
    if forged_bad:
        bad_id, bad_path = forged_bad
        before = os.path.getsize(bad_path)
        s, b = req("DELETE", f"/api/media/items/{bad_id}")
        print(f"  [raw] status={s} body={json.dumps(b, ensure_ascii=False)}")
        check("A3a 清 TG 标记失败 → 500", s == 500, f"status={s}")
        check(
            "A3b 500 文案点明是 downloaded flag 清不掉",
            isinstance(b, dict) and "downloaded flag" in str(b.get("error", "")),
            f"{b}",
        )
        check("A3c ★ 契约：条目仍在（没被偷偷删掉）", req("GET", f"/api/media/items/{bad_id}")[0] == 200)
        still = os.path.exists(bad_path)
        check(
            "A3d ★ 取证：500 自称『nothing was deleted』时字节是否真的还在",
            still,
            f"file_exists={still} size_before={before} "
            + ("→ 与文案一致" if still else "→ ★ 字节已被删，但响应自称没删东西（话术与实际背离）"),
        )
        log = logs()
        check("A3e 留痕 cannot parse tg ref", "cannot parse tg ref" in log,
              ([ln for ln in log.splitlines() if "cannot parse tg ref" in ln][:1] or ["<none>"])[0][:200])
        s2, b2 = req("DELETE", f"/api/media/items/{bad_id}")
        check("A4 500 后可重入：仍 500，条目仍在", s2 == 500 and req("GET", f"/api/media/items/{bad_id}")[0] == 200, f"status={s2}")

# A5 对照组：非 tg 来源 + 同样的垃圾 ref → 必须能删
local_ref = import_item(source="local", **{"ref": "not-a-tg-ref"}, path=write_file(j(os.path.join(DL, "qa-local-ref.mp4")), 128), title="qa-local-ref", kind="video")
s, b = req("DELETE", f"/api/media/items/{local_ref}")
check(
    "A5 ★ 对照：非 tg 来源带同样的垃圾 ref 照样删得掉 → 500 归因于 tg 标记",
    s == 200 and b.get("removed") == 1,
    f"status={s} body={b}",
)

# A7 ★ 真失败：独占句柄（CreateFileW share=0），不经由外部进程
print("\n--- A7 独占句柄（CreateFileW share=0）---")
locked_path = write_file(j(os.path.join(DL, "qa-locked.mp4")), 1024)
locked_id = import_item(source="local", path=locked_path, title="qa-locked", kind="video")
GENERIC_READ, FILE_SHARE_NONE, OPEN_EXISTING = 0x80000000, 0, 3
handle = ctypes.windll.kernel32.CreateFileW(locked_path, GENERIC_READ, FILE_SHARE_NONE, None, OPEN_EXISTING, 0x80, None)
locked_ok = handle != ctypes.c_void_p(-1).value
try:
    try:
        os.remove(locked_path)
        lock_effective = False
    except Exception:
        lock_effective = True
    print(f"  [setup] exclusive handle={locked_ok} 本机 os.remove 被挡住={lock_effective}")
    check("A7 前置：独占句柄确实能挡住删除", locked_ok and lock_effective)
    s, b = req("DELETE", f"/api/media/items/{locked_id}")
    print(f"  [raw] status={s} body={json.dumps(b, ensure_ascii=False)}")
    check("A7a ★ 字节删不掉**不中止**（仍 200）", s == 200, f"status={s}")
    check(
        "A7b ★ bytesRemoved:false + bytesError 非空（如实报错）",
        b.get("removed") == 1 and b.get("bytesRemoved") is False and bool(b.get("bytesError")),
        f"body={b}",
    )
    check("A7c ★ 字节确实还在磁盘上（可走 orphan 档回收）", os.path.exists(locked_path))
    check("A7d 条目仍然被删（用户意图优先）", req("GET", f"/api/media/items/{locked_id}")[0] == 404)
    log = logs()
    warn_lines = [ln for ln in log.splitlines() if "remove_file failed" in ln]
    check(
        "A7e WARN 日志含文件路径",
        bool(warn_lines) and "qa-locked.mp4" in warn_lines[0],
        (warn_lines[:1] or ["<none>"])[0][:300],
    )
finally:
    if locked_ok:
        ctypes.windll.kernel32.CloseHandle(handle)

print("\n### QA-only 汇总：PASS=%d FAIL=%d NOTE=%d" % (len(PASS), len(FAIL), len(OBSERVE)))
if FAIL:
    print("!! 失败项：" + "; ".join(FAIL))
for o in OBSERVE:
    print("   note | " + o)
sys.exit(1 if FAIL else 0)
