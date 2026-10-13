# 任务清单：模块重整与大型重构（spec.md 配套）

- 日期：2026-10-13
- 状态：**待 spec 批准后启用**
- 约定：
  - 每个 Task = 一次可独立提交的变更（英文 message + LF，遵守 commit-msg 门禁）。
  - 每期开工前 `git fetch origin` 并确认 `git rev-list --left-right --count origin/main...main` 左列为 0、工作区 clean。
  - Task 内文件路径相对仓库根；行号为 2026-10-13 取证时的近似锚点，动手前以当前代码为准复核。
  - 「搬运不改写」= 允许移动/包裹/改导入路径，禁止顺手改数据流与业务逻辑。
  - 前端构建输出一律落仓外临时目录或已 ignore 的 `dist/`、`tauri-shell/dist_*/`。

---

## 阶段总览与依赖

```
M0 前端 IA（零后端）
  └─ M1 设置归位 + ffmpeg 可诊断/可设置
        ├─ M2 文件事实层（前置：MEDIA-DESIGN 表述改写；IFL draft 定案）
        │     └─ M3 拆库 + 媒体归 daemon（需 Q2 拍板）
        │           ├─ M4 ffmpeg 受管安装
        │           └─ M5 局域网共享
  PD-T02（文案定位）并入 M0
```

M0/M1 不依赖任何后端架构决策；M3 依赖 Q2；M4/M5 依赖 M3 的服务归属（ffmpeg/共享落在 daemon）。

---

## M0 — 前端信息架构重排（纯展示）

> 禁区：不改任何 API 调用与端点、不改 store SSE 合并逻辑、不拆分巨型组件内部逻辑。

### M0-T01 导航类型与 Sidebar 重排

- 文件：
  - `tauri-shell/src/components/Sidebar.tsx`（ViewId L16-23、导航渲染）
  - `tauri-shell/src/components/MainLayout.tsx`（view state、面板挂载、跨视图回调）
- 改动：
  1. `ViewId` 收为 `'download' | 'files' | 'tg' | 'share' | 'settings'`；下载筛选改为下载模块内 state（`'all'|'downloading'|'paused'|'completed'`），初始值可从现有 view 映射。
  2. Sidebar 渲染五域（设置固定底部、分隔线）；图标与页面定制色统一；折叠态图标齐备。
  3. 移除 `resolveTgFeatureReady` 对入口的隐藏（门控逻辑移入 TG 面板内部空状态）。
- 验证：`npm.cmd run build`（仓外输出）通过；verify 截图五域 + 折叠态。

### M0-T02 下载模块容器化

- 文件：
  - 新建 `tauri-shell/src/components/download/DownloadPanel.tsx`（薄容器：标题栏 + segmented tabs + 现有 DownloadList）
  - 现有 `components/DownloadList.tsx`、`DownloadItem.tsx`、`DetailSheet.tsx`、`AddDownloadDialog.tsx`（搬运不改写，由 MainLayout 挂载点迁入 DownloadPanel）
  - `MainLayout.tsx`（挂载替换）
- 改动：筛选 tab 切换只改列表过滤 props；「新建下载」主按钮置标题栏右侧（无 FAB）。
- 验证：四档切换网络面板无新增清单请求（零派生请求，§D2）；非活动任务速度 0；verify 截图。

### M0-T03 文件模块外壳与媒体库迁入

- 文件：
  - 新建 `tauri-shell/src/domains/files/FilesPanel.tsx`（容器 + 二级 rail：内容/剧集/标签/文件夹）
  - `tauri-shell/src/components/MediaLibraryPanel.tsx`（整体迁入 files 目录或作为 FilesPanel 子视图，搬运不改写）
  - `components/media/*`（约 20 个，导入路径随迁）
  - `tauri-shell/src/api/media.ts`（仅 base/类型名如需，不改端点指向）
