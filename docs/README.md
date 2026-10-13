# docs 索引（唯一入口）

> **为什么有这个文件**：本目录有 40+ 篇设计/规则文档 + 182 条缺陷档。此前**没有任何索引**，
> 新会话只能 `ls docs/design/` 靠文件名猜哪份是当前真源、哪份已作废、哪份还在等裁定。
> 实测代价：`episode-multi-source-design-2026-09-22.md`（806 行、含完整任务分解）
> 写好 **7 天**无人跟进，期间两次重构都从零重判「剧集内页该怎么改」。
>
> **本文件只做一件事：告诉新会话「有哪些文档、讲什么、是否还生效」。**

---

## 一、新会话开工必读（5 份，按序）

| # | 文档 | 作用 |
|---|---|---|
| 1 | `AGENTS.md` | 协作约定（提交格式、分支铁律、代码约束、目录归属、门禁） |
| 2 | **`docs/README.md`**（本文件） | 文档地图 —— 不读它就会重判已有结论 |
| 3 | `docs/rules/decision-spec.md` | 待拍板项的强制结构（六段 + 9 条） |
| 4 | `docs/rules/bug-registry.md` | 缺陷登记规格 + 索引行规格 + 门禁行为 |
| 5 | `docs/bugs/README.md` | 缺陷索引（182 条，逐条可查） |

> ⚠️ **本必读集目前不会自动加载**。要让它被 Agent 自动发现，需要在 `AGENTS.md` 新增
> 一节 §0 指向本文件（**尚未授权，未改动**）。在授权前，本索引只能靠人工/会话内提示触达。

---

## 二、状态列怎么读

| 值 | 含义 |
|---|---|
| `draft` | 有 front-matter 且标为 draft，或**尚未裁定** |
| `decided` | 已拍板，未落地 |
| `implemented` | 已落地（`landed-in` 应给出 commit 或代码位置） |
| `superseded` | 已被后续文档取代（`superseded-by` 指新文档） |
| **`未标注`** | **该文档没有状态字段** —— 既不能视为生效，也不能视为作废。**用前必须人工核实** |

> 全量扫描实测（2026-09-29）：42 篇非缺陷文档中，**仅 3 篇有 `status:` 字段**
> （`episode-multi-source-design-2026-09-22.md` / `episode-segment-model-2026-09-29.md` /
> `doc-first.md`）。其余 39 篇为 `未标注`。
> **这不是本文件的缺陷，是文档缺元数据的现状** —— 补标需逐篇核实，不许猜。

---

## 三、设计文档（`docs/design/`，34 篇）

### 3.1 媒体库 · 剧集内页（**改这里之前必读**）

| 文档 | 主题 | 日期 | 状态 |
|---|---|---|---|
| `media-episode-image-handover-2026-09-28.md` | **当前剧集内页形态的规范真源**（左右主从 + 跑马灯 + 标题单行） | 09-28 | 未标注 |
| `media-library-layout-design-2026-09-28.md` | 媒体库整体布局设计 | 09-28 | 未标注 |
| `media-library-layout-prd-2026-09-28.md` | 媒体库布局 PRD | 09-28 | 未标注 |
| `media-library-management-prd-2026-09-22.md` | 媒体库管理 PRD | 09-22 | 未标注 |
| `episode-multi-source-design-2026-09-22.md` | 单集多视频源（多版本/主次/选主/归并）**未落地** | 09-22 | draft |
| `episode-segment-model-2026-09-29.md` | 一集 = N 个顺序片段（新需求，待裁定） | 09-29 | draft |
| `episode-internal-ia.md` | 剧集内页信息架构 PRD（问题池 + 分层） | 09-29 | 未标注 |
| `episode-internal-ia-v2-2026-09-29.md` | 剧集内页增量 PRD v2（左栏封面编辑 + 右栏主次重排；**冲突处以 v2 为准**） | 09-29 | 未标注 |
| `episode-cover-and-layout-2026-09-29.md` | 剧集封面替换 + 内页布局收敛增量设计（上游 = ia-v2；§6 待明确 X1–X3） | 09-29 | draft |
| `episode-binding-model-decision-2026-09-29.md` | 挂载模型重估：选「新增独立表」是否在堆债务（回答 segment-model §2.3 的 A） | 09-29 | 未标注 |
| `episode-source-and-library-ux-2026-09-29.md` | 来源区语义收敛 + 卡片可读性 + 选集器 N+更多 + 跳过片头（含 D1–D3 待拍板） | 09-29 | draft |

### 3.2 TG · 来源域

