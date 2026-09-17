# AGENTS.md — Orig Hub 协作约定

本文件定义 AI 智能体与协作者在本仓库工作的统一规则，对标 `orig-cms-ee` 的治理范式。

## 1. 仓库结构（双舱）

| 舱 | 路径 | 说明 |
|---|---|---|
| 下载内核 | `download-engine/` | Rust Cargo workspace，crate：`orig-core`(引擎)、`orig-net`、`orig-protocol-{http,virtual}`、`orig-daemon`(REST/SSE 守护进程) |
| 桌面壳 | `tauri-shell/` | Tauri v2 壳，`src-tauri/`(Rust) + `src/`(React 前端) |

> 不在仓库保留 Wails/Go 残留（`ui/`、`go.work*` 已清理）。内核通过 sidecar 模式被 Tauri 壳调用，**非 cgo FFI**。

## 2. 提交约定（强制）

格式：`<type>(<scope>): <subject>`

- type：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `style`
- scope：`engine`（内核）/ `shell`（Tauri 壳+前端）/ `docs` / `build`
- 示例：`feat(engine): 支持 Content-Disposition 文件名嗅探`

要求：

- 二进制（sidecar `*.exe`、`target/`、`dist/`、`node_modules/`、`/bin`、`/data`）**绝不入库**（已由根 `.gitignore` 覆盖）。
- 提交前确保 `cargo build`（engine）与 `npm run build`（shell 前端）通过。
- 不 `--no-verify` 跳过钩子，除非显式授权。

## 3. 缺陷追踪

- 每个缺陷一个文件：`docs/bugs/BUG-XXX.md`（编号自增，参考 `docs/bugs/README.md` 模板）。
- 状态机：`open` → `in_progress` → `fixed` / `wontfix` → `closed`。

## 4. 分支模型

- 主分支 `main`，保护分支，禁止直接 force。
- 临时工作用 `feature/xxx`，合并后删除。
- 禁止保留 `go-backup` / `backup/original-main` 这类迁移残留分支（待清理确认）。

## 5. 代码层约束

- 引擎侧：速度采样集中在 `run()` 主循环，`progress()` 只读缓存，避免多消费者抢采样 delta。
- 前端侧：状态统一经 `tauri-shell/src/store/useStore.ts` 的 SSE 合并；非活动任务速度必须为 0。
- 文件名解析顺序：用户显式 `filename` → `Content-Disposition` → URL path → `<id>.bin`，并依据 `Content-Type` 纠正扩展名。
- **流畅优先（BUG-026）**：进度类高频数据只允许影响「正在变化的那一小块 UI」，禁止整面板重渲染。
  - 轮询三律：有活才轮（终态即停）；等值短路（快照签名未变不 setState）；失败退避。
  - 轮询频率上限 5s（BUG-030）：任务/列表类轮询不得高于 5s 一次；同一数据只允许一个轮询源——
    多面板（如 TgPanel 主轮询与缓存管理面板）并存时，打开面板即由面板接管，主轮询暂停；进度条
    用 `Progress smoothMs≈轮询周期` 做视觉平滑补偿，不得靠缩短轮询间隔换流畅。
  - 被轮询的读端点**不许碰 DB**——内存快照（唯一写者在 DB 变更后刷新），SQLite 只承担写入。
  - 高频路径组件必须 `memo` 化；回调用 useEvent（引用恒定 + 数据回传式 `on(item)`），禁止内联箭头。
- **单飞呈现（BUG-027）**：进度类任务的端点**只返回一个结果**（`{task}` 而非 `{tasks[]}`）；
  执行侧单飞——同一时刻至多一个 worker 在跑，多任务一律排队 FIFO 接续。
- **进度变化零派生请求（BUG-027）**：轮询周期内只允许轮询本身的请求（1s = 1 请求）；
  任何重清单刷新只能由任务终态等**离散事件**触发，禁止由每次进度变化触发。
- **TG 拉流并行 + 元数据缓存（BUG-028）**：在线流式端点禁止裸 `iter_download` 串行吐流
  （单流吞吐 = chunk/RTT ≈ 0.5MB/s，播放器必然卡顿），必须走 `parallel_range_stream`
  （K=4 分片并行、按序合并）；媒体元数据/缩略图必须过 `lru.rs::TtlLru` 缓存——
  同一 `(chat,msg)` 的 seek/续 Range/重渲染不得重复付出 `get_messages_by_id` RPC（~1.2s）。
