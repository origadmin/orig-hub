#!/usr/bin/env node
'use strict'

/**
 * Acceptance for BUG-110 (frontend half): TG request failures must NOT dump the
 * transport-layer raw text into the UI.
 *
 * `src/api/tg.ts::request()` used to throw `${status} ${statusText}: ${body}`,
 * so the user saw `400 Bad Request: {"error":"request error: dropped
 * (cancelled)"}`. It now maps the reason through `classifyTgReason` and renders
 * the i18n text, keeping the raw string in the console only.
 *
 * Why this runs in a real browser instead of re-implementing the logic:
 * asserting against a *copy* of `classifyTgReason` would pass no matter what the
 * shipped module does. This imports the ACTUAL modules through the Vite dev
 * server and calls the real functions.
 *
 * Reverse falsification is mandatory here: a classifier that translates
 * *everything* would also pass the happy path, so a validation error
 * ("messageIds is empty") MUST stay untranslated -- otherwise the UI would tell
 * the user "Telegram is temporarily unavailable, retry later" when they simply
 * selected nothing, which is a worse lie than the raw text.
 *
 * Usage:
 *   node verify/verify_tg_error_i18n.cjs            # http://127.0.0.1:5180
 *   APP_URL=http://127.0.0.1:5173 node verify/verify_tg_error_i18n.cjs
 *
 * Exit codes: 0 = pass, 1 = assertion failed, 2 = environment problem
 *             (no browser / dev server unreachable).
 */

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'

/** 真实链路死因的两种形态：修复后的带 hint 版，与修复前的裸原文。 */
const DROP_AFTER_FIX =
  'MTProto link is down (sender runner exited); restart orig-tg to recover: request error: dropped (cancelled)'