| 文档 | 主题 | 日期 | 状态 |
|---|---|---|---|
| `tg-media-ux-confusion-assessment-2026-09-22.md` | TG 媒体 UX 混乱评估（症状清单） | 09-22 | 未标注 |
| `tg-media-confusion-assessment-handover-2026-09-22.md` | 同上，交接版 | 09-22 | 未标注 |
| `tg-ux-assessment-summary.md` | TG UX 评估汇总 | — | 未标注 |
| `tg-ux-requirements.md` | TG UX 需求 | — | 未标注 |
| `tg-ux-tech-assessment.md` | TG UX 技术评估 | — | 未标注 |
| `tg-ux-implementation-plan.md` | TG UX 实施计划 | — | 未标注 |
| `telegram-cache-storage-redesign.md` | TG 缓存存储重设计 | — | 未标注 |

### 3.3 存储 · 数据

| 文档 | 主题 | 日期 | 状态 |
|---|---|---|---|
| `blob-store-design.md` | blob 存储设计 | — | 未标注 |
| `store-db-split-design-2026-09-29.md` | store.db 拆分设计 | 09-29 | 未标注 |
| `byte-ownership-amendment-2026-09-24.md` | 字节归属修正 | 09-24 | 未标注 |
| `cache-root-unification-2026-09-28.md` | 缓存根统一 | 09-28 | 未标注 |

### 3.4 入库 · 播放 · 部署

| 文档 | 主题 | 日期 | 状态 |
|---|---|---|---|
| `play-to-ingest-design.md` | 播放转入库设计 | — | 未标注 |
| `ingest-pipeline-assessment.md` | 入库流水线评估 | — | 未标注 |
| `ingest-pipeline-redesign-assessment.md` | 入库流水线重设计评估 | — | 未标注 |
| `media-service-deployment-decision-2026-09-28.md` | 媒体服务部署决策 | 09-28 | 未标注 |

### 3.5 其他

| 文档 | 主题 | 日期 | 状态 |
|---|---|---|---|
| `bittorrent-extension-assessment-2026-09-29.md` | BT 扩展评估（对应 BUG-174） | 09-29 | 未标注 |
| `ROUND9-DESIGN-EVAL.md` | 第 9 轮设计评估 | — | 未标注 |
| `ee-export-p6-2026-09-25.md` | EE 导出 P6 | 09-25 | 未标注 |

### 3.6 产品方向 · 依赖组件（**本节列格式 = `docs/rules/doc-first.md` §1.2 模板**）

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `product-direction-and-ffmpeg-2026-10-09.md` | governance | docs | draft | 2026-10-09 | 否 | 无（任务表 `PD-T01`~`PD-T05` 均未开工，见该文 §4.2；`decided-by: —`） |

> **本节与 §3.1~§3.5 的列不同是刻意的**：§3.1~§3.5（30 行）是补标前建的旧表（4 列，`主题` 列写的是自由描述），
> 尚未授权统一；**自 2026-10-09 起，本文所有新建/新改的表（§3.6、§四、§六）一律用 `doc-first.md` §1.2 的 7 列模板**
> （`主题`/`模块` 取 §1.1 的受控枚举）。存量 §3.1~§3.5 待 `doc-first.md` §7 的补标授权后一次性统一
> （避免一次改动 30 行引发与并行会话的冲突）。
>
> 本节现有文档一句话说明：
> - `product-direction-and-ffmpeg-2026-10-09.md` —— 产品主体重定位评估 + ffmpeg 组件化（安装/设置/提供服务）+ **可执行任务表 §4.2（`PD-T01`~`PD-T05`）** + 里程碑 M0–M4；含 3 条待拍板。

### 3.7 播放投递 · 性能架构（**改播放路径之前必读**）

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `playback-delivery-optimal-2026-10-13.md` | delivery | engine+shell | draft | 2026-10-13 | 否 | 无（任务表 `PBD-T01`~`PBD-T05` 均未开工，见该文 §5；`decided-by: —`） |

> 一句话说明：`playback-delivery-optimal-2026-10-13.md` —— 以本机实测（投递 TTFB/吞吐、编码吞吐、源编码分布、刷新率）
> 定位「全都卡」的结构性根因：**编码被放在了播放路径上**；提出「直解优先 + 编码类别闸门 + 帧率保真 + 原生倍速」的最优形态，
> 含可反向证伪的 A/B（PB-P1~P5）与 2 条待拍板。**与 BUG-230 的关系见其 §2.3（补前提，不改写旧结论）。**

