import { memo } from 'react'
import type { NavState, ViewId } from '../nav'
import { libraryGroupOf, fileCategoryOf } from '../nav'
import { ContextBarActions } from './ContextBarActions'
import { ContextBarFilesActions } from './ContextBarFilesActions'
import { ContextBarStatus } from './ContextBarStatus'
import { FilesGlobalSearch } from './FilesGlobalSearch'
import { TgGlobalSearch } from '../components/TgGlobalSearch'
import { TgCacheEntry } from '../components/TgCacheEntry'
import type { IngestOverview } from '../domains/download/ingestGroups'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'
import { cn } from '../lib/utils'

/**
 * 顶部上下文栏（BUG-083）。
 *
 * 原先这一行是**固定的下载按钮组**，只在下载视图渲染，媒体库 / TG / 设置下整行空白
 * （`h-12 shrink-0` 有高度无用途）。现在改成随视图变化：
 *   - 下载类视图 → 右槽给连接灯（BUG-164，此前半数视图三角落缺一）+ 聚合速度 + 下载操作；
 *   - 文件域视图 → 右槽给**库级动作组**（BUG-317 四件套①+② / 任务 #9：
 *     导入目录 = `page-primary-action`，新建剧集/导出/标签管理 = 次级）；
 *   - 其余视图   → 右槽给全局状态（连接态 + 聚合速度 + 进行中数量）；
 *   - 左槽始终给当前视图标题（`page-title`，BUG-317 契约）。
 *
 * **不需要占位**：`<header>` 本身恒为 `h-12 shrink-0` 且恒定渲染，切换视图不会有高度跳动，
 * 额外占位只会多一个空 div。
 *
 * 流畅约束（AGENTS.md §5）：本组件**不订阅** `downloads`（SSE 高频），只接收低频 props
 * （`view` / `categoryFilter` / useEvent 恒定回调）；高频值由 `SpeedChip` / `ActiveCount`
 * 等叶子各自订阅 `store/selectors.ts` 的标量切片。
 */

/** 上下文栏形态：下载类视图给操作组，文件域给库级按钮，其余给全局态 */
export type ContextKind = 'download' | 'files' | 'status'

/** 稳定回调（由 `useEvent` 产出，引用恒定；禁止内联箭头 —— AGENTS.md §5） */
export type OnAction = () => void

export interface ContextBarProps {
  /** 全局导航状态（MainLayout 单一真源，低频） */
  nav: NavState
  onNewDownload: OnAction
  onPauseAll: OnAction
  onResumeAll: OnAction
  onClearCompleted: OnAction
  /**
   * 入库概览（在传/待处理/已缓存）：只读快照，供 TG 入口上的简易状态。
   *
   * 本栏**不持有**任何跨域跳转回调：入口上不挂跳转（2026-10-17 用户续裁
   * 「下载状态 / 去媒体库查看 都属于具体条目」），跨域仍只由 `Sidebar` 走
   * `navigate()` 唯一通道。
   */
  ingestOverview?: IngestOverview
  /** 「取不到」原因（BUG-318）；非空时入口计数显示为不可用而不是假 0 */
  ingestUnavailable?: string | null
}

/** 视图 → 形态（唯一真源，禁止在 JSX 里散写三元）。
 *  M0 起只有「下载」域给下载操作组；文件域给库级按钮组（BUG-317 / 任务 #9）；
 *  TG/共享/设置都给全局态 ——
 *  原 `all/downloading/paused/completed` 四个下载态收成一个 `download` 域，
 *  三档改由侧栏树驱动（模块重整 BUG-298 / M0-T02）。 */
export function resolveContextKind(view: ViewId): ContextKind {
  if (view === 'download') return 'download'
  if (view === 'files') return 'files'
  return 'status'
}

/** 视图 → 标题 i18n key（五项一级域） */
export const TITLE_KEY: Record<ViewId, string> = {
  files: 'nav.all',
  download: 'nav.download',
  tg: 'nav.tg',
  share: 'nav.share',
  settings: 'nav.settings',
}

interface ViewTitleProps {
  nav: NavState
}

/** 左槽：域标题 + 树选择副标题（对应 prototype `renderCtx()` 的 `ctx-sub`）。 */
export const ViewTitle = memo(function ViewTitle({ nav }: ViewTitleProps) {
  const { t } = useTranslation()
  const { view, fmode, dlFilter } = nav
  /**
   * BUG-409：剧集下钻时的面包屑尾节（剧名）。
   *
   * 用户 2026-10-23：「进入内容详情页后，标题区域只显示『文件管理』，缺少
   * 『剧集 → 内容』的层级表达」。实测根因：下钻把 `fmode` 换成 `series:<id>`，
   * 而本函数只认 `cat:*` 与 `lib-series` ⇒ **副标题整个消失**，比剧集墙上还少一级。
   *
   * 尾节由 `MediaLibraryPanel` 写进 store（剧名只有它知道），这里只读。
   */
  const crumb = useStore((s) => s.filesCrumb)

  // 副标题 = 当前树选择的标签（文件域取分类/合并视频入口；下载域取档位）
  let sub: string | null = null
  if (view === 'files') {
    const cat = fileCategoryOf(fmode)
    const lib = libraryGroupOf(fmode)
    if (cat) sub = t(`files.cat.${cat}`)
    // 2026-10-14 撤回 BUG-306 / D19-⑦ 合并：剧集是独立入口（标签 `files.lib.series`），
    // 副标题与侧栏同源，不许侧栏叫「剧集」、顶栏叫「视频」。
    else if (lib) sub = t('files.lib.series')
    // BUG-409：下钻到某一部剧集 —— 给「剧集 › 剧名」，缺剧名时至少保留「剧集」这一级。
    else if (fmode.startsWith('series:')) {
      sub = crumb ? `${t('files.lib.series')} › ${crumb}` : t('files.lib.series')
    }
  } else if (view === 'download' && dlFilter !== 'all') {
    sub = t(`download.${dlFilter}`)
  }

  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span
        className="min-w-0 truncate text-sm font-semibold text-fg-strong"
        title={t(TITLE_KEY[view])}
        data-testid="page-title"
      >
        {t(TITLE_KEY[view])}
      </span>
      {sub && (
        <span className="min-w-0 truncate text-[13px] text-muted" data-testid="context-bar-sub">
          {sub}
        </span>
      )}
    </span>
  )
})

