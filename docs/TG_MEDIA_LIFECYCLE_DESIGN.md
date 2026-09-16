# Orig Hub — 频道分组拉取优化 + 媒体在线预览/点播 + 设置结构整理 设计

> **版本**: v0.4.0（UAT 反馈后增补：文件夹修复/三栏交互/历史分页/缩略图）
> **日期**: 2026-09-16
> **上游基线**: `TG_CHANNEL_AGGREGATOR_DESIGN.md` v0.1.4（accepted）
> **关联 BUG**: BUG-013（分组拉取慢/分组缺失/假分页）、BUG-014（媒体预览性能与排版）、BUG-015（三栏交互/历史分页/聊天式时序），均 open。
> **状态**: v0.4.0 增补定稿，进入开发

## 快速概览（TL;DR）

| 项 | 说明 |
|---|---|
| 问题 | ① 分组 `/api/tg/dialogs` 单次全量 15.5s+，前端拿不到/卡死；② 入库媒体列表每条仅 `id/mimeType/size`，无内容端点，图/视频看不到、无法选下载/浏览；③ 设置页结构乱（TG 模块开关混入「账号」Tab、缓存清理无处安放） |
| 根因 | ① dialogs 无分页/无缓存；② orig-tg 未暴露媒体内容端点，无可渲染字节流；③ 设置页把「模块启停」与「账号绑定」叠在同 Tab，区块归属不清 |
| 方案 | ① 分组：增量分页（max_id 游标）+ SQLite 缓存 + 前端懒加载；② 媒体：**先做在线预览/点播**——新增 `/api/tg/file/{chat}/{msg}`（照片→JPEG、视频→Range 流），前端 `<img>` 点显 / `<video>` 点放，**不预下载、不做本地归档**；③ 设置：TG 模块开关迁「通用」默认开（检测 orig-tg 即启动）+ 该区加「清理 TG 缓存」；「账号」只留绑定/登录/诊断 |
| 改动范围 | sidecar `orig-tg`（分页 + 缓存 + 媒体流端点 + messages 增强 + 缓存清理接口）；`orig-daemon`（TG 自动拉起与状态、缓存清理透传/执行）；前端 `tauri-shell`（分组懒加载、媒体点看/点放、设置结构整理） |
| 不改 | 传输内核、下载后本地归档链路（作为后续演进，不在本期 MVP）、转码仍 Phase 2、控制面/数据面分离架构 |
| 关键验证 | 分组首屏 < 3s、二次毫秒级、滚动续拉；频道媒体图片点开即显、视频点击即播（在线流式，末预下载）；设置里 TG 默认开、可一键清缓存、账号页不再管模块开关 |
| 核心洞察 | 媒体 MVP 走「在线轻量」路线：预览/点播直接流式，遵守网速/流量、不过度缓存无用数据；下载归档留作后续增强。设置结构性：模块开关属于「功能」不属「账号」 |

## 1. 现状与问题（实测）

- `GET /api/tg/dialogs`：全量平铺数组，**15.5s / 30-50KB**，无分页无缓存 → 单次全量极慢。
- `GET /api/tg/messages/{chat}?limit=`：每条 `{id,mimeType,size}`（照片多 caption），**无 type/fileName/内容 URL**；`orig-tg` 无任何 `/file|media|thumbnail` 内容路由（实测 404）；`orig-daemon`(9876) 不代理 `/api/tg/*`（实测 404）。
- 设置页：`accounts` Tab 内 `TG 可选插件` 启停开关 + `AccountsPanel`（绑定/登录/诊断）叠放；无 TG 缓存清理入口；自动分类规则编辑器嵌在「下载」Tab 大段内联（用户判定：仅轻量优化，非本期重点）。

## 2. 方案（本期焦点）

### 2.1 分组：增量 + 缓存 + 懒加载
- sidecar：`GET /api/tg/dialogs?limit=&offset_id=` 走 Telegram `max_id` 游标分页，返回 `{items,next_offset}`；攒成 SQLite 缓存，`?cached=1` 秒回。
- 前端：分组列表懒加载，首屏 `limit=50` 滚动续拉。

