# TG 面板 UX 四项 · 实施方案（可照做）

> 日期：2026-09-21 ｜ 状态：**方案就绪，未实施**
> 前置：`docs/design/tg-ux-assessment-summary.md`（评估汇总）、`docs/bugs/BUG-099/100/101/102.md`
> 已拍板：① `#《A》《B》` 本期维持现状；② 搜索框 = 顶部上下文栏那一行居中（方案 A）；
> ③ 标签筛选必须跨频道 + 频道内都要；④ **本轮不改代码**。
> 本文**只描述改动，不含实际修改**。

---

## 0. 实施顺序与依赖

```
① BUG-101-a 折叠控件（0.5d）      ← 无依赖、零争议，可立即开工，唯一 P0
② BUG-100  搜索框上移（1~2d）      ← 已拍板方案 A；需先定「切回是否保留关键词」
③ BUG-099-a 标签高亮（2~3d）       ← 需先定 segments 还是 tags 字段
④ BUG-099-b 频道/跨频道筛选（2d）  ← 依赖 ②（筛选入口要占用频道标题栏腾出的位置）
                                     ③ 与 ④ 都改 TgPanel.tsx，必须串行
────────────────────────────────
⑤ BUG-102  同步单飞 + 摘前端轮询（3~5d，engine+shell）
⑥ BUG-101-b「立即同步」去留（0.5d） ← 与 ⑤ 同批（都碰 monitor_sync）
```

**硬约束（AGENTS.md §5，全程不得违反）**：高频刷新只影响局部 UI；轮询 ≤5s 且同一数据只允许一个轮询源；
被轮询的读端点不许碰 DB（走内存快照）；高频路径组件必须 `memo`；回调走 `useEvent`（引用恒定），
禁止内联箭头把 `memo` 废掉；错误文案不直出原文（走 `classifyTgReason`）。

---

## ① BUG-101-a 折叠控件（P0，0.5 天）

### 现状

`tauri-shell/src/components/TgPanel.tsx:1194-1213`：

```jsx
<div className="flex items-center justify-between border-b border-border-subtle/60 px-3 py-2">
  <button
    onClick={() => setMonitorOpen((v) => !v)}
    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
  >
    <span className="w-3 shrink-0 text-[10px] text-muted">{monitorOpen ? '▾' : '▸'}</span>
    <h3 className="truncate text-[13px] font-semibold text-fg-strong">
      ⭐ {t('tg.navMonitor')} ({monitoredList.length})
    </h3>
  </button>
  <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={doSync} ...>
    {syncing ? t('tg.syncing') : t('tg.sync')}
  </Button>
</div>
```

两个问题：`▾`/`▸` 是 `text-[10px]` 的**文本字符**（小到看不到）；
箭头与标题**共用同一个 `<button>`**（点标题即折叠）。

### 改法

1. **拆成两个元素**：chevron 独立成 `<button>`，标题降级为普通 `<h3>`（不再可点、不再折叠）。
2. chevron 用 **SVG**，容器 `h-6 w-6`（24×24 热区，与 `TgPanel.tsx:1742-1743` 既有口径一致）。
3. 加 `aria-expanded` 与 `aria-label`（无障碍 + 给验收探针稳定的选择器）。
4. 新增 i18n 键 `tg.monitorCollapse` / `tg.monitorExpand`（`zh-CN.json` + `en-US.json`）。

```jsx
<button
  type="button"
  aria-label={monitorOpen ? t('tg.monitorCollapse') : t('tg.monitorExpand')}
  aria-expanded={monitorOpen}
  data-testid="monitor-collapse-toggle"
  onClick={() => setMonitorOpen((v) => !v)}
  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg-strong"
>
  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d={monitorOpen ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
  </svg>
</button>
<h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-strong">
  ⭐ {t('tg.navMonitor')} ({monitoredList.length})
</h3>
```

> 注意：`<path>` 的 `d` 两条分支字符数不同（`M9 6l6 6-6 6`），别写错笔画。

### 验收判据

- `monitor-collapse-toggle` 的渲染盒 **≥ 24×24**（CDP 取 `getBoundingClientRect`）。
- **反向证伪**：点击标题文字 `h3`，`monitorOpen` **不变**（原先会折叠）。
- `aria-expanded` 与实际展开态一致（真值，不只是"一致"，参照 BUG-087 教训）。
- 回归：折叠后 `monitoredRows` 不渲染（`:1216` 的 `{monitorOpen && ...}` 保持不变）。

---

## ② BUG-100 搜索框上移（1~2 天）

