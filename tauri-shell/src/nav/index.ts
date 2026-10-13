/**
 * 导航契约（模块重整 M0 · BUG-298 / M0-T01）。
 *
 * **为什么要有这个文件**：M0 之前一级视图是自由字符串 `ViewId`
 * （`all | downloading | paused | completed | media | tg | settings`），
 * 「下载中/已暂停/已完成」三个**过滤态**与「全部文件/媒体库/TG/设置」四个**域**混在同一个枚举里，
 * 于是「下载没有独立落地页」「文件域混着任务行」这类信息架构问题在类型上**不可表达**。
 *
 * 本文件把两者分开：
 *   - `ViewId`      = 五个**域**（一级导航位，一项一域）
 *   - `dlFilter`    = 下载域内的树选择（三档 + 父行全部）
 *   - `fmode`       = 文件域内的树选择（分类组 + 资料库组 + 剧集下钻）
 *
 * **域间零直接 import**（设计原则 4）：跨域只允许 `navigate()` 与全局 `MediaViewer` 两条通道。
 * 本文件是 `navigate()` 的唯一真源 —— 禁止在组件里散写 `setView('tg')` 之类直改。
 *
 * 界面形态真值：`docs/design/module-restructure-2026-10-13/prototype/index.html`（v3）。
 * 高亮规则见 `prototype/app.js::syncNav()`，本文件的注释逐条对应。
 */

/** 一级域（五项）。顺序即侧栏自上而下。 */
export type ViewId = 'files' | 'download' | 'tg' | 'share' | 'settings'

/** 下载树三档 + 父行「全部任务」。`running` 含 downloading | queued | idle（BUG-082 口径）。 */
export type DlFilter = 'all' | 'running' | 'paused' | 'done'

export const DL_FILTERS: readonly DlFilter[] = ['all', 'running', 'paused', 'done']

/**
 * 文件树分类：六类成品。
 *
 * `video` 的侧栏入口已与剧集合并为单一「视频」入口（BUG-306 / D19-⑦，2026-10-14
 * 用户续裁「剧集可以放视频上面或者和视频合并」⇒ 已选合并）——侧栏只渲染其余五项，
 * 视频内容经 `lib-series` 剧集栅格到达（D18：视频=剧集 ⇒ 栅格覆盖全部视频）。
 * `cat:video` 这个 fmode 仍合法（MediaLibraryPanel 的 items 视图照旧支持），
 * 只是不再有侧栏入口。
 */
export type FileCategory = 'video' | 'music' | 'image' | 'doc' | 'archive' | 'other'

export const FILE_CATEGORIES: readonly FileCategory[] = [
  'video',
  'music',
  'image',
  'doc',
  'archive',
  'other',
]

/**
 * 资料库组（BUG-306 / D19 后只剩一个入口，且组标签已删）。
 *
 * **只剩「剧集」**（BUG-304 / D18，2026-10-14 用户四点裁定）：
 *   - `tags` 被移除 —— 标签是**过滤维度**不是目的地。实测 `lib-tags` 与 `lib-series`
 *     落在完全相同的视图（`MediaLibraryPanel` 里两个分支都 `setView('series')`），
 *     树项是**空转入口**。标签云与筛选框留在剧集墙顶部即可。
 *   - `unfiled` 被移除 —— **「未归档」状态本身取消**。用户口径「视频=剧集，单集必然是
 *     一个单集剧集」⇒「有条目但无剧集归属」是**缺陷症状**而非正常态，把它做成一等入口
 *     等于把缺陷固化成功能（原 D13-③ 已由 D18 修订）。
 *
 * **组标签删除、入口置顶并改名「视频」**（BUG-306 / D19，2026-10-14 续裁）：
 * 「资料库（策划）」组标签与「管理」「分类（成品内容）」同批裁定冗余（各包 0~1 个
 * 有意义子项）；剧集入口与视频分类合并为单一「视频」入口置于文件树子项最上方。
 * 保留 `LibraryGroup` 类型与 `libraryGroupOf()`：`lib-series` 仍是 MediaLibraryPanel /
 * ContextBar 的落点判据，与侧栏渲染形态解耦。
 */
export type LibraryGroup = 'series'

/**
 * 文件域树选择。
 *
 * - `cat-all`               父行「全部文件」= 成品媒体墙全部（`tab: 'all'`）
 * - `cat:<category>`        分类组子项（按 kind 过滤，`tab: <kind>`；`cat:video`
 *                            已无侧栏入口 —— 视频走 `lib-series`，BUG-306 / D19-⑦）
 * - `lib-series`            剧集栅格（标签云与筛选框同屏，标签是过滤维度不是目的地）；
 *                            侧栏入口标签为「视频」（BUG-306 / D19-⑦ 合并）
 * - `series:<id>`           剧集下钻（drill-in；返回即回到 `lib-series`）
 *
 * **已移除**（BUG-304 / D18）：`lib-tags`（空转入口，与 `lib-series` 同视图）、
 * `lib-unfiled`（「未归档」状态取消：视频=剧集 ⇒ 单集即单集剧集）。
 *
 * 设计取舍：用**字符串模板**而非嵌套对象 —— 它要进 React state、要能直接当
 * `key`/比较值，嵌套对象每次渲染都是新引用，`memo` 会失效。
 */
export type FileMode =
  | 'cat-all'
  | `cat:${FileCategory}`
  | 'lib-series'
  | `series:${number}`