- 改动：「文件夹」rail 项先渲染 disabled「即将推出」占位（M2 启用）；内容/剧集/标签映射现有 items/series/tags 视图。
- 验证：三视图与现状行为逐项对照（verify 截图 + 手工点开剧集/标签/lightbox）。

### M0-T04 TG 入口常驻 + 引导空状态

- 文件：`tauri-shell/src/components/TgPanel.tsx`（仅在顶部加未启用/未登录空状态分支，不拆组件）、`MainLayout.tsx`
- 改动：未启用时整页引导卡（说明 + 「启用 TG 插件」按钮 → `navigate('settings',{section:'tg'})`）；未登录态给「去账号」引导；已启用路径渲染现有内容。
- 验证：开关 tg_enabled 两态截图；入口永不消失。

### M0-T05 共享占位页

- 文件：新建 `tauri-shell/src/components/share/SharePanel.tsx`（关闭态说明卡 + 「即将推出」，无控件无请求）
- 验证：build + 截图。

### M0-T06 统一导航契约

- 文件：新建 `tauri-shell/src/components/nav.ts`（或 `src/nav/`：`ViewId`、`NavParams`、`navigate` 常量与类型）；改 `MainLayout.tsx`（`handleOpenMedia`/`handleGoAccounts` 等回调替换为统一契约调用）；TgPanel/下载完成跳转点改用契约。
- 验证：TG→文件、→设置账号、下载→文件（M2 才真有，先留类型）三条路径手动验证。

### M0-T07 设置 IA 重排（只移动，不改读写）

- 文件：`tauri-shell/src/components/SettingsPanel.tsx`（tabs L26、TG 通用块约 L1006-1096、下载目录/libDir 约 L563-595、CacheManagerDialog 挂载约 L1301）
- 改动：tabs 改七区块（通用/下载与存储/网络与代理（proxy+network 合并展示，存储仍各自端点）/播放引擎（先占位，M1 填充）/TG 插件（启停+accounts 内容+缓存管理入口）/共享（占位）/关于）；删除通用区 TG 控件；libDir 展示移到下载与存储（M0 仍写现端点）；布局改 divider 列表（去卡片栅格）。
- 验证：逐控件操作回归（启停 TG、改目录、账号入口、打开缓存管理）与网络请求端点前后一致（抓包/日志比对）。

### M0-T08 PD-T02 文案定位 + i18n

- 文件：`tauri-shell/src/i18n/zh-CN.json`、`en-US.json`（以实际路径为准）、`README.md`（如涉及定位语）、页面标题 ICON
- 改动：新导航/区块/空状态全量文案，中英双语同步；产品定位表述统一为「以媒体/文件管理为核心的下载/上传/共享/管理工具」。
- 验证：构建无缺失键告警；两语言切换截图。

### M0 出口

- 一期一提交或按 Task 多提交；`npm run build` + `tauri-shell/verify/` 全套；汇报四件事。

---

## M1 — 设置归位 + ffmpeg 可诊断/可设置（需 Q3=A）

### M1-T01 ffmpeg 诊断端点（orig-tg）

- 文件：`download-engine/crates/orig-tg/src/routes.rs`（新路由，建议 `/api/tg/ffmpeg/status` 或与媒体同位的 `/api/ffmpeg/status`，M3 迁移成本考虑在计划期定名）、`ffmpeg_caps.rs`（复用 `probe_ffmpeg/probe_gpus/probe_config`）
- 返回：`resolved_path/version/probes/gpus/recommended/effective/override` + 解析链每步命中情况；ffmpeg 缺失时 `ok:false` 而非 5xx。
- 验证：`cargo test`（有/无 ffmpeg 两夹具）；curl 两态。

### M1-T02 ffmpeg 用户配置持久化

