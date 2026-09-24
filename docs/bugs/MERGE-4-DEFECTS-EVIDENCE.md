# 内容合并 4 缺陷 · 取证台账（team-lead 直接取证部分）

> 用户报告（2026-09-23 原话）：
> 1. 「标题多集,内容多个添加时第一个会成为多集,后面会累加.」
> 2. 「多集无法编辑,集数只能修改前,然后不明-N,后续内容视频累加.」
> 3. 「多集后续内容不会填充正确内容,所有内容应该都一样的,后续全部都临时标题.」
> 4. 「全选本页 导入目录 新建剧集 标签管理 依然是全局过滤,有提出BUG,又丢失,没修复,这个是最最最严重的问题」

## 一、问题4 已完全取证（team-lead 亲验）

**文件**：`tauri-shell/src/components/MediaLibraryPanel.tsx`

**决定性事实**：

| 控件 | 行号 | view 守卫 | 结论 |
|---|---|---|---|
| 搜索框 | ~760 | ✅ `view === 'items'` | 已修（`f842309`） |
| 排序选择器 | `:781` | ✅ `view === 'items'`（`:781` `? ... : null`） | 已修（`f842309`） |
| 仅未归集 | `:800` | ✅ `view === 'items'`（`:800` `? ... : null`） | 已修（`f842309`） |
| **全选本页** | `:855-864` | ❌ **无** | **未修** |
| **导入目录** | `:865-872` | ❌ **无** | **未修** |
| **新建剧集** | `:873-880` | ❌ **无** | **未修** |
| **标签管理** | `:881-888` | ❌ **无** | **未修** |

**渲染条件原文**（`:808` / `:854`）：

```tsx
{selected.size > 0 ? (
  <>  {/* 已选工具栏：N 已选 / 加入剧集 / 移除 / 清除选择 */} </>
) : (
  <>
    <Button onClick={() => setSelected(new Set(visibleIds))}>{t('media.selectAll')}</Button>
    <Button onClick={() => setImportOpen(true)}>⬇ {t('media.importDir')}</Button>
    <Button onClick={() => setCreateOpen(true)}>＋ {t('media.newSeries')}</Button>
    <Button onClick={() => setTagMgrOpen(true)}>🏷 {t('media.manageTags')}</Button>
  </>
)}
```

**证据**：整个分支只看 `selected.size`，**完全没有 `view` 条件**。

**`selected` state 的归属（全部使用点）**：

| 行号 | 用途 | 归属 |
|---|---|---|
| `:152` | `useState<Set<number>>(new Set())` 定义 | — |
| `:155` | `selectedJoinable`：`items.find(...)` 判 kind | **items** |
| `:544` | `confirmTargetIds`：`[...selected]` | **items** |
| `:808` | 工具栏已选态 UI | — |
| `:820` | `selectedJoinable` 控制「加入剧集」可用性 | **items** |
| `:860` | **全选本页 → `setSelected(new Set(visibleIds))`** | **items**（`visibleIds` = `items.map(i => i.id)`，`:449`） |
| `:1015` | `MediaCard selected={selected.has(item.id)}` | **items** |
| `:1062` | `BulkTagDialog count={selected.size}` | **items** |
| `:1066` | `setItemTags(id, tagIds)` 遍历 | **items** |
| `:1086` | `AddToSeriesDialog itemIds={[...selected]}` | **items** |
| `:1173` | 删除 `doDeleteItems(k.ids ?? [...selected])` | **items** |

**结论**：`selected` 是 **items 专用**的选中集合（`visibleIds` 来自 `items`，后端操作全是 item 级）。
但工具栏在 **series 视图下照常渲染** → 用户在剧集墙点「全选本页」→ `selected` 被塞入**不可见的 items id**
→ 界面切到已选态（显示「N 已选」「加入剧集」「移除」）→ 但当前视图是剧集墙，**选中的对象看不见**。
**这正是用户所说的「全局过滤」**。

**与 BUG-131 的关系**：
- BUG-131 覆盖**搜索框 / 排序 / filterActive**（三件），**已由 `f842309` 修复代码**
- 但 **BUG-131 档与索引仍标 `open`**，档内还写着「尚未修复」→ **档案未跟上代码**
- 用户报的 **4 个操作按钮缺 view 守卫**，**不在 BUG-131 覆盖范围内** → **从未登记**

## 二、问题1/2/3 已完全取证（team-lead + Kou 双线独立验证，结论一致）

### 问题1：剧集标题取「第一条 caption」，追加永不更新