### 目标形态

顶部上下文栏那一行（左槽显示「Telegram」，`nav.tg`：`zh-CN.json:7`）分三槽：
**左=视图标题 / 中=搜索框 / 右=`ContextBarStatus`**，搜索框居中。

### 改动清单

1. **新增** `tauri-shell/src/components/TgSearchBox.tsx` —— **自带 state 的独立 `memo` 子组件**：
   - 内部持有输入值，300ms 防抖后写入 store（复用现状 `:651` 的 300ms）。
   - `export const TgSearchBox = memo(function TgSearchBox() {...})`。
   - **禁止**把 input 直接写进 `ContextBar` 或 `MainLayout` 本体 —— `ContextBar.tsx:19-22` 注释明写它
     只吃低频 props 以守 §5；否则每次按键会重渲染 2000+ 行的 `TgPanel`。

2. **store 加切片**（`tauri-shell/src/store/useStore.ts`）：`tgSearchInput` / `tgSearch` + setter。
   TgPanel 的 `globalSearchInput`/`globalSearch`（`:277-282`）改为读 store，
   **其余查询逻辑（`:655-675`）保持不变**，只是数据源从本地 state 换成 store。

3. **`ContextBar.tsx`** 加中间槽，仅 `view === 'tg'` 时渲染 `<TgSearchBox />`：

```jsx
<div className="flex min-w-0 flex-1 items-center gap-3">
  <ViewTitle view={view} categoryFilter={categoryFilter} />
  <div className="min-w-0 flex-1 flex justify-center">
    {view === 'tg' ? <TgSearchBox /> : null}
  </div>
  <div className="ml-auto flex shrink-0 items-center gap-3">...右槽...</div>
</div>
```

4. **删除两处旧 input**：`TgPanel.tsx:1319-1326`（结果视图头部）与 `:1472-1478`（频道标题栏）。
   → **两个实例收敛成一个**（验收 AC3b：全页 `input[type=search]` 恒为 1）。

5. **三槽可收缩**：中段 `min-w-0 flex-1`，左右 `shrink-0`；避免重演 BUG-040 的 min-content 钉死（720px 回归）。

### 边界态

TG 不可用（`alive` / `needConfig` 门控在 `TgPanel` 内部、`MainLayout` 不可见）时会出现
「顶部能搜、面板显示配置卡」。建议：TG 不可用时**隐藏**搜索框（待拍板项）。

### 验收判据

- 全页 `input[type=search]` **恒为 1**。
- 输入时 `TgPanel` 不整体重渲染（React DevTools / 自定义计数验证）。
- 搜索结果仍显示来自哪个频道（跨频道语义可见）。
- 反向证伪：切到非 tg 视图，搜索框消失且不残留。

---

## ③ BUG-099-a 标签高亮（2~3 天）

### 前提（已拍板）

`#《A》《B》` 本期**维持现状**（只产出一个）→ **不改 Rust 解析器语义**，只做重构，30+ 条单测必须全绿。

### 后端改动（`download-engine/crates/orig-tg/src/media.rs`）

1. **重构出带偏移的扫描器**（不改行为）：

```rust
pub struct TagSpan { pub start: usize, pub end: usize, pub text: String }

pub fn scan_tags(caption: &str) -> Vec<TagSpan> { /* 现有逻辑 + 记录字节偏移 */ }

pub fn extract_hash_tags(caption: &str) -> Vec<String> {
    scan_tags(caption).into_iter().map(|s| s.text).collect()
}
```

- **关键**：`extract_hash_tags` 的输出必须与重构前**逐字节一致**（30+ 条单测即回归网）。
- 顺手清掉 `:2758-2759` 重复的两行 `let body = body.trim().to_string();`。

2. **消息返回结构加分段**：给对外消息结构加可选 `segments`：

```rust
pub struct CaptionSegment { pub text: String, pub tag: bool }
```

在返回消息的装配处（`routes.rs` 的 `monitor/messages` 与 `stored` 两条路径）对**每条 caption**
跑一次 `scan_tags` 生成 `segments`。这是纯派生、不落库、无需迁移。

- 成本提示：每条消息每页一次 `scan_tags`，caption 通常 <1KB，可忽略。

### 前端改动

- `types.ts` / `api/tg.ts` 增加 `segments?: CaptionSegment[]`。
- 渲染 caption 的三处（`TgPanel.tsx:1681-1684`、`:1901-1904`、`:1366`）改为：
  有 `segments` 则按段渲染，`tag=true` 的段渲染成**可点击的标签按钮**（为 ④ 的筛选留入口）；
  无 `segments` 则退回纯文本（兼容旧后端）。

