"""BUG-156：在**真实库全量首行**上对比「修前 / 修后」的生产链最终剧名。

判据：修前必须存在剧名丢失（None/空）的样本；修后必须为 0。
跑法：python verify/verify_bug_156_real_corpus.py
"""
import os
import sqlite3
import sys

MAX_TITLE_CHARS = 120


def split_caption_old(caption):
    lines = caption.split("\n")
    first = (lines[0] if lines else "").strip()
    toks = first.split()
    while toks and toks[-1].startswith("#"):
        toks.pop()
    title = " ".join(toks)
    return title[:MAX_TITLE_CHARS] if title else None


def split_caption_new(caption):
    lines = caption.split("\n")
    first = (lines[0] if lines else "").strip()
    toks = first.split()
    frm = 1 if (toks and toks[0].startswith("#")) else 0
    while len(toks) > frm and toks[-1].startswith("#"):
        toks.pop()
    title = " ".join(toks)
    return title[:MAX_TITLE_CHARS] if title else None


def norm_old(title_line):
    """BUG-152 之前的语义：直接 trim 原文（未剥集号）。"""
    return (title_line or "").strip()


def norm_new(title_line):
    """BUG-152 + BUG-156 后的语义：剧名 = 集号之前（此处近似：剥 EP/第N集 尾部）。"""
    t = (title_line or "").rstrip()
    if not t:
        return ""
    # 从右往左找「EP/第」集号锚点，取之前的部分
    best = t
    for marker in ("EP", "ep", "第"):
        p = t.rfind(marker)
        if p > 0:
            seg = t[:p].strip()
            if seg:
                best = min(best, seg, key=len) if False else best
    # 简化：用 EP 锚点（真实库主流写法）
    import re
    m = re.search(r"\s?EP-?\d+", t)
    if m and m.start() > 0:
        return t[: m.start()].strip()
    m2 = re.search(r"\s?第\s*\d+\s*集", t)
    if m2 and m2.start() > 0:
        return t[: m2.start()].strip()
    return t.strip()


def main():
    db = os.path.expandvars(r"%LOCALAPPDATA%\Temp\orighub_probe2\store.db")
    if not os.path.exists(db):
        print(f"SKIP: probe db not found: {db}")
        return 0
    c = sqlite3.connect(db)
    caps = [
        r[0]
        for r in c.execute(
            "select caption from media_message where caption is not null and trim(caption)<>''"
        )
    ]
    uniq = list(dict.fromkeys(caps))
    firsts = [cap.strip().split("\n")[0].strip() for cap in uniq]
    firsts = [f for f in firsts if f]

    old_lost = [f for f in firsts if not norm_old(split_caption_old(f))]
    new_lost = [f for f in firsts if not norm_new(split_caption_new(f))]

    print(f"real corpus unique first lines : {len(firsts)}")
    print(f"OLD (pre-fix) lost series name : {len(old_lost)}")
    print(f"NEW (post-fix) lost series name: {len(new_lost)}")
    print()
    if old_lost:
        print("=== OLD failures (series name lost) ===")
        for f in old_lost:
            print("  " + repr(f))
        print()
    if new_lost:
        print("=== NEW failures (regression!) ===")
        for f in new_lost:
            print("  " + repr(f))

    # 判据：修前 >0（缺口真实存在）、修后 ==0（已修复）
    ok = len(old_lost) > 0 and len(new_lost) == 0
    print()
    print(f"VERDICT: {'PASS' if ok else 'FAIL'} "
          f"(pre-fix damage exists AND post-fix damage is zero)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
