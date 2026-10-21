import { create } from 'zustand'
import type {
  AccountsState,
  AppSettings,
  DaemonStatus,
  DownloadStatus,
  LanguageValue,
  TgAccount,
  TgLinkInfo,
  TgServiceState,
  TgSession,
} from '../types'
import {
  DAEMON_PORT,
  TG_PLUGIN_ID,
  addDownload as apiAddDownload,
  downloadAction as apiDownloadAction,
  findPlugin,
  getConfig,
  listDownloads,
  listInterfaces,
  removeDownload as apiRemoveDownload,
  restartPlugin,
  retryDownload as apiRetryDownload,
  setDaemonPort,
  setPluginEnabled,
  subscribeEvents,
} from '../api/daemon'
import { getTgSession, setTgPort } from '../api/tg'
import type { DaemonPlugin } from '../api/daemon'
import { logTgReason } from '../lib/tgReason'
import type { AddDownloadRequest, ViewerItem } from '../types'

const SETTINGS_KEY = 'orig-hub:settings'
const ACCOUNTS_KEY = 'orig-hub:accounts'

/**
 * `/api/config` 的 `plugins[]` → TG 服务态（**唯一**适配点，BUG-358）。
 *
 * 契约里不再有 `tg_enabled` / `tg_running` / `tg_port` / `tg_last_error` / `tg_link`
 * 这些把插件名写死的键（用户原话：「"tg_enabled"这些都是什么？毫无共通性…我把TG
 * 改成BB，这个还能用吗？」）。daemon 只下发 `plugins: [{id, label, enabled,
 * running, port, lastError, health}]`，前端按 `id` 取。
 *
 * 为什么把映射收在这一处：`TgServiceState` / `TgLinkHealth` 是既有界面与选择器的
 * 通用形状（snake_case），改它们要动几十处 UI。**只换适配层**，上层零改动 ——
 * 这也正是「插件化」要的可替换性：换插件只改这里的一行 id。
 */
function tgServiceFromPlugins(
  cfg: { plugins?: DaemonPlugin[] } | null | undefined,
): TgServiceState | null {
  const p = findPlugin(cfg, TG_PLUGIN_ID)
  if (!p) return null
  const h = p.health
  return {
    known: true,
    enabled: p.enabled,
    running: p.running,
    port: p.port ?? null,
    lastError: p.lastError ?? null,
    link: h
      ? {
          link_down: h.linkDown,
          down_streak: h.downStreak,
          confirms_required: h.confirmsRequired,
          restarts: h.restarts,
          last_restart_at: h.lastRestartAt,
          reason: h.reason,
        }
      : null,
  }
}

/**
 * 文件域库级动作注册表（BUG-317 / 任务 #9）。
 *
 * 四个动作都是**打开面板内既有对话框**（import / createSeries / export /
 * manageTags），不携带参数也不回传结果 —— 对话框内部的失败提示由面板自己
 * 经 `setError` 处理，与它们原先挂在面板头部时完全同一路径。
 */
export interface FilesActions {
  import: () => void
  createSeries: () => void
  export: () => void
  manageTags: () => void
}

/** TG 有界退避探测：最多 5 次、每次间隔 1.5s（启动期，非轮询；BUG-097） */
const TG_PROBE_MAX_ATTEMPTS = 5
const TG_PROBE_DELAY_MS = 1500

/**
 * 进行中的 TG 探测链取消函数（同一时刻至多一条）。
 *
 * `init()` 的启动探测与 `MainLayout` 开关翻转的探测可能并存，若各起一条链会叠加请求；
 * 这里做单例：重复触发只取消旧的、重启一条（BUG-097）。
 */
let tgProbeCancel: (() => void) | null = null

/** TG 服务层 / 链路层的等值短路签名（BUG-097 + BUG-178） */
function tgServiceKey(a: TgServiceState): string {
  // BUG-351：链路健康与自愈历史一并参与等值判定 —— 重启次数变化必须能刷新界面，
  // 否则「刚重启过」这条事实会被短路掉（界面继续恒绿）。
  // BUG-354：纳入 `known` —— 初始 `known:false` 与后来 `known:true` 必须能区分，
  // 否则「配置未确认」会被短路成「已确认禁用」。
  const l = a.link
  return `${a.known ? 'K' : '-'}|${a.enabled}|${a.running}|${a.port ?? ''}|${a.lastError ?? ''}|${
    l ? `${l.link_down}|${l.down_streak}|${l.restarts}|${l.last_restart_at ?? ''}|${l.reason ?? ''}` : ''
  }`
}