- 文件：`download-engine/crates/orig-tg/src/store.rs`（app_setting 键：`ffmpeg.path`/`ffmpeg.hwaccel`/`ffmpeg.device`）、`routes.rs`（GET/PUT 配置端点 + 鉴权与其他 tg 配置一致）
- 规则：env `ORIG_FFMPEG_PATH`/`ORIG_TG_HWACCEL` 保持最高优先；持久化覆盖次之；探测默认 auto 兜底。
- 验证：重启后配置保留单测。

### M1-T03 转码泵改读有效配置

- 文件：`download-engine/crates/orig-tg/src/routes.rs`（`FFMPEG_CONFIG` OnceCell L4411、`ffmpeg_config()` L4414、调用点约 L4634/L4721）
- 改动：探测结果可缓存，但**用户选择每次转码读取**（或配置变更使缓存失效）；auto/off/指定后端/指定显卡四态命令行断言。
- 验证：单测：同一进程内 auto→off 后新转码命令无 `-hwaccel`；off→指定后端含正确参数；ELT-T01 取消守卫不回归。

### M1-T04 设置·播放引擎区块

- 文件：`SettingsPanel.tsx`（播放引擎 tab）、新建 `tauri-shell/src/components/settings/FfmpegSection.tsx`、`api/` 对应客户端
- 内容：安装状态/版本/能力只读行；路径手动选择；硬解模式（自动/软件/指定后端）；显卡下拉；缺失时可行动文案 + 跳「安装」占位（M4）。
- 验证：双语文案；操作后诊断回读一致；501 播放器文案（VideoPlayer/lightbox 路径）带「去设置·播放引擎」。

### M1-T05 CacheManager 入口归位与配置键常量化

- 文件：`SettingsPanel.tsx`（约 L1301 挂载点）、`TgPanel.tsx`（约 L1980）、新建 `tauri-shell/src/api/configKeys.ts`（域→权威端点映射）
- 改动：唯一组件 `CacheManagerDialog`，TG 运营按钮（tasks 默认 tab）+ TG 设置区块（字节清理默认 tab）两语境入口；通用区旧入口删除；前端所有配置读写按映射表检查，无双写键。
- 验证：两入口打开 tab 正确；全局搜索配置写入点无双轨（grep 证据）。

### M1 出口

- `cargo build`、`cargo test -p orig-tg -p orig-daemon`、`download-engine/verify/`；UI verify；提交信息如 `feat(shell): add ffmpeg engine settings section`。

---

## M2 — 文件事实层（D1=A）

### M2-T00 前置（D1=A 强制项）

- 文件：`docs/MEDIA-DESIGN.md`（L11-16 及相关「M3 唯一事实源」表述）
- 改动：改写为「文件层 = 通用事实源；M3 媒体库 = 文件层的媒体领域视图」；M1/M2/M3 调用方向章节同步。
- 同时：评审 `docs/design/ingest-fact-layer-2026-10-13.md` 并定案（入库流水线事实层 IFL-T01~05），作为本阶段上游先提交。
- 验证：文档自洽评审；若含 `### D<n>.` 决策块，手跑 `python scripts/check-decisions.py`。

### M2-T01 文件事实查询服务（v1 不建表）

- 文件：新建 `download-engine/crates/orig-daemon/src/modules/files/`（facts 装配 + roots + 快照），挂载于 orig-daemon。
- **归属细化（2026-10-13，见 04-api-contracts.md §2 开头）**：文件层属核心面，M2 即落 daemon 而非「orig-tg 过渡再迁」。daemon 天然拥有下载根与任务记录；媒体投影在 M3 前经现有批量端点 `/api/media/items/by-refs`（orig-tg）跨服 enrich、M3 后改本地读，只搬一次。TG 离线时 `GET /api/files/roots` 回 `partial:true`，前端按来源离线路径降级。
- 数据装配：FS 扫描受管根（下载分类目录 + library_dir）× 下载任务记录 × `media_item` 投影；输出 `FileFact`（结构见 03-data-model-and-migration.md §6）；读端点只读内存快照（§D1 被轮询端点不碰 DB/不现场扫盘）。
- 验证：单测覆盖：非媒体文件可见、媒体文件不双计、缺失文件（孤儿条目）标记、来源映射正确、partial 降级。

