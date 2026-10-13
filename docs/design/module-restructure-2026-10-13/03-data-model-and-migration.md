# 数据模型与拆库迁移设计

- 配套：[02-backend-architecture.md](02-backend-architecture.md) §6（写者仲裁）、spec.md §9 M3
- 现状：单库 `store.db`（TG 数据目录 `%LocalAppData%\OrigHub\tg\store.db`），16 张表同住。
- 目标：`tg_store.db`（TG 过程态，7 表）+ `library.db`（库域，9 表 + 库键）物理分离；单写者各归其主进程。

---

## 1. 现状表清单（取证 2026-10-13）

### 1.1 TG 域（store.rs 建表，7 张）

| 表 | 主键/唯一 | 语义 | 去留 |
|---|---|---|---|
| `monitored_channel` | channel_id | 监控频道 | tg_store.db |
| `media_message` | (channel_id, message_id) | 频道消息流水（caption/mime/size/file_path/group_id…） | tg_store.db |
| `sync_cursor` | channel_id | 监控同步水位 | tg_store.db |
| `dialog_cache` | id | 会话列表缓存 | tg_store.db |
| `cache_task` | id；active 唯一索引 item_key | 缓存任务队列（含 priority，BUG-277） | tg_store.db |
| `cache_task_item_wall` | (task_id, message_id) | 条目级墙钟累计（BUG-276，跨进程存活） | tg_store.db |
| `app_setting` | key | 键值（**两域共用**） | 拆（§3） |

### 1.2 库域（media.rs 建表，9 张）

| 表 | 关键列/约束 | 语义 |
|---|---|---|
| `media_item` | id，UNIQUE(source, ref)；kind 索引；title/description/file_path/poster/size/duration/width/height/added_at | 条目事实（ref 全局唯一 `<chat_id>:<message_id>`） |
| `media_series` | id；source_key 条件唯一索引（BUG-031） | 剧集 |
| `media_episode` | id，UNIQUE(series_id, season, episode_no)；含合并溯源列 origin_series_title/origin_episode_no/episode_no_end、description | 分集 |
| `media_tag` | name UNIQUE | 标签字典 |
| `media_item_tag` | (item_id, tag_id) | 条目-标签 |
| `media_series_tag` | (series_id, tag_id) | 剧集-标签 |
| `media_episode_source` | item_id UNIQUE，(episode_id,item_id) 唯一 | 同槽备用播放来源（BUG-039） |
| `media_episode_image` | (episode_id,item_id,sort_no) | 集级浏览位图（BUG-168） |
| `media_episode_removed` | 建表单列（BUG-032 纪律：单独 CREATE 不进建表批） | 移除记录 |

另有触发器（`trg_media_episode_cleanup_sources` 等，先 DROP 再 CREATE 纪律）迁移时按定义原样复制。

### 1.3 耦合实测

- 跨域读：TG 侧 4 处运行时读取，全部只读 `media_message.caption` 一个字段；反向引用 0（09-28 文档 F9）。
- 历史迁移已多次从 caption 回填媒体文案：`backfill_item_text`（caption 首行→title）、`backfill_raw_file_titles`（BUG-256）、`collapse_episode_text`、`backfill_episode_desc_inherit`（BUG-281）——**说明「入库时把 caption 快照到库侧」本来就是既有数据纪律**，M3 只是把运行时残留读也切掉。
- `cache.rs` 缓存成功路径 upsert media_item（缓存即入库 §D4）：拆库后这是唯一跨进程写，走 daemon ingest HTTP（§6）。

---

## 2. 目标物理布局

```
%LocalAppData%\OrigHub\
  tg\
    session.session
    store.db         → 迁后改名 tg_store.db（见 §5 步骤 5，兼容旧路径）
  library.db         → 新增（M3）
  bin\ffmpeg.exe     → M4
```

| 库 | 单写者 | 表 |
|---|---|---|
| tg_store.db | orig-tg | §1.1 前 6 表 + app_setting（仅 TG 键） |
| library.db | orig-daemon | §1.2 全部 9 表 + 触发器/索引 + app_setting（仅库键）+ `schema_migration`（新增，见 §5） |

