#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""缺陷登记门禁（BUG-067）。

为什么需要它：登记册建了近 60 条，但修复提交里 **19/22 条不带 BUG 编号**，
索引行也不指向提交 —— 于是「某条 bug 到底修没修」「这次修的是哪条」只能靠人肉回忆，
大量缺陷实际上只活在 git 历史里。管理缺失不是靠写得更多，是靠**让缺管理不可表达**。

本门禁强制的不变量：
  1. `docs/bugs/BUG-<n>.md` 编号自 1 起连续，无缺号、无重复；
  2. 文件名集合 == README 索引行集合（双向一致，杜绝「有文件没索引」「有索引没文件」）；
  3. 每个登记文件必须是可解码 UTF-8（防 GBK 乱码入库）且含四个必填字段，取值在枚举内；
  4. 索引行的「状态」列必须与文件内 `- 状态:` 一致（杜绝两处各说各话）；
  5. 状态 fixed/closed 必须有非空的验收章节（RULE_FROM 起强制 `## 验收证据`）；
  6. 验收章节里引用到的**入库路径**（被 git 跟踪）必须真实存在；被 `.gitignore` 忽略的
     **本地证据**（`verify_shots/`、`docs/preview/` 等）「存在就核、缺失只汇总告警」——
     判错会让 CI 恒红，门禁就沦为噪音；
  7. 验收章节里出现的 git 提交短 hash 必须真实存在于本仓库（杜绝编造提交）；
  8. 终态（fixed/closed）必须带至少一条**跨机器可核验**的引用（入库路径或真实提交 hash）——
     只有 `verify_shots/` 引用时，换台机器（CI / 同事）根本无从复核，等于没有证据。
     RULE_FROM 起强制，历史只告警。

历史期的旧登记不追加强制章节（RULE_FROM 之前只告警），因为事后补写的「证据」
本身就是伪造 —— 规则从升级点起生效，历史如实标注。

用法：python scripts/check-bugs.py [--quiet]
退出码：0 通过；1 有违反。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUGS = os.path.join(ROOT, "docs", "bugs")
README = os.path.join(BUGS, "README.md")

# 规则升级点：>= 该编号的登记必须带 `## 验收证据` 节，且证据必须可核。
RULE_FROM = 56

STATUSES = {"open", "in_progress", "partial", "fixed", "wontfix", "closed"}
MODULES = {"engine", "shell", "engine+shell", "build", "docs"}
SEVERITIES = {"low", "mid", "high", "critical"}

FILE_RE = re.compile(r"^BUG-(\d{3})\.md$")
IDX_ID_RE = re.compile(r"^\|\s*BUG-(\d{3})\s*\|")
# 字段格式在历史上演进过（`- 状态: fixed` / `- **状态**: fixed` / `**状态**: fixed` /
# `- **Status**: fixed` / `- **严重级**: major / ...`），门禁对**历史条目**容忍这些写法
# （否则等于要求改历史，而改历史就是伪造），对 RULE_FROM 起的新条目要求统一格式与枚举取值。
FIELD_RE = re.compile(
    r"^\s*[-*]*\s*\*{0,2}"
    r"(状态|发现日期|模块|严重程度|严重级|报告轮次|Status|Severity|Date|Module)"
    r"\*{0,2}\s*[:：]\s*(.+?)\s*$"
)
ALIAS = {
    "严重级": "严重程度",
    "Status": "状态",
    "Severity": "严重程度",
    "Date": "发现日期",
    "Module": "模块",
}


def parse_index_row(line: str) -> tuple[int, str, str] | None:
    """从索引行取 (编号, 标题, 状态, 模块)。

    标题里允许出现转义的 `\\|`（例如 `scope=all\\|failed`），按 `|` 切分会多出列，
    故**状态与模块一律取倒数两列** —— 只有把列位置写死才会因为标题里的竖线而漏行。
    """
    m = IDX_ID_RE.match(line)
    if not m:
        return None
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) < 4:
        return None
    return int(m.group(1)), cells[1], cells[-2], cells[-1]
# 验收章节里引用到的仓内路径（只认带目录的、有扩展名的相对路径）。
# 前缀集合含源码与**入库的验收脚本**目录：`tauri-shell/src`、`tauri-shell/verify`、
# `download-engine/crates`、`download-engine/verify` —— 这些在任何克隆里都在，
# 属于「跨机器可核」的证据；`verify_shots` 单列（不入库，见第 6 条）。
PATH_RE = re.compile(
    r"(?:verify_shots|scripts|download-engine/(?:verify|crates)|docs|tauri-shell/(?:src|verify))/"
    r"[A-Za-z0-9_./-]+\.[A-Za-z0-9]+"
)
HASH_RE = re.compile(r"`([0-9a-f]{7,40})`")

errors: list[str] = []
warnings: list[str] = []
# `--quiet`：只印结论（供 pre-commit 用——100 条历史告警刷屏会把真正的 ERROR 埋掉）；
# CI 不加该参数，保留全量输出。
QUIET = "--quiet" in sys.argv[1:]


def err(m: str) -> None:
    errors.append(m)


