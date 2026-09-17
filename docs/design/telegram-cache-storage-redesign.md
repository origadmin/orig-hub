# Telegram 缓存 / 存储架构改造设计（问题 4 前瞻性分析）

> 状态：**设计分析，未实现**。触发：用户反馈 TG 缓存功能存在严重问题（无进度、无法清除、是否正确缓存存疑），且剧集缺外链联动、后期需支持网盘 / OSS / S3。
> 结论前置：当前 `media_item.source` 仅 `'local'/'tg'` 字符串 + `file_path` 本地路径，**无法支撑**缓存进度、外链映射、多后端扩展。需建模缓存状态与多条外链（`media_link` 表），存储后端**抽象层延后**（P1 用 `match` 分发，P4 网盘/OSS 接入时再抽 trait）。评审见 §8，决策见 §9。

---

## 1. 现状（基于代码事实）

媒体库当前分两层（均在 orig-tg / SQLite 同库）：

| 层 | 表 | 职责 | 当前状态 |
|---|---|---|---|
| TG 流水 | `media_message` | 随频道同步自动增删，用户不直接编辑 | 只读，UI 由 `TgPanel` 渲染 |
| 用户资料库 | `media_item` / `media_series` / `media_episode` / `media_tag` | 本次新增，用户显式导入整理 | 可用，但 `source` 仅 local/tg |

orig-tg 现有 TG 缓存相关端点（`crates/orig-tg/src/routes.rs` + `tg.ts`）：

- `GET /api/tg/local/{chat}/{msg}` — 已缓存文件的本地流（支持 Range，不回源）
- `POST /api/tg/cache/clear` — 一次性全量清理（缩略图/临时媒体）
- `GET /api/tg/file` / `GET /api/tg/thumb` — 回源 TG 取文件 / 缩略图

`media_item` 关键字段（media.rs）：

```
source    TEXT   -- 仅 'local' | 'tg'，无后端类型枚举
ref       TEXT   -- 本地=路径哈希；tg=chat:msg
file_path TEXT   -- 仅本地路径；tg 条目此处为空
poster    TEXT   -- 前端 canvas 抽帧回写
```

**缺字段**：`cache_status` / `cache_progress` / `external_ref`（源对象定位）/ `link_url`（可跳转外链）/ `cached_at`。

---

## 2. 核心缺陷（对应你提的几点）

1. **缓存无进度、无状态**：下载 / 回源进度未建模，前端无法显示「缓存中 / 已完成 / 失败」，也无法重试。`TgPanel` 只有 `listTgStored`，无进度 UI。
2. **清除不可见、不可控**：`cache/clear` 是一次性全清，没有「仅清某项」「清除进度可视化」「是否正确缓存校验」（即清完无法确认磁盘文件是否真的存在 / 已删除）。
3. **剧集缺外链联动**：剧集 / 单集当前只指向本地 `item`；TG 可能是消息深链（`t.me/c/...`），但 `link_url` 未建模，点击无法跳回 TG 原消息。「缓存中视频需找到对应对象」= 缺 `external_ref` 把缓存文件映射回 TG 消息 / 源对象。
4. **存储后端硬编码**：`source` 仅 local/tg，无法扩展网盘 / WebDAV / OSS / S3。后期需求明确要支持，当前架构直接不支持。

---

## 3. 目标模型

### 3.1 存储后端抽象
```
enum SourceBackend { Local, Telegram, Webdav, Oss, S3 }
```
- `Local`：读 `file_path` / `cache_path`。
- `Telegram`：用 `external_ref`（chat:msg）回源，写 `cache_path`，产进度。
- `Webdav / Oss / S3`：用 `external_ref`（如 `oss://bucket/key`、`s3://bucket/key`）取流或生成预签名 URL。

### 3.2 数据模型（评审修正版，见 §8 坑1/坑2）

`media_item` 新增列（**不**加 `external_ref`/`link_url` 单列，理由见 §8）：

```
source_type    TEXT     -- 后端类型：'local' | 'telegram'（预留 'webdav'/'oss'/'s3'，不实现）
cache_status   TEXT     -- none | caching | cached | failed
cache_progress REAL     -- 0..1
cache_path     TEXT     -- 相对 cache 根的路径（命中后 raw 直读；存相对路径，见 §8 坑4b）
cached_at      INTEGER
```

- **取流定位复用现有字段**：telegram 条目的 `ref`（`chat:msg`）即取流定位，`ref` 保留为去重键不变；`local` 条目继续用 `file_path`。**不新增 `external_ref` 列**，避免双字段漂移与数据回填。

外链 / 来源改为**关联表**（单资源多目标：网盘×N、TG×N）：

