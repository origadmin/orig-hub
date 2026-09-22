# TG 面板三项 UX 需求 · 技术评估（架构侧）

> 定位：本文是**技术侧现状定位 + 改动方案评估**，与产品侧《`docs/design/tg-ux-requirements.md`》配套阅读。
> 产品文档负责"要什么 / 为什么 / 待拍板"，本文负责"动哪些文件 / 有几条路 / 各自代价 / 踩不踩 AGENTS.md §5"。
>
> - 取证方式：逐条读码，结论附 `文件:行号`；**未亲自核实的引用一律标注来源**。
> - 本文**未改动任何源文件**，不含实现代码。
> - 需求编号沿用产品评估：BUG-099（标签高亮与筛选）/ BUG-100（搜索框层级）/ BUG-101（折叠控件与「立即同步」）。

---

## 0. 结论速览

| 需求 | 推荐方案 | 一句话理由 | 粗估工作量 |
|---|---|---|---|
| **BUG-099** 标签高亮 + 频道内筛选 | **(b-2) 后端派生分段 + 新增 `?tag=` 精筛**（零 schema 变更） | 后端已有 `extract_hash_tags` 唯一真源（`media.rs:2682`）；把"解析"留在 Rust、前端只渲染，可彻底消灭双真源；筛选复用已存在的单频道 `q` 通路（`routes.rs:1475`） | 中（engine 1–1.5d + shell 1d + 单测） |
| **BUG-100** 搜索框层级 | **A（ContextBar 同层居中）**，但必须同时满足三条落地约束；否则退 **B（TgPanel 顶部 toolBar 居中）** | A 满足用户字面要求且语义纠正力最强，技术代价可控；B 是成本 1/3 的退路 | A：中（0.5–1d）／ B：小（2–3h） |
| **BUG-101** 折叠控件 + 立即同步 | **折叠控件改 SVG 独立按钮（保持左侧，与标题解耦）**；**「立即同步」移出监控标题行 → 后端 fire-and-forget + 单飞**；**前端 60s 催同步与"只读新增计数端点"同批做，不批则本期不动** | 折叠控件是真 BUG（10px 文本 + 与标题同按钮）；`monitor_sync` 是同步 await 整轮 `sync_once`，且**三源并发无互斥**是比按钮语义更严重的问题 | 折叠：小（0.5d）／ 同步归位：中（engine 1d + shell 0.5d）／ 摘 60s：中-大（需后端配套，建议单独立项） |

**最大的技术风险**（按严重度排序）：

1. **三个 sync 源并发且后端无单飞**：后台 `monitor::spawn`（默认 30s）＋ 前端 60s 定时（`TgPanel.tsx:760-777`）＋ 手动点击，三路同时调 `sync_once`，后端**没有任何互斥标志**（`state.rs` 内无 sync 相关字段）。后果不是"界面卡"，而是 Telegram RPC 预算被叠加消耗 → FLOOD_WAIT 风险 + SQLite 写放大。
2. **标签解析双真源**：若在 TS 侧重写一套 `#《》` 正则，会与 Rust `extract_hash_tags`（含 30+ 条单测，`media.rs:3015-3093`）必然漂移 —— 本项目已因"两套真源"付过两次学费（BUG-069、BUG-087）。
3. **搜索框上移把高频输入拖进全局层**：`ContextBar` 靠 `memo` + 低频 props 守流畅约束（`ContextBar.tsx:19-22`），方案 A 若把输入 state 直接放进 `MainLayout`/`ContextBar`，每次按键会重渲染整个内容区（含 2000+ 行的 `TgPanel`）。这是方案 A 唯一真正的硬约束，有解但必须主动做。

---

## 1. BUG-099：`#标签` 高亮 + 频道内筛选

### 1.1 现状定位（逐条读码）

**呈现层：caption 是纯文本，零解析（三处）**

| 位置 | 代码 | 说明 |
|---|---|---|
| 单条消息气泡 | `TgPanel.tsx:1681-1684` | `{m.caption}` 直接渲染在 `<p>` 里，`whitespace-pre-wrap` |
| 相册气泡 | `TgPanel.tsx:1901-1904` | caption 取"组内第一条非空 caption"（`:1811` `items.find((it) => it.caption?.trim())?.caption`） |
| 全局搜索结果行 | `TgPanel.tsx:1366` | `{hit.caption}` 纯文本 |
| 数据通路 | `TgPanel.tsx:127-141 fromStored` / `:143-156 fromLive` | `FeedItem.caption` 原样搬运（`TgPanel.tsx:70-85`），**没有 tags 字段** |
| 类型 | `types.ts:189-207 TgStoredMessage` | 无 `tags`；`types.ts:161-178 TgMediaItem` 同样没有 |

**后端：解析器已经存在，且已覆盖 `#《》`**

- `media.rs:2682-2768 extract_hash_tags(caption) -> Vec<String>`：
  - 括号型标签 `#《…》` / `#（…）` / `#(…)` / `#[…]`，**必须成对闭合、不跨行**（`:2711-2736`）；
  - 未闭合 → 退回裸标签规则，不吞掉后续正文（`:2739-2756`）；
  - 裸标签：Unicode 字母数字 + `_`，词内允许 `-._·`，结尾剥离（`:2738-2755`）；
  - `#` 必须词首（`:2698-2706`）、大小写不敏感去重（`:2761`）、>32 字符丢弃（`:2760`/`:2683`）。
  - 注释里明写实测样本 `#《异世界男妓-瓦尔哈拉神枪馆》 EP-2`（`:2677-2678`）。
