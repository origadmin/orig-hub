import { useEffect, useCallback, useRef } from 'react'
import { Events } from '@wailsio/runtime'
import { AddDownload, PauseDownload, ResumeDownload, CancelDownload, RemoveDownload, ListDownloads, GetDownloadHistory, GetDefaultDownloadDir, OpenDirectoryDialog, SaveSettings } from '../../bindings/github.com/origadmin/orig-hub/internal/app/downloadservice'
import { EnterFloatingMode, RestoreFromFloating, SetFloatingBarEnabled } from '../../bindings/github.com/origadmin/orig-hub/internal/app/guicontroller'
import { useStore } from '../store/useStore'
import { DownloadStatus, DownloadStatusValue, DownloadEntry } from '../types'

function toDownloadStatus(raw: Record<string, unknown>): DownloadStatus {
  return {
    id: String(raw.id ?? ''),
    url: String(raw.url ?? ''),
    filename: String(raw.filename ?? ''),
    dest_path: String(raw.dest_path ?? ''),
    total_size: Number(raw.total_size ?? 0),
    downloaded: Number(raw.downloaded ?? 0),
    progress: Number(raw.progress ?? 0),
    speed: Number(raw.speed ?? 0),
    status: String(raw.status ?? 'queued') as DownloadStatusValue,
    error: String(raw.error ?? ''),
    eta: Number(raw.eta ?? 0),
    connections: Number(raw.connections ?? 0),
    added_at: Number(raw.added_at ?? 0),
    time_taken: Number(raw.time_taken ?? 0),
    avg_speed: Number(raw.avg_speed ?? 0),
  }
}

function toDownloadEntry(raw: Record<string, unknown>): DownloadEntry {
  return {
    id: String(raw.id ?? ''),
    url_hash: String(raw.url_hash ?? ''),
    url: String(raw.url ?? ''),
    dest_path: String(raw.dest_path ?? ''),
    filename: String(raw.filename ?? ''),
    status: String(raw.status ?? ''),
    total_size: Number(raw.total_size ?? 0),
    downloaded: Number(raw.downloaded ?? 0),
    completed_at: Number(raw.completed_at ?? 0),
    time_taken: Number(raw.time_taken ?? 0),
    avg_speed: Number(raw.avg_speed ?? 0),
    mirrors: Array.isArray(raw.mirrors) ? raw.mirrors as string[] : [],
  }
}

let backendAvailable: boolean | null = null

async function checkBackend(): Promise<boolean> {
  if (backendAvailable !== null) return backendAvailable
  try {
    await ListDownloads()
    backendAvailable = true
    return true
  } catch {
    backendAvailable = false
    return false
  }
}

export function useWailsEvents() {
  const { updateDownloads, updateDownload } = useStore()

  useEffect(() => {
    const off1 = Events.On('download:status', (statuses: unknown) => {
      let rawStatuses: unknown[]
      if (Array.isArray(statuses)) {
        rawStatuses = statuses
      } else if (statuses && typeof statuses === 'object') {
        const arr = Object.values(statuses as Record<string, unknown>)
        if (arr.length > 0 && Array.isArray(arr[0])) {
          rawStatuses = arr[0] as unknown[]
        } else {
          rawStatuses = [statuses]
        }
      } else {
        return
      }
      if (!Array.isArray(rawStatuses)) return
      const list: DownloadStatus[] = rawStatuses.map((item) => {
        if (item && typeof item === 'object') {
          return toDownloadStatus(item as Record<string, unknown>)
        }
        return null
      }).filter((item): item is DownloadStatus => item !== null)
      if (list.length > 0) {
        updateDownloads(list)
      }
    })

    const off2 = Events.On('download:added', () => {
      ListDownloads().then((list) => {
        if (list && list.length > 0) {
          updateDownloads(list)
        }
      }).catch(() => {})
    })

    const off3 = Events.On('download:paused', (id: unknown) => {
      updateDownload(String(id), { status: 'paused' })
    })

    const off4 = Events.On('download:resumed', (id: unknown) => {
      updateDownload(String(id), { status: 'downloading' })
    })

    const off5 = Events.On('download:cancelled', (id: unknown) => {
      updateDownload(String(id), { status: 'cancelled' })
    })

    // download:progress: 高频进度事件 (每下载 64KB 一次)
    const off6 = Events.On('download:progress', (evt: unknown) => {
      if (!evt || typeof evt !== 'object') return
      const e = evt as Record<string, unknown>
      const id = String(e.id ?? '')
      if (!id) return
      const downloaded = Number(e.downloaded ?? 0)
      const total_size = Number(e.total_size ?? 0)
      const speed = Number(e.speed ?? 0)
      const progress = Number(e.progress ?? 0)
      updateDownload(id, { downloaded, total_size, speed, progress })
    })

    // download:state: 状态变更事件 (后端 OnStateChanged emit)
    const off7 = Events.On('download:state', (evt: unknown) => {
      if (!evt || typeof evt !== 'object') return
      const e = evt as Record<string, unknown>
      const id = String(e.id ?? '')
      const state = String(e.state ?? '')
      if (!id || !state) return
      updateDownload(id, { status: state as DownloadStatusValue })
    })

    return () => {
      off1()
      off2()
      off3()
      off4()
      off5()
      off6()
      off7()
    }
  }, [updateDownloads, updateDownload])
}

