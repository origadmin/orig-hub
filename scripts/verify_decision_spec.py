"""决策规格门禁的反向证伪（验收的验收）。

给每条硬性要求喂一个**必须被拒绝**的输入，再给一个**必须被接受**的输入。
若规则不能 FAIL，它就是装饰品；若规则误伤合法输入，它会被绕过。

判据来源：docs/rules/decision-spec.md 第一节的 8 条硬性要求。

外加一条**在真实文档上实测到**的补充判据（规则J）：
「不做」选项必须按 `涉及:` 的**实质**判定，不能按标签措辞 —— 否则
「续编两集（维持现状的显式选择）」这种命名会让门禁放行一个没有「不做」选项的决策。
"""

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FULL = """# 待拍板决策清单（2026-09-23）

### D1. 示例决策

- **问题**: 选 A 还是 B？
- **现状与代价**: 现状如此，不定则无法收口。
- **设计锚点**: `docs/design/media-library-management-prd-2026-09-22.md` R10
- **请求**: 选 A 还是 B？

**选项**

**A. 第一个方案**
- 涉及: `scripts/check-bugs.py`
- 量化: 影响 1 个文件
- 回归风险: 低 — 无既有能力受影响
- 后果: 立即生效，可逆

**B. 第二个方案**
- 涉及: `scripts/check-decisions.py`
- 量化: 影响 1 个文件
- 回归风险: 中 — 需同步文档
- 后果: 延后生效，可逆

**C. 不做（维持现状）**
- 涉及: 无
- 量化: 0
- 回归风险: 无新增
- 后果: 问题保留，将来被迫回头做
"""


def mutate(name, fn):
    """把 FULL 改坏，返回 (标签, 文本)。"""
    return name, fn(FULL)


CASES = [
    mutate("规则A 无「不做」选项", lambda t: re.sub(
        r"\*\*C\. 不做.*?(?=\Z)", "", t, flags=re.S)),
    # 注意：只删 B 会剩 A + 不做 = 2 个选项，按规则**不应 FAIL**（首版夹具就错在这里，
    # 报「假绿」其实是夹具没造出「不足两个」的局面）。必须删到只剩 1 个实质选项。
    mutate("规则B 只剩 1 个选项（连「不做」也删掉）", lambda t: re.sub(
        r"\*\*B\. 第二个方案.*?(?=\Z)", "", t, flags=re.S)),
    mutate("规则C 选项缺 `涉及:`", lambda t: t.replace(
        "\n- 涉及: `scripts/check-bugs.py`", "")),
    mutate("规则D `涉及:` 为空", lambda t: t.replace(
        "- 涉及: `scripts/check-bugs.py`", "- 涉及:")),
    mutate("规则E 缺 `请求:`", lambda t: t.replace(
        "- **请求**: 选 A 还是 B？\n", "")),
    mutate("规则F 缺 `设计锚点:`", lambda t: t.replace(
        "- **设计锚点**: `docs/design/media-library-management-prd-2026-09-22.md` R10\n", "")),
    mutate("规则G 锚点指向不存在的文件", lambda t: t.replace(
        "`docs/design/media-library-management-prd-2026-09-22.md`",
        "`docs/design/this-file-does-not-exist.md`")),
    mutate("规则H 选项缺 `后果:`", lambda t: t.replace(
        "- 后果: 立即生效，可逆\n", "")),
    # 规则J：**只看标签的假绿**。实测在真实文档上踩到 —— 选项 B 命名为
    # 「续编两集（维持现状的显式选择）」，标签含「维持现状」使旧门禁放行，
    # 但它 `涉及:` 指向仓内文件、是实质量选项，该决策实际**没有「不做」选项**。
    # 判据必须看 `涉及:` 的实质，不能看措辞。
    mutate("规则J 「不做」选项标签像却指向仓内改动（须被识破）", lambda t: t.replace(
        "**C. 不做（维持现状）**\n- 涉及: 无",
        "**C. 维持现状但顺手改一处**\n- 涉及: `scripts/check-bugs.py`")),
]


def run_gate(dirpath, expect_fail, label):
    """在临时仓跑门禁（用 --all 以纳入所有日期）。

    必须用**临时仓里的**脚本副本，不能用真实仓的脚本：门禁用 `__file__` 定 ROOT，
    跑真实仓脚本时扫的是真实仓的 docs/review（`cwd=` 只影响相对路径，改不了 ROOT）。
    实测踩到：一开始传了真实仓脚本的绝对路径，于是「完整规格」用例扫到真实仓的旧文档、
    误报 24 项违反 —— **测的不是被测对象**，看起来像规则误伤，其实是夹具没生效。
    """
    r = subprocess.run(
        [sys.executable, os.path.join(dirpath, "scripts", "check-decisions.py"),
         "--quiet", "--all"],
        cwd=dirpath, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = (r.stdout or "") + (r.stderr or "")
    if expect_fail:
        ok = r.returncode == 1
        print(("  PASS  " if ok else "  FAIL  ") + label)
        print("          期望: FAIL(1)   实际: %s" % r.returncode)
    else:
        ok = r.returncode == 0
        print(("  PASS  " if ok else "  FAIL  ") + label)
        print("          期望: OK(0)     实际: %s  %s" % (r.returncode, out.strip()[:90]))
    return ok


def make_repo(decision_text):
    """搭一个最小仓：docs/review/<清单>.md + scripts/check-decisions.py。"""
    d = tempfile.mkdtemp(prefix="dgate_")
    os.makedirs(os.path.join(d, "docs", "review"))
    os.makedirs(os.path.join(d, "scripts"))
    os.makedirs(os.path.join(d, "docs", "design"))
    with open(os.path.join(d, "docs", "review", "pending-decisions-2026-09-23.md"),
              "w", encoding="utf-8") as f:
        f.write(decision_text)
    # 锚点指向的真实文件
    with open(os.path.join(d, "docs", "design",
                           "media-library-management-prd-2026-09-22.md"),
              "w", encoding="utf-8") as f:
        f.write("# PRD\n\n## R10\n续播\n")
    shutil.copy(os.path.join(HERE, "check-decisions.py"),
                os.path.join(d, "scripts", "check-decisions.py"))
    return d


POSITIVE_CASES = [
    mutate("规则I 全角冒号写法必须被接受（防分隔符不兼容）", lambda t: t),
]


if __name__ == "__main__":
    results = []
    print("=== 正向：完整决策项必须 PASS ===")
    d = make_repo(FULL)
    results.append(run_gate(d, False, "规则0  完整规格必须 OK"))
    shutil.rmtree(d, ignore_errors=True)

    for label, good in POSITIVE_CASES:
        d = make_repo(good)
        results.append(run_gate(d, False, label))
        shutil.rmtree(d, ignore_errors=True)

    print()
    print("=== 反向：每类缺失必须 FAIL ===")
    for label, bad in CASES:
        d = make_repo(bad)
        results.append(run_gate(d, True, label))
        shutil.rmtree(d, ignore_errors=True)

    print()
    allok = all(results)
    print("结论: " + ("ALL PASS — 每类缺失均可被拒，且合法输入（含全角冒号）不被误伤"
                      if allok else "FAIL — 存在假绿或误伤"))
    sys.exit(0 if allok else 1)
