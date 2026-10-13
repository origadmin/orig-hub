---
status: draft
author: 架构分析（AI 协作者）
date: 2026-10-13
topic: tg
module: engine+shell
decided-by: —
decided-at: —
landed-in: 无（`IFL-T01`~`IFL-T05` 均未开工；缺陷已登记 `BUG-294` / `BUG-295` / `BUG-296`）
---

# 入库流水线缺的是「事实层」—— 三条同源缺陷的统一设计（2026-10-13）

> **来源**：用户 2026-10-13 报障原话：「入库流水线 的下载中任务找不到，感觉还是要置顶。内容太多了。
> 还有很多命名是 10 个内容入了 2 个说完成了，后续 8 个丢失状态呢？完全是未知黑盒，
> **无法管控了解，补档**，这是严重的设计漏洞。」
>
> **本文的定位**：把用户的三句话收成**一个架构判断**，并给出**一处增量**的设计。
> 三句各自的现象/根因/判据在缺陷档里，本文不重复：
> `docs/bugs/BUG-294.md`（逐条状态）/ `BUG-295.md`（找不到 + 置顶）/ `BUG-296.md`（声明 vs 交付）。
>
> **本文不改代码**（用户 2026-10-10 定：纯文档任务，代码由别的组负责）。任务表见 §4。

---

## 0. 结论前置

**入库流水线缺的不是「状态」，是「事实」。**

用户说「无法管控了解、补档」。这两件事都需要**明细**，而流水线的明细**在每一层都被压成了标量**：

| 用户问的问题 | 需要的明细 | 库里实际有的 |
|---|---|---|
| 这 10 条里哪几条成了？ | 逐条结果 | `done = 2`（**一个计数**） |
| 哪几条从没试过？ | 逐条「未尝试」 | **什么都没有**（零记录） |
| 为什么停在这儿？ | 逐条原因 | `error = '应用重启：传输被中断，可重试继续'`（**一句固定文案**） |
| 标题说 EP1-10，够了吗？ | 声明范围 vs 实际 | `total = 10`（**本次发了 10 条消息**，与声明无关） |
| **媒体库里到底有几集？** | **条目有没有编进剧集** | **没有任何地方回答**（剧集视图从 `media_episode` 出发 ⇒ 未编入的条目**根本没有行**） |

⇒ 用户的抱怨是**同一根因的若干切面**（§2）。修法不是「多加几个字段」，而是
**把已经散落在六张表里的事实，做成一个可查询的「事实层」**（§3）。

> **勘误（2026-10-13 同日）**：本文初版把第 4 行写成「`total = 4`」，并据此推出
> 「软件没有丢 8 个」。**该推论错误，已撤回**（详见 `docs/bugs/BUG-296.md` 的 `## 勘误`）。
> 错因：拿应用自己的 `media_message` 当独立真值 —— 它是被审系统的产物，**结构上无法证伪丢失**。
> 用户报的那条任务（caption `EP1-10`、`total 10`）其相册**确有 10 条**；
> 而 **7 条登记了却从未编入剧集**，所以媒体库剧集视图只显示 3 —— 这正是用户说的
> 「媒体库只有 2 个，实际有 10 个」。**本节第 5 行就是这次修正补上的那一个缺失读数。**

**关键可行性结论**：这个事实层**可以完全派生，不需要新建表、不需要改状态机**。
所需事实**已经在库里**，只是没有出口 —— 这是本方案低风险的根本原因。

---

## 1. 现状：事实在哪，以及它被压成了什么

### 1.1 一次入队写下什么

`enqueue_cache_task`（`download-engine/crates/orig-tg/src/store.rs:1056`）只写：

```
items    = JSON([msg_id, ...])   ← 裸 id 数组，无结果
total    = message_ids.len()     ← 客户端本次发了多少条
done     = 0                     ← 一个计数器
status   = 'queued'
item_key = g:{chat}:{group} | m:{chat}:{msg0}
```

