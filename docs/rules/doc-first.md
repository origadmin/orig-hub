---
status: draft
author: 高见远（架构师）
date: 2026-09-29
topic: governance
module: docs
decided-by: —（待拍板 D1/D2/D3）
decided-at: —
landed-in: 无（scripts/check-docs.py 尚未创建，见 §8）
---

# 细则：先文档后代码 + 文档可继承（Doc-First）

> **权威链**：本文件是「文档如何被下一个 Session 认出来、接得上」的唯一真源。
> `AGENTS.md` §0 保留**必读集清单**，§7 保留**门禁接入**；本文件定义**字段、判据、脚本行为**。
> 机器门禁为 `scripts/check-docs.py`（待建，§5）。
>
> **为什么需要它（缺陷根因，一句话）**：
> **文档只有内容、没有可解析的状态与索引** —— 于是 24 篇设计文档对新 Session 而言
> 与 24 个无名文件等价：它无法判断哪份是当前真源、哪份已作废、哪份还在等裁定，
> 只能靠文件名猜，猜错就推翻重来。**「之前讨论出来的方案，新 Session 完全不认」不是记忆问题，是元数据缺失。**

---

## 0. 本轮实测取证（本规范的依据，可抽查）

| # | 事实 | 证据 / 复核方式 |
|---|---|---|
| E1 | `docs/design/` 有 **24 篇** md（不是 23） | `ls docs/design/*.md \| wc -l` = 24 |
| E2 | `docs/` **无 README.md、无 INDEX** | `ls docs/README.md` → No such file |
| E3 | `docs/overview.md` 是**某一次交付的交付记录**（标题「本轮交付：编辑器报错归因 + 门禁失效修复 + BUG-156 库定位纠错」），**不是文档地图** | `head -1 docs/overview.md` |
| E4 | 24 篇里 **13 篇完全没有状态字段**；有状态的 11 篇用了 **≥10 种互不一致的自然语言措辞** | 逐篇 `head -8`，见 §7.1 清单 |
| E5 | 唯一使用可解析词 `draft` 的只有 2 篇（`media-library-layout-design` / `media-library-layout-prd`） | 同上 |
| E6 | `episode-multi-source-design-2026-09-22.md`（806 行，含 T01–T05 与 D1/D2/D3）**无状态标记**；7 天后**仍未落地** —— 活的 `SeriesDetail.tsx:542-593` 仍是两个裸按钮（无质量信息、无锁定态），与那份设计 §5.1 描述的「改动后」形态完全不符 | 已复核 |
| E14 | **「未落地」的判据本身会踩坑**：`EpisodeExpanded.tsx` / `EpisodeBoard.tsx` / `EpisodeRow.tsx` / `EpisodePhotoGrid.tsx` / `SeriesHero.tsx` 是**零 importer 的孤儿**，拿它当证据会得出「有代码但没落地」的**误导性**结论。判组件死活必须查 importer（`grep -rn "from './X'" tauri-shell/src` 无命中 = 死） | 已复核（2026-09-29 由 PM 许清楚指出） |
| E7 | `scripts/check-decisions.py` 只扫 `docs/review/` 下文件名含 `decision`/`待拍板` 的 md —— **设计文档内嵌的 `### D<n>.` 从不被检查** | `check-decisions.py`: `REVIEW = docs/review`，文件名过滤 |
| E8 | 该脚本只校验决策项的**格式**（六段九条），**不校验状态/是否已裁定** | 同上，无 status 相关判据 |
| E9 | `AGENTS.md` §7 有 7 个门禁，**无一**检查「设计文档是否被跟进」 | `AGENTS.md` §7 表格 |
| E10 | `AGENTS.md` 无指向 `docs/design/` 的索引，也无「改代码前必须先有设计」的可执行判据 | `AGENTS.md` 全文 |
| E11 | **git 钩子恒不生效**（BUG-158，`core.hooksPath = NUL`） ⇒ **任何依赖钩子的方案都是假的** | BUG-158 |
| E12 | CI 现有 3 个 job：`Engine · tests + sidecar freshness` / `Shell · typecheck + build` / `Registry · bug tracking + commit policy` | `.github/workflows/ci.yml` |
| E13 | BUG-082 已确立「后续变更 = 追加节 + 历史锚定 + **不改写正文**」的惯例，但**不是强制规范** | BUG-082 |

> **E4 + E11 合起来就是根因**：状态靠自然语言写在正文里（E4）⇒ 脚本读不到 ⇒ 只能靠门禁强制；
> 而门禁若挂在钩子上（E11）⇒ 永远不跑 ⇒ 等于没有。
> **本规范的每一个判据，都必须能被一个不依赖钩子的脚本判定。**

---

## 1. 文档地图：单一真源 = `docs/README.md`

