#!/usr/bin/env python3
"""缺陷证据审计 —— 把「fixed 但拿不出可核验证据」变成一张可执行的清单。

## 为什么需要它

用户两次追问同一个问题：「BUG 丢失了，大量这种丢失，且没有跟踪」。上一轮已证明
**没有文件丢失**（421 条登记 = 421 个文件，编号无缺口，`git log --diff-filter=D`
零删除）。真正的洞是**状态说谎**：`- 状态: fixed` 却给不出任何跨机器可复核的
引用，于是「修过了」只是一句话 —— 换台机器、换个人，无从验证。

`check-bugs.py` 把这类文档降级成 warn（178 条 warn 里 50 条是这个），于是真正
该红的信号被淹没在噪声里。本脚本的职责是**把噪声变成清单**：

1. 找出所有 `fixed|closed` 但证据不合格的条目；
2. 从它们的 `## 修复` / `## 验收` 段里抽出实现路径，到 `git ls-files` 里解析；
3. `--apply` 时把解析到的路径补写成 `## 验收证据`（**只补可核验的引用，不重跑
   当年的验收**，措辞如实写明这一点）；
4. 解析不到的条目**不编造**，留在清单里由人处理；有未解决项时退出码 1。

## 用法

    python scripts/audit-bug-evidence.py            # 只报告（默认）
    python scripts/audit-bug-evidence.py --apply    # 补写可解析的条目
    python scripts/audit-bug-evidence.py --check    # CI：有未解决项即 exit 1

## 边界

- 只读 `docs/bugs/`，不碰代码；不删除、不覆盖已有 `## 验收证据` 节。
- 路径解析是**保守**的：宁可报告「解析不到」，也不拿一个不相干的文件凑数。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUGS = ROOT / "docs" / "bugs"

# 状态机里需要证据的两种终态
DONE = {"fixed", "closed"}
# 证据章节：新规约用 `## 验收证据`；老条目常写 `## 验收`
EVIDENCE_HEADINGS = ("## 验收证据", "## 验收")
# 7+ hex 可能是短提交；一律用 `git cat-file -t` 验明正身（内存教训：判真提交必须外层确认）
RE_HASH = re.compile(r"\b[0-9a-f]{7,40}\b")
RE_EXT = re.compile(r"[\w./\\-]+\.(?:rs|ts|tsx|js|cjs|mjs|py|md|json|toml|sh|cmd)\b")
# 修复段里被反引号包住的标识符（组件名 / crate 名 / 文件名）
RE_TICK = re.compile(r"`([^`\n]{3,80})`")


def repo_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    return [line.strip().replace("\\", "/") for line in out.splitlines() if line.strip()]


def parse_doc(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    # 状态字段历史上三种写法都出现过：`- 状态: fixed` / `- **状态**: fixed` /
    # `- **Status**: fixed`，值后面还常跟注释（`fixed（2026-09-18 已验收）`）。
    # 与 check-bugs.py 同口径：取首个 token，遇到全角括号即截断。
    status = ""
    m = re.search(
        r"^\s*[-*]*\s*\*{0,2}(?:状态|Status)\*{0,2}\s*[:：]\s*(.+)$", text, re.M | re.I
    )
    if m:
        status = re.split(r"[\s（(]", m.group(1).strip(), maxsplit=1)[0]
    sections = {}
    for name in ("修复", "验收", "验收证据"):
        sm = re.search(rf"^## {name}\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
        if sm:
            sections[name] = sm.group(1)
    return {"text": text, "status": status, "sections": sections}


def is_commit(sha: str) -> bool:
    """短 hash 只有在本仓库里真是 commit 才算证据（`cat-file -t` 为准）。"""
    r = subprocess.run(
        ["git", "cat-file", "-t", sha], cwd=ROOT, capture_output=True, text=True
    )
    return r.returncode == 0 and r.stdout.strip() == "commit"


def evidence_ok(parsed: dict) -> bool:
    """与 check-bugs.py **同口径**：只认 `## 验收证据` 正文，`## 验收` 不算。

    这条曾经放宽到 `## 验收`，结果 10 条老条目在本脚本里判「合格」、在门禁里
    判「无证据」—— 两套口径各说各话，审计就成了自娱自乐。口径必须只有一套。
    """
    body = parsed["sections"].get("验收证据") or ""
    if not body.strip():
        return False
    for sha in RE_HASH.findall(body):
        if is_commit(sha):
            return True
    for token in RE_EXT.findall(body):
        token = token.replace("\\", "/").lstrip("./")
        if token.startswith(("verify_shots/", "docs/preview/")):
            continue
        if resolve(token):
            return True
    return False


RE_SYMBOL = re.compile(
    r"(?:export\s+(?:async\s+)?function\s+|export\s+const\s+|export\s+class\s+"
    r"|function\s+|pub\s+(?:async\s+)?fn\s+|fn\s+|pub\s+struct\s+|struct\s+"
    r"|pub\s+enum\s+|enum\s+|def\s+|class\s+)([A-Za-z_][A-Za-z0-9_]*)"
)
SYMBOL_EXT = {".rs", ".ts", ".tsx", ".py", ".cjs", ".mjs"}
SYMBOLS: dict[str, set[str]] | None = None


def symbol_index() -> dict[str, set[str]]:
    """标识符 → 定义它的入库文件。

    老条目常常只写组件/函数名（`MediaLibraryPanel`、`cache_one`、
    `import_cached_file`），没有路径。这类引用同样**可核验**，只要它能唯一
    落到一个文件上；同名多处定义一律视为解析不到（不猜）。
    """
    global SYMBOLS
    if SYMBOLS is not None:
        return SYMBOLS
    index: dict[str, set[str]] = {}
    for rel in FILES:
        if Path(rel).suffix not in SYMBOL_EXT:
            continue
        try:
            text = (ROOT / rel).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for name in RE_SYMBOL.findall(text):
            index.setdefault(name, set()).add(rel)
    SYMBOLS = index
    return index


def resolve(token: str) -> list[str]:
    """把一个反引号标识符解析成入库文件（保守：宁可空手）。"""
    token = token.strip().strip("()（）:：,，;；")
    if not token or " " in token:
        return []
    cand = token.replace("\\", "/").lstrip("./")
    if cand in FILES:
        return [cand]
    # 后缀匹配：`orig-daemon/src/routes.rs` → `download-engine/crates/orig-daemon/src/routes.rs`
    suffix = "/" + cand
    hits = [f for f in FILES if f.endswith(suffix)]
    if hits:
        return sorted(hits, key=len)[:2]
    # 带扩展名的裸文件名：只接受唯一命中，否则算解析不到（避免凑数）
    if "/" not in cand and RE_EXT.fullmatch(cand):
        hits = [f for f in FILES if f.endswith("/" + cand)]
        if len(hits) == 1:
            return hits
    # 裸标识符（组件名 / 函数名）：要求全仓唯一定义
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", cand):
        hits = symbol_index().get(cand, set())
        if len(hits) == 1:
            return list(hits)
    return []


def candidates(parsed: dict) -> list[str]:
    """修复/验收段优先；两段都没有可用路径时退回全文（老条目常把落点写在「根因/现象」）。"""
    bodies = [
        parsed["sections"].get("修复", "") + "\n" + parsed["sections"].get("验收", ""),
        parsed["text"],
    ]
    for body in bodies:
        seen, out = set(), []
        for token in RE_TICK.findall(body):
            for path in resolve(token):
                if path not in seen:
                    seen.add(path)
                    out.append(path)
        if out:
            return out
    return []


AUDIT_NOTE = (
    "> 补录说明（2026-10-24 证据审计）：本节只把「修复落在哪些入库文件」变成\n"
    "> **跨机器可核验**的引用；当年的验收脚本/截图未入库，**本轮未重跑**。\n"
    "> 若需重新确认行为，按上面「验收」段描述复跑并补入脚本路径。\n"
)


def build_section(paths: list[str], parsed: dict) -> str:
    lines = ["## 验收证据", "", "实现路径（`git ls-files` 可核验）：", ""]
    lines += [f"- `{p}`" for p in paths]
    lines += ["", AUDIT_NOTE]
    return "\n".join(lines)


def append_section(text: str, section: str) -> str:
    """插到 `## 关联` 之前；没有关联段就追加到文末。"""
    m = re.search(r"^## 关联\s*$", text, re.M)
    if m:
        return text[: m.start()] + section + "\n" + text[m.start() :]
    return text.rstrip() + "\n\n" + section


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="补写可解析的条目")
    ap.add_argument("--check", action="store_true", help="有未解决项即 exit 1")
    args = ap.parse_args()

    global FILES
    FILES = set(repo_files())

    todo, resolved, unresolved, already = [], [], [], []
    for doc in sorted(BUGS.glob("BUG-*.md")):
        parsed = parse_doc(doc)
        if parsed["status"] not in DONE:
            continue
        if evidence_ok(parsed):
            already.append(doc.name)
            continue
        paths = candidates(parsed)
        todo.append(doc.name)
        if paths:
            resolved.append((doc, paths))
        else:
            unresolved.append(doc.name)

    print(f"终态条目：{len(already) + len(todo)}（证据合格 {len(already)} / 待补 {len(todo)}）")
    print(f"  可自动补录：{len(resolved)}")
    for doc, paths in resolved:
        print(f"    {doc} → {', '.join(paths)}")
    print(f"  解析不到实现路径（需人工）：{len(unresolved)}")
    for name in unresolved:
        print(f"    {name}")

    if args.apply:
        changed = 0
        for doc, paths in resolved:
            parsed = parse_doc(doc)
            section = build_section(paths, parsed)
            doc.write_text(append_section(parsed["text"], section), encoding="utf-8", newline="")
            changed += 1
        print(f"\n已补写 {changed} 个文件（`## 验收证据`）")

    if args.check and unresolved:
        print(f"\nFAIL — {len(unresolved)} 条终态缺陷仍无任何可核验证据")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