### 1.2 运行期只有三个标量在动

`run_one_cache_task`（`download-engine/crates/orig-tg/src/routes.rs:2452`）在循环里只更新
`done` / `current_id`，循环结束落一次终态。**`done += 1` 有三个落点，语义各不相同**：

| 落点 | 是否搬了字节 |
|---|---|
| 缓存命中（`cached_path`） | 否 —— 字节早在盘上 |
| photo 规则（`media_type == 'photo'`） | **否 —— 按 BUG-049 图片根本不落盘** |
| 下载成功（`cache_one_bytes`） | 是 |

⇒ 同一个 `done` 混了三种事实。**它连「搬了几条」都不等于。**

### 1.3 事实其实已经存在，只是散在六处

| 事实 | 真源 | 形态 |
|---|---|---|
| 这一批要处理哪些消息 | `cache_task.items` | JSON 数组 |
| 某条消息的字节到没到 | `media_item.file_path` + **磁盘 stat** | 行存在 / 不存在 |
| 某条消息是不是图片 | `media_message.media_type` / `media_item.kind` | 字符串 |
| 某条消息有没有被尝试过、烧了多少墙钟 | `cache_task_item_wall(task_id, message_id, accum_ms, started_at)` | **(task, msg) 主键 —— 已在** |
| **某条消息有没有被编入剧集** | `media_episode` ∪ `media_episode_image` ∪ `media_episode_source` | 行存在 / 不存在（**三表，缺一即误判**，见 §3.1） |
| 任务整体为什么停 | `cache_task.status` / `error` / `current_id` | 标量 |

⇒ **「从未尝试」= `items` 里有、`cache_task_item_wall` 里没有、`media_item` 无字节。**
这个判据今天就能算出来 —— 实测锚：`<task 183>`（`interrupted 2/10`，caption `EP1-10`）：

| 消息 | wall 行 | 字节 | 编入剧集 | 派生 state |
|---|---|---|---|---|
| `<3556>` | 有（`accum=117929ms`，已结束） | 有 | `sid=<370> ep=1` | `on_disk` |
| `<3557>` | 有（**`started_at` 非空 = 残留在途**） | 有 | `sid=<370> ep=2` | `on_disk`（+ 残留在途标记） |
| `<3558>` | 有（**残留在途**） | 无 | `sid=<370> ep=3` | `slotted_no_bytes`（= `BUG-254` 的态） |
| `<3559>`–`<3565>`（**7 条**） | **无 —— 零记录** | 无 | **无** | **`registered_unslotted` + `never_attempted`** |

⇒ 用户说的「**后续 8 个丢失状态**」就是最后这一格：**7 条有 `media_item` 行、无 wall 行、无剧集行**。
**三条读数（字节 / 尝试 / 编入）各管一段，缺任何一条都会把这一格说错。**

---

## 2. 三缺陷 = 同一根因的三个切面

| # | 用户原话 | 缺的是哪一面 | 编号 |
|---|---|---|---|
| 1 | 「下载中任务找不到…要置顶。内容太多了」 | **事实层的排序/聚合面** —— 该被置顶的语义集合漏了 `interrupted`；116 行无分区 | `BUG-295` |
| 2 | 「10 个内容入了 2 个说完成了」 | **事实层的「编入」面** —— `done N/N` 数的是「worker 走到第几条」，**不是「几条进了剧集」**；已登记未编入的条目**在剧集视图里没有行** | `BUG-296` |
| 3 | 「后续 8 个丢失状态…未知黑盒，无法管控了解，补档」 | **事实层的明细面** —— 任务内没有逐条状态 | `BUG-294` |
| 4 | 「**媒体库和 TG 整体逻辑**虽然实现，但是逻辑非常混乱，**基础使用都无法流程**」 | **事实层的词汇面** —— 两域各自派生同一件事，无权威（§2.5） | 三条共同的上位问题 |

