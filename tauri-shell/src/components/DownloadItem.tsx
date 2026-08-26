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

// Tauri 环境可用时才加载 opener（浏览器 dev 环境降级为不显示）
const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

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
  const { pause, resume, cancel, remove, setError } = useStore()
  const meta = statusMeta[item.status] ?? statusMeta.idle
  const isActive = item.status === 'downloading'

  /** 在资源管理器中显示文件（completed 任务可用） */
  const handleReveal = async () => {
    if (!item.dest_path) return
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
      await revealItemInDir(item.dest_path)
    } catch (e) {
      console.error('reveal failed', e)
      setError(`打开文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开下载目录 */
  const handleOpenDir = async () => {
    if (!item.dest_path) return
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      const dir = item.dest_path.slice(0, Math.max(item.dest_path.lastIndexOf('/'), item.dest_path.lastIndexOf('\\')))
      await openPath(dir || item.dest_path)
    } catch (e) {
      console.error('open dir failed', e)
      setError(`打开目录失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="group rounded-lg border border-border-subtle bg-surface p-4 transition-all duration-200 hover:border-accent/40 hover:bg-surface/80">
      <div className="flex items-start justify-between gap-3">
        {/* 文件名 + URL */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-fg-strong">
              {item.filename || '未知文件'}
            </p>
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted" title={item.url}>
            {item.url}
          </p>
        </div>

        {/* 操作按钮（图标+文字，悬停显示） */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {isActive && (
            <Button size="sm" variant="ghost" onClick={() => pause(item.id)} title="暂停">
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5v14M16 5v14" />
              </svg>
              暂停
            </Button>
          )}
          {item.status === 'paused' && (
            <Button size="sm" variant="ghost" onClick={() => resume(item.id)} title="恢复">
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86z" />
              </svg>
              恢复
            </Button>
          )}
          {(isActive || item.status === 'paused' || item.status === 'queued' || item.status === 'idle') && (
            <Button size="sm" variant="ghost" onClick={() => cancel(item.id)} title="取消">
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 6 6 18M6 6l12 12" />
              </svg>
              取消
            </Button>
          )}
          {(item.status === 'completed' || item.status === 'error' || item.status === 'cancelled') && (
            <>
              {item.status === 'completed' && isTauri() && item.dest_path && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { void handleReveal(); }} title="在资源管理器中显示文件">
                    <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
                    </svg>
                    打开文件
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { void handleOpenDir(); }} title="打开下载目录">
                    <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    打开目录
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => remove(item.id)} title="删除">
                <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                </svg>
                删除
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 进度条 */}
      <div className="mt-3">
        <Progress value={item.progress} animated={isActive} />
      </div>

      {/* 元信息 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-mono text-fg-mid">
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

      {/* 分块进度（BUG-002） */}
      {item.blocks_total ? (
        <div className="mt-2">
          {item.blocks && item.blocks.length > 0 ? (
            <div
              className="flex flex-wrap gap-0.5"
              title={`${item.blocks_done}/${item.blocks_total} 块完成 · ${item.blocks_pending} 待下载`}
            >
              {item.blocks.map((b, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1.5 w-1.5 rounded-[1px]',
                    b === 2
                      ? 'bg-success'
                      : b === 1
                        ? 'bg-accent/60'
                        : b === 3
                          ? 'bg-danger'
                          : 'bg-border-subtle',
                  )}
                />
              ))}
            </div>
          ) : (
            <div className="font-mono text-xs text-muted">
              {item.blocks_done}/{item.blocks_total} 块完成
              {item.blocks_pending ? ` · ${item.blocks_pending} 待下载` : ''}
            </div>
          )}
        </div>
      ) : null}

      {/* 连接明细（BUG-002） */}
      {isActive && item.connections_detail && item.connections_detail.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {item.connections_detail.map((c) => (
            <span
              key={c.id}
              className={cn(
                'rounded px-1 py-0.5 font-mono text-[10px]',
                c.state === 'error' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent',
              )}
              title={`${c.iface} · ${formatSpeed(c.speed)}`}
            >
              {c.iface}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
