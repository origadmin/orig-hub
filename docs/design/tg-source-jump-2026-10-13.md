---
status: draft
author: 架构分析（AI 协作者）
date: 2026-10-13
topic: tg
module: shell
decided-by: —
decided-at: —
landed-in: 无（`TGJ-T01`~`TGJ-T04` 均未开工）
---

# 「在 TG 中查看」应是**插件感知的源跳转** —— 可用则应用内跳频道定位，不可用则外部打开

> **来源**：用户 2026-10-13 报障原话：「**在 TG 中查看 的实现有严重问题**，应该是
> **插件（是否开启支持？）→ 跳转到插件对应频道，内容展示**。如果**插件没有开启**，
> 采用**外部打开（调起默认 APP，或者 WEB）** 这样可以做吗？」
>
> **结论（先答用户的问题）**：**可以做**，且**不需要新增任何权限、不需要改数据库、不需要改引擎** ——
> 坐标（`<chat>:<msg>`）在入库时就已落库，跳转所需的两个能力（应用内切面板 / 外部打开）
> 在壳里**都已经存在**。缺的只是把这两条路**接在一个判据上**。
>
> **本文不改代码**（用户 2026-10-10 定：纯文档任务，代码由别的组负责）。
> 本文是 **BUG-285 的复报**（不新开号，见 §7）。

---

## 0. 结论前置：现在的实现「有严重问题」在哪

| # | 事实 | 落点（实测） |
|---|---|---|
| 1 | 入口产出的是**一条裸深链**，只有 URL，没有行为分支 | `tauri-shell/src/lib/mediaSources.ts:325-330` `sourceMessageUrl()` → `https://t.me/c/<chat>/<msg>` |
| 2 | 渲染成**纯 `<a href target="_blank">`** —— 无 onClick、无插件判断、无降级 | `tauri-shell/src/components/media/SeriesDetail.tsx:1011-1022`（主源）与 `:1052-1063`（备用源），`data-testid="episode-source-view-tg"` |
| 3 | 全前端 `target="_blank"` **只有这 2 处**；而 `src-tauri/src/lib.rs` **没有** `on_navigation` / `on_new_window` 处理器，`tauri.conf.json` 的 `app` 段也无相关配置 | 见 §1.2 取证 |
| 4 | ⇒ 在 **Tauri WebView2 内**，这个 `<a>` **没有一个可达的打开通道**（新窗口没有处理器接） | 用户已实测「有严重问题」；机制候选见 §1.2，**本文不把候选当结论** |

**一句话**：现在的实现把「跳转」实现成了一条**只在浏览器里成立**的链接，
而用户是在**桌面壳**里点它 —— 分支（插件开/关）与通道（应用内/外部）**一个都没有**。

---

## 1. 现状取证（三个已确认事实 + 一个候选）

### 1.1 坐标早就在库里，缺的只是出口

- 入库时记下 `media_item(source, ref)`，TG 的 `ref` = `<chat_id>:<msg_id>`；
  剧集侧 `media_series.source_key` = `tg:group:<chat>:<group>` 或 `tg:msgs:<chat>:<msg>`。
- 解析器已存在：`tauri-shell/src/lib/tgmedia.ts:122-129` `parseTgRef()` →
  `{ chatId, messageId }`；经 `mediaSources.ts:305-310` `parseSourceRef()` 统一暴露。
- ⇒ **本条不需要任何 schema 变更**。BUG-285 的档内判断（「数据一直在、只是没有出口」）**成立且依然成立**。

### 1.2 当前 `<a target="_blank">` 在桌面壳里没有通道（用户报的「严重问题」）

实测（只读 grep，全仓）：

```
$ grep -rn 'target="_blank"' tauri-shell/src
SeriesDetail.tsx:1014
SeriesDetail.tsx:1055          ← 全仓仅此 2 处

$ grep -rn 'on_navigation\|new_window' tauri-shell/src-tauri/src/lib.rs
（0 命中）
```

Tauri v2 中，webview 内 `target="_blank"` 的落地行为由 **`on_new_window`**（或导航处理器）
决定；**未注册时没有任何处理器会把它交给系统默认程序**。
⇒ 用户在桌面壳里点它，**得到的是「点了没反应」或一个空的 webview** ——
这与用户「实现有严重问题」的描述一致。