| 环节 | 位置 | 事实 |
|---|---|---|
| 剧集标题来源 | `routes.rs:1309-1317` | `first_caption(task.chat_id, &task.message_ids)` → `split_caption(&cap)`，取**整批 message_ids 的第一个有 caption 的消息**当剧集名 |
| 追加路径 | `routes.rs:1342-1355` | 命中已有 `source_key` 时**只调 `append_episodes_ranged`**，剧集 title **永不更新** |
| 合并 | `media.rs:1586-1597` | `merge_series` 只把**源**标题快照进 `origin_series_title`，目标标题来自调用方传入 |
| 追加内核 | `media.rs:1940-2005` | `append_episodes_ranged` **完全不写 title** |

**判定**：首次成剧时用「第一条」的 caption 命名，后续批次全部 append 进这部剧，标题从此**钉死在第一条**。这就是「第一个成为多集标题、后面累加」。**从未登记**（BUG-103 讲备用源/孤儿行，BUG-130 讲合集时间偏移，均非标题归属）。

### 问题2：后端能力齐备，前端只接一半

**决定性事实：后端支持全集，前端不传端点。**

| 层 | 位置 | 事实 |
|---|---|---|
| 后端类型 | `media.rs:2927-2929` | `EpisodeEdit { episode_no_end: Option<Option<i64>> }` —— **三态语义完备** |
| 后端处理 | `media.rs:2401-2415` | `update_episode` **完整处理区间终点**（宽度平移 / 改单集） |
| 前端状态 | `SeriesDetail.tsx:172-178` | `openEpisodeEdit` 只 set `epTitle`/`epDraft`/`epSeason`/`epNo` —— **无 `episodeNoEnd`** |
| 前端提交 | `SeriesDetail.tsx:298-303` | `patchEpisode(epId, { title, description, season, episodeNo: no })` —— **从不传 `episodeNoEnd`** |
| 前端 UI | `SeriesDetail.tsx:814-840` | 只有「第[季]季 第[集]集」两个输入，**无区间终点输入** |
| 渲染点 | `SeriesDetail.tsx:619-622` | `S{season}E{episodeNo}{episodeNoEnd != null && > episodeNo ? \`-${episodeNoEnd}\` : ''}` |

**判定**：改合集（如 E3-4）时只能改起点，后端走 `None` 分支按宽度平移保留终点；**终点不可编辑、不可改回单集**。TS 签名 `media.ts:371` 已声明 `episodeNoEnd` 但**零调用**。**从未登记**（BUG-130 只覆盖合集模型层）。

### 问题3：不存在「临时标题」实现，实为条目 title 为空/原始文件名

- grep 全仓「临时标题 / tempTitle / untitled / placeholder」→ **零命中**，无占位标题概念。
- 实际是**标题缺失时的兜底链**，三处各一套：
  - `EpisodeList.tsx:147-150`：`ep.title || (isPhoto ? t('player.photoEp', {n}) : '') || \`#${ep.itemId}\``
  - `SeriesDetail.tsx:713-715`：`{ep.title || \`#${ep.itemId}\`}`
  - `MediaLibraryPanel.tsx:283`：`title: isRawFileName(e.title) ? '' : (e.title ?? '')`
- `media_episode` **不持有 title 副本**（`collapse_episode_text` 迁移已腾空 `:209` `UPDATE media_episode SET title = NULL`），`EpisodeView.title` 从 `media_item` join。
- `append_episodes_ranged` **不写任何标题** → 分集标题恒等于条目标题。

**判定**：用户看到的「临时标题」= 条目 title 为空或是**原始文件名**（TG 落盘名 `photo--xxx_yyy` / 纯数字消息 id），展示层兜底成 `#<itemId>`。根因在**入库时 `split_caption` 未拿到 caption 或 title 被 `isRawFileName` 判掉**。**从未登记**。

## 三、问题4 已完全取证（team-lead 亲验 + Kou 复核，结论一致）

**文件**：`tauri-shell/src/components/MediaLibraryPanel.tsx`

**决定性事实**：

| 控件 | 行号 | view 守卫 | 结论 |
|---|---|---|---|
| 搜索框 | `:770-780`（testid `media-search-input` @ `:773`） | ✅ `view === 'items'` | 已修（`f842309`） |
| 排序选择器 | `:781-794`（testid `media-sort-select` @ `:783`） | ✅ `view === 'items'` | 已修（`f842309`） |
| 仅未归集 | `:795-805` | ✅ `view === 'items'` | 已修（`f842309`） |
| **全选本页** | `:855-864` | ❌ **无** | **未修** |
| **导入目录** | `:865-872` | ❌ **无** | **未修** |
| **新建剧集** | `:873-880` | ❌ **无** | **未修** |
| **标签管理** | `:881-888` | ❌ **无** | **未修** |

**渲染条件原文**（分支入口 `:808` → `:853` else → `:890` 结束）：

