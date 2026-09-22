# TG→媒体库 混乱评估 · 移交报告（2026-09-22）

> **读者**：接手本任务的下一个 AI 会话。
> **目的**：完整交接「整体评估 TG→媒体库设计与实现的逻辑/设计混乱，并添加 BUG 修复计划」任务的当前状态、全部证据与后续步骤。
> **证据口径**：所有 file:line 均为 2026-09-22 实测值（本会话约 60 次工具调用逐一取证），非转引。
> **上游文档**：`docs/design/tg-media-ux-confusion-assessment-2026-09-22.md`（产品经理评估，**必读**）。

---

## 0. 一句话状态

**取证 100% 完成、产品评估已交付；BUG 已立档 13 条（BUG-131~143，索引已同步、门禁定向复检 0 err / 0 warn）；修复尚未开始（须先向用户收 Q1-Q5 拍板）；架构师与 QA 两个子任务因 429 限流失败、无任何产出落盘（不要去找他们的文档，不存在）。门禁全仓仍 FAIL（341 项，存量基线），另发现一条规则冲突，见 §13。**

---

## 1. 任务来源（用户原话，2026-09-22）

> 评估项目的设计和实现,我发现大量的逻辑混乱和设计混乱问题. 比如: 实时已连接,存在3个状态显示,右上,左下,右下. 媒体库的搜索栏,仅限部分页面有效,但是媒体库全局显示. 包括但不限于这些问题,所以需要整体评估下TG->媒体库,以及媒体库中的展示,播放等等逻辑问题. 并添加BUG修复计划。

## 2. 团队执行状态（软件公司专家 SOP，如实记录）

| 角色 | 成员 | 状态 | 产出 |
|---|---|---|---|
| 主理人 · 交付总监 | 齐活林 | ✅ 第一轮+续查取证完成 | 本报告 §5-§7 全部证据 |
| 产品经理 | 许清楚 | ✅ 完成 | `docs/design/tg-media-ux-confusion-assessment-2026-09-22.md`（症状清单 S1-S20 + 裁定 + Q1-Q5） |
| 架构师 | 高见远 | ❌ **429 限流失败**（额度 2026-09-23 16:18 重置） | **无**。原任务：技术归一方案（根因/方案/改动面/风险/依赖图） |
| QA 工程师 | 严过关 | ❌ **429 限流失败**（同上） | **无**。原任务：可证伪验收断言（防假绿） |
| BUG 登记 | 齐活林补位 | ✅ 已立档 13 条 | BUG-131~143 + `docs/bugs/README.md` 索引 13 行；详见 §9 / §13 |

**给下一个 AI 的建议**：架构/QA 两个文档**不必为补流程而补**——它们的实质内容（归一方案、验收断言）可以直接写进每条 BUG 登记的「根因」与「复现/验收」段。用户要的是「评估 + BUG 修复计划」，BUG 登记本身就是计划载体。

---

## 3. 核心结论（先读这个）

混乱的本质只有两类（许清楚文档 §1，本会话取证完全支持）：

1. **同一事实多套实现 / 多处呈现**——连接态 3 处、速度 2 处、有无字节 2 套判据、占用空间 2 套账、external 2 种形状、Range 解析 2 套、图片浏览 2 套、搜索 2 套。
2. **控件作用域与视觉作用域不匹配**——媒体库搜索框/排序选择器看着管全局、实际只对 items 视图生效，且默认落点恰恰是它们不生效的剧集视图。

**用户说的「数据打架」多数是同源冗余**：三处连接态已同源（BUG-087 已修，全读 `store/connState.ts`），值不会互相矛盾；真正会「值不一致」的是契约分叉（§5 B1/B3/B4）与假筛选态（B2）。

---

## 4. 已交付物