两库均为 libsql 本地连接；不引入网络数据库、不引新 crate（除非 dev-plan 期另行批准）。

---

## 3. app_setting 键拆分表

| 键 | 当前使用者 | 权威归属（M3 后） |
|---|---|---|
| `library_dir` | media.rs 多处、cache.rs:1770、store.rs:919 | **library.db**（daemon） |
| `download_dir` | routes.rs:828/884、cache.rs:70 | daemon TOML 为权威；**M1 前核对与 TOML 的同步方向**（见下注），M3 后 tg 侧删除此键、经 daemon 取值 |
| `download_item_max_secs` / `download_idle_max_secs` | routes 配置 API（采样参数） | daemon（采样属引擎职责）；M3 迁 library.db 或 daemon TOML，dev-plan 期按 §D1「采样单一真源」定 |
| TG 配置键集合（`/api/tg/config` get/put 现存键，迁移时枚举补全） | orig-tg | tg_store.db |
| `ffmpeg.path` / `ffmpeg.hwaccel` / `ffmpeg.device`（M1 新增） | M1 orig-tg | M1 写 tg_store.db；**M3 迁 library.db**（随转码泵迁 daemon），一次性键迁移 |

注：`download_dir` 双源（daemon TOML 与 app_setting）是现状疑点；M1-T05 的配置所有权常量化必须先回答「谁写谁缓存」，禁止拆库时把双源原样搬进两个库。

---

## 4. caption 运行时依赖消除（快照方案）

**方案（推荐）**：库侧自含展示文案，运行时零跨域。

- 入库（含 M3 起 `POST /api/media/ingest`）必须同时带 `title` 与 `description` 快照：title = caption 首行（沿用现有解析纪律）、description = caption 正文；相册组按 BUG-281 的继承逻辑由 daemon 侧重放。
- 删除 TG 侧 4 处 `media_message.caption` 运行时读；历史上只依赖这些读的展示路径改读 item 快照列。
- 验收：停掉 orig-tg（或库单独运行）时剧集/条目文案完整；grep 证明 daemon media 模块无 tg_store 文件访问。

备选（不推荐）：daemon 经 HTTP 回调 orig-tg 查 caption——把「媒体不依赖 TG」从文件层破坏成网络层，TG 离线即文案缺失；仅当发现存在「快照无法表达」的字段时再个案启用。

---

## 5. 迁移 Runbook（M3 执行手册）

### 5.1 设计纪律（AGENTS.md §D7）

- 建表批只允许新旧库都有的列；新增列走 pragma_table_info 探测 + ALTER（media.rs 现有模式）。
- 启动期库失败：打印库绝对路径 + 原因 + `EXIT_DB_*` 退出码，**禁止回落 `:memory:`**。
- 迁移必须有「旧库→新代码」单测；迁移幂等（重复执行不重复搬、不报错）。

### 5.2 首次升级步骤（daemon 启动迁移器，orig-tg 等待其完成）

1. **预检**：定位 `store.db`；校验可打开、`PRAGMA integrity_check`；计算两份文件备份名（`store.db.pre-library-split.bak`，同卷复制，用户数据零删除铁律）。
2. **建库**：`%LocalAppData%\OrigHub\library.db` 不存在则创建，执行 9 表 + 索引 + 触发器 DDL（与 media.rs 现状逐字一致）+ `schema_migration` 表记录迁移名与时间。
3. **拷数**：`ATTACH 'store.db' AS old` 后 `INSERT INTO media_x SELECT ... FROM old.media_x`，按 FK 依赖顺序（item/series/tag → episode → 关联表）；`INSERT OR IGNORE` + 分批事务；库键从 `old.app_setting` 按键白名单复制。
4. **校验**（同事务读一致性）：每表行数一致；抽样 checksum（`COUNT`/`SUM(size)`/最大 updated_at）；source+ref 唯一性；任一不符 → 删除半成品 library.db、报 `EXIT_DB_MIGRATE_VERIFY`、旧库不动。
5. **切换与兼容**：
   - daemon 开始以 library.db 提供媒体服务；
   - orig-tg 启动时检测 `store.db` 已被迁移标记（library.db 中 schema_migration 行 + tg_store.db 中迁移标记键），打开/改名为 `tg_store.db` 并只建 TG 7 表；旧 `store.db` 文件保留（备份），不删除。
