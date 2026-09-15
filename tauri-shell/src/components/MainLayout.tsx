import { useEffect, useState } from 'react'
import { Sidebar, type ViewId } from './Sidebar'
import { DownloadList } from './DownloadList'
import { AddDownloadDialog } from './AddDownloadDialog'
import { SettingsPanel } from './SettingsPanel'
import { TgPanel } from './TgPanel'
import { TitleBar } from './TitleBar'
import { Button } from './ui/button'
import { useStore } from '../store/useStore'
import { useTranslation } from '../i18n'
import { formatSpeed } from '../lib/utils'
import { ensureDaemon, daemonStatus } from '../api/tauri'
import { cn } from '../lib/utils'

export function MainLayout() {
  const [view, setView] = useState<ViewId>('downloading')
  const [collapsed, setCollapsed] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { t } = useTranslation()
  const { downloads, init, setDaemon, refresh, pauseAll, resumeAll, clearCompleted, toast, clearToast, categories, categoryFilter, setCategoryFilter, tgEnabled } = useStore()

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

  // TG 插件关闭时，若当前停留在 TG 视图则退回下载视图
  useEffect(() => {
    if (!tgEnabled && view === 'tg') setView('downloading')
  }, [tgEnabled, view])

  // 全局错误 toast：按钮/操作失败时的用户可见反馈（自动消失）
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => clearToast(), 4000)
    return () => clearTimeout(t)
  }, [toast, clearToast])

  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued')
  const paused = downloads.filter((d) => d.status === 'paused')
  const completed = downloads.filter((d) => d.status === 'completed')
  const totalSpeed = active.reduce((sum, d) => sum + (d.speed || 0), 0)

  // 全局聚合进度（BUG-004）：管理中任务（下载中/排队/已暂停）的累计字节占比。
  const aggregate = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused',
  )
  const aggDownloaded = aggregate.reduce((sum, d) => sum + (d.downloaded || 0), 0)
  const aggTotal = aggregate.reduce((sum, d) => sum + (d.total_size || 0), 0)
  const globalProgress = aggTotal > 0 ? Math.min(100, (aggDownloaded / aggTotal) * 100) : 0

  // 切换视图时清空分类筛选；保持「全部文件」下钻与顶层视图互斥。
  const handleView = (v: ViewId) => {
    setCategoryFilter(null)
    setView(v)
  }

  const baseVisible =
    view === 'settings'
      ? downloads
      : view === 'completed'
        ? completed
        : view === 'downloading'
          ? downloads.filter(
              (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused' || d.status === 'idle' || d.status === 'error',
            )
          : downloads
  const visible = categoryFilter
    ? baseVisible.filter((d) => d.category === categoryFilter)
    : baseVisible

  const busy = active.length > 0
  /** 下载相关视图才显示下载工具栏按钮（TG/设置视图隐藏） */
  const isDownloadView = view === 'all' || view === 'downloading' || view === 'completed'

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* 自定义标题栏（与系统样式一致） */}
      <TitleBar title="Orig Hub" />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          view={view}
          onViewChange={handleView}
          categories={categories}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          counts={{ active: active.length, completed: completed.length, total: downloads.length }}
          tgEnabled={tgEnabled}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 顶部工具栏：只放操作按钮；标题交给侧边栏，避免重复 */}
          <header className="flex h-12 shrink-0 items-center justify-end gap-3 border-b border-border-subtle bg-surface/60 px-4">
            {isDownloadView && busy && (
              <span className="mr-auto hidden font-mono text-xs text-accent sm:inline">
                {formatSpeed(totalSpeed)}
              </span>
            )}

            {isDownloadView && (
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                {t('main.newDownload')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => pauseAll().catch(() => {})}
                disabled={!busy}
                title={t('main.pauseAllHint')}
              >
                <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 5v14M16 5v14" />
                </svg>
                {t('main.pauseAll')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => resumeAll().catch(() => {})}
                disabled={paused.length === 0}
                title={t('main.resumeAllHint')}
              >
                <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86a1 1 0 00-1.5.86z" />
                </svg>
                {t('main.resumeAll')}
              </Button>
              {view === 'completed' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearCompleted().catch(() => {})}
                  disabled={completed.length === 0}
                  title={t('main.clearHint')}
                >
                  {t('main.clear')}
                </Button>
              )}
            </div>
            )}
          </header>

          {/* Content：设置页自带内滚动（标题置顶占满），其余视图用外层滚动 */}
          <main
            className={cn(
              'flex-1 overflow-hidden',
              view === 'tg' && 'flex',
              view !== 'settings' && view !== 'tg' && 'overflow-y-auto p-4',
            )}
          >
            {view === 'settings' ? (
              <SettingsPanel />
            ) : view === 'tg' ? (
              <TgPanel />
            ) : (
              <DownloadList items={visible} />
            )}
          </main>

          {/* 全局聚合进度条（BUG-004） */}
          {aggregate.length > 0 && (
            <div className="h-0.5 w-full bg-border-subtle" title={`全局进度 ${globalProgress.toFixed(1)}%`}>
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${globalProgress}%` }}
              />
            </div>
          )}

          {/* Status bar */}
          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border-subtle px-4 text-[11px] text-muted">
            <span>
              {t('main.status', {
                active: active.length,
                paused: paused.length,
                completed: completed.length,
              })}
            </span>
            <span className={cn('flex items-center gap-1.5')}>
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {t('main.daemonConnected')}
              {totalSpeed > 0 && (
                <span className="font-mono text-accent">{formatSpeed(totalSpeed)}</span>
              )}
            </span>
          </footer>
        </div>
      </div>

      <AddDownloadDialog open={addOpen} onClose={() => setAddOpen(false)} />

      {/* 全局错误 toast（按钮/操作失败可见反馈） */}
      {toast && (
        <div className="pointer-events-none fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-lg border border-danger/40 bg-danger/15 px-4 py-2 text-sm text-danger shadow-lg backdrop-blur-sm">
          {toast}
        </div>
      )}
    </div>
  )
}
