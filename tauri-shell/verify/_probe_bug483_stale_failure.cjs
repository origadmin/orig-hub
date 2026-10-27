#!/usr/bin/env node
'use strict'
/**
 * BUG-483 取证：历史 failed 缓存任务不得在挂载时重放成全局 toast；新鲜失败必须照常提示。
 *
 * 用户 2026-10-28：每次进 TG 插件都弹「下载过慢：该条目耗时超过单条上限（默认 30 分钟）…」
 * ——库里存着 ~10 条历史 failed 任务（部分 error 正是 too-slow 原文），`/api/tg/cache/tasks`
 * 恒返回「最近一条已结束」，挂载快照把历史失败重放成 store.toast（全局 toast）。
 *
 * 方法：CDP Fetch 域拦截「任意主机 /api/tg/cache/tasks」（**只**拦这一个端点，其余真实直达），
 * 注入受控合成响应——不往用户真实库里塞任务、零数据污染：
 *   A. **stale**：task.status=failed 且 updatedAt = 2 小时前（历史失败）→ 挂载进 TG 插件
 *      ⇒ 断言采样窗内 toast/页面**从不**出现「下载过慢」；
 *   B. **fresh**：task.status=failed 且 updatedAt = 挂载时刻之后（新鲜失败）⇒ 断言
 *      toast **出现**（反向变异：证明守卫没有把「提示失败」一并杀掉，禁恒绿）。
 *
 * 验牙：装回旧实现（无 updatedAt 新鲜度判据）复跑，A 必败（历史失败必弹 toast）。
 *
 * 用法：node tauri-shell/verify/_probe_bug483_stale_failure.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-bug483'),
)
const MARKER = '下载过慢' // tg.reasonTooSlow 文案的稳定片段
const SAMPLING_MS = 250
const WINDOW_MS = 8000
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const TOO_SLOW_RAW =
  'download too slow: 1800.0s for chat -100999 msg 1; wall-clock limit 1800s exceeded, ' +
  'aborted to keep the cache queue moving'

function syntheticTask(updatedAtSec) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 999001,
    chatId: -100999,
    itemKey: 'm:-100999:1',
    messageIds: [1],
    total: 1,
    done: 0,
    status: 'failed',
    error: TOO_SLOW_RAW,
    createdAt: now - 10800,
    updatedAt: updatedAtSec,
  }
}

/**
 * 打开一个页面，拦截 cache/tasks 端点并按 `payloadRef()` 现算响应。
 * 返回 { page, servedCount, stop } —— servedCount 证明拦截真的发生过（防 vacuous pass）。
 */
async function openWithInterception(browser, payloadRef) {
  const page = await browser.newPage()
  const state = { served: 0 }
  await page.conn.send(
    'Fetch.enable',
    { patterns: [{ urlPattern: '*api/tg/cache/tasks*', requestStage: 'Response' }] },
    { sessionId: page.sessionId },
  )
  const offPaused = page.conn.on('Fetch.requestPaused', async (params) => {
    if (params.sessionId && params.sessionId !== page.sessionId) return
    try {
      const payload = payloadRef()
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
      await page.conn.send(
        'Fetch.fulfillRequest',
        {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body,
        },
        { sessionId: page.sessionId },
      )
      state.served++
    } catch (err) {
      console.error('[bug483] fulfill failed:', err && err.message)
    }
  })
  return {
    page,
    served: () => state.served,
    stop: async () => {
      offPaused()
      try {
        await page.conn.send('Fetch.disable', {}, { sessionId: page.sessionId })
      } catch (_err) { /* closing anyway */ }
    },
  }
}

/** 点进 TG 插件，采样窗内轮询「下载过慢」是否出现过。返回 { seen, seenAtMs } */
async function sampleForMarker(page) {
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!clicked) throw new Error('nav-tg not found')
  const start = Date.now()
  let seen = false
  let seenAtMs = null
  while (Date.now() - start < WINDOW_MS) {
    const found = await page.evaluate(
      (marker) => document.body.innerText.includes(marker),
      MARKER,
    )
    if (found) {
      seen = true
      seenAtMs = Date.now() - start
      break
    }
    await delay(SAMPLING_MS)
  }
  return { seen, seenAtMs }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const results = {}
  try {
    // ---- 场景 A：历史失败（updatedAt = 2h 前）→ 必须静默 ----
    {
      const payloadRef = () => ({ task: syntheticTask(Math.floor(Date.now() / 1000) - 7200), queued: [] })
      const h = await openWithInterception(browser, payloadRef)
      try {
        await h.page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: 90000 })
        const { seen, seenAtMs } = await sampleForMarker(h.page)
        const shot = path.join(OUT, 'scenario-stale.png')
        await h.page.screenshot(shot)
        results.stale = { seen, seenAtMs, served: h.served(), shot }
        console.log(`[bug483] A stale: seen=${seen} served=${h.served()} shot=${shot}`)
      } finally {
        await h.stop()
      }
    }

    // ---- 场景 B：新鲜失败（updatedAt = 挂载之后）→ 必须提示（反向变异）----
    {
      const payloadRef = () => ({ task: syntheticTask(Math.floor(Date.now() / 1000) + 30), queued: [] })
      const h = await openWithInterception(browser, payloadRef)
      try {
        await h.page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: 90000 })
        const { seen, seenAtMs } = await sampleForMarker(h.page)
        const shot = path.join(OUT, 'scenario-fresh.png')
        await h.page.screenshot(shot)
        results.fresh = { seen, seenAtMs, served: h.served(), shot }
        console.log(`[bug483] B fresh: seen=${seen} served=${h.served()} shot=${shot}`)
      } finally {
        await h.stop()
      }
    }

    // ---- 断言 ----
    const checks = []
    checks.push([
      `A 前置：拦截确实服务过 cache/tasks（served=${results.stale.served}，防 vacuous pass）`,
      results.stale.served > 0,
    ])
    checks.push([
      `A 历史失败不重放：挂载采样窗 ${WINDOW_MS}ms 内从未出现「${MARKER}」toast`,
      results.stale.served > 0 && !results.stale.seen,
    ])
    checks.push([
      `B 前置：拦截确实服务过 cache/tasks（served=${results.fresh.served}）`,
      results.fresh.served > 0,
    ])
    checks.push([
      `B 新鲜失败仍提示：toast 出现（seenAt=${results.fresh.seenAtMs}ms，反向变异禁恒绿）`,
      results.fresh.served > 0 && results.fresh.seen,
    ])
    let fails = 0
    for (const [name, ok] of checks) {
      console.log(`[bug483] ${ok ? 'PASS' : 'FAIL'}: ${name}`)
      if (!ok) fails++
    }
    console.log(`[bug483] summary: ${checks.length - fails}/${checks.length} PASS`)
    fs.writeFileSync(path.join(OUT, 'probe-result.json'), JSON.stringify(results, null, 2))
    process.exitCode = fails === 0 ? 0 : 1
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error('[bug483] fatal:', e && e.message)
  process.exitCode = 2
})
