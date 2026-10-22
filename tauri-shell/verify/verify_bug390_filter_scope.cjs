#!/usr/bin/env node
/**
 * BUG-390 验收探针：文字筛选命中数的作用域可见性。
 *
 * 用户 2026-10-23 原话：「数据全空了」——实际是命中数只统计「监控中」频道
 * （store.rs count_filter_hits JOIN monitored_channel，单测
 * filter_ignores_unmonitored_channels 钉死），监控列表为空时全部关键词恒 0。
 *
 * 修法：无监控频道且存在筛选规则时渲染 `tg-filter-scope-hint` 作用域提示。
 *
 * 判据：
 *   S1（stub：/api/tg/monitor/channels → []，经 URL 参数 ?probe390=1 门控）
 *      提示可见、文本说明「监控」，且筛选规则行 > 0（规则来自真实端点，
 *      证明「有规则 + 无监控」前提成立）。
 *   S2（验牙：同页去参重载 → stub 失活，真实 1 频道）
 *      提示**不渲染**且监控行 > 0 —— 证明提示不是常驻噪音、由数据驱动。
 *
 * 只读：不增删任何监控频道/规则。截图落 evidence/BUG-390/。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-390')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 仅当 URL 带 probe390=1 时把监控列表 stub 成空数组（参数门控，验牙即去参）。 */
const STUB = `
(function () {
  if (!location.search.includes('probe390=1')) return
  const orig = window.fetch.bind(window)
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    if (url.includes('/api/tg/monitor/channels') && method === 'GET') {
      return Promise.resolve(new Response(JSON.stringify([]), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }
    return orig(input, init)
  }
})()
`

async function openTg(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await sleep(4500)
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="tg-panel-root"]')
    const btn = root && root.querySelector('[data-testid="filter-collapse-toggle"]')
    const state = btn && btn.getAttribute('aria-expanded')
    if (btn && state === 'false') btn.click()
  })
  await sleep(2000)
}

async function readState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="tg-panel-root"]')
    if (!root) return { root: false }
    const hint = root.querySelector('[data-testid="tg-filter-scope-hint"]')
    const rows = root.querySelectorAll('[data-testid="tg-filter-row"]').length
    const monRows = root.querySelectorAll('[data-testid="tg-monitor-row"]').length
    const monEmpty = /暂无监控频道|No monitored/.test(root.innerText || '')
    return {
      root: true,
      rows,
      monRows,
      monEmpty,
      hint: hint
        ? { text: (hint.textContent || '').trim(), visible: hint.offsetParent !== null }
        : null,
    }
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    // 参数门控的 stub 必须在**每次文档创建前**挂上，才能在首屏拉数据时生效。
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB }, { sessionId: page.sessionId })

    // ---- S1：stub（无监控频道）→ 提示可见 ----
    await page.goto('http://127.0.0.1:5180/?probe390=1', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
    await sleep(3000)
    await openTg(page)
    const s1 = await readState(page)
    check('S1 前提：筛选规则行 > 0（规则来自真实端点，未被 stub）', s1.root && s1.rows > 0, `rows=${s1.rows}`)
    check(
      'S1 无监控频道时作用域提示可见且说明「监控」',
      Boolean(s1.hint && s1.hint.visible && /监控|monitored/i.test(s1.hint.text)),
      s1.hint ? `text=${s1.hint.text.slice(0, 40)}…` : 'hint missing',
    )
    check('S1 stub 生效：监控区为空态', s1.monEmpty || s1.monRows === 0, `monRows=${s1.monRows} empty=${s1.monEmpty}`)
    await page.screenshot(path.join(OUT, '01-scope-hint-empty-monitors.png'))

    // ---- S2（验牙）：去参重载 → stub 失活 → 真实 1 频道 → 提示不渲染 ----
    await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
    await sleep(3000)
    await openTg(page)
    const s2 = await readState(page)
    check('S2 前提：真实监控行 > 0（stub 已失活）', s2.root && s2.monRows > 0, `monRows=${s2.monRows}`)
    check(
      'S2 有监控频道时提示不渲染（非常驻噪音）',
      s2.hint === null,
      s2.hint ? `unexpected hint: ${s2.hint.text.slice(0, 30)}` : 'hint absent',
    )
    await page.screenshot(path.join(OUT, '02-no-hint-with-monitors.png'))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`RESULT ${results.length - failed.length}/${results.length} PASS`)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
