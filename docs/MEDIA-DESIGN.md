# 媒体域最终设计（三模块分离）

> 单一真源，取代前稿。规则层见 `MEDIA-RULES.md`（S0–S5），本文是**形态 + 逻辑链 + 实施计划**。
> 逻辑只依赖结构与类型，禁止依赖内容。缓存是一次性的，库是持久的。
> 证据行号基线：`tauri-shell/src/components/*`、`download-engine/crates/orig-tg/src/*`。

## 0. 模块边界（先定边界，再谈形态）

| 模块 | 职责 | 禁区 |
|---|---|---|
| **M1 展示**（TG 面板） | 只读 TG 消息，渲染记录；发起"入队"请求 | 不判缓存态、不写库、不读剧集 |
| **M2 缓存**（后端 `/api/cache/*`） | 过程态：取字节 + 任务状态 | 不认剧集、不认 TG 会话语义；不持有事实 |
| **M3 媒体库**（`/api/media/*`） | 唯一事实源：条目 / 剧集 / 来源 | 不依赖 TG 会话；不持有过程态 |

**唯一调用方向**：M1 →(入队)→ M2；M2 →(登记事实/回填字节)→ M3；M1、播放页只读 M3 状态。

### 缓存归属三方案评估（用户点名项）

| 归属 | 含义 | 优势 | 代价 | 结论 |
|---|---|---|---|---|
| **纯 TG 端（现状）** | 缓存端点挂 `/api/tg/cache/*`（routes.rs:43-58），逻辑散在 routes/store/state | TG 场景一次做通 | 媒体库要读缓存态必须**反依赖 TG**；清理链分裂（`/api/tg/cache/clear` 名不副实）；换数据源即废 | ✗ |
| **媒体库端** | 缓存 = `media_item.file_path` 属性，端点挂 `/api/media/*` | 事实态天然单一 | 下载过程态（任务/进度/重试/并发）不属于库语义；TG 侧被迫读媒体库端点 | ◐ **部分采用**：事实态归库 |
| **纯后端独立模块（采用）** | `/api/cache/*`，只管"把字节取到本地"+任务状态，不认 TG、不认剧集 | 两端都能消费；清理链唯一；过程态不外泄；数据源可替换 | 需适配层：TG 消息 → cache job | ✓ **采用** |

**最终结构**：`media_item.file_path` 是**事实态**（有没有字节）；`cache_task` 是**过程态**（正在取字节）。
两者分离但单向写入：过程只改字节与任务行，事实只由 M3 变更。

---

## 1. M1 展示形态（TG 面板）

### 1.1 一条记录的四类数据

| 数据 | 现状 | 设计 |
|---|---|---|
| **标题** | FeedItem 无 title 字段（TgPanel.tsx:131-160） | 取 caption 首行，单行截断；无 caption 时**不显示标题行**（不编造） |
| **介绍** | caption 全量渲染不截断（1518-1522 / 1738-1742） | 折叠为 ≤3 行 + 展开；`whitespace-pre-wrap` 保留 |
| **内容** | 固定 `aspect-square` + `object-contain`（tgmedia.ts:94-104 / TgPanel.tsx:1696,1708）→ **留白的直接成因** | 动态拼图（§1.2） |
| **标签** | 完全未解析、未渲染（全文件无 hashtag） | 解析 `#tag` 渲染 chip，**仅展示**，永不参与逻辑（S4） |

### 1.2 内容区动态组合（替换 `albumGridClass`）

**上限 9**：>9 折进第 9 格 `+N`（`ALBUM_MAX_TILES=9`，保留）。

算法 `layoutTiles(tiles, W)`（新增于 `lib/tgmedia.ts`，替换 tgmedia.ts:94-104）：

