"""BUG-135 / BUG-136 验收（engine 侧，跑在**隔离**的 orig-tg mock 实例上）。

AGENTS.md §6：入库的验收脚本归 `download-engine/verify/`；产物（DB / 日志）落
`verify_shots/`（ignored）。本脚本**不含任何机器绝对路径** —— 端口、库名、目录
全部由环境变量传入，换台机器照跑。

## 隔离实例参数（由拉起方提供，缺一即无意义）

| 变量 | 用途 | 为什么必须独立 |
|---|---|---|
| `ORIG_TG_BASE` | 实例地址，如 `http://127.0.0.1:9879` | 真实实例在 9877；本脚本会**真的删文件**，指向它等于删用户数据（BUG-023 教训） |
| `ORIG_TG_DB` | SQLite 库路径（拉起方给 orig-tg 的入参） | 复用固定库会让上一轮条目污染计数断言 |
| `ORIG_TG_SESSION` | 会话文件路径 | 同上 |
| `ORIG_TG_DOWNLOAD_DIR` | 下载目录（= 缓存唯一可删区） | 决定 `inside_dir` 判定 |
| `ORIG_TG_EXTERNAL_DIR` | **下载目录之外**的目录 | 造「外部文件」用例；在下载目录内就测不出 `external` |
| `ORIG_TG_MOCK=1` | 显式选中合成客户端 | 合成实现只在 `--features mock` 构建里，且必须显式开关 |

拉取参照（runner 示例，`verify_shots/` 下，不入库）：

    CARGO_TARGET_DIR=target-mock cargo build -p orig-tg --release --features mock
    ORIG_TG_PORT=9879 ORIG_TG_DB=$TMP/store-<epoch>.db ORIG_TG_SESSION=$TMP/s.session \
    ORIG_TG_DOWNLOAD_DIR=$TMP/downloads ORIG_TG_MOCK=1 \
      target-mock/release/orig-tg.exe >$TMP/server.log 2>&1 &

## 覆盖

BUG-135 `DELETE /api/media/items/:id`
  1. 正常删除：200 + `removed:1` + `bytesRemoved:true` + 无 `bytesError` + 文件真的没了
  2. 幂等重删：200 + `removed:0`
  3. **反向证伪（字节删不掉）**：文件被占用 → 仍 200（不中止）+ `bytesRemoved:false`
     + `bytesError` 非空 + 条目已删 + 字节仍在磁盘 + 服务端 WARN 日志（含路径与原因）
  4. **反向证伪（TG 标记清不掉）**：`source=tg` 且 ref 不可解析 → **500**（中止删除）
     + 条目仍在（没被偷偷删掉）
  5. 对照：可解析的 tg ref → 不被中止（证明 4 的 500 是失败导致，不是「tg 一律拒删」）

BUG-136 `GET /api/cache/stats`
  6. `external` 是**对象**（count/bytes/removable），不再是数字
  7. `external.bytes` 真的累加了外部文件字节（与磁盘实占逐字一致）
  8. 与 `GET /api/cache/clear/preview` 的 `external` **同形状且同值**
  9. `bytes` 的既有含义不变（仍只含下载目录内、由条目背书的可清字节）

用法：
  ORIG_TG_BASE=http://127.0.0.1:9879 \
  ORIG_TG_DOWNLOAD_DIR=<隔离下载目录> \
  ORIG_TG_EXTERNAL_DIR=<隔离外部目录> \
  python download-engine/verify/verify_bug_135_136.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("ORIG_TG_BASE", "http://127.0.0.1:9879")
DL = os.environ.get("ORIG_TG_DOWNLOAD_DIR", "")
EXT = os.environ.get("ORIG_TG_EXTERNAL_DIR", "")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))
    return cond


def req(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def logs(lines=300):
    """`/api/tg/logs` 返回 `Vec<String>`（新→旧），直接序列化成 JSON 数组。"""
    s, b = req("GET", f"/api/tg/logs?lines={lines}")
    assert s == 200, f"logs failed: {s} {b}"
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
    assert s == 200, f"import failed: {s} {b}"
    assert b.get("count") == 1, f"import count != 1: {b}"
    return b["ids"][0]


if not DL or not EXT:
    sys.exit("!! 需要 ORIG_TG_DOWNLOAD_DIR 与 ORIG_TG_EXTERNAL_DIR")
if os.path.abspath(DL) == os.path.abspath(EXT) or os.path.abspath(EXT).startswith(
    os.path.abspath(DL) + os.sep
):
    sys.exit("!! ORIG_TG_EXTERNAL_DIR 必须在下载目录之外，否则造不出 external 用例")

# ─────────────────────────── BUG-136：external 形状与口径 ───────────────────────────
print("\n### BUG-136 GET /api/cache/stats —— external 归一为对象且累加字节")

ext_path = write_file(os.path.join(EXT, "outside-lib.mp4").replace("\\", "/"), 4096)
in_path = write_file(os.path.join(DL, "inside-cache.mp4").replace("\\", "/"), 2048)
ext_id = import_item(source="local", path=ext_path, title="outside-lib", kind="video")
in_id = import_item(source="local", path=in_path, title="inside-cache", kind="video")

s, st = req("GET", "/api/cache/stats")
check("6a stats 200", s == 200, f"status={s} body={st}")
ext = (st or {}).get("external")
check(
    "6b stats.external 是对象（不再是数字）",
    isinstance(ext, dict),
    f"type={type(ext).__name__} value={ext}",
)
check(
    "6c external 形状与 preview 一致（count/bytes/removable）",
    isinstance(ext, dict) and set(ext) == {"count", "bytes", "removable"},
    f"keys={sorted(ext) if isinstance(ext, dict) else ext}",
)
check(
    "6d external.removable 恒 false",
    isinstance(ext, dict) and ext.get("removable") is False,
    f"removable={ext.get('removable') if isinstance(ext, dict) else ext}",
)
check(
    "7a external.bytes 真的累加了外部文件字节（与磁盘实占逐字一致）",
    isinstance(ext, dict) and ext.get("bytes") == 4096,
    f"external={ext} on_disk={os.path.getsize(ext_path)}",
)
check(
    "7b external.count 计入该外部条目",
    isinstance(ext, dict) and ext.get("count") == 1,
    f"external={ext}",
)
check(
    "9a bytes 含义不变：只含下载目录内的可清字节",
    st.get("bytes") == 2048 and st.get("files") == 1,
    f"files={st.get('files')} bytes={st.get('bytes')}",
)

s2, pv = req("GET", "/api/cache/clear/preview")
check("8a preview 200", s2 == 200, f"status={s2}")
pext = (pv or {}).get("external")
check(
    "8b 两接口 external 同形状",
    isinstance(pext, dict) and set(pext) == {"count", "bytes", "removable"},
    f"preview.external={pext}",
)
check(
    "8c 两接口 external 同值（count 与 bytes 逐字相等）",
    isinstance(ext, dict)
    and isinstance(pext, dict)
    and ext.get("count") == pext.get("count")
    and ext.get("bytes") == pext.get("bytes"),
    f"stats={ext} preview={pext}",
)
check(
    "9b preview 的 total.bytes 与 stats.bytes 一致（本次未改 bytes 口径）",
    (pv or {}).get("total", {}).get("bytes") == st.get("bytes"),
    f"preview.total={pv.get('total')} stats.bytes={st.get('bytes')}",
)

# ─────────────────────────── BUG-135：删条目不再静默吞失败 ───────────────────────────
print("\n### BUG-135 DELETE /api/media/items/:id —— 失败不再被吞")

# 1. 正常删除（字节在下载目录内）
s, b = req("DELETE", f"/api/media/items/{in_id}")
check("1a 正常删除 200", s == 200, f"status={s} body={b}")
check(
    "1b removed:1 且 bytesRemoved:true 且不带 bytesError",
    b.get("removed") == 1 and b.get("bytesRemoved") is True and "bytesError" not in b,
    f"body={b}",
)
check("1c 字节真的被删（文件不在磁盘上）", not os.path.exists(in_path), f"path={in_path}")
s3, _ = req("GET", f"/api/media/items/{in_id}")
check("1d 条目真的被删（GET 404）", s3 == 404, f"status={s3}")

# 2. 幂等重删
s, b = req("DELETE", f"/api/media/items/{in_id}")
check(
    "2 幂等重删：200 + removed:0",
    s == 200 and b.get("removed") == 0,
    f"status={s} body={b}",
)

# 3. 反向证伪：字节删不掉（文件被本进程占用 → Windows 上 unlink 必然失败）
locked_path = write_file(os.path.join(DL, "locked.mp4").replace("\\", "/"), 1024)
locked_id = import_item(source="local", path=locked_path, title="locked", kind="video")
holder = open(locked_path, "rb")
try:
    s, b = req("DELETE", f"/api/media/items/{locked_id}")
    check("3a 字节删失败**不中止**条目删除（仍 200）", s == 200, f"status={s} body={b}")
    check(
        "3b bytesRemoved:false + bytesError 非空（如实报错，不再恒 true）",
        b.get("removed") == 1
        and b.get("bytesRemoved") is False
        and isinstance(b.get("bytesError"), str)
        and len(b["bytesError"]) > 0,
        f"body={b}",
    )
    check("3c 字节确实还在磁盘上（残留可走 orphan 档回收）", os.path.exists(locked_path))
    s4, _ = req("GET", f"/api/media/items/{locked_id}")
    check("3d 条目仍被删掉（用户意图优先）", s4 == 404, f"status={s4}")
finally:
    holder.close()

log = logs()
check(
    "3e 服务端留痕：WARN 日志含文件路径与 io 原因",
    "remove_file failed" in log and "locked.mp4" in log,
    "log hit="
    + (
        [ln for ln in log.splitlines() if "remove_file failed" in ln][:1]
        or ["<none>"]
    )[0][:200],
)
check(
    "3f 日志点明残留字节的回收通道（orphan 档）",
    "scope=orphan" in log,
    "log hit=" + ([ln for ln in log.splitlines() if "scope=orphan" in ln][:1] or ["<none>"])[0][:200],
)

# 4. 反向证伪：TG downloaded 标记清不掉 → 中止并 500
# 注意：TG 引用的 JSON 字段名是 `ref`（`ImportItem::tg_ref` 带 `#[serde(rename = "ref)]`）。
bad_id = import_item(source="tg", **{"ref": "not-a-tg-ref"}, title="bad-ref", kind="video")
s, b = req("DELETE", f"/api/media/items/{bad_id}")
check(
    "4a 清 TG 标记失败 → **真报错**（500，不是恒 200）",
    s == 500,
    f"status={s} body={b}",
)
check(
    "4b 500 响应带明确错误原因",
    isinstance(b, dict) and isinstance(b.get("error"), str) and "downloaded flag" in b["error"],
    f"body={b}",
)
s5, _ = req("GET", f"/api/media/items/{bad_id}")
check("4c 中止生效：条目仍在（没被偷偷删掉）", s5 == 200, f"status={s5}")
log = logs()
check(
    "4d 服务端留痕：cannot parse tg ref",
    "cannot parse tg ref" in log,
    "log hit=" + ([ln for ln in log.splitlines() if "cannot parse tg ref" in ln][:1] or ["<none>"])[0][:200],
)

# 5. 对照：可解析的 tg ref 不被中止
ok_id = import_item(
    source="tg", **{"ref": "-1001234567890:1"}, title="good-ref", kind="video"
)
s, b = req("DELETE", f"/api/media/items/{ok_id}")
check(
    "5 对照：可解析 tg ref → 不被中止（200 + removed:1）",
    s == 200 and b.get("removed") == 1,
    f"status={s} body={b}",
)

print(f"\n### 汇总：PASS={len(PASS)} FAIL={len(FAIL)}")
if FAIL:
    print("!! 失败项：" + "; ".join(FAIL))
sys.exit(1 if FAIL else 0)
