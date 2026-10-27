import { DownloadItem } from './DownloadItem'
import type { DownloadStatus } from '../../types'
import { useTranslation } from '../../i18n'

interface Props {
  items: DownloadStatus[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  /** 行级选中（BUG-353）：已选中的引擎任务 id 集合 */
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
}

export function DownloadList({ items, loading, error, onRetry, selectedIds, onToggleSelect }: Props) {
  const { t } = useTranslation()
  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-2 border-t-accent" />
        <p className="mt-4 text-sm">{t('download.list.loading')}</p>
      </div>
    )
  }

  if (error && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <p className="text-sm text-danger">{error}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-3 text-xs text-accent hover:underline"
          >
            {t('download.list.retry')}
          </button>
        )}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2">
          <svg className="h-8 w-8 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        </div>
        <h3 className="mt-4 text-sm font-medium text-fg-mid">{t('download.list.emptyTitle')}</h3>
        <p className="mt-1 text-xs text-muted">{t('download.list.emptyHint')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <DownloadItem
          key={item.id}
          item={item}
          selected={selectedIds?.has(item.id) ?? false}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  )
}
