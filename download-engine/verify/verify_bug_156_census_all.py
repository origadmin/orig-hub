"""BUG-156 影响面 / P4 风险面 —— 跨**多个真实库**的统一盘点（全部只读）。

跑法：python verify/verify_bug_156_census_all.py
"""
import os
import re
import sqlite3
import sys

DBS = [
    ("production-app", r"%LOCALAPPDATA%\OrigHub\tg\store.db"),
    ("probe2", r"%LOCALAPPDATA%\Temp\orighub_probe2\store.db"),
    ("probe", r"%LOCALAPPDATA%\Temp\orighub_probe\store.db"),
]


def split_old(first):
    toks = first.split()
    while toks and toks[-1].startswith("#"):
        toks.pop()
    return " ".join(toks) or None


def split_new(first):
    toks = first.split()
    frm = 1 if (toks and toks[0].startswith("#")) else 0
    while len(toks) > frm and toks[-1].startswith("#"):
        toks.pop()
    return " ".join(toks) or None


def census(path):
    if not os.path.exists(path):
        return None
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        caps = [
            r[0]
            for r in con.execute(
                "select caption from media_message where caption is not null and trim(caption)<>''"
            )
        ]
        series = list(con.execute("select id,title from media_series order by id"))
    except sqlite3.Error as e:
        return {"error": str(e)}
    uniq = list(dict.fromkeys(caps))
    firsts = [c.strip().split("\n")[0].strip() for c in uniq]
    firsts = [f for f in firsts if f]

    leading = [f for f in firsts if f.split()[0].startswith("#")]
    single = [f for f in leading if len([t for t in f.split() if t.startswith("#")]) == 1]
    multi = [f for f in leading if len([t for t in f.split() if t.startswith("#")]) > 1]
    old_lost = [f for f in firsts if not split_old(f)]
    new_lost = [f for f in firsts if not split_new(f)]
    fallback = [t for _, t in series if re.search(r"·\s*\d{4}-\d{2}-\d{2}$", t)]
    dup = {}
    for _, t in series:
        dup[t] = dup.get(t, 0) + 1
    dup_titles = {k: v for k, v in dup.items() if v > 1}

    return {
        "caps_nonempty": len(caps),
        "caps_uniq": len(uniq),
        "firsts": len(firsts),
        "leading": len(leading),
        "single": len(single),
        "multi": len(multi),
        "old_lost": len(old_lost),
        "new_lost": len(new_lost),
        "old_lost_samples": old_lost[:8],
        "single_samples": single[:8],
        "multi_samples": multi[:8],
        "series_total": len(series),
        "fallback_names": fallback,
        "dup_titles": dup_titles,
    }


def main():
    grand_old = grand_new = 0
    for label, pat in DBS:
        path = os.path.expandvars(pat)
        print(f"###### {label}: {path}")
        r = census(path)
        if r is None:
            print("   (not found)\n")
            continue
        if "error" in r:
            print(f"   (error: {r['error']})\n")
            continue
        print(f"   non-empty captions            : {r['caps_nonempty']} (uniq {r['caps_uniq']})")
        print(f"   unique first lines            : {r['firsts']}")
        print(f"   first token starts with #     : {r['leading']}")
        print(f"     single # token (P4 risk)    : {r['single']}")
        print(f"     multiple # tokens (benefit) : {r['multi']}")
        print(f"   series name lost, PRE-fix     : {r['old_lost']}")
        print(f"   series name lost, POST-fix    : {r['new_lost']}")
        print(f"   media_series total            : {r['series_total']}")
        print(f"   'channel . date' fallback     : {len(r['fallback_names'])}")
        for f in r["fallback_names"]:
            print(f"       - {f!r}")
        if r["dup_titles"]:
            print("   DUPLICATE series titles:")
            for k, v in r["dup_titles"].items():
                print(f"       x{v}  {k!r}")
        if r["old_lost_samples"]:
            print("   PRE-fix lost samples:")
            for f in r["old_lost_samples"]:
                print(f"       {f!r}")
        if r["single_samples"]:
            print("   P4 risk samples:")
            for f in r["single_samples"]:
                print(f"       {f!r}")
        if r["multi_samples"]:
            print("   Benefit samples:")
            for f in r["multi_samples"]:
                print(f"       {f!r}")
        grand_old += r["old_lost"]
        grand_new += r["new_lost"]
        print()

    print("================================================")
    print(f"TOTAL across DBs: PRE-fix lost = {grand_old}, POST-fix lost = {grand_new}")
    ok = grand_old > 0 and grand_new == 0
    print(f"VERDICT: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
