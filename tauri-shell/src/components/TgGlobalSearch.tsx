import { memo, useEffect, useRef } from 'react'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'
import { resolveTgFeatureReady } from '../store/selectors'
import { useTgSearch } from '../store/tgSearch'

/**
 * 顶部上下文栏的全局监控查找（BUG-100 方案 A）。
 *
 * 位置判定：搜索范围是**全部监控频道**，原先却挂在频道标题栏（单频道语义）或结果视图
 * 头部（只有搜了才出现）—— 语义错位且位置随内容漂移。上移到上下文栏后恒在同一行居中。
 *
 * 三重约束（违反即回归）：
 *  1. **唯一实例** —— 全页 `input[type=search]` 在 TG 视图恒为 1。
 *  2. **不进 ContextBar 本体** —— `input` 是高频值，只能由本叶子订阅；
 *     提交给 `TgPanel` 的只有防抖后的 `committed`（AGENTS.md §5）。
 *  3. **TG 不可用时隐藏** —— 否则会出现「顶部能搜、面板显示配置卡」的边界态。
 */
export const TgGlobalSearch = memo(function TgGlobalSearch() {
  const { t } = useTranslation()
  const ready = useStore((s) => resolveTgFeatureReady(s.tgEnabled, s.tgAvailability))
  const input = useTgSearch((s) => s.input)
  const setInput = useTgSearch((s) => s.setInput)
  const committed = useTgSearch((s) => s.committed)
  const hits = useTgSearch((s) => s.hits.length)
  const searching = useTgSearch((s) => s.searching)
  const clear = useTgSearch((s) => s.clear)

  /** 防抖 300ms：连续按键不触发查询，也不通知 TgPanel */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const next = input.trim()
    if (next === committed) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      useTgSearch.getState().commit(next)
    }, 300)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [input, committed])

  /** 切离 TG 视图即清空（拍板：切回时关键词不保留），避免结果视图在别处遗留 */
  useEffect(() => () => useTgSearch.getState().clear(), [])

  if (!ready) return null

  return (
    <div className="col-start-2 flex min-w-0 items-center justify-center">
      <div
        className="flex h-7 w-80 min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-surface-2/40 px-2"
        data-testid="tg-global-search"
      >
        {/*
          原此处常驻一条「仅搜索已同步到本地的监控消息」作用域 chip（f437571 引入）。
          已移除：那是**能力限制说明**，不是搜索功能的一部分，常驻占据搜索框最靠前的
          视觉位属于主客倒置——把「这个搜索有局限」当成第一眼信息递给用户，还挤占
          `w-80` 里本就紧张的输入宽度。BUG-100 的三条约束与验收要点（AC3b：全页
          input 恒为 1；结果展示来自哪个频道）**均未要求常驻范围标注**。
          限制说明改为**按需出现**：只在「搜不到」的空态里解释原因（TgPanel 空态）。
        */}
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
          placeholder={t('tg.globalSearchPlaceholder')}
          aria-label={t('tg.globalSearchPlaceholder')}
          data-testid="tg-global-search-input"
          className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-fg-strong outline-none placeholder:text-muted"
        />
        {searching ? (
          <span
            className="shrink-0 text-[10px] text-muted"
            data-testid="tg-global-search-searching"
          >
            ...
          </span>
        ) : committed ? (
          <span
            className="shrink-0 text-[10px] tabular-nums text-muted"
            data-testid="tg-global-search-hits"
          >
            {hits}
          </span>
        ) : null}
        {input ? (
          <button
            type="button"
            onClick={clear}
            aria-label={t('tg.globalSearchClear')}
            data-testid="tg-global-search-clear"
            className="shrink-0 rounded px-1 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong"
          >
            x
          </button>
        ) : null}
      </div>
    </div>
  )
})