**为什么必须一起做**：只做 3 ⇒ 用户能展开看到「7 条从未尝试」，但**找不到那一行**（1 未解）；
只做 2 ⇒ 用户知道「这 7 条没进剧集」，但**不知道各自什么状态、也不能补**（3 未解）；
只做 1 ⇒ 用户找到了那一行，**点开还是黑盒**（3 未解）。
三者的验收面**互相依赖**，故本文把它们收在一处设计。

### 2.5 为什么用户说「整体逻辑混乱，基础使用都无法流程」

> 这不是修辞。**同一个「内容」，五个界面各有一套状态，且没有一处是权威。**

| 界面 / 端点 | 真源 | 取值 | 与「这个内容能不能看」的关系 |
|---|---|---|---|
| TG 消息列表 | `media_message.downloaded` / `file_path` | 有 / 无 | 只说明**消息侧**的缓存路径 |
| 入库流水线 | `cache_task.status` | `queued`/`running`/`done`/`failed`/`interrupted`/`cancelled` | **与内容是否可看无关**（`done` 可以有 0 条进剧集） |
| 媒体库 items 视图 | `media_item.file_path` + stat | 有 / 无 | 与任务状态**可以矛盾**（`done` 却无字节） |
| 媒体库剧集视图 | `media_episode` ∪ `_image` ∪ `_source` | 有行 / 无行 | 与条目存在**可以矛盾**（条目在、**没有行**） |
| 播放器 | `/stream` 响应码 / `x-orig-stream` | 200 / 503 | 与上述四者**都可以矛盾** |

**实测三个矛盾（全部在产数据上复现）**：

1. `cache_task.status='done'` 而**该任务的条目 0 条进剧集**（`<task 72>`：`done 10/10`，0 条有槽位）。
2. `media_item` 有行、字节已在盘，而**三张认领表全空**（全库 **46 条** `video`）。
3. 同一个「不在剧集里」，**两个视图两种口径**：`list_media_items` 的 `unassigned`
   分支只排除 `media_episode`（`media.rs:1479`），于是把**集级挂图**也算成 unassigned
   —— 与 §3.1 的三表口径**不一致**（与 `BUG-255` 同源）。

⇒ **「基础使用无法流程」的机制**：用户按 A 界面得到一个结论，去 B 界面做动作，
B 的判据来自另一套派生 —— 两者不保证一致，且**不一致时没有任何一处报错**。
所以不是「某个功能坏了」，而是**同一件事有五个答案**。

⇒ **本文的派生事实层因此不只是一个新接口，而是两域之间的「唯一词汇表」**：
§3.1 的三表口径**必须**成为「条目是否编入剧集」的**唯一判据**，
其余四个界面**改为消费它**（或至少在派生层里对齐口径）。这是本节对 §3 的**新增约束**。

---

## 3. 设计：一处增量 —— 「派生事实层」

> **一句话**：新增一个**只读的派生层**，把 §1.3 的四处事实**按需拼装**成用户能问的两个问题：
> 「**这个任务的每条各自什么状态**」与「**这个剧集声明了几集、实际有几集、缺哪几集**」。

### 3.1 逐条事实（服务 `BUG-294`）

新增**只读**派生：`cache_task_items(task_id) -> Vec<{message_id, state, detail}>`

`state` 是**视图态**（不是状态机值，不进 `STATUSES`）：

| state | 判据 |
|---|---|
| `on_disk` | `media_item.file_path` 非空 **且磁盘 stat 命中** |
| `photo_no_bytes` | `kind == 'photo'`（按 BUG-049 规则**正常**，不是缺口） |
| `in_flight` | `cache_task_item_wall.started_at` 非空 |
| `failed` | 该 msg 出现在 `error` 的 `summarize_item_failures` 汇总里（**最多 10 条、每条 80 字符**，见 §6 红线） |
| `unknown_failed` | 任务 `failed` 但该 msg **不在**汇总里（汇总被截断）—— **不得渲染成成功** |
| `never_attempted` | **零记录**：不在 `cache_task_item_wall`、无字节 —— **用户说的「丢失状态」** |
| **`registered_unslotted`** | **有 `media_item` 行，但三张认领表全空** ⇒ 条目在库里、**媒体库剧集视图里没有它**（`BUG-296` 的核心受害态） |
| **`slotted_no_bytes`** | 已编入剧集但无字节（`BUG-254` 的态）—— 与 `registered_unslotted` **必须分开**：前者**有行可挂标记**，后者**连行都没有** |

