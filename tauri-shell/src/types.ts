/** 与 Rust daemon DownloadStatus 对齐的下载状态 */
export type DownloadStatusValue =
  | 'idle'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface DownloadStatus {
  id: string
  url: string
  filename: string
  dest_path?: string
  total_size: number
  downloaded: number
  progress: number
  speed: number
  status: DownloadStatusValue
  error?: string
  eta: number
  connections: number
  added_at: number
  time_taken: number
  avg_speed: number
  /** SSE Completed 事件附加 */
  hash_sha256?: string
}

export interface NetworkInterface {
  name: string
  /** Windows 友好名（如 Intel(R) Ethernet Connection），非 Windows 为 null */
  description?: string | null
  /** 主 IPv4；未连接/无地址为 null */
  ip: string | null
  is_default: boolean
  /** 是否已连接（有 IP 且 up）——只有 connected 才能参与加速 */
  connected: boolean
  /** 虚拟网卡（Hyper-V/WSL/隧道/Wi-Fi Direct） */
  is_virtual: boolean
  /** 是否在默认参与池（主网卡 true） */
  enabled: boolean
  /** 权重（≥1，默认 1） */
  weight: number
}

/** daemon AddReq.interfaces 契约：{primary_weight?, secondaries: {网卡名: 权重}} */
export interface InterfaceSpec {
  primary_weight?: number
  secondaries?: Record<string, number>
}

export interface AddDownloadRequest {
  url: string
  filename?: string
  output_path?: string
  headers?: Record<string, string>
  interfaces?: InterfaceSpec
  max_connections?: number
}

export interface DaemonStatus {
  alive: boolean
  port: number
  managed: boolean
}

export type ThemeValue = 'dark' | 'light' | 'system'

export interface AppSettings {
  maxConnections: number
  downloadDirectory: string
  autoStart: boolean
  notifications: boolean
  theme: ThemeValue
}