### 3.8 引擎 · 锁 / 线程 / ffmpeg 插件化设置（**改引擎并发或 ffmpeg 配置之前必读**）

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `engine-lock-thread-ffmpeg-2026-10-13.md` | delivery | engine+shell | draft | 2026-10-13 | 部分 | 部分（**`ELT-T01` / `ELT-T03` 已于 2026-10-13 实施并实测**，见 `docs/bugs/BUG-293.md`；`ELT-T02` / `T04`~`T07` 未开工，见该文 §5） |

> 一句话说明：`engine-lock-thread-ffmpeg-2026-10-13.md` —— 用户 2026-10-13 点名三条（**锁 / 线程（像 TG 一样不卡线程）/ ffmpeg 插件化设置**）
> 的现状实测与规格：①两处真实锁缺陷（单飞表 `.expect("poisoned")` ⇒ 一处 panic 让**全部播放**请求 panic；`peer_cache` 锁跨网络 `.await`）；
> ②**先纠正「我们卡的不是线程」**（转码是子进程，卡的是**任务模型**：编码器在播放路径上 + 消费者阻塞反压死锁生产者，见 `BUG-293`）；
> ③ffmpeg **能力探测与硬解默认开启已实现**（PD-T06），缺的是**可设置**（UI / 持久化 / 显式后端 / 缓存可失效）。
> 含判据 `EL-P1`~`EL-P7`；**无新增待拍板** —— 用户已给方向（「插件模式 / 参数经设置 / 硬解可选 / 默认开启」），
> 依 `decision-spec.md` §四「目的已定 ⇒ 结论已定」不得回抛；§6 记「用户已定 + 工程师自决」，
> 唯一触及既有裁定（BUG-230 stream-first）的议题**指向** `playback-delivery-optimal-2026-10-13.md` §6，不另开。

### 3.9 入库流水线 · 事实层（**改入库状态/进度/补档之前必读**）

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `ingest-fact-layer-2026-10-13.md` | tg | engine+shell | draft | 2026-10-13 | 否 | 无（任务表 `IFL-T01`~`IFL-T07` 均未开工，见该文 §4；`decided-by: —`） |

> 一句话说明：`ingest-fact-layer-2026-10-13.md` —— 把用户 2026-10-13 的抱怨
> （**找不到下载中 / 命名 10 个入 2 个说完成 / 后续 N 个丢失状态 / 媒体库和 TG 整体逻辑混乱**）收成**一处**判断：
> **入库流水线缺的不是「状态」而是「事实」**（`total`/`done`/`error` 三个标量 + 一个裸 id 数组，
> 混了「缓存命中 / 图片不落盘 / 真下载」三种语义）。给出**一处增量**：**只读派生事实层**
> （`cache_task_items` + `series_declaration_gap` + 派生排序常量），
> **不新建表、不改状态机、不改 `CACHE_TASK_ACTIVE_STATES`**；含 `IFL-T01`~`IFL-T07` 任务表、
> 12 条可反向证伪判据、15 条红线。对应缺陷 `BUG-294` / `BUG-295` / `BUG-296`，
> 取证工具 `scripts/ingest_forensics.py`（A~I 九节）。**与 `ingest-pipeline-redesign-assessment.md`
> 的 `asset_state`（资产侧）互补不重叠**（见其 §7）。
>
> **同日修正（勘误）**：初版据 `total = 4` 推出「软件没有丢 8 个」，**已被用户纠正并撤回** ——
> 错因是拿应用自己的 `media_message` 当独立真值（被审系统的产物**结构上无法证伪丢失**）。
> 修正后新增 §2.5「状态词汇表 + 三个实测矛盾」（回应「整体逻辑混乱、基础使用无法流程」）、
> §3.1 两个新 state（`registered_unslotted` / `slotted_no_bytes`）、§3.5 媒体库侧出口、
> `IFL-T06`/`IFL-T07`、判据 9~12、红线 11~15。详见 `BUG-296.md` 的 `## 勘误`。

### 3.10 TG 源消息跳转（**改「在 TG 中查看」之前必读**）

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `tg-source-jump-2026-10-13.md` | tg | shell | draft | 2026-10-13 | 否 | 无（任务表 `TGJ-T01`~`TGJ-T04` 均未开工，见该文 §4；`decided-by: —`） |