**「已编入」的判据是且只是**：`media_episode` ∪ `media_episode_image` ∪ `media_episode_source`
三表任一命中该 `item_id`。
**只查 `media_episode` 会错**：混编组的照片（`BUG-168` 起作为集级挂图）与备用源会被误判成未编入
—— 实测把未认领数从 **96 虚报成 207**（与 `BUG-255` 同一教训：只看一张表就下结论）。

出口：`GET /api/tg/cache/tasks/:id/items`。
UI：任务行可展开（`data-testid="cache-task-items"`），并给**「只重试 `never_attempted` 的那几条」**
—— 这就是「补档」的直接落点；`registered_unslotted` 给**「补进剧集」**动作（复用 `BUG-261`/`BUG-279`）。

### 3.2 声明事实（`BUG-296` 的**第二面**：声明与入队条数从不 reconcile）

> 注意：`BUG-296` 的**主面**是 §3.1 的 `registered_unslotted`（条目没进剧集 ⇒ 媒体库看不到）。
> 本节是它的**第二面**：caption 的 `EPx-y` 与 `total` 从不比较。
> 本节**不**能用来证明「没有丢失」—— 它只证明「没有对账」（见 §0 勘误）。

新增**只读**派生：`series_declaration_gap(series_id)` =
`{declared: max(episode_no_end), actual: [episode_no...], missing: [...]}`

- 数据源：`media_episode(series_id, episode_no, episode_no_end)` —— **已存在**。
- **覆盖面必须如实暴露**：实测只有 **6/78** 个剧集有 `episode_no_end`
  ⇒ 其余剧集显示「**无声明**」，**不得**显示成「无缺口」（两者语义相反）。
- 任务侧：把「**本次入队 N 条**」（= `total`，事实）与「**频道声明 x–y**」（从标题解析，
  **标注为声明**）拆成两个读数，`N != (y-x+1)` 时给**中性**提示。
  **中性**很重要：实测 156 个声明范围的相册组里 **71 个对不上**，且**两个方向都有**
  （声明 EP1-9 而组内视频 1 条 / 声明 EP1-2 而组内视频 5 条）⇒ 那是**数据现实**，
  不是错误，**禁止**用「失败/缺失」这类定性词。

### 3.3 排序与聚合（服务 `BUG-295`）

- 新增**派生**常量 `CACHE_TASK_ACTIONABLE_STATES = ('queued','running','interrupted')`
  用于 `list_cache_tasks` 的 `CASE`（**不动** `CACHE_TASK_ACTIVE_STATES`，见 §6 红线）。
- UI 列表加**分区标题**（入库中 / 待重试 / 已入库 / 入库失败）；
  `SCOPE_TABS` 增「待重试 · N」档；统计条增第四段「待重试 N」。
- 复用**已有**的 `cache-batch-retry`（BUG-249）实现「待重试档 → 全选 → 批量重试」。

### 3.4 为什么「派生」而不是「落库」

| 方案 | 代价 | 判定 |
|---|---|---|
| **A. 派生（本文推荐）** | 每次读多几条 SQL；无迁移；**天然自愈** | ✅ |
| B. `items` 从裸数组改成对象数组（存逐条结果） | 存量 135 行的 `items` 全部要迁移；`items` 被多处当数组读 | ❌ 迁移面大、且把「结果」写死（与磁盘真实状态会漂移） |
| C. 新建 `cache_task_item` 表 | 新表 + 双写 + 一致性维护 | ❌ 而 `cache_task_item_wall` **已经是 (task_id, message_id) 主键**，再加一张同主键表是重复 |

