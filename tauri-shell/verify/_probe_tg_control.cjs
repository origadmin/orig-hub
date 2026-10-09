'use strict'
/**
 * 对照 + 方法分解：进入一个**非监控**频道（经左栏「全部订阅」→ 点频道名，只 setSelectedId，
 * 不写监控），30s 内按 HTTP 方法（OPTIONS 预检 vs GET 实体）与端点族分解请求量。
 * 用于对照「每日沙雕墙」并验证 CORS 预检翻倍假设。
 * 用法：node _probe_tg_control.cjs "麻豆短剧"
 */
const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

// Resolved at runtime from daemon /api/config (tg_port drifts -- never hard-code).
let APP = ''
let TG = ''
let isTgApi = () => false

const TARGET = process.argv[2] || '麻豆短剧'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const fam = (u) => { try { const x = new URL(u); return x.pathname.split('?')[0].replace(/\/api\/tg\/thumb\/[^/]+\/[^/]+/, '/api/tg/thumb/{c}/{m}').replace(/\/api\/tg\/file\/[^/]+\/[^/]+/, '/api/tg/file/{c}/{m}').replace(/\/api\/tg\/local\/[^/]+\/[^/]+/, '/api/tg/local/{c}/{m}').replace(/\/api\/tg\/messages\/[^/]+/, '/api/tg/messages/{c}').replace(/\/api\/tg\/downloaded\/[^/]+/, '/api/tg/downloaded/{c}') } catch { return u } }

async function openPanel(page) {
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => { const b = document.querySelector('[data-testid="nav-tg"]'); if (b) b.click() }).catch(() => {})
    const ok = await page.waitForFunction(() => {
      const a = document.querySelector('[data-testid="tg-panel-root"] aside')
      return !!a && a.querySelectorAll('button').length > 0
    }, { timeout: 8000, intervalMs: 300 }).then(() => true).catch(() => false)
    if (ok) return true
    await delay(1500)
  }
  return false
}

async function main() {
  const ep = await endpoints.resolve()
  APP = ep.app
  TG = ep.tg
  isTgApi = ep.isTg

  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto(APP + '/', { settleMs: 3000 })
  if (!(await openPanel(page))) throw new Error('panel not opened')
  // 等频道列表（「全部订阅N」）载入：轮询直到计数 > 0
  let secLabel = null
  for (let i = 0; i < 15; i++) {
    await delay(2000)
    secLabel = await page.evaluate(() => {
      const a = document.querySelector('[data-testid="tg-panel-root"] aside')
      const b = [...a.querySelectorAll('button')].find((x) => /全部订阅|All/.test(x.textContent || ''))
      return b ? (b.textContent || '').trim() : null
    })
    const n = secLabel ? Number((secLabel.match(/(\d+)\s*$/) || [])[1] || 0) : 0
    if (n > 0) break
  }
  console.log('[sections loaded]', secLabel)

  const recs = []
  page.conn.on('Network.requestWillBeSent', (p) => recs.push({ url: p.request.url, method: p.request.method, ts: p.wallTime || p.timestamp }))

  // 点「全部订阅」section
  const sec = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="tg-panel-root"] aside')
    const b = [...a.querySelectorAll('button')].find((x) => /全部订阅|All/.test(x.textContent || ''))
    if (b) { b.click(); return (b.textContent || '').trim() }
    return null
  })
  console.log('[section]', sec)
  await delay(2500)

  // 点目标频道名（进入非监控频道）—— 组内频道列表在**中栏**，不在 aside
  const clicked = await page.evaluate((t) => {
    const root = document.querySelector('[data-testid="tg-panel-root"]')
    const btns = [...root.querySelectorAll('button')]
    const btn = btns.find((b) => {
      const p = b.querySelector('p')
      return p && (p.textContent || '').trim() === t
    })
    if (!btn) return false
    btn.click()
    return true
  }, TARGET)
  console.log('[click control]', TARGET, clicked)
  if (!clicked) {
    const names = await page.evaluate(() => [...document.querySelectorAll('[data-testid="tg-panel-root"] p.truncate')].map((p) => p.textContent.trim()).slice(0, 40))
    console.log('[available]', JSON.stringify(names))
    await browser.close(); return
  }
  const m = recs.length
  await delay(30000)
  const win = recs.slice(m).filter((r) => isTgApi(r.url))
  ep.assertTgTraffic(win.length, `对照频道「${TARGET}」30s 窗口`)
  const byMethod = {}
  const byFam = {}
  const byFamMethod = {}
  for (const r of win) {
    byMethod[r.method] = (byMethod[r.method] || 0) + 1
    byFam[fam(r.url)] = (byFam[fam(r.url)] || 0) + 1
    const k = `${r.method} ${fam(r.url)}`
    byFamMethod[k] = (byFamMethod[k] || 0) + 1
  }
  const dom = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="tg-panel-root"]')
    return { imgs: root ? root.querySelectorAll('img').length : 0, tiles: root ? root.querySelectorAll('[data-testid="tg-photo-preview"],[data-testid^="tg-album-tile-"]').length : 0 }
  })
  console.log(`[control 30s] /api=${win.length}  DOM ${JSON.stringify(dom)}`)
  console.log('[by method]', JSON.stringify(byMethod))
  console.log('[by family]', JSON.stringify(byFam))
  console.log('[by method+family]', JSON.stringify(byFamMethod))
  await browser.close()
}
main().catch((e) => { console.error('FAIL', e && e.message); process.exit(1) })
