#!/usr/bin/env node
'use strict'
/**
 * BUG-485 取证：筛选面板入库必须有终态——提交成功后
 *   1) 选中计数归零、入库按钮禁用（不能无限再点）；
 *   2) 已提交行不可再勾、带「已提交」徽标；
 *   3) 全选（toggleAll）不会把已提交单元勾回（selectableUnits 排除 submitted）；
 *   4) 禁用按钮上的强制点击不产生第二次 cache POST（后端幂等不再是唯一防线）。
 *
 * 用户 2026-10-28：「入库能无限选择，毫无逻辑性」（截图：提示「已提交 1 条入库」
 * 的同时顶部仍是「已选 1 条 / 入库选中 (1)」可再点）。
 *
 * 方法：CDP Fetch 零数据污染——GET monitor/filters 注入一条合成规则，
 * GET 该规则的 messages 注入两条合成未缓存命中（默认全选 = 2），
 * POST cache/tasks 合成应答；其余请求直达真实引擎。
 *
 * 验牙：装回旧实现（无 submitted 终态）复跑 → 1/2/3/4 全 FAIL。
 *
 * 用法：node tauri-shell/verify/_probe_bug485_ingest_terminal_state.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-bug485'),
)
const RULE_ID = 777001
const base = Math.floor(Date.now() / 1000) - 120
const hit = (messageId) => ({
  channelId: -100999485,
  messageId,
  groupId: null,
  caption: `BUG-485 验收命中 #${messageId}`,
  fileName: `bug485-${messageId}.mp4`,
  mimeType: 'video/mp4',
  size: 12345000 + messageId,
  type: 'video',
  date: base - messageId,
  channelTitle: 'BUG-485 验收频道',
  downloaded: false,
})
const RULE = {
  id: RULE_ID,
  label: 'BUG-485 验收规则',
  keyword: 'BUG-485',
  createdAt: base,
  hits: 2,
  newHits: 0,
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openIntercepted(browser) {
  const page = await browser.newPage()
  const st = { cachePosts: [], filtersServed: 0 }
  const jsonRes = (payload) => ({
    responseCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/json' },
      { name: 'access-control-allow-origin', value: '*' },
    ],
    body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  })
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
      if (url.includes('monitor/filters')) {
        // 规则清单（GET）与规则命中列表（GET .../{id}/messages）都合成：
        // 恰好一条规则、两条未缓存命中 ⇒ 默认全选 = 2，断言目标确定。
        if (method === 'GET' && /filters\/\d+\/messages/.test(url)) {
          await send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            ...jsonRes({ items: [hit(485001), hit(485002)], hasMore: false }),
          })
          return
        }
        if (method === 'GET') {
          st.filtersServed++
          await send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            ...jsonRes({ items: [RULE] }),
          })
          return
        }
        await send('Fetch.continueRequest', { requestId: params.requestId })
        return
      }
      if (url.includes('cache/tasks')) {
        if (method === 'GET') {
          await send('Fetch.continueRequest', { requestId: params.requestId })
          return
        }
        let body = null
        try { body = JSON.parse(params.request.postData || '{}') } catch { body = { raw: params.request.postData } }
        st.cachePosts.push(body)
        await send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          ...jsonRes({ id: 900485, chatId: 0, messageIds: [], total: 2, done: 0, status: 'queued', createdAt: 0, updatedAt: 0 }),
        })
        return
      }
      await send('Fetch.continueRequest', { requestId: params.requestId })
    } catch (err) {
      console.error('[bug485] intercept failed:', err && err.message)
    }
  })
  return {
    page,
    st,
    stop: async () => {
      off()
      try { await page.conn.send('Fetch.disable', {}, { sessionId: page.sessionId }) } catch { /* closing */ }
    },
  }
}

/** nav-tg → 点开合成规则行 → 等命中面板渲染出两行可勾单元。 */
async function reachPanel(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tg-filter-row"]').length > 0,
    { timeout: 30000 },
  )
  console.log('[bug485] step: filter rows visible')
  await page.evaluate(() => {
    // 行容器 tg-filter-row 无 onClick；面板入口 = 行内 chip 按钮（enterTransient）。
    const row = document.querySelector('[data-testid="tg-filter-row"] [data-testid="tg-filter-chip"]')
    if (row) row.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tg-filter-hit"]').length >= 2,
    { timeout: 30000 },
  )
  console.log('[bug485] step: hits rendered')
}

