---
status: draft
author: 高见远（架构师）
date: 2026-10-09
topic: governance
module: docs
decided-by: —（本文只是把既有条款汇总成一张可执行对照表，**未新增裁定**；升为强制待主理人确认）
decided-at: —
landed-in: 无（工具侧已落地 `check-bugs.py --changed`，规则侧待确认）
---

# 门禁作用域（Gate Scope）

> **一句话**：门禁按「**改了什么**」选，**不按「习惯」跑**。
> 跑一个门禁之前，必须能说出**本次变更的哪条路径落在它的作用域里**；说不出，就是不该跑。

---

## 0. 为什么需要这份规则（实测缺陷，可复核）

2026-10-09，一次**纯文档**改动（3 个 `.md`、**0 行代码**）在提交前跑了 `check-bugs.py` ——
全量扫描 241 条缺陷档，耗时 **6 分 39 秒（399 s）**。而该改动**没有碰任何缺陷档**，
门禁结果与本次改动**零因果关系**。产品负责人裁定：

> 「为什么就改了份文档还需要各种代码测试各种逻辑测试？完全脱离修改范围了……大量浪费时间，也是完全错误逻辑。」

### 四条根因（缺一条都不会发生）

| # | 根因 | 证据 |
|---|---|---|
| **R1** | **门禁脚本没有作用域参数** —— 任何调用都是全量扫描 | `scripts/check-bugs.py` 改动前只认 `--quiet`；241 条档案逐条 spawn 子进程 |
| **R2** | **规范与实测不符** —— `AGENTS.md` §7 声明 check-bugs 为 pre-commit「**必需**」，但实装钩子只跑污染门禁 | `framework/.git/modules/orig-hub/hooks/pre-commit` 正文只有 `exec sh ".../scripts/check-pollution.sh"`（BUG-187） |
| **R3** | **为 R2 打的补丁习惯没有范围限定词** —— 「改了缺陷档要跑 check-bugs」退化成「提交前跑 check-bugs」 | 于是纯文档改动也照跑 |
| **R4** | **免检白名单只写在文档门禁那一节** —— `doc-first.md` §3.2 早已写「纯文档改动（`docs/**`）免检」，但它只覆盖**文档门禁**，没覆盖缺陷/代码门禁 | 本仓 7 个门禁**没有一张「改了什么 → 跑哪个」的对照表** |

> **R1+R4 合起来就是那句「完全脱离修改范围」**：没有对照表（R4）⇒ 靠记忆跑；
> 工具又不能按范围裁（R1）⇒ 一次误跑就是 6 分 39 秒。

---

## 1. 对照表（**唯一判据**，不靠记忆）

> 用法：`git diff --name-only` 拿到变更集 → 逐条查下表 → **只跑命中的**。
> 变更集**全部**落在 §2 免检白名单 ⇒ **不跑任何门禁**。

| 变更路径 | 必须跑 | 依据 |
|---|---|---|
| `docs/bugs/**`、`scripts/check-bugs.py` | `python scripts/check-bugs.py` | `AGENTS.md` §7 |
| `docs/review/**`，或任何含 `### D<n>.` 的 `docs/**` | `python scripts/check-decisions.py` | `AGENTS.md` §7 |
| `docs/**`（不含上面两类） | **无** | `doc-first.md` §3.2 免检档 |
| `download-engine/**`（Rust 源码/测试） | `cargo test`（在 `download-engine/` 下跑）+ `sh scripts/sync-sidecars.sh --check` | `AGENTS.md` §7 |
| `tauri-shell/src/**` | `node node_modules/typescript/bin/tsc --noEmit` + 构建 | `AGENTS.md` §7 |
| `tauri-shell/verify/**`、`download-engine/verify/**` | **无**（验收脚本自身免检） | `doc-first.md` §3.2 |
| 新增/修改 `scripts/check-*.py`、`docs/rules/*.md` | 同行**必须**带 `docs/design/*.md` 或 `docs/rules/*.md` | `doc-first.md` §3.1 **T5** |
| 提交信息本身 | `python scripts/check-commit-msgs.py`（commit-msg 钩子自动跑，无需手工） | `AGENTS.md` §7 |
| 仓库根新增文件 | `sh scripts/check-pollution.sh`（pre-commit 钩子自动跑，无需手工） | `AGENTS.md` §7 |

**反面例子（本次实测）**：变更集 = 3 个 `docs/**/*.md` ⇒ 查表得「无」，却跑了 check-bugs（6 分 39 秒）。

---

## 2. 免检档（与 `doc-first.md` §3.2 **逐字对齐**，不另立一套）