### 2.2 媒体：在线预览/点播（不预下载）
- 新增 `GET /api/tg/file/{chat}/{msg}`：照片 → JPEG 字节（`?w=` 可缩略，节流量）；视频 → HTTP Range 分段。
- `messages` 响应单条增强：注入 `type`(photo/video/audio/file) / `fileName` / `date` / `hasMedia`。
- 前端：媒体列表图片点开即显、视频点击即播，均走在线流式；**不触发下载、不做本地归档**。
- 带宽/流量约束：缩略图走小尺寸；视频仅拉当前播放段（Range）；预览内容不入库、超时即释放。

> 下载后本地浏览/整理/播放的「入库」链路不做，作为后续演进（对齐上游 §4.2，但不在本期落地）。

### 2.3 设置结构整理
- 「通用」新增「TG 模块」区块（Divider 分段列表）：
  - 「TG 模块」开关：**默认开启**；启动时检测 orig-tg（health/进程）可用即拉起；显示 running/starting/stopped 状态。
  - 「清理 TG 缓存」项：调用后端清缩略图/临时媒体缓存，带二次确认 + 结果提示。
- 「账号」Tab：移除 TG 模块开关，仅保留 `AccountsPanel`（登录/绑定/诊断）。
- 自动分类规则编辑器：仅轻量排版优化，不做大改。

### 2.4 后端接口（OG 变更，需评审确认）
| 域 | 方法/路径 | 说明 |
|---|---|---|
| orig-tg | GET `/api/tg/dialogs?limit=&offset_id=&cached=` | 分页/缓存枚举 |
| orig-tg | GET `/api/tg/file/{chat}/{msg}` | 媒体在线流（照片/视频 Range） |
| orig-tg | GET `/api/tg/messages/{chat}?limit=&offset_id=` | 分页 + 单条增强 |
| orig-tg | POST `/api/tg/cache/clear` | 清 TG 缓存 |
| daemon | daemon 向 orig-tg 的启动/健康管理（`tg_enabled` 默认 true + 检测拉起）+ 透传缓存清理 | 模块默认开 |

## 3. 任务拆分（供多 AI 并行）

| 任务 | 舱 | 范围 | 提交流 |
|---|---|---|---|
| T1 分组分页+缓存 | engine(orig-tg) | dialogs 游标分页 + SQLite 缓存 + cached | `feat(engine): ...` |
| T2 媒体在线流 | engine(orig-tg) | `/file/:chat/:msg`（照片/视频 Range）+ messages 增强 | `feat(engine): ...` |
| T3 TG 默认开 + 缓存清理 | engine(daemon+orig-tg) | 启动检测拉起、`tg_enabled` 默认 true、`/cache/clear` | `feat(engine): ...` |
| T4 前端分组懒加载 + 媒体点看/点放 | shell | 分组分页、`<img>/<video>` 在线预览点播 | `feat(shell): ...` |
| T5 设置结构整理 | shell | TG 开关迁通用默认开 + 缓存清理入口 + 账号页清理 | `feat(shell): ...` |

顺序：T1→T2→T3 可并行互不依赖；T4/T5 依契约 mock 先行。本期要做的 2 个硬需求 = **T2（媒体在线流） + T5（设置整理）**，随带 T1/T3 使分组与默认开落地。

## 4. 验收

- [ ] `cargo build --release` + `npm run build` 通过
- [ ] 分组：首屏 < 3s、二次 < 200ms、滚动续拉（截图）
- [ ] 媒体：频道图片点开即显、视频点击即播（在线流式，未触发下载）（截图）
- [ ] 设置：TG 模块默认开 + 检测拉起；「清理 TG 缓存」二次确认 + 结果；账号页不再显示模块开关

## 5. v0.4.0 增补（2026-09-16 UAT 反馈定案）

> 触发：v0.3.0 上线 Web 实测后，用户反馈 5 项问题（详见 BUG-013/014/015）。本节为对 §2 方案的修订与扩展；与前文冲突处以本节为准。

### 5.1 分组：缓存优先 + 后台全量扫描（替代 §2.1 的游标增量）