1. 每 tile 需 `w/h`；缺失时回退：**图片 3:4、视频 16:9**（后端补元信息后走真实值，见 §6-P1）。
2. **单 tile**：占满容器，格比例 = 图片比例，高度夹取在 `[0.5W, 1.0W]` → 无留白。
3. **N ≥ 2**：justified rows —— 按 `r = w/h` 贪心累加，累计 r 使行高 `H = W / Σr` 落入目标带 `[W/3.2, W/2.2]` 即换行；行内宽度 `wi = H · ri`；**末行允许 1.0~1.15 倍拉伸**补齐整宽（避免 7 图的 `3+3+1` 瘸腿空洞）。
4. 每格 `object-cover` 填满分配格（格比例≈图片比例，实为无裁切，仅吸收浮点误差）。
5. 输出 `rows: [{ height, tiles: [{ width, tile }] }]`，React 逐行渲染。

**明令禁用**：写死 `aspect-square`、`grid-cols-2/3`、固定几何内的 `object-contain`。

### 1.3 状态契约收敛（四套 → 一套）

现状四套真源：`downloadedPaths`(445-467) / `photoLibRefs`(749-770) / `cacheTask`(509-537) / `item.downloaded`(143)，
写入时机不同 → 状态打架。

**收敛为**：`GET /api/media/state?refs=tg:123:456,...` → `{ [ref]: { itemId, inLibrary, cached, task?: {status, done, total} } }`。
M1 显示层只认这一个响应；按钮状态机严格按 kind（video：`缓存 → 缓存中 → 已缓存·播放`；photo：`加入媒体库 → 已入库`）。

### 1.4 组件分层（1957 行拆层）

`TgPanel` 拆为：容器（取数/轮询）→ 记录列表 → 单记录 `MessageBubble` → 组记录 `AlbumBubble` → `MediaTile`（纯展示）。
取数与展示不得同处一个组件。

---

## 2. M2 缓存模块（冲突失败点与逻辑链修复）

### 2.1 当前冲突/混乱点（证据）

| # | 问题 | 证据 |
|---|---|---|
| C1 | `/api/tg/cache/clear` 名不副实：只清 dialog 列表缓存，不动文件、不动 `file_path` | routes.rs:538-546 |
| C2 | 状态四套真源，写入时机不同 | store.rs:254-268 / 285 / media.rs:32-46 / TgPanel:143 |
| C3 | `upsert_media_item` 用 `COALESCE(excluded.file_path, 旧值)`——传 NULL 时**旧路径被粘住**，清缓存无法置空 | store.rs:616 |
| C4 | 下载成功但入库失败只记日志，`downloaded=1` 保留 → "已缓存未入库" | routes.rs:846-849 |
| C5 | 两条独立清理链（clear_stored / delete_media_item）非事务 → 孤儿文件、悬空 `file_path`（`local_file` 已有 404 兜底=承认存在） | routes.rs:1573-1592 / 1884-1902 / 628-630 |
| C6 | `cache_task.dir` 建表但未读；状态是字符串约定，无 DB 约束 | store.rs:285-301 / 151 / 113 |
| C7 | 缓存业务横跨 routes/store/state 三文件，与 TG 同 router、同 AppState、同 conn | lib.rs:17-28 / store.rs:88-89,308 |

### 2.2 修复后的逻辑链（顺序固定，不可跳步）

```
入队(幂等 item_key) → 登记事实(条目先存在) → 取字节(仅 video 落盘) → 回填 file_path → 终态显式
```

1. **入队**：`POST /api/cache/tasks`，唯一索引保证同 item_key 只有一条活跃任务（保留 store.rs:300-301）。
2. **事实先登记**：入队即 `import item`（photo：`file_path=NULL`；video：`file_path=NULL` 待回填）——
   任何时刻条目都可查，杜绝"缓存了没入库"。
3. **取字节**：worker **只看 kind**（S1）：video 下载落盘；photo 跳过（routes.rs:1143-1156 现有分支保留）。
4. **回填**：`file_path` 用**专用语句**更新（不走 COALESCE，修 C3）。
5. **失败**：只标记任务 failed，事实不回滚（可重试，重试只重做字节）。
6. **清理唯一链**：
   - 清缓存（保留条目）：`unlink` → `file_path=NULL` → `downloaded=false`。
   - 删条目（连字节）：`unlink` → 删行 → 标签/分集随删 → 空剧清理，**同一事务**（修 C5）。

