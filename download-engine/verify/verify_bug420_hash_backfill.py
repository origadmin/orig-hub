#!/usr/bin/env python3
"""BUG-420 验收：存量条目必须能补出内容 hash，且补 hash 不得凭空造出 blob 引用。

用户 2026-10-23 的质问：真实库 596 条里只有 47 条有 `content_hash`
（video 19/377），「是不是 hash 的算法来源不对？」——
结论是**算法没错、覆盖没铺开**：唯一写入点是内容寻址落盘（D24-A / BUG-309），
`blob::hash_file` 承诺的「存量懒纳入」全仓零调用点。本脚本验收补上之后的行为。

## 判据（每条都能反向证伪）

1. **只补真实文件**：文件存在 ⇒ 补上，且 hash 等于 `hashlib.sha256(文件内容)`；
   文件不存在 ⇒ 跳过并计入 `missingFile`，条目保持 NULL（不许伪装成「算过」）。
2. **同内容 ⇒ 同 hash**：两个不同条目指向内容相同的文件，补出来的 hash 必须相等
   （这是 BUG-407/408 归并判据的前提）。
3. **不碰引用计数**：补 hash 之后 `media_blob` 仍是 0 行 —— 字节不在 `.blobs` 下，
   记 refcount 会让「归零即 unlink」指向一个从不存在的路径。
4. **幂等**：连跑两次，第二次 `scanned` 只剩「缺文件」那条、`hashed == 0`。
5. **已有 hash 的不进扫描集**。

## 为什么自带引擎实例

`POST /api/media/hashes/backfill` 会写库。本脚本用 `ORIG_TG_DB` + `ORIG_TG_PORT`
起**隔离实例**，并且把启动自动回填关掉（`ORIG_TG_HASH_BACKFILL_DELAY_SECS=3600`）——
否则后台任务会与手动端点抢同一批条目，断言必然抖。

## 用法

    python download-engine/verify/verify_bug420_hash_backfill.py
    python download-engine/verify/verify_bug420_hash_backfill.py --keep

退出码：0 = 全部 PASS；1 = 有 FAIL（或前置不成立）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
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
PORT = 19798
BASE = f"http://127.0.0.1:{PORT}"

PASS: list[str] = []
FAIL: list[str] = []


def check(ok: bool, name: str, detail: str) -> bool:
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")
    return ok


# 环回必须绕过本机 http_proxy（否则 127.0.0.1 会被代理接管 → 假 000）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(method: str, path: str, timeout: float = 60.0):
    req = urllib.request.Request(BASE + path, method=method)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def port_free(port: int) -> bool:
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def spawn(db: Path, workdir: Path) -> subprocess.Popen:
    env = dict(os.environ)
    env["ORIG_TG_DB"] = str(db).replace("\\", "/")
    env["ORIG_TG_PORT"] = str(PORT)
    # 关掉启动自动回填：本用例只验手动端点，两条路抢同一批条目会让断言抖。
    env["ORIG_TG_HASH_BACKFILL_DELAY_SECS"] = "3600"
    env.pop("ORIG_TG_SESSION", None)
    env["RUST_LOG"] = "warn"
    creationflags = 0x08000000 if os.name == "nt" else 0
    return subprocess.Popen(
        [str(EXE)],
        cwd=str(workdir),
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


def seed_item(db: Path, name: str, file_path: str | None, content_hash: str | None = None) -> int:
    """直写一条最小事实（引擎已建好 schema 之后才能用）。"""
    c = sqlite3.connect(db)
    t = int(time.time())
    cur = c.execute(
        "INSERT INTO media_item (source, ref, title, kind, file_path, poster, size, duration,"
        " added_at, description, source_title, content_hash)"
        " VALUES ('local',?,?,'video',?,NULL,NULL,NULL,?,NULL,?,?)",
        (f"seed:{name}", name, file_path, t, name, content_hash),
    )
    c.commit()
    iid = int(cur.lastrowid)
    c.close()
    return iid


def hash_of(db: Path, item_id: int) -> str | None:
    c = sqlite3.connect(db)
    row = c.execute("SELECT content_hash FROM media_item WHERE id = ?", (item_id,)).fetchone()
    c.close()
    return row[0] if row else None


def blob_rows(db: Path) -> int:
    c = sqlite3.connect(db)
    n = c.execute("SELECT COUNT(*) FROM media_blob").fetchone()[0]
    c.close()
    return int(n)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留临时目录（排查用）")
    args = ap.parse_args()

    if not EXE.is_file():
        print(f"!! 缺少二进制 {EXE}（先跑 scripts/dev/dev_stack.py build-tg）")
        return 1
    if not port_free(PORT):
        print(f"!! 端口 {PORT} 被占用，换端口或先停掉占用进程")
        return 1

    work = Path(tempfile.mkdtemp(prefix="orighub-bug420-"))
    db = work / "store.db"
    files = work / "files"
    files.mkdir()

    # 两个内容相同的真文件 + 一条指向不存在文件的条目 + 一条已有 hash 的条目。
    a = files / "a.mp4"
    b = files / "b-copy.mp4"
    a.write_bytes(b"bug420-payload-" * 1000)
    b.write_bytes(b"bug420-payload-" * 1000)
    gone = files / "gone.mp4"  # 刻意不创建
    expect_hash = hashlib.sha256(a.read_bytes()).hexdigest()

    proc = spawn(db, work)
    try:
        if not wait_health(proc):
            return 1

        ia = seed_item(db, "a", str(a).replace("\\", "/"))
        ib = seed_item(db, "b", str(b).replace("\\", "/"))
        ic = seed_item(db, "c", str(gone).replace("\\", "/"))
        id_preset = seed_item(db, "preset", str(a).replace("\\", "/"), "f" * 64)
        seed_item(db, "nofile", None)  # 从未下载：无路径 ⇒ 不进扫描集

        status, rep = http("POST", "/api/media/hashes/backfill")
        check(status == 200, "端点可用", f"POST /api/media/hashes/backfill -> {status}")
        if not isinstance(rep, dict):
            print(f"!! 响应不是 JSON：{rep!r}")
            return 1

        check(
            rep.get("scanned") == 3,
            "扫描集只含「有路径无 hash」的三条",
            f"scanned={rep.get('scanned')}（期望 3：a/b/c；preset 已有 hash、nofile 无路径都不该进）",
        )
        check(
            rep.get("hashed") == 2,
            "只给真实存在的文件补 hash",
            f"hashed={rep.get('hashed')}（期望 2）",
        )
        check(
            rep.get("missingFile") == 1,
            "缺文件的单独计数、不算失败",
            f"missingFile={rep.get('missingFile')} failed={rep.get('failed')}",
        )

        ha, hb, hc = hash_of(db, ia), hash_of(db, ib), hash_of(db, ic)
        check(ha == expect_hash, "hash 等于文件内容的 SHA-256", f"got={ha} want={expect_hash}")
        check(hb == ha, "同内容 ⇒ 同 hash（归并判据的前提）", f"b={hb} a={ha}")
        check(hc is None, "缺文件的条目保持 NULL", f"c={hc}")
        check(
            hash_of(db, id_preset) == "f" * 64,
            "已有 hash 的条目不被改写",
            f"preset={hash_of(db, id_preset)}",
        )
        check(blob_rows(db) == 0, "补 hash 不产生 media_blob 行", f"media_blob={blob_rows(db)} 行")

        status, cov = http("GET", "/api/media/hashes")
        check(
            status == 200 and cov.get("hashed") == 3 and cov.get("missing") == 1
            and cov.get("noFilePath") == 1,
            "覆盖率体检口径",
            f"{cov}（期望 hashed=3 missing=1 noFilePath=1）",
        )

        status, rep2 = http("POST", "/api/media/hashes/backfill")
        check(
            rep2.get("scanned") == 1 and rep2.get("hashed") == 0,
            "幂等：重跑只剩缺文件那条、零写",
            f"scanned={rep2.get('scanned')} hashed={rep2.get('hashed')}",
        )
        check(blob_rows(db) == 0, "重跑仍不产生 blob 行", f"media_blob={blob_rows(db)} 行")
    finally:
        stop(proc)
        if not args.keep:
            for p in work.rglob("*"):
                try:
                    p.chmod(0o666)
                except OSError:
                    pass
            import shutil

            shutil.rmtree(work, ignore_errors=True)
        else:
            print(f"   临时目录保留：{work}")

    print()
    print(f"PASS {len(PASS)} / FAIL {len(FAIL)}")
    if FAIL:
        for n in FAIL:
            print(f"  FAIL {n}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