- **缓存即入库 + 双向删除联动（BUG-029）**：任何缓存成功路径（worker/手动）**必须**
  `upsert_media_item(source="tg", ref="{chat}:{msg}", ...)`——媒体库是缓存的主视图，
  只写 `media_message` 等于内容对用户不可见。删除必须**双向联动**：清缓存 → 删对应
  media_item；删 TG 来源条目 → 清缓存副本。单向删除会在下次缓存 upsert 时「复活」，
  表现为删不掉。ref 约定全局唯一：`source="tg"`、`ref="<chat_id>:<message_id>"`。
- **restart_tg.py 必须以 Popen+wait 托管**：Windows 的 `os.execve` 是「spawn+立即退出(0)」
  的模拟，父进程退出即被任务托管判定结束并回收进程树（服务刚连上就被杀）。
- **投递契约铁律（BUG-031）**：`/api/media/items/:id/raw`（媒体库）与 `/api/tg/local/:chat/:msg`
  （TG 已缓存）**必须共用同一实现**（`serve_local_file`）——两条路径都直接喂 `<video>`，
  分叉即意味着「其中一条会退化」。契约：无 Range → 200 + **完整文件**（绝不只给前 N 字节）；
  `bytes=S-` → 206 + 32MiB 有界块 + 如实 `Content-Range`；`bytes=S-E` → 206 + 尊重请求；
  恒带 `ETag`/`Last-Modified`（缺了 Chromium 会重复下载已取字节）；MIME 按扩展名判定，
  **禁止 `image/jpeg` 之类兜底值**（会把视频误标成静态图导致拒播）。
  新增/修改任一路径，必须同步 `probe_media.py` 的「delivery path」两组断言。
- **迁移与启动期依赖（BUG-032）**：建表批（`execute_batch`）里**只允许出现新旧库都存在的列**——
  引用待 `ALTER TABLE` 补上的列会让整批迁移失败，且 SQLite 报错位置与真实原因（顺序）无关。
  凡 schema 变更，必须配一条「旧库 → 新代码」迁移单测（造旧 schema + 塞旧数据 → `open` 成功 +
  数据仍在，例：`media::tests::legacy_db_migrates_without_failing_open`）。
  启动期依赖（存储库、会话、客户端）打开失败一律**显式失败**（`EXIT_*` 退出码 + 打印实际路径），
  **禁止回落空实现** —— `:memory:` 兜底会把 schema 错误伪装成「用户数据全没了」。
- **投递问题先出线上字节账，再谈优化（BUG-031 / BUG-033）**：「大量 raw 请求 / 播放卡死」
  类现象先跑 `verify_shots/diag_rate_storm.cjs`（CDP 逐请求落地字节 + 落地区间并集去重 +
  `loadstart`/`emptied` 计数），并且**必须分别在 1x 与倍速下各记一段** ——
  1x 完全正常的通路在 2x 下可能放大数十倍（实测 2→137 请求、冗余 2x→63x）。
  已实测否定、**勿再调参**的候选：回包块大小（1/4/8/32MiB/EOF）、前端
  `preload`（auto/metadata/none）、浏览器缓存开关、按 Range 形态分流
  （seek 与顺序播放同为 open-ended `bytes=S-`，不可区分）。
- **投递必须做背压（BUG-033）**：本地千兆下服务端灌数据的速率（数百 MB/s）远超解码器消费速率
  （码率 × `playbackRate`），Chromium 会读满 buffer 即 abort 并在**同一区域反复重取** ——
  实测 2x 播放 10s 内 137 请求 / 792 MiB / 冗余 63x，在 WebView2 里就是界面卡死。
  `serve_local_file` 必须按「码率 × `DELIVERY_BUDGET_FACTOR`」节流（`duration` 不可得时回落
  `DELIVERY_FALLBACK_BPS`），可用 `ORIG_TG_DELIVERY_BPS` 覆盖以便 A/B，无需重编。
  判断标准：**倍速下的冗余倍数应在个位数**（当前 3–4x）。新增任何投递端点必须同样过背压，
  并纳入 `diag_rate_storm.cjs` 回归。
