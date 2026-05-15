import { useEffect, useCallback } from 'react'
import { EventsOn, EventsOff } from 'wailsjs/runtime/runtime.js'
import { AddDownload, PauseDownload, ResumeDownload, CancelDownload, RemoveDownload, ListDownloads, GetDownloadHistory, GetDefaultDownloadDir, OpenDirectoryDialog, SaveSettings } from 'wailsjs/go/main/App.js'
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

export function useWailsEvents() {
  const { updateDownloads, updateDownload, removeDownload } = useStore()

  useEffect(() => {
    EventsOn('download:status', (...args: unknown[]) => {
      const rawStatuses = args[0] as Record<string, unknown>[]
      if (!Array.isArray(rawStatuses)) return
      const statuses: DownloadStatus[] = rawStatuses.map(toDownloadStatus)
      updateDownloads(statuses)
    })

    EventsOn('download:added', (_id: unknown) => {
      ListDownloads().then((raw) => {
        if (raw && raw.length > 0) {
          updateDownloads(raw.map(toDownloadStatus))
        }
      })
    })

    EventsOn('download:paused', (id: unknown) => {
      updateDownload(String(id), { status: 'paused' })
    })

    EventsOn('download:resumed', (id: unknown) => {
      updateDownload(String(id), { status: 'downloading' })
    })

    EventsOn('download:cancelled', (id: unknown) => {
      updateDownload(String(id), { status: 'cancelled' })
    })

    return () => {
      EventsOff('download:status')
      EventsOff('download:added')
      EventsOff('download:paused')
      EventsOff('download:resumed')
      EventsOff('download:cancelled')
    }
  }, [updateDownloads, updateDownload, removeDownload])
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
    const raw = await ListDownloads()
    if (!raw) return []
    return raw.map(toDownloadStatus)
  }, [])

  const handleGetHistory = useCallback(async (): Promise<DownloadEntry[]> => {
    const raw = await GetDownloadHistory()
    if (!raw) return []
    return raw.map(toDownloadEntry)
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
  }
}