- `docs/README.md`（**待建**，模板见 §1.2）是**唯一**的文档入口。任何「文档在哪」的问题，答案只能是它。
- 索引**三维**：**主题**（topic）/ **模块**（module）/ **状态**（status）。三维都是**受控枚举**，不是自由文本。
- `docs/overview.md` **不**承担此职责（E3）；历史交付记录继续放 `docs/`，但**必须**在 README 索引里登记，避免再一次被误当成地图。

### 1.1 受控枚举

| 维度 | 取值 |
|---|---|
| `topic` | `media-episode` / `media-library` / `tg` / `storage` / `delivery` / `ux` / `governance` / `deployment` |
| `module` | `engine` / `shell` / `engine+shell` / `docs` |
| `status` | `draft` / `decided` / `implemented` / `superseded` |

### 1.2 `docs/README.md` 结构模板（照抄）

```markdown
# 文档地图（单一真源）

> 本文件由 `scripts/check-docs.py` 校验，**手工改动必须与 `docs/design/*` 实际一致**（门禁 C3）。
> 文档状态字段规格见 `docs/rules/doc-first.md`。

## 开工前必读（≤5 份，与 AGENTS.md §0 逐行一致，门禁 C4）
1. `AGENTS.md` — 规则判据
2. `docs/README.md` — 本文件
3. `docs/rules/doc-first.md` — 文档状态与先文档后代码
4. `docs/rules/decision-spec.md` — 待拍板项怎么写
5. `docs/bugs/README.md` — 缺陷索引速览

## 设计文档

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `docs/design/episode-multi-source-design-2026-09-22.md` | media-episode | engine+shell | draft | 2026-09-22 | 否 | 无（`SeriesDetail.tsx:542-593` 仍为裸按钮；`EpisodeExpanded.tsx` 是死代码，不作判据） |
| `docs/design/episode-segment-model-2026-09-29.md` | media-episode | engine+shell | draft | 2026-09-29 | 否 | 无 |

## 顶层文档
| 文档 | 主题 | 状态 | 日期 | 说明 |
|---|---|---|---|---|
| `docs/overview.md` | governance | superseded | — | **交付记录，不是文档地图**（E3）。勿当索引读 |

## 规则
| 文档 | 主题 | 状态 | 说明 |
|---|---|---|---|
| `docs/rules/bug-registry.md` | governance | implemented | 缺陷登记规格 |
| `docs/rules/decision-spec.md` | governance | implemented | 决策项六段九条 |
| `docs/rules/doc-first.md` | governance | draft | 本文件 |
```

**列的含义（不得自由发挥）**：

| 列 | 判据 |
|---|---|
| 状态 | 取自文档 front-matter `status`；**无 front-matter = `draft`**（§2.2 默认规则） |
| 已落地 | `status == implemented` ⇒ `是`；否则 `否` |
| 落地证据 | `landed-in` 字段原文；`implemented` 时**必须**非空（门禁 C1d） |

---

## 2. 状态标注规范（强制 front-matter）

### 2.1 字段规格

每篇 `docs/design/*.md` 与**被 README 索引的顶层文档**，文件最顶部必须是 YAML front-matter
（`---` 包裹，位于 `# 标题` **之前**）：

```yaml
---
status: draft | decided | implemented | superseded
author: <角色（姓名）>
date: YYYY-MM-DD
topic: <§1.1 受控枚举>
module: engine | shell | engine+shell | docs
decided-by: <谁拍板>          # status ∈ {decided, implemented, superseded} 时必填
decided-at: YYYY-MM-DD        # 同上
landed-in: <commit 短 hash | 代码位置 | 无>   # status == implemented 时必填且不得为「无」
superseded-by: <docs/ 下真实路径>            # status == superseded 时必填且文件必须存在
---
```

### 2.2 默认规则（**关键，立即生效**）

> **无 front-matter 的文档 = 视为 `draft`，且视为「从未被裁定、从未落地」。**

这一条把 E4 的 13 篇无状态文档**立即**纳入可判定范围，**不需要等补标完成**。
任何新 Session 看到「无 front-matter」就有确定答案：**这是草稿，不能当既成事实执行**。

### 2.3 状态机

```
draft ──(拍板)──> decided ──(落地 + landed-in)──> implemented
  │                  │                                │
  └──────(被取代)────┴────────────────────────────────┴──> superseded
```

| 迁移 | 条件 | 谁做 |
|---|---|---|
| `draft → decided` | 决策人对该文档的**全部** `### D<n>.` 给出裁定 | 决策人拍板后，由**作者或主理人**回填 `decided-by` / `decided-at` |
| `decided → implemented` | 代码已入库 | 实施者在提交时填 `landed-in`（commit hash 或 `file:line`） |
| `→ superseded` | 有更新的文档取代它 | 新文档作者填 `superseded-by` |

### 2.4 与 BUG-082「后续变更」惯例的关系

BUG-082 的「追加节 + 历史锚定 + **不改写正文**」是本规范在**正文层面**的对应物，**继续有效**：

- front-matter 的 `status` 变化 ⇒ **改 front-matter，不改写正文**；
- 设计被修订 ⇒ 在文末追加 `## 变更记录`（日期 / 谁 / 改了哪节的结论 / 为什么），**不删旧结论**；
- **`superseded` 的文档不删除**，只改 front-matter 并填 `superseded-by` —— 删掉历史会让下一个 Session 重新踩一遍（这正是本规范要治的病）。

---

## 3. 「先文档后代码」的可执行判据

> **不许写成口号。** 本节每一条都能被 `scripts/check-docs.py` 用 `git diff` 判定。

### 3.1 门槛：命中任一即**必须**同行带设计文档

| # | 门槛 | 机器判据（扫 `git diff <base>...HEAD`） |
|---|---|---|
| **T1 新增/改 schema** | diff 的 `download-engine/**/*.rs` 中出现 `CREATE TABLE` / `ALTER TABLE` / `pragma_table_info` | 正则命中 |
| **T2 新增 REST 端点** | diff 中**新增**形如 `"/api/..."` 的路由注册行 | 行首 `+` 且含 `"/api/` |
| **T3 新增能力入口** | diff **新增** `tauri-shell/src/components/**/*.tsx` 文件，或新增 `data-testid=` 常量 | 路径 + 内容 |
| **T4 新增/改数据模型** | diff 触及 `media_episode*` / `media_item*` 相关表结构或 `Episode*Ref` 类型定义 | 正则 + 路径 |
| **T5 改既有裁定** | diff 触及 `docs/rules/*.md` 或 `scripts/check-*.py` | 路径 |

