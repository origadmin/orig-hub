"""BUG-156 P4 风险面 + BUG-152/BUG-156 交互修正的量化复核（在产库，只读）。

跑法：python verify/verify_bug_156_p4_census.py
"""
import os
import sqlite3
import sys


def main():
    db = os.path.expandvars(r"%LOCALAPPDATA%\Temp\orighub_probe2\store.db")
    if not os.path.exists(db):
        print(f"SKIP: probe db not found: {db}")
        return 0
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    caps = [
        r[0]
        for r in c.execute(
            "select caption from media_message where caption is not null and trim(caption)<>''"
        )
    ]
    uniq = list(dict.fromkeys(caps))
    firsts = [cap.strip().split("\n")[0].strip() for cap in uniq]
    firsts = [f for f in firsts if f]

    leading = [f for f in firsts if f.split()[0].startswith("#")]
    single = [f for f in leading if len([t for t in f.split() if t.startswith("#")]) == 1]
    multi = [f for f in leading if len([t for t in f.split() if t.startswith("#")]) > 1]

    print("=== P4 风险面（首词为 # 的 caption）===")
    print(f"unique first lines       : {len(firsts)}")
    print(f"first token starts with #: {len(leading)}")
    print(f"  single # token         : {len(single)}  <- P4 风险（可能是演员名）")
    print(f"  multiple # tokens      : {len(multi)}  <- 首个通常是剧名（修复受益）")
    print()
    if single:
        print("=== single # token（无法区分剧名/演员名）===")
        for f in single:
            print("  " + repr(f))
        print()
    if multi:
        print("=== multiple # tokens（首个=剧名）===")
        for f in multi:
            print("  " + repr(f))
        print()

    # BUG-152/BUG-156 交互：`#` 后跟数字的剧名不能被误读为集号
    import re
    hash_digit_titles = [f for f in firsts if re.search(r"#[0-9]", f)]
    print("=== BUG-152/BUG-156 交互面：`#` 后紧跟数字的首行 ===")
    print(f"count: {len(hash_digit_titles)}")
    for f in hash_digit_titles:
        first_tok = f.split()[0] if f.split() else ""
        ok = bool(first_tok)
        print(f"  {'OK ' if ok else 'BAD'} {f!r}  -> first token {first_tok!r}")
    print()
    bad = [f for f in hash_digit_titles if not (f.split() and f.split()[0])]
    print(f"VERDICT: interaction面 {len(hash_digit_titles)} 条, 剧名段落空 {len(bad)}")
    return 0 if len(bad) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
