import { create } from 'zustand'
import type {
  AccountsState,
  AppSettings,
  DaemonStatus,
  DownloadStatus,
  LanguageValue,
  TgAccount,
} from '../types'
import {
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
import type { AddDownloadRequest } from '../types'

const SETTINGS_KEY = 'orig-hub:settings'
const ACCOUNTS_KEY = 'orig-hub:accounts'

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
  /** 自动分类清单（daemon classify_rules 的去重分类名，如 Videos/Music/...）；供侧边栏「全部文件」下钻 */
  categories: string[]
  /** 当前选中的分类筛选（null = 不过滤）；与 view 配合用于「全部文件」下钻 */
  categoryFilter: string | null
  setCategoryFilter: (c: string | null) => void

  /** TG 可选插件开关（daemon [tg] enabled）；false 时侧边栏隐藏 TG 模块 */
  tgEnabled: boolean
  /** orig-tg 子服务是否实际在运行（daemon 探活） */
  tgRunning: boolean
  /** 启停 TG 插件：写 daemon（运行时生效+持久化），同步 tgEnabled/tgRunning */
  setTgEnabled: (enabled: boolean) => Promise<boolean>

  /** 账号绑定中心状态（当前仅 Telegram，后续可扩展其他账号） */
  accounts: AccountsState
  loadAccounts: () => void
  /** 更新某个账户的绑定态（持久化到 localStorage） */
  setTgAccount: (patch: Partial<TgAccount>) => void
  /** 校准 TG 绑定态：向 orig-tg 查询会话 phase==='Authorized'（失败静默） */
  refreshTgSession: () => Promise<void>

  init: () => Promise<void>
  refresh: () => Promise<void>
  setDaemon: (d: DaemonStatus) => void
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
  tgEnabled: false,
  tgRunning: false,
  accounts: loadAccounts(),

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
      () => set({ connected: true }),
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
      set({ downloads, loading: false, error: null })
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  },

  setDaemon: (d) => set({ daemon: d }),

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
  setCategoryFilter: (c) => set({ categoryFilter: c }),

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
    // 以后端 /session 的 phase 为唯一权威（不轮询，仅在启动/登录完成/进入 TG 界面时调用）。
    // 未登录或服务不可达一律视为未绑定，杜绝本地 bound 残留导致的“已绑定却未登录”。
    let session
    try {
      session = await getTgSession()
    } catch {
      // 服务不可达（orig-tg 未运行）时无法确认登录，视为未绑定
      if (get().accounts.tg.bound) get().setTgAccount({ bound: false, phone: null })
      return
    }
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
