import { memo } from 'react'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'

/**
 * 上下文栏右槽的「入库流水线」入口（缓存管理）。
 *
 * 原先它独占 `TgPanel` 顶部一整行 —— 1248x41 的容器里只放一个 89x28 的按钮，
 * 视觉上一整行被一个按钮占着。上移到上下文栏后与连接态/速度同一行，不再单独占行。
 *
 * 未授权/不可用时**照样显示**（沿用原判据）：缓存任务与缓存字节是本地数据，
 * TG 连不上时恰恰更需要查看与清理；只有真连不上服务（`unreachable`）才隐藏。
 */
export const TgCacheEntry = memo(function TgCacheEntry() {
  const { t } = useTranslation()
  const up = useStore(
    (s) => s.tgAvailability === null || s.tgAvailability.status !== 'unreachable',
  )
  const open = useStore((s) => s.setTgCacheManagerOpen)

  if (!up) return null

  return (
    <button
      type="button"
      onClick={() => open(true)}
      title={t('tg.cacheManagerHint')}
      className="flex h-7 shrink-0 items-center gap-1 rounded border border-border-subtle px-2 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg-strong"
      data-testid="tg-cache-manager-entry"
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M20 7.5 12 12 4 7.5m8 4.5v9M4 7.5C4 5.015 7.582 3 12 3s8 2.015 8 4.5M4 7.5v9C4 18.985 7.582 21 12 21s8-2.015 8-4.5v-9"
        />
      </svg>
      {t('tg.cacheManager')}
    </button>
  )
})
