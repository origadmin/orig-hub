import { memo } from 'react'
import type { ViewId } from './Sidebar'
import { ContextBarActions } from './ContextBarActions'
import { ContextBarStatus } from './ContextBarStatus'
import { useTranslation } from '../i18n'

/**
 * 顶部上下文栏（BUG-083）。
 *
 * 原先这一行是**固定的下载按钮组**，只在下载视图渲染，媒体库 / TG / 设置下整行空白
 * （`h-12 shrink-0` 有高度无用途）。现在改成随视图变化：
 *   - 下载类视图 → 右槽给下载操作（沿用原有按钮与文案）；
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
  /** 当前视图（MainLayout 本地 state，低频） */
  view: ViewId
  /** 「全部文件」分类下钻值（null = 未下钻）；仅用于标题面包屑 */
  categoryFilter: string | null
  onNewDownload: OnAction
  onPauseAll: OnAction
  onResumeAll: OnAction
  onClearCompleted: OnAction
}

/** 视图 → 形态（唯一真源，禁止在 JSX 里散写三元） */
export function resolveContextKind(view: ViewId): ContextKind {
  return view === 'all' ||
    view === 'downloading' ||
    view === 'paused' ||
    view === 'completed'
    ? 'download'
    : 'status'
}

/** 视图 → 标题 i18n key（复用既有 `nav.*`，不重复造标题文案） */
export const TITLE_KEY: Record<ViewId, string> = {
  all: 'nav.all',
  downloading: 'nav.downloading',
  paused: 'nav.paused',
  completed: 'nav.completed',
  media: 'nav.media',
  tg: 'nav.tg',
  settings: 'nav.settings',
}

interface ViewTitleProps {
  view: ViewId
  categoryFilter: string | null
}

/** 左槽：当前视图标题（所有视图都渲染 → 这一栏不再留白） */
export const ViewTitle = memo(function ViewTitle({
  view,
  categoryFilter,
}: ViewTitleProps) {
  const { t } = useTranslation()
  // 「全部文件」下钻时补一级面包屑；分类名本身可翻译，缺失时回退到分类 key 本身
  const title =
    view === 'all' && categoryFilter
      ? t('ctx.allCategory', {
          cat: t(`category.${categoryFilter}`, undefined, categoryFilter),
        })
      : t(TITLE_KEY[view])
  return (
    <span
      className="min-w-0 truncate text-sm font-semibold text-fg-strong"
      title={title}
      data-testid="context-bar-title"
    >
      {title}
    </span>
  )
})

export const ContextBar = memo(function ContextBar({
  view,
  categoryFilter,
  onNewDownload,
  onPauseAll,
  onResumeAll,
  onClearCompleted,
}: ContextBarProps) {
  const { t } = useTranslation()
  const kind = resolveContextKind(view)

  /** 只有「已完成」档挂「清空」：失败·已取消档已移除，失败项不再有独立导航页，
   *  其单条清理走 `DownloadItem` 行内的「删除」按钮（覆盖 completed | error | cancelled）。 */
  const showClear = view === 'completed'

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-3"
      aria-label={t('ctx.barLabel')}
      data-testid="context-bar"
    >
      <ViewTitle view={view} categoryFilter={categoryFilter} />
      <div className="ml-auto flex shrink-0 items-center gap-3">
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