export function useDownloadPolling() {
  const updateDownloads = useStore((s) => s.updateDownloads)
  const enableMockData = useStore((s) => s.enableMockData)
  const useMockData = useStore((s) => s.useMockData)
  const tickMockDownloads = useStore((s) => s.tickMockDownloads)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const poll = async () => {
      try {
        const list = await ListDownloads()
        backendAvailable = true
        if (list && list.length > 0) {
          updateDownloads(list)
        } else if (!useMockData) {
          // 后端可达但无任务: 不 mock, 让 UI 显示空状态
          updateDownloads([])
        }
      } catch {
        // 后端不可达: fallback 到 mock (仅作为离线开发预览)
        if (!useMockData) {
          enableMockData()
        }
      }
    }

    timerRef.current = setInterval(poll, 2000)
    poll()

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }
  }, [updateDownloads, enableMockData, useMockData])

  useEffect(() => {
    if (useMockData) {
      mockTimerRef.current = setInterval(() => {
        tickMockDownloads()
      }, 1000)
    } else {
      if (mockTimerRef.current) {
        clearInterval(mockTimerRef.current)
        mockTimerRef.current = null
      }
    }
    return () => {
      if (mockTimerRef.current) {
        clearInterval(mockTimerRef.current)
      }
    }
  }, [useMockData, tickMockDownloads])
}

export function useWailsActions() {
  const handleAddDownload = useCallback(async (url: string, outputPath: string, filename: string, mirrors: string[] = [], headers: Record<string, string> = {}): Promise<string> => {
    const id = await AddDownload(url, outputPath, filename, mirrors, headers)
    return id
  }, [])

  const handlePauseDownload = useCallback(async (id: string): Promise<void> => {
    await PauseDownload(id)
  }, [])

  const handleResumeDownload = useCallback(async (id: string): Promise<void> => {
    await ResumeDownload(id)
  }, [])

  const handleCancelDownload = useCallback(async (id: string): Promise<void> => {
    await CancelDownload(id)
  }, [])

  const handleRemoveDownload = useCallback(async (id: string): Promise<void> => {
    await RemoveDownload(id)
  }, [])

  const handleListDownloads = useCallback(async (): Promise<DownloadStatus[]> => {
    const list = await ListDownloads()
    if (!list) return []
    return list
  }, [])

  const handleGetHistory = useCallback(async (): Promise<DownloadEntry[]> => {
    const list = await GetDownloadHistory()
    if (!list) return []
    return list
  }, [])

  const handleGetDefaultDownloadDir = useCallback(async (): Promise<string> => {
    return await GetDefaultDownloadDir()
  }, [])

  const handleOpenDirectoryDialog = useCallback(async (title: string): Promise<string> => {
    const dir = await OpenDirectoryDialog(title)
    return dir || ''
  }, [])

  const handleSaveSettings = useCallback(async (outputDir: string, maxConnections: number): Promise<void> => {
    await SaveSettings(outputDir, maxConnections)
  }, [])

  const handleEnterFloatingMode = useCallback(async (): Promise<void> => {
    await EnterFloatingMode()
  }, [])

  const handleRestoreFromFloating = useCallback(async (): Promise<void> => {
    await RestoreFromFloating()
  }, [])

  const handleSetFloatingBarEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    await SetFloatingBarEnabled(enabled)
  }, [])

  return {
    addDownload: handleAddDownload,
    pauseDownload: handlePauseDownload,
    resumeDownload: handleResumeDownload,
    cancelDownload: handleCancelDownload,
    removeDownload: handleRemoveDownload,
    listDownloads: handleListDownloads,
    getHistory: handleGetHistory,
    getDefaultDownloadDir: handleGetDefaultDownloadDir,
    openDirectoryDialog: handleOpenDirectoryDialog,
    saveSettings: handleSaveSettings,
    enterFloatingMode: handleEnterFloatingMode,
    restoreFromFloating: handleRestoreFromFloating,
    setFloatingBarEnabled: handleSetFloatingBarEnabled,
  }
}