### 验收判据

- **未入库/未缓存的消息同样高亮**（本条需求的灵魂，不能只覆盖已缓存）。
- `extract_hash_tags` 重构后 30+ 条单测**全绿**（行为不变）。
- 标签段可点击（即使 ④ 还没做，也应先占位或禁用，别做成死链）。

---

## ④ BUG-099-b 频道内 / 跨频道筛选（2 天，依赖 ②）

### 后端改动

落点 **`/api/tg/stored`**（`routes.rs:1567-1591`）—— 唯一同时满足
「跨全部监控频道 + `beforeId` 分页 + 含未缓存行」的现成通路。

1. `StoredMsgQuery`（`routes.rs:1545-1565`）新增两个可选参数：
   - `tag: Option<String>` —— 标签精筛
   - `channelIds: Option<Vec<i64>>` —— 频道子集（不传 = 全部监控频道）

2. `store.list_stored` 增加两阶段过滤：
   - 粗筛：SQL 层 `caption LIKE '%tag%'`（`%`/`_` 已转义，照抄 `store.rs:513-554` 的现有做法）+ 可选 `channel_id IN (...)`；
     取 `limit * K` 候选（K 建议 4~8）。
   - 精筛：Rust 侧对候选 caption 跑 `extract_hash_tags`，用**大小写不敏感**比对保留真正含该标签的行，截断到 `limit`。

3. `has_more` 保持 `items.len() >= limit`（`routes.rs:1589`）。
   **已知代价**：精筛后一页可能凑不满 → `hasMore` 偏保守（可能提前判"没有更多"）。
   若实测不可接受，再考虑落表（见下方选型）。

### 前端改动

- `api/tg.ts` 的 `listTgStored`（`:255`）增加 `tag` / `channelIds`。
- 筛选入口放在频道标题栏（② 腾出的位置）：
  - 频道内：传 `channelIds=[当前频道]`
  - 跨频道：不传 `channelIds`
  - **同一套代码覆盖两种作用域**——这正是"不能只顾频道内"的解法。
- 筛选态与全局搜索框**是否互斥**仍待拍板（建议互斥，否则空态无法解释）。

### 选型判据（落表 vs 不落表）

| 条件 | 选择 |
|---|---|
| `media_message` 数千级、频道几十个 | `?tag=` 粗筛+精筛（零迁移，推荐） |
| 单频道上万条 **且** 要求精确翻到筛选结果最后一页 | 新建 `media_message_tag` 关联表 |

→ **实施前先统计 `media_message` 行数**，再决定。落表方案需额外承担：schema 迁移 + 全量回填 +
与媒体库 `media_tag` 划边界（AGENTS.md §5 迁移铁律：建表批只允许新旧库都存在的列；
凡 schema 变更必须配"旧库→新代码"迁移单测）。

### 验收判据

- 点 `#A` 不得捞出 `#AB`，也不得捞出正文含 `A` 但无该标签的消息（**精筛有效**）。
- 不传 `channelIds` 时能跨频道命中；传 1 个时结果只来自该频道。
- 未缓存消息也能被筛到。

---

## ⑤ BUG-102 同步单飞 + 摘前端轮询（3~5 天，engine+shell）

**三件事必须打包，只做任一件都不够。**

1. **后端加单飞**（`download-engine/crates/orig-tg/src/monitor.rs`）：
   - `AppState` 增 `sync_in_flight: AtomicBool`（或 `tokio::sync::Mutex<()>`）。
   - `sync_once` 入口先 `compare_exchange` 抢占，抢不到直接返回 `Ok(0)` 并记一条日志；
     出口（含错误路径）必须释放 —— **用 guard 或 `defer` 语义，别漏掉 Err 分支**。
   - 现状三个触发源：后台循环（`:21`，默认 30s）+ 前端 60s + 手动点击。
   - **配套**：`monitor_sync`（`routes.rs:1537-1543`）改 fire-and-forget 后，返回体从
     `{"added": n}` 改为 **`{"started": bool}`** —— `false` 表示已有同步在跑、本次被单飞挡下。
     这既是前端可行动的反馈，也是下面验收第 1 条的可测锚点。

2. **新增只读「新增条数」端点**：`GET /api/tg/monitor/new-count`
   - **内存快照，不碰 DB**（§5 硬约束）；由 `sync_once` 完成时更新计数。
   - 「有 N 条新内容」提示条改由它驱动，轮询 ≥5s。

