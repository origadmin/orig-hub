#!/usr/bin/env node
'use strict'
/**
 * BUG-484 取证：入库按标题自动归属——同名筛选复用（不重复建）、无同名才落新规则；
 * 对话框只有标题一个输入（无「新建/已有」模式、无规则下拉）；系列轴同源
 * （seriesKey = tg:filter:{id}），titleHint === seriesHint === 标题。
 *
 * 用户 2026-10-28：「不存在加入筛选，筛选是根据标题筛选的，既然已经有了为什么还要反复加入」。
 *
 * 方法：CDP Fetch（Request stage）**零数据污染**——
 *   - GET `monitor/messages` 注入**一条合成消息**（有 caption、未缓存）⇒ 频道流里
 *     恰有一颗可点的「缓存入库」，断言目标确定，不随真实 feed 抖动；
 *   - GET `monitor/filters` 首个请求 **hold**，等点开对话框、读到实得标题 V 后再放行：
 *     A. 放行 [{id:777001, label:V, keyword:V}] ⇒ 同名复用：filters POST 必须为 0，
 *        cache POST seriesKey 必须是 tg:filter:777001；
 *     B. 放行 [] ⇒ 无同名：filters POST 恰 1 次且 keyword === label === V，
 *        seriesKey = tg:filter:777002（新建那条的 id）；
 *   - POST `monitor/filters` / `cache/tasks` 一律合成应答（不落引擎）；
 *     OPTIONS 预检以合法 CORS 头放行（跨源 5180 → 19787）。
 *
 * 验牙：装回「无复用、恒新建」旧实现复跑场景 A，filters POST 必为 1 ⇒ 必败。
 *
 * 用法：node tauri-shell/verify/_probe_bug484_ingest_by_title.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-bug484'),
)
const REUSE_ID = 777001
const CREATED_ID = 777002
const SYNTH = {
  channelId: -100999484,
  messageId: 484001,
  caption: 'BUG-484 验收剧集 · 入库按标题归属',
  mimeType: 'video/mp4',
  size: 12345678,
  type: 'video',
  date: Math.floor(Date.now() / 1000) - 60,
  createdAt: Math.floor(Date.now() / 1000) - 60,
  downloaded: false,
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openIntercepted(browser) {
  const page = await browser.newPage()
  const st = {
    firstFiltersSeen: false, // 只 hold 首个 GET filters（后续一律即时应答）
    releaseList: null, // 放行时的 items（null = 还没决定）
    V: null, // 从对话框读到的实得标题
    filtersPosts: [],
    cachePosts: [],
  }
  const listNow = () =>
    st.V && st.releaseList && st.releaseList.length > 0
      ? [{ id: REUSE_ID, label: st.V, keyword: st.V, createdAt: 0, hits: 0, newHits: 0 }]
      : st.releaseList || []
  const jsonRes = (payload) => ({
    responseCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/json' },
      { name: 'access-control-allow-origin', value: '*' },
    ],
    body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  })
  /** 跨源 POST 的预检必须以合法 CORS 应答放行，否则浏览器直接拦死真请求 */
  const preflightRes = {
    responseCode: 204,
    responseHeaders: [
      { name: 'access-control-allow-origin', value: '*' },
      { name: 'access-control-allow-methods', value: 'GET,POST,DELETE,PATCH,PUT' },
      { name: 'access-control-allow-headers', value: 'content-type' },
    ],
  }
  await page.conn.send(
    'Fetch.enable',
    {
      patterns: [
        { urlPattern: '*api/tg/monitor/filters*', requestStage: 'Request' },
        { urlPattern: '*api/tg/cache/tasks*', requestStage: 'Request' },
        { urlPattern: '*api/tg/monitor/messages*', requestStage: 'Request' },
      ],
    },
    { sessionId: page.sessionId },
  )
  const off = page.conn.on('Fetch.requestPaused', async (params) => {
    if (params.sessionId && params.sessionId !== page.sessionId) return
    const url = (params.request && params.request.url) || ''
    const method = (params.request && params.request.method) || 'GET'
    const send = (m, p) => page.conn.send(m, p, { sessionId: page.sessionId })
    try {
      if (method === 'OPTIONS') {
        await send('Fetch.fulfillRequest', { requestId: params.requestId, ...preflightRes })
        return
      }
      if (url.includes('monitor/messages')) {
        // 合成频道流：恰好一条有 caption 的未缓存消息
        await send('Fetch.fulfillRequest', { requestId: params.requestId, ...jsonRes({ items: [SYNTH], hasMore: false }) })
        return
      }
      if (url.includes('monitor/filters')) {
        if (method === 'GET') {
          if (!st.firstFiltersSeen) {
            st.firstFiltersSeen = true
            st.filtersGetHeld = params.requestId // hold 首个：等 V 已知再放行
            return
          }
          await send('Fetch.fulfillRequest', { requestId: params.requestId, ...jsonRes({ items: listNow() }) })
          return
        }
        // POST 新建：捕获请求体 + 合成应答（不落引擎）
        let body = null
        try { body = JSON.parse(params.request.postData || '{}') } catch { body = { raw: params.request.postData } }
        st.filtersPosts.push(body)
        await send('Fetch.fulfillRequest', { requestId: params.requestId, ...jsonRes({ ok: true, id: CREATED_ID }) })
        return
      }
      if (url.includes('cache/tasks')) {
        if (method === 'GET') {
          await send('Fetch.continueRequest', { requestId: params.requestId })
          return
        }
        // POST 入队：捕获请求体 + 合成任务应答
        let body = null
        try { body = JSON.parse(params.request.postData || '{}') } catch { body = { raw: params.request.postData } }
        st.cachePosts.push(body)
        await send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          ...jsonRes({ id: 900001, chatId: 0, messageIds: [], total: 1, done: 0, status: 'queued', createdAt: 0, updatedAt: 0 }),
        })
        return
      }
      await send('Fetch.continueRequest', { requestId: params.requestId })
    } catch (err) {
      console.error('[bug484] intercept failed:', err && err.message)
    }
  })
  return {
    page,
    st,
    /** V 已知后放行 hold 中的 GET filters（items 由 V 拼装：reuse=[同名], create=[]） */
    release(list) {
      st.releaseList = list
      return (async () => {
        if (st.filtersGetHeld === null) return
        const id = st.filtersGetHeld
        st.filtersGetHeld = null // 放行后不再 hold 后续 GET
        await page.conn.send(
          'Fetch.fulfillRequest',
          { requestId: id, ...jsonRes({ items: listNow() }) },
          { sessionId: page.sessionId },
        )
      })()
    },
    stop: async () => {
      off()
      try { await page.conn.send('Fetch.disable', {}, { sessionId: page.sessionId }) } catch { /* closing */ }
    },
  }
}