| 文件 | 内容 | 状态 |
|---|---|---|
| `docs/design/tg-media-ux-confusion-assessment-2026-09-22.md` | 症状清单 S1-S20（含触发步骤/P0-P2/判定分类）+ 产品裁定 + 修复批次 P0/P1/P2 + **待用户拍板 Q1-Q5** | ✅ 已落盘（19:14） |
| 本报告 | 技术证据全集 + 纠错记录 + BUG 立项建议 + 移交清单 | ✅ 本文件 |

---

## 5. 缺陷证据清单（S 编号 = 许清楚文档；B 编号 = 本会话技术编号）

### 5.1 用户投诉两例（已定性，比投诉更严重）

**A1 / S1-S3 连接态三处显示 + 速度两处**
- 三处已同源：全读 `store/connState.ts` 的 `useConnState()` + `CONN_LABEL` + `CONN_DOT`。消费者仅 3 处：
  - 右上 `ContextBarStatus.tsx:76-81`（`data-testid="context-conn"`，灯 `h-1.5 w-1.5`）
  - 左下 `Sidebar.tsx:351-358`（`data-testid="sidebar-conn"`，灯 **`h-2 w-2`** ← 唯一尺寸不一致）
  - 右下 `MainLayout.tsx:309-317`（`data-testid="statusbar-conn"`，灯 `h-1.5 w-1.5`）
  - 三处均带 `data-conn-state` 属性（验收锚点现成）。
- **速度双实现（同病症，用户未提及）**：`ContextBarStatus.tsx:28-42` `SpeedChip` 走 `selectors.selectActiveSpeedLabel`；`MainLayout.tsx:129` `totalSpeed` **直接 filter+reduce 绕过 selectors**（`:316-318` 渲染）。两处口径同为 `downloading|queued` 但数据源不同，注释自承认「不是同一个数据源」。
- 拍板参考：许清楚建议收敛为两处差异化（侧栏=进程态/上下文栏=链路态，去右下）+ 速度合一；见 Q1。

**A2 / S4-S8 媒体库搜索栏作用域（四层问题，全部锁定到行）**
- 搜索框物理位置：**主区工具条** `MediaLibraryPanel.tsx:690-697`（`t('media.search')`）。
- 第 1 层：`:112` `view` 默认 `'series'` → 打开媒体库第一眼是剧集墙；`:189-198` `loadSeries` **完全不消费 search**；`:206` 加载 effect 硬守卫 `if (!alive || view !== 'items') return` → **搜索框可见但输入无效**。
- 第 2 层：同排三控件三种作用域（`:690-719`）——搜索框无 view 守卫、**排序选择器**（`:698-708`）无守卫（series 下切换毫无效果）、「仅未归集」复选框（`:709-719`）**有**守卫。
- 第 3 层：`:463` `filterActive = activeTagId!==null || search.trim()!=='' || unassignedOnly` → series 视图输入搜索词出现「无匹配 + 清除筛选」假空态（实际未过滤）。
- 第 4 层：`:656-660` 标签 chip 点击 `if (!seriesSide) setView('items')` 主动切视图，search 不会——同类「筛选」两套行为。
- 交付约束（许清楚裁定）：**搜索框/排序/filterActive 三件必须同批交付**，拆开留半修状态更糟。见 Q2/Q3。

### 5.2 技术面混乱（B 系列）