export const ContextBar = memo(function ContextBar({
  nav,
  onNewDownload,
  onPauseAll,
  onResumeAll,
  onClearCompleted,
  ingestOverview,
  ingestUnavailable,
}: ContextBarProps) {
  const { t } = useTranslation()
  const { view, dlFilter } = nav
  const kind = resolveContextKind(view)

  /** 只有「已完成」档挂「清空」：失败·已取消没有专属档位（树里没有它），
   *  其单条清理走 `DownloadItem` 行内的「删除」按钮（覆盖 completed | error | cancelled）。 */
  const showClear = view === 'download' && dlFilter === 'done'

  /**
   * 三列网格（唯一真源，禁止在 JSX 里散写三元）。
   *
   * 常态：左右同为 `1fr` ⇒ 中槽**真正的居中**（flex 下中槽只在剩余空间里居中，
   * 实测偏左 53px）。
   *
   * **TG 域 + 窄窗的例外**（2026-10-17）：TG 视图右槽是「入库流水线」入口 +
   * 在传/待处理/已缓存 计数，实测宽 **232px**。壳 `minWidth=900` 时 `1fr` 轨道
   * 只有 166px，右槽会**向左溢出压住中槽的全局搜索框**（入口更宽时实测重叠
   * 211px）。故窄窗下把右槽改成 `auto`（按内容取宽）、标题也改成 `auto`、
   * 中槽 `minmax(0,1fr)` 让位 —— 搜索框本身是 `w-80` + `min-w-0`（可收缩），
   * 让位即自动变窄，不需要它自己写响应式。
   *
   * 断点 1100px 的来历：`1fr` 轨道 ≥ 232px 要求窗口 ≥ 232*2+320+24+192+32 ≈ 1032，
   * 取 1100 留出计数进位（三位数，+22px）的余量。宽窗下形态与改动前**逐像素一致**。
   */
  const gridCls = cn(
    'grid min-w-0 flex-1 items-center gap-3',
    view === 'tg'
      ? 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] max-[1100px]:grid-cols-[auto_minmax(0,1fr)_auto]'
      : 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]',
  )

  return (
    <div
      className={gridCls}
      aria-label={t('ctx.barLabel')}
      data-testid="context-bar"
    >
      <ViewTitle nav={nav} />
      {/* 中槽：TG 视图的全局监控查找（BUG-100 方案 A）。
          只在 tg 视图挂载；组件内部自判可用性与自持高频输入 state，本栏不订阅。
          三列网格而非 flex：左右两列同为 `1fr`，中槽才是**真正的居中** ——
          flex 下中槽只在「标题之后到右槽之前」的剩余空间里居中，实测偏左 53px。

          文件域 items 视图同位挂 `FilesGlobalSearch`（BUG-400 用户裁定：搜索
          属标题栏）。剧集视图（lib-series）不挂 —— 搜索对剧集墙无效，
          恒渲染但恒无效等于控件撒谎（BUG-131 同一口径）。 */}
      {view === 'tg' ? <TgGlobalSearch /> : null}
      {view === 'files' && (nav.fmode === 'cat-all' || fileCategoryOf(nav.fmode) !== null) ? (
        <FilesGlobalSearch />
      ) : null}
      <div className="col-start-3 flex shrink-0 items-center justify-end gap-3">
        {/* TG 入口（2026-10-17 终裁）：**只有入口按钮本身** —— 点它开最初的
            「入库流水线」面板（功能一个不删），按钮上挂「在传/待处理/已缓存」
            简易计数。**不挂跳转**：`下载状态` / `去媒体库查看` 都是条目级动作，
            只留在条目行上（面板每行 / 下载域行内）。计数来自 MainLayout 的唯一
            轮询点，本栏只转发。 */}
        {view === 'tg' ? (
          <TgCacheEntry overview={ingestOverview} unavailable={ingestUnavailable} />
        ) : null}
        {kind === 'download' ? (
          <ContextBarActions
            showClear={showClear}
            onNewDownload={onNewDownload}
            onPauseAll={onPauseAll}
            onResumeAll={onResumeAll}
            onClearCompleted={onClearCompleted}
          />
        ) : kind === 'files' ? (
          /* 文件域库级动作组（BUG-317 四件套①+② / 任务 #9）：
             导入目录 = page-primary-action，其余次级。选择态动作不在标题行
             —— 它们在面板内的浮动底部选择条（items-selection-bar）。 */
          <ContextBarFilesActions />
        ) : (
          <ContextBarStatus />
        )}
      </div>
    </div>
  )
})