```tsx
{selected.size > 0 ? (
  <>  {/* 已选工具栏：N 已选 / 加入剧集 / 移除 / 清除选择 */} </>
) : (
  <>
    <Button onClick={() => setSelected(new Set(visibleIds))}>{t('media.selectAll')}</Button>
    <Button onClick={() => setImportOpen(true)}>⬇ {t('media.importDir')}</Button>
    <Button onClick={() => setCreateOpen(true)}>＋ {t('media.newSeries')}</Button>
    <Button onClick={() => setTagMgrOpen(true)}>🏷 {t('media.manageTags')}</Button>
  </>
)}
```

**整个分支只看 `selected.size`，零 `view` 条件。** header 在 `:767`，**三种视图共用**。

**`selected` state 的归属（12 处全部使用点，全部 items 级）**：

| 行号 | 用途 |
|---|---|
| `:152` | `useState<Set<number>>(new Set())` 定义 |
| `:154-159` | `selectedJoinable`：`items.find(...)` 判 kind |
| `:544` | `confirmTargetIds`：`[...selected]` |
| `:808` | 工具栏已选态 UI |
| `:811` | `t('media.selected', { n: selected.size })` 计数 |
| `:818` | `selectedJoinable` 控制「加入剧集」可用性 |
| `:860` | **全选本页 → `setSelected(new Set(visibleIds))`**（`visibleIds` = `items.map(i => i.id)`，`:449`） |
| `:1015` | `MediaCard selected={selected.has(item.id)}` |
| `:1062` | `BulkTagDialog count={selected.size}` |
| `:1066` | `setItemTags(id, tagIds)` 遍历 |
| `:1086` | `AddToSeriesDialog itemIds={[...selected]}` |
| `:1173` | `doDeleteItems(k.ids ?? [...selected])` |

**判定**：`selected` 是 **items 专用**。在剧集墙点「全选本页」→ `selected` 被塞入**当前不可见的 items id** → 界面切已选态（显示「N 已选 / 加入剧集 / 移除」）→ 但对象看不见。**这就是用户说的「全局过滤」。**

**注意（产品裁定点）**：「导入目录 / 新建剧集 / 标签管理」**本身是合法的全局动作**（不依赖 `selected`），但它们与「全选本页」**同排同分支**，在 series 视图下一并露出，造成「这一排都在管全局」的错觉。**「全选本页」缺守卫是硬缺陷；另 3 个是否收窄属产品裁定。**

## 四、已确认的档案-代码不一致（「修了但看起来没修」）

| 档 | 档状态 | 实际代码 | 提交 |
|---|---|---|---|
| BUG-131 | `open`（档内写「尚未修复」） | 搜索/排序/filterActive **已加 view 守卫** + 两个 testid | `f842309`（09-22 23:07） |
| BUG-143 | `open`（档内写「尚未修复」） | `ImportDialog` 默认目录**已改走 recentDirs** | `f842309` |

`f842309` 提交信息原文：
```
- BUG-131: the media-library toolbar (search/sort) renders only on the items view;
  filterActive now also drives the series view (loadSeries consumes it).
- BUG-143: ImportDialog default directory no longer hardcodes D://test_videos;
  it reuses recentDirs so the dev residue is not shipped to users.
Refs: BUG-131, BUG-143
```

**BUG-131.md `:24-27` 引用的行号（`:112` / `:690-697` / `:463`）已全部偏移**，实际为 `:146` / `:770-794` / `:534`。

**判定**：属「修了但档未更新」—— 与「诊断即交付」是**两个方向的同一类管理失效**：一边「以为修了其实没修」，一边「修了但看起来没修」。两者都源于**档与代码之间无校验**。

## 五、登记状态总判定

| 问题 | 与已登记档的关系 | 判定 |
|---|---|---|
| 问题1 剧集标题取首条 caption、追加不更新 | BUG-103（备用源/孤儿行）、BUG-130（合集偏移）**均不覆盖** | **从未登记** |
| 问题2 前端编辑入口缺 `episodeNoEnd` | BUG-130 只覆盖合集模型层 | **从未登记** |
| 问题3 条目 title 为空/原始文件名 → 兜底 `#<id>` | BUG-116（图片无字节）、BUG-119（图片无归属）**均不同** | **从未登记** |
| 问题4 四按钮无 view 守卫 | BUG-131 **只管搜索/排序/filterActive** | **从未登记** |
| BUG-131 / BUG-143 | 代码已修 | **档未更新** |

## 六、相关已登记档（供交叉参考）

- `BUG-103`（in_progress）：合并剧集丢失分集备用源 + 孤儿行永久阻塞
- `BUG-112`（in_progress）：剧集里的图片无法移除
- `BUG-129`（open）：`addEpisode` 槽位 upsert 静默覆盖
- `BUG-130`（open）：合集缺时间偏移
- `BUG-113`（open）：单集多视频缺质量/主版本语义
- `BUG-119`（open）：图片没有归属层级