- 但它**只在入库/缓存时**被调用：`collect_hash_tags`（`media.rs:2248-2279`）→ `add_series_tags_by_name`（`:2311`）/ `add_item_tags_by_name`（`:2343`），写进 `media_tag` / `media_item_tag` / `media_series_tag`（媒体库 item/series 级，**人工可编辑**）。**未入库的消息一条标签都没有**。

**筛选：单频道 caption 子串搜索后端已存在，前端没接**

- `routes.rs:1412-1425 MonitorMsgQuery` 已声明 `q: Option<String>`；
- `routes.rs:1475-1483`：`q` 非空 → `store.search_messages(channel_id, sq, anchor, limit)`，只查本地、**不做网络回补**；
- `store.rs:513-554 search_messages`：`caption LIKE ?2 ESCAPE '\'` + `channel_id` + 可选 `message_id < beforeId`，`%`/`_` 已转义；
- 前端 `listTgMonitorMessages` 的调用点（`TgPanel.tsx:729`、`TgPanel.tsx:828`）只传 `{limit, beforeId}`，**从不传 `q`**。
  （产品评估取证 #14 称 `api/tg.ts:150-158` 已支持传 `q`；本会话未能复读该文件逐行核实，实施前请工程师确认签名与默认值。）

**分页语义（决定了"纯前端过滤"为何不行）**

- `TgPanel.tsx:57 PAGE_SIZE = 30`；首屏 `:729` / 翻页 `:828`（`beforeId` = 当前最旧 id）；
- 也就是说 feed 是**按页增量加载**的，任何"只筛已加载内容"的方案，在用户向上翻页时会立刻露出未筛选的原集合（产品评估 AC6 会挂）。

### 1.2 方案选项对比

| 方案 | 做法 | 代价 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|---|
| **(a) 前端渲染层正则** | TS 里写一套 `#标签` 正则，渲染时切 caption；筛选对已加载 feed 做内存过滤 | 零后端改动 | 最快看到效果 | ① 双真源必然漂移（32 字上限、词首判定、括号对、去重规则全要重实现）；② 筛选与分页语义打架（AC6 必挂）；③ 未加载历史筛不到 | **不推荐** |
| **(b-1) 后端派生 tags 名清单** | `StoredMessage` 增加派生字段 `tags: Vec<String>`（`extract_hash_tags(&caption)` 现算）；前端按 tag 名在 caption 里做**最小定位**后高亮；筛选走新增 `?tag=` | engine：1 个字段 + 1 处 attach + 1 个新查询参数；shell：1 个渲染组件 + 1 个筛选 state | 规则真源在 Rust；零 schema 变更 | 前端仍需"按名找位置"的定位逻辑（可能找不到 → 降级不高亮，但**不会高亮错**） | 可选 |
| **(b-2) 后端派生分段数组（推荐）** | Rust 侧新增 `caption_segments(caption) -> Vec<Segment{text, tag?}>`（**重构 `extract_hash_tags` 为共用的 `scan_tags(caption) -> Vec<(Range, String)>`，两者同核**）；`StoredMessage` 增加可选 `segments`；前端只做渲染 | 比 b-1 多一个 Rust 函数 + 单测；payload 略增 | **彻底消灭双真源**：前端零解析、零定位；AC3 的对拍脚本需求自动消失；高亮位置天然精确 | payload 变大（每条多一个数组），需 `skip_serializing_if` 控制只在 TG 面板读路径填充 | **推荐** |
| **(c) 后端落表 `media_message_tag`** | upsert 时抽 tag 落表 + 索引 + 全量回填；新增标签 rail 端点 | **大**：新表 + 建表/ALTER + 索引 + 存量回填 + **必须配"旧库→新代码"迁移单测**（AGENTS.md §5 迁移铁律，范例 `media::tests::legacy_db_migrates_without_failing_open`） | 可 SQL 精确分页、可做频道级标签云 | 触发迁移铁律；还要与媒体库 `media_tag` 划清边界（产品评估 B-1） | **本期不做** |

**为什么推荐 b-2 而不是 c**：本需求的验收核心是"高亮正确 + 频道内筛得准 + 未入库消息同样生效"（AC1/AC2/AC7）。`extract_hash_tags` 是**纯函数、输入就是 caption**，落表带来的唯一增量是"能 SQL 精确分页"—— 而当前 feed 是 30 条/页的滚动加载，`hasMore` 本来就是保守估计（`store.rs:1492` `let mut has_more = true`），**粗筛+精筛的近似分页与现状同构**，用一张新表 + 一次全量回填去换"精确 hasMore"不划算，还要背上迁移铁律的债。

**筛选的精确性怎么保证**：`?tag=异世界` 走 `caption LIKE '%异世界%'` 粗筛（取 `limit*K` 候选，K 建议 5）→ Rust 侧 `extract_hash_tags(caption)` 精筛（大小写不敏感包含）→ 截断到 limit。这样点 `#A` 不会捞出 `#AB`，正文里出现"异世界"但没打标签的也不会误中。