3. **摘掉前端 60s 轮询**：删除 `TgPanel.tsx:760-777` 的 `setInterval(run, 60_000)` 与
   `:771` 的立即 `void run()`。

> **⚠️ 顺序不可颠倒**：第 2 步未就绪就摘第 3 步 → 直接退回 BUG-038「面板永不更新」。
> `TgPanel.tsx:756-759` 的注释明确写了这段代码的来由，删之前先读它。

### 校准（实施前必做）

**FLOOD_WAIT 是推断、未实测**（BUG-102 已标红）。实施前用 `/api/tg/logs` 加计时，
实测一轮 `sync_once` 的耗时与频道数关系，确认是否真的存在风险，避免为一个不存在的问题做设计。

### 验收判据（**可实测，不依赖 FLOOD_WAIT 假设**）

架构师复核后收敛：BUG-102 **即使拿掉 FLOOD_WAIT 这个机制假设仍然成立**，剩下两个**读码已证实**的事实
——① 三路 `sync_once` 并发做无用功；② 一个**写端点**被轮询（违反 §5 精神）。
故验收改为下列**今天就能实测**的断言：

1. **单飞生效**：连续打 2 次 `POST /api/tg/monitor/sync` → 第二次**立即**返回 `started === false`。
2. **前端已摘**：停留 TG 面板 3 分钟 → `/api/tg/logs` 里只有后台周期那一批轮次（约 6 轮 / 30s），
   **前端侧 `POST /api/tg/monitor/sync` 计数 = 0**。
3. 摘掉前端轮询后，「有新内容」提示条**仍能正常出现**（反向证伪：不摘则无法证明只读端点有效）。
4. 手动同步点击后立即返回，**不再 `stickBottomRef=true` 重拉一页拽走滚动位置**。

> **不给 FLOOD_WAIT 写验收**：全仓 `orig-tg` **没有任何 FLOOD_WAIT 处理**，完全依赖 grammers 客户端
> 内部行为（新版是内部 sleep 重试），实测更可能表现为「整体变慢/排队」而非报错。
> 拿机制假设做判据 = 制造假绿。

---

## ⑥ BUG-101-b「立即同步」去留（0.5 天，与 ⑤ 同批）

- 前端：从监控列表标题行（`:1204-1212`）移出 → 放进「入库流水线」面板，带说明文案（**不硬删**，
  保留"刚加监控立刻要内容"的路径）。
- 后端：`monitor_sync`（`routes.rs:1537-1543`）改 **fire-and-forget**（`tokio::spawn` + 立即返回 202），
  不再同步 `await` 整轮。与 ⑤ 的单飞配合：spawn 内部同样走 `sync_once`，受单飞保护。
- 待拍板：弱化到流水线面板（推荐）还是直接移除。

---

## 7. 尚未拍板（阻塞对应条目开工）

| # | 阻塞项 | 阻塞谁 | 建议 |
|---|---|---|---|
| 1 | 筛选路径：`?tag=` vs 落表 | ④ | 先统计 `media_message` 行数，数千级用 `?tag=` |
| 2 | 是否加 `channelIds`（任意频道子集） | ④ | 建议加，成本极低且覆盖"不能只顾频道内" |
| 3 | 切走 TG 再切回，关键词保留还是清空 | ② | 建议清空（跨视图残留易误解） |
| 4 | TG 不可用时是否隐藏顶部搜索框 | ② | 建议隐藏 |
| 5 | 筛选态与全局搜索是否互斥 | ④ | 建议互斥 |
| 6 | 「立即同步」弱化 vs 移除（BUG-101 B-2） | ⑥ | 建议弱化 |
| 7 | 高亮用 `segments`（带偏移）还是只给 `tags` 名清单 | ③ | 建议 `segments`（前端按名定位会误命中同名子串） |

---

## 8. 回滚

四条均为**增量、可独立回退**：

- ① 纯 UI 结构拆分，改坏退回单 button 即可。
- ② 状态从本地 state 提到 store，旧 input 删除前先确认 store 通路打通（可共存过渡）。
- ③ `segments` 是**可选字段**，后端未返回时前端退回纯文本 → 可安全灰度。
- ④ `tag` / `channelIds` 是**可选参数**，不传即等同现状 → 零风险。
- ⑤ **唯一有回滚风险**：摘前端轮询后若只读端点出问题，会退回 BUG-038。
  故第 2 步必须先上线并观察，再摘第 3 步；不要同一提交里做完。
