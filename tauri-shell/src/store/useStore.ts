import { create } from 'zustand'
import type { AppSettings, DaemonStatus, DownloadStatus } from '../types'
import {
  addDownload as apiAddDownload,
  downloadAction as apiDownloadAction,
  listDownloads,
  listInterfaces,
  removeDownload as apiRemoveDownload,
  subscribeEvents,
} from '../api/daemon'
import type { AddDownloadRequest } from '../types'

const SETTINGS_KEY = 'orig-hub:settings'

/** 读取持久化设置（localStorage）；不存在时返回默认值 */
function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    maxConnections: 8,
    downloadDirectory: '',
    autoStart: true,
    notifications: true,
    theme: 'dark',
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
}

export const useStore = create<DownloadState>((set, get) => ({
  downloads: [],
  daemon: null,
  settings: loadSettings(),
  connected: false,
  loading: false,
  error: null,

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
                hash_sha256: item.hash_sha256 ?? cur?.hash_sha256,
              } as DownloadStatus)
            } else if (evt.event === 'error') {
              const cur = map.get(item.id)
              const errItem = item as unknown as { id: string; message?: string }
              map.set(item.id, {
                ...(cur ?? {}),
                id: item.id,
                status: 'error',
                error: errItem.message ?? cur?.error,
              } as DownloadStatus)
            } else if (evt.event === 'paused') {
              const cur = map.get(item.id)
              map.set(item.id, { ...(cur ?? {}), id: item.id, status: 'paused' } as DownloadStatus)
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

  setError: (e) => set({ error: e }),
}))