### 1.3 改动点清单（推荐方案 b-2 + `?tag=`）

**后端（`download-engine/crates/orig-tg/`）**

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/media.rs` | **修改** | 把 `extract_hash_tags`（`:2682`）重构为 `scan_tags(caption) -> Vec<(Range<usize>, String)>`（含偏移），`extract_hash_tags` 改为它的薄封装（**保证 30+ 条既有单测 `:3015-3093` 全绿**）；新增 `caption_segments(caption) -> Vec<CaptionSegment>` |
| `src/store.rs` | **修改** | `StoredMessage`（`:32-59`）新增 `#[serde(skip_serializing_if = "Option::is_none")] pub segments: Option<Vec<CaptionSegment>>` 与/或 `tags`；`stored_message_from_row`（`:260-275`）**保持纯 DB 映射不变**，在 `list_messages`（`:479`）/ `search_messages`（`:513`）/ `search_monitored_messages`（`:560`）出口统一 attach（三处受益、一处改动；`/api/tg/stored` 等其它读路径不带，控制 payload） |
| `src/store.rs` | **新增** | `search_messages_by_tag(channel_id, tag, before_id, limit)`：`LIKE '%tag%'` 粗筛 `limit*K` → `extract_hash_tags` 精筛 → 截断 |
| `src/routes.rs` | **修改** | `MonitorMsgQuery`（`:1412-1425`）新增 `tag: Option<String>`；`monitor_messages`（`:1464`）在 `q` 分支之后加 `tag` 分支 |
| 单测 | **新增** | `scan_tags` / `caption_segments` 覆盖：`#《甲》#《乙》`、`#《没闭合`、`#《》`、`#（全角）`、`http://x/a#b`、`C#`、`#tag.`、33 字超长、跨行；**复用既有黄金用例**（与产品评估 AC3 同一组） |

**前端（`tauri-shell/src/`）**

| 文件 | 动作 | 说明 |
|---|---|---|
| `components/TgPanel.tsx` | **修改** | ① `FeedItem`（`:70-85`）加 `segments?: CaptionSegment[]`；② `fromStored`（`:127`）/ `fromLive`（`:143`）/ `onGlobalHitPreview` 构造（`:679-691`）搬运；③ 新增 `const CaptionText = memo(...)` 组件，替换 `:1681-1684`、`:1901-1904`、`:1366` 三处 `{...caption}`；④ 新增 `activeTag` state + 清除入口（放频道标题栏，占位由 BUG-100 腾出）；⑤ `listTgMonitorMessages` 调用点（`:729`、`:828`）传 `tag` |
| `api/tg.ts` | **修改** | `listTgMonitorMessages` 增加可选 `tag`（或 `q`）透传（据产品评估取证 #14 已支持 `q`，需确认后复用） |
| `types.ts` | **修改** | `TgStoredMessage`（`:189`）/ `TgMediaItem`（`:161`）新增可选 `segments` / `tags` |
| `i18n/locales/zh-CN.json` + `en-US.json` | **修改** | 新增筛选态文案（如 `tg.tagFilter` / `tg.tagFilterClear` / `tg.tagFilterEmpty`），**双语必须同步**（缺占位符不报错、只显示空串，参照 `MainLayout.tsx:296-303` 的警示） |

### 1.4 实现陷阱（写给工程师）

1. **memo 失效陷阱**：`MessageBubble`（`:1636`）/ `AlbumBubble`（`:1784`）已 `memo`。`segments` 若在渲染时 `map` 新建数组，每次父级重渲染都会产生新引用 → memo 全废 → 5s 缓存任务轮询会把整列气泡重建（正是 AGENTS.md §5 要禁止的）。**必须**把 `segments` 固化在 `FeedItem` 对象里（`fromStored` 阶段），`CaptionText` 再 `memo`。
2. **相册 caption 来源**：相册的 caption 是"组内第一条非空 caption"（`:1811`），它的 `segments` 必须取自**同一条**消息，不能重新从组内拼接。
3. **作用域边界**：非监控频道走在线流 `GET /api/tg/messages/:chat_id`，该端点**没有任何文本过滤参数**（`routes.rs:59`）。因此标签筛选**只对监控频道可用** —— UI 上必须在非监控频道隐藏/禁用筛选入口，否则点了没反应。
4. **与全局搜索互斥**：`globalSearch` 非空时右列整体切成结果视图（`:1314`）。`activeTag` 与它都是"第二列内容视图的过滤条件"，**建议互斥**（激活筛选时清空搜索词，反之亦然），否则空态无法解释。
5. **未入库消息同样生效**：b-1/b-2 是"只读派生"，未缓存消息也能高亮/筛中（AC7）；这是相对"复用媒体库 `media_tag`"路线的核心收益。

---

## 2. BUG-100：搜索框层级

### 2.1 现状定位

