#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立运行的 verify_http 兼容 Range 服务器（用 verify_http.RangeHandler）。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify_http import RangeHandler, make_random_file  # noqa: E402

import http.server  # noqa: E402
from socketserver import ThreadingTCPServer  # noqa: E402

SIZE = 5 * 1024 * 1024


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, "file.bin")
    make_random_file(path, SIZE)

    class H(RangeHandler):
        pass

    ThreadingTCPServer.allow_reuse_address = True
    srv = ThreadingTCPServer(("127.0.0.1", port), H)
    srv.SIZE = SIZE
    print(f"READY {port} size={SIZE}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
