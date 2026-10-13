# 任务清单：模块重整与大型重构（spec.md 配套）

- 日期：2026-10-13（同日按二轮/三轮/四轮决策重写，里程碑以本版为准）
- 状态：**IA 相关决策已全部拍板（D2/D7/D10/D12-D17=A），本清单可执行；实施人选另行评估。**
- 效力：本文件与 [09-revision-2026-10-13-v2.md](09-revision-2026-10-13-v2.md) §7/§9/§10 冲突时以 09 为准；
  界面形态以 `prototype/`（v3，五项导航 + 双树、下载无页内 tabs）为可视化真值。
- 约定：
  - 每个 Task = 一次可独立提交的变更（英文 message + LF，遵守 commit-msg 门禁，`fix` 须引用 BUG 号）。
  - 每期开工前 `git fetch origin` 并确认 `git rev-list --left-right --count origin/main...main` 左列为 0、工作区 clean。
  - Task 内文件路径相对仓库根；行号为 2026-10-13 取证时的近似锚点，动手前以当前代码为准复核。
  - 「搬运不改写」= 允许移动/包裹/改导入路径，禁止顺手改数据流与业务逻辑。
  - 前端构建输出一律落仓外临时目录或已 ignore 的 `dist/`、`tauri-shell/dist_*/`。

---

## 阶段总览与依赖

```
Q4 工作区 clean（非编码，M0 首个提交前必须完成）
 │
 M0 前端 IA（零后端；下载只改导航，其余现状保留）
 │
 ├─ M1 媒体完全脱离 TG（D2=A，独立核心修复，关闭 BUG-172）
 │     └─ M2 文件域成品化（D13/D16：成品浏览器 + 完成即入库 + 未归档 + 剧集成员管理）
 │           └─ M3 下载 = 全局监控（D7=A：/api/activity 注册表泛化 + 前端接线 + 来源 chips）
 │                 └─ M4 TG 两级化（D10=A 前半：禁三级 Navi、账号已在设置、单账户）
 │
 ├─ M5 ffmpeg 可诊断/可设置 + 受管安装（开工前补批 D3/D4）
 ├─ M6 局域网只读共享（D12=A + D15=A 内容区 segmented）
 └─ M7 插件化（D8/D9/D17）+ TG 多账户（D10=A 后半）
```

依赖说明：

- **M1 是独立成立的核心修复**（用户四轮裁定「媒体库完全脱离 TG，这是核心」），即使后续里程碑不做也必须做；
  M2 是它的受益方而非它存在的理由。M0 过渡期前端仍打现有 `/api/media/*`（orig-tg 端口），M1 完成后一行改向。
- M2 依赖 M1（ingest 落 daemon 媒体模块）；M3 的前端消费在 M0 树结构之上接 `/api/activity`，
  后端泛化不依赖 M1/M2，但排在 M2 后便于同一批 verify 脚本收口。
- M4 只依赖 M0（IA）与 M3（任务移出 TG 面板）；M5/M6/M7 互不阻塞，可按人力插排。
- ffmpeg 现状能力（转码播放）在 M1 随媒体模块整体迁入 daemon，**不拆不丢**；用户可设置/受管安装在 M5。

---

## Q4 — 工作区 clean（流程前置，非决策项）

当前工作区存在大量未提交改动（routes.rs/store.rs/多个前端组件的 M 状态，BUG-293~296、
若干 draft、临时 verify 产物等未跟踪文件）。M0 首个代码提交前必须：

1. 在途 BUG 修复按「修一条 → 提交一条」入库；未达标改动逐条定性（续做 / 回退 / 登记新 BUG）。
2. 临时产物移出仓库（系统临时目录或已 ignore 目录）；过 `sh scripts/check-pollution.sh`。
3. 确认远端对齐：`git fetch origin`；`git rev-list --left-right --count origin/main...main` 左列 0。
4. 验证钩子已安装：`bash scripts/install-hooks.sh`（缺依赖即失败，不静默跳过）。
- 出口：`git status` clean（除规划包文档外）；污染门禁 exit 0。

---

## M0 — 前端信息架构重排：五项一级 + 两棵树（纯前端，零后端改动）

