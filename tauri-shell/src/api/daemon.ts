import type {
  AddDownloadRequest,
  DownloadStatus,
  NetworkInterface,
} from '../types'

/** surge-daemon 默认端口（与 Rust 侧 DAEMON_PORT 一致） */
export const DAEMON_PORT = 9876

/** 开发模式下 daemon 可能不在 9876（可被环境变量覆盖） */
const port = Number(
  import.meta.env.VITE_DAEMON_PORT ?? DAEMON_PORT,
)

export const DAEMON_BASE = `http://127.0.0.1:${port}`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** GET /api/downloads */
export function listDownloads(): Promise<DownloadStatus[]> {
  return request('/api/downloads')
}

/** GET /api/downloads/:id */
export function getDownload(id: string): Promise<DownloadStatus> {
  return request(`/api/downloads/${encodeURIComponent(id)}`)
}

/** POST /api/downloads — 新增下载任务（返回 {id}，非完整状态） */
export function addDownload(req: AddDownloadRequest): Promise<{ id: string }> {
  return request('/api/downloads', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

/** POST /api/downloads/:id?action=pause|resume|cancel */
export function downloadAction(
  id: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<DownloadStatus> {
  return request(
    `/api/downloads/${encodeURIComponent(id)}?action=${action}`,
    { method: 'POST' },
  )
}

/** DELETE /api/downloads/:id — 删除任务（含磁盘文件？由 daemon 决定） */
export function removeDownload(id: string): Promise<void> {
  return request(`/api/downloads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/** GET /api/interfaces — 网卡列表（{primary, secondaries}，均已含 enabled/weight） */
export async function listInterfaces(): Promise<{
  primary: NetworkInterface
  secondaries: NetworkInterface[]
}> {
  const raw = await request<unknown>('/api/interfaces')
  if (Array.isArray(raw)) {
    // 兼容旧返回（数组）
    const arr = raw as NetworkInterface[]
    return {
      primary: arr[0],
      secondaries: arr.slice(1),
    }
  }
  return raw as { primary: NetworkInterface; secondaries: NetworkInterface[] }
}

/** GET /health */
export function health(): Promise<{ status: string }> {
  return request('/health')
}

/**
 * 订阅 SSE 事件流（下载进度 / 状态变更）。
 * 返回取消函数；连接断开自动重连（指数退避，最长 10s）。
 */
export function subscribeEvents(
  onEvent: (evt: { event: string; data: DownloadStatus | DownloadStatus[] }) => void,
  onOpen?: () => void,
  onError?: (err: Error) => void,
): () => void {
  let closed = false
  let retryMs = 1000
  let es: EventSource | null = null

  // daemon 发送的是命名事件：progress/completed/error/paused/resumed/deleted
  const EVENT_NAMES = ['progress', 'completed', 'error', 'paused', 'resumed', 'deleted'] as const

  const handle = (event: string) => (msg: MessageEvent) => {
    try {
      const data = JSON.parse(msg.data as string) as DownloadStatus | DownloadStatus[]
      onEvent({ event, data })
    } catch {
      // 忽略无法解析的消息
    }
  }

  const connect = () => {
    if (closed) return
    es = new EventSource(`${DAEMON_BASE}/api/events`)
    es.onopen = () => {
      retryMs = 1000
      onOpen?.()
    }
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, handle(name))
    }
    es.onerror = () => {
      es?.close()
      es = null
      if (!closed) {
        onError?.(new Error('SSE connection lost'))
        setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, 10000)
      }
    }
  }

  connect()
  return () => {
    closed = true
    es?.close()
  }
}