**判据**：命中 ≥1 条门槛 **且** 变更文件集中**没有任何** `docs/design/*.md` / `docs/rules/*.md`
⇒ **FAIL**（退出码 1），并在输出里列出命中的门槛编号。

### 3.2 免检（EXEMPT）：与 `docs/rules/bug-registry.md` 轻量档**同一分级思路**

以下改动**不需要**同行带设计文档（与轻量档逐字对齐）：

- i18n 文案、常量、样式、拼写、单个 label、无逻辑分支的配置项；
- 纯文档改动（`docs/**`）；
- 单测、验收脚本、`verify_shots/`（ignored）；
- 门禁脚本自身的**修复**（但新增门禁需走 T5）。

**判据**：变更文件集**全部**落在白名单（`**/locales/**`、`*.css`、`*.md`、`docs/**`、
`download-engine/verify/**`、`tauri-shell/verify/**`、`scripts/**`）⇒ 直接 PASS，不看门槛。

> **升档要求（沿用 bug-registry 的同一条）**：改动过程中若发现需要根因分析
> （例如「加个文案」背后是键名约定不一致），**必须就地升为需设计文档**，不得留在免检档。

### 3.3 为什么这样能落地

- 判据输入只有两样：`git diff --name-only` 与 `git diff` 文本 —— **不依赖钩子**（E11），
  CI 里跑 `scripts/check-docs.py --base origin/main` 即可；
- 门槛是**白名单式穷举**，不是「重要改动要写文档」这种无法判定的表述；
- 免检档与既有轻量档**共用同一套措辞**，工程师不需要学第二套分类。

---

## 4. 门禁脚本设计：`scripts/check-docs.py`

### 4.1 职责与判据

| # | 判据 | FAIL 条件 | 级别 |
|---|---|---|---|
| **C1a** | status 合法 | front-matter 存在但 `status` 不在 §1.1 枚举内 | FAIL |
| **C1b** | 状态可判定 | 无 front-matter ⇒ 按 §2.2 **视为 `draft`**，**告警**并计入待补标清单；**但必须出现在 `docs/README.md` 里且状态列为 `draft`**（否则由 C3 抓） | WARN |
| **C1c** | **陈旧未落地** | `status == decided` 且 `decided-at` 距今 > `STALE_DAYS`（默认 **14** 天）且 `landed-in` 为空/为「无」 | FAIL |
| **C1d** | 状态字段自洽 | `implemented` 无有效 `landed-in`；`superseded` 无 `superseded-by` 或目标文件不存在；`decided`/`implemented` 缺 `decided-by`/`decided-at` | FAIL |
| **C1e** | 已落地仍有悬空决策 | `status == implemented` 的文档里存在 `### D<n>.` 块，且块内无 `**已裁定**:` 标记 | FAIL |
| **C2** | 先文档后代码 | §3.1 命中门槛 且 变更集无设计文档（需 `--base`，缺省 `origin/main`） | FAIL |
| **C3** | 索引双向一致 | `docs/README.md` 的行集合 ≠ `docs/design/*.md` ∪ 顶层白名单；或某行状态 ≠ 该文件 front-matter 状态 | FAIL |
| **C4** | 必读集不漂移 | `AGENTS.md` §0 的清单 ≠ `docs/README.md`「开工前必读」清单（逐行比较） | FAIL |
| **C5** | 待拍板项可拍板 | 复用 `scripts/check-decisions.py` 的解析器，对**所有** `docs/design/*.md` 中的 `### D<n>.` 块跑六段九条（**修补 E7 的盲区**：现在只扫 `docs/review/`） | FAIL（对 `RULE_FROM` 之后的文档） |
| **C6** | **证据不得指向死代码**（E14） | `landed-in` / 现状取证里出现 `tauri-shell/src/components/**/*.tsx` 的路径，而该文件在 `tauri-shell/src` 内**零 importer**（`grep -rn "from '<同名>'"` 无命中） | FAIL |

