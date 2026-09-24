#!/usr/bin/env python3
"""BUG-156 十条例判据的**独立复核**（不依赖 Rust 测试，直接复刻判据语义）。

跑法：python verify/verify_bug_156_falsify.py
退出码 0 = 全部通过；非 0 = 有判据失败。

用途：给 team-lead 一个可以**独立复跑**的证据面，
并确认「判据本身是能变红的」（反向证伪见 --mutate）。
"""
import sys

MAX_TITLE_CHARS = 120


def split_caption(caption: str):
    """复刻 media.rs::split_caption（BUG-156 版）。"""
    lines = caption.split("\n")
    first = (lines[0] if lines else "").strip()
    body_parts = [l.strip() for l in lines[1:] if l.strip()]
    body = "\n".join(body_parts) or None

    toks = first.split()
    # BUG-156: toks[0] 以 '#' 开头 => 它是标题，从 toks[1:] 起才弹尾
    frm = 1 if (toks and toks[0].startswith("#")) else 0
    while len(toks) > frm and toks[-1].startswith("#"):
        toks.pop()
    title = " ".join(toks)
    if not title:
        return (None, body)
    return (title[:MAX_TITLE_CHARS], body)


def normalized_series_name(title_line: str) -> str:
    """复刻 routes.rs::normalized_series_name 的语义（剧名 = 集号之前）。

    这里只实现对判据 1-9 用得到的部分：剥掉首个集号锚点及其后全部内容。
    """
    t = title_line.rstrip()
    if not t:
        return ""
    n = len(t)
    i = 0
    while i < n:
        c = t[i]
        anchor = 0
        if c == "第":
            anchor = 1
        elif c == "#":
            # 只有「# 后跟独立数字 token」才算集号锚点
            j = i + 1
            d = 0
            while j + d < n and t[j + d].isdigit():
                d += 1
            if d == 0:
                i += 1
                continue
            nxt = t[j + d: j + d + 1]
            standalone = (nxt == "") or nxt.isspace() or (
                not nxt.isalnum() and not nxt.isspace()
            )
            if not standalone:
                i += 1
                continue
            anchor = 1
        elif t[i:i + 2].lower() == "ep":
            prev = t[i - 1] if i > 0 else ""
            if prev.isalnum():
                i += 1
                continue
            anchor = 2
        else:
            i += 1
            continue
        # 吃数字段
        k = i + anchor
        while k < n and t[k].isspace():
            k += 1
        d_end = k
        while d_end < n and (t[d_end].isdigit() or t[d_end] in "-~到至"):
            d_end += 1
        if not any(ch.isdigit() for ch in t[k:d_end]):
            i += 1
            continue
        name = t[:i].strip()
        return name if name else ""
    return t.strip()


# ---------------------------------------------------------------- 判据表
# 每项：(编号, 说明, 实际值, 期望值)
def build_cases():
    cases = []

    def add(no, desc, actual, expected):
        cases.append((no, desc, actual, expected))

    # --- 原有 5 条（P2 无回归；用例 1-5 来自 team-lead 的回归清单）---
    t, d = split_caption("这是标题\n第一行介绍\n第二行介绍 #标签1")
    add("1", "首行标题 + 正文，行尾 #标签 不进标题", t, "这是标题")
    add("1b", "  同上：介绍保留行尾标签原文", d, "第一行介绍\n第二行介绍 #标签1")

    t2, _ = split_caption("标题行 #a #b\n正文")
    add("2", "P2 回归：有非#标题词时行为不变", t2, "标题行")

    t3, d3 = split_caption("只有一行")
    add("3", "单行 caption：只有标题", t3, "只有一行")
    add("3b", "  同上：无介绍", d3, None)

    t4, d4 = split_caption("\n只有正文")
    add("4", "首行空 => 无标题", t4, None)
    add("4b", "  同上：整段退化为介绍", d4, "只有正文")

    t5, d5 = split_caption("   ")
    add("5", "空白 caption => 无标题", t5, None)
    add("5b", "  同上：无介绍", d5, None)

    # --- 新增 4 条真实库正例（当前必须已转绿）---
    add("6", "#神雕侠侣 #刘亦菲 => 保留首个 # 词",
        split_caption("#神雕侠侣 #刘亦菲")[0], "#神雕侠侣")
    add("7", "#18岁太奶奶驾到重整家族荣耀 #李柯以 #杨姝音 #孟娜",
        split_caption("#18岁太奶奶驾到重整家族荣耀 #李柯以 #杨姝音 #孟娜")[0],
        "#18岁太奶奶驾到重整家族荣耀")
    add("8", "#存在感零 #杨幂 #赵今麦",
        split_caption("#存在感零 #杨幂 #赵今麦")[0], "#存在感零")
    add("9", "#周也（整行即剧名）",
        split_caption("#周也")[0], "#周也")

    # --- 第 10 条：生产调用链上的最终剧名非空 ---
    chain_inputs = [
        "#周也",
        "#18岁太奶奶驾到重整家族荣耀 #李柯以 #杨姝音 #孟娜",
        "#存在感零 #杨幂 #赵今麦",
        "#神雕侠侣 #刘亦菲",
        "#大厨小婿 #陈姝君 #朱容君 #景漫",
        "#ai成人短剧 #AI短剧 #ai成人 #神墓 #黑丝",
    ]
    for idx, cap in enumerate(chain_inputs, 1):
        title = split_caption(cap)[0] or ""
        name = normalized_series_name(title)
        # 10.x  最终剧名必须非空
        add(f"10.{idx}", f"生产链剧名非空: {cap[:24]}", bool(name.strip()), True)
        # 10.xb 最终剧名必须等于 caption 的第一个 `#` 词（剧名段），无集号残留。
        #       这正是「入口不吞名」的直接可观察结果。
        first_tok = cap.split()[0]
        add(f"10.{idx}b", f"  剧名 == 首个 # 词（无集号残留）: {cap[:24]}",
            name, first_tok)

    return cases


def run(mutate=None):
    cases = build_cases()
    failed = []
    for no, desc, actual, expected in cases:
        if mutate == "case6_none":
            # 反向证伪 1：把用例 6 的期望改成 None，必须失败
            if no == "6":
                expected = None
        if mutate == "case2_raw":
            # 反向证伪 2：把用例 2 的期望改成未弹尾的原文，必须失败
            if no == "2":
                expected = "标题行 #a #b"
        ok = actual == expected
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {no:>6}  {desc}")
        print(f"          expected={expected!r}")
        print(f"          actual  ={actual!r}")
        if not ok:
            failed.append(no)
    print()
    print(f"total={len(cases)} passed={len(cases) - len(failed)} failed={len(failed)}")
    if failed:
        print(f"failed cases: {failed}")
        return 1
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else None
    if mode == "--mutate":
        # 证伪模式：期望这两次「故意改坏期望」都以非 0 退出（即判据能变红）
        print("=== mutation 1: case 6 expects None (must FAIL) ===")
        rc1 = run(mutate="case6_none")
        print(f"-> exit={rc1} (non-zero expected)\n")
        print("=== mutation 2: case 2 expects '标题行 #a #b' (must FAIL) ===")
        rc2 = run(mutate="case2_raw")
        print(f"-> exit={rc2} (non-zero expected)")
        sys.exit(0 if (rc1 != 0 and rc2 != 0) else 1)
    sys.exit(run())
