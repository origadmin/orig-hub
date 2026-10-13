# 后端架构与模块划分

> **⚠️ 里程碑编号以 [tasks.md](tasks.md)（四轮版）为准**：M1=媒体拆库迁入 daemon（即本文结论，D2=A，关闭 BUG-172）；
> M2=文件成品化（完成即入库 D16）；M3=/api/activity 注册表泛化与前端接线（D7）；
> ffmpeg 诊断/设置/受管安装 = M5；共享 = M6；插件化 = M7。本文正文若出现旧编号（M3=迁媒体等）以 tasks.md 映射为准。

- 配套：[spec.md](spec.md) §6（拓扑演进）、[03-data-model-and-migration.md](03-data-model-and-migration.md)（拆库细节）、[04-api-contracts.md](04-api-contracts.md)（端点契约）
- 范围：`download-engine/` Cargo workspace，7 个 crate / 33 个 Rust 文件
- 结论先行：**不新增 sidecar、不新增二进制。把 orig-tg 从「TG + 缓存 + 整个媒体库 + ffmpeg 转码」收缩为「TG 采集插件面」；媒体/文件/ffmpeg/共享全部归无凭证必启动的 orig-daemon 核心面。投递能力抽共享 crate 供两服共用。**

---

## 1. 现状拓扑（取证 2026-10-13）

```
Tauri 壳(src-tauri/lib.rs 管 sidecar 进程)
   │ 127.0.0.1:19786 + Bearer/?token=
   ▼
orig-daemon（无凭证必启动）
   ├─ 下载引擎（orig-core）：任务 CRUD、SSE /api/events、activity
   ├─ 配置：/api/config*（手写 TOML parser，config.rs）
   ├─ 网络：/api/interfaces、/api/proxy/verify
   └─ 进程托管：/api/tg/restart，按 tg_enabled（默认 true）拉起 orig-tg
            │
            ▼ （独立端口，需 TG 凭证前置：lib.rs 凭证门禁）
        orig-tg（grammers/MTProto，二进制比 daemon 大 5.00 MiB）
            ├─ TG：session/dialogs/folders/messages/monitor/thumb/file/local
            ├─ 缓存：/api/cache/*、cache_task 队列、peer_cache、TtlLru
            ├─ 媒体库：整个 /api/media/*（9 表，media.rs 6576 行，对 TG client 引用 0）
            ├─ 投递：serve_local_file（routes.rs:5084，raw 与 tg/local 共用）
            └─ ffmpeg：转码泵 transcode_pump（约 L4634/L4721）+ ffmpeg_caps 探测
```

错位点：媒体库在代码层已完全脱离 TG（media.rs/cache.rs/store.rs 对 TG client 引用为 0、媒体路由不做 `ensure_authorized`），物理上却寄宿在「没配 TG 就起不来」的进程里（BUG-172）。

---

## 2. 目标拓扑（M3 后）

```
Tauri 壳
   ▼
orig-daemon（核心面：装了应用就必然可用）
   ├─ 下载 / SSE / 配置（既有）
   ├─ 文件事实层 /api/files/*（M2 起在此设计，M3 落 daemon；M2 过渡期在 orig-tg）
   ├─ 媒体库 /api/media/*（M3 迁入）
   │     └─ raw/stream 投递 + transcode_pump + ffmpeg_caps（M3 迁入）
   ├─ ffmpeg 诊断/设置（M1 在 orig-tg，M3 随媒体迁入）、受管安装（M4）
   ├─ 共享只读面 /s/* + /api/share/*（M5，独立网卡绑定，默认不监听）
   └─ 托管拉起 orig-tg（仅 tg_enabled 且有凭证时）
            │
            ▼
        orig-tg（插件面：只剩采集与过程态）
            ├─ TG 会话/对话/频道/监控/搜索（既有）
            ├─ 字节缓存 /api/cache/*、cache_task、TtlLru（既有）
            ├─ 缓存入库：不再直写 media_*，改调 daemon 内部端点 POST /api/media/ingest（见 §5）
            └─ 投递：/api/tg/local/* 仍由此服务，但底层调用共享 crate 的 serve_local_file
```

进程数仍为 2；磁盘占用不新增；前端媒体访问 base 改一行（`api/media.ts`）。

---

## 3. Crate 级职责划分

| crate | 现状职责 | 目标变化 |
|---|---|---|
| orig-core | 下载引擎、协议、注册表、路径 | 不变 |
| orig-net | 连接池/探测 | 不变 |
| orig-protocol-http | 下载协议 HTTP（单 lib.rs） | 不变；**不**塞入文件投递（避免下载协议与文件服务耦合） |
| orig-protocol-virtual | 虚拟协议 | 不变 |
| orig-daemon | 下载 + REST/SSE + 配置 + 托管 | **M2/M3 扩张为核心面**：新增 modules `media/`、`files/`、`ffmpeg/`、`share/`（M5）；持有 library.db |
| orig-tg | TG + 缓存 + 媒体 + ffmpeg | **M3 收缩为插件面**：移出 media.rs 与媒体路由/转码；缓存入库改 HTTP |
| **orig-file-serve（新，M3）** | — | 新增**无网络协议依赖的文件投递 crate**：`serve_local_file`（Range/206/ETag/Last-Modified/MIME/码率背压）；orig-daemon 与 orig-tg 共同依赖。备选：并入 orig-protocol-http（弃，理由如上） |
| orig-ctl | CLI | 不变 |