**A 的关键理由**：`docs/design/ingest-pipeline-redesign-assessment.md` §2.5 踩坑 2 已经裁定过
同构问题 —— 「把派生值换成列就引入**永久谎言**（磁盘被手工删但状态没更新）；派生值天然自愈」。
本条**沿用该裁定**：字节态必须继续由 `file_path` + stat 派生。

### 3.5 媒体库侧的出口（`BUG-296` 主面的落点）

派生层解决了「**读得到**」，但 `BUG-296` 要求的是「**用户能看见并补上**」。
两条出口，**都不新建通道**：

1. **任务侧**：`registered_unslotted` 的条目在展开行里给「**补进剧集**」
   —— 复用 `BUG-261` 的 `episodeRecacheCandidates` / `canRecacheEpisode`。
2. **媒体库侧**：剧集详情页（`SeriesDetail`）需要一个**入口**指向「属于本剧但未编入的条目」，
   或至少在「入库流水线」页签内提供，**避免用户必须先去条目视图才能发现它们**。
   本条**不改**剧集视图的既有结构（`BUG-254` 的 `series-nobytes` / `episode-nobytes` 契约不动）。

**口径约束**：媒体库侧的任何计数**必须**来自 §3.1 的三表口径，
**不得**复用 `list_media_items` 的 `unassigned`（它只排除 `media_episode`，见 §2.5 实测 3）。

---

## 4. 任务分解（**全部未开工**）

| Task ID | 任务名 | 源文件 | 依赖 | 优先级 | 状态 | 负责 |
|---|---|---|---|---|---|---|
| `IFL-T01` | `cache_task_items` 派生查询 + `GET /tasks/:id/items`（含 `registered_unslotted`） | `download-engine/crates/orig-tg/src/store.rs`、`routes.rs` | 无 | P0 | 未开工 | — |
| `IFL-T02` | 任务行可展开 + 「只重试从未尝试」+「补进剧集」入口 | `tauri-shell/src/components/CacheManagerDialog.tsx` | T01 | P0 | 未开工 | — |
| `IFL-T03` | `CACHE_TASK_ACTIONABLE_STATES` + 排序 + 分区标题 + 「待重试 N」读数/档位 | `download-engine/crates/orig-tg/src/store.rs`、`CacheManagerDialog.tsx` | 无 | P0 | 未开工 | — |
| `IFL-T04` | `series_declaration_gap` 派生 + 剧集内页缺口呈现 + 补档入口 | `download-engine/crates/orig-tg/src/media.rs`、`routes.rs`、`tauri-shell/src/components/media/SeriesDetail.tsx` | 无 | P1 | 未开工 | — |
| `IFL-T05` | 任务行「本次入队 N 条 / 频道声明 x–y」双读数 + 中性提示 | `tauri-shell/src/components/CacheManagerDialog.tsx` | T04（共用解析） | P1 | 未开工 | — |
| `IFL-T06` | 媒体库侧出口：未编入条目可见 + 补档（口径 = 三表，**不得**复用 `unassigned`） | `tauri-shell/src/components/media/SeriesDetail.tsx`、`download-engine/crates/orig-tg/src/media.rs` | T01 | P1 | 未开工 | — |
| `IFL-T07` | **口径统一**：`list_media_items` 的 `unassigned` 改为三表口径（消除 §2.5 实测 3） | `download-engine/crates/orig-tg/src/media.rs` | T01 | P2 | 未开工 | — |

**排序理由**：T01/T03 互不依赖且都是 P0（T01 解决「黑盒」，T03 解决「找不到」），可并行；
T02 依赖 T01；T04/T05 是「声明 vs 交付」，晚于前两条；T06 是 `BUG-296` 的**用户可见出口**，
依赖 T01；T07 是**一致性收口**（`BUG-255` 同源），可最后做但**不可省略** ——
否则 §2.5 的「两个视图两种口径」会一直存在。