| 编号 | 问题 | 证据（file:line） | 对应 S |
|---|---|---|---|
| B1 | **「有无字节」判据分叉**：Rust `MediaItem` **无 `has_bytes`**（`media.rs` `media_item_from_row` 14 列 + `ITEM_SELECT` 不含）→ 前端 `MediaItem.hasBytes` 恒 undefined → 条目视图永远走 `Boolean(filePath)`；`EpisodeView` **有** `has_bytes`（`media.rs:690-734`，SQL 末列 `i.file_path IS NOT NULL`）→ 分集视图走另一路。而 `file_path IS NOT NULL` 已被 BUG-105 判定为错判（外部删除/0 字节都谎报有字节）。**库里已有正确三态探测 `probe_cached_bytes`（`cache.rs:94-121`，返回 Present/Missing/Unknown）但没有任何媒体端点调用**（grep 已核实） | `tgmedia.ts:133-139`（三级优先级 + `:127` 注释把事实写成设计）、`api/media.ts:26-44`（MediaItem 无 hasBytes） | S9 |
| B2 | 编辑弹窗同病：`canClear = Boolean(item.filePath)` | `media/ItemEditDialog.tsx:34` | S10 |
| B3 | **库级字节账答不出**：`library_stats.total_size` = `COALESCE(SUM(size),0) FROM media_item`（**登记值**，清缓存只置空 file_path 不清 size → 数字不变）；`cache/stats.bytes` = 下载目录磁盘真值。两套账口径不同且都答不全 | `media.rs:2676-2694`；`cache.rs:843-872`（`external` 只计数不累加字节） | S11 |
| B4 | **同一 `external` 两种形状**：`GET /api/cache/stats` → **数字**；`GET /api/cache/clear/preview` → **对象**（含 bytes，累加） | `cache.rs:858-870` vs `cache.rs:611-616` | S12 |
| B5 | **删除媒体条目失败被静默吞**：`let _ = std::fs::remove_file(p)` 与 `let _ = st.store.clear_downloaded(chat, msg).await` | `routes.rs:2107-2140`（与同文件 `reset_tg_flag` 的 BUG-109「必须如实报错」判定自相矛盾） | S13 |
| B6 | **TG 在线流端点无背压**：`media_file`（`/api/tg/file/:chat/:msg`）直接 `client.media()` + `parallel_range_stream`（4 worker，mpsc 2/4 缓冲），HTTP 层无节流；对比 `serve_local_file`（`:2344+`）按 `delivery_bps` 背压（`DELIVERY_BUDGET_FACTOR=6.0`、`DELIVERY_FALLBACK_BPS=16MiB/s`、env `ORIG_TG_DELIVERY_BPS` 可覆盖） | `routes.rs:432-499`；背压实现 `routes.rs:2395-2440`；分片 `grammers.rs:1007+` | —（**并入既有 BUG-114，勿新立**） |
| B7 | **Range 解析两套实现**：`parse_range`（返回 `MediaRange::{Open,Closed,Tail}`）vs `media_parse_range`（返回 `(start,end,open_ended)`），同文件并存，注释自承「语义已对齐」 | `routes.rs:504-546` vs `routes.rs:2227-2261` | —（重构项） |
| B8 | **TgPanel 视图状态无单一真源**：三层 JSX 三元表达 4+ 视图（全局搜索结果 `:1305` / 分组模式 `:1371` / 频道详情 `:1431`），无 `resolveTgView()`；项目已有成功范式 `resolveConnState`/`resolveContextKind`（`ContextBar.tsx:44`） | `TgPanel.tsx` | S17（重构项） |
| B9 | **TG 两个「搜索」**：全局 `useTgSearch`（上下文栏 `TgGlobalSearch.tsx`，防抖 300ms，筛全部监控频道**消息**）vs 面板内 `search`（`:269`，**仅分组模式可见** `:1380-1385`，只筛频道名/用户名，消费点 `groupChannels :464-477`）。**注意**：频道详情消息流的搜索框已删（`:1469-1470` 注释「单频道过滤是它的子集，此处不再单设一框」）——BUG-100 落地后的残留是**分组模式频道过滤框**这一个 | `TgPanel.tsx`、`store/tgSearch.ts` | S16 |
| B10 | **TG 侧内置播放器无上下一条**：三处 `openViewer`（全局搜索命中 `:698-703` / 单条预览 `:1021-1028` / 相册预览 `:1030-1036`）只传单条或单相册；对比 `MediaLibraryPanel.playItems`（`:277-297`）会扩整部剧集 | `TgPanel.tsx` | S14 |
| B11 | **「打开」语义双轨**：`openDownloaded`（`:979-989`）= `plugin-opener.openPath()` **系统默认播放器**；预览 = 内置播放器。同一「打开」动词两种行为 | `TgPanel.tsx` | S15 |
| B12 | **media:list 无读缓存**：`fetchCache.cacheKey` 只有 `seriesList`/`seriesDetail` 两键 → 媒体库条目列表每次进 items 视图发真请求（无在途合并/无结果缓存），与 BUG-026 等值短路精神不一致 | `lib/fetchCache.ts:62-67` | — |

