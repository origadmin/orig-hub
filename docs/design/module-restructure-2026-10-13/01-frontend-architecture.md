# 前端架构与模块划分

- 配套：[spec.md](spec.md)（为什么）、[05-ui-wireframes.md](05-ui-wireframes.md)（长什么样）、[04-api-contracts.md](04-api-contracts.md)（调什么）
- 范围：`tauri-shell/src/`（React 前端，77 个 ts/tsx 文件）
- 结论先行：**按五个功能域重组目录；状态只分「全局 SSE 单一源」与「域内局部态」两层；域间只允许经导航契约与全局覆盖层通信。**

---

## 1. 设计原则（本期所有前端改动的判据）

1. **域优先**：目录、组件归属、状态、API 客户端都按域组织；不再有「平铺在 components/ 根的巨型面板」。
2. **搬运优先于重写**：M0 只允许移动 + 薄容器包裹，禁止改 props 数据流；巨型组件的深度拆分（TgPanel）单列任务、独立提交。
3. **状态两层**：跨域存活的数据（下载任务、SSE 进度、连接态）只在 `store/useStore.ts` 单一 SSE 合并源；域数据（文件列表、TG 频道、设置表单）是域内局部态。禁止域组件直连另一个域的 store 切片。
4. **域间零直接 import**：域 A 不得 import 域 B 的组件/hook/类型实现；跨域只有两条通道：`navigate(view, params)` 与全局 `MediaViewer`。
5. **性能铁律沿用 AGENTS.md §5**：高频组件 `memo`、回调用 useEvent；进度只变最小 UI 块；轮询三律（有活才轮/等值短路/失败退避）5s 上限、单一轮询源；非活动任务速度 0。
6. **UI 偏好沿用用户既定口径**：主按钮在标题栏右侧（无 FAB）；设置用 divider 列表；页面 ICON 统一风格+定制色；全中文 UI，中英 i18n 同步；无实际效果的保存按钮不出现。

---

## 2. 目标目录结构（终态，M2 后达成）

```
tauri-shell/src/
  app/
    App.tsx                    # ← 现 src/App.tsx，只做 Provider + 根布局
    main.tsx                   # ← 现 src/main.tsx
  nav/
    index.ts                   # ViewId / NavParams / navigate() / SECTION 常量
  domains/
    download/
      DownloadPanel.tsx        # 容器：标题栏 + 状态分段 tabs
      DownloadList.tsx         # ← components/DownloadList.tsx
      DownloadItem.tsx         # ← components/DownloadItem.tsx
      DownloadDetailSheet.tsx  # ← components/DownloadDetailSheet.tsx
      AddDownloadDialog.tsx    # ← components/AddDownloadDialog.tsx
    files/
      FilesPanel.tsx           # 容器：二级 rail（内容/剧集/标签/文件夹）
      views/
        ContentsView.tsx       # items + kind tab（MediaLibraryPanel items 段拆出）
        SeriesView.tsx         # 剧集列表（SeriesCard 网格）
        SeriesDetailView.tsx   # ← hooks/useSeriesDetail 消费主入口
        TagsView.tsx
        FoldersView.tsx        # M2 新增：文件事实层视图（含非媒体）
      media/                   # ← 现 components/media/ 整体归此（20 个展示组件）
        MediaCard.tsx SeriesCard.tsx Deck.tsx Lightbox.tsx VideoPlayer.tsx
        Series*.tsx Episode*.tsx Tag*.tsx CoverImage.tsx
        ImportDialog.tsx ExportPreviewDialog.tsx ItemEditDialog.tsx ...
      shared/
        MediaViewer.tsx        # 全局覆盖层（物理位置放 files 域，注册为全局单例）
    tg/
      TgPanel.tsx              # 瘦身后的三栏容器（目标 < 400 行）
      TgOnboarding.tsx         # 未启用/未登录引导态（M0 新增）
      AccountsBar.tsx          # ← components/AccountsPanel.tsx
      ChannelNav.tsx           # 对话/folders/监控频道导航
      ChatMediaStream.tsx      # 中右两栏媒体流（TgPanel 主体拆出）
      TgGlobalSearch.tsx       # ← components/TgGlobalSearch.tsx
      TgCacheEntry.tsx         # ← components/TgCacheEntry.tsx
      cache/
        CacheManagerDialog.tsx # ← components/CacheManagerDialog.tsx（唯一组件）
        CacheBytesPanel.tsx    # ← components/CacheBytesPanel.tsx
    share/
      SharePanel.tsx           # M0 占位；M5 完整
    settings/
      SettingsPanel.tsx        # 骨架：左分区锚点 + 右内容
      sections/
        GeneralSection.tsx
        DownloadsSection.tsx   # 下载目录/分类/并发 + libDir
        NetworkSection.tsx     # network + proxy 合并
        EngineSection.tsx      # ffmpeg（M1）
        TgSection.tsx          # 启停 + 账号 + 缓存管理入口
        ShareSection.tsx       # M5
        AboutSection.tsx
      widgets/
        SettingRow.tsx SettingSwitch.tsx SettingSelect.tsx  # 统一行组件（新）
      DirectoryPicker.tsx      # ← components/DirectoryPicker.tsx
      InterfacePickerDialog.tsx# ← components/InterfacePickerDialog.tsx
  shell/
    TitleBar.tsx               # ← components/TitleBar.tsx
    Sidebar.tsx                # ← components/Sidebar.tsx（五域）
    MainLayout.tsx             # ← components/MainLayout.tsx（只留布局 + 面板路由）
    ContextBar.tsx ContextBarActions.tsx ContextBarStatus.tsx  # ← components/ 同名
  store/                       # 维持（useStore/selectors/tgSearch/connState）
  api/                         # 维持 4 文件，按域注释分区；新增 configKeys.ts
    daemon.ts tg.ts media.ts tauri.ts configKeys.ts
  hooks/                       # 跨域共享 hook 才留此（useEvent/usePlayerSettings/useSeriesDetail 归 files）
  lib/                         # 维持（12 个纯函数工具，跨域共享）
  components/ui/               # 维持（基础控件库 8 个）
  i18n/index.ts                # 维持
  types.ts                     # 跨域 DTO；域私有类型下沉各域
```