变更集**全部**落在下列白名单 ⇒ 直接 PASS，**不看任何门槛、不跑任何门禁**：

- `docs/**`、`*.md`
- `**/locales/**`（i18n 文案）
- `*.css`、纯样式/常量/拼写
- `download-engine/verify/**`、`tauri-shell/verify/**`（验收脚本、探针）
- `scripts/**`（**门禁脚本自身的修复**；**新增**门禁或改裁定走 §1 的 T5 行）

> **升档要求（沿用 `bug-registry.md` 的同一条）**：改动过程中若发现需要根因分析
> （例如「加个文案」背后是键名约定不一致），**必须就地升档**，不得留在免检档。

---

## 3. 工具侧保障（**让误跑不花钱**，不靠人记得）

**`scripts/check-bugs.py --changed` / `--base <ref>`**（2026-10-09 新增，**默认行为不变**）：

| 调用 | 变更集来源 | 行为 |
|---|---|---|
| `python scripts/check-bugs.py` | — | **全量扫描**（行为与改动前完全一致；CI 与人工核对继续用它） |
| `python scripts/check-bugs.py --changed` | `git diff --cached --name-only` | 变更集不含 `docs/bugs/`、也不含脚本自身 ⇒ **SKIP，退出 0** |
| `python scripts/check-bugs.py --base origin/main` | `git diff --name-only origin/main...HEAD` | 同上（CI 用） |

**设计口径**：作用域常量集中在脚本顶部的 `SCOPE_PREFIXES` / `SCOPE_FILES`（单一真源），
**改它必须同步本文件 §1**。取不到变更清单（无 git / 非仓库）时**退回全量**，不静默跳过。

**为什么是「工具裁」而不是「规则劝」**：本仓已有实测教训 ——
**靠人记得同步 = 没有**（`doc-first.md` E2：`docs/design/` 涨到 24 篇，索引始终是 0 行；
E11：钩子恒不生效）。规则只解决「知道该跑什么」，工具才解决「误跑也不疼」。

---

## 4. 反向证伪（**必须各自独立可证**，防「永远 SKIP」的假门禁）

| 用例 | 构造 | 必须 |
|---|---|---|
| **G1** | 暂存一个纯 `docs/design/*.md` | 打印 `SKIP`、**退出 0**、**不进入全量扫描**（实测约 **2.9 s** = Python 解释器启动开销，对比全量 **399 s**） |
| **G2** | 暂存一个 `docs/bugs/*.md` | **不得 SKIP** —— 必须真的进入全量扫描（用 `--quiet` 观察输出行） |
| **G3** | 不带任何参数 | **仍是全量扫描**（回归：新增开关不得改变默认行为） |
| **G4** | 暂存集为空 | `SKIP`、退出 0（不是 FAIL） |

> **G2 是这套设计里唯一能证伪「假门禁」的用例** —— 只有 G1/G3/G4 全绿、G2 真的跑起来，
> 才说明 SKIP 是**按作用域**裁的，而不是脚本坏了。

---

## 5. 纪律

1. **不许用「保险起见」作为跑门禁的理由。** 说不出「本次变更的哪条路径落在它的作用域里」，就是不该跑。
2. **跑门禁的代价要能被量化。** 本仓最慢门禁 check-bugs 实测 **399 s**（最慢一次 420.8 s）——
   把它跑在作用域外的改动上，是**纯浪费**，不是「稳妥」。
   （该门禁自身已按 `docs/bugs/BUG-247.md` 从逐次 spawn 改为批量：**916 次子进程 → 2 次，399 s → 2.8 s**。
   保留原数字是为了让「为什么要按作用域跑」这条论证可复核。）
3. **规范与实测不符时，以实测为准并订正规范。** `AGENTS.md` §7 的「本地钩子」列写的是**应有**行为；
   实装钩子是弱版本（R2）。在钩子修好前，`docs/bugs/**` 与决策清单的改动**必须手工跑**对应门禁 ——
   **只限这两类改动**。
4. **本文件只汇总既有条款，未新增裁定。** 它把散落在 `AGENTS.md` §7 / `doc-first.md` §3.2 /
   `bug-registry.md` 的分级思路**收敛成一张可执行对照表**；不改任何既有门禁的判据。

---

## 6. 关联

- `AGENTS.md` §7（门禁与自动化 —— 各门禁的覆盖范围）
- `docs/rules/doc-first.md` §3.1（T1–T5 门槛）/ §3.2（免检档，本文件 §2 逐字对齐）
- `docs/rules/bug-registry.md`（轻量档 / 升档要求）
- `docs/bugs/BUG-187.md`（实装钩子是弱版本 —— R2 的证据）