### 5.3 本会话续查新增发现（N 系列，许清楚文档之后）

| 编号 | 问题 | 证据 |
|---|---|---|
| N1 | **SeriesDetail `KIND_LABEL` 硬编码中文**（series/collection/album）——BUG-128 同病未修实例 | `media/SeriesDetail.tsx:32-36` |
| N2 | **ImportDialog `KIND_LABEL` 硬编码中文** + 全对话框文案硬编码（约 11 处） | `media/ImportDialog.tsx:8-13, 97-196` |
| N3 | **ImportDialog 默认目录硬编码 `'D:\test_videos'`**——开发残留进了生产 UI 的输入框默认值（placeholder 同样硬编码） | `media/ImportDialog.tsx:26, 109` |
| N4 | **图片浏览双实现**：`SeriesDetail` 私有灯箱（`data-testid="series-photo-viewer"`，fixed z-50，自带 ‹›/Esc）vs 全局 `MediaViewer` browse 模式（MainLayout `:198-209`，absolute z-40）。灯箱注释自称「图片永不进播放器」是**有意设计**，但全局 viewer 的 browse 模式已满足该意图（BUG-036 已做 kind 分组），私有灯箱是重复的导航/键盘/关闭逻辑 | `media/SeriesDetail.tsx:876-931` |
| N5 | **i18n 孤儿 key 量化**：zh/en 各 **433 key 完全对齐**、全仓 `t()` 引用 **0 缺失**（这两项是健康的）；但 **53 个 key 无人引用**（剔除 `category.*` 动态前缀误报 11 个后 **42 个确认死键**）——死键恰是 BUG-087/BUG-100 收敛后留下的文案残骸（`status.daemonRunning`、`main.daemonConnected`、`tg.searchMessages`、`tg.cachedLib` 等） | 节点脚本全仓扫描；清单见 §7 |
| N6 | **同值 key 36 组**（不同 key 同文案，如「视频」= category.Videos / media.videos / media.kindVideo）——**部分是 BUG-128 的刻意裁定**（单数徽标 vs 复数分类名，修复说明明确「刻意不复用」），**禁止盲并**，逐组判语义后再清 | 同上 |
| N7 | **BUG-128 已修复核实**：`MediaCard.tsx:70-75` 已是 `KIND_LABEL_KEY`（存 i18n 键）+ en-US `:335-338` 四键齐全——但 N1/N2 说明同病还在别处 | — |
| N8 | **编号基线漂移实测**：本会话 19:43 时 `docs/bugs/` max=BUG-128（128 个文件）；19:56 已出现 **BUG-129、BUG-130**（并行会话的「合集/多源」工作线，BUG-130=合集时间偏移与单集多源共存，与本任务无内容冲突）。**建档前现查编号是硬要求** | `ls docs/bugs/` 两次对比 |
| N9 | **i18n 硬编码中文总量**：**253 行**含中文字符串字面量（剔注释后），分布 25 个文件，Top：`SeriesDetail.tsx` 51、`DownloadDetailSheet.tsx` 25、`DownloadItem.tsx` 23、`AddDownloadDialog.tsx` 17、`SeriesDialog.tsx` 13、`ImportDialog.tsx` 11、`ItemEditDialog.tsx` 9、`MediaCard.tsx` 9 | 节点脚本全仓扫描 |

---

## 6. 本会话纠正过的初判（下一个 AI 勿重蹈）

