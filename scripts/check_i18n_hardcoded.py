#!/usr/bin/env python3
"""门禁：扫描前端源码里「非注释行」的硬编码中文字面量。

用途（BUG-141）：
- 盘点 `tauri-shell/src` 里仍绕开 i18n 通道、直接写中文的 UI 文案；
- 作为回归门禁：硬编码中文行数超过阈值即失败，防止「修了又长回来」。

判据（防止误报）：
1. 先剥离块注释 /* ... */ 与行注释 // ...（保护 http:// https:// 里的 //）；
2. 不扫描 i18n 词典本身（i18n/locales/*.json 的中文是翻译值，不是缺陷）；
3. 不扫描测试 / 夹具 / 脚本（**/*.test.*、**/*.spec.*、__tests__、verify、scripts）；
4. 仅匹配中文字符（CJK 统一表意 \u4e00-\u9fff + 常用扩展），落在非注释行即计数。

用法：
  python scripts/check_i18n_hardcoded.py            # 打印每文件计数 + 总数（不判失败）
  python scripts/check_i18n_hardcoded.py --max N    # 总数 > N 时 exit 1（门禁模式）
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tauri-shell", "src")

# CJK 统一表意 + 扩展 A + 兼容表意（非 raw 字符串，确保 \u 转义被解释）
CJK = re.compile("[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")

# 保护 http(s):// 里的 //
URL_RE = re.compile(r"https?://[^\s\"'`)]*")

# 块注释
BLOCK_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
# 行注释（在剥离块注释之后做，避免 /* 里的 // 干扰）；暂不处理字符串内的 //
LINE_RE = re.compile(r"//[^\n]*")


def strip_comments(text: str) -> str:
    # 1. 保护 URL（把 // 段换成占位，避免被当成行注释）
    urls = []

    def _keep(m):
        urls.append(m.group(0))
        return f"\x00URL{len(urls) - 1}\x00"

    text = URL_RE.sub(_keep, text)
    # 2. 剥块注释
    text = BLOCK_RE.sub("", text)
    # 3. 剥行注释
    text = LINE_RE.sub("", text)
    # 4. 还原 URL（URL 里不会有中文，还原不影响计数）
    for i, u in enumerate(urls):
        text = text.replace(f"\x00URL{i}\x00", u)
    return text


def scan_file(path: str):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    cleaned = strip_comments(raw)
    lines = cleaned.split("\n")
    hits = []
    for idx, line in enumerate(lines, 1):
        if CJK.search(line):
            hits.append((idx, line.strip()))
    return hits


def iter_targets():
    for dirpath, dirnames, filenames in os.walk(SRC):
        # 排除词典 / 测试 / 夹具 / 脚本
        rel = os.path.relpath(dirpath, SRC)
        parts = rel.split(os.sep)
        if "i18n" in parts or "__tests__" in parts or "verify" in parts:
            dirnames[:] = []
            continue
        # 排除隐藏目录（.git / .vscode 等）；根目录 relpath 是 "."，不能据此剪枝
        if rel != "." and any(p.startswith(".") for p in parts):
            dirnames[:] = []
            continue
        for fn in filenames:
            if not (fn.endswith(".ts") or fn.endswith(".tsx")):
                continue
            if fn.endswith(".d.ts"):
                continue
            if ".test." in fn or ".spec." in fn:
                continue
            if dirpath.endswith("scripts") or "scripts" in parts:
                continue
            yield os.path.join(dirpath, fn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=None, help="门禁阈值：总数 > N 则 exit 1")
    ap.add_argument("--verbose", action="store_true", help="打印命中的行")
    args = ap.parse_args()

    counts = {}
    total = 0
    for path in sorted(iter_targets()):
        hits = scan_file(path)
        if hits:
            counts[path] = hits
            total += len(hits)

    # 打印
    print(f"== 硬编码中文扫描（非注释行）== 共 {total} 行，命中 {len(counts)} 个文件")
    for path in sorted(counts):
        hits = counts[path]
        rel = os.path.relpath(path, ROOT)
        print(f"  {len(hits):3d}  {rel}")
        if args.verbose:
            for ln, txt in hits:
                # 截断过长的行
                t = txt if len(txt) <= 120 else txt[:117] + "..."
                print(f"        L{ln}: {t}")

    if args.max is not None:
        if total > args.max:
            print(f"\n[FAIL] 硬编码中文行数 {total} > 阈值 {args.max}")
            sys.exit(1)
        else:
            print(f"\n[OK] 硬编码中文行数 {total} <= 阈值 {args.max}")
            sys.exit(0)


if __name__ == "__main__":
    main()
