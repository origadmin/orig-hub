#!/usr/bin/env python3
"""验收脚本的**范围裁剪**入口（BUG-331 / BUG-402）。

## 为什么需要它

修复一个 BUG 的回合里，执行者「保险起见」把全套验收脚本跑一遍：范围外的失败会
混进本回合结论（假红），且时间成本与改动零因果。用户裁定：**工具裁，不靠人记得**。

## 三种模式

    run-acceptance.py --changed          # S2：按本回合变更集推断域，只跑该域的脚本
    run-acceptance.py --only BUG-467     # 只跑该 BUG 档案里登记的验收脚本
    run-acceptance.py --all              # S3：全量（发布前 / 用户点名，开发回合禁用）

## 真源

- 脚本 → 域 / 档位：`tauri-shell/verify/MANIFEST.md`（人维护的表，本脚本只读）
- BUG → 脚本：`docs/bugs/BUG-NNN.md` 的 `## 验收证据` 节里出现的 `verify/*.cjs`

两者都是**已有**真源，本脚本不新增登记位置 —— 否则又多一处会漏记的地方。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tauri-shell" / "verify" / "MANIFEST.md"
BUGS = ROOT / "docs" / "bugs"

# 变更路径 → MANIFEST 的域。只覆盖有验收脚本的四个域；未命中即「不裁」。
PATH_DOMAINS: list[tuple[re.Pattern[str], set[str]]] = [
    (re.compile(r"^tauri-shell/src/domains/tg/|TgPanel|TgAvatar|api/tg\.ts|lib/tg"), {"tg"}),
    (re.compile(r"^download-engine/crates/orig-tg/"), {"tg", "engine"}),
    (re.compile(r"^download-engine/crates/orig-daemon/"), {"engine", "download"}),
    (re.compile(r"^download-engine/crates/"), {"engine"}),
    (re.compile(r"^tauri-shell/src/domains/download/|DownloadPanel"), {"download"}),
    (re.compile(r"^tauri-shell/src/components/media/|MediaLibraryPanel|domains/files/"), {"files"}),
]


def changed_paths() -> list[str]:
    out: list[str] = []
    for args in (["diff", "--name-only", "HEAD"], ["ls-files", "--others", "--exclude-standard"]):
        r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        out.extend(x.strip() for x in r.stdout.splitlines() if x.strip())
    return sorted(set(out))


def parse_manifest() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    if not MANIFEST.exists():
        return rows
    for line in MANIFEST.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^\|\s*([^|]+?\.cjs)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$", line)
        if m:
            rows.append({"script": m.group(1).strip(), "domain": m.group(2).strip(), "tier": m.group(3).strip()})
    return rows


def bug_scripts(bug: str) -> list[str]:
    doc = BUGS / f"{bug}.md"
    if not doc.exists():
        return []
    text = doc.read_text(encoding="utf-8", errors="replace")
    # 只在「验收证据」节里找，避免把「复现步骤」里提到的脚本当成验收脚本
    idx = text.find("## 验收证据")
    if idx >= 0:
        text = text[idx:]
        nxt = text.find("\n## ", 1)
        if nxt > 0:
            text = text[:nxt]
    return sorted(set(re.findall(r"(verify/[\w.\-]+\.cjs)", text)))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--changed", action="store_true", help="只跑本回合变更域（开发回合默认）")
    g.add_argument("--only", metavar="BUG-467", nargs="+", help="只跑这些 BUG 登记的验收脚本")
    g.add_argument("--all", action="store_true", help="全量（发布前/用户点名，开发回合禁用）")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不执行")
    args = ap.parse_args()

    rows = parse_manifest()
    by_script = {Path(r["script"]).name: r for r in rows}

    if args.only:
        selected: list[str] = []
        for bug in args.only:
            got = bug_scripts(bug)
            if not got:
                print(f"SKIP  {bug}: 档案「验收证据」未登记脚本（若该 BUG 已 fixed 且无脚本，属登记缺失）")
                continue
            selected.extend(got)
        plan = sorted(set(selected))
        reason = f"--only {','.join(args.only)}"
    elif args.all:
        plan = sorted(r["script"] for r in rows)
        reason = "--all"
    else:
        paths = changed_paths()
        domains: set[str] = set()
        for p in paths:
            for rx, ds in PATH_DOMAINS:
                if rx.search(p):
                    domains |= ds
        if not domains:
            print(f"SKIP  changed={len(paths)} 个文件未命中任何有脚本的域 ⇒ 运行 S1 冒烟即可（smoke.cjs）")
            return 0
        plan = sorted(r["script"] for r in rows if r["domain"] in domains and r["tier"] != "S1")
        reason = f"--changed 域={','.join(sorted(domains))}"

    print(f"# scope: {reason} → {len(plan)} 个脚本（范围外一律不跑）")
    if args.dry_run:
        for s in plan:
            print(f"  RUN {s} [{by_script.get(Path(s).name, {}).get('domain', '?')}]")
        return 0

    verify = ROOT / "tauri-shell" / "verify"
    failed: list[str] = []
    for s in plan:
        path = verify / Path(s).name
        if not path.exists():
            print(f"MISS {s}: 脚本不存在（MANIFEST 与磁盘不一致）")
            failed.append(s)
            continue
        r = subprocess.run(["node", str(path)], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
        ok = r.returncode == 0
        print(f"{'PASS' if ok else 'FAIL'} {s}")
        if not ok:
            failed.append(s)
            tail = (r.stdout or "").strip().splitlines()[-6:]
            for line in tail:
                print(f"     | {line}")

    print(f"# {len(plan) - len(failed)}/{len(plan)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