### 2.3 端点迁移（旧 → 新；重复端点一律删除，不做兼容并存）

| 旧 | 新 |
|---|---|
| `/api/tg/cache/tasks*` | `/api/cache/tasks*` |
| `/api/tg/cache/clear`（名不副实） | `POST /api/cache/clear`（真清：全量 unlink + 置空） |
| `DELETE /api/tg/stored/:cid/:mid` | `DELETE /api/cache/items/:item_id`（清缓存·单条） |
| `/api/tg/cache/finished` + `POST /api/cache/tasks/clear` | **合并**为 `DELETE /api/cache/tasks?scope=all\|success\|failed` |

**功能集收敛铁律**（第四轮评估）：缓存管理只有两类对象——任务记录与缓存字节。
动词固定为 5 个（取消 / 重试 / 删除 / 清除 / 清除缓存文件），**批量清除的范围是参数不是按钮**。
范围三档互斥且并集为全集，因此「还要不要清空失败、清空成功、清空已取消…」的答案恒为：
**不加档，先归到这三位之一**；加不进去才说明模型错了。磁盘侧必须配 `GET /api/cache/stats`
读数（`files`/`bytes`/`external`），否则「清除」是盲操作；外部文件计入读数但永不删除。

---

## 3. M3 媒体库（入库内容与展示）

### 3.1 图片归位（当前侵入视频）

- 图片是**浏览条目**：只出现在「图片」视图/条目池 + 灯箱；**永不进剧集、永不进播放序列**（触发器已强制，展示层不得再开后门）。
- 组记录里的图片随组入库为 photo 条目，**不挂分集**；组内有视频时，剧集只由视频分集构成。
- `episodesToItems` 把分集（含 photo）转成条目再靠 `MediaViewer.modeOf` 兜底（MediaLibraryPanel:205-223 / MediaViewer:24-25）——
  兜底即隐患：改为**构造序列时就排除非视频**，兜底只作断言。

### 3.2 视频：单集多资源 / 合集区间

| 能力 | 现状 | 设计 |
|---|---|---|
| 单集多来源 | `ep.sources` 已下发，剧集页可切主源（SeriesDetail:470-487），**侧栏未渲染**（EpisodeList:136-210） | 侧栏与播放页统一渲染「N 源」徽标 + 切源入口（复用 `switchEpisodeSource`） |
| 1-2 合集（区间） | 仅剧集页渲染 `S1E1-2`（SeriesDetail:407-411）；侧栏取单点（EpisodeList:183）、播放页取单点（MediaViewer:120-123,135） | **所有分集渲染点统一用 `episodeNo`+`episodeNoEnd`**，抽公共 `episodeLabel()`，一次实现三处复用 |
| 集号徽标 | `MediaCard` 有 `episodeLabel` 但从未被传入（MediaLibraryPanel:723-731）→ 不可见 | 卡片传值并渲染 |

### 3.3 剧集页基础内容（当前展示不足）

卡片/详情页固定要素：封面（显式封面 ?? 首集封面）+ 集数（分集数，非媒体数）+ 简介（≤3 行可展开）+ 标签 + 分集列表
（每行：集号（含区间）、标题、时长、缓存角标、多源徽标）。缺任一项即视为未完成。

---

## 4. 播放页（剧集一等视图，非纯播放器）

**现状缺口**：播放器 props 仅 9 项、无分集列表/索引/上一集（VideoPlayer.tsx:48-63）；切集实现在 MediaViewer
（81-83、170-179、94-106），播放页本身没有分集导航；`useSeriesDetail` 在 MediaViewer:65 重复拉取已有详情。

**设计**：

```
┌──────────────────────────────┬───────────────┐
│ 播放器（flex-1）              │ 分集侧栏 320px │
│ 标题栏：剧集名 · S1E1-2 · 集名 │ 当前集高亮     │
│                              │ 区间集号       │
│                              │ 多源徽标       │
│                              │ 缓存角标       │
└──────────────────────────────┴───────────────┘
```

