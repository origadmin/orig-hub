import type {
  TgCacheTask,
  TgChannel,
  TgDiag,
  TgFolder,
  TgMediaItem,
  TgMessagePage,
  TgMonitoredChannel,
  TgSession,
  TgStoredItem,
  TgStoredMessage,
} from '../types'

/** orig-tg 默认端口（与 Rust 侧 orig-tg 监听端口一致，独立于 daemon 的 9876） */
export const TG_PORT = 9877

/** 开发模式下 orig-tg 可能不在 9877（可被环境变量覆盖，仅用于本地调试） */
const port = Number(import.meta.env.VITE_TG_PORT ?? TG_PORT)

export const TG_BASE = `http://127.0.0.1:${port}`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${TG_BASE}${path}`, {
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

/** GET /health — orig-tg 健康探活 */
export function tgHealth(): Promise<{ status: string }> {
  return request('/health')
}

/** GET /api/tg/session — 登录阶段快照 */
export function getTgSession(): Promise<TgSession> {
  return request('/api/tg/session')
}

/** POST /api/tg/start — 发送验证码到指定手机号（E.164，如 +8613912345678） */
export function startTgLogin(phone: string): Promise<void> {
  return request('/api/tg/start', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  })
}

/** POST /api/tg/code — 提交验证码或 2FA 密码（orig-tg 复用同一端点）
 *  phone 必须与 start 时使用的 E.164 完全一致；step 字段区分 code 阶段。 */
export function submitTgCode(phone: string, codeOrPassword: string): Promise<TgSession> {
  return request('/api/tg/code', {
    method: 'POST',
    body: JSON.stringify({ phone, code: codeOrPassword }),
  })
}

/** POST /api/tg/password — 两步验证密码阶段（需传入之前 start 用的 phone） */
export function submitTgPassword(phone: string, password: string): Promise<TgSession> {
  return request('/api/tg/code', {
    method: 'POST',
    body: JSON.stringify({ phone, password }),
  })
}

/** GET /api/tg/diag — 运行诊断快照（端口/客户端真实度/代理/会话阶段/api 凭证） */
export function tgDiag(): Promise<TgDiag> {
  return request('/api/tg/diag')
}

/** GET /api/tg/logs?lines=N — 最近 N 条诊断日志（新→旧） */
export function tgLogs(lines = 50): Promise<string[]> {
  return request(`/api/tg/logs?lines=${lines}`)
}

/** 分页枚举结果（GET /api/tg/dialogs，v0.4.0 缓存优先 + 后台扫描） */
export interface TgDialogsPage {
  items: TgChannel[]
  total: number
  hasMore: boolean
  /** 后台是否正在全量扫描会话缓存（true 时前端可轮询） */
  scanning?: boolean
}

/** GET /api/tg/dialogs?limit=&offset=&refresh= — 订阅频道（缓存优先，需已授权）。
 * v0.4.0：永远先读本地缓存分页；缓存空/refresh 时后台全量扫描，扫描中 scanning=true。
 * 兼容旧版平铺数组返回。 */
export async function listTgDialogs(opts?: {
  limit?: number
  offset?: number
  refresh?: boolean
}): Promise<TgDialogsPage> {
  const q = new URLSearchParams()
  q.set('limit', String(opts?.limit ?? 200))
  if (opts?.offset) q.set('offset', String(opts.offset))
  if (opts?.refresh) q.set('refresh', '1')
  const res = await request<unknown>(`/api/tg/dialogs?${q}`)
  if (Array.isArray(res)) {
    // 兼容旧返回（平铺数组）
    return { items: res as TgChannel[], total: res.length, hasMore: false, scanning: false }
  }
  const page = res as Partial<TgDialogsPage>
  return {
    items: Array.isArray(page.items) ? page.items : [],
    total: Number(page.total) || 0,
    hasMore: Boolean(page.hasMore),
    scanning: Boolean(page.scanning),
  }
}

/** GET /api/tg/folders — 用户自定义分组（需已授权） */
export function listTgFolders(): Promise<TgFolder[]> {
  return request('/api/tg/folders')
}

/** GET /api/tg/monitor/channels — 被监控频道列表 */
export function listTgMonitoredChannels(): Promise<TgMonitoredChannel[]> {
  return request('/api/tg/monitor/channels')
}

/** POST /api/tg/monitor/channels — 添加频道到监控（幂等） */
export function addTgMonitoredChannel(ch: {
  channelId: number
  title: string
  username?: string
}): Promise<{ ok: boolean }> {
  return request('/api/tg/monitor/channels', {
    method: 'POST',
    body: JSON.stringify(ch),
  })
}

/** DELETE /api/tg/monitor/channels/:id — 移除监控频道（保留已入库消息） */
export function removeTgMonitoredChannel(channelId: number | string): Promise<{ ok: boolean }> {
  return request(
    `/api/tg/monitor/channels/${encodeURIComponent(String(channelId))}`,
    { method: 'DELETE' },
  )
}

/** GET /api/tg/monitor/messages?channelId=..&limit=..&beforeId=..
 *  本地真列表（新→旧）：本地不足一页时后端向 TG 回补并入库；网络失败降级只回本地。
 *  beforeId 为历史游标（exclusive）：只取 messageId < beforeId 的一页。兼容旧平铺数组。 */
export async function listTgMonitorMessages(
  channelId: number | string,
  opts?: { limit?: number; beforeId?: number },
): Promise<TgMessagePage<TgStoredMessage>> {
  const limit = opts?.limit ?? 30
  const q = new URLSearchParams({
    channelId: String(channelId),
    limit: String(limit),
  })
  if (opts?.beforeId !== undefined) q.set('beforeId', String(opts.beforeId))
  const res = await request<unknown>(`/api/tg/monitor/messages?${q}`)
  if (Array.isArray(res)) {
    return { items: res as TgStoredMessage[], hasMore: res.length >= limit }
  }
  const page = res as Partial<TgMessagePage<TgStoredMessage>>
  return {
    items: Array.isArray(page.items) ? page.items : [],
    hasMore: Boolean(page.hasMore),
  }
}

/** POST /api/tg/monitor/sync — 手动触发一轮增量同步 */
export function syncTgMonitor(): Promise<{ added: number }> {
  return request('/api/tg/monitor/sync', { method: 'POST' })
}

/** GET /api/tg/messages/:chat_id?limit=&beforeId= — 在线媒体历史（新→旧，需已授权）。
 *  v0.4.0：后端只返回媒体消息并支持 beforeId 历史游标翻页。兼容旧平铺数组。 */
export async function listTgMessages(
  chatId: number | string,
  opts?: { limit?: number; beforeId?: number },
): Promise<TgMessagePage<TgMediaItem>> {
  const limit = opts?.limit ?? 30
  const q = new URLSearchParams({ limit: String(limit) })
  if (opts?.beforeId !== undefined) q.set('beforeId', String(opts.beforeId))
  const res = await request<unknown>(
    `/api/tg/messages/${encodeURIComponent(String(chatId))}?${q}`,
  )
  if (Array.isArray(res)) {
    return { items: res as TgMediaItem[], hasMore: res.length >= limit }
  }
  const page = res as Partial<TgMessagePage<TgMediaItem>>
  return {
    items: Array.isArray(page.items) ? page.items : [],
    hasMore: Boolean(page.hasMore),
  }
}

/** POST /api/tg/download/:chat_id/:message_id — 下载媒体到本地（需已授权） */
export function downloadTgMessage(
  chatId: number | string,
  messageId: number | string,
  dir?: string,
): Promise<{ messageId: number; path: string; bytes: number }> {
  return request(`/api/tg/download/${encodeURIComponent(String(chatId))}/${encodeURIComponent(String(messageId))}`, {
    method: 'POST',
    body: JSON.stringify(dir ? { dir } : {}),
  })
}

/** GET /api/tg/file/{chat}/{msg} — 媒体在线流（照片→JPEG；视频→Range）。
 * 供 <img>/<video> 直接引用实现点看/点放，不预下载、不过度缓存。 */
export function tgFileUrl(chatId: number | string, messageId: number | string): string {
  return `${TG_BASE}/api/tg/file/${encodeURIComponent(String(chatId))}/${encodeURIComponent(String(messageId))}`
}

/** GET /api/tg/thumb/{chat}/{msg} — 轻量缩略图（<=480px JPEG，列表海报专用）。
 *  后端优先返回 TL 内嵌 Cached 缩略图（秒回）；无缩略图时该 URL 返回 404。 */
export function tgThumbUrl(chatId: number | string, messageId: number | string): string {
  return `${TG_BASE}/api/tg/thumb/${encodeURIComponent(String(chatId))}/${encodeURIComponent(String(messageId))}`
}

/** GET /api/tg/config — 运行时配置（缓存下载目录等） */
export async function getTgConfig(): Promise<{ downloadDir: string }> {
  return request<{ downloadDir: string }>('/api/tg/config')
}

/** PUT /api/tg/config — 更新缓存下载目录（持久化到 app_setting，立即生效） */
export async function setTgDownloadDir(downloadDir: string): Promise<{ downloadDir: string }> {
  return request<{ downloadDir: string }>('/api/tg/config', {
    method: 'PUT',
    body: JSON.stringify({ downloadDir }),
  })
}

/** GET /api/tg/local/{chat}/{msg} — 已缓存文件的本地流（支持 Range，不回源 TG）。
 *  供 <video> 直接引用；未缓存/文件缺失时返回 404，前端降级在线流。 */
export function tgLocalFileUrl(chatId: number | string, messageId: number | string): string {
  return `${TG_BASE}/api/tg/local/${encodeURIComponent(String(chatId))}/${encodeURIComponent(String(messageId))}`
}

/** GET /api/tg/stored?q=&type=&downloaded=1&beforeId=&limit= — 缓存库跨频道聚合视图（新→旧） */
export async function listTgStored(
  opts?: { q?: string; mediaType?: string; downloaded?: boolean; limit?: number; beforeId?: number },
): Promise<TgMessagePage<TgStoredItem>> {
  const limit = opts?.limit ?? 50
  const q = new URLSearchParams({ limit: String(limit) })
  if (opts?.q) q.set('q', opts.q)
  if (opts?.mediaType) q.set('type', opts.mediaType)
  if (opts?.downloaded) q.set('downloaded', '1')
  if (opts?.beforeId !== undefined) q.set('beforeId', String(opts.beforeId))
  const res = await request<unknown>(`/api/tg/stored?${q}`)
  const page = res as Partial<TgMessagePage<TgStoredItem>>
  return {
    items: Array.isArray(page.items) ? page.items : [],
    hasMore: Boolean(page.hasMore),
  }
}

/** POST /api/tg/cache/clear — 清理 TG 缓存（缩略图/临时媒体）。
 * 若后端尚未实现该端点将返回 4xx，前端据此兜底提示。 */
export async function clearTgCache(): Promise<{ ok: boolean }> {
  return request('/api/tg/cache/clear', { method: 'POST' })
}

/** DELETE /api/tg/stored/{chat}/{msg} — 清除单条消息的本地缓存
 * （删落盘文件副本 + 复位 downloaded；库内记录保留，可重新缓存） */
export async function clearTgStored(
  chatId: number | string,
  messageId: number | string,
): Promise<{ ok: boolean; removed: boolean }> {
  return request(
    `/api/tg/stored/${encodeURIComponent(String(chatId))}/${encodeURIComponent(String(messageId))}`,
    { method: 'DELETE' },
  )
}

/** GET /api/tg/downloaded/{chat} — 该频道已缓存清单：{messageId: filePath}。
 *  DB 为唯一真相源，feed/缓存库加载时合并，保证刷新后缓存状态准确。 */
export async function listTgDownloaded(
  chatId: number | string,
): Promise<Record<string, string>> {
  const res = await request<{ downloaded?: Record<string, string> }>(
    `/api/tg/downloaded/${encodeURIComponent(String(chatId))}`,
  )
  return res.downloaded ?? {}
}

// ---- 缓存任务（服务端任务态）----
//
// 缓存由后端 worker 执行并落库，前端不再自己跑「逐条循环」：那个循环活在浏览器内存里，
// 刷新/切页即消失（「缓存状态完全丢失」的根因）。这里只负责入队 + 读状态。

/** GET /api/tg/cache/tasks — 返回**当前唯一**任务（后端单飞：running → 最老 queued →
 *  最近一条已结束；无任务时 null）。挂载时调用即恢复进度，1s 轮询也走这里。 */
export async function getCacheTask(): Promise<TgCacheTask | null> {
  const res = await request<{ task?: TgCacheTask | null }>('/api/tg/cache/tasks')
  return res.task ?? null
}

/**
 * POST /api/tg/cache/tasks — 入队缓存任务。
 * 幂等：同 key 已有活跃任务时后端复用该任务，不重复下载。
 * 传 `groupId` 表示整组（相册）缓存；缺省为单条。
 */
export async function enqueueCacheTask(opts: {
  chatId: number
  messageIds: number[]
  groupId?: number
}): Promise<TgCacheTask> {
  return request<TgCacheTask>('/api/tg/cache/tasks', {
    method: 'POST',
    body: JSON.stringify({
      chatId: opts.chatId,
      messageIds: opts.messageIds,
      groupId: opts.groupId,
    }),
  })
}

/** DELETE /api/tg/cache/tasks/{id} — 取消任务（worker 在下一条目间隙退出）。 */
export async function cancelCacheTask(id: number): Promise<{ ok: boolean }> {
  return request(`/api/tg/cache/tasks/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/** GET /api/tg/cache/tasks/all — 全量任务 + 各状态计数（缓存管理面板用，低频拉取）。 */
export async function listAllCacheTasks(): Promise<{
  tasks: TgCacheTask[]
  counts: Record<string, number>
}> {
  return request('/api/tg/cache/tasks/all')
}

/** DELETE /api/tg/cache/finished — 清除全部终态任务记录（活跃任务不受影响）。 */
export async function clearFinishedCacheTasks(): Promise<{ ok: boolean; removed: number }> {
  return request('/api/tg/cache/finished', { method: 'DELETE' })
}