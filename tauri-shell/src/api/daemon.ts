import type {
  AddDownloadRequest,
  DownloadStatus,
  NetworkInterface,
} from '../types'

/** orig-daemon 起始端口（与 Rust 侧 DAEMON_PORT 一致；仅作**初值**） */
export const DAEMON_PORT = 19786

/**
 * daemon **实际**端口的初值。
 *
 * 为什么不再是常量（BUG-178）：daemon 落在 Windows 动态保留区时会自己顺延端口，
 * 硬编码 9876 就会连到一个不存在（或属于别人）的服务上。真源只有两个 ——
 * 桌面壳给的 `daemon_status().port`，或 daemon 自己回的 `/api/config` 的 `port`；
 * 这里的值只是首次请求之前的占位，随后立即被真源覆盖。
 */
const remoteDaemonUrl = (import.meta.env.VITE_DAEMON_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, '')

let daemonPort = Number(import.meta.env.VITE_DAEMON_PORT ?? DAEMON_PORT)

/** 用真源端口覆盖初值（桌面壳 / `/api/config` 各调一次，幂等） */
export function setDaemonPort(port: number) {
  if (Number.isFinite(port) && port > 0 && port !== daemonPort) daemonPort = port
}

/** daemon 基址（**每次现算**）。
 * - 设了 `VITE_DAEMON_URL` → 指向远程守护进程（容器/另一台机器），即远程管理模式。
 * - 否则回退桌面端 `http://127.0.0.1:<port>`。 */
export function daemonBase(): string {
  if (remoteDaemonUrl) return remoteDaemonUrl
  return `http://127.0.0.1:${daemonPort}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemonBase()}${path}`, {
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

/** GET /api/interfaces — 网卡列表（{primary, secondaries}，均已含 enabled/weight） */export async function listInterfaces(): Promise<{
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

/** daemon 配置（GET /api/config） */
export interface DaemonConfig {
  /** daemon 实际监听端口（可能与起始端口不同：保留区顺延，BUG-178）。真源。 */
  port?: number
  download_dir: string | null
  /** 系统默认下载目录（按 OS 解析：Windows 为 C:\Users\<user>\Downloads，非 ~/Downloads）。前端未显式设置时作占位/回退。 */
  default_download_dir: string
  max_connections: number
  classify_enabled: boolean
  /** 扩展名（小写，无点）→ 分类目录名（已合并内置默认 + 用户自定义） */
  classify_rules: Record<string, string>
  /** 代理配置：mode=direct|system|custom；url 仅 custom 模式有值 */
  proxy: {
    mode: 'direct' | 'system' | 'custom'
    url: string | null
  }
  /** TG 可选插件开关（daemon [tg] enabled）；false 时前端隐藏 TG 模块 */
  tg_enabled: boolean
  /** orig-tg 子服务是否实际在运行（daemon 探活） */
  tg_running: boolean
  /** orig-tg 实际监听端口（daemon 是唯一真源；可被 ORIG_TG_PORT 迁移，前端不得再猜 9877） */
  tg_port?: number
  /**
   * 最近一次拉起/自愈失败的原因（null = 最近一次成功）。
   * 服务不可用时侧栏没有 TG 入口，原因必须摆在设置页开关旁，否则用户只会以为功能没了。
   */
  tg_last_error?: string | null
}

/** 代理配置（HTTP 下载） */
export interface ProxyConfig {
  mode: 'direct' | 'system' | 'custom'
  url?: string | null
}

/** GET /api/config — 读取 daemon 配置 */
export function getConfig(): Promise<DaemonConfig> {
  return request<DaemonConfig>('/api/config')
}

/** PUT /api/config/proxy — 保存代理配置（运行时生效 + 持久化） */
export function saveProxyConfig(req: ProxyConfig): Promise<{
  ok: boolean
  proxy: { mode: string; url: string | null }
}> {
  return request('/api/config/proxy', {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

/** POST /api/proxy/verify — 验证代理连通性（对 api.telegram.org 探测），返回耗时与状态 */
export function verifyProxy(req: {
  mode: string
  url?: string | null
}): Promise<{ ok: boolean; latency_ms: number; status: number; target: string }> {
  return request('/api/proxy/verify', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

/** PUT /api/config/classify — 保存自动分类规则（运行时生效 + 持久化） */
export function saveClassifyConfig(req: {
  enabled: boolean
  rules: Record<string, string>
}): Promise<{ ok: boolean; classify_enabled: boolean; classify_rules: Record<string, string> }> {
  return request('/api/config/classify', {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

/** PUT /api/config/tg — 启停 TG 可选插件（运行时生效 + 持久化；同时拉起/终止 orig-tg 子服务） */
export function saveTgConfig(req: {
  enabled: boolean
}): Promise<{
  ok: boolean
  tg_enabled: boolean
  tg_running: boolean
  tg_port?: number
  tg_last_error?: string | null
}> {
  return request('/api/config/tg', {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

/**
 * POST /api/tg/restart — 请 daemon 重启它托管的 orig-tg（**daemon 是唯一执行者**）。
 *
 * 为什么前端还要留这个口（BUG-178）：凭证保存 / 网络修好后必须重启 orig-tg 才生效
 * （它只在启动时连一次 Telegram）。但动作是 daemon 执行的 —— 前端只是**请求**，
 * 不再自己 spawn/kill 进程，也不再让用户去点「启动服务」。
 */
export function restartTgService(): Promise<{
  ok: boolean
  tg_enabled: boolean
  tg_running: boolean
  tg_port?: number
  tg_last_error?: string | null
}> {
  return request('/api/tg/restart', { method: 'POST', body: '{}' })
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
    es = new EventSource(`${daemonBase()}/api/events`)
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