> **待拍板（≤3 条）**：① `interrupted` 是排在 `running` **之前**还是同桶按 `priority` 排？
> ② 未编入条目的补档入口放**剧集详情页**还是**入库流水线页签**（`IFL-T06` 的落点）？
> ③ T05 的「中性提示」是否本期就做（**建议先不做**，等 T01~T04 落地后再评估）。

---

## 5. 判据（可证伪，预先声明）

| # | 判据 | 反向证伪（必须 FAIL） |
|---|---|---|
| 1 | `<task 183>` 的 `never_attempted` == **7**，且逐条 state 与 §1.3 的表**逐格一致**（`on_disk` 2 / `slotted_no_bytes` 1 / `registered_unslotted`+`never_attempted` 7） | 把派生改成只读 `done` 计数 ⇒ 逐条列表必空；把「编入」判定改成只查 `media_episode` ⇒ `<3558>` 与 `<3559>` 会同态 ⇒ FAIL |
| 2 | `<series_id>` 的缺口 == `[9,10,11,12,13,14,15]` | 把 `declared` 取成 `count(*)` ⇒ 缺口必为 0 |
| 3 | `priority>0` 的 `done` 与 `interrupted` 同库时，**后者排在返回序更前** | `CASE` 改回 `CACHE_TASK_ACTIVE_STATES` ⇒ 必落其后 |
| 4 | 重启 `orig-tg` 后逐条列表**逐条一致**（`never_attempted` 集合不变） | 逐条状态改成只存内存 ⇒ 重启后必全退化成 unknown |
| 5 | 无 `episode_no_end` 的剧集显示「**无声明**」，与「有声明且无缺口」**可区分** | 把两者都渲染成「无缺口」⇒ FAIL |
| 6 | 对 71 个「组内视频数 != 声明集数」的组，UI **不出现**「失败/缺失」定性词 | 出现即 FAIL（那是数据现实） |
| 7 | **不回归**：`GET /:id`、`/all`、`by-item`（BUG-279）、批量条（BUG-249）、优先级（BUG-277）响应字段一个不减；`check-bugs.py` 既有 4 项 ERROR 不增 | — |
| 8 | **UI 真实渲染**（CDP，禁读 className、用 `data-testid`）：`never_attempted` 条数与判据 1 一致 | — |
| 9 | `<task 183>` 派生 == `已编入 3 / registered_unslotted 7 / 无条目 0`（实测锚） | 认领判定改成**只查 `media_episode`** ⇒ 全局未认领数必须 **96 → 207**；若不变则三表口径未生效（假绿） |
| 10 | `<task 72>`（`done 10/10`、0 条进剧集）的摘要 == `已编入 0 / registered_unslotted 10`；接口**不得**报「全部已入库」 | 把 `done` 当编入数 ⇒ 必报 10/10 ⇒ FAIL |
| 11 | 全库 **46 条**「`video` 有字节且未认领」**存在用户可达的界面**能看到并发起补档；该界面计数 == 三表口径 | 该界面改用 `unassigned`（只排除 `media_episode`）⇒ 计数必 ≠ 46 ⇒ FAIL |
| 12 | `slotted_no_bytes`（`BUG-254` 的态）与 `registered_unslotted` 在派生层是**两个不同 state**，任何界面**不得**合并成一个 | 合并 ⇒ `<3558>` 与 `<3559>` 会同态 ⇒ FAIL |

**复现工具**：`python scripts/ingest_forensics.py --api-port 0`（只读；A~I 九节；
带**硬断言**防静默少报 + **反向证伪**：错 `--db` 退出 2、错 `--api-port` 必须报「取不到」而非「0 行」、
`_claimed()` 改单表 ⇒ 未认领数 96→207）。

---

## 6. 红线 / 不变量（改动前必须逐条对照）

