/**
 * Telegram 可用性原因 → 用户文案的**唯一映射**（BUG-088 通用规则 / BUG-094）。
 *
 * 后端 `/api/tg/session` 与 `/api/tg/diag` 给出的 `reason` / `unavailable_reason`
 * 是**传输层原文**，形如 `MTProto connect failed: request error: read 0 bytes`。
 * 它既不是给用户看的（英文、术语、无行动指引），也可能带内部细节 ——
 * 因此**任何喂给用户的文案都不得直出原文**：原文一律只进日志，
 * 界面上只渲染本模块映射出的 i18n 键对应的双语文案。
 *
 * 单一真源的必要性（BUG-087 的教训）：同一语义若在每个面板里各写一份，
 * 它们会在改需求时齐刷刷显示同一个错值、且错得一模一样。
 * 故 TgPanel（未绑定引导 / 故障卡 / 调试离线卡）与 AccountsPanel
 * （故障横幅 / 连接诊断）**全部**调用这里的 `classifyTgReason`。
 */

/** 分类结果：i18n 键（调用方再用 `t(key)` 取双语文案） */
export type TgReasonKey =
  | 'tg.reasonOfflineDebug'
  | 'tg.reasonFlood'
  | 'tg.reasonConfig'
  | 'tg.reasonAuth'
  | 'tg.reasonNetwork'
  | 'tg.reasonUnknown'

/**
 * 原文 → i18n 键的**分类降级**。
 *
 * 匹配顺序即优先级：越具体的先试，兜底为 `tg.reasonUnknown`。
 * 空值（'' / null / undefined）表示「后端没给原因」，同样走兜底。
 *
 * @param reason 后端原因原文（可能为空）
 * @returns i18n 键
 */
export function classifyTgReason(reason: string | null | undefined): TgReasonKey {
  const raw = (reason ?? '').trim()
  if (!raw) return 'tg.reasonUnknown'
  // 调试期离线短路：预期态，有专属文案，不能落到「暂时不可用」
  if (/offline debug mode/i.test(raw)) return 'tg.reasonOfflineDebug'
  if (/flood|rate limit|too many|retry after|FLOOD_WAIT/i.test(raw)) return 'tg.reasonFlood'
  if (/api_id|api_hash|api credential|not configured|missing api|credentials/i.test(raw))
    return 'tg.reasonConfig'
  if (/unauthoriz|auth key|session|credential|phone|password|login|code/i.test(raw))
    return 'tg.reasonAuth'
  if (
    // `dropped` 是 grammers `RequestError::Dropped` 的签名（原文
    // `request error: dropped (cancelled)`），含义是 MTProto 发信任务已死 ——
    // 它**不含** mtproto/connect/network 任何一词，不单独列出就会被判成 Unknown
    // 从而保留英文原文（即「没修到」）。'cancelled' 太宽（用户主动取消也用它），故只加 dropped。
    /mtproto|connect|network|proxy|socks|timeout|timed out|eof|refused|reset by peer|dns|read 0 bytes|unreachable|i\/o|transport|failed to fetch|load failed|networkerror|dropped/i.test(
      raw,
    )
  )
    return 'tg.reasonNetwork'
  return 'tg.reasonUnknown'
}

/**
 * 原文**只进日志**：保留排查所需的全部信息，但不把它抛到界面上。
 *
 * @param reason 后端原因原文（可能为空，空则什么都不做）
 * @param tag 调用点标记，便于在日志里区分来源（如 `tg-panel` / `accounts`）
 */
export function logTgReason(reason: string | null | undefined, tag = 'tg'): void {
  const raw = (reason ?? '').trim()
  if (!raw) return
  console.debug(`[${tag}] availability reason (raw, not rendered):`, raw)
}
