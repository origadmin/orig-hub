#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""决策项门禁：让「不可拍板的决策」不可交付。

为什么需要它：2026-09-22 的决策清单**形式合规**（每条都有背景/建议/后果），
但实测 6/6 条的「选项列举」为 0 —— 只给了单一建议。决策人的反馈是
「让我无逻辑性猜测、随机决策、结果完全不可预测、开发脱离核心设计」。

根因不是「写得不够多」，而是**规格里没要求列举选项**，于是「给出建议」被当成了
「给出选择」。这两件事完全不同：建议是替你决定，选择是让你决定。

本门禁强制的不变量（规格见 docs/rules/decision-spec.md 第一节）：
  1. 每个决策项必须有 `请求:`（一句可回答的话）；
  2. 必须有 `设计锚点:`，且指向 docs/ 下的真实文件；
  3. 必须有 **≥2 个实质选项**（只给一个选项 = 逼签，不是决策）；
  4. 必须有 **「不做 / 维持现状」选项**，并写明其后果；
  5. 每个选项必须有 `涉及:`（具体路径）、`量化:`、`回归风险:`、`后果:` 四个字段；
  6. **空字段视为字段不存在**（`涉及: ` 后无内容 → FAIL）。

容忍策略：历史文档（本门禁生效前）只告警，不阻断 —— 规则从升级点起生效，
事后补写的「选项」本身就是伪造（同 check-bugs 的 RULE_FROM 思路）。

用法：python scripts/check-decisions.py [--quiet] [--all]
  --all: 也检查历史文档（默认只对 RULE_FROM 之后的检查清单强制）
退出码：0 通过；1 有违反。
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REVIEW = os.path.join(ROOT, "docs", "review")

# 规则生效点：此日期（含）之后的决策清单强制。之前的只告警。
RULE_FROM = "2026-09-23"

DECISION_RE = re.compile(r"^###\s+(D\d+)\.\s*(.+?)\s*$", re.M)
OPTION_RE = re.compile(r"^\*\*([A-Z])\.\s*(.+?)\*\*\s*$", re.M)
NOTHING_RE = re.compile(r"不做|维持现状|不做（|不拍板")

# 「不做」选项的**实质**判据（不能只看标签里有没有那几个字）。
# 实测踩到的假绿：选项 B 叫「续编两集（维持现状的显式选择）」—— 标签里有「维持现状」，
# 于是 NOTHING_RE 命中、门禁放行，可它**是要改代码的实质量选项**（只是不采纳 A），
# 该决策实际上**没有「不做」选项**。仅凭标签判定 = 让措辞骗过门禁。
#
# 故「不做」必须同时满足：① 标签命中 NOTHING_RE；② `涉及:` 表示**无仓内改动**。
# ② 用「排除法」而非白名单：只要 `涉及:` 里出现仓内路径（含 `/` 且含扩展名），
# 它就不是「不做」—— 因为「涉及具体文件」本身就意味着要动东西。
CHANGE_PATH_RE = re.compile(r"`[^`]*[/\\][^`]*`")


def _option_is_noop(name: str, obody: str) -> bool:
    """判定某选项是否真的是「不做 / 维持现状」。"""
    if not NOTHING_RE.search(name):
        return False
    line = field_line(obody, "涉及")
    if line is None:
        return False
    body = strip_comment(line)
    # `涉及: 无` / `涉及: 0` / `涉及: 无（推后）` → 视为不动代码
    if CHANGE_PATH_RE.search(body):
        return False
    return body.startswith("无") or body.startswith("0") or body.startswith("不")

FIELD_PREFIXES = {
    "问题": ["问题"],
    "现状与代价": ["现状与代价", "现状", "代价"],
    "设计锚点": ["设计锚点"],
    "请求": ["请求"],
}
OPTION_FIELDS = ["涉及", "量化", "回归风险", "后果"]

# 字段名后允许**半角或全角**冒号。中文文档里天然会写全角 `：`，
# 只认半角会让每个字段都「找不到」—— 实测踩到：门禁对 3 个选项 × 4 个字段
# 全报「缺字段」（14 项虚警），真因只是冒号字符不匹配。
# 教训（与 check-bugs.py 的 `档位` 未被 FIELD_RE 收录**同源**）：
# **凡按字符串前缀找字段，就必须把「分隔符的全/半角」当成同一件事处理。**
SEP = r"[:：]"

errors: list[str] = []
warnings: list[str] = []
QUIET = "--quiet" in sys.argv[1:]
CHECK_ALL = "--all" in sys.argv[1:]


def err(m: str) -> None:
    errors.append(m)
    if not QUIET:
        print(f"err   {m}", flush=True)


def warn(m: str) -> None:
    warnings.append(m)
    if not QUIET:
        print(f"warn  {m}", flush=True)


def read_text(p: str) -> str:
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def field_line(body: str, name: str) -> str | None:
    """在正文里找 `- <name>[:：] ...` 这一行（名字后允许半角或全角冒号）。"""
    pat = re.compile(r"^\s*[-*]*\s*\*{0,2}" + re.escape(name) + r"\*{0,2}\s*" + SEP)
    for ln in body.splitlines():
        if pat.match(ln):
            return ln
    return None


