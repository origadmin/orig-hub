import type { TgChannel, TgDiag, TgMediaItem, TgSession } from '../types'

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

/** GET /api/tg/dialogs — 订阅频道枚举（需已授权） */
export function listTgDialogs(): Promise<TgChannel[]> {
  return request('/api/tg/dialogs')
}

/** GET /api/tg/messages/:chat_id?limit= — 媒体历史（需已授权） */
export function listTgMessages(chatId: number | string, limit = 100): Promise<TgMediaItem[]> {
  return request(`/api/tg/messages/${encodeURIComponent(String(chatId))}?limit=${limit}`)
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