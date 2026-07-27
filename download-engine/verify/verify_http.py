#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
surge-daemon 自动化验收（纯标准库，无第三方依赖）。

覆盖既定验收门：
  1. 真实 HTTP 下载（Range GET）端到端跑通；
  2. 下载目录三层解析：不传 output_path 时落「配置 download_dir」
     （本脚本通过 SURGE_DOWNLOAD_DIR 注入，验证规则 2）；
  3. 显式 output_path 覆盖生效（规则 1）；
  4. 完成文件 size 与 sha256 与源完全一致（校验正确性）。

用法：
  python3 verify_http.py --daemon target/debug/surge-daemon [--port 9876] [--token xxx]
"""
import argparse
import hashlib
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from socketserver import ThreadingTCPServer

EXPECTED_SIZE = 5 * 1024 * 1024  # 5 MiB


def compute_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def make_random_file(path: str, size: int) -> str:
    """生成确定性的随机文件（用 sha256 自身派生，便于复现），返回 sha256。"""
    h = hashlib.sha256()
    with open(path, "wb") as f:
        written = 0
        seed = b"surge-verify-seed"
        while written < size:
            block = hashlib.sha256(seed + written.to_bytes(8, "big")).digest() * (1 << 10)
            take = min(len(block), size - written)
            f.write(block[:take])
            h.update(block[:take])
            written += take
    return h.hexdigest()


class RangeHandler(http.server.BaseHTTPRequestHandler):
    def _serve(self, want_head: bool):
        if self.path.split("?")[0] not in ("/file.bin", "/"):
            self.send_error(404)
            return
        fp = self.server.file_path
        size = os.path.getsize(fp)
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            spec = rng[len("bytes=") :]
            start_s, end_s = spec.split("-")
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            with open(fp, "rb") as f:
                f.seek(start)
                data = f.read(end - start + 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(len(data)))
        else:
            with open(fp, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        if not want_head:
            self.wfile.write(data)

    def do_GET(self):
        self._serve(False)

    def do_HEAD(self):
        self._serve(True)

    def log_message(self, *a):
        pass


def start_server(file_path: str):
    httpd = ThreadingTCPServer(("127.0.0.1", 0), RangeHandler)
    httpd.file_path = file_path
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


def api_call(method: str, url: str, body=None, token=None, timeout=10):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def wait_completed(base: str, tid: str, token, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, js = api_call("GET", f"{base}/api/downloads/{tid}", token=token)
        if st == 200 and js.get("status") == "completed":
            return True, js
        if st == 200 and js.get("status") == "error":
            return False, js
        time.sleep(0.3)
    return False, None


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daemon", default="target/debug/surge-daemon")
    ap.add_argument("--port", type=int, default=9876)
    ap.add_argument("--token", default=None)
    args = ap.parse_args()

    if not os.path.exists(args.daemon):
        fail(f"daemon binary not found: {args.daemon} (run `cargo build` first)")

    work = tempfile.mkdtemp(prefix="surge_verify_")
    try:
        # 源文件 + 期望 hash
        src = os.path.join(work, "src.bin")
        expected_hash = make_random_file(src, EXPECTED_SIZE)
        httpd, sport = start_server(src)
        url = f"http://127.0.0.1:{sport}/file.bin"

        # 配置下载目录（三层解析规则 2）
        cfg_dir = os.path.join(work, "cfg_dir")
        os.makedirs(cfg_dir, exist_ok=True)

        env = dict(os.environ)
        env["SURGE_DOWNLOAD_DIR"] = cfg_dir
        env["PORT"] = str(args.port)

        print(f"== start daemon (download_dir={cfg_dir}, port={args.port}) ==")
        proc = subprocess.Popen([args.daemon], env=env)
        base = f"http://127.0.0.1:{args.port}"

        # 等 /health
        for _ in range(50):
            st, _ = api_call("GET", f"{base}/health", token=args.token)
            if st == 200:
                break
            time.sleep(0.2)
        else:
            proc.terminate()
            fail("daemon /health not ready")

        # ---- 测试 A：不传 output_path → 落配置目录 ----
        st, js = api_call("POST", f"{base}/api/downloads",
                          {"url": url}, token=args.token)
        if st != 201 or "id" not in js:
            proc.terminate()
            fail(f"add download failed: {st} {js}")
        tid = js["id"]
        ok, status = wait_completed(base, tid, args.token)
        if not ok:
            proc.terminate()
            fail(f"download not completed: {status}")
        out_a = os.path.join(cfg_dir, "file.bin")
        if not os.path.exists(out_a):
            proc.terminate()
            fail(f"file not in configured dir: {out_a}")
        if os.path.getsize(out_a) != EXPECTED_SIZE:
            proc.terminate()
            fail(f"size mismatch: {os.path.getsize(out_a)} != {EXPECTED_SIZE}")
        if compute_sha256(out_a) != expected_hash:
            proc.terminate()
            fail("sha256 mismatch (configured dir path)")
        print(f"PASS A: 默认目录解析 + size + sha256 一致  ({out_a})")

        # ---- 测试 B：显式 output_path（目录）覆盖配置目录 ----
        # orig-hub 契约：output_path 即「下载目录」，文件名取自 URL；
        # daemon 拼为 dir/filename（与 Go 侧 OutputDir + UrlFilename 一致）。
        override_dir = os.path.join(work, "override")
        st, js = api_call("POST", f"{base}/api/downloads",
                          {"url": url, "output_path": override_dir}, token=args.token)
        if st != 201 or "id" not in js:
            proc.terminate()
            fail(f"add download (override) failed: {st} {js}")
        tid2 = js["id"]
        ok2, _ = wait_completed(base, tid2, args.token)
        if not ok2:
            proc.terminate()
            fail("download (override) not completed")
        out_b = os.path.join(override_dir, "file.bin")
        if not os.path.exists(out_b):
            proc.terminate()
            fail(f"file not at output_path dir/filename: {out_b}")
        if compute_sha256(out_b) != expected_hash:
            proc.terminate()
            fail("sha256 mismatch (override dir)")
        print(f"PASS B: 显式 output_path 目录覆盖生效 + sha256 一致  ({out_b})")

        # ---- 清理 ----
        api_call("DELETE", f"{base}/api/downloads/{tid}", token=args.token)
        api_call("DELETE", f"{base}/api/downloads/{tid2}", token=args.token)
        proc.terminate()
        print("ALL PASS")
    finally:
        pass


if __name__ == "__main__":
    main()