---

## 3. 全量文件处置表（77 个现有文件）

阶段标记：**M0** 搬/包；**M2** 搬（随文件域）；**留** 原地；**拆** 拆分后搬运；**新** 新增。

### 3.1 现 `components/` 根（21）

| 文件 | 处置 | 目标 / 说明 |
|---|---|---|
| Sidebar.tsx | M0 改+留 shell/ | ViewId 收五域（spec §3.1） |
| MainLayout.tsx | M0 改+留 shell/ | 删跨视图回调，改 navigate；挂载五面板；MediaViewer 全局单例 |
| TitleBar.tsx / ContextBar*.tsx | M0 搬 | `shell/`（搬运不改写） |
| DownloadList.tsx / DownloadItem.tsx / DownloadDetailSheet.tsx / AddDownloadDialog.tsx | M0 搬 | `domains/download/` |
| MediaLibraryPanel.tsx | M0 包 → M2 拆 | M0 被 `files/FilesPanel.tsx` 薄包裹（整体渲染）；M2 拆成 Contents/Series/Tags 三视图后删除 |
| MediaViewer.tsx | M2 搬 | `domains/files/shared/`，MainLayout 全局挂载不变 |
| TgPanel.tsx | M0 加引导态 → M2-T04 拆 | 见 §4.3 |
| AccountsPanel.tsx | M2 搬+改名 | `domains/tg/AccountsBar.tsx` |
| TgGlobalSearch.tsx / TgCacheEntry.tsx | M2 搬 | `domains/tg/` |
| CacheManagerDialog.tsx / CacheBytesPanel.tsx | M1 搬 | `domains/tg/cache/`（M1-T05 入口归位时迁） |
| SettingsPanel.tsx | M0 原地重排 → M2 拆 sections | M0 只重排 tab 内容；M2 物理拆 7 个 section 文件 |
| DirectoryPicker.tsx / InterfacePickerDialog.tsx | M2 搬 | `domains/settings/widgets 同级` |

### 3.2 现 `components/media/`（20）

- M0：**全部不动**（避免 20 文件导入路径 churn 与功能改动混提交）。
- M2：整目录迁 `domains/files/media/`（一次纯 move 提交，git mv 保留历史）。
- 归属全部为 files 域；tg 域只通过已入库条目跳转使用，不得直接 import 其内部组件。