> 禁区（四轮裁定 §10.1）：不改任何 API 端点；下载模块**除导航外全部保留现状**——
> DownloadList 卡片流、DownloadItem 悬停操作（暂停/恢复/取消/打开文件/打开目录/删除）、
> DetailSheet、ContextBar 逐档操作映射（清空仅已完成档）一律不动；**不引入页内状态 tabs**；
> 来源筛选 chips 随 M3 接线引入，M0 不做。

### M0-T01 导航类型与双树 Sidebar

- 文件：
  - `tauri-shell/src/components/Sidebar.tsx`（ViewId L16-23；全部文件行双点击区 L130-149、chevron L269-293）
  - `tauri-shell/src/components/MainLayout.tsx`（view state L257-269；baseVisible L177-189 证明现状文件/三档共用任务表——本任务解除该共用）
  - 新建 `tauri-shell/src/nav/index.ts`（ViewId / NavParams / navigate / 子状态类型）
- 改动：
  1. `ViewId = 'files' | 'download' | 'tg' | 'share' | 'settings'`。
  2. 下载树：父行「下载」= `dlFilter:'all'`（默认落地）；子项 `running/paused/done` 三档，可整组缩起；
     状态选择唯一载体是树，**页面内无 tabs**；ContextBar 标题随树选择变化（复用 TITLE_KEY 机制）。
  3. 文件树：父行「文件」= `fmode:'cat-all'`；展开两组——
     分类组（视频/音乐/图片/文档/压缩/其他，`cat:video|music|image|doc|archive|other`）+
     资料库组（剧集 `lib:series` / 标签 `lib:tags` / 未归档 `lib:unfiled`，带事实计数）；
     drill-in `series:<id>`。
  4. chevron 复用现状原语：点主行导航、点 chevron 只翻转展开（两棵树各自独立，不互斥）；
     折叠态退化（父行直达默认选择）；树子项选中高亮与父行高亮规则同原型 `syncNav()`。
  5. 移除 `resolveTgFeatureReady` 对入口的隐藏（门控移入 TG 面板内部空状态，M0-T05）。
- 验证：`npm.cmd run build`（仓外输出）通过；`tauri-shell/verify/` 截图：五域、双树展开/折叠、
  父行/子项/chevron 三种点击区、折叠侧栏；树切换网络面板无新增派生清单请求（§D2）。

### M0-T02 下载模块容器化（只换挂载与状态来源）

- 文件：
  - 新建 `tauri-shell/src/domains/download/DownloadPanel.tsx`（薄容器：读 dlFilter → 过滤 props；标题/操作沿用 ContextBar 现状）
  - 现有 `components/DownloadList.tsx`、`DownloadItem.tsx`、`DetailSheet.tsx`、`AddDownloadDialog.tsx`、
    `ContextBar.tsx`（搬运不改写，由 MainLayout 挂载点迁入 domains/download）
  - `MainLayout.tsx`（files 不再落 DownloadList；download 落 DownloadPanel）
- 改动：
  1. 四档（全部任务/下载中/已暂停/已完成）过滤由树选择驱动，初始 `'all'`；列表组件本身不改。
  2. 数据源 M0 保持现状（引擎任务端）；TG 任务并入在 M3。失败/error|cancelled 行只在 `all` 可见（现状 baseVisible 语义保留）。
  3. 「新建下载」主按钮维持标题栏右侧（无 FAB）；TG 视图中槽 TgGlobalSearch、右槽 TgCacheEntry 布局不动（BUG-100/164）。
- 验证：四档切换行为与现状逐项对照；非活动任务速度 0；verify 截图；零派生清单请求。

### M0-T03 文件域外壳 + 媒体库拆解搬运（MediaLibraryPanel → files 域）