`orig-file-serve` 初版 API 草案（dev-plan 期可微调）：

```rust
pub struct ServeOptions { pub kind: Option<String>, pub duration: Option<f64>, pub budget_factor: f64 }
pub async fn serve_local_file(path: &Path, opts: ServeOptions, headers: &HeaderMap) -> Response;
// 不变量：无 Range→200 全文；bytes=S-→206+32MiB 有界块+如实 Content-Range；
// 恒带 ETag/Last-Modified；MIME 按扩展名，禁止 image/jpeg 兜底；非环回按码率×factor 节流。
```

- 迁移方式：routes.rs:5084 函数体**原样剪切** + 单测同迁（现有 `serve_local_file_first_byte_is_immediate`、`serve_local_file_still_throttles` 等测试约 L7040 起跟随），先让两服务都依赖它且行为不变，再做路由迁移。顺序铁律：**先共享 crate，后迁路由**。

---

## 4. 文件级处置清单（21 个业务源文件 + 新增）

### 4.1 orig-tg（15 文件）

| 文件 | 行数级 | 处置 | 阶段 |
|---|---|---|---|
| `main.rs` / `lib.rs` | 小 | 留：二进制入口、凭证前置门禁、service 装配 | — |
| `state.rs` | 中 | 留：TG 运行态；删除其中库连接/媒体状态装配 | M3 |
| `grammers.rs` / `login.rs` / `monitor.rs` | 大 | 留：MTProto 栈、登录、监控频道 | — |
| `cache.rs` | 1.4k | 留：字节缓存过程态；**缓存成功 upsert media_item 改调 daemon ingest 端点**（§5） | M3 |
| `lru.rs` | 小 | 留：缩略图/媒体元数据 TtlLru（§D3 要求） | — |
| `store.rs` | 1.8k | **拆**：TG 域 7 表 + TG 键存储留此（`tg_store.db`）；通用建表/迁移工具与 `library_dir` 等库域键、9 张 media_* 表 DDL 随 media 迁 daemon（`library.db`） | M3 |
| `media.rs` | 6.6k | **迁** orig-daemon `src/modules/media/`（mod 化：items/series/tags/scan/export 可分文件，但先整文件平移再拆） | M3 |
| `routes.rs` | 7.6k+ | **三分**：TG 路由 + /api/cache 挂载留；/api/media/* 与 raw/stream 迁 daemon；`serve_local_file`（L5084）先去 orig-file-serve；ffmpeg 诊断/设置（M1 新增）M3 随迁 | M1/M3 |
| `ffmpeg_caps.rs` | 中 | M1 留在 orig-tg 加诊断端点；M3 迁 daemon `modules/ffmpeg/caps.rs`（探测纯函数，无 TG 依赖） | M1/M3 |
| `config.rs` | 小 | 留：TG 侧配置；ffmpeg 设置键（M1 新增于 app_setting）M3 迁库 | M3 |
| `unavailable.rs` / `mock.rs` | 小 | 留：功能不可用态与测试桩；媒体不可用态在 M3 后从本服摘除 | M3 |

### 4.2 orig-daemon（6 文件 → 模块化）

| 文件 | 处置 |
|---|---|
| `main.rs` | 启动装配：加载 library.db（M3，失败 `EXIT_*` 禁内存库）、ffmpeg 配置、按需第二监听（M5） |
| `state.rs` | 新增：库连接池、文件事实快照、ffmpeg 有效配置、ingest 通道、共享运行态 |
| `routes.rs` | 从 13 路由的单文件变为 router 聚合：downloads/events/config（既有）+ `modules::media/files/ffmpeg/share` 挂载；既有下载/配置逻辑逐步 mod 化但 M0-M1 不强求 |
| `config.rs` | 手写 TOML 扩展键：`ffmpeg.*`（M3 迁入后）、`share.*`（M5）；沿用现有 parser，不引新依赖除非计划期批准 |
| `activity.rs` / `status.rs` | 留；健康语义增加「库可用/插件可用」两维（M3-T06） |

新增模块（M3 起）：

```
orig-daemon/src/modules/
  media/        # ← media.rs 平移后拆分
  files/        # FileFact 查询（M2 设计先在 orig-tg 验证，M3 平移）
  ffmpeg/       # caps 探测 + 有效配置 + 安装器（M4）
  share/        # 只读面 + 令牌 + 访问记录（M5）
```

---

## 5. 端点清单：现状 → 目标

### 5.1 orig-daemon 现状（13 条，全部保留）

`/health`、`/api/downloads`（GET/POST）、`/api/downloads/:id...`（L935）、`/api/events`(SSE)、`/api/activity`、`/api/interfaces`、`/api/config`、`/api/config/classify`、`/api/config/proxy`、`/api/config/download`、`/api/proxy/verify`、`/api/config/tg`、`/api/tg/restart`。

- 变化：M3 起新增 `/api/media/*`（迁入）、`/api/files/*`（M2 设计 / M3 落此）、`/api/ffmpeg/*`（M1 在 tg / M3 迁入）、`/api/media/ingest`（M3 新增内部端点）、`/api/share/*`（M5）、`/s/*`（M5 第二监听）。

### 5.2 orig-tg 端点分组（约 40 条，去留映射）

| 现状组（代表路由） | 去留 |
|---|---|
| `/health` `/debug` | 留；健康语义区分 TG 就绪度 |
| 会话：`/api/tg/session` `/start` `/code` `/logs` `/diag` | 留 |
| 采集：`/api/tg/dialogs` `/folders` `/messages/:id` `/monitor/*` `/stored` `/downloaded/:id` | 留 |
| 媒体获取：`/api/tg/thumb/:c/:m` `/file/:c/:m` `/download/:c/:m` | 留（TG 通道能力） |
| 本地投递：`/api/tg/local/:c/:m` | 留路径，实现改调 orig-file-serve（M3） |
| 缓存：`/api/tg/cache/*`（clear、tasks、priority、by-item 等 L53-79）+ `.merge(cache::router())` 的 `/api/cache/*` | 全部留 |
| TG 配置：`/api/tg/config` GET/PUT | 留；删库域键（library_dir），库键改由 daemon 提供（M3） |
| ffmpeg（M1 新增）：`/api/ffmpeg/status` `/config` GET/PUT | M1 加在本服；M3 随媒体迁 daemon，路径不变 |
| `/api/media/stats` | **迁 daemon（M3）** |
| `/api/media/items*`（含 `:id/raw` `:id/stream` `by-ref` `by-refs` `:id/tags`） | **迁 daemon（M3）** |
| `/api/media/series/*` `episodes/*` `sources/*`（L121-184 系列） | **迁 daemon（M3）** |
| `/api/media/tags*`、`/api/media/scan`、`/api/media/export*` | **迁 daemon（M3）** |

前端 base 改向仅 `tauri-shell/src/api/media.ts` 一处；所有 `/api/tg/*` 客户端不变。

### 5.3 新增的进程间内部契约（M3 关键）

拆库后 cache.rs 不能再直写 `media_item`（缓存即入库 §D4 必须保留）。新增 daemon **环回内部端点**：

- `POST /api/media/ingest`：仅绑环回 + 共享 daemon token；body = 缓存完成事件（source=`tg`、ref=`<chat>:<msg>`、路径、大小、kind、caption 快照、时长等）。
- 语义：按 `source+ref` 幂等 upsert（与现「缓存即入库」完全一致，只是跨进程）；失败由 cache 任务侧重试/标记，不丢字节（清缓存联动铁律不变）。
- 该端点**不**进共享面 `/s/*`，绝不对外。

---

## 6. 数据所有权与并发（M3 后）

- `library.db` 单写者 = orig-daemon；orig-tg 对库的写只剩 ingest HTTP 一条路。
- `tg_store.db` 单写者 = orig-tg；daemon 不读 TG 库（caption 在入库时快照到库侧，消除 daemon→tg 反向依赖）。
- 启动顺序：daemon 先就绪（库可用即服务可用）→ 再按开关拉起 orig-tg；TG 崩溃/未装不影响库与播放。
- 健康两维：`library.ready`（库迁移/连接）与 `tg.ready`（凭证+会话）；前端 `media.offline` 相应拆两态。

---

## 7. sidecar 生命周期与交付物

- 二进制清单不变（orig-daemon.exe / orig-tg.exe）；M3 后体积变化预期：daemon 增大、tg 减小（grammers 仍在 tg）。
- TG 数据目录不变：`%LocalAppData%\OrigHub\tg\`（session/store.db）；库文件新址：同根 `library.db`（精确定位以 [03-data-model-and-migration.md](03-data-model-and-migration.md) 为准）。
- ffmpeg 安装目标：`%LocalAppData%\OrigHub\bin\ffmpeg.exe`（M4）。
- `scripts/sync-sidecars.sh`：M3 后仍两副本四处同步清单，但两服职责变化要更新清单注释；`--check` 是 M3 必跑验收。

---

## 8. 后端约束检查单（每期）

1. 媒体路径不得出现 grammers/TG client（`cargo tree -p orig-daemon`、grep 双证）。
2. 投递只允许经 orig-file-serve；新增投递端点同步 `probe_media.py` 与 `diag_rate_storm.cjs`。
3. 启动期依赖失败显式失败，禁 `:memory:`；schema 变更带旧库→新代码迁移单测。
4. 被轮询读端点走内存快照，不碰 DB（§D1）。
5. 流式端点禁止裸 iter_download，须 parallel_range_stream K=4（§D3，留在 tg 域，M3 不动）。
6. ffmpeg 唯一 spawn 点仍是转code泵；M4 安装器的 `ffmpeg -version` 回读是短生命周期命令，不算转码 spawn。