```
media_link
  id           INTEGER PK
  resource_type TEXT    -- 'item' | 'series' | 'episode'
  resource_id  INTEGER
  backend      TEXT     -- 'telegram' | 'webdav' | 'oss' | 's3' | 'external'
  url          TEXT     -- 人可点外链（t.me/c/... / 分享链接）
  ref          TEXT     -- 可空；机器定位（如 chat:msg），backend=telegram 时可用于回源缓存
  label        TEXT     -- 展示名（如「阿里云盘」「TG 频道」）
  sort_order   INTEGER
  created_at   INTEGER
```

- `backend='telegram'` 且 `ref` 非空 → 该链接是**可取流来源候选**（缓存 worker 用）；其余纯展示跳转。
- 一张表覆盖 item/series/episode 三资源，替代原设计「三处各加一列」。

### 3.3 统一取流（评审修正：不做流式回源）
`mediaItemUrl(id)` 后端按 `source_type + cache_status` 决策：
- 本地直读 / 已缓存读 `cache_path`（Range 流）
- **未缓存不自动回源**：点击未缓存条目 → 提示并显式「缓存」→ 进度可见 → 完成后可播。
  避免「一次误点 = 大文件全量下载」的流量坑；grammers 边下边播（流式回源）复杂度高，推 P3+。

### 3.4 缓存任务服务（评审修正：DB + 轮询，不建 SSE）
orig-tg 内建异步缓存 worker（任务队列去重），`cache_status / cache_progress` **落库**；
前端 1s 轮询列表接口取进度（orig-tg 现无 SSE 基础设施，grep 证实无 `text/event-stream`/broadcast 通道——
为进度单建 SSE 是隐性大工程，P1 不做）。提供「重新校验」接口确认磁盘文件存在性。

### 3.5 缓存落盘（裁定方案：下载目录 + 点前缀内部缓存目录）
```
<download_dir>/.media-cache/<item_id>_<ref哈希>.<ext>
```
- `cache_path` 存**相对 cache 根的相对路径**（`download_dir` 可被用户变更，绝对路径会失效）。
- 文件名用 `item_id + ref 哈希`，避免原始文件名冲突/特殊字符。
- 与自动分类共存：分类仅在**新下载落盘时**决定输出路径（`resolve_output_classified`），**不回扫**下载目录
  （代码证据：config.rs:456-475），故缓存目录不会被分类搬走；但用户手动整理下载目录会删缓存 → 依赖「重新校验」。
- 配额上限策略待定（LRU / 手动清理），见 §7。

### 3.6 清除 API（粒度化）
- `POST /api/media/items/:id/cache/clear` — 按 item 清
- `POST /api/media/series/:id/cache/clear` — 按剧集清
- 返回受影响计数 + 校验结果（清完回查磁盘）
- **必须收敛旧接口**：现有 `POST /api/tg/cache/clear` 全清（缩略图/临时媒体）需排除 `.media-cache/`
  或同步重置相关 item 的 `cache_status`，否则全清一次 → item 缓存状态全脏（§8 坑6）。

---

## 4. 分层修改点

| 层 | 文件 | 改动 |
|---|---|---|
| DB schema | `media.rs::migrate` | `media_item` 新增 5 列（旧库幂等 ALTER，同 `media_episode.description` 先例）；新建 `media_link` 表；不需要 `media_cache_task` 表（worker 队列在内存，状态落 `media_item`） |
| 存储抽象 | 新增 `orig-storage` 或 `media.rs::source` 模块 | Local / Telegram / Webdav / Oss / S3 实现 `fetch(ref)->stream` + `presign(url)` |
| 路由 | `routes.rs` | 新增 `/items/:id/cache`、`/cache/clear`、`/items/:id/link`；`raw` 按 cache_status 决策 |
| 同步层 | TG monitor | 落库时写 `external_ref`/`link_url`，触发缓存任务 |
| 前端 | `TgPanel` / `MediaCard` / `SeriesDetail` | cache 徽标 + 进度条；外链按钮；清除弹窗（选粒度 + 进度 + 校验） |
| 配置 | `download-engine.toml` / daemon config | 各后端凭据（OSS/S3/Webdav） |

---

## 5. 难度评估

- **难度：高**。
  - schema 迁移 + 异步缓存 worker + 多后端适配。
  - OSS/S3 需引入 SDK（Rust：`aws-sdk-s3` / 阿里云 SDK），增加编译体积与凭据管理面。
  - ffmpeg 缺失：缓存文件若需转码 / 抽帧仍只能靠前端 canvas（现状已如此，需注意）。
  - 多后端鉴权安全（凭据不入库 / 走配置）。
- **工作量估算**（2026-09-17 评审后下调，见 §8 坑7；不含 OSS/S3 真实联调）：engine 2–3 人日、前端 1.5–2 人日、验证 1–2 人日。

---

