'use strict'
/**
 * TG 面板状态诊断（BUG-361 取证）：为什么「文字筛选」是空的、`alive` 是否为真。
 *
 * 只做取证：真实渲染 + 页面内 fetch 复算 + DOM 实况，不改产品。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    // 有界等待筛选节渲染（规则由 API 异步到达）
    let waited = 0
    while (waited < 20000) {
      const n = await page.evaluate(
        () => document.querySelectorAll('[data-testid="tg-filter-row"]').length,
      )
      if (n > 0) break
      await sleep(500)
      waited += 500
    }
    const st = await page.evaluate(async () => {
      const q = (s) => document.querySelectorAll(s).length
      const txt = (s) => {
        const el = document.querySelector(s)
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : null
      }
      // 页面内复算：同一个源、同一个端口（绕开 Node 侧网络差异）
      let filters = null
      let health = null
      try {
        const r = await fetch('http://127.0.0.1:19787/api/tg/monitor/filters')
        filters = { status: r.status, body: (await r.text()).slice(0, 300) }
      } catch (e) {
        filters = { err: String(e) }
      }
      try {
        const r = await fetch('http://127.0.0.1:19787/health')
        health = { status: r.status, body: (await r.text()).slice(0, 200) }
      } catch (e) {
        health = { err: String(e) }
      }
      return {
        filterRows: q('[data-testid="tg-filter-row"]'),
        filterListText: txt('[data-testid="tg-filter-list"]'),
        monitorListText: txt('[data-testid="tg-monitor-list"]'),
        ingestStatus: txt('[data-testid="tg-ingest-status"]'),
        ingestUnavailable: q('[data-testid="tg-ingest-unavailable"]'),
        contextBar: txt('[data-testid="context-bar"]'),
        filters,
        health,
      }
    })
    console.log(JSON.stringify(st, null, 1))
    console.log(`waitedMs=${waited}`)
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('DIAG CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