> **本文的诚实边界**：以上是**静态取证**（代码里没有处理器）。
> 具体的运行期表现（无反应 / 空窗口 / 被 CSP 拦）**未在本轮实测**，
> 因为需要起桌面二进制并人工点击，本轮未做。**机制候选不当作结论**，
> 但 §3 的设计对三种表现**都成立**（无论当前是哪种坏法，接上判据后都修好）。

### 1.3 「外部打开」的能力**已经就位，零新增权限**

```
tauri-shell/src-tauri/Cargo.toml:23          tauri-plugin-opener = "2"
tauri-shell/src-tauri/src/lib.rs:469         .plugin(tauri_plugin_opener::init())
tauri-shell/src-tauri/capabilities/default.json:17   "opener:default"
```

且 `opener:default` 的实测内容（取自 `src-tauri/gen/schemas/acl-manifests.json`）：

```json
{"identifier":"default",
 "description":"This permission set allows opening `mailto:`, `tel:`, `https://` and `http://` urls
                using their default application as well as reveal file in directories …",
 "permissions":["allow-open-url","allow-reveal-item-in-dir","allow-default-urls"]}
```

⇒ **`openUrl()` 现在就能用**（http/https 已在 scope 内）。
既有同类调用已 5 处，统一走**动态 import**（`SettingsPanel.tsx:416` / `TgPanel.tsx:1298` /
`ExportPreviewDialog.tsx:92` / `DownloadItem.tsx:70`），本条沿用同一形态。

### 1.4 「插件是否开启」的判据**已有唯一真源**

用户问的「插件是否开启支持」，在壳里就是 TG 服务门控：

- 真源：`tauri-shell/src/store/useStore.ts:606-656` `refreshTgState()`
  → `tgService = { enabled, running, port, lastError }`（来自 daemon 的 `cfg.tg_enabled` / `cfg.tg_running`）。
- 门控：`tauri-shell/src/store/selectors.ts::resolveTgFeatureReady(tgService)` ——
  **入口级门控的唯一来源**（BUG-087 / BUG-097 / BUG-178；`MainLayout.tsx:47`、`AccountsPanel.tsx:58` 同源消费）。
- ⇒ **不得**在本条里另写一份「TG 能不能用」的判断（BUG-177 的教训：
  两份判据迟早分叉，分叉就会出现「入口还在、进来却被弹走」）。

---

## 2. 目标行为（用户裁定，逐条对齐）

| 分支 | 条件 | 行为 |
|---|---|---|
| **A** | TG **可用**（`resolveTgFeatureReady === true`） | **应用内跳转**：切到 TG 面板 → **选中对应频道** → **定位到该消息并展示内容** |
| **B** | TG **不可用**（未开启 / 未运行 / 未绑定 / 连不上） | **外部打开**：交给系统默认程序 —— **装了 TG 客户端则拉起 App，否则走 WEB** |

> 分支 B 的「调起默认 APP 或 WEB」**不是我们二选一**，而是 `openUrl('https://t.me/…')`
> 由操作系统按用户机器上装了什么来决定 —— 这正是用户要的语义，**不要自己造 App/WEB 判断**。

---

## 3. 设计：一处 store 增量 + 一个判别函数 + 两个消费点

### 3.1 一处 store 增量：`pendingTgFocus`（**与 `pendingMediaFocus` 同构**）

壳里**已有**一个完全同构的先例 —— 「入库流水线 → 媒体库」的跳转焦点：

| 既有先例 | 位置 |
|---|---|
| 定义 | `useStore.ts:192-193` `pendingMediaFocus: string \| null` / `setPendingMediaFocus` |
| 设置方 | `CacheManagerDialog.tsx:916` `setPendingMediaFocus(ref)` |
| 消费方 | `MediaLibraryPanel.tsx:500-528`（消费后**立刻置 null**，`useEffect` 依赖它） |

⇒ 本条**照抄这个形状**，新增一个**平行**字段（不合并、不复用 `pendingMediaFocus`，
后者的语义是「媒体库条目 ref」，混用会让两个视图抢同一个槽）：

```ts
// useStore.ts —— 与 pendingMediaFocus 并列
pendingTgFocus: { chatId: number; messageId: number } | null
setPendingTgFocus: (at: { chatId: number; messageId: number } | null) => void
```

**为什么用「待办焦点」而不是直接调用 TgPanel**：媒体库与 TG 面板是**兄弟视图**
（`MainLayout.tsx:259-262` 按 `view` 二选一渲染），媒体库拿不到 TgPanel 的实例；
store 字段是两者之间**唯一**的合法通道（既有 `pendingMediaFocus` 就是为此而生）。

### 3.2 一个判别函数：把「坐标」翻成「该走哪条路」

在 `mediaSources.ts` 里把 `sourceMessageUrl` **升级为**（或并列新增）一个**判别式**返回值 ——
调用方不再需要自己判断环境，**分支决策收在一处**：

```ts
export type SourceJump =
  | { kind: 'tg-in-app'; chatId: number; messageId: number }
  | { kind: 'external'; url: string }
  | null   // 来源无坐标（本地来源）⇒ 不渲染入口（BUG-285 的既有判据不变）

