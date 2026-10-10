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
  | 'tg.reasonStalled'
  | 'tg.reasonTooSlow'
  | 'tg.reasonRestarted'
  | 'tg.reasonNetwork'
  | 'tg.reasonUnknown'

/**
 * 「传输停滞」的判据（BUG-257 判据 6）。
 *
 * **必须排在网络类之前**，否则这条最具体的诊断会被下面那条宽泛的网络正则吃掉：
 * 停滞原文含 `connection presumed dead`，而网络正则含 `connect` ⇒ 命中 `tg.reasonNetwork`
 * ⇒ 界面显示「无法连接到 Telegram，请检查网络与代理设置后重试」。
 *
 * 那是**误导性的可行动指引**：真实条件是「连接早已建立、字节流中途停住」，用户会去
 * 反复改代理，而问题在传输停滞。实测原文：
 * `download stalled: no bytes for 90s (chat -1004457697592 msg 1156); connection presumed dead, aborted to unblock the cache queue`
 *
 * 判据取「停滞语义」而不是整句精确匹配：后端的秒数、chat/msg 号会变，写死整句等于
 * 给每个数字留一个漏网口。`stalled|no bytes for|connection presumed dead` 三者任一即可。
 */
const STALLED_RE = /download stalled|no bytes for \d+s|connection presumed dead/i

/**
 * 「慢流」判据（BUG-271）：单条目耗时超过墙钟上限。
 *
 * 原文形如 `download too slow: 1805.2s for chat -1001 msg 55; wall-clock limit 1800s
 * exceeded, aborted to keep the cache queue moving`。
 *
 * **必须与「停滞」（STALLED_RE）分开**：停滞是「无字节」（死），慢流是「有字节但
 * 总耗时超限」（慢）——用户可行动指引不同（停滞查代理稳定性，慢流换更快的来源或
 * 调大 `download_item_max_secs`）。也**必须排在网络类之前**：原因串含
 * `wall-clock`，虽不含 `connect`，但网络正则宽（`transport` 等），任何重叠都会把
 * 具体诊断吞成「检查网络与代理」——BUG-257 点 3 的同款坑，不得再踩。
 */
const TOO_SLOW_RE = /download too slow|wall-clock limit \d+s exceeded/i

/**
 * 「因重启中断」的判据（BUG-257 点2/ 判据 5）。
 *
 * `interrupted` 此前**恒无原因字段**，界面只显示「已中断」——用户无法把「已中断」与
 * 「我刚重启过」联系起来，更不知道它可重试。服务端在启动降级时写入这个原因，这里把它
 * 翻译成能指明成因与出路的文案。
 */
const RESTARTED_RE = /应用重启|restart interrupted|interrupted by restart/i

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
  // 停滞与重启必须**先于**网络类：它们的原文含 `connect`/`restart`，会被网络正则吞掉。
  if (STALLED_RE.test(raw)) return 'tg.reasonStalled'
  // 慢流同样先于网络类（BUG-271）：否则被宽泛网络正则吞成「检查网络与代理」。
  if (TOO_SLOW_RE.test(raw)) return 'tg.reasonTooSlow'
  if (RESTARTED_RE.test(raw)) return 'tg.reasonRestarted'
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

/**
 * 任务失败原因 → **可直接渲染**的最终文案（BUG-111）。
 *
 * 与 `classifyTgReason` 的区别：那个只回答「属于哪一类」，这里给出最终字符串，
 * 并把散落各处的两条既有约定收在一处：
 *
 * - `tg.protectedMedia`：受保护内容的领域特例，**优先于**通用分类。
 *   它原本只在 TgPanel 里手写了一份，CacheManagerDialog 完全没有 ——
 *   同一语义两处实现，改需求时会齐刷刷错成一样（BUG-087 的教训）。
 * - 分类不出的一律保留原文：与 `api/tg.ts::tgFailureMessage` 同一条理由 ——
 *   把「没有这个任务」说成「暂时不可用」是谎报，还会给出错误的可行动指引。
 *
 * **本函数不负责打日志**（保持纯函数）：留痕由持有原文的调用方自行
 * `logTgReason`，否则同一条原因在两处渲染点会被记两遍。
 *
 * @param raw 任务里持久化的失败原因原文
 * @param t 翻译函数
 * @param fallbackKey 原因为空时用的 i18n 键
 */
export function describeTgFailure(
  raw: string | null | undefined,
  t: (key: string) => string,
  fallbackKey = 'tg.cacheFailed',
): string {
  const s = (raw ?? '').trim()
  if (!s) return t(fallbackKey)
  if (/os error 5|拒绝访问|access denied/i.test(s)) return t('tg.protectedMedia')
  const key = classifyTgReason(s)
  if (key === 'tg.reasonUnknown') return s
  return t(key)
}
