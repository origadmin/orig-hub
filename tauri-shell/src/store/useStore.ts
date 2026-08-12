import { create } from 'zustand'
import type { AppSettings, DaemonStatus, DownloadStatus } from '../types'
import {
  addDownload as apiAddDownload,
  downloadAction as apiDownloadAction,
  listDownloads,
  removeDownload as apiRemoveDownload,
  subscribeEvents,
} from '../api/daemon'
import type { AddDownloadRequest } from '../types'

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
  clearCompleted: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => void
  setError: (e: string | null) => void
}

export const useStore = create<DownloadState>((set, get) => ({
  downloads: [],
  daemon: null,
  settings: {
    maxConnections: 8,
    downloadDirectory: '',
    autoStart: true,
    notifications: true,
    theme: 'dark',
  },
  connected: false,
  loading: false,
  error: null,

  init: async () => {
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
    set((s) => ({ settings: { ...s.settings, ...patch } })),

  setError: (e) => set({ error: e }),
}))