1. 入口携带 `seriesId + episodeId`（不再只带单个 item），播放器按剧集上下文打开。
2. `VideoPlayer` 补 props：`episodes / currentIndex / onSelect(i) / onPrev / onNext`；自动连播倒计时保留（544-624）。
3. 侧栏 = `EpisodeList` 复用（补齐区间集号 + 多源 + 缓存态 + `scrollIntoView` 当前集）。
4. 详情复用共享缓存，消除 MediaViewer:65 的重复请求。
5. 快捷键不冲突：播放页切集用 `Shift+←/→`（`J/L` 仍为快进退，`←/→` 仍归浏览态切条）。

---

## 5. 引申同类问题（同一根因的扩散项）

1. **状态真源多处** → 收敛唯一状态端点（§1.3）
2. **清理链分裂** → 唯一清理链（§2.2-6）
3. **元信息缺失**（无 width/height/duration）→ 无法动态拼图、无法生成海报帧（§1.2 依赖）
4. **模块物理耦合**（同 router/AppState/conn）→ `/api/cache/*` 独立（§0）
5. **组件未分层**（1957 行）→ 拆层（§1.4）
6. **重复请求**（详情拉两遍）→ 共享缓存（§4-4）
7. **区间/多源渲染不一致**（3 处各异）→ 单一 `episodeLabel()`（§3.2）
8. **photo 边界** → 只在浏览位（§3.1）
9. **幂等 COALESCE 粘住旧值** → 专用更新语句（§2.2-4）
10. **任务 `dir` 未读 / 状态无 DB 约束** → 补 CHECK 或用枚举列（§2.1-C6）
11. **空剧与孤儿分集** → 删条目/摘分集后统一清理（§2.2-6）
12. **i18n 键同步** → 新增文案双端补齐
13. **验收覆盖** → 每阶段单测 + e2e + Playwright 截图，边界数据保留

---

## 6. 实施计划（可直接上手）

| 阶段 | 内容 | 改动落点 | 验收 |
|---|---|---|---|
| **P0 边界** ✅ 已完成 | 缓存端点迁 `/api/cache/*`（旧路径别名保留一版）；M2 不认 TG/剧集 | `src/cache.rs` 新模块 + routes.rs merge | e2e 12/12（`verify_cache_chain.py`） |
| **P1 逻辑链** ✅ 已完成（清理链部分） | COALESCE 专用语句（`set_item_file_path`）；唯一清理链（清缓存=unlink+置空保留行；删条目=unlink+删行）；下载目录外文件永不删 | media.rs / routes.rs / cache.rs | 单测 30/30 + e2e 12/12：删条目后文件不存在；清缓存后 `file_path=NULL` 且条目仍在；photo 清缓存 422 |
| **P1b 事实先登记** ⏳ 待做 | 入队即登记条目（杜绝「已缓存未入库」）；下载失败不回滚事实 | routes.rs 入队 handler | 单测：入队后条目即存在；下载失败条目仍在 |
| **P2 展示** | `layoutTiles` 动态拼图；状态端点 `/api/media/state` 收敛四源；TgPanel 拆层；标题/介绍/标签三类渲染 | lib/tgmedia.ts / TgPanel 拆 4 组件 / api/media.ts | 截图：1/2/3/5/7/9 图与混合视频组各一张，无余白、无瘸腿行 |
| **P3 库展示** | 图片归位（浏览位 + 灯箱）；序列构造排除非视频；`episodeLabel()` 三处统一；侧栏多源；卡片集号徽标 | MediaLibraryPanel / EpisodeList / SeriesDetail / MediaCard / MediaViewer | 截图：1-2 合集三处一致；多源在侧栏/播放页可见 |
| **P4 播放页** | 播放器补 `episodes/currentIndex/onSelect/onPrev/onNext`；侧栏分集；详情复用；切集快捷键 | VideoPlayer / MediaViewer / EpisodeList | e2e：连播到下一集、侧栏点集跳转、上一集可用 |

**每阶段完成判据**：规则不变（不读内容做分支）+ 单测 + e2e + 截图证据进 `verify_shots/`；
破坏性操作必须有确认框；改动后自检「这个分支读了内容吗」。
