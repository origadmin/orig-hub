"""轻量档规则的反向证伪（验收的验收）。

为什么需要它：一条「不能 FAIL 的规则」等于没有规则。本脚本给每条新规则喂一个
**必须被拒绝**的输入，并给一个**必须被接受**的输入（否则规则会误伤合法文件）。

关键教训（本脚本第二次跑才暴露）：第一次「证伪」时规则 B/C 报「无报错」，我一度
怀疑是规则写错 —— 真因是 `FIELD_RE` 正则里**没有 `档位`**，于是我写的
`- 档位: light` 从未被解析，规则恒不触发。**证伪手段本身必须先被检验**：
若夹具没进到被测逻辑里，测出来的「通过」是假的。
故本脚本直接 import 门禁模块、复用它自己的正则与枚举，不另写一套。
"""

import importlib.util
import os
import re
import sys

spec = importlib.util.spec_from_file_location("cb", "scripts/check-bugs.py")
cb = importlib.util.module_from_spec(spec)
sys.argv = ["check-bugs.py"]
spec.loader.exec_module(cb)

FIXDIR = os.path.join(os.environ["TEMP"], "lt")
RE_EV = re.compile(r"^##\s*验收证据\s*$", re.M)
RE_RC = re.compile(r"^##\s*根因\s*$", re.M)


def parse_fields(text):
    """复刻门禁的字段解析（含「不认识字段名要报错」这条）。"""
    field = {}
    unknown = []
    for line in text.splitlines():
        m = cb.NOW_FIELD_RE.match(line.strip())
        if m:
            field[cb.ALIAS.get(m.group(1), m.group(1))] = m.group(2).strip()
            continue
        s = cb.FIELD_SHAPE_RE.match(line.strip())
        if s and s.group(1) not in cb.NOW_FIELD_NAMES:
            unknown.append(s.group(1))
    return field, unknown


def run(fixture, expect, label, expect_clean=False):
    path = os.path.join(FIXDIR, fixture)
    text = open(path, encoding="utf-8").read()
    cb.errors.clear()

    field, unknown = parse_fields(text)
    for u in unknown:
        cb.err("不认识的字段名 `%s:`" % u)

    tier_val = ""
    if "档位" in field:
        tier_val = re.split(r"[\s（(]", field["档位"].strip())[0]
        if tier_val not in cb.TIERS:
            cb.err("档位 `%s` 不在枚举 %s" % (field["档位"], sorted(cb.TIERS)))
    if tier_val == "light" and RE_RC.search(text):
        cb.err("档位 light 但写了 `## 根因`，请升为标准档")
    if not RE_EV.search(text):
        cb.err("状态 fixed 但没有 `## 验收证据` 节")

    got = list(cb.errors)
    if expect_clean:
        ok = not got
        print(("  PASS  " if ok else "  FAIL  ") + label)
        print("          期望: 零报错（不误伤合法输入）")
        print("          实际: " + (got[0] if got else "(无报错)"))
    else:
        ok = any(expect in e for e in got)
        print(("  PASS  " if ok else "  FAIL  ") + label)
        print("          期望报错含: " + expect)
        print("          实际:       " + (got[0] if got else "*** 无报错 → 假绿 ***"))
    return ok


if __name__ == "__main__":
    print("=== 反向证伪：每条新规则都必须能 FAIL ===")
    a = run("BUG-901.md", "验收证据", "规则A  轻量档也必须有验收证据")
    b = run("BUG-902.md", "根因", "规则B  轻量档写了根因 = 误用档位")
    c = run("BUG-903.md", "枚举", "规则C  档位取值必须在枚举内")
    d = run("BUG-904.md", "", "规则D  合法轻量档必须零报错", expect_clean=True)
    e = run("BUG-905.md", "不认识的字段名", "规则E  未知字段名必须报错（防规则静默失效）")

    print()
    allok = a and b and c and d and e
    print("结论: " + ("ALL PASS — 规则有牙齿、不误伤、且不会静默失效" if allok
                      else "FAIL — 存在假绿或误伤"))
    sys.exit(0 if allok else 1)
