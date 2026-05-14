import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DownloadStatus } from '../types'

let mockDownloads: DownloadStatus[] = [
  {
    id: '1',
    url: 'https://example.com/file1.zip',
    filename: 'file1.zip',
    dest_path: '',
    total_size: 104857600,
    downloaded: 47185920,
    progress: 45,
    speed: 2621440,
    status: 'downloading',
    error: '',
    eta: 22,
    connections: 4,
    added_at: Date.now() - 60000,
    time_taken: 60,
    avg_speed: 2457600,
  },
  {
    id: '2',
    url: 'https://example.com/file2.zip',
    filename: 'file2.zip',
    dest_path: '',
    total_size: 52428800,
    downloaded: 52428800,
    progress: 100,
    speed: 0,
    status: 'completed',
    error: '',
    eta: 0,
    connections: 0,
    added_at: Date.now() - 120000,
    time_taken: 45,
    avg_speed: 1165084,
  },
]

export function useDownloads() {
  const queryClient = useQueryClient()

  const downloadsQuery = useQuery({
    queryKey: ['downloads'],
    queryFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return mockDownloads
    },
  })

  const addDownloadMutation = useMutation({
    mutationFn: async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const newDownload: DownloadStatus = {
        id: Date.now().toString(),
        url,
        filename: url.split('/').pop() || 'download',
        dest_path: '',
        total_size: 0,
        downloaded: 0,
        progress: 0,
        speed: 0,
        status: 'queued',
        error: '',
        eta: 0,
        connections: 0,
        added_at: Date.now(),
        time_taken: 0,
        avg_speed: 0,
      }
      mockDownloads = [...mockDownloads, newDownload]
      return newDownload
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['downloads'] })
    },
  })

  const pauseDownloadMutation = useMutation({
    mutationFn: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      mockDownloads = mockDownloads.map((d) =>
        d.id === id ? { ...d, status: 'paused' } : d
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['downloads'] })
    },
  })

  const resumeDownloadMutation = useMutation({
    mutationFn: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      mockDownloads = mockDownloads.map((d) =>
        d.id === id ? { ...d, status: 'downloading' } : d
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['downloads'] })
    },
  })

  const cancelDownloadMutation = useMutation({
    mutationFn: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      mockDownloads = mockDownloads.map((d) =>
        d.id === id ? { ...d, status: 'cancelled' } : d
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['downloads'] })
    },
  })

  return {
    downloads: downloadsQuery.data || [],
    isLoading: downloadsQuery.isLoading,
    addDownload: addDownloadMutation.mutate,
    pauseDownload: pauseDownloadMutation.mutate,
    resumeDownload: resumeDownloadMutation.mutate,
    cancelDownload: cancelDownloadMutation.mutate,
  }
}