async function uiState(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const count = q('[data-testid="tg-filter-selected-count"]')
    const btn = q('[data-testid="tg-filter-ingest"]')
    const all = q('[data-testid="tg-filter-select-all"]')
    const rows = [...document.querySelectorAll('[data-testid="tg-filter-hit"]')]
    return {
      selectedText: count ? count.textContent.trim() : null,
      ingestDisabled: btn ? btn.disabled : null,
      ingestText: btn ? btn.textContent.trim() : null,
      notice: q('[data-testid="tg-filter-notice"]')
        ? q('[data-testid="tg-filter-notice"]').textContent.trim()
        : null,
      rowChecks: rows.map((r) => {
        const c = r.querySelector('input[type="checkbox"]')
        return { checked: c ? c.checked : null, disabled: c ? c.disabled : null }
      }),
      submittedTags: document.querySelectorAll('[data-testid="tg-filter-submitted"]').length,
      selectAllChecked: all ? all.checked : null,
    }
  })
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const h = await openIntercepted(browser)
  try {
    await h.page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: 90000 })
    await reachPanel(h.page)
    await delay(400)
    const before = await uiState(h.page)
    const shotBefore = path.join(OUT, 'before-ingest.png')
    await h.page.screenshot(shotBefore)

    // 提交（默认全选 = 2）
    await h.page.evaluate(() => {
      const b = document.querySelector('[data-testid="tg-filter-ingest"]')
      if (b) b.click()
    })
    for (let i = 0; i < 40 && h.st.cachePosts.length === 0; i++) await delay(250)
    await delay(600)
    const after = await uiState(h.page)
    const postsAfterIngest = h.st.cachePosts.length // 2 个独立单元 = 单元级 2 次 POST（单元=入库单位）
    const shotAfter = path.join(OUT, 'after-ingest.png')
    await h.page.screenshot(shotAfter)

    // 强制对（已禁用的）提交按钮再点一次：不得产生第二次 cache POST
    await h.page.evaluate(() => {
      const b = document.querySelector('[data-testid="tg-filter-ingest"]')
      if (b) b.click()
    })
    await delay(800)

    // 点「全选」两次：第一次清掉残余选中（对齐基线），第二次尝试全选——
    // 已提交单元不在 selectableUnits 里 ⇒ 不得被勾回（BUG-485 终态）。
    for (let i = 0; i < 2; i++) {
      await h.page.evaluate(() => {
        const a = document.querySelector('[data-testid="tg-filter-select-all"]')
        if (a) a.click()
      })
      await delay(400)
    }
    const afterToggleAll = await uiState(h.page)
    const shotFinal = path.join(OUT, 'after-toggle-all.png')
    await h.page.screenshot(shotFinal)

    const result = { before, after, afterToggleAll, cachePosts: h.st.cachePosts }
    console.log('[bug485] before :', JSON.stringify(before))
    console.log('[bug485] after  :', JSON.stringify(after))
    console.log('[bug485] toggleAll:', JSON.stringify(afterToggleAll))
    console.log('[bug485] cachePosts:', h.st.cachePosts.length, JSON.stringify(h.st.cachePosts[0] || null))

    const checks = []
    checks.push([
      `前置：默认全选 2 行（before.selectedText 含 2、两行 checked）`,
      /2/.test(String(before.selectedText)) &&
        before.rowChecks.length === 2 &&
        before.rowChecks.every((c) => c.checked === true),
    ])
    checks.push([
      `① 提交成功后选中归零、按钮禁用（after.selectedText 含 0 且 ingestDisabled）`,
      /0/.test(String(after.selectedText)) && after.ingestDisabled === true,
    ])
    checks.push([
      `② 已提交行不可勾 + 带「已提交」徽标（2 行 disabled + 2 个徽标）`,
      after.rowChecks.length === 2 &&
        after.rowChecks.every((c) => c.disabled === true && c.checked === false) &&
        after.submittedTags === 2,
    ])
    checks.push([
      `③ 全选不勾回已提交单元（toggleAll 后 selected 仍 0、无行被勾）`,
      /0/.test(String(afterToggleAll.selectedText)) &&
        afterToggleAll.rowChecks.every((c) => c.checked === false),
    ])
    checks.push([
      `④ 无重复提交：终态后强制点击/全选，cache POST 恒为 ${postsAfterIngest} 次（实得 ${h.st.cachePosts.length}）`,
      h.st.cachePosts.length === postsAfterIngest,
    ])
    let fails = 0
    for (const [name, ok] of checks) {
      console.log(`[bug485] ${ok ? 'PASS' : 'FAIL'}: ${name}`)
      if (!ok) fails++
    }
    console.log(`[bug485] summary: ${checks.length - fails}/${checks.length} PASS`)
    fs.writeFileSync(path.join(OUT, 'probe-result.json'), JSON.stringify(result, null, 2))
    process.exitCode = fails === 0 ? 0 : 1
  } finally {
    await h.stop()
    await browser.close()
  }
})().catch((e) => {
  console.error('[bug485] fatal:', e && e.message)
  process.exitCode = 2
})
