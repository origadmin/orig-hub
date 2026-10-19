import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { DownloadPanel } from '../domains/download/DownloadPanel'
import { AddDownloadDialog } from '../domains/download/AddDownloadDialog'
import { useIngestGroups } from '../domains/download/useIngestGroups'
import { SettingsPanel } from '../components/SettingsPanel'
import { TgPanel } from '../components/TgPanel'
import { FilesPanel } from '../domains/files/FilesPanel'
import { MediaViewer } from '../components/MediaViewer'
import { ErrorBoundary } from '../components/ui/ErrorBoundary'
import { TitleBar } from './TitleBar'
import { ContextBar } from './ContextBar'
import { useStore } from '../store/useStore'
import { selectActiveSpeedLabel, selectHasActiveSpeed } from '../store/selectors'
import { CONN_DOT, CONN_LABEL, useConnState } from '../store/connState'
import { useEvent } from '../hooks/useEvent'
import { useTranslation } from '../i18n'
import {
  DEFAULT_NAV,
  navigate,
  type NavState,
  type SidebarCounts,
  type ViewId,
} from '../nav'
import { SharePanel } from '../domains/share/SharePanel'
import { ensureDaemon, daemonStatus } from '../api/tauri'
import { health, setDaemonPort } from '../api/daemon'
import { cn } from '../lib/utils'