export function sourceJumpTarget(source?: string | null, ref?: string | null): SourceJump
```

- 解析仍走 `parseSourceRef`（**TG 知识继续封死在 `lib/tgmedia` 里**，
  `mediaSources.ts` 仍是唯一 import 它的文件 —— 该注释见 `:322-323`）。
- `null` 分支语义不变：本地来源没有 TG 消息可跳 ⇒ 调用方**不渲染入口**。

### 3.3 两个消费点

**(a) `SeriesDetail.tsx`（`:1011-1022` 主源 / `:1052-1063` 备用源）**：
`<a href target="_blank">` → **`<button type="button" onClick={…}>`**（理由见 §3.4），
文案与 `data-testid` **不变**（`episode-source-view-tg`），并新增 `data-testid` 上的
**分支可见性**（便于 CDP 断言）：

```tsx
onClick={async () => {
  const jump = sourceJumpTarget(cur.source, cur.ref)
  if (!jump) return
  if (jump.kind === 'tg-in-app') {           // 分支 A
    setPendingTgFocus({ chatId: jump.chatId, messageId: jump.messageId })
    onOpenTg()                                // 新增 prop：切 view='tg'（MainLayout 已有 setView）
  } else {                                    // 分支 B
    if (isTauri()) {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(jump.url)                 // 系统默认：有 TG 客户端拉起 App，否则 WEB
    } else {
      window.open(jump.url, '_blank', 'noopener,noreferrer')   // 网页调试模式（BUG-286 同款守卫）
    }
  }
}}
```

> `tgFeatureReady` 的判断放在 `sourceJumpTarget` 的**调用侧还是内部**，
> 实现时二选一并写清；本文倾向**内部**（`sourceJumpTarget` 收一个 `tgReady: boolean` 入参），
> 因为「插件开不开」是**运行时状态**、不该让每个渲染点各取一次 store。

**(b) `TgPanel.tsx`**：新增消费 `pendingTgFocus` 的 `useEffect` ——
与 `MediaLibraryPanel.tsx:500-528` 同形（**消费后立刻置 null**）：

1. `setSelectedId(chatId)`（复用**已有**通道：`TgPanel.tsx:343` `selectedId` / `:639` 自动选首个 / `:954-1001` 由 `selectedId` 驱动 feed 加载）；
2. 频道列表可能**尚未就绪**（`monitoredRows` 异步）⇒ 需**等待该 chatId 出现在候选里**再选中，
   **不得**因为「列表还没加载完」就丢弃焦点；
3. feed 加载后**滚动并高亮** `messageId`（`expandedHit` 已有展开态，`TgPanel.tsx:381`）。

### 3.4 为什么必须是 `<button>`，不能继续用 `<a>`

1. `<a target="_blank">` 在 WebView2 里**没有可达通道**（§1.2）—— 这是当前「严重问题」的直接来源；
2. 分支 A/B 是**运行时**判断（取决于 `tgFeatureReady`），`<a href>` 无法表达；
3. `<a href>` 会把 `t.me` URL 暴露给「右键复制链接/拖拽」，而分支 A 下**根本没有这个 URL 该出现的地方**。

---

## 4. 任务分解（**全部未开工**）

| Task ID | 任务名 | 源文件 | 依赖 | 优先级 | 状态 | 负责 |
|---|---|---|---|---|---|---|
| `TGJ-T01` | `sourceJumpTarget` 判别式 + `tgReady` 入参（含 `null` 判据不变） | `tauri-shell/src/lib/mediaSources.ts` | 无 | P0 | 未开工 | — |
| `TGJ-T02` | store 增 `pendingTgFocus` / `setPendingTgFocus`（与 `pendingMediaFocus` 并列） | `tauri-shell/src/store/useStore.ts` | 无 | P0 | 未开工 | — |
| `TGJ-T03` | `SeriesDetail` 两处入口 `<a>` → `<button>` + 分支 onClick；`MainLayout` 下传 `onOpenTg` | `tauri-shell/src/components/media/SeriesDetail.tsx`、`tauri-shell/src/components/MediaLibraryPanel.tsx`、`tauri-shell/src/components/MainLayout.tsx` | T01/T02 | P0 | 未开工 | — |
| `TGJ-T04` | `TgPanel` 消费 `pendingTgFocus`（选频道 → 等就绪 → 载 feed → 滚动高亮） | `tauri-shell/src/components/TgPanel.tsx` | T02 | P0 | 未开工 | — |

**排序**：T01/T02 无依赖可并行；T03 依赖两者；T04 依赖 T02。
**T03 与 T04 必须同一期交付** —— 只做 T03 会让分支 A「点了切过去但没定位」（等于把 BUG-285 的入口做成了半成品）。

> **待拍板（≤3 条）**：
> ① 分支 A 的落点：**切到 TG 面板**（本设计）还是**开一个浮层/抽屉就地展示**（不切视图）？
> ② 目标消息的呈现强度：**滚动定位即可**，还是需要**高亮/聚焦**（`expandedHit`）？
> ③ TG 面板已在该频道时，是否仍要「重新定位」？（建议：是，幂等重定位）

---

## 5. 判据（可证伪，预先声明）

| # | 判据 | 反向证伪（必须 FAIL） |
|---|---|---|
| 1 | `tgReady === true` 时点击：**不产生任何外部打开**（断言 `openUrl` / `window.open` **零调用**）+ `view` 切到 `tg` + `selectedId === chatId` + `messageId` 在 DOM 中可见 | 把分支写成**恒外部打开** ⇒ 必 FAIL（且断言「openUrl 零调用」直接抓到） |
| 2 | `tgReady === false` 时点击：**调用外部打开一次**且 URL **逐字等于** `https://t.me/c/<chatId>/<messageId>` | 把分支写成**恒应用内** ⇒ 必 FAIL（外部分支不可达、用户点不动） |
| 3 | **网页调试模式**（无 Tauri 运行时）点击分支 B：走 `window.open`，**不得**抛 `Cannot read properties of undefined (reading 'invoke')` | 恢复裸 `@tauri-apps` 调用 ⇒ 必重现该报错 ⇒ FAIL（BUG-286 同款判据） |
| 4 | **本地来源**（`parseSourceRef` 返 null）：**不渲染**入口 | 无条件渲染 ⇒ 出现「点了没有可跳的坐标」的死按钮 ⇒ FAIL（不回归 BUG-285） |
| 5 | **判据自身可失败**：注入「`tgReady` 恒 false」⇒ 判据 1 必须 FAIL；注入「恒 true」⇒ 判据 2 必须 FAIL。两者都抓不到 ⇒ 判据恒真、不是判据 | — |
| 6 | **UI 真实渲染**（CDP，**禁读 `className`**，用 `data-testid`）：`episode-source-view-tg` 存在、可点、且点击后分支可见 | — |
| 7 | **不回归**：`media_item.ref` / `media_series.source_key` 的既有形态不变；`parseSourceRef` 的返回契约不变；`check-bugs.py` 既有 4 项 ERROR **不增** | — |

