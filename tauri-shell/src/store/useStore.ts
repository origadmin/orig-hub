import { create } from 'zustand'
import type {
  AccountsState,
  AppSettings,
  DaemonStatus,
  DownloadStatus,
  LanguageValue,
  TgAccount,
  TgAvailability,
} from '../types'
import {
  DAEMON_PORT,
  addDownload as apiAddDownload,
  downloadAction as apiDownloadAction,
  getConfig,
  listDownloads,
  listInterfaces,
  removeDownload as apiRemoveDownload,
  saveTgConfig,
  subscribeEvents,
} from '../api/daemon'
import { getTgSession } from '../api/tg'
import type { AddDownloadRequest, ViewerItem } from '../types'

const SETTINGS_KEY = 'orig-hub:settings'
const ACCOUNTS_KEY = 'orig-hub:accounts'

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

  /** TG 可选插件开关（daemon [tg] enabled）；false 时侧边栏隐藏 TG 模块 */
  tgEnabled: boolean
  /** orig-tg 子服务是否实际在运行（daemon 探活） */
  tgRunning: boolean
  /** 启停 TG 插件：写 daemon（运行时生效+持久化），同步 tgEnabled/tgRunning */
  setTgEnabled: (enabled: boolean) => Promise<boolean>

  /** 账号绑定中心状态（当前仅 Telegram，后续可扩展其他账号） */
  accounts: AccountsState
  /**
   * TG 可用性探测结果（null = 尚未探测）。
   *
   * 与 `accounts.tg.bound` 正交：`bound` 说的是「有没有登录会话」，
   * 这里说的是「依赖本身能不能用」。区分二者才能不把连接故障显示成「登录丢了」。
   */
  tgAvailability: TgAvailability | null
  loadAccounts: () => void
  /** 更新某个账户的绑定态（持久化到 localStorage） */
  setTgAccount: (patch: Partial<TgAccount>) => void
  /** 校准 TG 绑定态：向 orig-tg 查询会话 phase==='Authorized'（失败静默） */
  refreshTgSession: () => Promise<void>

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
  remove: (id: string) => Promise<void>
  pauseAll: () => Promise<void>
  resumeAll: () => Promise<void>
  clearCompleted: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => void
  applyInterfaces: () => Promise<void>
  setError: (e: string | null) => void
  clearToast: () => void
}

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
  tgEnabled: false,
  tgRunning: false,
  accounts: loadAccounts(),
  tgAvailability: null,

  init: async () => {
    // 0. system 主题实时跟随系统配色
    watchSystemTheme(() => get().settings.theme)
    // 1. 订阅 SSE 实时进度
    subscribeEvents(
      (evt) => {
        const list = Array.isArray(evt.data) ? evt.data : [evt.data]
        if (list.length === 0) return
        set((s) => {
          const map = new Map(s.downloads.map((d) => [d.id, d]))
          for (const item of list) {
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
      },
      // SSE 连上 = 与 daemon 的通信真的通了 → alive 反推为 true（BUG-090，零新增请求）
      () => {
        set({ connected: true })
        get().setDaemonAlive(true)
      },
      () => set({ connected: false }),
    )
    // 2. 拉取当前列表
    await get().refresh()
    // 3. 拉取分类清单 + TG 插件开关状态（供侧边栏「全部文件」下钻与 TG 模块显隐）
    try {
      const cfg = await getConfig()
      const cats = Array.from(new Set(Object.values(cfg.classify_rules))).sort()
      set({
        categories: cats,
        tgEnabled: cfg.tg_enabled,
        tgRunning: cfg.tg_running,
      })
    } catch {
      // 配置不可达时静默：菜单暂不列出分类
    }
    // 4. 校准账号绑定态（orig-tg 会话）
    get().loadAccounts()
    await get().refreshTgSession().catch(() => {})
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
  remove: async (id) => {
    await apiRemoveDownload(id)
    await get().refresh()
  },

  /** 全部暂停（仅作用于下载中/排队中任务） */
  pauseAll: async () => {
    const targets = get().downloads.filter(
      (d) => d.status === 'downloading' || d.status === 'queued',
    )
    for (const d of targets) {
      await apiDownloadAction(d.id, 'pause').catch(() => {})
    }
    await get().refresh()
  },

  /** 全部开始（仅作用于已暂停任务） */
  resumeAll: async () => {
    const targets = get().downloads.filter((d) => d.status === 'paused')
    for (const d of targets) {
      await apiDownloadAction(d.id, 'resume').catch(() => {})
    }
    await get().refresh()
  },

  clearCompleted: async () => {
    const completed = get().downloads.filter(
      (d) => d.status === 'completed' || d.status === 'error' || d.status === 'cancelled',
    )
    for (const d of completed) {
      await apiRemoveDownload(d.id).catch(() => {})
    }
    await get().refresh()
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

  viewer: null,
  openViewer: (v) => set({ viewer: v }),
  setViewerIndex: (i) =>
    set((s) => (s.viewer ? { viewer: { ...s.viewer, index: i } } : s)),
  closeViewer: () => set({ viewer: null }),
  setCategoryFilter: (c) => set({ categoryFilter: c }),
  setPendingMediaFocus: (ref) => set({ pendingMediaFocus: ref }),

  /** 启停 TG 插件：写 daemon（拉起/终止 orig-tg 子服务），成功同步开关与运行态 */
  setTgEnabled: async (enabled) => {
    try {
      const res = await saveTgConfig({ enabled })
      set({ tgEnabled: res.tg_enabled, tgRunning: res.tg_running })
      return true
    } catch (e) {
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

  refreshTgSession: async () => {
    // 以 /session 的 phase 为唯一权威（不轮询，仅在启动/登录完成/进入 TG 界面时调用）。
    //
    // 「不可用/不可达」与「未登录」必须分开（BUG-023）：
    //   旧逻辑把「连不上 orig-tg」直接当成「未绑定」，于是依赖故障在界面上表现成
    //   「登录丢了」，用户会去重登，而真因是服务连不上。现在分成三态，故障**可见**：
    //     - ok：可用，按 phase 推导 bound
    //     - unavailable：orig-tg 活着但连不上 Telegram（后端给出原因），保留上次 bound
    //     - unreachable：连 orig-tg 进程都够不到，保留上次 bound
    //   后两种都**不清空**登录态——因为「不知道」不等于「没登录」。
    let session
    try {
      session = await getTgSession()
    } catch (e) {
      // 后台可用性探测失败（orig-tg 未运行 / 离线调试）：仅记录状态，不弹红色错误 toast——
      // 网页调试阶段 orig-tg 本就可能离线，弹「503 / fetch failed」会让调试环境变成错误环境。
      // 状态仍可见（侧栏据此隐藏 TG），故障并未被掩盖。
      set({ tgAvailability: { status: 'unreachable' } })
      return
    }
    if (session?.available === false) {
      set({
        tgAvailability: { status: 'unavailable', reason: session.reason ?? null },
      })
      return
    }
    set({ tgAvailability: { status: 'ok' } })
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
}))
