import { memo, useEffect, useRef } from 'react'
import { useTranslation } from '../i18n'
import { useFilesSearch } from '../store/filesSearch'

/**
 * 顶部上下文栏的文件域搜索（BUG-400）。
 *
 * 用户裁定：搜索属于**标题栏**，不属于内容区工具条 —— 与 TG 域
 * `TgGlobalSearch`（BUG-100）同一位置、同一形态（中槽居中搜索框）。
 *
 * 约束（与 TgGlobalSearch 同三条，违反即回归）：
 *  1. **唯一实例** —— 文件 items 视图恒为 1（挂载门控在 ContextBar：
 *     `fmode === 'cat-all' || fileCategoryOf(fmode) !== null`；剧集视图
 *     `lib-series` 不挂 —— 搜索对剧集墙无效，恒渲染但恒无效等于撒谎，BUG-131）。
 *  2. **不进 ContextBar 本体订阅** —— `input` 是高频值，只有本叶子订阅；
 *     提交给面板的只有防抖后的 `committed`（AGENTS.md §5）。
 *  3. **切离即清空** —— unmount 清 store（input+committed），关键词不跨视图遗留
 *     （与 TgGlobalSearch 同一拍板口径）。
 */
export const FilesGlobalSearch = memo(function FilesGlobalSearch() {
  const { t } = useTranslation()
  const input = useFilesSearch((s) => s.input)
  const setInput = useFilesSearch((s) => s.setInput)

  /** 防抖 300ms：连续按键不通知面板（与 TgGlobalSearch 同一节奏） */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const next = input.trim()
    if (useFilesSearch.getState().committed === next) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      useFilesSearch.getState().commit(next)
    }, 300)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [input])

  /** 切离 items 视图即清空（拍板：切回时关键词不保留） */
  useEffect(() => () => useFilesSearch.getState().clear(), [])

  return (
    <div className="col-start-2 flex min-w-0 items-center justify-center">
      <div
        className="flex h-7 w-80 min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-surface-2/40 px-2"
        data-testid="files-global-search"
      >
        <svg
          className="h-3.5 w-3.5 shrink-0 text-muted"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-4.3-4.3M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z"
          />
        </svg>
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('media.search')}
          aria-label={t('media.search')}
          /* testid 沿用面板工具条时代的契约，验收脚本不需追改 */
          data-testid="media-search-input"
          className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-fg-strong outline-none placeholder:text-muted"
        />
        {input ? (
          <button
            type="button"
            onClick={() => useFilesSearch.getState().clear()}
            aria-label={t('media.clearFilter')}
            data-testid="files-global-search-clear"
            className="shrink-0 rounded px-1 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong"
          >
            x
          </button>
        ) : null}
      </div>
    </div>
  )
})
