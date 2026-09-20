#!/usr/bin/env python3
"""提交信息门禁 · 范围版（CI 用）。

本地 `.git/hooks/commit-msg` 只能拦单条、且可以被 `--no-verify` 绕过；
CI 是对**已落地提交**的最后一道闸，按范围复验 `AGENTS.md` §2 的两条硬规：

  1. 提交信息一律**英文**（subject 与 body 都不得含 CJK）—— 与 EE 规约对齐；
  2. `fix` 类提交必须引用 `BUG-<三位编号>`，让「修了什么」可追溯到登记册。

用法：
  python scripts/check-commit-msgs.py                 # 默认 origin/main..HEAD
  python scripts/check-commit-msgs.py BASE..HEAD      # 指定范围
  python scripts/check-commit-msgs.py --all           # 全历史（审计用，退出码仍非零表示有违规）

设计取舍：
- 扫 **全文 `%B`**（subject + body + trailer），只看 `%s` 会假阴性（历史教训）；
- `Merge` / `Revert` 提交跳过（机器生成，不代表作者措辞）；
- 审计历史用 `--all` 时只统计不阻断（退出码 0），便于把它挂进报告而不让 CI 永远红。
"""

from __future__ import annotations

import re
import subprocess
import sys

# CJK 统一表意文字 + 中日韩标点 + 全角符号：出现即判「非英文」。
CJK = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")
BUG_REF = re.compile(r"BUG-\d{3}")
FIX_SUBJECT = re.compile(r"^fix(\(|!|:|\s)", re.IGNORECASE)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
    ).stdout


def commits_in_range(rng: str) -> list[tuple[str, str, str]]:
    """返回 [(sha, subject, full_message)]。"""
    out = git("log", "--format=%H%x1f%s%x1f%B%x1e", rng)
    items: list[tuple[str, str, str]] = []
    for chunk in out.split("\x1e"):
        chunk = chunk.strip("\n")
        if not chunk:
            continue
        parts = chunk.split("\x1f")
        if len(parts) < 3:
            continue
        sha, subject, body = parts[0].strip(), parts[1].strip(), parts[2]
        items.append((sha, subject, body))
    return items


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    audit = "--all" in sys.argv

    if args:
        rng = args[0]
    elif audit:
        # 审计模式（无范围可算时用）：最近 50 条，只看趋势不阻断。
        rng = "-n 50"
    else:
        rng = "origin/main..HEAD"
        if subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", "origin/main"],
            capture_output=True,
        ).returncode != 0:
            print("check-commit-msgs: 无 origin/main（浅克隆/新仓库），退化为最近 50 条。")
            rng = "-n 50"

    commits = commits_in_range(rng)
    if not commits:
        print(f"check-commit-msgs: 范围内无提交（{rng}），跳过。")
        return 0

    errors: list[str] = []
    for sha, subject, body in commits:
        short = sha[:8]
        if re.match(r"^(Merge|Revert)\b", subject):
            continue
        # 全文（含 body）判定，避免只看 subject 的假阴性
        hit = CJK.search(body)
        if hit:
            snippet = body[max(0, hit.start() - 20) : hit.start() + 20].replace("\n", " ")
            errors.append(f"{short}: 提交信息含中文/全角字符 → …{snippet}…  （{subject}）")
        if FIX_SUBJECT.match(subject) and not BUG_REF.search(body):
            errors.append(f"{short}: `fix` 提交未引用 BUG-<编号> → {subject}")

    if errors:
        print(f"check-commit-msgs: {len(errors)} 项违规 / 共 {len(commits)} 条提交（{rng}）")
        for e in errors:
            print("  ERROR " + e)
        return 0 if audit else 1

    print(f"check-commit-msgs: OK - {len(commits)} 条提交全部合规（{rng}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
