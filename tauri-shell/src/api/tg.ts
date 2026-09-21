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
import { t } from '../i18n'
import { classifyTgReason, logTgReason } from '../lib/tgReason'

/** orig-tg 默认端口（与 Rust 侧 orig-tg 监听端口一致，独立于 daemon 的 9876） */
export const TG_PORT = 9877

/** 开发模式下 orig-tg 可能不在 9877（可被环境变量覆盖，仅用于本地调试） */
const port = Number(import.meta.env.VITE_TG_PORT ?? TG_PORT)

export const TG_BASE = `http://127.0.0.1:${port}`

/** 从响应体取服务端给的 `error` 字段（本服务统一 `{"error": "..."}` 形状）。 */
function extractErrorField(body: string): string | null {
  const s = body.trim()
  if (!s.startsWith('{')) return null
  try {
    const j = JSON.parse(s) as { error?: unknown }
    return typeof j.error === 'string' ? j.error : null
  } catch {
    return null
  }
}

/**
 * 构造**给用户看**的失败文案（BUG-110 的前端半边）。
 *
 * 导出是为了让验收脚本能对**这个真函数**断言（见 `verify/verify_tg_error_i18n.cjs`）：
 * 只测它依赖的 `classifyTgReason` 不够 —— 分类对了而这里的组装/分岔写错，界面照样错。
 *
 * `request()` 抛出的 `message` 会被 17 个文件、62 处调用点直接 `setError` 渲染，
 * 所以**在这里一处**替换就能让全部 TG 调用点合规；反之，只要这里是原文，
 * 那 62 处无一幸免 —— 这是「在源头修」而非「逐处打补丁」的同一条理由
 * （后端 BUG-110 也是这样修的）。
 *
 * 两条硬规则：
 *
 * 1. **原文只进日志**（`logTgReason`），绝不进界面 —— 对齐 `tgReason.ts` 的既定约定。
 * 2. **只翻译确认识别的错误**，识别不出的一律保留原文。
 *    把「未选中任何消息」说成「Telegram 暂时不可用，请稍后重试」是**另一种谎报**，
 *    而且更糟：它给了错误的可行动指引，用户会照着做然后更困惑。
 */
