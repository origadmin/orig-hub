import { useEffect, useState } from 'react'
import { Sidebar, type ViewId } from './Sidebar'
import { DownloadList } from './DownloadList'
import { AddDownloadDialog } from './AddDownloadDialog'
import { SettingsPanel } from './SettingsPanel'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { useStore } from '../store/useStore'
import { formatSpeed } from '../lib/utils'
import { ensureDaemon, daemonStatus } from '../api/tauri'

export function MainLayout() {
  const [view, setView] = useState<ViewId>('downloading')
  const [collapsed, setCollapsed] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { downloads, init, setDaemon, refresh } = useStore()

  useEffect(() => {
    init()
    // 确保 daemon 运行（先拉起，再查状态）
    ensureDaemon()
      .then(() => daemonStatus())
      .then(setDaemon)
      .catch(() => {})
    // 定期刷新兜底（SSE 断线时）
    const timer = setInterval(() => refresh().catch(() => {}), 5000)
    return () => clearInterval(timer)
  }, [init, refresh, setDaemon])

  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued')
  const completed = downloads.filter((d) => d.status === 'completed')
  const totalSpeed = active.reduce((sum, d) => sum + (d.speed || 0), 0)

  const visible =
    view === 'settings'
      ? downloads
      : view === 'completed'
        ? completed
        : downloads.filter(
            (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused' || d.status === 'idle' || d.status === 'error',
          )

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        view={view}
        onViewChange={setView}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        counts={{ active: active.length, completed: completed.length }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-4">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-zinc-100">
              {view === 'downloading' && '下载中'}
              {view === 'completed' && '已完成'}
              {view === 'settings' && '设置'}
            </h1>
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {active.length} 活跃
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden font-mono text-xs text-accent md:inline">
              {formatSpeed(totalSpeed)}
            </span>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              新建下载
            </Button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4">
          {view === 'settings' ? (
            <SettingsPanel />
          ) : (
            <DownloadList items={visible} />
          )}
        </main>

        {/* Status bar */}
        <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border-subtle px-4 text-[11px] text-muted">
          <span>
            {active.length} 个下载中 · {completed.length} 个已完成
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            daemon 已连接
            {totalSpeed > 0 && (
              <span className="font-mono text-accent">{formatSpeed(totalSpeed)}</span>
            )}
          </span>
        </footer>
      </div>

      <AddDownloadDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}