1. **`openDownloaded` 不是内置播放器**——它是 `plugin-opener.openPath()`（系统默认播放器）。最初误判「TG 侧播放器无上下条」时把它也算作播放器入口，复核后排除（但 B10 结论对内置播放器三入口仍成立）。
2. **`media_file` 无 Range 时是 200+完整文件，不违反 BUG-031 契约**——`grammers.rs:705-745` range 规约：`total_size` 已知时 `None → (0, total-1)`。只有 Photo 等 `total_size.is_none()` 才走 `UNKNOWN_TOTAL_SEGMENT` 分段流。该端点唯一问题是**无背压**（B6）。
3. **三处连接态是同源冗余，不是数据打架**——BUG-087 已修。用户看到的「三个状态显示」要按「重复渲染」治理，不是「修不一致」。
4. **TG 频道详情流搜索框已删除**——`:1469-1470` 注释确认 BUG-100 落地。第二搜索框只剩分组模式的频道过滤（B9 精确边界）。
5. **`check-bugs.py` 需要 3.5-4 分钟**——`docs/rules/bug-registry.md` 明示「别用 2 分钟超时」。本会话早期三次 SIGTERM 无输出即此因（超时被杀，不是脚本坏了）。

---

## 7. i18n 死键清单（42 个确认未引用，清理时逐条核对）

`status.daemonRunning`、`main.daemonConnected`、`tg.heading`、`tg.sub`、`tg.loadingChannels`、`tg.noChannels`、`tg.loadingMessages`、`tg.noMessages`、`tg.filterAll`、`tg.notMonitored`、`tg.storedHeading`、`tg.loadingMonitor`、`tg.noStored`、`tg.monitoredCount`、`tg.clearCacheHint`、`tg.clearCacheConfirm`、`tg.clearCacheDone`、`tg.clearCacheFail`、`tg.clearCacheConfirm2`、`tg.clearCacheDone2`、`tg.loadMore`、`tg.navFolders`、`tg.selectGroup`、`tg.searchMessages`、`tg.globalSearchTitle`、`tg.monitorViewHint`、`tg.cachedLib`、`tg.clearRow`、`tg.view`、`tg.searchMedia`、`tg.emptyCached`、`tg.serviceOffline`、`tg.selectToPlay`、`tg.downloadDir`、`tg.downloadDirTip`、`tg.close`、`tg.save`、`tg.clearCenter`、`tg.bytesRows`、`tg.bytesNoBytes`、`media.sectionContent`、`media.delete`。

（另有 11 个 `category.*` 键看似未用，实为 `t(\`category.${cat}\`)` 动态前缀消费，**不是死键**。）

---

## 8. 待用户拍板（许清楚文档 §5，原文照录要点）

- **Q1 连接态收敛**：A=收敛两处差异化（侧栏=进程态/上下文栏=链路态，去右下）【推荐】；B=保留三处但差异化语义+统一尺寸。
- **Q2 搜索作用域**：A=诚实收窄（搜索框/排序仅 items 视图渲染）【推荐】；B=扩为对剧集/分集也生效（独立特性，工期长）。
- **Q3 标签 chip 是否继续点击切视图**：A=不再隐式切视图【推荐】；B=保留跳转+显式提示。
- **Q4 占用空间口径**：A=主显磁盘真值+登记值次显并标注【推荐】；B=只留登记值。**注意与 BUG-051 不冲突**——「登记体积不变」本身正确，错在把它当「占用空间」展示；修口径与文案，不改行为。
- **Q5 有无字节判据**：A=统一接后端三态探测（`probe_cached_bytes`），条目/分集/弹窗同源且保持三态不压布尔【推荐】；B=维持现状（违背 BUG-104/105 结论）。

---

## 9. BUG 立项清单（✅ 已全部立档：BUG-131~143，编号 = 实际编号）

