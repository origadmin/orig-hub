'use strict'

/**
 * 追加取证：进入「每日沙雕墙」后，反复「滚到顶」加载更早历史，
 * 量化每页（30 条消息）的请求成本与重复率，用于判断 1000+ 是否由翻页线性累积。
 * 只读：仅驱动真实 UI 滚动。
 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

// Resolved at runtime from daemon /api/config (tg_port drifts -- never hard-code).
let APP = ''
let TG = ''
let isTgApi = () => false

const TITLE = process.argv[2] || '每日沙雕墙'
const PAGES = Number(process.argv[3] || 6)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const pathKey = (u) => { try { const x = new URL(u); return x.pathname + (x.search || '') } catch { return u } }
const fam = (u) => pathKey(u).split('?')[0]
  .replace(/\/api\/tg\/thumb\/[^/]+\/[^/]+/, '/api/tg/thumb/{c}/{m}')
  .replace(/\/api\/tg\/file\/[^/]+\/[^/]+/, '/api/tg/file/{c}/{m}')
  .replace(/\/api\/tg\/local\/[^/]+\/[^/]+/, '/api/tg/local/{c}/{m}')
  .replace(/\/api\/media\/items\/[^/]+\/raw/, '/api/media/items/{id}/raw')
  .replace(/\/api\/tg\/messages\/[^/]+/, '/api/tg/messages/{c}')
  .replace(/\/api\/tg\/downloaded\/[^/]+/, '/api/tg/downloaded/{c}')

function famCounts(rs) { const m = {}; for (const r of rs) m[fam(r.url)] = (m[fam(r.url)] || 0) + 1; return m }

async function main() {
  const ep = await endpoints.resolve()
  APP = ep.app
  TG = ep.tg
  isTgApi = ep.isTg

  const browser = await cdp.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.goto(APP, { settleMs: 2000 })
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    const records = []
    page.conn.on('Network.requestWillBeSent', (p) => records.push({ ts: p.wallTime || p.timestamp, url: p.request.url }))

    await page.evaluate(() => { const b = document.querySelector('[data-testid="nav-tg"]'); if (b) b.click() })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), { timeout: 20000, intervalMs: 250 })
    await delay(5000)
    const mountApi = records.filter((r) => isTgApi(r.url))
    console.log(`[mount] /api=${mountApi.length}`, JSON.stringify(famCounts(mountApi)))
    ep.assertTgTraffic(mountApi.length, 'TG 面板挂载')
    const beforeScroll = records.length

    // 反复滚到顶，每次触发一页 loadOlder
    for (let i = 0; i < PAGES; i++) {
      const m = records.length
      await page.evaluate(() => {
        const root = document.querySelector('[data-testid="tg-panel-root"]')
        const el = [...root.querySelectorAll('div')].find(
          (d) => d.scrollHeight > d.clientHeight + 50 && d.querySelector('[data-testid="tg-photo-preview"],[data-testid^="tg-album-tile-"]'),
        )
        if (el) el.scrollTop = 0
      })
      await delay(2600)
      const pageApi = records.slice(m).filter((r) => isTgApi(r.url))
      const dom = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="tg-panel-root"]')
        return { imgs: root ? root.querySelectorAll('img').length : 0, bubbles: root ? root.querySelectorAll('[data-testid="tg-photo-preview"],[data-testid^="tg-album-tile-"]').length : 0 }
      })
      console.log(`[scroll ${i + 1}] 本页新增 /api=${pageApi.length}  DOM imgs=${dom.imgs} tiles/photos=${dom.bubbles}  ${JSON.stringify(famCounts(pageApi))}`)
    }

    const allApi = records.filter((r) => isTgApi(r.url))
    const afterScroll = records.slice(beforeScroll).filter((r) => isTgApi(r.url))
    console.log(`\n[total] mount+scroll /api=${allApi.length}  scroll-only /api=${afterScroll.length}`)
    console.log(`[total 端点族] ${JSON.stringify(famCounts(allApi))}`)
    const uc = {}; for (const r of allApi) uc[r.url] = (uc[r.url] || 0) + 1
    const dups = Object.entries(uc).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
    console.log(`[重复 URL] ${dups.length} 个; Top8: ${dups.slice(0, 8).map(([u, n]) => n + 'x ' + pathKey(u)).join(' | ')}`)
  } finally {
    await browser.close()
  }
}
main().catch((e) => { console.error('PROBE FAILED:', e && e.message); process.exit(1) })