- 文件：
  - 新建 `tauri-shell/src/domains/files/FilesPanel.tsx`（容器，按 fmode 切换 pane）
  - 新建 `domains/files/panes/`：CategoryPane（分类媒体墙，kind 过滤映射现有 items 数据）、
    SeriesPane（剧集栅格，搬 `View='series'`）、TagsPane（标签云+点选结果，搬 tags 视图）、
    UnfiledPane（未归档）、SeriesDetailPane（剧集详情，搬 `View='seriesDetail'`）
  - 现有 `components/MediaLibraryPanel.tsx`（拆解：toViewerItem、pendingMediaFocus、
    ImportDialog/TagManagerDialog/SeriesDialog 等对话框与 hook 迁入 domains/files 共享，搬运不改写）、
    `components/media/*`（约 20 个，导入路径随迁）
  - `api/media.ts`（M0 不改端点指向，仅模块归属/类型名如需）
- 改动与**过渡口径**（M0 数据源仍在 orig-tg，M1 改向、M2 扩面）：
  1. 父行/分类组 = 成品媒体墙：只显已入库 items（TG 缓存/导入产物，语义上全是成品），**绝不显任务行**；
     引擎下载产物与非媒体文件（pdf/zip/srt 等）在 M2 接入，M0 分类墙暂不含，不做假数据。
  2. 未归档 M0 用现有 items 列表前端过滤 `series_id == null`（M2 改后端参数化查询）；
     空态文案「下载/缓存完成的内容会自动出现在这里」（D16 语义前置，能力 M2 补齐）。
  3. 标签点选结果集、剧集 drill-in/返回行为与现状一致；资料库组计数由离散事件（任务终态/入库完成）触发刷新，不轮询。
- 验证：三视图与现状行为逐项对照（verify 截图 + 手工 lightbox/标签/剧集钻取）；媒体墙中不出现任何进行中任务；
  高频卡片 `memo`。

### M0-T04 剧集详情补「移除成员」入口（关 BUG-112 的前端位）

- 文件：`domains/files/panes/SeriesDetailPane.tsx`（由 MediaLibraryPanel seriesDetail 搬来）
- 改动：图片成员与视频成员一律给常驻半透明「× 移除」（**禁止纯 hover 显露**，BUG-040 教训；原型 `.sd-remove` 口径）；
  移除 = 只断剧集归属（`series_id` 置空 → 落「未归档」），**不删字节、不删 media_item**（AGENTS §5 单向联动）。
- 验证：图片/视频成员均可移除 → 未归档立即可见、字节仍可播；后端若无图片解绑端点则在本任务内补最小端点（这是 M0 唯一允许的后端小改，随本任务提交并在 BUG-112 记录证据）。
- 出口：BUG-112 fixed 证据齐备（截图 + 操作录屏），`fix(shell): ... BUG-112`。

### M0-T05 TG 入口常驻 + 引导空状态

- 文件：`components/TgPanel.tsx`（仅在顶部加未启用/未登录空状态分支，不拆组件）
- 改动：未启用 → 整页引导卡（说明 + 「启用 Telegram 插件」→ `navigate('settings',{section:'tg'})`）；
  已启用未登录 → 「去账号」引导（账号区 M0-T07 已进设置）；已启用路径渲染现有内容。
- 验证：tg_enabled 三态截图；入口在任何状态下不消失（BUG-094 门控口径改变：只影响面板内容，不影响导航位）。

### M0-T06 共享占位页（D12 两级、D15 segmented 在 M6 落地）

- 文件：新建 `domains/share/SharePanel.tsx`（关闭态说明卡 + 「即将推出」，无控件无请求）。
- 验证：build + 截图。

### M0-T07 设置 IA 重排（只移动，不改读写）+ TG 账号区进设置

- 文件：`tauri-shell/src/components/SettingsPanel.tsx`（tabs L26、TG 通用块约 L1006-1096、
  下载目录/libDir 约 L563-595、CacheManagerDialog 挂载约 L1301）、`TgPanel.tsx`（账号区迁出）
- 改动：
  1. 分区改：通用 / 下载与存储 / 网络与代理（proxy+network 合并展示，存储仍各自端点）/
     播放引擎（占位，M5 填充）/ Telegram 插件（启停 + **账号管理区** + 缓存管理入口）/
     共享（占位，M6）/ 关于；divider 列表（去卡片栅格）。
  2. 删除通用区 TG 控件；libDir 展示移到下载与存储（M0 仍写现端点）；
     账号管理为 M7 多账户预留 account_id 字段位（单账户 UI，不做多账户切换）。