6. **ingest 切换**：cache.rs upsert 改调 daemon；保留一个版本的双写观察期？——**不做双写**（双写者违规）；改为发布顺序保证：先发布带迁移器与 ingest 的 daemon，orig-tg 在同版发布时切换（sidecar 同步脚本保证两服同版）。

### 5.3 回滚

- 迁移器未通过校验：自动回滚（删新库、旧库继续用），应用照常启动到旧行为。
- 已切换后回滚版本：旧版二进制用备份 `store.db`（迁移动作只复制不改写旧表）；切换后新增的库条目需要恢复脚本（dev-plan 期评估：M3 是否提供 library→store 反向导出工具；默认不提供，回滚窗口 = 当次发布前）。

### 5.4 单测清单（`cargo test`）

1. 旧库夹具（含每表若干行、历史缺列形态）→ 迁移 → 行数/抽样字段/索引/触发器齐备；
2. 重复迁移幂等；
3. 校验失败路径（人为制造行数不一致）→ 退出码、无库残留；
4. 旧库锁定/损坏 → 显式失败非内存库；
5. caption 快照：ingest 入库后停 tg 连接，文案仍可读；
6. 现有 media.rs 全部迁移/回填测试在新库连接下保持通过。

---

## 6. FileFact 数据模型（M2，v1 不建表）

文件事实层本期**派生视图**（与 ingest-fact-layer「可派生不建表」原则一致），不新增持久表：

```rust
pub struct FileFact {
    pub fact_id: String,          // 稳定派生 id：root_id + ":" + rel_path 哈希/规范化
    pub root_id: String,          // 受管根标识："library" | "download:<class>" | ...
    pub root_path: PathBuf,
    pub rel_path: PathBuf,
    pub size: u64,
    pub mtime: u64,
    pub kind: FileKind,           // video|photo|audio|doc|archive|other（按扩展名/MIME）
    pub origin: FactOrigin,       // Download { task_id } | Tg { chat, msg } | Import | Unknown
    pub media_item_id: Option<i64>, // 投影命中的 media_item.id
    pub health: FactHealth,       // Ok | OrphanEntry(有条目无文件) | Unmanaged(有文件无条目)
}
```

- 数据源三路 join：① FS 扫描受管根（下载分类目录 + library_dir）；② 下载任务记录（daemon 内存/持久态）；③ `media_item` 投影。
- 性能：扫描结果内存快照 + 目录增量事件/定时低频刷新（频率上限 5s 且遵守轮询三律）；HTTP 读端点只读快照不碰 DB/FS 重扫（§D1）。
- v2 演进（不在本期）：当下载目录量级或导入来源多到扫描昂贵时，再评估持久化 `file_fact` 表；届时由本模型直接落表，UI 契约不变。
- 不变量：「文件夹」视图文件总数 = FS 事实；「内容」视图 = FileFact ∩ media_item（kind ∈ 媒体类）；同一文件两处计数不翻倍（UI 验收 AC）。

---

## 7. 与既有 BUG/约束的核对

| 约束 | 本文档如何遵守 |
|---|---|
| 缓存即入库（§D4） | ingest 端点保留 source+ref 幂等 upsert 全语义 |
| 删除联动单向（§D4） | 清缓存只回收字节（tg_store/缓存目录），永不删 library.db 条目；删 TG 条目由 daemon 连字节删除（字节在库根，daemon 有权） |
| 建表批纪律（§D7） | §5.1 沿用 pragma+ALTER 模式；media_episode_removed 继续单独建表 |
| BUG-031/033 投递 | 字节不搬位置（library_dir 不变），只搬服务；投递函数共享 crate |
| 采样单一真源（§D1） | 采样键随引擎归 daemon（§3），tg 不持副本 |