| 层 | 代码 | 内容 |
|---|---|---|
| ① 应用顶部上下文栏 | `MainLayout.tsx:242-254`（`<header className="flex h-12 shrink-0 ...">`）+ `ContextBar.tsx:91-128` | 左槽 `ViewTitle`（tg 视图 = `nav.tg`「Telegram」，`ContextBar.tsx:58`）；右槽 `resolveContextKind('tg') === 'status'` → `ContextBarStatus`（连接态 + 聚合速度 + 进行中数量，`ContextBarStatus.tsx:65-87`）。**高度恒定 h-12、恒定渲染**，无中间槽 |
| ② TgPanel 顶部 toolbar | `TgPanel.tsx:1045-1074`（`data-testid="tg-toolbar"`，`justify-end`） | 仅"入库流水线"一个按钮 |
| ③ 频道标题栏 | `TgPanel.tsx:1447-1513` | 返回/头像/频道名 + **搜索框 `w-48`（`:1472-1478`）** + 入库流水线 + 「监控中」Chip / 「添加监控」 |

**关键事实（与产品评估一致，另补充两点）**：

- 搜索框的行为是**跨全部监控频道**：`globalSearchInput`/`globalSearch`（`:277-282`）→ 300ms 防抖（`:650-653`）→ `searchTgMonitorMessages`（`:662`）→ `GET /api/tg/monitor/search`（`routes.rs:70`、`:1434-1454`）→ `search_monitored_messages`（`store.rs:560-593`，`JOIN monitored_channel`）。
- **补充 1：同一个 state 有两个 input 实例** —— 结果视图里还有一个 `autoFocus` 的输入（`:1319-1326`），与频道标题栏那个（`:1472-1478`）共享 `globalSearchInput`，二者只显示其一。上移后应**收敛成一个常驻输入框**，删掉重复实例。
- **补充 2：tg 视图的右槽不是空的** —— 是 `ContextBarStatus`（连接态/速度/进行中）。所以"上移到那一行"意味着搜索框要与状态区争右槽，只能放**中间**。
- 另有一个**不同**的搜索 state：`search`（`:262`，UI 在 `:1392-1398`）只用于分组模式下的**频道名**过滤，**不要动它**。

### 2.2 方案选项对比

| 方案 | 做法 | 代价 | 语义纠正力 | 判定 |
|---|---|---|---|---|
| **A. ContextBar 同层居中** | `MainLayout` 的 `<header>` 内加中间槽；输入 state 放 zustand 切片；`ContextBar` 新增"tg 视图中间槽"分支 | ① 全局 store 多一个面板专属 UI 字段；② `ContextBar` 的 `download/status` 二元抽象 → 需加第三形态（破坏"与视图无关"）；③ 三槽各自可收缩（720px 回归，BUG-040 类）；④ 需定义切视图时关键词保留/清空；⑤ **TgPanel 内部还有 `needConfig`/`alive` 门控（`:307`、`:252`）在 MainLayout 侧不可见** → 凭证未配置时会出现"顶部能搜、面板是配置卡"的怪态（可接受，但要知晓） | **最强**（与"Telegram"同层） | **推荐**（用户字面要求），但必须同时做 2.3 的三件事 |
| **B. TgPanel 顶部 toolBar 居中** | 把输入框从 `:1472` 搬到 `:1046-1073` 那一行，改为三槽（左留白 / 中搜索 / 右入库流水线 `absolute right`）；删除 `:1319-1326` 的重复 input | 1 处 JSX 搬迁 + 1 处删除；**零跨组件改动、零 store 污染、零 portal** | 中（视觉上是"Telegram 层的下一行"，但**已离开频道标题栏**，语义错位消除） | **退路**（若不愿为单个面板污染全局 store / 不愿改 ContextBar 抽象） |
| **C. Portal** | state 留在 TgPanel，用 `createPortal` 把输入框挂到 header 里的锚点 div | ① MainLayout 需预埋 `<div id="tg-search-slot">`，形成**隐式 DOM 契约**；② **首帧时序坑**：`view` 初始即为 `tg` 时，TgPanel 的 render 阶段锚点尚未插入 DOM，`getElementById` 返回 null → 必须 ref + state/useEffect 延迟挂载；③ 调试与链路追踪变难 | 强 | **不推荐**：契约隐式 + 时序防御，换来的只是"state 不外溢"，而 A 用 zustand 切片同样能保证 state 不外溢到高频层 |

### 2.3 方案 A 的三条落地约束（缺一不可）

1. **输入 state 不得放进 `MainLayout` 或 `ContextBar` 本体**。
   做法：zustand 增加 `tgSearch` / `setTgSearch`；`ContextBar` 只渲染一个**自带局部 input state 的独立 `memo` 子组件**（如 `TgSearchBox`），子组件内做 300ms 防抖后再写入 store。这样：
   - 每次按键 → 只有 `TgSearchBox` 重渲染；
   - 防抖后 store 变更 → 只有订阅 `tgSearch` 的 `TgPanel` 重渲染（与现状等价，甚至更好：现状是每按键 `TgPanel` 全量重渲染，因为 `globalSearchInput` 就在 TgPanel 里）。
   `ContextBar` 的 memo + 低频 props 设计（`ContextBar.tsx:19-22`）保持原样。