def warn(m: str) -> None:
    warnings.append(m)


def read_text(path: str) -> str:
    with open(path, "rb") as fh:
        raw = fh.read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        err(f"{os.path.relpath(path, ROOT)}: 不是合法 UTF-8（{exc}）—— 疑似错误编码写盘")
        return raw.decode("utf-8", errors="replace")


def git_has_commit(sha: str) -> bool:
    try:
        r = subprocess.run(
            ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return r.returncode == 0
    except OSError:
        return True  # 无 git 时不判负


# 无 git 环境（例如从 tarball 里跑门禁）时的兜底前缀：这些目录按 AGENTS.md §6 不入库。
LOCAL_ONLY_PREFIXES = ("verify_shots/", "docs/preview/")


def git_ignores(rel: str) -> bool:
    """该路径是否会被 `.gitignore` 忽略 —— 对**不存在的路径**同样有效（纯模式匹配）。

    用它而不是硬编码「哪些目录算本地证据」：新增 ignored 目录时门禁自动跟上。
    """
    try:
        r = subprocess.run(
            ["git", "check-ignore", "-q", "--", rel],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except OSError:
        return rel.startswith(LOCAL_ONLY_PREFIXES)
    if r.returncode == 0:
        return True
    if r.returncode == 128:  # 128 = 不在 git 仓库内 → 退回前缀判断
        return rel.startswith(LOCAL_ONLY_PREFIXES)
    return False


def main() -> int:
    if not os.path.isdir(BUGS):
        err("docs/bugs/ 不存在")
        return 1

    files: dict[int, str] = {}
    for fn in sorted(os.listdir(BUGS)):
        m = FILE_RE.match(fn)
        if m:
            n = int(m.group(1))
            if n in files:
                err(f"编号重复：BUG-{n:03d}")
            files[n] = os.path.join(BUGS, fn)

    if not files:
        err("docs/bugs/ 下没有任何 BUG-*.md")
        return 1

    # 1. 编号连续
    top = max(files)
    for n in range(1, top + 1):
        if n not in files:
            err(f"缺号：BUG-{n:03d} 无文件（编号必须自 1 起连续）")

    # 2. 索引
    idx: dict[int, tuple[str, str, str]] = {}
    if os.path.isfile(README):
        for line in read_text(README).splitlines():
            row = parse_index_row(line)
            if row:
                n, title, status, module = row
                if n in idx:
                    err(f"索引重复行：BUG-{n:03d}")
                idx[n] = (title, status, module)
    else:
        err("docs/bugs/README.md 不存在")
    for n in sorted(set(files) - set(idx)):
        err(f"BUG-{n:03d}.md 存在但索引里没有对应行")
    for n in sorted(set(idx) - set(files)):
        err(f"索引有 BUG-{n:03d} 行但没有对应文件")

    # 3~7. 逐条校验
    for n in sorted(files):
        rel = os.path.relpath(files[n], ROOT)
        text = read_text(files[n])
        lines = text.splitlines()

        field: dict[str, str] = {}
        for line in lines:
            m = FIELD_RE.match(line.strip())
            if m:
                field[ALIAS.get(m.group(1), m.group(1))] = m.group(2).strip()

        # 状态是唯一的历史全量字段：值取首个 token（`fixed（2026-09-18 已验收）` → `fixed`）
        raw_status = field.get("状态", "")
        status = re.split(r"[\s（(]", raw_status)[0] if raw_status else ""

        if "状态" not in field:
            err(f"{rel}: 缺少字段 `- 状态:`")
        elif status not in STATUSES:
            err(f"{rel}: 状态 `{raw_status}` 不在枚举 {sorted(STATUSES)}")
        if n in idx and status and idx[n][1] != status:
            err(f"{rel}: 状态与索引不一致（文件={status} 索引={idx[n][1]}）")

        # 其余字段：新条目强制，历史条目只告警（不逼着改历史 —— 那等于伪造当时的记录）
        for key in ("发现日期", "模块", "严重程度"):
            if key not in field:
                msg = f"{rel}: 缺少字段 `- {key}:`"
                err(msg) if n >= RULE_FROM else warn(msg)
        date_val = field.get("发现日期", "")
        if date_val and not re.match(r"^\d{4}-\d{2}-\d{2}$", date_val):
            msg = f"{rel}: 发现日期 `{date_val}` 不是 YYYY-MM-DD"
            err(msg) if n >= RULE_FROM else warn(msg)
        mod_val = field.get("模块", "")
        if mod_val and n >= RULE_FROM and mod_val not in MODULES:
            err(f"{rel}: 模块 `{mod_val}` 不在枚举 {sorted(MODULES)}")
        sev_val = field.get("严重程度", "")
        if sev_val and n >= RULE_FROM:
            head = re.split(r"\s*/\s*", sev_val)[0].strip()
            if head not in SEVERITIES:
                err(f"{rel}: 严重程度 `{sev_val}` 不在枚举 {sorted(SEVERITIES)}")

        if status not in ("fixed", "closed"):
            continue

        # 5. 验收章节
        has_ev = re.search(r"^##\s*验收证据\s*$", text, re.M) is not None
        has_fix = re.search(r"^##\s*修复\s*$", text, re.M) is not None
        if not has_ev:
            if n >= RULE_FROM:
                err(f"{rel}: 状态 {status} 但没有 `## 验收证据` 节（BUG-{RULE_FROM:03d} 起强制）")
            elif not has_fix:
                warn(f"{rel}: 状态 {status} 但既无 `## 验收证据` 也无 `## 修复` 节")
        if has_ev:
            body = text.split("## 验收证据", 1)[1].split("\n## ", 1)[0].strip()
            if not body:
                err(f"{rel}: `## 验收证据` 为空")

        # 6. 证据路径必须存在 —— 但判据不是「写在哪」，而是**换台机器还能不能核**：
        #    · 被 git 跟踪的路径（`scripts/` / `download-engine/verify/` / `docs/` / 源码…）
        #      = 任何克隆里都在 → 不存在即错；
        #    · 被 .gitignore 忽略的路径（`verify_shots/`、`docs/preview/` 等**本地证据**）
        #      = 按 AGENTS.md §6 不入库 → 本机存在就核、缺失只汇总告警。
        #    用 `git check-ignore` 而不是硬编码前缀清单：**它对新出现的忽略目录自动成立**，
        #    不必每加一个 ignored 目录就回来改门禁（硬编码清单必然会漏，BUG-002 引用
        #    `docs/preview/…` 就是漏出来的那一个）。
        local_missing: list[str] = []
        for p in sorted(set(PATH_RE.findall(text))):
            exists = os.path.exists(os.path.join(ROOT, p))
            ignored = git_ignores(p)
            if ignored and exists:
                continue                      # 本地证据，本机已核
            if ignored:
                local_missing.append(p)       # 本地证据但不在本机（CI 上属预期）
                continue
            if not exists:
                err(f"{rel}: 证据引用了不存在的路径 `{p}`")

        # 7. 提交 hash 必须真实
        #    · 只认「7–40 位十六进制」的候选；32 位（md5）/64 位（sha256）是**产物指纹**
        #      不是提交，误判会把「记录二进制一致性」当成「引用了不存在的提交」。
        #    · **不能要求含字母**：真实短 hash 可能是纯数字（本仓库 `0921056` 就是
        #      `fix(shell): make media overlays escapable…`，含字母的判据会把它当噪音跳过，
        #      于是「有提交证据」的登记反被判成「没有跨机器证据」—— 门禁自己制造的假阴性）。
        commits: list[str] = []
        for sha in sorted(set(HASH_RE.findall(text))):
            if not re.fullmatch(r"[0-9a-f]{7,40}", sha) or len(sha) in (32, 64):
                continue
            if git_has_commit(sha):
                commits.append(sha)
            elif re.search(r"[a-f]", sha):
                err(f"{rel}: 引用的提交 `{sha}` 在本仓库不存在"
                    f"（历史被重写过会使旧 hash 失效，请改为当前可达的 hash）")
            else:
                warn(f"{rel}: `{sha}` 形如纯数字短 hash 但本仓库无此提交 —— "
                     f"若非提交引用请去掉反引号，避免门禁误判")

        # 8. 终态 BUG 必须带**跨机器可核验**的引用：入库路径或真实提交 hash。
        #    **只看 `## 验收证据` 正文**：正文之外的源码路径只说明「改在哪」，
        #    不构成「验过」（否则一句 `tauri-shell/src/…` 就能把验收顶掉）。
        #    只有本地证据（`verify_shots/`）时，换台机器（CI / 同事）根本无从复核 —— 等于没证据。
        #    历史条目只告警（不逼着重写当时的记录），RULE_FROM 起强制。
        ev_text = text.split("## 验收证据", 1)[1].split("\n## ", 1)[0] if has_ev else ""
        ev_refs = [
            p for p in set(PATH_RE.findall(ev_text))
            if os.path.exists(os.path.join(ROOT, p)) and not git_ignores(p)
        ]
        ev_commits = [h for h in set(HASH_RE.findall(ev_text)) if h in commits]
        if not ev_refs and not ev_commits:
            msg = (f"{rel}: 状态 {status} 但 `## 验收证据` 内没有跨机器可核验的引用"
                   f"（入库路径或提交 hash）—— 只有本地证据在 CI 上无法复核")
            err(msg) if n >= RULE_FROM else warn(msg)

        if local_missing:
            shown = ", ".join(local_missing[:3]) + (" …" if len(local_missing) > 3 else "")
            warn(f"{rel}: {len(local_missing)} 处本地证据不在本机（verify_shots/ 不入库，CI 属预期）：{shown}")

    if not QUIET:
        for w in warnings:
            print(f"warn  {w}")
    for e in errors:
        print(f"ERROR {e}")
    if errors:
        print(f"\ncheck-bugs: FAIL - {len(errors)} 项违反（warn {len(warnings)} 项）")
        return 1
    print(f"check-bugs: OK - {len(files)} 条登记，编号连续、索引一致、字段与证据合法"
          f"（warn {len(warnings)} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