> 一句话说明：`tg-source-jump-2026-10-13.md` —— 把用户 2026-10-13 报障
> （「**在 TG 中查看的实现有严重问题**，应**插件感知**：开启则应用内跳频道定位，未开启则**外部打开**」）
> 收成一处设计。取证：当前实现是**裸 `<a href target="_blank">`**（全仓仅 2 处，
> `SeriesDetail.tsx:1011-1022` / `:1052-1063`），而 `lib.rs` **无 `on_navigation`/`on_new_window`**
> ⇒ **桌面壳内没有可达通道**；外部打开**零新增权限**（`opener:default` 已含 `allow-open-url`）；
> 门控真源 = `store/selectors.ts::resolveTgFeatureReady`。设计 = **一处 store 增量**
> `pendingTgFocus`（与 `pendingMediaFocus` 同构）+ **一个判别式** `sourceJumpTarget`
> + 两个消费点（`SeriesDetail` 入口改 `<button>` / `TgPanel` 消费焦点）。
> 7 条可反向证伪判据、10 条红线。**是 `BUG-285` 的复报**（不新开号：285 的入口已落地但形态不成立）。

---

## 四、规则（`docs/rules/`）

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `code-constraints.md` | governance | docs | 未标注 | — | 否 | 无 |
| `bug-registry.md` | governance | docs | 未标注 | — | 否 | 无 |
| `decision-spec.md` | governance | docs | 未标注 | — | 否 | 无 |
| `doc-first.md` | governance | docs | draft | 2026-09-29 | 否 | 无（`scripts/check-docs.py` 尚未创建，见该文 §8） |
| `gate-scope.md` | governance | docs | draft | 2026-10-09 | 否 | 工具侧已落地：`scripts/check-bugs.py` 的 `--changed` / `--base`（见该文 §3）；规则侧待主理人确认 |

---

## 五、顶层文档（`docs/*.md`）

| 文档 | 主题 |
|---|---|
| `ACCEPTANCE.md` | 验收标准 |
| `DELIVERY_OVERVIEW.md` | 交付总览 |
| `DESIGN_BRIEF.md` | 设计简报 |
| `MEDIA-DESIGN.md` / `MEDIA-RULES.md` | 媒体域设计 / 规则 |
| `TG_CHANNEL_AGGREGATOR_DESIGN.md` | TG 频道聚合设计 |
| `TG_MEDIA_LIFECYCLE_DESIGN.md` | TG 媒体生命周期设计 |
| `EVALUATION-2026-08-26.md` | 早期评估 |
| `GIT-SAFETY.md` | Git 安全约定 |
| `overview.md` | ⚠️ **是某一次交付的交付记录，不是文档地图**（历史误用为地图的成因之一） |

---

## 六、评审 · 事故

| 文档 | 主题 | 模块 | 状态 | 日期 | 已落地 | 落地证据（commit / 代码位置） |
|---|---|---|---|---|---|---|
| `docs/review/media-tg-review-2026-09-22.md` | governance | docs | 未标注 | 2026-09-22 | 否 | 无 |
| `docs/review/pending-decisions-2026-09-22.md` | governance | docs | 未标注 | 2026-09-22 | 否 | 无（**早于 `doc-first.md`，缺 front-matter**） |
| `docs/review/product-direction-decisions-2026-10-09.md` | governance | docs | draft | 2026-10-09 | 否 | 无（D1/D2/D3 **三条均未裁定**，`decided-by: —`；阻塞 `PD-T03`/`PD-T04`/`PD-T05`） |
| `docs/incidents/INC-001-git-total-loss.md` | governance | docs | 未标注 | 2026-09-23 | 否 | 无（**事故取证档，不适用落地语义**） |

---

## 七、本文件的维护约定

- **不配门禁脚本，不加 CI job。** 理由：本仓已有 3 个 CI job，其中 `check-bugs.py`
  单项实测即需数十分钟；再加全量扫描型门禁会拖慢每一次提交，收益远小于成本。
  本索引的价值在「存在」而非「被强制校验」。
- **新建 `docs/design/*.md` 或 `docs/review/*.md` 时，两件事必须同时做**：
  ① 文件顶部写 `docs/rules/doc-first.md` §2.1 规定的**完整 front-matter**（不是只写 `status` 一行）；
  ② 在本文第三节（或第六节）按 **7 列模板**加一行，`状态` 取自该文件 front-matter、`已落地` 由 `status` 推出、
  `落地证据` 抄 `landed-in` 原文。**两处不一致即视为登记未完成。**
- **给存量文档补状态时，用 front-matter**，并把本表对应行的 `未标注` 换成真实值。
  补标只插 front-matter，**正文一字不改**；**疑义一律标 `draft`**
  （标一个不实的 `decided` 比不标更坏）。
- 本文件与 `docs/design/*` 的**双向一致性不做强制校验** —— 宁可索引偶尔滞后，
  也不要为了「索引永不漂移」而引入一个每次提交都跑的重量级门禁。