const DROP_RAW = 'request error: dropped (cancelled)'
/** 服务端校验失败：必须保持原文，不得被翻译成「暂时不可用」。 */
const VALIDATION = 'messageIds is empty'
/** 与网络无关的失败：防「分类器把所有东西都判成 Network」的假绿。 */
const UNRELATED = 'an entirely unrelated internal failure'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function main() {
  let browser
  try {
    browser = await cdp.launch()
  } catch (e) {
    console.error(`[verify:tg-i18n] cannot launch browser: ${e.message}`)
    process.exit(2)
  }

  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { timeoutMs: 60000 })

    const got = await page.evaluate(
      async (dropAfterFix, dropRaw, validation, unrelated) => {
        const reason = await import('/src/lib/tgReason.ts')
        const i18n = await import('/src/i18n/index.ts')
        const keyOf = (s) => reason.classifyTgReason(s)
        return {
          keyAfterFix: keyOf(dropAfterFix),
          keyRaw: keyOf(dropRaw),
          keyValidation: keyOf(validation),
          keyUnrelated: keyOf(unrelated),
          textNetwork: i18n.t('tg.reasonNetwork'),
          textUnknown: i18n.t('tg.reasonUnknown'),
        }
      },
      DROP_AFTER_FIX,
      DROP_RAW,
      VALIDATION,
      UNRELATED,
    )

    // 1. 修复后的死因文案 → 网络类（可翻译）。
    check(
      'link-down reason (with hint) classifies as tg.reasonNetwork',
      got.keyAfterFix === 'tg.reasonNetwork',
      got.keyAfterFix,
    )
    // 2. 裸原文 `dropped (cancelled)` 也必须被识别 —— 它不含 mtproto/connect/network
    //    任何一词，不单列就会退回 Unknown 从而保留英文原文（等于没修）。
    check(
      'bare "dropped (cancelled)" also classifies as tg.reasonNetwork',
      got.keyRaw === 'tg.reasonNetwork',
      got.keyRaw,
    )
    // 3. 反向证伪：校验类错误必须保持未识别，否则会被误报成「暂时不可用」。
    check(
      'validation error stays tg.reasonUnknown (must NOT be translated)',
      got.keyValidation === 'tg.reasonUnknown',
      got.keyValidation,
    )
    // 4. 分类器不是「什么都判成 Network」—— 无关文本必须退回 Unknown。
    //    没有这条，一个把 classifyTgReason 写成恒返回 reasonNetwork 的实现也会全绿。
    check(
      'unrelated failure stays tg.reasonUnknown (classifier is not blanket)',
      got.keyUnrelated === 'tg.reasonUnknown',
      got.keyUnrelated,
    )
    // 5. 翻译确实存在（不是回退成 key 本身）。
    check(
      'tg.reasonNetwork has real translated text',
      typeof got.textNetwork === 'string' &&
        got.textNetwork.length > 0 &&
        got.textNetwork !== 'tg.reasonNetwork',
      JSON.stringify(got.textNetwork),
    )
    check(
      'tg.reasonUnknown has real translated text',
      typeof got.textUnknown === 'string' && got.textUnknown !== 'tg.reasonUnknown',
      JSON.stringify(got.textUnknown),
    )
    // ---- 真函数 tgFailureMessage 的四条分岔 ----
    // 只测 classifyTgReason 不够：分类对了、这里的组装或分岔写错，界面照样错。
    const shaped = await page.evaluate(async () => {
      const api = await import('/src/api/tg.ts')
      const i18n = await import('/src/i18n/index.ts')
      const f = api.tgFailureMessage
      return {
        network: f(
          503,
          'Service Unavailable',
          '{"error":"MTProto link is down (sender runner exited); restart orig-tg to recover: request error: dropped (cancelled)"}',
        ),
        validation: f(400, 'Bad Request', '{"error":"messageIds is empty"}'),
        serverFault: f(500, 'Internal Server Error', '{"error":"database is locked"}'),
        fetchFailed: f(0, '', 'Failed to fetch'),
        textUnknown: i18n.t('tg.reasonUnknown'),
        textNetwork: i18n.t('tg.reasonNetwork'),
      }
    })

    // 6. 用户真正会遇到的那条：链路已死的 503 → 网络类中文文案。
    check(
      '503 link-down renders the i18n network text',
      shaped.network === shaped.textNetwork,
      JSON.stringify(shaped.network),
    )
    // 7. 反向证伪：校验类 400 必须保留原文，不得被翻译成「暂时不可用」。
    check(
      '400 validation error keeps its raw reason',
      shaped.validation === 'messageIds is empty',
      JSON.stringify(shaped.validation),
    )
    // 8. 5xx 且原因不可识别 → 通用「暂时不可用」（服务端故障，如实表述）。
    check(
      'unrecognised 5xx falls back to the generic unavailable text',
      shaped.serverFault === shaped.textUnknown,
      JSON.stringify(shaped.serverFault),
    )
    // 9. fetch 本身失败（orig-tg 没起来）不得裸抛 "Failed to fetch"。
    check(
      'fetch failure renders the i18n network text',
      shaped.fetchFailed === shaped.textNetwork,
      JSON.stringify(shaped.fetchFailed),
    )

    // ---- 活体：真实 request() 打真实服务 ----
    const live = await page.evaluate(async () => {
      const api = await import('/src/api/tg.ts')
      const out = { diagOk: false, threw: false, message: '' }
      try {
        const d = await api.tgDiag()
        out.diagOk = Boolean(d && d.port)
      } catch {
        out.diagOk = false
      }
      try {
        await api.cancelCacheTask(999999)
      } catch (e) {
        out.threw = true
        out.message = e instanceof Error ? e.message : String(e)
      }
      return out
    })

    // 10. 回归护栏：成功路径没被这次改动弄坏。
    check('live tgDiag() still succeeds', live.diagOk === true, String(live.diagOk))
    // 11. 活体失败路径：抛出的文案里不得再带 JSON 原文。
    check('live failure threw', live.threw === true, String(live.threw))
    check(
      'live failure message leaks no raw JSON body',
      live.message.length > 0 && !live.message.includes('{'),
      JSON.stringify(live.message),
    )
    // ---- 任务失败原因（BUG-111，第三条泄漏路径：daemon 聚合 → 任务错误 → 界面）----
    const taskMsg = await page.evaluate(async () => {
      const r = await import('/src/lib/tgReason.ts')
      const i18n = await import('/src/i18n/index.ts')
      const f = r.describeTgFailure
      return {
        dropped: f('request error: dropped (cancelled)', i18n.t),
        protectedMedia: f('os error 5: 拒绝访问', i18n.t),
        unknown: f('no active cache task with this id', i18n.t),
        empty: f('', i18n.t),
        textNetwork: i18n.t('tg.reasonNetwork'),
        textProtected: i18n.t('tg.protectedMedia'),
        textFallback: i18n.t('tg.cacheFailed'),
      }
    })

    // 12. 真实留存过的那条失败原因（时间戳 02:05:12，见 BUG-111）必须显示中文。
    check(
      'persisted task error "dropped" renders the i18n network text',
      taskMsg.dropped === taskMsg.textNetwork,
      JSON.stringify(taskMsg.dropped),
    )
    // 13. 领域特例优先于通用分类（原本只在 TgPanel 手写了一份）。
    check(
      'protected media keeps its dedicated message',
      taskMsg.protectedMedia === taskMsg.textProtected,
      JSON.stringify(taskMsg.protectedMedia),
    )
    // 14. 反向证伪：认不出的原因保留原文，不得被套上「暂时不可用」。
    check(
      'unrecognised task error keeps its raw reason',
      taskMsg.unknown === 'no active cache task with this id',
      JSON.stringify(taskMsg.unknown),
    )
    // 15. 原因为空时走兜底文案，不给空白。
    check(
      'empty task error falls back to tg.cacheFailed',
      taskMsg.empty === taskMsg.textFallback,
      JSON.stringify(taskMsg.empty),
    )
  } finally {
    await browser.close()
  }

  if (failures > 0) {
    console.error(`[verify:tg-i18n] ${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('[verify:tg-i18n] all assertions passed')
  process.exit(0)
}

main().catch((e) => {
  console.error(`[verify:tg-i18n] ${e.stack || e.message}`)
  process.exit(2)
})