2. **三槽必须各自可收缩**：标题 `min-w-0 truncate`、搜索框 `min-w-0 flex-1`、状态区 `shrink-0`。否则重演 BUG-040 的 min-content 钉死（header 高度必须恒为 48px、不换行）。
3. **切视图语义先定死**：切走 tg 视图时是否清空 `tgSearch`？推荐**清空**（否则从下载视图切回 tg，右列直接停在结果视图，用户没有上下文）。清空动作要同时清 `globalHits`。

### 2.4 改动点清单

| 方案 | 文件 | 动作 |
|---|---|---|
| A | `store/useStore.ts` | 新增 `tgSearch` / `setTgSearch`（zustand 切片） |
| A | `components/ContextBar.tsx` | `ContextKind` 扩 `'tg'`（或新增可选 `centerSlot`）；tg 视图渲染 `<TgSearchBox />`；`resolveContextKind` 需同步 |
| A | `components/ContextBarSearch.tsx`（建议新建） | `memo` 搜索框，自带 input state + 300ms 防抖 → store |
| A/B | `components/TgPanel.tsx` | 删除 `:1472-1478` 与 `:1319-1326` 两个 input；`globalSearchInput`/`globalSearch` 改为读 store（A）或保留局部（B）；结果视图头部（`:1318-1338`）改为只显示命中数与清除按钮；B 方案另需改 `:1046-1073` 行为三槽 |
| A/B | `i18n/locales/{zh-CN,en-US}.json` | 如需新增"清除筛选/搜索"文案则双语同步；`tg.globalSearchPlaceholder` 已含"全部监控频道"，可直接沿用（产品评估 AC4） |
| A/B | `tauri-shell/verify/`（若有 UI 验收脚本） | 新增落位/居中/720px 断言（产品评估 AC1/AC2/AC5） |

---

## 3. BUG-101：折叠控件 + 「立即同步」

### 3.1 现状定位

- 折叠控件：`TgPanel.tsx:1194-1213`。**箭头与标题同属一个 `<button>`**（`:1195-1203`，`onClick={() => setMonitorOpen(v => !v)}` 挂在包住箭头+标题的按钮上）→ **点标题文字也会折叠**；箭头本体是 `text-[10px]` 的文本字符 `▾`/`▸`（`:1199`），宽度 `w-3`（12px）。
- 「立即同步」：同行右侧 `:1204-1212` → `doSync`（`:905-923`）。
- 折叠内容：`monitorOpen && ...`（`:1216-1264`），`max-h-56` 内滚。
- 新内容提示条：`pendingNew`（`:270`，`:1577-1590`）—— **数据源唯一**：来自 `syncTgMonitor()` 返回的 `added`（`:766`）。

### 3.2 后端执行语义（重点取证）

**Q：`monitor_sync` 是同步 await 吗？跑在哪个执行上下文？会不会阻塞 daemon？**

- `routes.rs:1537-1543`：`async fn monitor_sync(...) { match monitor::sync_once(&st).await { ... } }` —— **是同步 await**，HTTP 连接一直挂到整轮同步结束才回 `{added}`。
- 执行上下文：`main.rs:151 #[tokio::main]`（默认 **multi_thread**，worker = CPU 数）。`sync_once` 内部全是 `.await`（`store.list_channels`、`client.messages`、`upsert_message`），**不会占住 OS 线程**，其它 HTTP 请求照常被调度。**所以严格说"不会阻塞事件循环"** —— 但它会：
  1. 长时间占住这一个请求（前端「同步中…」挂同样久）；
  2. 与后台监控循环**抢同一份 Telegram RPC 预算**。

**Q：一轮到底多久？**

`sync_once`（`monitor.rs:44-99`）对每个被监控频道**串行**做：
1. `state.client.messages(ch.channel_id, 100, None)`（`monitor.rs:57`）；
2. 对返回的每条消息**逐条 `upsert_message`**（`:63-84`）。

关键：**`client.messages(ch, 100, None)` 不是"一次 RPC 拿 100 条"**。`grammers.rs:326-356` 的实现是：不设 `iter.limit`，循环 `iter.next()` 直到凑够 100 条**媒体**消息，**最多扫 600 条原始消息**（`grammers.rs:64 MEDIA_RAW_SCAN_CAP = 600`）。媒体稀疏的频道会翻多页 → 每个频道可能多次 RTT。

按此估算（**未实测，需以 `/api/tg/logs` 加计时实测为准**）：

| 项 | 量级 |
|---|---|
| 单频道 | `resolve_peer`（缓存命中≈0）+ 最多 6 页 RPC × RTT(0.3–1.5s，走代理更慢) + ≤100 次本地 upsert（≤100ms）≈ **0.3–9s** |
| 10 个监控频道 | **3–90s** |
| 50 个监控频道 | **分钟级** |

即：频道一多，前端「同步中…」挂几十秒到几分钟是**结构性**的，不是网络偶发。

**Q：并发与单飞？**

