import { DownloadItem } from './DownloadItem'
import type { DownloadStatus } from '../types'

interface Props {
  items: DownloadStatus[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
}

export function DownloadList({ items, loading, error, onRetry }: Props) {
  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-2 border-t-accent" />
        <p className="mt-4 text-sm">加载中…</p>
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
            重试
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
        <h3 className="mt-4 text-sm font-medium text-fg-mid">暂无下载任务</h3>
        <p className="mt-1 text-xs text-muted">点击右上角「新建下载」添加任务</p>
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <DownloadItem key={item.id} item={item} />
      ))}
    </div>
  )
}