**宽容策略（必须，否则一上来就把 CI 锁死）**：

- `RULE_FROM = 2026-09-29`。此日期**之前**的存量文档，C1a/C1d/C5 只 **WARN** 不 FAIL（与 `check-decisions.py` 同思路）；
  C3 在 `docs/README.md` **不存在**时 **SKIP + 打印 TODO**（不 FAIL）—— 否则规范一发布就红。
- `--strict` 参数可把 WARN 升级为 FAIL，供补标完成后收紧。

### 4.2 用法与退出码

```sh
python scripts/check-docs.py                       # 全量（不含 C2 的 diff 判据）
python scripts/check-docs.py --base origin/main    #含 C2（CI 用）
python scripts/check-docs.py --strict              # WARN 升级为 FAIL
python scripts/check-docs.py --fix                 # 自动生成/刷新 docs/README.md 索引（D3 选项 A，见 §9）
```

退出码：`0` 通过；`1` 有 FAIL。

### 4.3 反向证伪：`scripts/verify_doc_first.py`（每个用例必须**各自 FAIL**）

| 用例 | 构造 | 必须 |
|---|---|---|
| V1 | 在临时 `docs/design/` 下造一篇**无 front-matter** 的文档 | C1b WARN + C3 FAIL（README 无此行） |
| V2 | 在 `docs/README.md` 里写一行**不存在的文件路径** | C3 FAIL |
| V3 | 造 `status: decided` + `decided-at` = 20 天前 + `landed-in: 无` | C1c FAIL |
| V4 | 造 `status: bogus` | C1a FAIL |
| V5 | 构造一个只含 `CREATE TABLE` 的 diff、无任何 `docs/` 改动 | C2 FAIL |
| V6 | 造 `status: implemented` + 文档里有未标「已裁定」的 `### D1.` | C1e FAIL |
| V8 | 在 `landed-in` 里写一个**零 importer 的孤儿组件**路径（如 `EpisodeExpanded.tsx`） | C6 FAIL |
| V7 | **合法全量**：每篇都有合法 front-matter + README 双向一致 + 无陈旧 decided + 免检改动 | **必须零报错，退出码 0** |

> 与 `scripts/verify_decision_spec.py` / `verify_light_tier.py` 同一形制：**每个反例各自独立跑、各自必须 FAIL，
> 且必须有一个正例必须零报错**（防「永远 FAIL」的假门禁 —— AGENTS.md §7 记过这个病）。

### 4.4 接入 `AGENTS.md` §7 与 CI（**不依赖钩子**）

**`AGENTS.md` §7 表格新增一行**：