### M2-T02 文件夹视图（FilesPanel 启用第四 rail）

- 文件：`tauri-shell/src/domains/files/FilesPanel.tsx`、新建 `domains/files/views/FoldersView.tsx`、`api/files.ts`
- 内容：按根/来源分组浏览、kind 图标、非媒体文件行操作（打开所在位置、归仓、删除条目联动按既有铁律）；「内容」视图保持只显媒体。
- 验证：构造视频+文档+压缩包夹具的 verify 截图；删除联动回归（清缓存不删条目/删 TG 条目连字节）。

### M2-T03 下载完成→文件层串通

- 文件：完成事件处理（前端 SSE 合并处 `tauri-shell/src/store/useStore.ts` 只加导航/提示，不加轮询）、后端入库路径（M2-T01 origin 映射）
- 改动：完成态「定位文件」走 `navigate('files',{origin:'download',taskId})`；下载目录文件在文件夹视图可见。
- 验证：端到端下载一个小文件后文件夹视图立即可见（事件驱动，无刷新轮询）。

### M2-T04（可选独立提交）TgPanel 拆分

- 文件：`TgPanel.tsx` → `tg/` 目录容器 + AccountsBar/ChannelList/MessageMediaStream/CacheTasksButton/GlobalSearchDialog
- 原则：纯结构拆分，行为不变；与 M2 功能提交分开。
- 验证：TG verify 全套对照截图。

### M2 出口

- `cargo test` + verify + 轮询三律检查（新增端点无 DB 直查证据）。

---

## M3 — 拆库 + 媒体迁入 orig-daemon（需 Q2=A）

### M3-T01 文件归属清单（先文档后代码）

- 产出：在本目录追加 `m3-mapping.md`（dev-plan 期生成）：逐文件/逐表/逐端点列「迁/留」。
- 已知锚点：迁 = `media.rs`、9 张 `media_*` 表、`/api/media/*`、raw/stream、transcode、ffmpeg 配置（M1 键随迁）；留 = `cache.rs`（TG 过程态）、cache_task 表、TG 5 表、`/api/tg/*`、`/api/tg/local/*`；`app_setting` 按键拆分；`store.rs` 拆为各自域内模块或共享建表工具。

### M3-T02 拆库迁移

- 文件：`store.rs`/`media.rs` 建表与连接串、orig-tg 启动处、新增迁移代码与单测
- 规则：建表批只含新旧库共有列（§D7）；复制式迁移不删旧表；库路径由 daemon 数据目录管理；失败 `EXIT_*` + 打印路径，禁 `:memory:`。
- 验证：「旧库→新代码」迁移单测：9 表行数、抽样字段、索引一致；库损坏/半迁移失败路径显式退出。

### M3-T03 caption 跨域读消除

- 从 09-28 文档 F9 的 4 处只读点改为**入库快照**（入库时 caption 已可用），库侧自含展示文案；grep 证明 daemon 媒体路径无 orig-tg HTTP 依赖。
- 验证：断网/停 orig-tg 时库内剧集文案照常显示。

### M3-T04 serve_local_file 抽共享 crate

- 文件：新建或选定共享 crate（候选 `orig-protocol-http`，否则 `orig-file-serve`）；orig-daemon 与 orig-tg 共同依赖；两处投递端点改为同函数调用。
- 铁律保持：无 Range→200 全文；`bytes=S-`→206+32MiB 有界块+如实 Content-Range；恒带 ETag/Last-Modified；MIME 按扩展名禁止 jpeg 兜底；码率×`DELIVERY_BUDGET_FACTOR` 节流。
- 验证：`probe_media.py` 两路全项；`diag_rate_storm.cjs` 不回归。

### M3-T05 媒体路由/转码迁入 daemon + 前端改向