- 实证：`take_dialogs()` 每次新建 `iter_dialogs()` 从头枚举，路由层循环调用只会反复 upsert 前 50 条 → total 恒 50、`hasMore=false`。
- 定案：`GET /api/tg/dialogs` **永远先读 SQLite 缓存分页**（秒回）；缓存为空或 `refresh=1` 时 spawn **一次**后台全量扫描（全量 `iter_dialogs` + folder 映射逐条 upsert），响应增 `scanning:bool`，前端轮询至扫描结束。AppState 加扫描互斥；启动授权后自动首扫。
- 文件夹修复：`folders()` 同时接受 `dialogFilter` 与 `dialogFilterChatlist`；`include_peers` 统一转 Bot API 对话 id（Channel/Supergroup `-1000000000000-id`、Chat `-id`、User `+id`、含 FromMessage 变体）；加诊断日志实证 filters 原始数量。

### 5.2 三栏交互（替代 §2/T4 的单栏列表）

```
左：导航            中：频道             右：内容
─ 监控中 (N) ★     频道行 + 添加监控      聊天式媒体流
─ <TG 文件夹…>     （监控视图为本地列表）  最新在底部
─ 未分组                                 滚到顶加载更早历史
```

- 「监控中」读本地 `GET /monitor/channels` 秒显，与订阅枚举解耦；文件夹视图读 dialogs 缓存，频道可「添加/已添加」。

### 5.3 内容：媒体过滤 + 历史分页 + 聊天式时序

- `Client::messages(chat, limit, before_id)`：grammers `iter_messages().offset_id(before)`；**只返回媒体消息**（内部翻页收集够 limit 条媒体，设扫描上限）。
- `GET /api/tg/monitor/messages?channelId=&limit=&beforeId=`：本地优先，不足一页时以 `beforeId 或本地最小 id` 为锚实时向 TG 回补入库再返回；响应 `{items,hasMore}`。
- `media_message` 增列 `media_type`、`msg_date`（幂等迁移）；StoredMessage 序列化 `type`/`date`；`created_at` 仍为入库时间，排序一律以 `message_id` 为准。
- 前端：最新在底、进入滚底；滚顶 prepend 并锚定滚动位置；只含媒体消息。

### 5.4 缩略图与性能（修订 §2.2）

- 新增 `GET /api/tg/thumb/:chat/:msg`：照片取宽度 ≤480 的最大 `PhotoSize`；视频取 `Document.thumbs()`（优先内嵌 Cached，否则下载小尺寸 JPEG）；`image/jpeg`、可缓存。
- PeerRef 缓存：枚举 dialogs 时填充 `HashMap<bot_api_id, PeerRef>`；`media()/messages()/thumb()` 命中即免去全量枚举（实测该枚举占首字节 3.8~4.5s）。
- 前端：图片自然比例缩略图（不裁切）+ 点击原图遮罩；视频缩略图 + 播放按钮，点击才挂载 `<video>` 走 `/file/` Range 流。

### 5.5 接口变更汇总（相对 v0.3.0）

| 方法/路径 | 变更 |
|---|---|
| GET `/api/tg/dialogs` | 响应增 `scanning`；改为缓存优先 + 后台扫描（offset/limit 仍保留，读缓存） |
| GET `/api/tg/folders` | 修 id 空间 + Chatlist 兼容 + 诊断日志（行为修复，契约不变） |
| GET `/api/tg/monitor/messages` | 增 `beforeId`；响应由 `[]` 改为 `{items,hasMore}` |
| GET `/api/tg/thumb/:chat/:msg` | **新增**：缩略图字节流 |
| StoredMessage | 增 `type`、`date`（消息真实时间） |

## 变更历史

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.2.0 | 2026-09-16 | 初版：分组分批 + 媒体「在线预览 × 本地归档」三段式 |
| v0.3.0 | 2026-09-16 | 范围修正（用户定案）：媒体砍掉本地归档，**只做在线预览/点播、不预下载**；新增设置结构整理（TG 默认开+缓存清理+账号页去开关）；分组方案保留 |
| v0.4.0 | 2026-09-16 | UAT 反馈增补：folders id 空间/Chatlist 修复、dialogs 改缓存优先+后台全量扫描、三栏交互、消息媒体过滤+beforeId 历史分页+聊天式时序、缩略图端点、PeerRef 缓存、StoredMessage 增 type/date（BUG-013/014/015） |