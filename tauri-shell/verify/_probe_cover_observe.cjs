'use strict'

/**
 * BUG-239 (untracked working probe): observe cover-extraction requests on the
 * items grid, plus the in-page budget stats. Prints raw request URLs and the
 * mounted/visible card counts so we can see WHY the grid does/doesn't extract.
 *
 *   node tauri-shell/verify/_probe_cover_observe.cjs
 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function triggerSite(p) {
  const frames = p.initiator && p.initiator.stack && p.initiator.stack.callFrames
  if (frames && frames.length) {
    const f = frames[0]
    return `${(f.url || '').replace(/^https?:\/\/[^/]+/, '')}:${(f.lineNumber ?? 0) + 1}`
  }
  return (p.initiator && p.initiator.type) || ''
}

const clickTestId = (page, id) =>
  page.evaluate((tid) => {
    const b = document.querySelector(`[data-testid="${tid}"]`)
    if (!b) return false
    b.click()
    return true
  }, id)

async function geometry(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
    const vh = window.innerHeight
    const M = 200
    let visible = 0
    for (const c of cards) {
      const r = c.getBoundingClientRect()
      if (r.bottom >= -M && r.top <= vh + M && r.right >= 0 && r.left <= window.innerWidth) visible++
    }
    const stats = window.__origPoster ? window.__origPoster.stats() : null
    return { mounted: cards.length, visible, stats }
  })
}

async function main() {
  const ep = await endpoints.resolve()
  const browser = await cdp.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.goto(ep.app, { waitUntil: 'load' })
    await delay(2500)
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    const records = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      const url = p.request.url
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      records.push({ url, site: triggerSite(p) })
    })

    await clickTestId(page, 'nav-media')
    await delay(2500)
    await clickTestId(page, 'media-cat-all')
    await delay(8000)

    const raw = records.filter((r) => ep.isTg(r.url) && /\/raw(\?|$)/.test(r.url))
    console.log('\n=== raw requests on items grid ===')
    for (const r of raw) console.log(`  ${r.url.replace(ep.tg, '')}  <- ${r.site}`)
    console.log(`  total raw = ${raw.length}`)
    console.log(`  unique raw ids = ${new Set(raw.map((r) => r.url)).size}`)
    const geo = await geometry(page)
    console.log('  geometry:', JSON.stringify(geo))
    console.log('  all TG during window:', records.filter((r) => ep.isTg(r.url)).length)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