def strip_comment(line: str) -> str:
    """取分隔符之后的内容；`<!-- ... -->` 视为空（模板占位注释不算填写）。"""
    parts = re.split(SEP, line, maxsplit=1)
    body = parts[1] if len(parts) > 1 else ""
    body = re.sub(r"<!--.*?-->", "", body)
    return body.strip()


def check_file(path: str) -> tuple[int, int]:
    rel = os.path.relpath(path, ROOT)
    text = read_text(path)
    forced = True
    if not CHECK_ALL:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path))
        if m and m.group(1) < RULE_FROM:
            forced = False

    blocks = DECISION_RE.split(text)
    # blocks: [前言, (id, title), body, (id, title), body, ...]
    items = []
    for i in range(1, len(blocks), 3):
        did, title, body = blocks[i], blocks[i + 1], blocks[i + 2]
        items.append((did, title, body))

    if not items:
        warn(f"{rel}: 未发现 `### D<n>.` 形式的决策项")
        return 0, 0

    for did, title, body in items:
        tag = f"{rel} {did}"
        # ① 请求字段
        req_line = field_line(body, "请求")
        if req_line is None:
            (err if forced else warn)(f"{tag}: 缺 `请求:` —— 决策人不知道该拍哪一句")
        elif not strip_comment(req_line):
            (err if forced else warn)(f"{tag}: `请求:` 为空")

        # ② 设计锚点（并核对路径真实存在）
        anchor_line = field_line(body, "设计锚点")
        if anchor_line is None:
            (err if forced else warn)(f"{tag}: 缺 `设计锚点:` —— 拍完会脱离核心设计")
        else:
            refs = re.findall(r"`(docs/[A-Za-z0-9_./-]+\.md)`", anchor_line)
            if not refs:
                (err if forced else warn)(
                    f"{tag}: `设计锚点:` 未指向 `docs/*.md`（须锚定到具体设计文档）"
                )
            for r in refs:
                if not os.path.exists(os.path.join(ROOT, r)):
                    (err if forced else warn)(f"{tag}: 设计锚点指向不存在的文件 {r}")

        # ③ 选项
        # OPTION_RE 带**两个**捕获组，re.split 返回 [前言, g1, g2, 正文, g1, g2, 正文, ...]，
        # 故步长为 3、正文在 j+2。
        parts = OPTION_RE.split(body)
        opts = []
        for j in range(1, len(parts), 3):
            if j + 2 >= len(parts):
                break
            opts.append((parts[j], parts[j + 1], parts[j + 2]))
        if len(opts) < 2:
            (err if forced else warn)(
                f"{tag}: 只有 {len(opts)} 个实质选项（须 ≥2）—— 只给一个选项是**逼签**，不是决策"
            )
        has_nothing = any(_option_is_noop(name, obody) for _, name, obody in opts)
        if not has_nothing:
            # 若只是「标签像但实质是改动」，给出精准提示，避免作者误以为已满足。
            label_only = [
                name for _, name, obody in opts
                if NOTHING_RE.search(name) and not _option_is_noop(name, obody)
            ]
            hint = (
                f"（选项 {label_only[0][:24]!r} 标签含该词但 `涉及:` 指向仓内改动，"
                f"是**实质量选项**而非「不做」）" if label_only else ""
            )
            (err if forced else warn)(
                f"{tag}: 缺「不做 / 维持现状」选项 —— 不给它等于把失败成本从决策人身上转移掉{hint}"
            )

        # ④ 每个选项的四个字段
        for letter, name, obody in opts:
            for fld in OPTION_FIELDS:
                line = field_line(obody, fld)
                if line is None:
                    (err if forced else warn)(f"{tag} 选项{letter}: 缺 `{fld}:`")
                elif not strip_comment(line):
                    (err if forced else warn)(
                        f"{tag} 选项{letter}: `{fld}:` 为空（空字段=字段不存在）"
                    )

    return len(items), len(errors)


def main() -> int:
    if not os.path.isdir(REVIEW):
        print(f"check-decisions: SKIP - {os.path.relpath(REVIEW, ROOT)} 不存在")
        return 0

    files = sorted(
        os.path.join(REVIEW, f)
        for f in os.listdir(REVIEW)
        if f.endswith(".md") and ("decision" in f or "待拍板" in f)
    )
    if not files:
        print("check-decisions: SKIP - docs/review/ 下无决策清单文件（*decision*.md）")
        return 0

    total_items = 0
    for p in files:
        n, _ = check_file(p)
        total_items += n

    scope = "全部" if CHECK_ALL else f"{RULE_FROM} 起强制，之前只告警"
    if errors:
        print(f"check-decisions: FAIL - {len(errors)} 项违反（warn {len(warnings)} 项；{scope}）")
        return 1
    print(
        f"check-decisions: OK - {len(files)} 份清单 / {total_items} 条决策，"
        f"选项/请求/锚点齐备（warn {len(warnings)} 项；{scope}）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