/** 全局导航状态（单一真源在 MainLayout；禁止组件各存一份 view）。 */
export interface NavState {
  view: ViewId
  dlFilter: DlFilter
  fmode: FileMode
  /**
   * 设置域内的分区锚点（M0-T07 七区块）。
   *
   * 与 `dlFilter` / `fmode` 同一性质：**域内选择存在域状态里**，不散在各面板。
   * 少它的话 `navigate('settings', { section: 'telegram' })` 会在 `navigate()`
   * 里被静默丢掉 —— 入口照跳、落点回到默认区，用户以为点了没反应
   * （M0-T05 的「启用 Telegram 采集」正是这条路径）。
   */
  section: SettingsSection
}

/**
 * 侧栏树徽标的**事实计数**（M0-T01）。
 *
 * 纪律（BUG-125 / BUG-133）：徽标数必须与域面板里的数是**同一个数**，
 * 不许侧栏自己再算一套。故这些数由各域面板经回调上报，`MainLayout` 只中转。
 */
export interface SidebarCounts {
  /** 成品总数（文件父行徽标） */
  files: number
  /** 剧集数（资料库组） */
  series: number
  /** 标签数（资料库组） */
  tags: number
}

/** 默认落地：文件域 · 全部成品。原 `useState<ViewId>('all')` 的等价物。 */
export const DEFAULT_NAV: NavState = {
  view: 'files',
  dlFilter: 'all',
  fmode: 'cat-all',
  section: 'general',
}

/** 设置域的分区锚点（M0-T07 七区块；`data-sec` 与 prototype 一致）。 */
export type SettingsSection =
  | 'general'
  | 'downloads'
  | 'network'
  | 'engine'
  | 'telegram'
  | 'share'
  | 'about'

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'downloads',
  'network',
  'engine',
  'telegram',
  'share',
  'about',
]

export interface NavigateOptions {
  /** 下载树选择（仅 view= 'download' 有意义） */
  dlFilter?: DlFilter
  /** 文件树选择（仅 view= 'files' 有意义） */
  fmode?: FileMode
  /** 设置分区锚点（仅 view= 'settings' 有意义） */
  section?: SettingsSection
}

/**
 * `navigate()` —— 唯一的跨域通道。
 *
 * 规则（对应 prototype `switchView`）：
 *  1. 切域时**保留**另一域的树选择（用户切走再回来不该丢失上下文）；
 *  2. 显式传入的树选择覆盖；
 *  3. 未传且目标域没有历史选择时，用该域默认（下载=all，文件=cat-all）。
 */
export function navigate(prev: NavState, view: ViewId, opts: NavigateOptions = {}): NavState {
  return {
    view,
    dlFilter: opts.dlFilter ?? (view === 'download' ? prev.dlFilter : 'all'),
    fmode: opts.fmode ?? (view === 'files' ? prev.fmode : 'cat-all'),
    // 与上两行同构：离开设置域就回默认区，回来时保留上次所在的分区。
    section: opts.section ?? (view === 'settings' ? prev.section : DEFAULT_NAV.section),
  }
}

/** 从 `fmode` 取分类组子项的种类；非分类选择返回 null。 */
export function fileCategoryOf(fmode: FileMode): FileCategory | null {
  if (!fmode.startsWith('cat:')) return null
  const c = fmode.slice(4)
  return (FILE_CATEGORIES as readonly string[]).includes(c) ? (c as FileCategory) : null
}

/** 是否资料库组选择。当前只有「剧集」（BUG-304 / D18 移除了 tags 与 unfiled）。 */
export function libraryGroupOf(fmode: FileMode): LibraryGroup | null {
  return fmode === 'lib-series' ? 'series' : null
}

/** 从 `series:<id>` 取剧集 id；非下钻返回 null。 */
export function seriesIdOf(fmode: FileMode): number | null {
  if (!fmode.startsWith('series:')) return null
  const n = Number(fmode.slice(7))
  return Number.isFinite(n) ? n : null
}

/** 构造剧集下钻的 fmode。 */
export function seriesMode(seriesId: number): FileMode {
  return `series:${seriesId}`
}

/**
 * 高亮判据（逐条对应 prototype `syncNav()`，2026-10-14 BUG-306 / D19 起父子排他）：
 *   - 父行：`nav.files` 仅在 `cat-all` 或剧集下钻（`series:<id>`）时点亮；
 *           `nav.download` 仅在 `dlFilter==='all'` 时点亮（排他：选中子项时父行熄灭）；
 *   - 一级项（tg/share/settings）：`dataset.view === currentView`；
 *   - 子项：文件子项在 `view==='files' && fmode` 相等时点亮；
 *           下载子项在 `view==='download' && dlFilter` 相等时点亮；
 *   - **剧集下钻时文件子项全部熄灭**（prototype 的 `!sdSeries` 条件），
 *     只留父行 —— 这是原型既定规则，M0-T01 要求「同原型」，故不自行「优化」。
 */
export function isNavChildActive(
  view: ViewId,
  fmode: FileMode,
  dlFilter: DlFilter,
  child: { fmode?: FileMode; dlFilter?: DlFilter },
): boolean {
  if (child.fmode !== undefined) return view === 'files' && !seriesIdOf(fmode) && child.fmode === fmode
  if (child.dlFilter !== undefined) return view === 'download' && child.dlFilter === dlFilter
  return false
}