**反向证伪的注入方式**（本轮已验证过的同类手法）：CDP 注入互斥类/短路条件 →
断言必须由 PASS 转 FAIL → **自动还原并自证**（`sha256` before == after）。
**证伪注入必须真能制造出被断言的状态**（BUG-259 的教训：注入一个「本来就不溢出」的值 ⇒ 假红）。

---

## 6. 红线 / 不变量（改动前必须逐条对照）

1. **不推翻 BUG-285**：本条**沿用**它的入口与坐标判据，只是把**形态**从「裸深链」改成「判别式跳转」。
2. **不改 `parseSourceRef` 的判据**：坐标能否解析仍由**来源适配器**决定；本条不新增「什么算可跳」的第二套标准。
3. **`mediaSources.ts` 仍是唯一 import `lib/tgmedia` 的文件**（`:322-323` 的注释是设计约束）——
   TG 深链形状继续封死在这一层，组件只见「来源 → 该走哪条路」。
4. **不另写 TG 可用性判据**：一律消费 `store/selectors.ts::resolveTgFeatureReady`（BUG-177）。
5. **不新增权限、不改 Tauri 配置**：`opener:default` 已含 `allow-open-url`（§1.3）；
   若实现时需要动 `capabilities/default.json`，说明设计跑偏了。