### 3.3 基础设施（36 个，原则不动）

| 目录 | 文件数 | 处置 |
|---|---|---|
| `api/` | 4 | 留；M0 在文件头按域写分区注释；M1 新增 `configKeys.ts`（域→权威端点映射）；M3 `media.ts` base 一行改向 |
| `store/` | 4 | 留。`useStore.ts` 仍是唯一 SSE 合并源；`tgSearch.ts` 物理上可留，仅 tg 域 import |
| `lib/` | 12 | 留（纯函数共享层）。域归属提示：`tgmedia.ts/tgReason.ts/mediaSources.ts` 仅供 tg/files，M2 可加注释标明，不搬 |
| `hooks/` | 3 | `useEvent.ts` 留（跨域）；`usePlayerSettings.ts`、`useSeriesDetail.ts` M2 随 files 域迁走 |
| `components/ui/` | 8 | 留（控件库） |
| `i18n/index.ts` | 1 | 留；键命名按域加前缀：`nav.*` `download.*` `files.*` `tg.*` `share.*` `settings.*` |
| `types.ts` / App / main / vite-env | 4 | types.ts 保留跨域 DTO；M0 App/main 归 `app/`（可缓至 M2，M0 不动也可） |

---

## 4. 域组件树与状态边界

### 4.1 download 域

```
DownloadPanel
├─ PanelHeader（ICON+标题+[新建下载]主按钮；计数徽标）
├─ StatusTabs（全部/下载中/暂停/完成 ← 原一级导航四项）
├─ DownloadList（memo）
│   └─ DownloadItem（进度块为本组件最小重渲染单元；速度 0 规则）
├─ DownloadDetailSheet（选中行）
└─ AddDownloadDialog
```

- 状态：任务/进度/速度全部读 `useStore` SSE 切片；`StatusTabs` 当前档为域内 state（可同步 URL hash，非必须）。
- 禁止：自行轮询 `/api/downloads`；列表刷新只能由 SSE 终态事件触发（单飞呈现 §D2）。
- 出域：完成项「定位文件」→ `navigate('files',{view:'folders',origin:'download',taskId})`（M2 生效）。

### 4.2 files 域

```
FilesPanel
├─ PanelHeader（按 rail 切换主动作：导入/导出/打开根目录/归仓）
├─ Rail（内容 | 剧集 | 标签 | 文件夹[M2]）
├─ ContentsView ─ MediaCard 网格（kind tab：全部/视频/图片/音频）
├─ SeriesView ─ SeriesCard
├─ SeriesDetailView（useSeriesDetail）
│   └─ SeriesHero / EpisodeList / EpisodeExpanded / EpisodePhotoGrid / 编辑面板
├─ TagsView ─ TagToken + TagManagerDialog
└─ FoldersView[M2]（文件事实层；非媒体文件行 + 来源分组）
全局：MediaViewer / Lightbox / VideoPlayer（经 decodeHealth 探测）/ 各 Dialog
```

- 状态：视图状态、选中、编辑对话框为域内局部态；媒体数据走 `api/media.ts`（M3 前 orig-tg、M3 起 daemon，调用方不感知）。
- 禁止：任何 TG client/session 概念（source 离线只读文案降级走 `mediaSources.ts`）。
- 入域：TG「在媒体库打开」、下载「定位文件」只经 navigate params。

### 4.3 tg 域

```
TgPanel（瘦容器，三栏布局 + 未就绪分支）
├─ TgOnboarding（未启用 → 跳 settings.tg；未登录 → AccountsBar 引导）
├─ 左：ChannelNav（AccountsBar 入口 / folders / dialogs / 监控频道）
├─ 中：频道列表 + TgGlobalSearch 入口
├─ 右：ChatMediaStream（消息媒体流）
│        └─ TgCacheEntry（每条媒体的缓存/入队状态）
├─ 运营按钮：[缓存任务] → CacheManagerDialog(tasks)
└─ Dialogs：CacheManagerDialog / CacheBytesPanel
```