1. **不得修改 `CACHE_TASK_ACTIVE_STATES`**（`store.rs:186`）。
   它被**入队去重**（`active_cache_task` `:1121` / `active_cache_task_covering` `:1143`）、
   **运行判据**（`is_cache_task_active` `:1523`，`run_one_cache_task` 每个条目都问一次）、
   **部分唯一索引**（`cache_task_active_uniq ... WHERE status IN ('queued','running')`）
   三方依赖。改它 = 改入队语义 = 撞 `BUG-279` 契约。要置顶 `interrupted` ⇒ **加派生常量**。
2. **不得改 `total` 的语义**（`= message_ids.len()`）。改成「声明集数」会让 `done/total`
   变成两个不同单位的比 —— 那是制造第二个 `BUG-294`。
3. **不得新增状态机值**。`STATUSES` 六态不动；`state` 是**视图态**，只活在派生层。
4. **不得改 `mark_stale_cache_tasks` 的语义**（`running → interrupted` 是 `BUG-257` 的裁定：
   重启必须降级，否则 UI 卡在永不推进的假「缓存中」）。
5. **不得推翻 `BUG-220`**：剧集行的状态判别**不携带失败原因**。
   本方案的展开面是**入库流水线任务行**，与剧集行是**两个 surface**。
6. **不得把 `summarize_item_failures` 的截断当成完整事实**：它 `MAX_LISTED = 10`、
   `MAX_REASON_CHARS = 80`（`routes.rs:2428-2429`）。超出的必须给 `unknown_failed`，
   **不得**渲染成成功。
7. **不得把「无声明」与「无缺口」混为一谈**（实测只有 6/78 个剧集有声明范围）。
8. **不得为 `photo` 造缺口**：图片按 `BUG-049` 规则**不落盘是设计**（实测 145 条 photo 无字节）。
9. **不得新建同主键表**：`cache_task_item_wall` 已是 `(task_id, message_id)` 主键。
10. **`retry_cache_task` 归零 `done` 的行为不改**，但派生层必须让**已在盘的条目仍为 `on_disk`**
    （即派生**不得**依赖 `done`）。
11. **「已编入」必须三表口径**（`media_episode` ∪ `media_episode_image` ∪ `media_episode_source`）。
    只查一张表是**实测踩过的错**（96 虚报成 207），且与 `BUG-255` 同源。
    **不得**为了「看起来干净」而把挂图/备用源排除在外。
12. **不得回退 `BUG-248` 的登记时机**（入队即登记 `media_item`）。
    本方案要的是**把「登记了但没编入」显式化**，**不是**「不登记」。
    回退会让 `BUG-170`「先入信息、再入字节」重新失守。
13. **不得把 `registered_unslotted` 与 `slotted_no_bytes` 合并**：
    前者**没有行**（`BUG-296`），后者**有行无字节**（`BUG-254`，已有 `series-nobytes`/`episode-nobytes` 契约）。
    合并会让 `BUG-254` 的标记无处可挂、且把「看不到」说成「看得到但没缓存」。
14. **不得用被审系统自己的产物当独立真值**（`BUG-296` 的勘误教训，**写成规范**）：
    凡断言「有没有丢东西」，真值必须来自**被审系统之外**（TG 侧扫描 / 客户端发来的 `items`），
    **不得**用 `media_message` / `media_item` 这类由本应用填充的表去证明本应用没丢东西。
15. **不得把 §2.5 的口径分歧当「已知差异」留着**：`list_media_items` 的 `unassigned`
    必须收口到三表口径（`IFL-T07`）。留着 = 用户继续得到两个答案。

---

## 7. 关联

- 缺陷档：`docs/bugs/BUG-294.md`、`docs/bugs/BUG-295.md`、`docs/bugs/BUG-296.md`（本方案的判据来源）
- **本条不推翻的既有裁定**：`BUG-248`（入队即登记，`routes.rs:2004` `register_enqueued_items`）
  与 `BUG-170`（先信息后字节）—— 本方案**沿用**，只是把它们的另一半（登记了但没编入）显式化。