| 暂定编号 | 标题（索引行一句话） | 模块 | 严重程度 | 覆盖 |
|---|---|---|---|---|
| BUG-131 | 媒体库工具条搜索/排序仅 items 生效却恒渲染 + series 视图假筛选态——作用域诚实化三件套 | shell | high | S4-S8 / A2 |
| BUG-132? | 条目「有无字节」判据分叉——MediaItem 无 hasBytes 恒走 filePath，probe_cached_bytes 三态未接线 | engine+shell | high | S9-S10 / B1-B2 |
| BUG-133 | 媒体库「占用空间」展示登记值——清缓存后数字不变，应主显磁盘真值并标注口径 | engine+shell | high | S11 / B3 |
| BUG-134? | 连接态三处重复渲染 + 速度两处双实现（一处绕过 selectors）+ 灯尺寸不齐 | shell | mid | S1-S3 / A1 |
| BUG-135 | 删除媒体条目时文件删除与 clear_downloaded 失败被静默吞——违背 BUG-109 如实报错判定 | engine | mid | S13 / B5 |
| BUG-136? | cache 接口 external 字段双形状双口径（stats 数字不累加 / preview 对象累加） | engine | low | S12 / B4 |
| BUG-137? | TG 内置播放器打开不传邻居序列——TG 侧无上一条/下一条（媒体库侧有） | shell | low | S14 / B10 |
| BUG-138? | media:list 无读缓存——cacheKey 未覆盖条目列表，与既有列表缓存策略不一致 | shell | low | B12 |
| BUG-139? | 「打开已下载」与「预览」语义双轨——同一动词系统播放器/内置播放器两种行为 | shell | low | S15 / B11 |
| BUG-141/142/143 | i18n 债务批次：253 行硬编码中文 + 42 死键 + ImportDialog/SeriesDetail KIND_LABEL + 默认目录 `D:\test_videos` 残留 | shell | low | N1-N3/N5/N6/N9 / S18-S20 |

**不立新 BUG 的项**：
- B6（TG 在线流无背压）→ **并入既有 BUG-114**（open，同一根因面）。
- B7（Range 两套）、B8（TgPanel 视图无枚举）→ 重构项，建议随相邻修复顺手做或立 refactor 任务，不必占 BUG 编号。
- N4（图片浏览双实现）→ 设计评估项：全局 viewer browse 模式已满足「图片不进播放器」，可归并；但灯箱是有意设计，先与用户确认再动。
- BUG-128 已 fixed，勿重报；N1/N2 已随 BUG-141 立档（BUG-143 为 ImportDialog 默认目录残留）。

**交付顺序（许清楚 P0/P1/P2 + 技术映射）**：
1. **P0**：BUG-131（A2 三件套必须同批）→ BUG-132 → BUG-133。
2. **P1**：BUG-134 → BUG-135 → BUG-136 → BUG-140（TG 双搜索消歧）。
3. **P2**：BUG-137/138/139 + i18n 批量档 + B7/B8 重构。
4. 每批独立可交付、每条 fixed 必须有 `## 验收证据`（跨机器可核验引用）。

---

## 10. 下一个 AI 的工作清单（按序）

1. **读三份文件**：本报告 → `docs/design/tg-media-ux-confusion-assessment-2026-09-22.md` → `docs/rules/bug-registry.md`（登记格式与门禁的唯一真源）+ AGENTS.md §5/§6。
2. **向用户收 Q1-Q5 拍板**（§8）。拍板前不要动 A1/A2 相关代码。
3. ~~现查 BUG 编号并登记~~ → **已完成**（BUG-131~143，见 §13 门禁结论）。后续如需新登记，仍须**建档前现查**。
4. **向用户收 Q1-Q5 拍板后进入修复**。若新增登记，用一行 python 回读校验索引（列数≥4、状态枚举、无裸 `|`）。
5. **修复实施**按 §9 交付顺序；P0 三件套（搜索框/排序/filterActive）**必须同一批提交**。
6. **验收**：走 `npm run verify:ui` + `verify_shots/` 既有 CDP 脚本风格；见 §11.3 验收缺口与锚点建议。

---

## 11. 环境与操作注意事项（本仓反复踩坑，务必先读）

### 11.1 并行会话与编号
- **建档前现查编号，不能用 ls 快照**——本会话实测 19:43→19:56 间基线从 BUG-128 漂到 BUG-130（并行线）。
- 提交只 add 自己的文件；`git status` 里的未跟踪/已改文件未必是自己的。
- 提交信息**英文 + LF**；`fix` 必须引用 `BUG-<编号>`；不 `--no-verify`。

