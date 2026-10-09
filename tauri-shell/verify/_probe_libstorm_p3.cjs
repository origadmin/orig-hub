'use strict'
/**
 * Focused P3: does switching away from the media library and back re-fire the
 * first-screen request set? (The first big run clicked `all-files-row`, which is
 * a non-interactive <div> at Sidebar.tsx:230 -> that run's P3 was a no-op.)
 * Here we switch away via `nav-tg` (a real button) and back via `nav-media`.
 */
const cdp = require('./lib/cdp.cjs')
const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function group(reqs) {
  const m = new Map()
  for (const r of reqs) {
    let k
    try { const u = new URL(r.url); k = u.origin === TG ? u.pathname + u.search : u.origin + u.pathname } catch { k = r.url }
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

async function click(page, id) {
  return page.evaluate((x) => { const b = document.querySelector(`[data-testid="${x}"]`); if (!b) return false; b.click(); return true }, id)
}

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto(APP, { waitUntil: 'load' })
  await delay(2500)
  await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
  const rec = []
  page.conn.on('Network.requestWillBeSent', (p) => {
    if (!p.request.url.startsWith('data:') && !p.request.url.startsWith('blob:')) rec.push({ url: p.request.url })
  })

  const a = rec.length
  await click(page, 'nav-media'); await delay(7000)
  const p1 = rec.slice(a)
  console.log('ENTRY#1 TG-reqs:', group(p1.filter((r) => r.url.startsWith(TG))).map(([k, n]) => `${n}x ${k}`).join(' | ') || '(none)')

  const b = rec.length
  const okAway = await click(page, 'nav-tg'); await delay(2500)
  const okBack = await click(page, 'nav-media'); await delay(7000)
  const p3 = rec.slice(b)
  const media3 = p3.filter((r) => r.url.startsWith(TG))
  console.log(`SWITCH-AWAY(ok=${okAway})->BACK(ok=${okBack}) TG-reqs:`, group(media3).map(([k, n]) => `${n}x ${k}`).join(' | ') || '(none)')

  const dom = await page.evaluate(() => ({
    seriesCards: document.querySelectorAll('[data-testid="series-card"]').length,
    offline: !!document.body.textContent.includes('媒体库') && !!document.querySelector('[data-testid="media-panel-title"]'),
  }))
  console.log('DOM after re-entry:', JSON.stringify(dom))
  await browser.close()
}
main().catch((e) => { console.error('FAIL', e && e.message); process.exit(1) })
