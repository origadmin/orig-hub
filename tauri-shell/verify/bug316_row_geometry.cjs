'use strict'

/**
 * BUG-316 段② 行几何测量（CDP / Edge，零依赖）。
 * 量 FileRow / IngestGroupRow 的实际高度、均匀性、展开增量，为窗口化定参。
 */

const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

const PAGE_JS = `
window.__m = {
  rows(sels) {
    const out = {}
    for (const [k, s] of Object.entries(sels)) {
      const els = [...document.querySelectorAll(s)]
      out[k] = {
        n: els.length,
        h: els.slice(0, 5).map((e) => Math.round(e.getBoundingClientRect().height)),
      }
    }
    return out
  },
  click(sel) {
    const el = document.querySelector(sel)
    if (!el) return 'MISSING'
    el.click()
    return 'ok'
  },
  scrollTop(sel) {
    const el = document.querySelector(sel)
    return el ? el.scrollTop : -1
  },
}
`

;(async () => {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await sleep(2500)
    await page.evaluate(PAGE_JS)

    // 文件视图：FileRow 几何
    await page.evaluate(`window.__m.click('[data-testid="nav-files"]')`)
    await sleep(2500)
    const fileGeom = await page.evaluate(`window.__m.rows({
      fileRow: '[data-testid="file-list-row"]',
      header: '[data-testid="file-list-header"]',
    })`)
    console.log('file view geometry:', JSON.stringify(fileGeom))

    // 下载视图：组行几何（折叠态）
    await page.evaluate(`window.__m.click('[data-testid="nav-download"]')`)
    await sleep(2500)
    const dlGeom = await page.evaluate(`window.__m.rows({
      group: '[data-testid="ingest-group-row"]',
      header: '[data-testid="ingest-group-header"]',
      engine: '[data-testid="download-item"]',
    })`)
    console.log('download view geometry (collapsed):', JSON.stringify(dlGeom))

    // 展开第一个组：量展开增量
    await page.evaluate(`window.__m.click('[data-testid="ingest-group-toggle"]')`)
    await sleep(600)
    const dlGeomOpen = await page.evaluate(`window.__m.rows({
      group: '[data-testid="ingest-group-row"]',
      entry: '[data-testid="ingest-group-entry"]',
    })`)
    console.log('download view geometry (first expanded):', JSON.stringify(dlGeomOpen))

    // 量渲染成本：文件视图滚动到底再回顶（强制重排）
    await page.evaluate(`window.__m.click('[data-testid="nav-files"]')`)
    await sleep(2000)
    const t0 = Date.now()
    await page.evaluate(`
      window.__lt = []
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] })
      const sc = document.querySelector('[data-testid="file-list-scroll"]')
      sc.scrollTop = sc.scrollHeight
    `)
    await sleep(800)
    const ltScroll = await page.evaluate('window.__lt')
    console.log('file list scroll-to-bottom longtasks:', JSON.stringify(ltScroll), 'wall~', Date.now() - t0)
  } finally {
    await browser.close()
  }
})().catch((e) => { console.error(e); process.exit(1) })