### 11.2 工具坑
- `curl` 一律加 `--noproxy '*'`；`-o /dev/null` 恒 exit 23（幽灵），判成败**只看 `-w '%{http_code}'`**。
- `check-bugs.py` **实测 40 分 24 秒**（20:34→21:15），不是文档标称的 3.5-4 分钟；前台 480s 超时会被 SIGTERM 且**输出 0 字节**（脚本缓冲到结束才打印）。→ 必须后台跑，且别在它跑完前下结论。
- 后台任务完成通知要核对 task_id，别拿旧通知当新结果。

### 11.3 验收缺口（QA 未产出，这里是最小接班包）
- 现成锚点：三处连接态均有 `data-testid` + `data-conn-state`（`context-conn`/`sidebar-conn`/`statusbar-conn`）；媒体网格 `media-grid`；无字节占位 `item-nobytes`；重缓存 `item-recache`；系列图片灯箱 `series-photo-viewer`。
- **缺口**：媒体库搜索框与排序选择器**都没有 `data-testid`**——修复时应补 `media-search-input` / `media-sort-select`（命名对齐既有 kebab 风格）。
- 验收通道：`npm run verify:ui`（= `node tauri-shell/verify/verify_ui_render.cjs`，需先起 daemon + `npm run dev`，`APP_URL=http://127.0.0.1:5180`）；底层 `verify/lib/cdp.cjs` 零依赖（Node 内置 WebSocket + 本机 Edge，`BROWSER=msedge` 与 WebView2 同引擎）。**禁止仅以 curl 200 验收**（docs/ACCEPTANCE.md 明令）。
- 防假绿铁律：反向证伪（换错误地址必须 FAIL）；判据写「值正确」不是「值一致」；A2 的断言要能区分「前端过滤」与「后端查询」（CDP 抓请求 URL 是否带 `q=`）。

### 11.4 仓库卫生（已知违反项，勿擅动）
- 仓库根存在 `_p.txt`、`._bld.txt` 等临时 txt（违反 AGENTS.md §6「根只允许 4 文件」）——并行会话产物，**清理需用户逐条显式授权**（AGENTS.md 铁律：删除任何东西要显式授权）。

---

## 12. 关键文件索引（取证主战场，按重要度）

| 文件 | 关键行 | 主题 |
|---|---|---|
| `tauri-shell/src/components/MediaLibraryPanel.tsx` | 112/115/173/189-198/206/277-297/463/656-660/690-719 | A2 全部四层 |
| `tauri-shell/src/store/connState.ts` | 全文 52 行 | A1 同源真源 |
| `tauri-shell/src/components/{ContextBarStatus,Sidebar,MainLayout}.tsx` | 76-81 / 351-358 / 129,309-318 | A1 三处 + 速度双实现 |
| `download-engine/crates/orig-tg/src/media.rs` | 690-734/805-846/857-925/2676-2694 | B1/B3 |
| `download-engine/crates/orig-tg/src/cache.rs` | 94-121/611-616/843-872 | B1 三态探测/B4 |
| `download-engine/crates/orig-tg/src/routes.rs` | 432-546/2107-2140/2296-2340/2344-2450 | B5/B6/B7 |
| `tauri-shell/src/lib/tgmedia.ts` | 118-139 | B1 前端判据 |
| `tauri-shell/src/lib/fetchCache.ts` | 26-67 | B12 |
| `tauri-shell/src/components/TgPanel.tsx` | 269/464-477/698-703/979-989/1021-1036/1305/1371-1395/1431/1469-1470 | B8-B11 |
| `tauri-shell/src/components/media/{MediaCard,ItemEditDialog,ImportDialog,SeriesDetail}.tsx` | 70-75,287-297 / 34 / 8-26 / 32-36,876-931 | N1-N4 |
| `tauri-shell/src/i18n/locales/{zh-CN,en-US}.json` | 各 433 键 | N5-N7 |
| `docs/rules/bug-registry.md` | 全文 | 登记格式唯一真源 |
| `docs/design/tg-media-ux-confusion-assessment-2026-09-22.md` | 全文 | 产品评估（S1-S20/Q1-Q5） |

