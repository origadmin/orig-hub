# TG 面板：组级封面 + 点击展开（第 3 点）

- **日期**：2026-10-22
- **来源**：用户第 3 点「内容加载影响：和 TG 不一样，我们要的是过滤下载，而不是一个聊天 TG，
  所以图片即时加载是否改成列表点击加载整个组内容，排版也改成这种适合模式？」
- **状态**：已落地（前端），**UI 实测待用户起栈后跑**（见 §五）

---

## 一、问题：一个相册 = 十个实时回源请求

| 事实 | 位置 |
| --- | --- |
| 相册已聚合为单元，但**全部瓦片一次性渲染** | `TgPanel.tsx::groupAlbums` + `AlbumBubble` 宫格 |
| 每个瓦片一个 `<img src={tgThumbUrl(...)}>` | `AlbumBubble` / `PhotoBlock` / `VideoBlock` |
| `thumb` 端点**没有服务端缓存** | `routes.rs:thumb` → `client.thumb()` 实时回源 Telegram |
| 只有浏览器 `max-age=86400` 一层 | 响应头 |

⇒ TG 相册上限 10 张，一个相册 = 10 个缩略图请求 = 10 次 Telegram RPC；
滚一屏（10 个相册）就是 100 次。这不是「加载慢」，是**在为一个聊天式浏览界面
烧下载器的 RPC 预算**。

而产品定位不是聊天：用户原话「我们要的是过滤下载，而不是一个聊天 TG」。
聊天界面需要「每条消息都即时可见」；过滤下载只需要「能认出这是不是我想要的」。

## 二、方案：L1 组级封面

### 2.1 三档对比（评估时已列，此处复述结论）

| 档 | 形态 | 首屏请求 | 识别度 | 改动面 |
| --- | --- | --- | --- | --- |
| L0（原状） | 全部瓦片即时渲染 | 每相册 N 个 | 最高 | 0 |
| **L1（采用）** | **1 张封面 + 数量角标，点击展开整组** | **每相册 1 个** | 高（有图可看） | 中 |
| L2 | 纯文字列表，无图 | 0 | 低（一半内容盲选） | 小 |

选 L1 的理由：L2 把「有图可看」这个唯一的视觉识别线索也砍掉了，用户要在
几十条里盲选；L1 用 1/10 的请求换到同样的识别能力。

### 2.2 折叠判据（三选一）

```ts
const collapsible = items.length > 1 && !!onToggleExpand
const open = expanded || highlighted || !collapsible
```

| 条件 | 为什么 |
| --- | --- |
| 宿主没给 `onToggleExpand` | **恒展开**。不留「点了没反应」的按钮（BUG-324 死按钮） |
| `highlighted`（BUG-305 定位） | **强制展开**。用户要的是「回到这条内容」，把目标藏在折叠态里等于定位失败 |
| 单条 | 本身就是 1 张封面，没有「展开」可言 |

### 2.3 交互语义

- 折叠态点击 = **展开整组**（不是打开大图）。用户原话「列表点击加载整个组内容」，
  所以第一次点击的语义是"把组摊开"。
- 展开态点击瓦片 = 打开大图预览（原行为不变）。
- 展开后状态行出现「收起」（唯一的回退入口）。
- 整组缓存按钮**不受折叠影响**：缓存作用于全部条目，与看不看得到无关。

### 2.4 展开态存在哪

`TgPanel` 层（`Set<string>`，键 = `album-{首条 key}`），**不在 `AlbumBubble` 内部**：
气泡会随 feed 重渲染/重排，状态留在内部会被重置 —— 用户展开完一滚动又收回去。

## 三、落地

| 位置 | 改动 |
| --- | --- |
| `TgPanel.tsx` | `expandedAlbums` + `toggleAlbum`（`useCallback`） |
| `AlbumBubble` | `expanded` / `onToggleExpand` 两个 props（后者可选，缺省恒展开） |
| `AlbumBubble` | 折叠态渲染 `data-testid="album-cover"`（`data-count` = 组内条数） |
| `AlbumBubble` | 展开态状态行加 `data-testid="album-collapse"` |
| i18n | `tg.albumExpandHint` / `tg.albumCollapse`（中英） |

## 四、判据（写进验收脚本的形态）

1. **折叠态只有一个 `<img>`**：`[data-testid=album-cover] img` 计数 = 1，
   且同组内不存在第二个 `tg-thumb` 请求（用 `performance.getEntriesByType('resource')`
   过滤 `/api/tg/thumb/`，断言该组消息 id 只出现 1 个）。
2. **点击后请求数 = 组内条数**：点 `album-cover` 后，该组 N 条消息的 thumb 请求
   全部出现（这才是「点击加载整组内容」）。
3. **点击前不预加载**：折叠态下该组第 2..N 条消息的 thumb **零请求**
   （只断言 DOM 里没有 `<img>` 不够 —— `loading=lazy` 也会在视口内触发）。
4. **数量角标**：`album-cover-count` 的文本 = 组内条数，且组内条数 > 1。
5. **高亮强制展开**（BUG-305 回归）：带 `highlighted` 的相册不出现 `album-cover`。
6. **单条不折叠**：`unit.length === 1` 时走 `MessageBubble`，没有 `album-cover`。

## 五、未做 / 待办

- **UI 实测未跑**：需要用户用 `scripts/dev/dev-stack.cmd` 起 dev 栈（`5180`），
  然后按 §四 的六条断言跑真实渲染。当前只做了 `tsc --noEmit`（通过）。
  **不要**把「tsc 通过」当成验收 —— 这是布局/请求数判据，必须真渲染。
- **展开态没有记忆到下次进入**：刷新/切频道后回到全部折叠。是否要持久化
  （localStorage）未定；先看用起来是否碍事。
- **`+N` 溢出角标**（`ALBUM_MAX_TILES = 10`）在展开态保留原逻辑：TG 相册上限
  就是 10，溢出分支只对 >10 起防御作用。
