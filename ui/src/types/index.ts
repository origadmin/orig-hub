export type DownloadStatusValue = 'queued' | 'downloading' | 'paused' | 'completed' | 'cancelled' | 'error'

export interface DownloadStatus {
  id: string
  url: string
  filename: string
  dest_path: string
  total_size: number
  downloaded: number
  progress: number
  speed: number
  status: DownloadStatusValue
  error: string
  eta: number
  connections: number
  added_at: number
  time_taken: number
  avg_speed: number
}

export interface DownloadEntry {
  id: string
  url_hash: string
  url: string
  dest_path: string
  filename: string
  status: string
  total_size: number
  downloaded: number
  completed_at: number
  time_taken: number
  avg_speed: number
  mirrors: string[]
}

export type ThemeValue = 'light' | 'dark' | 'system'

export interface AppSettings {
  maxConnections: number
  downloadDirectory: string
  autoStart: boolean
  notifications: boolean
  theme: ThemeValue
}
