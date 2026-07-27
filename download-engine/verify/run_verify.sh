#!/bin/sh
# 构建并运行 surge-daemon 自动化验收。
set -e
cd "$(dirname "$0")/.."   # 切到 download-engine 根目录
echo "== cargo build =="
cargo build
echo "== run acceptance (Range server + default-dir + sha256) =="
python3 verify/verify_http.py --daemon target/debug/surge-daemon