- 后台：`monitor::spawn`（`monitor.rs:21-39`），间隔 `monitor_interval_secs.max(10)`，默认 **30s**（`config.rs:27`/`:44`，无其它覆盖点）。若一轮耗时超过间隔，下一 tick 立即触发 → 自身可叠。
- 前端：`TgPanel.tsx:760-777` 每 **60s** `POST /api/tg/monitor/sync` 一次（停留在监控频道时）。
- 手动：按钮 `doSync`（`:905-923`），只有 `if (syncing) return`（只防自己的重复点击）。
- **后端 `AppState`（`state.rs`）没有任何 sync 进行中标志、没有互斥、没有排队**（全文件无 sync 相关字段）。
- 后果：三路 `sync_once` 可同时飞行 → Telegram RPC 叠加 → **FLOOD_WAIT** 风险（一旦限流，连正常的在线播放/缩略图取流都会被拖慢，这就是用户说的"影响前端展示"的真实机制）＋ SQLite 写放大。

**Q：入库影响前端展示吗？**

影响，且有两处：
1. `doSync`（`:905-923`）同步完成后 `stickBottomRef.current = true` 并**重新拉一页 feed**（`:911-914`）→ **直接拽走滚动位置**。这正是用户主张要消除的。
2. 60s 定时那一路（`run`，`:763-770`）只 `setPendingNew`，**不重载** —— 这一路的设计是对的（BUG-038 定下的"点击提示条才刷新"契约，`:1577-1590`）。

### 3.3 方案选项对比

**R3-a / R3-b：折叠控件**

| 选项 | 做法 | 判定 |
|---|---|---|
| 只放大字号 | 10px → 14px 文本 `▾`/`▸` | 不推荐（仍是文本字符，字体依赖强、无 `aria` 语义） |
| **SVG chevron + 独立按钮 + 与标题解耦** | 独立 `<button>` 渲染 SVG chevron（渲染 ≥12×12，热区 ≥24×24，与 `PlaybackSpeed` 的既有口径一致：`TgPanel.tsx:1742-1743` 注释"最小可点击目标 24×24"）；带 `aria-expanded` / `aria-controls` / `data-testid="monitor-collapse"`；标题文字**不再触发折叠** | **推荐** |
| 位置 | **保持左侧** | 推荐。理由：① 右侧当前是操作区（「立即同步」），折叠是层级/导航控件，与"纵向列表标题左箭头"的通行心智一致；② 左栏其余行（分组按钮 `:1290`、频道行 `:1231`）标题一律左对齐，箭头放右会与它们的视觉基线不一致；③ 若「立即同步」被移走，右侧留白，左箭头也不会与任何元素打架 |

**R3-c：「立即同步」去留**

| 选项 | 做法 | 代价 | 判定 |
|---|---|---|---|
| **① 移除按钮** | 删 `:1204-1212` 与 `doSync` | 最小；但丢掉"刚加监控想立刻看到内容"的路径（首轮游标为 0，否则要等下一轮，最多 30s） | 可选 |
| **② 移入「入库流水线」面板 + 后端 fire-and-forget（推荐）** | 按钮移到 `CacheManagerDialog`（那里本来就是入库的可观测面，文案明确"后台已自动同步，此处仅立即拉一次"）；后端 `monitor_sync` 改为 `tokio::spawn(sync_once)` + `AtomicBool` 单飞互斥，立即返回 `{started}`；前端**不再 await、不再重载 feed** | engine 改 1 个 handler + 1 个 state 字段；shell 改按钮归属 + 去掉 feed 重载 | **推荐** |
| ③ 保留现状 | — | 保留"分钟级挂起 + 拽滚动"两个已知问题 | 不推荐 |

**R3-d：前端 60s 催同步**

| 选项 | 做法 | 判定 |
|---|---|---|
| 本期不动 | 只做 R3-c，60s 留待 BUG-098 一起做 | **保守可接受**（但要在 BUG 文件里写明这是已知欠账） |
| **同批做：新增只读"新增条数"端点 → 前端改轮询它 → 摘掉 60s sync** | engine 新增只读端点返回各监控频道自上次以来的新增条数，**走内存快照**（AGENTS.md §5：被轮询的读端点不许碰 DB；由 sync 这个唯一写者在写后刷新快照）；前端轮询节拍 ≥5s；`pendingNew` 改由只读计数驱动 | **推荐，但必须与后端同批** —— **后端未就绪前摘前端 = 直接退回 BUG-038（面板永不更新）** |

### 3.4 改动点清单