- 验证：逐控件操作回归（启停 TG、改目录、账号 CRUD、打开缓存管理）与网络请求端点前后一致（抓包/日志比对）。

### M0-T08 i18n 与命名（D14=A：文件 / 下载 / Telegram）

- 文件：`tauri-shell/src/i18n/locales/zh-CN.json`、`en-US.json`（nav.* L2-8）、ContextBar TITLE_KEY、
  原型对照文案全集
- 改动：`nav.all` 文案改「文件/Files」（key 与 testid 保留 `all` 不动，减少回归）；
  新增下载父行标题（全部任务）；TG 统一品牌名 **Telegram**（不叫「TG 采集」）；
  新导航/分组/空状态全量中英双语；产品定位语统一。
- 验证：构建无缺失键；两语言切换 + 窄侧栏截断截图。

### M0-T09 文档回写（BUG-082）

- 文件：`docs/bugs/BUG-082.md`（追加「后续」节：失败/cancelled/interrupted 的兜底口径改判为
  「下载 → 全部任务」，不再由文件域兜底；注明 M0 实现位置与验证方式，不新开 BUG）。
- 验证：`python scripts/check-bugs.py`（如字段枚举变化）；纯 docs 改动免构建门禁。

### M0 出口

- 一期一提交或按 Task 多提交；`npm.cmd run build` + `tauri-shell/verify/` 全套；汇报四件事。
- 形态对照真值：`prototype/` v3（文件树/下载树/剧集详情）。

---

## M1 — 媒体完全脱离 TG：拆 library.db + 媒体迁入 orig-daemon（D2=A，关闭 BUG-172）

> 依据：`docs/design/media-service-deployment-decision-2026-09-28.md` 推荐路径 **D2-A → D1-B**
> （新增 0 个 sidecar；前端一行改向；TG 降级为可替换采集通道）。事实基础：media.rs（6576 行）
> 对 TG 客户端引用 0 次（BUG-172 F1-F4）。红线：TG→媒体反向依赖保持单向窄接口（F9 4 处 caption 只读）。

### M1-T01 文件归属清单（先文档后代码）

- 产出：在本目录追加 `m1-mapping.md`：逐文件/逐表/逐端点列「迁/留」。
- 已知锚点：迁 = `media.rs`、9 张 `media_*` 表、`/api/media/*`、raw/stream、transcode、ffmpeg 配置键；
  留 = `cache.rs`（TG 过程态）、cache_task 表、TG 5 表、`/api/tg/*`、`/api/tg/local/*`；
  `app_setting` 按键拆分；`store.rs` 拆为各自域内模块或共享建表工具。
- 验证：文档评审自洽；含决策块则过 `python scripts/check-decisions.py`。

### M1-T02 拆库迁移