## 6. 分阶段建议（评审裁剪版）

- **P1（解 TG 痛点，砍掉独立抽象层）**：`source_type/cache_status/cache_progress/cache_path/cached_at`
  五列 + `media_link` 表迁移；TG 回源缓存 worker（去重队列）+ DB 进度轮询；
  `.media-cache` 落盘 + 按 item/series 清除与校验；TG 取流定位复用 `ref`。
  取流分发用 `match source_type` 两分支（Local 直读 / TG 回源），**不建 trait**。
- **P2（外链联动）**：`media_link` 的增删改查 UI + 外链跳转按钮（三资源统一）；
  TG 链接（有 ref）可一键「从此外链缓存」。
- **P3（流式回源 / 播放体验，可选）**：边下边播、缓存完成自动续播。
- **P4（扩展后端，方向性保留不实现）**：WebDAV / OSS / S3——届时再把 `match` 重构为 trait、引入 SDK。
  `backend` 字段与 `media_link.backend` 已预留 `'webdav'/'oss'/'s3'` 值。

原「P3 后端统一取流抽象」被裁掉：为尚不存在的后端先付抽象税是过度设计，两个分支用 match 足够。

---

## 7. 待拍板（评审后余项）

1. ~~是否按「SourceBackend 抽象 + cache_status」方向推进？~~ → 方向确认，但抽象层延后（见 §6 P1/P4）。
2. ~~外链形式？~~ → **多条外链**，`media_link` 关联表（单资源多目标：网盘×N、TG×N）。已裁定。
3. ~~OSS/S3 本期是否要？~~ → **不实现、不引 SDK**，仅字段层预留。已裁定。
4. ~~缓存落盘位置？~~ → **`<download_dir>/.media-cache/`（点前缀）**，相对路径存储。已裁定。
5. **缓存配额策略**：LRU 自动淘汰（按 cached_at + 大小上限）还是仅手动清理？
6. **TG 回源并发上限**：同时缓存几个 item（建议 1-2，避免 TG 限流）？

---

## 8. 评审发现的坑（2026-09-17，含代码证据）

1. **外链 1:N 建模错误（结构性，已修）**：原 `link_url TEXT` 单列 + series/episode 各加一列，
   无法表达「网盘×N、TG×N」→ 改 `media_link` 关联表（§3.2），一张表覆盖三资源，反而更简单。
2. **`ref` 与 `external_ref` 双字段漂移（已修）**：tg 条目 `ref` 本就是 `chat:msg` 取流定位，
   再加 `external_ref` 会冗余且需数据回填 → 复用 `ref`，不加列。
3. **SSE 进度是隐性大工程（已裁）**：orig-tg 无任何 SSE/broadcast 基础设施（grep 证实），
   原设计「经 SSE 推前端」= 新建推送通道 → 改 DB 落库 + 1s 轮询。
4. **缓存目录三个残留坑**：
   a) Windows 下点前缀**无隐藏属性语义**，仅是命名空间约定（可接受）；
   b) `download_dir` 被用户变更 → 绝对路径全失效 → **`cache_path` 必须存相对路径**；
   c) 用户手动整理下载目录会误删缓存 → 「重新校验」接口是必须品而非锦上添花。
   （分类器已排除：仅落盘时定路径、不回扫目录，`config.rs:456-475`。）
5. **点击即回源的流量坑（已修）**：未缓存自动回源 = 一次误点全量下载 → 改显式缓存按钮（§3.3）。
6. **两套清除逻辑互踩**：旧 `/api/tg/cache/clear` 全清若波及 `.media-cache/` → cache_status 全脏
   → 全清接口需排除缓存目录或同步重置状态（§3.6）。
7. **复杂度总评**：原方案「有点复杂」的三个来源——SSE 通道、trait 抽象、OSS SDK——全部被裁掉或延后。
   估算下调：engine 3-5 → **2-3 人日**，前端 2-3 → **1.5-2 人日**，验证 1-2 人日不变。

---

## 9. 决策记录（2026-09-17 用户裁定）

| # | 决策 | 内容 | 影响 |
|---|---|---|---|
| D1 | 外链多条 | 单资源多目标（网盘×N、TG×N） | `media_link` 关联表取代 link_url 单列（§3.2） |
| D2 | OSS 方向 | 不是马上要，但是目标方向 | 不引 SDK；`backend` 预留 `'oss'/'s3'/'webdav'`，P4 再实现 |
| D3 | 缓存落盘 | 下载目录 + 内部缓存目录（`.` 前缀） | `<download_dir>/.media-cache/`，相对路径存储（§3.5） |
| D4 | 推进方式 | 先评审（本文档 §8），评审完由用户决定是否开始全部修复 | 本文档为评审交付物，未写任何实现代码 |
