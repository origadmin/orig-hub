import { useEffect, useState } from 'react'
import { Sidebar, type ViewId } from './Sidebar'
import { DownloadList } from './DownloadList'
import { AddDownloadDialog } from './AddDownloadDialog'
import { SettingsPanel } from './SettingsPanel'
import { TgPanel } from './TgPanel'
import { MediaLibraryPanel } from './MediaLibraryPanel'
import { MediaViewer } from './MediaViewer'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { TitleBar } from './TitleBar'
import { ContextBar } from './ContextBar'
import { useStore } from '../store/useStore'
import { useEvent } from '../hooks/useEvent'
import { useTranslation } from '../i18n'
import { formatSpeed } from '../lib/utils'
import { ensureDaemon, daemonStatus } from '../api/tauri'
import { cn } from '../lib/utils'

export function MainLayout() {
  // 默认落地媒体库（下载模块已按用户裁定隐藏，见 Sidebar 的 DOWNLOAD_MODULE_HIDDEN）
  const [view, setView] = useState<ViewId>('media')
  const [collapsed, setCollapsed] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { t } = useTranslation()
  const { downloads, init, setDaemon, refresh, pauseAll, resumeAll, clearCompleted, toast, clearToast, categories, categoryFilter, setCategoryFilter, accounts, viewer, setViewerIndex, closeViewer, tgEnabled, tgAvailability, refreshTgSession } = useStore()

  /** TG 入口级门控（用户裁定：常规 TG 开关控制整个 TG 内容）：
   *  开关关 OR 探测到不可用/不可达 → 侧栏 TG 导航与账号页 TG 绑定整体隐藏；
   *  面板级故障卡只作保底回退。`tgAvailability === null` 为探测未返回的瞬态，
   *  按 ready 处理避免首帧闪烁（探测毫秒级，init() 挂载即触发）。 */
  const tgFeatureReady = tgEnabled && (tgAvailability === null || tgAvailability.status === 'ok')

  useEffect(() => {
    init()
    // 确保 daemon 运行（先拉起，再查状态）
    ensureDaemon()
      .then(() => daemonStatus())
      .then(setDaemon)
      .catch(() => {})
    // 定期刷新兜底：仅在 SSE 断线（connected=false）时真正拉取，避免健康连接下每 5s 空轮询
    const timer = setInterval(() => {
      if (useStore.getState().connected) return
      refresh().catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [init, refresh, setDaemon])

  // TG 未绑定时，若当前停留在 TG 视图则退回媒体库（由登录绑定态驱动，非插件开关）
  useEffect(() => {
    if (!accounts.tg.bound && view === 'tg') setView('media')
  }, [accounts.tg.bound, view])

  // 功能被摘除时（开关关 / 探测到不可用）把用户从 TG 视图送回媒体库，
  // 避免停留在已被门控隐藏的面板上。探测未返回（null）不算不可用。
  useEffect(() => {
    if (view !== 'tg') return
    const unavailable = tgAvailability !== null && tgAvailability.status !== 'ok'
    if (!tgEnabled || unavailable) setView('media')
  }, [tgEnabled, tgAvailability, view])

  // TG 开关变化时重探测可用性：开启侧 daemon 拉起 orig-tg 需要时间，最多重试 5 次；
  // 关闭侧探一次即可（必为不可达，TG 入口随之摘除）。
  useEffect(() => {
    if (!tgEnabled) {
      void refreshTgSession()
      return
    }
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = () => {
      void refreshTgSession().then(() => {
        const st = useStore.getState().tgAvailability
        if ((st === null || st.status !== 'ok') && ++attempts < 5) {
          timer = setTimeout(probe, 1500)
        }
      })
    }
    probe()
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [tgEnabled, refreshTgSession])

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

  /**
   * 上下文栏的四个操作回调：必须 `useEvent` 恒定引用。
   * 原写法 `onClick={() => pauseAll()...}` 是内联箭头，每次渲染都是新引用，
   * 会让 `ContextBar` / `ContextBarActions` 的 memo 形同虚设（AGENTS.md §5）。
   */
  const handleNewDownload = useEvent(() => setAddOpen(true))
  const handlePauseAll = useEvent(() => void pauseAll().catch(() => {}))
  const handleResumeAll = useEvent(() => void resumeAll().catch(() => {}))
  const handleClearCompleted = useEvent(() => void clearCompleted().catch(() => {}))

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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* 自定义标题栏（与系统样式一致） */}
      <TitleBar title="Orig Hub" />

      <div className="relative flex min-h-0 flex-1">
        {/* 全局播放器页：打开时独占整个内容区（连侧边导航在内无任何模块信息），返回后回到原视图 */}
        {viewer && (
          <div className="absolute inset-0 z-40 flex bg-background">
            <MediaViewer
              className="min-w-0 flex-1"
              items={viewer.items}
              index={viewer.index}
              onIndex={setViewerIndex}
              onClose={closeViewer}
              title={viewer.title}
            />
          </div>
        )}
        <Sidebar
          view={view}
          onViewChange={handleView}
          categories={categories}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          counts={{ active: active.length, completed: completed.length, total: downloads.length }}
          tgBound={accounts.tg.bound}
          tgReady={tgFeatureReady}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            顶部上下文栏（BUG-083）：高度恒为 h-12 shrink-0 且恒定渲染，
            内容随视图切换（下载视图给操作、其余给标题 + 全局态），因此不需要占位。
          */}
          <header
            className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-surface/60 px-4"
            data-testid="context-bar-header"
          >
            <ContextBar
              view={view}
              categoryFilter={categoryFilter}
              onNewDownload={handleNewDownload}
              onPauseAll={handlePauseAll}
              onResumeAll={handleResumeAll}
              onClearCompleted={handleClearCompleted}
            />
          </header>

          {/* Content：设置页自带内滚动（标题置顶占满），其余视图用外层滚动 */}
          <main
            className={cn(
              'flex-1 overflow-hidden',
              (view === 'tg' || view === 'media') && 'flex',
              view !== 'settings' && view !== 'tg' && view !== 'media' && 'overflow-y-auto p-4',
            )}
          >
            {view === 'settings' ? (
              <SettingsPanel />
            ) : view === 'tg' ? (
              <ErrorBoundary>
                <TgPanel />
              </ErrorBoundary>
            ) : view === 'media' ? (
              <ErrorBoundary>
                <MediaLibraryPanel />
              </ErrorBoundary>
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