function tgLinkKey(a: TgLinkInfo): string {
  return `${a.state}|${a.reason ?? ''}`
}

/**
 * 由 orig-tg 会话推导**链路层**状态（BUG-178）。
 *
 * 分层是这次的核心：以前「没配凭证」与「Telegram 连不上」都塌成一个
 * `available=false`，前端只能一律喊「Telegram 不可用」—— 于是**待用户完成的动作**
 * （去设置页填凭证、登录）被渲染成了故障，而设置页同时显示「插件：运行中」，
 * 两处互相打架。现在：
 *   - 没配凭证 → `needs_config`（引导去配置，不是故障）
 *   - 已配未登录 → `needs_login`（引导去登录）
 *   - 已配但连不上 → `link_down`（**这才是**故障，重启由 daemon 负责）
 */
export function resolveTgLink(session: TgSession | null | undefined): TgLinkInfo {
  if (!session) return { state: 'unknown', reason: null }
  if (session.api_configured !== true) {
    return { state: 'needs_config', reason: session.reason ?? null }
  }
  if (session.available !== true) {
    return { state: 'link_down', reason: session.reason ?? null }
  }
  return session.phase === 'Authorized'
    ? { state: 'ready', reason: null }
    : { state: 'needs_login', reason: null }
}

/**
 * 由「通信结果」反推的 daemon 状态（BUG-090）。
 *
 * 只改 `alive` 一个字段：Tauri 路径给的 `managed` / `port` 是宿主的真实信息，
 * 不能被一次 HTTP 成功改写掉（`managed` 决定停止按钮等托管语义）。
 * `daemon` 为 null（从未拿到过宿主信息，如浏览器开发模式）时按「非托管」播种。
 */
function daemonWithAlive(cur: DaemonStatus | null, alive: boolean): DaemonStatus {
  if (cur) return cur.alive === alive ? cur : { ...cur, alive }
  return { alive, port: DAEMON_PORT, managed: false }
}

/** 按浏览器环境推断默认语言（i18n 缺省值） */
function defaultLanguage(): LanguageValue {
  if (typeof navigator === 'undefined') return 'zh-CN'
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** 读取持久化设置（localStorage）；不存在时返回默认值 */
function loadAccounts(): AccountsState {
  const defaults: AccountsState = { tg: { phone: null, bound: false } }
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY)
    if (!raw) return defaults
    return { ...defaults, ...(JSON.parse(raw) as Partial<AccountsState>) }
  } catch {
    return defaults
  }
}

/** 读取持久化设置（localStorage）；不存在时返回默认值 */
function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    maxConnections: 8,
    downloadDirectory: '',
    autoStart: true,
    notifications: true,
    theme: 'dark',
    language: defaultLanguage(),
    primaryInterface: undefined,
    enabledInterfaces: {},
    autoClassify: false,
    classifyRules: {},
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaults
    return { ...defaults, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    return defaults
  }
}