**后端**

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/routes.rs` | **修改** | `monitor_sync`（`:1537-1543`）：`sync_once` → `tokio::spawn` + 单飞；返回体加 `started`（保留 `added` 兼容期可先只返回 `started`） |
| `src/state.rs` | **修改** | 新增 `sync_in_flight: AtomicBool`（该文件已 `use std::sync::atomic::{AtomicBool, Ordering}`，`:4`）+ 可选 `last_sync_added` 内存快照（供 R3-d 的只读端点复用） |
| `src/monitor.rs` | **修改（可选）** | `sync_once` 结束写回 `last_sync_added` / `push_log` 计时（便于实测一轮耗时，验证 3.2 的估算） |
| `src/routes.rs` | **新增（R3-d）** | 只读端点（如 `GET /api/tg/monitor/pending`）：读内存快照，零 DB |
| 四副本 sidecar | **必须** | engine 改完必须跑 `sh scripts/sync-sidecars.sh --check`（AGENTS.md §7，CI 会拦） |

**前端**

| 文件 | 动作 | 说明 |
|---|---|---|
| `components/TgPanel.tsx` | **修改** | ① `:1195-1203` 拆成"SVG chevron 独立按钮 + 纯标题"；② 删除 `:1204-1212` 按钮与 `doSync`（`:905-923`）；③ 若做 R3-d：删除 `:760-777` 的 60s `syncTgMonitor()`，改轮询新的只读端点；④ `pendingNew` 数据源同步切换 |
| `components/CacheManagerDialog.tsx` | **修改** | 承接"立即同步"入口（选项 ②）+ 说明文案 |
| `api/tg.ts` | **修改** | `syncTgMonitor` 返回体适配 `started`；新增只读端点封装 |
| `i18n/locales/{zh-CN,en-US}.json` | **修改** | 新增/调整 `tg.sync*` 相关文案（双语同步）。注意：`tg.navMonitor`（`zh-CN.json:258`）与 `tg.monitoring`（`:188`）中文**都是"监控中"**，改文案时别串味 |

---

## 4. 与 AGENTS.md §5 的逐条核对

| 条款（§5） | 本方案是否踩线 | 处置 |
|---|---|---|
| 高频数据只影响正在变化的那一小块 UI（BUG-026） | **BUG-100 方案 A 有风险** | 输入 state 必须走 zustand 切片 + 独立 `memo` 子组件 + 300ms 防抖；**禁止**放进 `MainLayout`/`ContextBar` 本体 |
| `memo` 化 + 回调用 `useEvent`，禁止内联箭头 | BUG-099 有陷阱 | `CaptionText` 必须 `memo`；`segments` 必须固化在 `FeedItem` 内（不可渲染时新建数组）；新增标签点击回调走 `useEvent`（参照 `:1011-1031`） |
| 轮询 ≤5s；同一数据只允许一个轮询源 | **BUG-101 现状已违规** | 三源 sync 并发；收敛方案：后端单飞 + 摘掉前端 60s；新增只读端点节拍 ≥5s |
| 被轮询的读端点不许碰 DB（内存快照，唯一写者刷新） | BUG-101 R3-d 有风险 | 新增的"新增条数"端点**必须**读内存快照，由 sync 唯一写者刷新；绝不每次请求扫 `media_message` |
| 进度变化零派生请求 / 单飞呈现（BUG-027） | BUG-101 顺带修正 | `sync_once` 加单飞与"执行侧单飞"同构（同一时刻至多一轮，后续请求直接返回 `started:false`） |
| 原文不进 DOM，走 `classifyTgReason`（BUG-088） | 不涉 | 本轮改动不渲染后端错误原文；caption 是用户内容，不适用该约束。若新增同步失败提示，仍须走 `classifyTgReason` |
| 迁移铁律（BUG-032）：建表批只允许新旧库都存在的列 + schema 变更必配"旧库→新代码"迁移单测 | **BUG-099 推荐方案完全不触发** | b-1/b-2 是只读派生字段，不动表。若改选方案 (c) 落表，必须配迁移单测（范例 `media::tests::legacy_db_migrates_without_failing_open`） |
| 单一真源（BUG-069 / BUG-087 教训） | BUG-099 核心 | 标签解析**只在 Rust**。选 b-2 则前端零解析，AC3 对拍脚本需求自动消失 |
| 仓库根只允许 4 个文件 | 合规 | 本文落在 `docs/design/` |
| 提交信息英文 + LF（§2）、缺陷登记（§3） | 实施阶段 | 每个改动按 `docs/bugs/` 模板立 BUG-099/100/101；提交信息全英文、LF、不用 `--no-verify` |
| sidecar 四副本一致（§7） | BUG-101 / BUG-099 后端改动 | 改完必跑 `sh scripts/sync-sidecars.sh --check` |
| 窄窗口 720px 回归（BUG-040 类） | BUG-100 方案 A | 三槽各自可收缩；header 高度恒 48px 不换行 |

---

## 5. 工作量与依赖顺序

| 编号 | 条目 | 工作量 | 依赖 |
|---|---|---|---|
| 101-a | 折叠控件 SVG 化 + 与标题解耦 | **小**（0.5d，含验收） | 无（可最先做） |
| 100 | 搜索框层级（B / A） | **小（B：2–3h）/ 中（A：0.5–1d）** | 需先拍 A 还是 B |
| 101-c | 「立即同步」归位 + 后端 fire-and-forget + 单飞 | **中**（engine 1d + shell 0.5d + sidecar 同步） | 与前端改动无耦合，可并行 |
| 099-a | caption 高亮（b-2 分段） | **中**（engine 0.5–1d + shell 0.5d + 单测） | 需先拍语法 A-1（`#《A》《B》` 等 5 项）与 b-1/b-2 |
| 099-b | 频道内标签筛选（`?tag=`） | **中**（engine 0.5d + shell 0.5d） | 依赖 099-a 的解析器重构；**依赖 100**（筛选入口要占用频道标题栏腾出的位置） |
| 101-d | 摘前端 60s + 只读新增计数端点 | **中-大**（engine 1d + shell 0.5d + BUG-038 回归验证） | 必须后端先就绪；建议单独立项或并入 BUG-098 |

