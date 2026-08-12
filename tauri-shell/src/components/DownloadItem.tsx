import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import {
  cn,
  formatBytes,
  formatEta,
  formatSpeed,
} from '../lib/utils'
import type { DownloadStatus } from '../types'
import { useStore } from '../store/useStore'

const statusMeta: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'danger' | 'default' | 'secondary' }
> = {
  downloading: { label: '下载中', variant: 'default' },
  queued: { label: '排队中', variant: 'secondary' },
  idle: { label: '空闲', variant: 'secondary' },
  paused: { label: '已暂停', variant: 'warning' },
  completed: { label: '已完成', variant: 'success' },
  error: { label: '错误', variant: 'danger' },
  cancelled: { label: '已取消', variant: 'secondary' },
}

export function DownloadItem({ item }: { item: DownloadStatus }) {
  const { pause, resume, cancel, remove } = useStore()
  const meta = statusMeta[item.status] ?? statusMeta.idle
  const isActive = item.status === 'downloading'

  return (
    <div className="group rounded-lg border border-border-subtle bg-surface p-4 transition-all duration-200 hover:border-accent/40 hover:bg-surface/80">
      <div className="flex items-start justify-between gap-3">
        {/* 文件名 + URL */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-zinc-100">
              {item.filename || '未知文件'}
            </p>
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted" title={item.url}>
            {item.url}
          </p>
        </div>

        {/* 操作按钮 */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {isActive && (
            <Button size="sm" variant="ghost" onClick={() => pause(item.id)} title="暂停">
              暂停
            </Button>
          )}
          {item.status === 'paused' && (
            <Button size="sm" variant="ghost" onClick={() => resume(item.id)} title="恢复">
              恢复
            </Button>
          )}
          {(isActive || item.status === 'paused' || item.status === 'queued' || item.status === 'idle') && (
            <Button size="sm" variant="ghost" onClick={() => cancel(item.id)} title="取消">
              取消
            </Button>
          )}
          {(item.status === 'completed' || item.status === 'error' || item.status === 'cancelled') && (
            <Button size="sm" variant="ghost" onClick={() => remove(item.id)} title="删除">
              删除
            </Button>
          )}
        </div>
      </div>

      {/* 进度条 */}
      <div className="mt-3">
        <Progress value={item.progress} animated={isActive} />
      </div>

      {/* 元信息 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-mono text-zinc-300">
          {formatBytes(item.downloaded)}
          {item.total_size > 0 && (
            <> / {formatBytes(item.total_size)}</>
          )}
        </span>
        <span className="font-mono text-accent">
          {isActive ? formatSpeed(item.speed) : '—'}
        </span>
        {isActive && item.eta > 0 && (
          <span className="font-mono">ETA {formatEta(item.eta)}</span>
        )}
        {item.connections > 0 && (
          <span className={cn('font-mono')}>{item.connections} 连接</span>
        )}
        {item.status === 'completed' && item.avg_speed > 0 && (
          <span className="font-mono">均速 {formatSpeed(item.avg_speed)}</span>
        )}
        {item.error && (
          <span className="truncate text-danger" title={item.error}>
            {item.error}
          </span>
        )}
      </div>
    </div>
  )
}