- **同源的口径错误**：`BUG-255`（`episodeCount` 漏算 `media_episode_image`）——
  与 §2.5 实测 3 的 `unassigned` 口径同源：**只看一张表就下结论**。本方案 §3.1 的三表口径是共同修法。
- **相邻但不同层**：`BUG-254`（无字节内容三处不可辨）—— 它是「有槽位、无字节」，
  本方案要新增的 `slotted_no_bytes` / `registered_unslotted` **必须分开**（§6 红线 13）。
- **叠加构成「整体混乱」**：`BUG-292`（同一相册建成两个剧集、`media_item` 被两条 `media_episode` 认领；
  双 `group_id` 真相 —— 实测每个任务的 `cache_task.group_id` 与消息自带 `group_id` **差 1**）
  与本方案**叠加**：重复剧集 + 未编入条目，共同构成用户说的「媒体库和 TG 整体逻辑混乱」。
- **已实现但未收尾**：`docs/bugs/BUG-279.md` —— `cache_task_for_item`（`store.rs:1185`）、
  `/api/tg/cache/tasks/by-item`、`episodeCacheStatus`（`mediaSources.ts:181`）**均在 `HEAD`**，
  但索引仍标 `open`。它是**条目 → 任务**（反方向）；本方案**必须与它共存**，不得改动其语义。
  **它回答不了「这条任务哪几条没进剧集」** —— 缺的正是 task → item 这个方向（`IFL-T01` 补上）。
- **并行在途**：`BUG-276`（条目墙钟跨重启）—— 工作区已见未提交的
  `begin_item_wall_attempt` / `end_item_wall_attempt` / `item_wall_elapsed_ms` / `clear_task_item_walls`。
  **`IFL-T01` 依赖 `cache_task_item_wall`，落地前必须与该改动对齐**。
- 既有裁定沿用：`BUG-257`（重启降级 + 不弃单）、`BUG-249`（批量条）、`BUG-277`（优先级）、
  `BUG-220`（剧集行不带失败原因）、`BUG-049`（图片不缓存）、`BUG-280`（标题两遍选取）、
  `BUG-232 v2`（标题数据源是 `media_message`）。
- 同域设计文档：
  - `docs/design/ingest-pipeline-redesign-assessment.md`（**未实施**）—— 其 `asset_state`（资产侧状态）
    与本方案的「逐条事实」（流水线侧）**互补不重叠**；其 §2.5 踩坑 2「保留派生、不要换列」被本文 §3.4 沿用；
    其 §4.1 裁定 ①「未就绪条目默认不进媒体库主网格」是本文 UI 落点的前提约束。
  - `docs/design/ingest-pipeline-assessment.md`（文件命名 / 磁盘真值 / `.part` 残留）
  - `docs/design/play-to-ingest-design.md`（播放转入库）
  - `docs/design/telegram-cache-storage-redesign.md`（缓存存储）

---

## 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-10-13 | 初版：由用户当日三条抱怨（找不到 / 说完成 / 丢失状态）收成「缺事实层」一处判断，给出派生事实层设计与 `IFL-T01`~`IFL-T05` 任务表；登记 `BUG-294`/`295`/`296`；新增只读取证工具 `scripts/ingest_forensics.py` | 架构分析（AI 协作者） |
| 2026-10-13 | **同日修正（勘误）**：用户纠正「事实上丢失，媒体库只有 2 个，实际有 10 个」—— 初版据 `total = 4` 推出的「软件没有丢 8 个」**错误，已撤回**。新增 §0 勘误、§2 第 4 面、**§2.5 状态词汇表与三个实测矛盾**（回应用户「整体逻辑混乱、基础使用无法流程」）、§3.1 两个新 state（`registered_unslotted` / `slotted_no_bytes`）、**§3.5 媒体库侧出口**、`IFL-T06`/`IFL-T07`、判据 9~12、红线 11~15；复现工具扩到 A~I 九节（新增 H/I 节，含三表口径与硬断言） | 架构分析（AI 协作者） |