/** 解析最终主题：dark | light（system → 跟随 prefers-color-scheme） */
export function resolveTheme(theme: AppSettings['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return theme
}

/** 将主题应用到 <html data-theme>（并同步 body 类名） */
export function applyTheme(theme: AppSettings['theme']) {
  const resolved = resolveTheme(theme)
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.classList.toggle('light', resolved === 'light')
}

/** 监听系统配色变化：system 模式下实时跟随 */
export function watchSystemTheme(theme: () => AppSettings['theme']) {
  const mq = window.matchMedia?.('(prefers-color-scheme: light)')
  if (!mq || typeof mq.addEventListener !== 'function') return
  const handler = () => applyTheme(theme())
  mq.addEventListener('change', handler)
}

interface DownloadState {
  /** 当前任务列表 */
  downloads: DownloadStatus[]
  /** daemon 健康状态 */
  daemon: DaemonStatus | null
  settings: AppSettings
  /** SSE 已连接 */
  connected: boolean
  loading: boolean
  error: string | null
  /** 全局瞬时提示（toast）：按钮/操作失败时的用户可见反馈，避免“点击无反应” */
  toast: string | null
  /**
   * 全局媒体播放器（模块无关）：打开时整个内容区切换为播放器页（不带任何模块信息），TG/媒体库共用。
   *
   * **播放页是只读的**：它只负责看，不提供任何编辑入口。曾经这里有个 `editable`
   * 标志让播放页弹出条目的编辑框，结果是一排「看着能改」的控件落在「正在看片」的
   * 上下文里 —— 改标题/介绍是**整理资料库**的动作，归媒体库（卡片、剧集分集面板），
   * 那里才看得到归属、排序与影响面。
   */
  viewer: { items: ViewerItem[]; index: number; title?: string } | null
  openViewer: (v: { items: ViewerItem[]; index: number; title?: string }) => void
  setViewerIndex: (i: number) => void
  closeViewer: () => void
  /** 自动分类清单（daemon classify_rules 的去重分类名，如 Videos/Music/...）；供侧边栏「全部文件」下钻 */
  categories: string[]
  /** 当前选中的分类筛选（null = 不过滤）；与 view 配合用于「全部文件」下钻 */
  categoryFilter: string | null
  setCategoryFilter: (c: string | null) => void
  /**
   * 入库流水线 → 媒体库的跳转焦点（`source="tg"` 的 ref，形如 `<chatId>:<msgId>`）。
   *
   * 缓存是「订阅内容 → 媒体库」的入库准备物，成品在媒体库。流水线的「去媒体库查看」
   * 因此是一次**跨视图跳转**：先在流水线里就地起播（播放器是全屏覆盖层），再把视图
   * 切到媒体库并把这个 ref 记在这里 —— 媒体库挂载时消费它（定位条目 / 起播），
   * 于是关掉播放器后用户落在媒体库而不是回到 TG 面板。null = 无待消费的焦点。
   */
  pendingMediaFocus: string | null
  setPendingMediaFocus: (ref: string | null) => void

  /**
   * 媒体库 → TG 面板的跳转焦点（BUG-305：`pendingMediaFocus` 的**正向对应**）。
   *
   * 上面那个焦点解决「流水线 → 媒体库」（内容成品在库里）；本焦点解决反方向：
   * 用户在媒体库看到一条 TG 来源的内容，想回到「它来自哪个频道、哪条消息」时，
   * 入口把 `ref`（`<chat>:<msg>`）解析成坐标记在这里，再经 `navigate('tg')`
   * 切到 TG 面板 —— 面板挂载/可见时消费它（选频道 + 定位消息 + 高亮），
   * 消费完即置回 null。null = 无待消费的焦点。
   *
   * 与 `pendingMediaFocus` 是同构的两半，**不得**互相改名/删除（BUG-285 判据⑤）。
   */
  pendingTgFocus: { chatId: number; messageId: number } | null
  setPendingTgFocus: (focus: { chatId: number; messageId: number } | null) => void

  /**
   * 文件域**库级动作注册表**（BUG-317 页面结构规范 / 任务 #9 按钮统一化）。
   *
   * 「导入目录 / 新建剧集 / 导出 / 标签管理」是库级动作（不读任何选择集），
   * 按 BUG-317 四件套应上标题行右槽作为 `page-primary-action` 与次级按钮 ——
   * 而标题行是应用外壳的 `ContextBar`（跨子树），对话框 state 与 `refreshAll`
   * 却都在 `MediaLibraryPanel` 里。搬 state 会把面板的数据局部性打散，
   * 故走**注册表**：面板挂载时把四个 dialog-open handler 注册进 store，
   * `ContextBar` 的 files 分支读取并调用；卸载时注销（null）。
   *
   * 与 `pendingMediaFocus` / `pendingTgFocus` 同一模式（store 作跨组件信号通道），
   * 区别只在形态：那两个传「坐标」，这个传「可执行回调」。
   * null = 文件面板未挂载（按钮整簇不渲染 —— 不可用就不展示，不呈现死按钮）。
   */
  filesActions: FilesActions | null
  setFilesActions: (a: FilesActions | null) => void

  /**
   * TG **服务层**状态（orig-tg 进程）：真源是 daemon `/api/config`（BUG-178）。
   *
   * 「服务在不在」只由 daemon 回答 —— 前端不再自己探测 orig-tg 端口：那是把
   * 「daemon 的托管职责」偷换成「前端的猜测」，猜错就出现「设置页说运行中、
   * 面板说不可用」这种自相矛盾。
   */
  tgService: TgServiceState
  /** TG **链路层**状态（Telegram 侧）：真源是 orig-tg `/api/tg/session` */
  tgLink: TgLinkInfo
  /** 启停 TG 插件：写 daemon（运行时生效+持久化），同步服务层状态 */
  setTgEnabled: (enabled: boolean) => Promise<boolean>
  /**
   * 请 daemon 重启它托管的 orig-tg（**不是**前端拉进程）。
   *
   * 凭证保存 / 网络修好后必须重启才生效（orig-tg 只在启动时连一次 Telegram）。
   * 以前这个动作是桌面壳 `ensure_tg` 与前端「重试连接」两个手动入口，TG 进程因此
   * 有两个主人、互相 kill；现在只留这一个：前端发请求，daemon 执行。
   */
  restartTg: () => Promise<boolean>
  /**
   * 缓存管理（「入库流水线」）面板开关。
   *
   * 入口原先独占 `TgPanel` 顶部一整行（1248x41 的容器里只放一个 89x28 的按钮），
   * 现上移到上下文栏右槽 —— 跨子树（`MainLayout` 触发 / `TgPanel` 渲染），开关只能提到 store。
   */
  tgCacheManagerOpen: boolean
  setTgCacheManagerOpen: (v: boolean) => void

  /** 账号绑定中心状态（当前仅 Telegram，后续可扩展其他账号） */
  accounts: AccountsState
  loadAccounts: () => void
  /** 更新某个账户的绑定态（持久化到 localStorage） */
  setTgAccount: (patch: Partial<TgAccount>) => void
  /**
   * 刷新 TG 状态（**唯一刷新入口**，BUG-097 / BUG-178）：
   * 服务层来自 daemon `/api/config`，链路层来自 orig-tg `/api/tg/session`。
   * 先问服务层，**服务不在就不问链路层**（问了也只是连不上，反而把「服务不在」
   * 误报成「链路故障」）。两层都等值短路，失败分类留痕。
   */
  refreshTgState: () => Promise<void>
  /**
   * 启动期 / 开关翻转后的**有界退避探测**（BUG-097 P0-2）：orig-tg 冷启动首次握手
   * 约 4s，一次探测定终身会永久冻结状态。有界（≤5 次）、就绪即停、**不是轮询**。
   * @returns cancel —— 组件卸载 / 依赖变化时清除未决定时器
   */
  probeTg: () => () => void

  init: () => Promise<void>
  refresh: () => Promise<void>
  setDaemon: (d: DaemonStatus) => void
  /**
   * 用**已有请求的结果**推导 daemon 存活（BUG-090）：不新发任何探活请求。
   *
   * Tauri 命令（`daemon_status`）只在桌面宿主里存在；浏览器开发模式下它 reject，
   * 于是 `daemon` 恒为 null → 连接态恒 offline，而此时 daemon 明明活着
   * （`/api/downloads` 等请求一直在成功）。故存活改由真实通信结果反推：
   * SSE 连上 / 列表拉取成功 → alive；拉取失败 → 不 alive。
   */
  setDaemonAlive: (alive: boolean) => void
  addDownload: (req: AddDownloadRequest) => Promise<void>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  /** 重试一条停住的行。端点独立于 pause/resume/cancel（它作用于记录，不是活体）。 */
  retry: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  pauseAll: () => Promise<void>
  resumeAll: () => Promise<void>
  clearCompleted: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => void
  applyInterfaces: () => Promise<void>
  setError: (e: string | null) => void
  clearToast: () => void
  /** 全局瞬时提示（信息/成功类）：失败走 `setError`，信息类不该被染成错误样式。 */
  setToast: (msg: string) => void
}

/**
 * `/api/events` 订阅句柄（**单例**）。
 *
 * `init()` 由 `MainLayout` 的 effect 调用，而 dev 下 `main.tsx` 开着 `React.StrictMode`
 * （effect 双挂），HMR 也会重跑 —— 旧写法把 `subscribeEvents()` 的返回值**丢弃**，
 * 于是每多一次 init 就多一条 SSE 长连接，且**永不关闭**。每条都占着 daemon 源的一个
 * 连接名额（浏览器同源 6 条），断线还各自退避重连 ⇒ 表现为「/api/events 一直在请求」。
 *
 * 句柄存在即视为已订阅：重复调用 `init()` 不再新建连接。
 */
let sseUnsub: (() => void) | null = null

export const useStore = create<DownloadState>((set, get) => ({
  downloads: [],
  daemon: null,
  settings: loadSettings(),
  connected: false,
  loading: false,
  error: null,
  toast: null,
  categories: [],
  categoryFilter: null,
  pendingMediaFocus: null,
  // BUG-305：媒体库 → TG 面板的正向跳转焦点（与上一行反向对应；null = 无待消费焦点）。
  pendingTgFocus: null,
  // 文件域库级动作注册表（BUG-317 / 任务 #9）：null = 文件面板未挂载，
  // 标题行右槽的库级按钮整簇不渲染（不可用就不展示）。
  filesActions: null,
  setFilesActions: (a) => set({ filesActions: a }),
  // 入口级门控（`resolveTgFeatureReady`）只由服务层决定：开关开着 **且** daemon 说
  // 进程在服务才显示。daemon 不可达 / 插件关闭 / 拉起失败时入口保持隐藏 ——
  // 不可用就不展示（不呈现死按钮，违反设计）。
  tgService: { known: false, enabled: false, running: false, port: null, lastError: null },
  tgLink: { state: 'unknown', reason: null },
  accounts: loadAccounts(),

  init: async () => {
    // 0. system 主题实时跟随系统配色
    watchSystemTheme(() => get().settings.theme)
    // 1. 订阅 SSE 实时进度（**只订阅一次**：句柄已存在就复用，见 `sseUnsub` 注释）
    if (!sseUnsub) {
      sseUnsub = subscribeEvents(
      (evt) => {
        const list = Array.isArray(evt.data) ? evt.data : [evt.data]
        if (list.length === 0) return
        // BUG-372：事件引用了 store 里没有的行（任务在别处创建 / 本端启动晚于
        // 任务 / 删后重建）时，旧代码用 `{...(cur ?? {}), ...item}` 拿事件里的
        // 残缺字段造记录 —— completed 事件只有 {id,status,hash}，没有 filename
        // ⇒ 列表与详情 Sheet 标题显示「未知文件」（用户 2026-10-22 截图实录）。
        // 这里只打标记，set 之后补一次全量刷新把完整记录拿回来。
        let needBackfill = false
        set((s) => {
          const map = new Map(s.downloads.map((d) => [d.id, d]))
          for (const item of list) {
            if (!map.has(item.id) && evt.event !== 'deleted') needBackfill = true
            if (evt.event === 'completed') {
              // Completed 事件：{id, hash_sha256, path} → 标记 completed
              const cur = map.get(item.id)
              map.set(item.id, {
                ...(cur ?? {}),
                id: item.id,
                status: 'completed',
                speed: 0,
                hash_sha256: item.hash_sha256 ?? cur?.hash_sha256,
              } as DownloadStatus)
            } else if (evt.event === 'error') {
              const cur = map.get(item.id)
              const errItem = item as unknown as { id: string; message?: string }
              map.set(item.id, {
                ...(cur ?? {}),
                id: item.id,
                status: 'error',
                speed: 0,
                error: errItem.message ?? cur?.error,
              } as DownloadStatus)
            } else if (evt.event === 'paused') {
              const cur = map.get(item.id)
              map.set(item.id, { ...(cur ?? {}), id: item.id, status: 'paused', speed: 0 } as DownloadStatus)
            } else if (evt.event === 'resumed') {
              const cur = map.get(item.id)
              map.set(item.id, { ...(cur ?? {}), id: item.id, status: 'downloading' } as DownloadStatus)
            } else if (evt.event === 'deleted') {
              map.delete(item.id)
            } else {
              // progress：Progress 结构字段合并
              map.set(item.id, { ...(map.get(item.id) ?? {}), ...item })
            }
          }
          return { downloads: [...map.values()] }
        })
        if (needBackfill) void get().refresh()
      },
      // SSE 连上 = 与 daemon 的通信真的通了 → alive 反推为 true（BUG-090，零新增请求）
      () => {
        set({ connected: true })
        get().setDaemonAlive(true)
        // 顺带补一次 TG 状态刷新（BUG-097 的事件驱动信号源）：冷启动时 orig-tg
        // 常晚于 SSE 就绪，这条信号让 TG 状态在服务起来后自动转正（等值短路，无重渲染）。
        void get().refreshTgState()
      },
      () => set({ connected: false }),
      )
    }
    // 2. 拉取当前列表
    await get().refresh()
    // 3. 拉取分类清单 + TG 插件开关状态（供侧边栏「全部文件」下钻与 TG 模块显隐）
    try {
      const cfg = await getConfig()
      const cats = Array.from(new Set(Object.values(cfg.classify_rules))).sort()
      // 端口以 daemon 为准（可能顺延）：拿到即刻校准两个 base，之后的请求才不会
      // 打到一个不存在（或属于别人）的端口上（BUG-178）。
      if (typeof cfg.port === 'number') setDaemonPort(cfg.port)
      // BUG-358：插件态只认 `plugins[]`（按 id 取），契约里已经没有 `tg_*` 了。
      const svc = tgServiceFromPlugins(cfg)
      if (svc?.port != null) setTgPort(svc.port)
      set({
        categories: cats,
        ...(svc ? { tgService: svc } : {}),
      })
    } catch (e) {
      // 配置不可达：分类暂不列出（菜单退化）。失败**分类留痕**，不静默吞掉（BUG-097）；
      // TG 状态由下方 refreshTgState + 有界退避探测补正。
      logTgReason(e instanceof Error ? e.message : String(e), 'init-config')
    }
    // 4. 校准账号绑定态（orig-tg 会话）
    get().loadAccounts()
    // 一次性校准：失败由 refreshTgState 内部分类留痕，不再 `.catch(() => {})`（BUG-090 / BUG-097）
    await get().refreshTgState()
    // 启动期不能一次定终身（BUG-097）：orig-tg 冷启动首次握手实测约 4s，上面这一次
    // 探测多半赶不上；交给有界退避探测，在服务就绪后自动转正（就绪即停，非轮询）。
    get().probeTg()
  },

  refresh: async () => {
    set({ loading: true })
    try {
      const downloads = await listDownloads()
      // 列表拉取成功 = daemon 可达（BUG-090：复用既有请求的成功信号，不新发探活）
      get().setDaemonAlive(true)
      set({ downloads, loading: false, error: null })
    } catch (e) {
      // 拉取失败 = 这会儿真连不上（5s 兜底轮询会再试，恢复后自动翻回 alive）
      get().setDaemonAlive(false)
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  },

  setDaemon: (d) => set({ daemon: d }),

  setDaemonAlive: (alive) =>
    set({ daemon: daemonWithAlive(get().daemon, alive) }),

  addDownload: async (req) => {
    await apiAddDownload(req)
    await get().refresh()
  },

  pause: async (id) => {
    await apiDownloadAction(id, 'pause')
    await get().refresh()
  },
  resume: async (id) => {
    await apiDownloadAction(id, 'resume')
    await get().refresh()
  },
  cancel: async (id) => {
    await apiDownloadAction(id, 'cancel')
    await get().refresh()
  },
  retry: async (id) => {
    await apiRetryDownload(id)
    await get().refresh()
  },
  remove: async (id) => {
    await apiRemoveDownload(id)
    await get().refresh()
  },

  /**
   * 批量操作失败必须**聚合后如实提示**（BUG-106 同类病根：静默吞错）。
   *
   * 此前每条都 `.catch(() => {})`，调用方再吞一次 —— 于是「全部暂停」在 daemon 不可用
   * 时会**一条都没暂停成功，而界面毫无反应**：用户分不清是「没有符合条件的任务」
   * 还是「操作失败了」。对比单条 `pause`：`await` 抛出、由 `DownloadItem` 用 `setError`
   * 提示 —— 同一功能两套容错策略，批量那条是缺的那一半。
   *
   * 批量语义是「尽力而为」：单条失败不中断其余，但**结束时必须把失败数说清楚**。
   */
  pauseAll: async () => {
    const targets = get().downloads.filter(
      (d) => d.status === 'downloading' || d.status === 'queued',
    )
    let failed = 0
    let firstErr: unknown = null
    for (const d of targets) {
      try {
        await apiDownloadAction(d.id, 'pause')
      } catch (e) {
        failed += 1
        firstErr ??= e
      }
    }
    await get().refresh()
    if (failed > 0) {
      const reason = firstErr instanceof Error ? firstErr.message : String(firstErr)
      set({ toast: `${failed}/${targets.length} 个任务暂停失败：${reason}` })
    }
  },

  /** 全部开始（仅作用于已暂停任务） */
  resumeAll: async () => {
    const targets = get().downloads.filter((d) => d.status === 'paused')
    let failed = 0
    let firstErr: unknown = null
    for (const d of targets) {
      try {
        await apiDownloadAction(d.id, 'resume')
      } catch (e) {
        failed += 1
        firstErr ??= e
      }
    }
    await get().refresh()
    if (failed > 0) {
      const reason = firstErr instanceof Error ? firstErr.message : String(firstErr)
      set({ toast: `${failed}/${targets.length} 个任务续跑失败：${reason}` })
    }
  },

  clearCompleted: async () => {
    const completed = get().downloads.filter(
      (d) => d.status === 'completed' || d.status === 'error' || d.status === 'cancelled',
    )
    let failed = 0
    let firstErr: unknown = null
    for (const d of completed) {
      try {
        await apiRemoveDownload(d.id)
      } catch (e) {
        failed += 1
        firstErr ??= e
      }
    }
    await get().refresh()
    if (failed > 0) {
      const reason = firstErr instanceof Error ? firstErr.message : String(firstErr)
      set({ toast: `${failed}/${completed.length} 条记录清除失败：${reason}` })
    }
  },

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch {
        // 忽略持久化失败（隐私模式等）
      }
      // 主题切换即时生效（含 system → 跟随系统）
      if (patch.theme) applyTheme(settings.theme)
      return { settings }
    }),

  /** 设置页保存后应用到 daemon（默认多网卡池）。 */
  applyInterfaces: async () => {
    // 已连接的非虚拟网卡，且在主网卡之外被勾选 → 提交为默认池
    const { settings } = get()
    try {
      const { primary, secondaries } = await listInterfaces()
      const enabled: Record<string, number> = {}
      for (const nic of [primary, ...(secondaries ?? [])]) {
        if (!nic || nic.is_default) continue
        if (nic.connected && !nic.is_virtual && settings.enabledInterfaces[nic.name]) {
          enabled[nic.name] =
            Math.max(1, Number(settings.enabledInterfaces[nic.name]) || 1)
        }
      }
      // TODO(phase): daemon 暂无「设置默认池」端点；此处预留：
      //   await apiSetDefaultInterfaces(enabled)
      // 当前实现：全局选择仅持久化 + 下载弹窗自动带入。
      void enabled
    } catch {
      // daemon 不可达时静默失败
    }
  },

  setError: (e) => set({ error: e, toast: e }),
  clearToast: () => set({ toast: null }),
  setToast: (msg) => set({ toast: msg }),

  viewer: null,
  openViewer: (v) => set({ viewer: v }),
  setViewerIndex: (i) =>
    set((s) => (s.viewer ? { viewer: { ...s.viewer, index: i } } : s)),
  closeViewer: () => set({ viewer: null }),
  setCategoryFilter: (c) => set({ categoryFilter: c }),
  setPendingMediaFocus: (ref) => set({ pendingMediaFocus: ref }),
  setPendingTgFocus: (focus) => set({ pendingTgFocus: focus }),
  tgCacheManagerOpen: false,
  setTgCacheManagerOpen: (v) => set({ tgCacheManagerOpen: v }),

  /** 启停插件：写 daemon（拉起/终止它托管的子服务），成功同步服务层状态（BUG-358 走 id） */
  setTgEnabled: async (enabled) => {
    try {
      const res = await setPluginEnabled(TG_PLUGIN_ID, { enabled })
      const svc = tgServiceFromPlugins({ plugins: res.plugins })
      if (svc?.port != null) setTgPort(svc.port)
      if (svc) set({ tgService: svc })
      return true
    } catch (e) {
      set({ toast: e instanceof Error ? e.message : String(e) })
      return false
    }
  },

  /** 请 daemon 重启它托管的子服务（前端不碰进程；BUG-178 / BUG-358 走 id） */
  restartTg: async () => {
    try {
      const res = await restartPlugin(TG_PLUGIN_ID)
      const svc = tgServiceFromPlugins({ plugins: res.plugins })
      if (svc?.port != null) setTgPort(svc.port)
      if (svc) set({ tgService: svc })
      return svc?.running ?? false
    } catch (e) {
      // 原文只进日志：Rust/HTTP 报文不进界面
      logTgReason(e instanceof Error ? e.message : String(e), 'tg-restart')
      set({ toast: e instanceof Error ? e.message : String(e) })
      return false
    }
  },

  loadAccounts: () => set({ accounts: loadAccounts() }),

  setTgAccount: (patch) =>
    set((s) => {
      const accounts = { ...s.accounts, tg: { ...s.accounts.tg, ...patch } }
      try {
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts))
      } catch {
        // 忽略持久化失败（隐私模式等）
      }
      return { accounts }
    }),

  /**
   * 刷新 TG 状态（**唯一刷新入口**，BUG-097 / BUG-178）。
   *
   * 顺序是设计的一部分：**先问服务层（daemon），它说进程不在就直接停**。
   * 反过来的代价正是 BUG-178 的现象 —— 链路层在自己探测 orig-tg、探不到就喊
   * 「Telegram 不可用」，而服务层（daemon）同时说「运行中」，两处互相打架。
   *
   * 失败一律**分类留痕**（logTgReason），绝不 `.catch(() => {})` 静默吞掉（BUG-090 / BUG-097）。
   */
  refreshTgState: async () => {
    const applyLink = (next: TgLinkInfo) => {
      if (tgLinkKey(get().tgLink) !== tgLinkKey(next)) set({ tgLink: next })
    }
    let cfg
    try {
      cfg = await getConfig()
    } catch (e) {
      // daemon 不可达：服务层保持上次值（「不知道」不等于「停了」），原文只进日志
      logTgReason(e instanceof Error ? e.message : String(e), 'tg-config')
      return
    }
    // 端口真源：daemon 可能顺延，两个 base 都必须跟着它走。
    if (typeof cfg.port === 'number') setDaemonPort(cfg.port)
    // BUG-358：插件态从 `plugins[]` 按 id 取（契约里没有 `tg_*`）；
    // 取不到 = daemon 还没登记这个插件 ⇒ 保持上次值，不臆断成「被用户关了」。
    const mapped = tgServiceFromPlugins(cfg)
    if (!mapped) return
    if (mapped.port != null) setTgPort(mapped.port)
    const svc: TgServiceState = mapped
    if (tgServiceKey(get().tgService) !== tgServiceKey(svc)) set({ tgService: svc })

    // 服务不在 → 链路无从谈起。这里**不**再去连 orig-tg：连也只是失败，
    // 还会把「服务没起来」渲染成「Telegram 连不上」，方向就错了。
    if (!svc.enabled || !svc.running) {
      applyLink({ state: 'unknown', reason: null })
      return
    }

    let session: TgSession | null = null
    try {
      session = await getTgSession()
    } catch (e) {
      // 失败**分类留痕**（原文只进日志），不静默吞掉。
      logTgReason(e instanceof Error ? e.message : String(e), 'tg-session')
      applyLink({ state: 'unknown', reason: null })
      return
    }
    applyLink(resolveTgLink(session))
    const tg = get().accounts.tg
    if (!session?.phase) return
    const bound = session.phase === 'Authorized'
    if (tg.bound !== bound || (bound && tg.phone !== (session.phone ?? tg.phone))) {
      get().setTgAccount(
        bound
          ? { bound: true, phone: session.phone ?? tg.phone }
          : { bound: false, phone: null },
      )
    }
  },

  /**
   * 启动期 / 开关翻转后的**有界退避探测**（BUG-097 P0-2）。
   *
   * 从 MainLayout 原「开关翻转 → 最多 5×1.5s」逻辑抽出，让启动阶段也复用：
   * orig-tg 冷启动首次 MTProto 握手实测约 4s，一次探测定终身会让服务层永久冻结在
   * `running=false`（BUG-178 里就表现为「开关开着但 TG 永远不显示」）。
   *
   * **不是轮询**（AGENTS.md §5 轮询三律）：次数有界（≤5）、退避触发、就绪即停；
   * 每次刷新都等值短路，故不会造成高频重渲染。
   * 同一时刻至多一条链（模块级单例）：重复触发只重启，不叠加请求。
   *
   * @returns cancel —— 组件卸载 / 依赖变化时清除未决定时器
   */
  probeTg: () => {
    tgProbeCancel?.()
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const probe = () => {
      void get().refreshTgState().then(() => {
        if (cancelled) return
        // 就绪判据是**服务层**（进程在不在），不是链路层：链路还要等 MTProto 握手，
        // 拿它当判据会让「服务已就绪、正在连 Telegram」被误判成没起来。
        const svc = get().tgService
        if (!(svc.enabled && svc.running) && ++attempts < TG_PROBE_MAX_ATTEMPTS) {
          timer = setTimeout(probe, TG_PROBE_DELAY_MS)
        }
      })
    }
    const cancel = () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (tgProbeCancel === cancel) tgProbeCancel = null
    }
    tgProbeCancel = cancel
    probe()
    return cancel
  },
}))

/**
 * 开发期调试钩子（**仅 dev 构建**）：把 store 挂到 `window.__origStore`。
 *
 * 验收探针需要人为制造「陈旧快照」（把 `tgRunning`/`tgAvailability` 改回启动期
 * 那次探测的值）以证明事件驱动刷新路径真的生效（BUG-097 的冻结现象无法用正常
 * UI 操作复现）。生产构建里 `import.meta.env.DEV` 为 false，整段被 tree-shake，
 * 不向页面脚本暴露内部状态。
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __origStore?: typeof useStore }).__origStore = useStore
}
