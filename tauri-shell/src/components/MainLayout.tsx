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
import { CONN_DOT, CONN_LABEL, useConnState } from '../store/connState'
import { useEvent } from '../hooks/useEvent'
import { useTranslation } from '../i18n'
import { formatSpeed } from '../lib/utils'
import { ensureDaemon, daemonStatus } from '../api/tauri'
import { health } from '../api/daemon'
import { cn } from '../lib/utils'

export function MainLayout() {
  // APP 核心是下载工具，默认落地全部下载
  const [view, setView] = useState<ViewId>('all')
  const [collapsed, setCollapsed] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { t } = useTranslation()
  /** 连接态：与上下文栏、侧栏底部同源（BUG-087，唯一来源 `store/connState.ts`） */
  const connState = useConnState()
  const { downloads, init, setDaemon, setDaemonAlive, refresh, pauseAll, resumeAll, clearCompleted, toast, clearToast, categories, categoryFilter, setCategoryFilter, viewer, setViewerIndex, closeViewer, tgEnabled, tgAvailability, refreshTgSession } = useStore()

  /** TG 入口级门控（用户裁定：常规 TG 开关控制整个 TG 内容）：
   *  开关关 OR orig-tg 进程不可达 → 侧栏 TG 导航整体隐藏；
   *  面板级故障卡只作保底回退。`tgAvailability === null` 为探测未返回的瞬态，
   *  按 ready 处理避免首帧闪烁（探测毫秒级，init() 挂载即触发）。
   *
   *  **「服务可用」= orig-tg 进程可达**（BUG-094）：只有 `unreachable`（连进程都
   *  够不到）才算服务不在；`unavailable`（进程活着、连不上 Telegram）恰恰是最需要
   *  让用户进来修的场景（改代理 / 重新登录），把它判成「功能不存在」而隐藏入口，
   *  就等于把唯一的修复入口一起藏掉。 */
  const tgFeatureReady =
    tgEnabled && (tgAvailability === null || tgAvailability.status !== 'unreachable')

  useEffect(() => {
    init()
    /*
     * 确保 daemon 运行（先拉起，再查状态）。
     *
     * `ensureDaemon` / `daemonStatus` 都是 **Tauri Rust 命令**：纯浏览器开发模式
     * （直接开 dev server、无桌面宿主）下 `invoke` 不存在 → Promise reject。
     * 旧写法 `.catch(() => {})` 把失败咽掉 → `daemon` 恒 null → 连接态恒 offline，
     * 而此时 `/api/downloads` 等请求明明一直在成功（BUG-090：指示器说谎）。
     * 故 Tauri 路径不可用时退到**一次** HTTP 健康探测播种 alive —— 启动期一次性请求，
     * 不是轮询；此后的存活完全由既有请求的成功/失败反推（见 store.refresh / SSE onOpen）。
     */
    ensureDaemon()
      .then(() => daemonStatus())
      .then(setDaemon)
      .catch(() => {
        health()
          .then(() => setDaemonAlive(true))
          .catch(() => setDaemonAlive(false))
      })
    // 定期刷新兜底：仅在 SSE 断线（connected=false）时真正拉取，避免健康连接下每 5s 空轮询
    const timer = setInterval(() => {
      if (useStore.getState().connected) return
      refresh().catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [init, refresh, setDaemon, setDaemonAlive])

  // 服务被摘除时（开关关 / orig-tg 进程不可达）把用户从 TG 视图送回全部下载，
  // 避免停留在已被门控隐藏的面板上。探测未返回（null）不算不可用。
  //
  // 注意：**未绑定不再弹回**（BUG-094）。此前还有一段「未绑定 → 退回 all」，
  // 它与「服务可用即显示」的新门控直接冲突：入口放行了，进来又被弹走，等于没改；
  // 而 `unavailable`（连不上 Telegram）正是必须让用户留下来修的状态。
  useEffect(() => {
    if (view !== 'tg') return
    const serviceDown = tgAvailability !== null && tgAvailability.status === 'unreachable'
    if (!tgEnabled || serviceDown) setView('all')
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

  /**
   * 真正在跑的任务（downloading | queued）：**只**驱动速度合计（下方 `totalSpeed`），不含 idle。
   *
   * 注意：「全部暂停」按钮的可用性**不是**由本变量提供的 —— 它由 `selectActiveCount`
   * （`store/selectors.ts:33-34`）独立订阅，经 `ContextBarActions` 的 `busy` 消费。
   * 两者**口径一致**（同为 downloading | queued）但**不是同一个数据源**：
   * 改这里不会影响那个按钮，反之亦然。
   *
   * 也不要把本变量并进 `downloadingBucket` —— 那会让 idle 任务也计入「真正在跑」，
   * 于是只有 idle 时「全部暂停」亮起却空转（正是本 BUG 要根除的死按钮）。
   */
  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued')
  /**
   * 「下载中」档 = 下载中 | 排队 | 空闲。与侧栏徽标、状态栏共用同一口径，
   * 保证「徽标数 == 点进去的条数」；注意与上面的 active 不是一回事 ——
   * active 只算真正在跑的，不含 idle（否则只有 idle 任务时「全部暂停」会亮起却空转，
   * 那就是新造一个死按钮）。
   */
  const downloadingBucket = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'idle',
  )
  const paused = downloads.filter((d) => d.status === 'paused')
  const completed = downloads.filter((d) => d.status === 'completed')
  // error 与 cancelled 同属「未成功终态」。**只服务状态栏读数**（下方 `main.status` 的
  // `{failed}` 占位符），**不再驱动导航** —— 失败·已取消档已移除，失败任务在「全部文件」里
  // 以行内红色错误文字标记 + 行内「删除」处理。删掉这行 tsc 照样绿（占位符缺失只显示空
  // 字符串），状态栏的失败数会静默消失 —— 典型假绿，勿删。
  const failed = downloads.filter((d) => d.status === 'error' || d.status === 'cancelled')
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
  /**
   * TG 未绑定引导区的出口：跳到设置页（→ 账号 Tab）复用已有的绑定入口。
   * 不在此处另起一套登录流程 —— 登录表单归 `AccountsPanel`，只有一份实现。
   */
  const handleGoAccounts = useEvent(() => handleView('settings'))
  /**
   * 入库流水线 → 媒体库的跨视图出口。
   *
   * 缓存是「订阅内容 → 媒体库」的入库准备物，成品在媒体库里：流水线点了
   * 「去媒体库查看」，就地起播之后要落在媒体库（而不是回到 TG 面板），
   * 否则「查看」只是一次播放器弹出，用户从没到达过成品所在的地方。
   * 视图 state 在本组件（局部），接线只能是这一个回调 —— 组件间不另开通道。
   */
  const handleOpenMedia = useEvent(() => handleView('media'))

  /**
   * 档位过滤（BUG-082）：下载三档（下载中 / 已暂停 / 已完成）各对应一组状态，
   * `idle` 归入下载中档（否则它三档皆不可见）。
   * `error | cancelled` **没有专属档位**（失败·已取消导航档已移除）：它们落在最后的
   * `downloads` 兜底分支，即只在「全部文件」里可见，靠行内红色错误文字 + 行内「删除」处理。
   */
  const baseVisible =
    view === 'settings'
      ? downloads
      : view === 'completed'
        ? completed
        : view === 'paused'
          ? paused
          : view === 'downloading'
            ? downloadingBucket
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
          counts={{
            downloading: downloadingBucket.length,
            paused: paused.length,
            completed: completed.length,
            total: downloads.length,
          }}
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
              view !== 'settings' &&
                view !== 'tg' &&
                view !== 'media' &&
                'overflow-y-auto p-4',
            )}
          >
            {view === 'settings' ? (
              <SettingsPanel onOpenMedia={handleOpenMedia} />
            ) : view === 'tg' ? (
              <ErrorBoundary>
                <TgPanel onOpenAccounts={handleGoAccounts} onOpenMedia={handleOpenMedia} />
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
              {/*
                注意：这里的键名 `active` 是 **i18n 模板占位符契约**（对应 zh/en
                双语模板 `main.status` 里的 `{active}`），**不得**与 <Sidebar counts>
                的 `downloading` 键统一命名 —— 两边同名纯属巧合，语义不同源：
                  · 本处 `active` 受 zh-CN.json / en-US.json 的模板占位符约束；
                  · Sidebar 的 `downloading` 是组件 props 字段名。
                改任一侧都需要**同步双语模板**：占位符缺失不会报错、只显示空字符串，
                状态栏这个数会静默消失而 tsc 照样绿（典型假绿）。
              */}
              {t('main.status', {
                active: downloadingBucket.length,
                paused: paused.length,
                completed: completed.length,
                failed: failed.length,
              })}
            </span>
            {/*
              连接态**不在此处判定**（BUG-087）：此前这里是硬编码「daemon 已连接」+ 恒绿点，
              daemon 真断线时底部照绿，与上下文栏的「daemon 未连接」同屏打架。
              现与上下文栏、侧栏底部同读 `useConnState()`，文案与配色一律取自
              `store/connState.ts` 的 `CONN_LABEL` / `CONN_DOT`。
            */}
            <span
              className={cn('flex items-center gap-1.5')}
              data-testid="statusbar-conn"
              data-conn-state={connState}
            >
              <span
                className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CONN_DOT[connState])}
              />
              {t(CONN_LABEL[connState])}
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