**建议实施顺序**：`101-a`（独立、P0）→ `100`（**定顶部结构**，因为它决定 099 的筛选入口位置，两者都改 `TgPanel.tsx` 必须串行）→ `099-a` → `099-b`；`101-c` / `101-d` 属 engine 侧，可与上述并行，但 **101-d 不可早于其后端端点**。

---

## 6. 我核出的偏差与补充（以代码为准）

1. **"后端没有 tag 解析"是误读（最重要）**：`media.rs:2682 extract_hash_tags` **已完整实现**，且注释里就写着 `#《…》` 的取舍理由（`:2675-2679`）。所以 BUG-099 的岔路不是"前端还是后端从零写"，而是"**复用后端唯一真源**（前端只渲染）" vs "**前端另写一套**（必然漂移）" vs "**落表**"。
2. **"频道内筛选"有现成后端通路**：`GET /api/tg/monitor/messages?channelId=&q=` → `store.search_messages`（`routes.rs:1475-1483`、`store.rs:513-554`）已可用，`%`/`_` 已转义；前端只是没传 `q`。不必新端点、更不必落表。
3. **折叠控件不只是"小到看不到"**：箭头与标题**共用同一个 `<button>`**（`:1195-1203`），即"点标题即折叠"。这比尺寸更像 BUG（误操作且列表忽然消失），建议与尺寸同批改。
4. **搜索框其实有两个 input 实例**绑定同一个 state（`:1319-1326` 结果视图 + `:1472-1478` 频道标题栏），不是"唯一搜索框"。上移时应收敛为一个。
5. **"立即同步会不会阻塞 daemon"要分两层答**：不会阻塞 tokio 事件循环（`main.rs:151` 多线程 + 全 await 让出），但会**长时间占住该请求**、并与后台循环抢 RPC 预算。而且**三源并发、后端无单飞**（`state.rs` 无 sync 字段）才是真风险 —— 比"按钮语义不清"严重得多。
6. **`sync_once` 的单频道耗时被低估**：不是"1 次 RPC"，而是最多扫 **600 条原始消息**（`grammers.rs:64 MEDIA_RAW_SCAN_CAP`）直到凑够 100 条媒体 → 可能多次翻页 RTT。故整体是"频道数 × 多次 RTT + ≤100 次串行 upsert"。
7. **tg 视图的 ContextBar 右槽不是空的**（是 `ContextBarStatus`），所以搜索框上移只能居中，且三槽要一起做收缩。
8. **TgPanel 的门控状态部分在组件内部**（`alive` `:252`、`needConfig` `:307`），MainLayout 侧不可见 —— 方案 A 会出现"顶部能搜、面板在显示配置卡"的边界态（无害，但需知晓）。

**未能亲自核实的一项**：`tauri-shell/src/api/tg.ts` 本次未能复读（工具侧拦截），其中 `listTgMonitorMessages` 是否已支持 `q` 参数引自产品评估取证 #14（`api/tg.ts:150-158`）。**实施前请工程师确认签名**后再决定是复用 `q` 还是新增 `tag`。

---

## 7. 需要工程/产品拍板的岔路（技术侧）

| # | 岔路 | 技术侧倾向 | 不定的代价 |
|---|---|---|---|
| **T-1** | 搜索框：A（ContextBar 同层，代价 = 全局 store 字段 + ContextBar 视图分支 + 720px 回归）还是 B（TgPanel toolBar 居中，代价 = 1 处 JSX） | **A**（满足用户字面；代价可控且有明确规避方案）；若不愿改 ContextBar 抽象则 B | BUG-100 无法开工 |
| **T-2** | 标签高亮：b-1（后端给 tags 名 + 前端定位）还是 b-2（后端给分段数组 + 前端零解析） | **b-2**（真源最强，前端零规则；代价是一个 Rust 函数 + payload 略增） | 影响 AC3 是否还需写对拍脚本 |
| **T-3** | 筛选精度：`?tag=` 后端粗筛+Rust 精筛（零迁移、分页近似）还是落表精确分页（迁移 + 回填 + 迁移单测） | **粗筛+精筛**（与现状 `hasMore` 保守估计同构） | 工作量在"2 天"与"1 周"之间摆动 |
| **T-4** | 「立即同步」：移除 / 移入入库流水线 + 后端 fire-and-forget + 单飞 | **后者**（保留"刚加监控立刻拿内容"，同时消除分钟级挂起与拽滚动） | 影响 BUG-101 后端是否要动（进而影响 sidecar 同步与 CI） |
| **T-5** | 前端 60s 催同步：本期同批摘（需后端只读计数端点）还是留到 BUG-098 | **建议同批**，但**后端未就绪前绝不能先摘前端**（否则退回 BUG-038） | 摘早了 = 面板永不更新 |
| **T-6** | 折叠箭头左还是右 | **保持左侧**（右侧是操作区；左箭头与纵向列表心智一致） | 低（易改） |

---

## 8. 本文边界

- 只做评估，**未改动任何源文件、未写实现代码**。
- 工作量为人日粗估，不含联调与回归套件补齐。
- 3.2 的耗时为**按代码路径的量级估算，非实测**；建议实施前用 `/api/tg/logs` 加一轮计时实测校准（真实频道数与代理 RTT 差异很大）。