export function MainLayout() {
  /**
   * 全局导航状态（M0-T01）：五项域 + 两棵树，单一真源。
   *
   * M0 前这里是 `useState<ViewId>('all')`（七值自由枚举，把「下载三档」与
   * 「文件/TG/设置」混在一层）。现在 `view` 只表示**域**，树选择在
   * `dlFilter` / `fmode` 里 —— 域间只经 `navigate()` 切换（见 nav/index.ts）。
   */
  const [nav, setNav] = useState<NavState>(DEFAULT_NAV)
  /** 当前域（`nav` 的五个值之一）：渲染分配额与 CSS 分支都只读它 */
  const { view } = nav
  const [collapsed, setCollapsed] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  /** 侧栏徽标的事实计数（各域面板上报，不在此处另算） */
  const [filesCounts, setFilesCounts] = useState<SidebarCounts>({
    files: 0,
    series: 0,
    tags: 0,
  })
  const { t } = useTranslation()
  /** 连接状态点唯一渲染点（BUG-169 终裁=右下角）：真源 `store/connState.ts`。 */
  const connState = useConnState()
  // BUG-134: 状态栏下载速度改读全局选择器，与全局速度文案同源（不再用 active.reduce 自算一套）
  const activeSpeedLabel = useStore(selectActiveSpeedLabel)
  const hasActiveSpeed = useStore(selectHasActiveSpeed)
  const { downloads, init, setDaemon, setDaemonAlive, refresh, pauseAll, resumeAll, clearCompleted, toast, clearToast, viewer, setViewerIndex, closeViewer, tgService, refreshTgState, probeTg } = useStore()

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
      .then((d) => {
        // daemon 实际端口（可能顺延）：先校准 base，再让后续请求打到真服务上（BUG-178）。
        if (typeof d?.port === 'number') setDaemonPort(d.port)
        setDaemon(d)
      })
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

  /*
   * M0-T01 / M0-T05：**删除「TG 不可用就把用户弹回」的 effect**。
   *
   * 这个 effect 与「入口常驻 + 面板内引导空态」直接冲突：入口放行了，用户进来
   * 又被踢走，等于没改。而 `unavailable`（连不上 Telegram）正是**必须让用户
   * 留下来修**的状态（BUG-094 的原话）。
   *
   * 门控没有消失，只是换了位置：`resolveTgFeatureReady(tgService)` 现在由
   * `TgPanel` 自己算（判据仍是同一处选择器，不写第二份 —— BUG-177），
   * 未启用/未登录时渲染 `TgOnboarding` 引导卡，其中「启用 Telegram 插件」
   * 跳到设置·Telegram。**入口在任何状态下都不消失。**
   */

  // TG 开关变化 / 启动期重探测（BUG-097）：退避探测已抽成 store 的 `probeTg` 复用 ——
  // 开启侧 daemon 拉起 orig-tg 需要时间，最多重试 5 次、就绪即停；关闭侧探一次即可
  // （必为不可达，TG 入口随之摘除）。这是**有界探测**，不是常驻轮询。
  useEffect(() => {
    if (!tgService.enabled) {
      void refreshTgState()
      return
    }
    return probeTg()
  }, [tgService.enabled, refreshTgState, probeTg])

  // 全局错误 toast：按钮/操作失败时的用户可见反馈（自动消失）
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => clearToast(), 4000)
    return () => clearTimeout(t)
  }, [toast, clearToast])

  // BUG-134: 状态栏下载速度改读 `selectActiveSpeedLabel`（store/selectors.ts），与全局速度文案同源，
  // 不再在此处用 `active.reduce` 自算一套口径。
  /**
   * 「下载中」档 = 下载中 | 排队 | 空闲。与侧栏徽标、状态栏共用同一口径，
   * 保证「徽标数 == 点进去的条数」；注意与上面的 active 不是一回事 ——
   * active 只算真正在跑的，不含 idle（否则只有 idle 任务时「全部暂停」会亮起却空转，
   * 那就是新造一个死按钮）。
   */
  /**
   * 入库任务的**唯一轮询点**（M3 · BUG-300）。
   *
   * 既供侧栏/状态栏计数，也经 props 下传给 `DownloadPanel`。让面板自己再拉一份
   * 会得到「两次轮询 + 两个时刻的状态」——那正是「徽标数 ≠ 点进去的条数」的来源
   * （BUG-082 三处同源纪律：徽标 / 树档 / 列表三处必须同源）。
   *
   * 按视图在场门控（2026-10-16 用户裁定「不在其位不谋其政」）：不在场时
   * hook 不拉不起轮 —— 否则任何视图都在每 3s 读 SQLite 的 `/api/activity`。
   * 侧栏/状态栏的入库计数在场外显示最后已知快照，切回在场视图立即刷新。
   *
   * **TG 域也算「在位」**（2026-10-17 入口终裁）：上下文栏的「入库流水线」入口在
   * TG 域渲染「在传 / 待处理 / 已缓存」小计数，它就是本 hook 的消费者 —— 门控若不
   * 含 tg，用户停在 TG 域看到的会是切走前的冻结快照，计数不动。故门控 = 下载域 ∪ TG 域。
   * 仍然是**同一处轮询**（不新增数据源，BUG-082 三处同源纪律）。
   */
  const ingest = useIngestGroups(undefined, view === 'download' || view === 'tg')
  /** 概览 = 「笼统的数据」：按**内容对象**计数，不是按原始任务记录数。 */
  const overview = ingest.overview

  const downloadingBucket = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'idle',
  )
  const paused = downloads.filter((d) => d.status === 'paused')
  const completed = downloads.filter((d) => d.status === 'completed')
  // error 与 cancelled 同属「未成功终态」。**只服务状态栏读数**（下方 `main.status` 的
  // `{failed}` 占位符）—— 侧栏树档已按 BUG-314 撤档（曾误设「已取消」独立档，
  // 越权解读用户「记录不消失」诉求；记录可见性由「全部」档承担），这条只读不导航。
  // 删掉这行 tsc 照样绿（占位符缺失只显示空字符串），状态栏的失败数会静默消失
  // —— 典型假绿，勿删。
  const failed = downloads.filter((d) => d.status === 'error' || d.status === 'cancelled')
  // 全局聚合进度（BUG-004）：管理中任务（下载中/排队/已暂停）的累计字节占比。
  const aggregate = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused',
  )
  const aggDownloaded = aggregate.reduce((sum, d) => sum + (d.downloaded || 0), 0)
  const aggTotal = aggregate.reduce((sum, d) => sum + (d.total_size || 0), 0)
  const globalProgress = aggTotal > 0 ? Math.min(100, (aggDownloaded / aggTotal) * 100) : 0

  /**
   * 唯一的域间通道（M0-T01）：`navigate()` 是跨域跳转的唯一真源，
   * 禁止在组件里各自 `setView('tg')`（域间零直接 import，设计原则 4）。
   *
   * 切域时**保留**另一域的树选择（用户切走再回来不该丢上下文）；
   * 显式传入的树选择覆盖。规则见 `nav/index.ts::navigate`。
   */
  const handleNavigate = useEvent((view: ViewId, opts?: Parameters<typeof navigate>[2]) =>
    setNav((prev) => navigate(prev, view, opts)),
  )

  /**
   * 上下文栏的四个操作回调：必须 `useEvent` 恒定引用。
   * 原写法 `onClick={() => pauseAll()...}` 是内联箭头，每次渲染都是新引用，
   * 会让 `ContextBar` / `ContextBarActions` 的 memo 形同虚设（AGENTS.md §5）。
   */
  const handleNewDownload = useEvent(() => setAddOpen(true))
  // 这三个 store 方法内部已聚合失败并通过 toast 提示（见 useStore 的 pauseAll 等），
  // 此处的 catch 仅为防止 unhandled rejection —— 不要再叠一层 toast，否则同一失败弹两遍。
  const handlePauseAll = useEvent(() => void pauseAll().catch(() => {}))
  const handleResumeAll = useEvent(() => void resumeAll().catch(() => {}))
  const handleClearCompleted = useEvent(() => void clearCompleted().catch(() => {}))
  /**
   * TG 未绑定引导区的出口：跳到设置页（→ 账号 Tab）复用已有的绑定入口。
   * 不在此处另起一套登录流程 —— 登录表单归 `AccountsPanel`，只有一份实现。
   */
  const handleGoAccounts = useEvent(() => handleNavigate('settings', { section: 'telegram' }))
  /**
   * 入库流水线 → 媒体库的跨视图出口。
   *
   * 缓存是「订阅内容 → 媒体库」的入库准备物，成品在媒体库里：流水线点了
   * 「去媒体库查看」，就地起播之后要落在媒体库（而不是回到 TG 面板），
   * 否则「查看」只是一次播放器弹出，用户从没到达过成品所在的地方。
   * 视图 state 在本组件（局部），接线只能是这一个回调 —— 组件间不另开通道。
   */
  const handleOpenMedia = useEvent(() => handleNavigate('files', { fmode: 'lib-series' }))
  /**
   * 入库流水线 → 下载域的跨视图出口（2026-10-17 用户裁定「入口只需要简易内容，
   * 全部都在下载里面，其他都不要」）。
   *
   * 条目级明细与管理的家（逐条清单 / 重试 / 删除 / 取消优先）在下载域：
   * TG 侧弹窗每行只留一个门，落到「全部下载」（`dlFilter='all'`）—— 那里按
   * 入库口径列出全部组，点开 `IngestDetailSheet` 就是条目级明细。
   * 与 `handleOpenMedia` 同理，视图 state 在本组件（局部），接线只能是这一个回调。
   */
  const handleOpenDownload = useEvent(() => handleNavigate('download', { dlFilter: 'all' }))
  /**
   * BUG-305：媒体库 → TG 面板的跨域出口（`handleOpenMedia` 的反向对应）。
   *
   * 「在 TG 中查看」的应用内落点：入口先把来源坐标设进 store 正向焦点
   * （`setPendingTgFocus`），这里只负责经 nav 契约切到 tg 域 —— TgPanel 挂载/
   * 可见时消费焦点（选频道 + 定位消息）。视图 state 在本组件（局部），
   * 接线只能是这一个回调（组件间不另开通道，域间零直接 import）。
   */
  const handleOpenTg = useEvent(() => handleNavigate('tg'))

  // 下载档位过滤已随 M0-T02 移入 `domains/download/DownloadPanel`（读 nav.dlFilter）。
  // 本组件只保留**状态栏/徽标口径**用的三个桶（BUG-082 三处同源纪律）。

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
        {/*
          侧栏（M0-T01）：五项域 + 两棵树。
          - `nav` 是单一真源；`onNavigate` 是唯一入口；
          - counts 由各域面板上报（`filesCounts` / 下载三桶），不在此处另算一套；
          - **不再传 `tgReady`**：入口常驻，门控移入 TgPanel 内部空状态（M0-T05）。
            这是 BUG-094 口径的改变 —— 只影响面板内容，不影响导航位。
        */}
        <Sidebar
          nav={nav}
          onNavigate={handleNavigate}
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          counts={{
            files: filesCounts.files,
            // 下载域各桶 = 引擎任务 + 入库对象（M3/BUG-300，口径见上方 overview 注释）
            downloading: downloadingBucket.length + overview.active,
            paused: paused.length,
            completed: completed.length + overview.done,
            series: filesCounts.series,
            tags: filesCounts.tags,
          }}
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
              nav={nav}
              onNewDownload={handleNewDownload}
              onPauseAll={handlePauseAll}
              onResumeAll={handleResumeAll}
              onClearCompleted={handleClearCompleted}
              ingestOverview={overview}
              ingestUnavailable={ingest.unavailable}
            />
          </header>

          {/* Content：设置页自带内滚动（标题置顶占满），其余视图用外层滚动 */}
          <main
            className={cn(
              'flex-1 overflow-hidden',
              // tg / files 两域自带内滚动与分栏，外层不再套滚动（M0 前 media 同理）
              (view === 'tg' || view === 'files') && 'flex',
              // 只有下载域用外层滚动 + 页面留白（卡片流现状不变）
              view === 'download' && 'overflow-y-auto p-4',
            )}
          >
            {view === 'settings' ? (
              <SettingsPanel
                onOpenMedia={handleOpenMedia}
                section={nav.section}
                onSectionChange={(s) => setNav((prev) => navigate(prev, 'settings', { section: s }))}
              />
            ) : view === 'tg' ? (
              <ErrorBoundary>
                <TgPanel
                  onOpenAccounts={handleGoAccounts}
                  onOpenMedia={handleOpenMedia}
                  onOpenDownload={handleOpenDownload}
                />
              </ErrorBoundary>
            ) : view === 'share' ? (
              <ErrorBoundary>
                <SharePanel />
              </ErrorBoundary>
            ) : view === 'download' ? (
              <ErrorBoundary>
                <DownloadPanel
                  dlFilter={nav.dlFilter}
                  items={downloads}
                  ingest={ingest}
                  // 「去媒体库查看」的出口（BUG-300 复报④）：入库行的 goLibrary 是
                  // 共享 hook，但 `onOpenMedia` 是可选的 —— 宿主不给就只起播不切
                  // 视图，按钮照样渲染（死按钮，用户原话「跳转查看」没实现）。
                  // 视图 state 在本组件，接线只能是这一个回调（与 handleOpenTg 同理）。
                  onOpenMedia={handleOpenMedia}
                />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary>
                <FilesPanel
                  nav={nav}
                  onFmodeChange={(m) => setNav((prev) => navigate(prev, 'files', { fmode: m }))}
                  onCounts={setFilesCounts}
                  onOpenTg={handleOpenTg}
                />
              </ErrorBoundary>
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
                // M3/BUG-300：状态栏与侧栏徽标、下载域树档三处同源（含入库任务）
                active: downloadingBucket.length + overview.active,
                paused: paused.length,
                completed: completed.length + overview.done,
                failed: failed.length + overview.stalled,
              })}
            </span>
            {/*
              连接状态点**唯一渲染点**（BUG-169 终裁 = 右下角）：全应用只有这里一个
              连接指示。底栏在 MainLayout 根部单次渲染、不按视图分叉——顶栏灯在
              BUG-164 出过「下载分支整类视图漏接」事故，侧栏/顶栏重复指示已被
              三处收敛全部移除。真源唯一（`useConnState`）+ 渲染唯一（本处）+
              无旁路断言（BUG-167）。速度读数同处展示（BUG-134，来源不变）。
            */}
            <span
              className="flex items-center gap-1.5"
              data-testid="statusbar-conn"
              data-conn-state={connState}
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CONN_DOT[connState])} />
              {t(CONN_LABEL[connState])}
              {hasActiveSpeed && (
                <span className="font-mono text-accent">{activeSpeedLabel}</span>
              )}
            </span>
          </footer>
        </div>
      </div>

      <AddDownloadDialog open={addOpen} onClose={() => setAddOpen(false)} />

      {/* 全局错误 toast（按钮/操作失败可见反馈） */}
      {toast && (
        <div
          className="pointer-events-none fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-lg border border-danger/40 bg-danger/15 px-4 py-2 text-sm text-danger shadow-lg backdrop-blur-sm"
          data-testid="global-toast"
        >
          {toast}
        </div>
      )}
    </div>
  )
}
