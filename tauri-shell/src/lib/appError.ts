/**
 * 错误的**结构化**表达（BUG-384，第 5 次提出）。
 *
 * 现状是 `setError(e.message)`：界面只有一句话，没有对象标识、没有状态码、
 * 没有时间、没有可复制的诊断串 ⇒ 用户说不清「哪一条坏了」，开发者无法复现。
 *
 * 这一层不改任何 throw 点的语义，只做**解析与补全**：
 * 各 api 客户端抛的是 `"<status> <statusText>: <body>"`（`api/daemon.ts:48` 等）
 * 或纯文案，这里把能提出的字段提出来，缺的用调用方给的上下文补。
 * 于是「加详情」不需要先重写十几个 throw 点 —— 也就不会有「改了一半」的状态。
 */

export interface AppError {
  /** 给人看的一句话（原 message 的首行，剥掉状态码前缀） */
  message: string
  /** 动作或端点来源，如 `GET /api/tg/dialogs`、`编辑条目 #394` */
  source?: string
  /** 出问题的对象标识：item id / ref / chat:msg / 任务 id 等 */
  objectRef?: string
  /** HTTP 状态码（解析自 message 前缀；没有则 undefined） */
  status?: number
  /** 后端错误码（body 里的 `code` 字段，若有） */
  code?: string
  /** 后端原始响应体（截断到 800 字符，够诊断又不至于把界面撑爆） */
  body?: string
  /** 发生时间（ISO 字符串） */
  at: string
  /** 原始 message，完整保留 —— 复制诊断串时用它 */
  raw: string
}

/** `"404 Not Found: {...}"` / `"500 Internal Server Error"` 的前缀形态。 */
const STATUS_PREFIX = /^(\d{3})\s+([^:]*?)(?::\s*([\s\S]*))?$/

/**
 * 把任意抛出的东西归一成 `AppError`。
 *
 * @param e     catch 到的值（Error / string / 任意）
 * @param ctx   调用点知道的上下文：来源、对象标识、动作
 */
export function toAppError(
  e: unknown,
  ctx: { source?: string; objectRef?: string } = {},
): AppError {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)
  const out: AppError = {
    message: raw.trim() || 'unknown error',
    source: ctx.source,
    objectRef: ctx.objectRef,
    at: new Date().toISOString(),
    raw,
  }
  const m = STATUS_PREFIX.exec(raw.trim())
  if (m) {
    out.status = Number(m[1])
    out.message = (m[3] ?? m[2] ?? '').trim() || m[2] || raw.trim()
    if (m[2]) out.code = m[2].trim() || undefined
    const body = m[3] ?? ''
    if (body) {
      out.body = body.length > 800 ? `${body.slice(0, 800)}…` : body
      // 后端错误体统一为 `{code,message}`（见 BUG-176 的错误契约），能解则用 code 覆盖
      try {
        const parsed = JSON.parse(body) as { code?: unknown; message?: unknown }
        if (typeof parsed.code === 'string') out.code = parsed.code
        if (typeof parsed.message === 'string' && parsed.message) out.message = parsed.message
      } catch {
        // 非 JSON 体：保留原文，不清空已解析字段
      }
    }
  }
  return out
}

/** 一条可粘贴进缺陷报告的诊断串（一键复制用）。 */
export function errorReport(err: AppError): string {
  const lines = [
    `time: ${err.at}`,
    err.source ? `source: ${err.source}` : null,
    err.objectRef ? `object: ${err.objectRef}` : null,
    err.status !== undefined ? `status: ${err.status}` : null,
    err.code ? `code: ${err.code}` : null,
    `message: ${err.message}`,
    err.body ? `body: ${err.body}` : null,
  ].filter(Boolean)
  return lines.join('\n')
}