- 拆分策略（M2-T04，一次纯结构提交）：先把 JSX 段落原样剪到子组件，props 显式下传；**不引入新状态管理库**；拆分后逐视图 verify 截图对照。
- 状态：TG 服务可用性读 `connState` 切片；其余域内自管。
- 禁止：持有/管理库根字节；缓存成功后的 upsert 是后端职责（缓存即入库 §D4），前端不拼 media_item。

### 4.4 share 域

- M0：单页占位（说明卡，无请求）。
- M5：开关状态卡 + 启用表单（网卡/端口）+ 服务信息（URL/二维码/令牌/访问记录）。域内局部态 + `/api/share/*`。

### 4.5 settings 域

```
SettingsPanel
├─ 左侧锚点列表：通用 / 下载与存储 / 网络与代理 / 播放引擎 / TG 插件 / 共享 / 关于
└─ 右侧 scroll 区：各 Section，统一 SettingRow 行：
      label + 描述 + 控件（switch/select/input/按钮）
      divider 分隔，不用卡片栅格
```

- 表单态局部；保存语义沿用现有「即时应用」或显式保存二选一，逐行统一；无效果控件不渲染保存按钮。
- `navigate('settings',{section})` 支持深链（TG 引导、ffmpeg 501 跳转复用）。
- M0 重排时逐控件抓包比对端点，确保「只搬家不改行为」。

---

## 5. 导航契约（消灭 MainLayout 临时回调）

`nav/index.ts`：

```ts
export type ViewId = 'download' | 'files' | 'tg' | 'share' | 'settings';

export type NavParams =
  | { view: 'files'; section?: 'contents'|'series'|'tags'|'folders';
      kind?: 'all'|'video'|'photo'|'audio';
      source?: 'tg'; ref?: string;            // <chat>:<msg>
      origin?: 'download'; taskId?: string }
  | { view: 'settings'; section: 'general'|'downloads'|'network'|'engine'|'tg'|'share'|'about' }
  | { view: 'tg'; chatId?: string; msgId?: string }
  | { view: 'download'; status?: 'all'|'downloading'|'paused'|'completed' };

export function navigate(target: NavParams): void;   // 单一实现，MainLayout 持有路由态
```

- 现 `handleOpenMedia`、`handleGoAccounts` 全部改为 `navigate(...)`，禁止再新增跨面板回调 props。
- params 为**一次性深链语义**：目标面板消费后可清除高亮，不回写全局 store。
- 4 条标准跳转路径见 spec §3.4；新增路径必须在本文件加类型（编译期穷尽检查）。

---

## 6. 配置写入的前端约束（配合 spec §5）

- 新增 `api/configKeys.ts`：`{ key, owner:'daemon-toml'|'tg-setting'|'shell-local', get?, put? }` 常量表；所有设置表单只许通过该表取端点。
- 禁止同一键出现在两个 owner；禁止 localStorage 镜像服务端键。
- 已发现的双源疑点（执行前核对）：`download_dir` 同时出现在 daemon TOML 与 orig-tg `app_setting`（cache.rs:70 读取）；M1-T05 必须查清同步方向并在表中注明唯一权威端。

---

## 7. i18n 计划

- 新键前缀按域（§3.3 表）；M0 一次性补齐五域导航/空状态/设置分区文案。
- 门禁：构建无 missing key；zh-CN 与 en-US 键集合一致（可加一行校验脚本到 verify，非必须）。
- 硬约束：界面不出现裸英文常量文案。

---

## 8. 分阶段移动顺序（控制 diff 风险）

1. **M0**：新建 `nav/`、`shell/` 只搬 4 个 chrome 组件、`domains/download/` 搬 4 个；新建 FilesPanel/SharePanel/TgOnboarding 薄组件；SettingsPanel 原地重排。media/ 与 TgPanel 不拆。
2. **M1**：CacheManager 两件 + settings 播放引擎区（可先在原 SettingsPanel 文件内加组件，物理拆分延后）。
3. **M2**：git mv `components/media/` → `domains/files/media/`；MediaLibraryPanel 拆视图；TgPanel 拆分；settings sections 物理拆分；hooks 归位。
4. **M3**：`api/media.ts` base 一行改向（唯一前端改动点）。
5. **M4/M5**：EngineSection 安装卡片；SharePanel 完整。

每步独立提交（`refactor(shell): ...` / `feat(shell): ...`），move 提交与逻辑提交严格分开，保证 review 与回滚粒度。