6. **不改 `TgPanel.selectedId` 的语义**：只**新增**一条「由 store 焦点驱动选中」的通道；
   既有的「自动选首个频道」（`:639`）行为保持。
7. **Tauri 内禁止用 `window.open` 做外部打开**（WebView2 无可达通道 —— 正是当前缺陷的成因）。
8. **「插件未开启」是降级不是失败**：分支 B 不得渲染成错误态/警告色（用户裁定它是**正常退路**）。
9. **不得把 `pendingTgFocus` 与 `pendingMediaFocus` 合并**：两者语义不同（TG 坐标 vs 媒体库条目 ref），
   合并会让两个视图抢同一个槽（BUG-262 的教训：语义跳变）。
10. **分支 A 与 B 必须同一期交付**（§4 排序）：只交付一半 = 把入口做成半成品。

---

## 7. 关联

- **`BUG-285`（open）—— 本条是它的复报（不新开号）**：
  285 的诉求「加『在 TG 中查看』入口」**已落地**（`mediaSources.ts:325-330` + `SeriesDetail.tsx:1011-1022`），
  但**形态不成立**：裸深链 + 无插件感知 + 无降级 ⇒ 用户在桌面壳里点不动。
  本条把 285 的「入口」补齐成「**入口 + 分支 + 通道**」。
- **`BUG-286`（open）**：网页模式缺 `isTauri()` 守卫。**分支 B 的网页路径必须带守卫**（判据 3），
  否则会把 286 的错误复制到新代码里。
- **`BUG-177` / `BUG-178`**：TG 门控判据唯一来源 + 服务层与链路层不打架。**本条沿用** `resolveTgFeatureReady`。
- **`BUG-094`**：「未绑定不弹回」—— 分支 B 的触发条件里含「未绑定」，
  与 094 的裁定**一致**（未绑定 = TG 不可用 ⇒ 走外部打开，而不是把用户弹走）。
- **`BUG-283` / `BUG-296`**：占位名/无标内容**正是最需要这个入口的内容** ——
  它们的标题不可辨认，唯一的人工辨认手段就是跳回源头看一眼。本条的入口是它们的**用户可见出口**。
- **既有同构先例（照抄对象）**：`pendingMediaFocus`（`useStore.ts:192` / `CacheManagerDialog.tsx:916` /
  `MediaLibraryPanel.tsx:500-528`）。
- 设计文档：`docs/design/ingest-fact-layer-2026-10-13.md`（其 `IFL-T06` 的「媒体库侧出口」与本条的入口**互补**：
  那条解决「未编入的条目怎么被看见」，本条解决「看见之后怎么回源头」）。

---

## 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-10-13 | 初版：由用户当日报障「在 TG 中查看的实现有严重问题（应插件感知 → 应用内跳频道定位；插件未开启则外部打开）」收成一处设计；取证确认当前为裸 `<a target="_blank">`（全仓仅 2 处、无 `on_new_window` 处理器）⇒ 桌面壳内无通道；确认 `opener:default` 已含 `allow-open-url`（零新增权限）、`resolveTgFeatureReady` 为门控唯一真源；给出 `pendingTgFocus` store 增量 + `sourceJumpTarget` 判别式 + `TGJ-T01`~`TGJ-T04` 任务表；7 条可反向证伪判据、10 条红线；登记为 **BUG-285 的复报** | 架构分析（AI 协作者） |