- 文件：store.rs/media.rs 建表与连接串、orig-tg 启动处、新增迁移代码与单测
- 规则：建表批只含新旧库共有列（AGENTS §D7）；复制式迁移不删旧表；库路径由 daemon 数据目录管理
  （`%LocalAppData%\OrigHub\` 下，与 CWD 无关）；失败 `EXIT_*` + 打印路径，禁回落 `:memory:`。
- 验证：「旧库→新代码」迁移单测：9 表行数、抽样字段、索引一致；库损坏/半迁移显式退出。

### M1-T03 caption 跨域读消除（F9）

- 4 处 `media_message.caption` 只读点改为**入库快照**（入库时 caption 已可用），库侧自含展示文案；
  grep 证明 daemon 媒体路径无 orig-tg HTTP 依赖。
- 验证：停 orig-tg / 断网时库内剧集文案照常显示。

### M1-T04 serve_local_file 抽共享 crate

- 文件：新建或选定共享 crate（候选 `orig-protocol-http`，否则 `orig-file-serve`）；orig-daemon 与 orig-tg 共同依赖。
- 铁律保持（AGENTS §D5，BUG-031/033）：无 Range→200 全文；`bytes=S-`→206+32MiB 有界块+如实
  Content-Range；恒带 ETag/Last-Modified；MIME 按扩展名禁止 jpeg 兜底；码率×`DELIVERY_BUDGET_FACTOR` 节流。
- 验证：`probe_media.py` 两路全项；`diag_rate_storm.cjs` 不回归。

### M1-T05 媒体路由/转码/ffmpeg 现状能力迁入 daemon + 前端改向

- 文件：`orig-daemon`（挂载 `/api/media/*`、转码泵与现有 ffmpeg 探测/配置随迁）、`orig-tg/src/routes.rs`
  （删除媒体段）、Cargo.toml、`tauri-shell/src/api/media.ts`（base 一行改向）、`src-tauri/src/lib.rs`（健康检查语义）
- 验证：
  1. **全新无 TG 凭证环境媒体可读可播（BUG-172 主证据）**；
  2. `cargo tree -p orig-daemon` 无 grammers；orig-tg 无 `media_*` SQL（grep 证据）；
  3. `scripts/sync-sidecars.sh --check` 通过；
  4. M0 文件域三视图在改向后行为零变化（verify 对照截图）；现有转码播放链路不回归。

### M1-T06 健康/自愈语义拆分

- 改动：`media.offline` 拆「库不可用/服务不可用」两态；自愈只拉起对应服务；前端连接点语义区分 daemon/orig-tg。
- 验证：分别停 daemon / 停 orig-tg 的 UI 状态与重试目标准确。

### M1 出口

- BUG-172 fixed 登记（可核证据 = 无凭证环境录屏/截图 + 上述命令输出）；提交 `fix(engine): detach media service from tg plugin BUG-172`。

---

## M2 — 文件域成品化：完成即入库 + 成品浏览器扩面（D13/D16=A）

> 产品口径（用户原话）：「缓存后应该进入文件管理，这是需求」——HTTP 下载完成、TG 缓存完成
> （现状「缓存即入库」已满足，AGENTS §5）、导入完成三类成品一律自动出现在文件域，零额外用户动作。
> v1 **不做物理目录树浏览**（D16-C4）；物理定位走开文件/打开目录。

### M2-T00 前置文档

- `docs/MEDIA-DESIGN.md` 表述与新拓扑对齐（文件层=通用事实源；媒体视图是其媒体领域投影；服务在 daemon）。
- 评审并定案 `docs/design/ingest-fact-layer-2026-10-13.md`（如仍适用，按 daemon 归属修订 IFL 条目）。

### M2-T01 daemon 完成即入库（ingest-on-complete）

- 文件：`orig-daemon` 媒体模块（M1 迁入）+ 引擎完成事件接线
- 改动：orig-core 下载完成事件 → daemon ingest（类型探测→建 media_item，source=http，ref 用任务/URL 稳定标识）；
  与 TG 现状 upsert（source='tg', ref=`<chat>:<msg>`）共用同一幂等入口；导入路径 source=local。
- 规则：幂等单测（同一完成事件重复 ingest 不重复建，复用 source+ref 唯一约束）；
  ingest 失败显式标记、可重试，不静默丢；不经 orig-tg、不依赖 TG 存活。
- 验证：端到端「HTTP 下载完成 → 文件域立即可见 → 可播放」；断 TG 进程重复下载回归。

### M2-T02 成品浏览器扩面：非媒体文件 + 无字节「在线」条目

- 文件：`orig-daemon` 文件事实装配（受管下载根 × 任务记录 × media_item 投影；只读内存快照，§D1 端点不碰 DB/不现场扫盘）、
  `domains/files/panes/CategoryPane.tsx`、新建 `api/files.ts`
- 改动：
  1. 六分类覆盖全部成品：视频/音乐/图片走媒体卡（海报/时长/缩略图）；文档/压缩/其他走非媒体文件行
     （kind 图标 + 打开文件/打开目录）；同一成品不双计。
  2. 无字节条目（TG 图片 hasMediaBytes=false）：正常出现在图片分类与资料库，卡面常驻「在线/未缓存」标，
     点击按现状重缓存/投递链路走；来源失效不阻断库浏览（BUG-147 不变量）。
  3. 孤儿条目（有条目无字节且非在线来源）：保留现状「缺失遮罩 + 移除条目」。
- 验证：视频+pdf+zip+srt+在线图片混合夹具 verify；删除联动回归（清缓存不删条目 / 删 TG 条目连字节，BUG-051/096）。

### M2-T03 未归档后端参数化 + 批量归集

- 文件：daemon 媒体列表端加 `series_id IS NULL` 过滤参数；UnfiledPane 去前端全量过滤；
  批量「归入剧集」工具栏（原型 pane-unfiled）。
- 验证：大库（千条级）未归档查询不卡 UI；归集后计数与各 pane 一致。

### M2-T04 存量补录（一次性迁移扫描）

- 改动：升级后对受管根内历史已完成文件做一次性 ingest 扫描（带幂等）；用户无「加入媒体库」常规操作。
- 验证：在含历史文件的旧库上升级一次，文件域成品数与磁盘一致；重复执行不产生重复条目。

### M2-T05 完成事件前端串通（零新增轮询）

- 文件：`tauri-shell/src/store/useStore.ts`（SSE 合并处只加导航/toast，不加轮询）、下载完成跳转点
- 改动：完成态「定位文件」走统一导航契约 `navigate('files',{fmode,ref})` 并高亮目标卡；
  toast 口径「已加入文件」；资料库/未归档计数由离散完成事件刷新。
- 验证：下载小文件后无手工刷新即可见；网络面板无轮询新增。

### M2 出口

- `cargo test` + 双端 verify + 轮询三律证据；文件域与原型 v3 逐项对照（分类六类/资料库三组/剧集详情/未归档）。

---

## M3 — 下载 = 全局任务监控（D7=A：注册表泛化 + 前端接线）

> 现状：daemon `GET /api/activity`（activity.rs）已聚合引擎+TG 且有五铁律（只读聚合/控制分流/
> 不造假暂停/插件不可达恒 200/不阻塞），但前端零消费；TG 快照端读 SQLite（BUG-085）。

### M3-T01 jobs 内存快照准入（偿还 BUG-085）

- 文件：`crates/orig-tg/src/cache.rs`/`routes.rs`
- 改动：TG 任务全量快照改内存读取（不碰 SQLite）；快照结构对齐活动契约 Job 模型。
- 验证：5s 高频拉取下 DB 零查询证据；`cargo test -p orig-tg`；BUG-085 fixed 证据。

### M3-T02 聚合器注册表泛化 + 控制代理

- 文件：`crates/orig-daemon/src/activity.rs`、`crates/orig-daemon/src/modules/plugins/`
- 改动：
  1. 来源遍历插件注册表（不再写死引擎+TG）；id 命名空间 `{plugin_id}:{native_id}`；
     并发拉取 + 300ms 超时 + 1s 快照缓存；插件不可达恒 200 并标来源不可用。
  2. 新增 `POST /api/activity/jobs/:gid/:action` 控制代理（pause/resume/cancel/retry 映射插件能力声明；
     无该能力的插件（TG 无暂停）代理返回明确语义，前端不渲染假按钮）。
- 验证：单测：注册表 0/1/2 插件、超时、部分不可达；控制代理对「无暂停能力」任务的拒绝路径。

### M3-T03 前端切消费 /api/activity + 来源筛选 chips

- 文件：`domains/download/`（新建 api/activity 客户端与 SSE/轮询适配，遵守轮询三律）、
  DownloadPanel（加来源 chips 行：全部/HTTP/TG/…插件名；仅过滤，不进导航、无历史栈）
- 改动：
  1. 四档（树）× 来源 chips（页内）正交过滤；TG 运行行显「运行中不可暂停」，无暂停按钮。
  2. 失败/interrupted 行只在「全部任务」；行操作沿用 DownloadItem 现状（M0 已搬，不改写）；
     TG 行控制动作经代理；进度/速度走 SSE 合并。
  3. TG 工作区移除任务轮询（任务统一在下载看）；TgCacheEntry 保留为缓存管理快捷入口。
- 验证：树档 9/3/1/4 类计数对照（原型口径）；引擎+TG 混合夹具；插件不可达 banner；
  非活动任务速度 0；verify 全套。

### M3 出口

- 下载页与原型 v3「全部任务 + 来源 chips」一致；BUG-085 closed；活动端 readme/契约文档更新。

---

## M4 — TG 两级化（D10=A 前半：单账户；禁三级 Navi）

> 优点与改进清单见 09 §10.4；数据/接口零改动，只换前端 IA。

### M4-T01 TgPanel 两级重排（可先做纯结构拆分独立提交）

- 文件：`TgPanel.tsx` → `domains/tg/`：容器 + 左栏会话列表 + 右栏详情/媒体流；
  AccountsBar/ChannelList/MessageMediaStream/CacheTasksButton/GlobalSearchDialog 分文件
- 改动：取消「文件夹→频道→消息」三级钻取栈；segmented（全部/监控/群组/私聊，过滤非导航）；
  文件夹 chips 横向滚动 + 「更多 ▾」弹层（禁止挤成两行）；复合过滤渲染可单独清除的条件 chip；
  列表保留未读标记/最新预览/监控态（信息密度不退步）；监控切换与打开会话点击区视觉分离、防误触；
  右栏媒体流「缓存/入库并打开」现状不动；发起缓存 toast「已加入下载」。
- 验证：TG verify 全套对照；多文件夹（10+）夹具；三账户态（M7 前单账户）。

### M4-T02 账号区只在设置（M0-T07 已搬家，本任务收口交互）

- TG 工作区不放账号 CRUD；右栏账号只读显示；数据模型/契约预留 account_id（不做多账户 UI）。
- 验证：账号增删改只在设置·Telegram；工作区无账号控件残留。

### M4 出口

- 接口零改动 diff 证据；TG 全链路 verify。

---

## M5 — ffmpeg 可诊断/可设置 + 受管安装（开工前补批 D3/D4）

- M5-T01 诊断端点（daemon，M1 后归属）：resolved_path/version/probes/gpus/recommended/effective/override；
  ffmpeg 缺失 `ok:false` 非 5xx；有/无夹具单测。
- M5-T02 用户配置持久化：`ffmpeg.path`/`ffmpeg.hwaccel`/`ffmpeg.device`；env > 持久化 > auto 探测；重启保留单测；
  转码泵每次转码读有效选择（auto/off/指定后端/指定显卡四态命令行断言）。
- M5-T03 设置·播放引擎区块：安装状态/版本/能力只读行、路径选择、硬解模式、显卡下拉、501 可行动文案（去设置）。
- M5-T04 受管安装（PD-T03/T06）：清单来源与签名信任根（安全评审后）→ daemon 代理下载（断点/超时/SSE 进度/
  临时文件→sha256 校验→原子替换 `%LOCALAPPDATA%\OrigHub\bin\ffmpeg.exe`）→ 手动/离线路径 → UI 安装卡片。
- 验证：干净环境一键安装（含代理）、篡改校验失败不留残文件、离线安装、双卡命令行证据、`ffmpeg -version` 回读。

---

## M6 — 局域网只读共享（D12=A 两级 + D15=A 内容区 segmented）

- M6-T01 daemon 独立绑定面（默认关闭）：网卡枚举（复用 `/api/interfaces`）、端口、启停、令牌根。
- M6-T02 只读路由 `/s/*`：浏览库 + 单文件投递全走 M1-T04 共享 crate；仅 GET/HEAD；401/405 齐全。
- M6-T03 SharePanel：服务关 = onboarding（跳设置·共享）；服务开 = 内容区 segmented
  **共享目标 / 访问记录**（L2 不进侧栏，09 §10.5）；目标 = 库/剧集/标签/条目集，每目标独立开关、
  独立令牌/二维码/有效期/撤销；目标选择器复用资料库选择 UI。
- M6-T04 安全与限速回归：默认无监听 netstat 证据；无令牌 401；写方法 405；停用即关端口；
  旧令牌重置即失效；`diag_rate_storm.cjs` 非环回用例冗余倍数个位数。
- 出口：`feat(engine): read-only LAN share with token auth`。

---

## M7 — 插件化（D8/D9/D17）+ TG 多账户（D10=A 后半）

- M7-T01 标准屏注册表与稳定契约（D8 细化 D5；开工前补批 D8）：manifest 声明
  （型：source/fetcher/drive；能力：jobs 快照/控制动作/主从浏览面）；统一描述符前端渲染。
- M7-T02 生命周期（D9，补批）：安装/启停/健康/权限/升级；启用/禁用为离散事件，驱动侧栏增删。
- M7-T03 动态导航位（D17=A）：固定五项 + 已启用 source/drive 插件按品牌名进侧栏（TG 从硬编码位迁为
  首个动态位，文案保持 Telegram）；主从型 L2 走模块内左栏（D15）；fetcher 不占位，
  「新建下载」对话框加来源/解析器选择；禁用即撤位、不显示未配置占位。
- M7-T04 TG 多账户：account_id 全链路打通；设置多账户 CRU D + 切换；工作区右栏账号 chip 加
  「切换账户 ▾」快捷菜单（状态机仍只在设置）；任务/缓存按账户隔离与聚合口径定案。
- 验证：禁用 TG 后侧栏位消失、媒体库照常（M1 成果回归）；第二插件（可用 drive 型试验桩）
  自动进下载监控（M3 成果）与侧栏；多账户任务不串号。

---

## 全局检查单（每期收口）

1. `git fetch origin`；左列计数 0；工作区 clean；不 --no-verify。
2. engine：`cargo build` + `cargo test`；shell：`npm.cmd run build`（输出不入库）。
3. 影响投递：`probe_media.py`、`diag_rate_storm.cjs`。
4. UI：`tauri-shell/verify/` 新截图入 `verify_shots/<topic>/`（ignored）；i18n 双键；形态对照原型 v3。
5. 门禁：`sh scripts/check-pollution.sh`；`docs/bugs/**` 改动手跑 `python scripts/check-bugs.py --changed`；
   含决策块手跑 `python scripts/check-decisions.py`；sidecar 改动过 `sh scripts/sync-sidecars.sh --check`。
6. 汇报四件事：依据规则 / 改动 / 验收结果 / 待拍板（≤3 条、带三段式）。
7. BUG 状态不因报告自动关闭；fixed 需可核证据，用户确认后 closed。

---

## BUG 追踪映射（2026-10-13 登记）

本清单已接进缺陷追踪（`docs/bugs/README.md`）。**每个 Task 的提交必须引用所属编号**：
`feat(shell): M0-T03 files domain BUG-298`（`fix` 类必须带号，否则 commit-msg 门禁拒绝）。

| 里程碑 | 编号 | 说明 |
|---|---|---|
| Q4 工作区 clean | —（流程前置，非缺陷） | 2026-10-13 已达成（8 个提交，未跟踪项 0） |
| **M0** 前端 IA 重排 | **BUG-298** | 新建；M0-T01~T09 任务表在该档 |
| **M1** 媒体完全脱离 TG | **BUG-172**（已有，critical） | **复报不新开号**：现象即「媒体库被错误部署在 TG 进程内」。M1-T01~T06 作为「实施计划」追加进该档；动工前置 = **BUG-173** 的 A1–A6 判据 |
| **M2** 文件域成品化 | **BUG-299** | 新建 |
| **M3** 下载 = 全局任务监控 | **BUG-300** | 新建；M3-T01 偿还 BUG-085 根因 |
| **M4** TG 两级化 | **BUG-301** | 新建 |
| **M5** ffmpeg 可诊断/受管安装 | **BUG-302** | 新建；关联 BUG-237/238 |
| **M6** 局域网只读共享 | **BUG-303** | 新建 |
| **M7** 插件化 + TG 多账户 | **BUG-238**（已有，high） | **复报不新开号**：现象即「插件化管理框架缺失」。M7-T01~T04 作为「实施计划」追加进该档；开工前补批 D8/D9 |

被各里程碑关闭/接管的既有缺陷（不新开号）：BUG-112（M0-T04 移除成员入口）、
BUG-082（M0-T09 回写）、BUG-085（M3-T01 偿还）、BUG-172/173（M1）、BUG-238（M7）。
