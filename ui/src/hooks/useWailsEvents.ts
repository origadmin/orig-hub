import { useEffect } from 'react'
import { EventsOn, EventsOff } from 'wailsjs/runtime/runtime.js'
import { AddDownload, PauseDownload, ResumeDownload, CancelDownload, ListDownloads, GetDownloadHistory } from 'wailsjs/go/main/App.js'
import { useStore } from '../store/useStore'
import { DownloadStatus, DownloadStatusValue, DownloadEntry } from '../types'

export function useWailsEvents() {
  const { updateDownloads, updateDownload, removeDownload } = useStore()

  useEffect(() => {
    EventsOn('download:status', (rawStatuses: Record<string, unknown>[]) => {
      const statuses: DownloadStatus[] = rawStatuses.map((s: Record<string, unknown>) => ({
        ...s,
        status: s.status as DownloadStatusValue,
      }))
      updateDownloads(statuses)
    })

    EventsOn('download:added', (id: string) => {
      console.log('Download added:', id)
    })

    EventsOn('download:paused', (id: string) => {
      updateDownload(id, { status: 'paused' })
    })

    EventsOn('download:resumed', (id: string) => {
      updateDownload(id, { status: 'downloading' })
    })

    EventsOn('download:cancelled', (id: string) => {
      removeDownload(id)
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
  const handleAddDownload = async (url: string, outputPath: string, filename: string, mirrors: string[] = [], headers: Record<string, string> = {}) => {
    try {
      const id = await AddDownload(url, outputPath, filename, mirrors, headers)
      return id
    } catch (err) {
      console.error('Failed to add download:', err)
      throw err
    }
  }

  const handlePauseDownload = async (id: string) => {
    try {
      await PauseDownload(id)
    } catch (err) {
      console.error('Failed to pause download:', err)
    }
  }

  const handleResumeDownload = async (id: string) => {
    try {
      await ResumeDownload(id)
    } catch (err) {
      console.error('Failed to resume download:', err)
    }
  }

  const handleCancelDownload = async (id: string) => {
    try {
      await CancelDownload(id)
    } catch (err) {
      console.error('Failed to cancel download:', err)
    }
  }

  const handleListDownloads = async (): Promise<DownloadStatus[]> => {
    try {
      const raw = await ListDownloads()
      return (raw || []).map((s: Record<string, unknown>) => ({
        ...s,
        status: s.status as DownloadStatusValue,
      }))
    } catch (err) {
      console.error('Failed to list downloads:', err)
      return []
    }
  }

  const handleGetHistory = async (): Promise<DownloadEntry[]> => {
    try {
      const raw = await GetDownloadHistory()
      return (raw || []).map((e: Record<string, unknown>) => ({
        ...e,
        mirrors: (e.mirrors as string[]) || [],
      }))
    } catch (err) {
      console.error('Failed to get history:', err)
      return []
    }
  }

  return {
    addDownload: handleAddDownload,
    pauseDownload: handlePauseDownload,
    resumeDownload: handleResumeDownload,
    cancelDownload: handleCancelDownload,
    listDownloads: handleListDownloads,
    getHistory: handleGetHistory,
  }
}