---

## 13. 门禁验证结论（2026-09-22 21:15 跑完，🚨 含一条规则冲突）

### 13.1 本次跑的结果

`python scripts/check-bugs.py` → **`FAIL - 341 项违反（warn 265 项）`**，耗时 **40 分 24 秒**。

| 判定 | 结论 |
|---|---|
| 341 项 ERROR 的类型 | **全部**是「不认识的字段名」（无索引不一致、无状态不一致、无缺号） |
| 341 项的分布 | **73 个文件**，最多的是 BUG-083（34 条）、BUG-082（19 条）、BUG-106（14 条）→ **存量基线，不是本次引入** |
| 本次新增 13 档（131-143）的贡献 | 旧版全文扫描下 8 条（131/132/133/137/140×2/141/142）；**当前版本下为 0**（见 13.2） |
| 我插入的 13 行索引 | 回读校验 13/13 OK（列数≥4、状态枚举、模块枚举、文件存在、无裸 `|`） |

### 13.2 门禁脚本在本次运行期间被并行会话改过（关键）

- 门禁 21:15 结束，`scripts/check-bugs.py` 的 mtime 是 **21:19:32**（结束后 4 分钟），当前为 `M`（未提交）。
- 改动内容（`git diff`）：`FIELD_RE` → `NOW_FIELD_RE` + 新增 `FIELD_SHAPE_RE`/`NOW_FIELD_NAMES`/`TIERS`，
  并把「不认识的字段名」**从硬失败降级为 warn**，扫描范围也**从全文缩到「首个 `##` 之前的头部块」**
  （脚本注释自陈：全文扫描时 505 个候选里 471 个是误伤）。
- 含义：13.1 里的 341 项是**旧版**行为。**按当前版本复检，BUG-131~143 为 0 err / 0 warn**（已用脚本自身常量复现验证）。

### 13.3 🚨 发现一条门禁规则冲突（未改，留给规则所有人裁定）

- 脚本**文档头第 14 行**写：「状态 **fixed/closed** 必须有非空的验收章节（RULE_FROM 起强制 `## 验收证据`）」。
- 但**代码**（`if not has_ev: if n >= RULE_FROM: err(...)`）对 **>= BUG-056 的所有状态（含 `open`）无条件强制**。
- 后果：存量 `open` 档 **BUG-125/126/129/130 同样会 FAIL** —— 这会挡死并行会话的提交，属于门禁规则缺陷而非登记缺陷。
- 本次处置：**不给 `open` 档伪造验收证据**，而是按现行规则给 13 档各补了一个 `## 验收证据` 节，
  首行明确标注「当前状态 open，尚未修复；以下为修复后必须满足的可证伪判据（预先声明，非已执行记录）」，
  并引用真实入库源码路径以满足「跨机器可核」要求。修复时必须把该节替换为实际执行记录。
- **建议**（未擅自改他人脚本）：把条件收紧为 `status in {fixed, closed, partial}`，或把文档头措辞改成与代码一致。

### 13.4 复检命令（下一个 AI 可直接用）

把 `scripts/check-bugs.py` 当模块加载可安全复用其规则常量（脚本有 `if __name__ == "__main__"` 保护），
对指定编号做定向自检，不用再等 40 分钟：

```python
import importlib.util, re, os
spec = importlib.util.spec_from_file_location('cb', 'scripts/check-bugs.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
# 再用 m.NOW_FIELD_RE / m.STATUSES / m.MODULES / m.SEVERITIES / m.PATH_RE 对目标编号逐条判定
```

---

*报告终。接手后如有与本报告冲突的新发现，以你亲自取证的实时代码为准，并在 BUG 登记里更新证据。*