/** nav-tg → 第一个监控频道（合成流）→ 点开唯一的「缓存入库」→ 读 V。 */
async function reachDialog(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tg-monitor-row"]').length > 0,
    { timeout: 30000 },
  )
  await page.evaluate(() => {
    const row = document.querySelector('[data-testid="tg-monitor-row"]')
    if (row) row.click()
  })
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="bubble-cache-ingest"]')),
    { timeout: 30000 },
  )
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="bubble-cache-ingest"]')
    if (b) b.click()
  })
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="tg-filter-cache-dialog"]')),
    { timeout: 8000 },
  )
  const v = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="tg-filter-cache-name"]')
    return input ? input.value : ''
  })
  if (!v.trim()) throw new Error('dialog title pre-fill is empty')
  return v.trim()
}

async function runScenario(browser, name, releaseItems) {
  const h = await openIntercepted(browser)
  try {
    await h.page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: 90000 })
    const v = await reachDialog(h.page)
    h.st.V = v
    const dialogShape = await h.page.evaluate(() => {
      const dlg = document.querySelector('[data-testid="tg-filter-cache-dialog"]')
      if (!dlg) return null
      return {
        h2: dlg.querySelector('h2') ? dlg.querySelector('h2').textContent : '',
        inputs: dlg.querySelectorAll('input[type="text"], input:not([type])').length,
        radios: dlg.querySelectorAll('input[type="radio"]').length,
        selects: dlg.querySelectorAll('select').length,
      }
    })
    const shot = path.join(OUT, `dialog-${name}.png`)
    await h.page.screenshot(shot)
    // 放行 GET filters（A：含同名；B：空清单），让状态落地后再提交
    await h.release(releaseItems)
    await delay(700)
    await h.page.evaluate(() => {
      const s = document.querySelector('[data-testid="tg-filter-cache-submit"]')
      if (s) s.click()
    })
    // 等 POST cache/tasks 被捕获（合成应答即时返回）
    for (let i = 0; i < 40 && h.st.cachePosts.length === 0; i++) await delay(250)
    await delay(400)
    if (h.st.cachePosts.length === 0) {
      const dbg = await h.page.evaluate(() => {
        const t = document.body.innerText
        const i = t.indexOf('入库')
        return {
          toast: t.slice(Math.max(0, i - 60), i + 80),
          dialogStill: Boolean(document.querySelector('[data-testid="tg-filter-cache-dialog"]')),
          errEls: [...document.querySelectorAll('[data-testid="tg-filter-cache-error"]')].map((e) => e.textContent),
        }
      }).catch(() => null)
      const perrs = h.page.pageErrors ? h.page.pageErrors() : []
      const cerrs = h.page.consoleErrors ? h.page.consoleErrors() : []
      console.log(`[bug484] ${name}: DEBUG no-cachePost dialogStill=${dbg && dbg.dialogStill} errEls=${JSON.stringify(dbg && dbg.errEls)} toast=${JSON.stringify(dbg && dbg.toast).slice(0, 160)} pageErrors=${JSON.stringify(perrs).slice(0, 300)} consoleErrors=${JSON.stringify(cerrs).slice(0, 400)}`)
    }
    const result = {
      V: v,
      dialogShape,
      shot,
      filtersPosts: h.st.filtersPosts,
      cachePosts: h.st.cachePosts,
    }
    console.log(`[bug484] ${name}: V=${JSON.stringify(v)} shape=${JSON.stringify(dialogShape)} filtersPosts=${h.st.filtersPosts.length} cachePosts=${h.st.cachePosts.length}`)
    console.log(`[bug484] ${name}: cacheBody=${JSON.stringify(h.st.cachePosts[0] || null)}`)
    return result
  } finally {
    await h.stop()
  }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const results = {}
  try {
    // ---- 场景 A：同名筛选已存在 → 必须复用（filters POST = 0，seriesKey 指向它）----
    results.reuse = await runScenario(browser, 'reuse', [{ id: REUSE_ID }])

    // ---- 场景 B：无同名 → 恰好落一条新规则（keyword === label === V）----
    results.create = await runScenario(browser, 'create', [])

    // ---- 断言 ----
    const A = results.reuse
    const B = results.create
    const cacheBody = (r) => r.cachePosts[0] || {}
    const checks = []
    checks.push([
      `A 前置：对话框真实打开且预填 = 合成 caption（V=${JSON.stringify(A.V)}）`,
      Boolean(A.V) && Boolean(A.dialogShape) && A.V === SYNTH.caption,
    ])
    checks.push([
      `A 对话框形态：只有 1 个文本输入，0 radio / 0 select（无「新建/已有」模式）`,
      A.dialogShape && A.dialogShape.inputs === 1 && A.dialogShape.radios === 0 && A.dialogShape.selects === 0,
    ])
    checks.push([
      `A 同名复用：filters POST 计数 = 0（不重复建；实得 ${A.filtersPosts.length}）`,
      A.filtersPosts.length === 0,
    ])
    checks.push([
      `A 归属同源：cache POST seriesKey = tg:filter:${REUSE_ID} 且 titleHint === seriesHint === V`,
      A.cachePosts.length === 1 &&
        cacheBody(A).seriesKey === `tg:filter:${REUSE_ID}` &&
        cacheBody(A).titleHint === A.V &&
        cacheBody(A).seriesHint === A.V,
    ])
    checks.push([
      `B 无同名才落新规则：filters POST 恰 1 次且 keyword === label === V（实得 ${B.filtersPosts.length}）`,
      B.filtersPosts.length === 1 &&
        B.filtersPosts[0] &&
        B.filtersPosts[0].keyword === B.V &&
        B.filtersPosts[0].label === B.V,
    ])
    checks.push([
      `B 新规则同轴：cache POST seriesKey = tg:filter:${CREATED_ID}`,
      B.cachePosts.length === 1 && cacheBody(B).seriesKey === `tg:filter:${CREATED_ID}`,
    ])
    let fails = 0
    for (const [name2, ok] of checks) {
      console.log(`[bug484] ${ok ? 'PASS' : 'FAIL'}: ${name2}`)
      if (!ok) fails++
    }
    console.log(`[bug484] summary: ${checks.length - fails}/${checks.length} PASS`)
    fs.writeFileSync(path.join(OUT, 'probe-result.json'), JSON.stringify(results, null, 2))
    process.exitCode = fails === 0 ? 0 : 1
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error('[bug484] fatal:', e && e.message)
  process.exitCode = 2
})