| 门禁 | 脚本（单一真源） | 覆盖 | 本地钩子 | CI |
|---|---|---|---|---|
| 文档可继承 | `python scripts/check-docs.py --base origin/main` | 状态合法/陈旧未落地/索引双向一致/必读集不漂移/**先文档后代码门槛** | pre-commit（**尽力**，见下） | **`docs`** |
| 文档门禁证伪 | `python scripts/verify_doc_first.py` | 反向证伪：V1–V6 各自必须 FAIL；合法全量必须零报错 | — | `docs` |

**CI**：`.github/workflows/ci.yml` 新增 job，name: `Docs · inheritance + doc-first gate`（与现有三个 job 并列），
步骤：`python scripts/check-docs.py --base origin/main` + `python scripts/verify_doc_first.py`。

> **钩子声明（必须写清楚，别自我欺骗）**：本仓 git 钩子**恒不生效**（E11 / BUG-158）。
> pre-commit 行写「尽力」的含义是：`scripts/install-hooks.sh` 照旧安装，**但 CI 是唯一可靠的闸** ——
> 与 `AGENTS.md` §7 现有表述「CI 是最后一道闸（本地可被 `--no-verify` 绕过）」一致。
> **本规范的全部强制力来自 CI，不来自钩子。**

---

## 5. 新 Session 的最小必读集（≤5 份）

| # | 文档 | 为什么必读 |
|---|---|---|
| 1 | `AGENTS.md` | 规则判据（提交约定 / 代码约束 / 目录归属 / 门禁） |
| 2 | `docs/README.md` | 文档地图：现在有哪些设计、各自什么状态、哪份是真源 |
| 3 | `docs/rules/doc-first.md` | 本文件：状态怎么读、什么改动必须先写文档 |
| 4 | `docs/rules/decision-spec.md` | 待拍板项怎么写（六段九条），以及什么该自决 |
| 5 | `docs/bugs/README.md` | 缺陷索引速览：哪些坑已经踩过并修了 |

**放在哪里才能被自动发现（不依赖钩子）**：

| 位 | 作用 |
|---|---|
| **`AGENTS.md` §0「开工前必读」（新增，置于 §1 之前）** | **主位**。AGENTS.md 是 AI Agent 的天然入口，所有会话都会先读它。新 Session 在读到任何规则之前，先读到这 5 行 |
| `docs/README.md`「开工前必读」小节 | **副本**。从文档侧进入的会话在这里拿到同一份清单 |
| **门禁 C4** | **防漂移**：两处清单必须逐行一致，不一致即 FAIL |

**刻意不放的位置**（都验证过不可行）：

- ❌ git hook（BUG-158，钩子恒不执行，E11）；
- ❌ `.github/CONTRIBUTING.md`（本仓对 AI/Agent 目录零容忍，`AGENTS.md` §6；且 agent 不会主动读）；
- ❌ 只在某篇设计文档里写「下个会话请读我」（E6 已证明：写了也没人读得到 —— 因为**没有索引**）。

> **为什么不放在 README.md（仓根）**：仓根 README 是**产品**说明，且 `AGENTS.md` §6 规定仓库根只允许 4 个文件；
> 治理清单放仓根会被「根白名单」门禁反复打扰。放 `AGENTS.md` §0 是唯一既有强制力又零成本的位置。

---

## 6. 与既有规约的衔接（避免重复造规约）

| 既有规约 | 关系 | 本规范**不**重复什么 |
|---|---|---|
| `AGENTS.md` §3 缺陷追踪 | 缺陷走 `docs/bugs/` + `bug-registry.md`；**设计走 `docs/design/` + 本文件**。两者是两条链，不合并 | 不重定义 BUG 登记规格 |
| `AGENTS.md` §5 代码层约束 | §5 管「代码怎么改」，本规范管「改之前必须先有什么文档」。**§5 的判据不变** | 不新增代码层约束 |
| `AGENTS.md` §7 门禁与自动化 | 本规范在 §7 表格**加两行**（check-docs / verify_doc_first）与一个 CI job `docs`，不改现有 7 个门禁的行为 | 不动既有 7 个门禁 |
| `AGENTS.md` §8 汇报与决策约定 | §8 管「汇报里怎么写待拍板」，本规范管「待拍板有没有被裁定、有没有落地」 | 不重定义六段九条 |
| `docs/rules/bug-registry.md` | **等级思路复用**：其「轻量档」（i18n/常量/样式/拼写）直接成为本规范 §3.2 的免检档；其「升档要求」原样沿用 | 不新建缺陷登记档位 |
| `docs/rules/decision-spec.md` | 决策项的**写法**以它为准；本规范只补「决策项的**状态**」（是否裁定 / 是否落地 / 多久没落地要告警） | 不改六段九条，也不改 `check-decisions.py` |
| `scripts/check-decisions.py` | **作用域扩大**（E7）：本规范的 C5 复用其解析器，把 `docs/review/` 扩到 **所有 `docs/design/*.md`** | 不重写其解析逻辑 |
| BUG-082「后续变更」 | 正文层的历史锚定惯例 → 上升为 §2.4 强制条款 | 不改 BUG-082 本身 |

**一句话**：本规范只新增三件事 ——① front-matter 状态字段 ② `docs/README.md` 索引 ③ 一个门禁脚本。
其余全部复用既有规约。

---

## 7. 存量补标方案（**不**批量改写正文）

### 7.1 24 篇 `docs/design/*` 的现状与建议状态

> **纪律**：补标 = **只在文件最顶部插入 front-matter**，**一个字都不改正文**（§2.4 / BUG-082）。

| # | 文档 | 现有状态措辞（原文） | 建议 status | 谁补 |
|---|---|---|---|---|
| 1 | `blob-store-design.md` | 「已拍板，设计定稿，未实现」 | `decided` | 架构师 |
| 2 | `cache-root-unification-2026-09-28.md` | 「已定案，待批施工」 | `decided` | 架构师 |
| 3 | `ingest-pipeline-assessment.md` | 「评估完成，未实施」 | `draft` | 架构师 |
| 4 | `ingest-pipeline-redesign-assessment.md` | 「评估完成，未实施」 | `draft` | 架构师 |
| 5 | `media-library-layout-design-2026-09-28.md` | 「draft（待用户审 Q5 / 待工程师实施）」 | `draft`（已有词，补 front-matter） | 架构师 |
| 6 | `media-library-layout-prd-2026-09-28.md` | 「draft（待架构师拆解）」 | `draft`（同上） | PM |
| 7 | `play-to-ingest-design.md` | 「设计定稿，待实现」 | `decided` | 架构师 |
| 8 | `telegram-cache-storage-redesign.md` | 「设计分析，未实现」 | `draft` | 架构师 |
| 9 | `tg-media-ux-confusion-assessment-2026-09-22.md` | 「评估完成，待用户拍板」 | `draft` | PM |
| 10 | `tg-ux-assessment-summary.md` | 「评估完成，未开工」 | `draft` | PM |
| 11 | `tg-ux-implementation-plan.md` | 「方案就绪，未实施」 | `decided` | 架构师 |
| 12 | `episode-multi-source-design-2026-09-22.md` | **无任何状态行**（仅 日期/作者/范围/定位） | `draft` | 架构师（**本次已补，作示范样板**） |
| 13 | `bittorrent-extension-assessment-2026-09-29.md` | 无（性质/登记） | `draft` | 架构师 |
| 14 | `byte-ownership-amendment-2026-09-24.md` | 无（触发/定位） | `decided`（用户已裁定触发） | 架构师 |
| 15 | `ee-export-p6-2026-09-25.md` | 无（依据） | `draft` | 架构师 |
| 16 | `media-episode-image-handover-2026-09-28.md` | 无（「未动任何产品代码」） | `draft` | PM |
| 17 | `media-library-management-prd-2026-09-22.md` | 无（日期/角色/类型） | `draft` | PM |
| 18 | `media-service-deployment-decision-2026-09-28.md` | 无（触发/定位；D2 已拍板 A） | `decided` | 架构师 |
| 19 | `store-db-split-design-2026-09-29.md` | 无（「版本 v2.1」；D2-A 已拍板） | `decided` | 架构师 |
| 20 | `ROUND9-DESIGN-EVAL.md` | 无（范围） | `superseded` → 指向当轮落地档 | 主理人 |
| 21 | `tg-media-confusion-assessment-handover-2026-09-22.md` | 无（读者/目的） | `draft` | PM |
| 22 | `tg-ux-requirements.md` | 无（范围） | `draft` | PM |
| 23 | `tg-ux-tech-assessment.md` | 无（定位） | `draft` | 架构师 |
| 24 | `episode-segment-model-2026-09-29.md` | 有（本轮新建，`draft`） | `draft` | 已完成 |

### 7.2 补标口径（防止补标变成「重新解释历史」）

1. **只加 front-matter，不改正文一个字**（§2.4）。
2. **有疑义一律标 `draft`** —— 标 `decided`/`implemented` 需要可核验的裁定记录或代码位置；
   **标不实的状态比不标更坏**（它会让下一个 Session 把未定的东西当既成事实执行）。
3. `decided-by` / `decided-at` 只在**能给出裁定出处**时填；给不出就**留空**，`status` 相应退为 `draft`。
4. 补标是一次性动作，由**主理人授权**后执行；本轮**只**补 #12（已授权，作样板），其余只列清单。

### 7.3 已完成的示范样板

- `docs/design/episode-multi-source-design-2026-09-22.md` 已补 front-matter：
  `status: draft` + `decided-by/decided-at: —` + `landed-in: 无（未落地，活的 `SeriesDetail.tsx:542-593` 仍为裸按钮）`。
  ⇒ **这份 806 行、7 天前写好的设计，从此对新 Session 有确定答案：草稿、未裁定、未落地。**

---

## 8. 落地步骤（有序）

| 步 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| S1 | 本文件定稿 + `AGENTS.md` §0（必读集）+ §7（门禁行） | 待拍板 D1 | 待授权 |
| S2 | 建 `docs/README.md`（模板 §1.2）+ 生成 24 行索引 | S1 | 待授权 |
| S3 | 写 `scripts/check-docs.py`（C1–C5，宽容策略 §4.1） | S1 | 待授权 |
| S4 | 写 `scripts/verify_doc_first.py`（V1–V7） | S3 | 待授权 |
| S5 | CI 加 job `Docs · inheritance + doc-first gate` | S3+S4 | 待授权 |
| S6 | 24 篇批量补标（§7.1） | S1 + 主理人授权 | 待授权 |
| S7 | `--strict` 收紧（WARN 升级 FAIL） | S6 完成 | 待授权 |

> **本轮已完成**：本文件 + #12 的示范 front-matter。**其余步骤需授权后执行**（不擅自批量改写 23 篇文档）。

---

## 9. 待拍板清单

### D1. 「先文档后代码」的强制级别：CI 阻断，还是只告警？

- **问题**: §3 的门槛（新增表/列、新增 REST 端点、新增能力入口、改既有裁定）命中却无设计文档同行时 —— CI **直接失败阻断**，还是**只告警不阻断**？
- **现状与代价**: 现状**没有任何判据**（E9/E10）—— `AGENTS.md` §7 的 7 个门禁无一检查「设计文档是否被跟进」。实测后果：`episode-multi-source-design-2026-09-22.md`（806 行、含 T01–T05）写好 7 天，活的 `SeriesDetail.tsx:542-593` 仍是两个裸按钮，**设计文档与代码之间没有任何约束力**（E6）。不定 ⇒ 本规范的 C2 判据无法定级，S3 无法开工。
- **设计锚点**: `docs/rules/doc-first.md` §3.1（门槛）/ §4.1（C2）/ §4.4（接入）
  - 冲突: 无。但注意 **`AGENTS.md` §7 记过的病** —— 「pre-commit 曾无条件 `exec` 一个从未入库的脚本 → 恒 exit 127 把所有提交锁死」。故 C2 **必须**有 `--base` 与免检白名单（§3.2），否则会把正常提交锁死。
- **请求**: 选 A（我的建议）还是 B？

**A. CI 阻断（pre-commit 尽力 + CI job 强制）**
- 涉及: 新建 `scripts/check-docs.py`、新建 `scripts/verify_doc_first.py`、改 `.github/workflows/ci.yml`（新增 job `Docs · inheritance + doc-first gate`）、改 `AGENTS.md`（§0 必读集 + §7 门禁表）
- 量化: 2 个新脚本 + 1 个新 CI job + 1 处 AGENTS.md；5 条门槛 + 1 个免检白名单
- 回归风险: **低** —— 新增 job 与既有 3 个 job（`Engine`/`Shell`/`Registry`）并行，不改动既有门禁行为；C2 只在 `--base` 模式下跑
- 后果: 「改了表/加了端点却没设计文档」在 CI 上**红**，合不进 main。用户抱怨的「完全违反先文档后代码」获得可执行判据。可逆（删 job 即回退，不改任何产品代码）

**B. 只告警不阻断**
- 涉及: 同 A（脚本一样写），仅退出码策略不同（C2 违反时 `WARN`，退出码 0）
- 量化: 2 个新脚本 + 1 个 CI job + 1 处 AGENTS.md；与 A 同量
- 回归风险: **低** —— 不会锁死任何提交
- 后果: 与今天**实质相同**：告警会被忽略（E6 就是「写了文档也没人跟」的实测）。用户抱怨的问题不会改善，只是多了一份报告。可逆

**C. 不做（维持现状）**
- 涉及: 无
- 量化: 0 改动
- 回归风险: 无新增
- 后果: 「先文档后代码」继续是口号。已实测的代价：一份 806 行的设计 7 天未落地且无人发现（E6）。只要项目继续迭代，设计文档与代码的偏离会持续累积，新 Session 每次都要重新判断「哪份还算数」—— 这正是用户问题 4 的原话

---

### D2. 24 篇存量设计文档的补标：一次性全补，还是只补活跃档 + 归档其余？

- **问题**: `docs/design/` 下 24 篇 —— 13 篇完全没有状态字段、11 篇用了 ≥10 种互不一致的自然语言措辞（E4/E5）—— 是**一次性全量补 front-matter**，还是**只补近 30 天活跃的 N 篇、其余标 `superseded` 归档**？
- **现状与代价**: 现状脚本读不到任何状态（E4）。不定 ⇒ §2.2 的「无 front-matter = draft」虽已立即生效，但 24 篇里到底哪些**其实已落地**、哪些**其实已作废**，新 Session 无从区分 —— 文档地图建起来也是一张全是 `draft` 的表。**补标的真实成本是判断，不是编辑**：每篇要判断它是否已被后续工作取代。
- **设计锚点**: `docs/rules/doc-first.md` §2（状态标注规范）/ §7.1（24 篇清单与建议状态）
  - 冲突: 无。但受 §7.2 口径约束 —— **标不实的状态比不标更坏**，`decided-by`/`decided-at` 给不出出处的必须退为 `draft`。
- **请求**: 选 A（我的建议）还是 B？

**A. 一次性全量补标（24 篇，只插 front-matter）**
- 涉及: `docs/design/*.md` 24 篇（**仅在文件顶部插入 front-matter，正文一字不改**）、`docs/README.md`（24 行索引）
- 量化: 24 个文件各 +1 段 front-matter、1 份索引、0 行正文改动；预计按 §7.1 的「谁补」分给架构师 13 / PM 7 / 主理人 4
- 回归风险: **低** —— 纯插入，不改正文；`docs/` 不参与任何构建与门禁（除新增的 check-docs）
- 后果: 文档地图**一次建成**，C3（索引双向一致）与 C1c（陈旧未落地）立即有意义。风险是有几篇可能被标错 —— 由 §7.2 第 2 条（疑义一律 `draft`）兜住。可逆（删 front-matter 即回退）

**B. 只补近 30 天活跃的 N 篇，其余标 `superseded` 归档**
- 涉及: `docs/design/*.md` 中约 6–8 篇（2026-09-28/29 的）补 `draft`/`decided`，其余 16–18 篇**仅**标 `superseded` 并填 `superseded-by`
- 量化: 24 个文件同样各 +1 段 front-matter（**数量不省**），省的是**判断量**（其余不必逐个判定真实状态）
- 回归风险: **中** —— 把 2026-09-21/22 的评估档一律标 `superseded` 会**丢信息**：`tg-media-ux-confusion-assessment`（PM 症状清单）等仍被后续文档引用为上游（如 `episode-multi-source-design` 引 BUG-113）。标 `superseded` 会让新 Session 跳过它们，反而重踩
- 后果: 短期快；但「被引用为上游」的旧档被误标为已取代，是**用一个新的元数据错误替换旧的无元数据**。可逆（改 front-matter）

**C. 不做（不补存量，只对新建文档生效）**
- 涉及: 无
- 量化: 0 改动
- 回归风险: 无新增
- 后果: §2.2 默认规则兜底 —— 24 篇全部视为 `draft`，**不会误导**（安全），但也**不能告诉新 Session 哪份已落地**。文档地图变成一张 24 行全是 `draft` 的表，索引价值有限。若用户后续追问「之前的方案做没做」，仍要人工逐篇翻

---

### D3. `docs/README.md` 索引的维护责任：脚本自动生成，还是手工维护 + 门禁校验？

- **问题**: 24 行（且会持续增长）的索引 —— 由 `check-docs.py --fix` **自动生成并写回**，还是**手工维护**、由门禁 C3 校验双向一致？
- **现状与代价**: 现状**根本没有索引**（E2），且 `docs/overview.md` 被误当成地图（E3）。不定 ⇒ S2 无法定稿。注意 **C3 双向一致这条判据在两种方案下都存在**，区别只在「不一致时谁来修」。
- **设计锚点**: `docs/rules/doc-first.md` §1.2（README 模板）/ §4.1（C3）/ §4.2（`--fix`）
  - 冲突: 无。但两种方案对「表格里的人工列」（主题 / 落地证据）影响不同 —— 主题与落地证据**无法从 front-matter 自动推断全部**（`landed-in` 可自动带出，但 `topic` 需人工首次填）。
- **请求**: 选 A（我的建议）还是 B？

**A. 脚本生成 + 人工补列（`--fix` 写回）**
- 涉及: `scripts/check-docs.py`（新增 `--fix` 模式，读 front-matter 生成表格行）、`docs/README.md`（生成物）
- 量化: 脚本 +1 个模式、24 行自动生成、人工只需在 front-matter 里维护 `topic`/`landed-in` 两个字段
- 回归风险: **低** —— `--fix` 只重写「设计文档」与「顶层文档」两张表，不碰「开工前必读」与「规则」两节（C4 保护）；生成前先备份比对
- 后果: 索引**永不漂移**（文件增删即反映），人工零维护成本。代价：`topic` 仍需在 front-matter 里人工填一次（填错会被 C1a 拦下，不会静默）。可逆

**B. 手工维护 + C3 校验**
- 涉及: `docs/README.md`（纯手工）、`scripts/check-docs.py`（只有 C3 校验，无 `--fix`）
- 量化: 脚本少 1 个模式；但每次新增/删除设计文档都要**手工同步两处**（文件 + 索引），漏一次即 C3 FAIL
- 回归风险: **中** —— 与 E11 同一类病：「靠人记得同步」在没有钩子的环境里等于没有。实测本仓就是这个病：`docs/design/` 涨到 24 篇，**索引始终是 0 行**（E2）
- 后果: 门禁能抓到不一致（比现状强），但**每次都要人工补**——由 E2 实测（24 篇从未有过索引）看，这条路径大概率再次空转。可逆

**C. 不做（不建索引）**
- 涉及: 无
- 量化: 0 改动
- 回归风险: 无新增
- 后果: 「文档在哪」这个问题**没有答案**。新 Session 只能 `ls docs/design/` 然后靠文件名猜 —— 这正是 E6 的成因（806 行的设计躺在目录里 7 天没人知道）。用户问题 4「之前讨论出来的方案，新 Session 完全不认」**不会改善**

---

> **依赖顺序**：**D1 → D2 → D3**。
> D1 决定门禁是否强制（不强制则 D2/D3 的产出无人使用）；D2 决定存量底数（影响 D3 第一次生成的行数）；
> D3 决定索引怎么维护。**三者可按 D1 → (D2, D3 并行) 裁定。**