- 文件：`orig-daemon/src/routes.rs`（挂载 `/api/media/*`）、`orig-tg/src/routes.rs`（删除媒体段）、Cargo.toml 依赖调整、`tauri-shell/src/api/media.ts`（base 一行改向）、`src-tauri/src/lib.rs`（如启动/健康检查语义变化）
- 验证：
  1. 全新无 TG 凭证环境媒体可读可播（BUG-172 主证据，关闭后登记证据）；
  2. `cargo tree -p orig-daemon` 无 grammers；orig-tg 无 `media_*` SQL（grep 证据）；
  3. `scripts/sync-sidecars.sh --check` 通过；
  4. ffmpeg 诊断/设置端点随迁后 M1 UI 行为不变。

### M3-T06 健康/自愈语义拆分

- 文件：daemon/tg 健康探测、前端连接状态
- 改动：`media.offline` 拆「库不可用/服务不可用」两态（09-28 文档另注）；自愈只拉起对应服务。
- 验证：分别停 daemon / 停 orig-tg 的 UI 状态与重试目标准确。

### M3 出口

- BUG-172 走 fixed 登记（可核证据 = 无凭证环境录屏/截图 + 上述命令输出）；`fix(engine): ... BUG-172` 提交。

---

## M4 — ffmpeg 受管安装（PD-T03/T06，D2=A）

- M4-T01 安装计划与清单来源：版本/URL/sha256（清单获取方式与签名信任根在 dev-plan 定，需安全评审）；端点返回计划供 UI 展示。
- M4-T02 下载器：经 daemon 代理配置（127.0.0.1:7897 可用）；断点/超时；SSE 进度；落临时文件→校验→原子替换到 `%LOCALAPPDATA%\OrigHub\bin\ffmpeg.exe`；失败不留残文件、不动旧版本。
- M4-T03 手动/离线路径：选择本机 exe 复制或登记路径；离线包目录扫描安装。
- M4-T04 UI：设置·播放引擎加安装卡片与进度、卸载/重装、版本对比；多显卡完整控件（PD-T06）。
- 验证：干净环境一键安装（含代理用例）、篡改 sha256 失败、离线安装、双卡选择命令行证据；`ffmpeg -version` 回读一致。

---

## M5 — 局域网只读共享（PD-T05，D3=A）

- M5-T01 daemon 独立绑定面：配置（默认关闭）、网卡枚举（复用 `/api/interfaces`）、端口选择、启用/停用、令牌生成/重置。
- M5-T02 只读路由 `/s/*`：浏览库 + 单文件投递，全走 M3-T04 共享 crate；仅 GET/HEAD；401/405 语义齐全。
- M5-T03 SharePanel 完整页：URL/二维码、复制链接、令牌管理、访问记录、停用；开关状态与「实时连接」类徽标约定一致。
- M5-T04 安全与限速回归：`diag_rate_storm.cjs` 非环回用例（冗余倍数个位数）；默认无监听 netstat 证据；无令牌 401；停用即关端口；旧令牌重置即失效。
- 出口：`feat(engine): read-only LAN share with token auth`。

---

## 全局检查单（每期收口）

1. `git fetch origin`；左列计数 0；工作区 clean；不 --no-verify。
2. engine：`cargo build` + `cargo test`；shell：`npm.cmd run build`（输出不入库）。
3. 影响投递：`probe_media.py`、`diag_rate_storm.cjs`。
4. UI：`tauri-shell/verify/` 新截图入 `verify_shots/<topic>/`（ignored）；i18n 双键。
5. 门禁：`sh scripts/check-pollution.sh`；`docs/bugs/**` 改动手跑 `python scripts/check-bugs.py --changed`；决策块手跑 `python scripts/check-decisions.py`。
6. 汇报四件事：依据规则 / 改动 / 验收结果 / 待拍板（≤3 条、带三段式）。
7. BUG 状态不因报告自动关闭；fixed 需可核证据，用户确认后 closed。
