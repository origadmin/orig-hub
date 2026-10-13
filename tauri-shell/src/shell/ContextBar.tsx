import { memo } from 'react'
import type { NavState, ViewId } from '../nav'
import { libraryGroupOf, fileCategoryOf } from '../nav'
import { ContextBarActions } from './ContextBarActions'
import { ContextBarStatus } from './ContextBarStatus'
import { TgGlobalSearch } from '../components/TgGlobalSearch'
import { TgCacheEntry } from '../components/TgCacheEntry'
import { useTranslation } from '../i18n'

/**
 * 顶部上下文栏（BUG-083）。
 *
 * 原先这一行是**固定的下载按钮组**，只在下载视图渲染，媒体库 / TG / 设置下整行空白
 * （`h-12 shrink-0` 有高度无用途）。现在改成随视图变化：
 *   - 下载类视图 → 右槽给连接灯（BUG-164，此前半数视图三角落缺一）+ 聚合速度 + 下载操作；
 *   - 其余视图   → 右槽给全局状态（连接态 + 聚合速度 + 进行中数量）；
 *   - 左槽始终给当前视图标题。
 *
 * **不需要占位**：`<header>` 本身恒为 `h-12 shrink-0` 且恒定渲染，切换视图不会有高度跳动，
 * 额外占位只会多一个空 div。
 *
 * 流畅约束（AGENTS.md §5）：本组件**不订阅** `downloads`（SSE 高频），只接收低频 props
 * （`view` / `categoryFilter` / useEvent 恒定回调）；高频值由 `SpeedChip` / `ActiveCount`
 * 等叶子各自订阅 `store/selectors.ts` 的标量切片。
 */

/** 上下文栏形态：下载类视图给操作，其余给全局态 */
export type ContextKind = 'download' | 'status'

/** 稳定回调（由 `useEvent` 产出，引用恒定；禁止内联箭头 —— AGENTS.md §5） */
export type OnAction = () => void

export interface ContextBarProps {
  /** 全局导航状态（MainLayout 单一真源，低频） */
  nav: NavState
  onNewDownload: OnAction
  onPauseAll: OnAction
  onResumeAll: OnAction
  onClearCompleted: OnAction
}

/** 视图 → 形态（唯一真源，禁止在 JSX 里散写三元）。
 *  M0 起只有「下载」域给操作组；文件/TG/共享/设置都给全局态 ——
 *  原 `all/downloading/paused/completed` 四个下载态收成一个 `download` 域，
 *  三档改由侧栏树驱动（模块重整 BUG-298 / M0-T02）。 */
export function resolveContextKind(view: ViewId): ContextKind {
  return view === 'download' ? 'download' : 'status'
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

  // 副标题 = 当前树选择的标签（文件域取分类/资料库组；下载域取档位）
  let sub: string | null = null
  if (view === 'files') {
    const cat = fileCategoryOf(fmode)
    const lib = libraryGroupOf(fmode)
    if (cat) sub = t(`files.cat.${cat}`)
    else if (lib) sub = t(`files.lib.${lib}`)
  } else if (view === 'download' && dlFilter !== 'all') {
    sub = t(`download.${dlFilter}`)
  }

  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span
        className="min-w-0 truncate text-sm font-semibold text-fg-strong"
        title={t(TITLE_KEY[view])}
        data-testid="context-bar-title"
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
}: ContextBarProps) {
  const { t } = useTranslation()
  const { view, dlFilter } = nav
  const kind = resolveContextKind(view)

  /** 只有「已完成」档挂「清空」：失败·已取消没有专属档位（树里没有它），
   *  其单条清理走 `DownloadItem` 行内的「删除」按钮（覆盖 completed | error | cancelled）。 */
  const showClear = view === 'download' && dlFilter === 'done'

  return (
    <div
      className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3"
      aria-label={t('ctx.barLabel')}
      data-testid="context-bar"
    >
      <ViewTitle nav={nav} />
      {/* 中槽：TG 视图的全局监控查找（BUG-100 方案 A）。
          只在 tg 视图挂载；组件内部自判可用性与自持高频输入 state，本栏不订阅。
          三列网格而非 flex：左右两列同为 `1fr`，中槽才是**真正的居中** ——
          flex 下中槽只在「标题之后到右槽之前」的剩余空间里居中，实测偏左 53px。 */}
      {view === 'tg' ? <TgGlobalSearch /> : null}
      <div className="col-start-3 flex shrink-0 items-center justify-end gap-3">
        {view === 'tg' ? <TgCacheEntry /> : null}
        {kind === 'download' ? (
          <ContextBarActions
            showClear={showClear}
            onNewDownload={onNewDownload}
            onPauseAll={onPauseAll}
            onResumeAll={onResumeAll}
            onClearCompleted={onClearCompleted}
          />
        ) : (
          <ContextBarStatus />
        )}
      </div>
    </div>
  )
})
