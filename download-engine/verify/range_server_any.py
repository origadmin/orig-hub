#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Range 测试服务器（任意 bind 地址版）：range_server.py 的 0.0.0.0 变体。
用法: python range_server_any.py [port] [bind]
默认: 8899 0.0.0.0 —— 支持多网卡分流测试（127.0.0.1 / 172.26.x.x / 局域网 IP 均可访问）。
"""
import hashlib
import http.server
import sys
import time

SIZE = 10 * 1024 * 1024  # 10 MiB


class H(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Length", str(SIZE))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path not in ("/file.bin", "/", "/slow/file.bin", "/slow/"):
            self.send_error(404)
            return
        rng = self.headers.get("Range")
        slow = "/slow" in self.path
        if rng:
            parts = rng.split("=")[1].split("-")
            start = int(parts[0])
            end = int(parts[1]) if parts[1] else SIZE - 1
            end = min(end, SIZE - 1)
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{SIZE}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            pattern = hashlib.sha256(b"seed" + start.to_bytes(8, "big")).digest() * 4096
            written = 0
            while written < length:
                take = min(len(pattern), length - written)
                self.wfile.write(pattern[:take])
                written += take
                if slow:
                    time.sleep(0.1)
        else:
            self.send_response(200)
            self.send_header("Content-Length", str(SIZE))
            self.end_headers()
            for off in range(0, SIZE, 1 << 20):
                block = hashlib.sha256(b"seed" + off.to_bytes(8, "big")).digest() * 4096
                self.wfile.write(block)
                if slow:
                    time.sleep(0.1)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    bind = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    srv = http.server.ThreadingHTTPServer((bind, port), H)
    print(f"READY on {bind}:{port}", flush=True)
    srv.serve_forever()