export function tgFailureMessage(status: number, statusText: string, body: string): string {
  const raw = (body ? extractErrorField(body) ?? body : `${status} ${statusText}`.trim()).trim()
  logTgReason(raw, 'tg-request')
  const key = classifyTgReason(raw)
  if (key !== 'tg.reasonUnknown') return t(key)
  // 识别不出原因时按状态码分岔：
  // - 5xx 是**服务端/依赖故障**，给通用「暂时不可用」是如实表述；
  // - 4xx 一律保留原文 —— 那多半是请求本身的问题（如「未选中任何消息」），
  //   说成「暂时不可用」就是谎报，还会给出错误的可行动指引。
  //   响应体为空（连原因都没有）时同样保留状态行：不给没依据的说法。
  if (status >= 500) return t('tg.reasonUnknown')
  return raw || t('tg.reasonUnknown')
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${TG_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch (e) {
    // fetch 本身失败（orig-tg 未启动 / 端口不通 / 被拦截）：同样不得直出原文。
    throw new Error(tgFailureMessage(0, '', e instanceof Error ? e.message : String(e)))
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(tgFailureMessage(res.status, res.statusText, body))
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
  opts?: { limit?: number; beforeId?: number; q?: string },
): Promise<TgMessagePage<TgStoredMessage>> {
  const limit = opts?.limit ?? 30
  const q = new URLSearchParams({
    channelId: String(channelId),
    limit: String(limit),
  })
  if (opts?.beforeId !== undefined) q.set('beforeId', String(opts.beforeId))
  if (opts?.q) q.set('q', opts.q)
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

/** GET /api/tg/monitor/search?q=.. — 全局监控内容查找（跨全部监控频道，caption 子串）。
 *  只查本地已同步消息；命中项带 channelTitle 供按频道分组展示。 */
export async function searchTgMonitorMessages(
  q: string,
  limit = 60,
): Promise<(TgStoredMessage & { channelTitle?: string })[]> {
  const trimmed = q.trim()
  if (!trimmed) return []
  const res = await request<{ items?: (TgStoredMessage & { channelTitle?: string })[] }>(
    `/api/tg/monitor/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`,
  )
  return res.items ?? []
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

/**
 * POST /api/cache/tasks/:id/retry — **原任务重试**（BUG-078）：按 id 复位终态记录为
 * `queued`，复用同一行，不再新建任务。与 `enqueueCacheTask`（对终态会 INSERT 新行）区分。
 */
export async function retryCacheTask(id: number): Promise<TgCacheTask> {
  return request(`/api/cache/tasks/${encodeURIComponent(String(id))}/retry`, { method: 'POST' })
}

/**
 * DELETE /api/cache/tasks/{id} — 删除**单条**任务记录（任何状态）。
 * 与「取消」不同：终态记录也要能删掉，活跃任务则先置 cancelled 再删。
 */
export async function deleteCacheTask(id: number): Promise<{ ok: boolean }> {
  return request(`/api/cache/tasks/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/**
 * DELETE /api/cache/tasks?ids=1,2,3 — 删除**勾选的具体几条**任务记录。
 *
 * 与 `clearCacheTasks(scope)` 共用同一端点：scope 是「看得见的筛选」整档，
 * ids 是用户勾出来的集合（点全选即等价全部）。选择本身才是诉求 ——
 * 枚举档位永远追不上（清空失败 / 清空成功 / 清空中断…）。
 * 空数组会被后端 422 拒绝（避免误发空选择反而清空列表）。
 */
export async function deleteCacheTasksByIds(
  ids: number[],
): Promise<{ ok: boolean; removed: number; selected: number }> {
  if (ids.length === 0) {
    throw new Error('没有勾选任何记录')
  }
  return request(`/api/cache/tasks?ids=${encodeURIComponent(ids.join(','))}`, { method: 'DELETE' })
}

/**
 * DELETE /api/cache/tasks?scope=all|success|failed — 批量清除任务记录。
 *
 * 动词只有一个（清除），范围走参数：三档互斥且并集为全集，所以不需要「清空全部」
 * 「清除记录」「清空失败」N 个函数。活跃任务只有 `all` 档会清（先取消再删）。
 * 界面上的批量删除已改为「勾选 + 删除所选」（见 `deleteCacheTasksByIds`）。
 */
export async function clearCacheTasks(
  scope: 'all' | 'success' | 'failed',
): Promise<{ ok: boolean; removed: number; scope: string }> {
  return request(`/api/cache/tasks?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' })
}

/** GET /api/tg/cache/tasks/all — 全量任务 + 各状态计数（缓存管理面板用，低频拉取）。 */
export async function listAllCacheTasks(): Promise<{
  tasks: TgCacheTask[]
  counts: Record<string, number>
}> {
  return request('/api/tg/cache/tasks/all')
}

/**
 * GET /api/cache/stats — 缓存磁盘占用（`files` / `bytes` / `external`）。
 * 「清除缓存文件」是释放磁盘的动作，不知道占多少就是盲操作。
 */
export async function getCacheStats(): Promise<{
  ok: boolean
  files: number
  bytes: number
  external: number
}> {
  return request('/api/cache/stats')
}

/** 缓存清理**预览**（只读）：回答「按下确认会释放多少、涉及哪几条」（BUG-059）。 */
export type CacheClearPreview = {
  ok: boolean
  downloadDir: string
  olderThanDays: number
  total: { count: number; bytes: number }
  /** 孤儿：磁盘上有、库里没有任何条目指向 */
  orphan: { count: number; bytes: number; truncated: boolean }
  /** 外部文件（导入/扫描带进来的）：**永不参与清理**，只如实计数 */
  external: { count: number; bytes: number; removable: boolean }
  stale: { count: number; bytes: number }
  /** 失败/取消/中断任务涉及过的消息所占字节 */
  failed: { count: number; bytes: number }
  byChat: Array<{ chatId: number; count: number; bytes: number }>
  items: Array<{
    id: number
    title: string
    chatId: number | null
    bytes: number
    ageDays: number
    inside: boolean
    failed: boolean
  }>
  itemsTruncated: boolean
}

/** GET /api/cache/clear/preview — 清理影响面（**不产生任何删除**）。 */
export async function getCacheClearPreview(olderThanDays?: number): Promise<CacheClearPreview> {
  const qs = olderThanDays ? `?olderThanDays=${olderThanDays}` : ''
  return request(`/api/cache/clear/preview${qs}`)
}

/** 清理结果：如实回报，界面直接照读，不自行推算。 */
export type CacheClearResult = {
  ok: boolean
  scope: string
  removed: number
  skipped: number
  bytesFreed: number
  /** 仅 `ids` 档：请求里选了几条 / 实际命中几条 */
  selected?: number
  hit?: number
}

/**
 * POST /api/cache/clear — 清理**缓存字节**的唯一端点（条目与记录一律保留）。
 *
 * 三种互斥范围：`ids`（勾选的集合）/ `scope`（整档）/ 无参（= `scope=all`，向后兼容）。
 * 旧签名 `clearCacheBytes()` 仍然可用 —— 无参即全清。
 */
export async function clearCacheBytes(
  opts: { ids?: number[]; scope?: 'all' | 'orphan' | 'stale' | 'failed'; olderThanDays?: number } = {},
): Promise<CacheClearResult> {
  const parts: string[] = []
  if (opts.ids && opts.ids.length > 0) parts.push(`ids=${encodeURIComponent(opts.ids.join(','))}`)
  else if (opts.scope) parts.push(`scope=${encodeURIComponent(opts.scope)}`)
  if (opts.olderThanDays) parts.push(`olderThanDays=${opts.olderThanDays}`)
  const qs = parts.length > 0 ? `?${parts.join('&')}` : ''
  return request(`/api/cache/clear${qs}`, { method: 'POST' })
}

/**
 * DELETE /api/cache/items/:id — 清除**单个条目**已缓存的字节（记录保留，可重新缓存）。
 *
 * 语义与「删除条目」严格区分：清缓存后条目仍在库里（回「仅入库」浏览态），
 * 删除条目则连记录一起没了。后端对「没有字节可清」返回 422，前端据此给如实提示。
 */
export async function clearCacheItem(id: number): Promise<{ ok: boolean; freed: number }> {
  return request(`/api/cache/items/${id}`, { method: 'DELETE' })
}