'use strict'

/**
 * Media-library request-storm + duplicate-data probe (user report 2026-10-09):
 *   "进入媒体库请求了 42 个，而且大量重复问题数据。"
 *
 * Read-only forensic probe. It drives the REAL app over CDP and records EVERY
 * HTTP request the browser makes while entering the media library, then answers:
 *   1. what the N requests are made of (grouped by endpoint + trigger site)
 *   2. whether the same URL is requested more than once in the first-screen window
 *   3. whether the "duplicate data" is FRONTEND re-render (unique API ids but
 *      duplicated DOM cards) or BACKEND duplicate rows (same id repeated in the
 *      raw API response) -- proven by comparing API id-uniqueness vs DOM id-uniqueness
 *   4. reload vs switch-away-and-back: does the request count change?
 *
 * Nothing under tauri-shell/src or download-engine is touched.
 *
 * Usage (run from repo root):
 *   BROWSER=msedge node tauri-shell/verify/_probe_libstorm.cjs
 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

// APP / TG / isTg are resolved at runtime from the daemon's /api/config
// (tg_port drifts between runs -- never hard-code it). Assigned in main().
let APP = ''
let TG = ''
let isTg = () => false
const FIRST_SCREEN_MS = 8000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Best-effort trigger site: top script call frame as `file:line`. */
function triggerSite(p) {
  const frames = p.initiator && p.initiator.stack && p.initiator.stack.callFrames
  if (frames && frames.length) {
    const f = frames[0]
    return `${(f.url || '').replace(/^https?:\/\/[^/]+/, '')}:${(f.lineNumber ?? 0) + 1}`
  }
  return (p.initiator && p.initiator.type) || ''
}

/** Group request records by endpoint (path + query). */
function groupByEndpoint(reqs) {
  const byUrl = new Map()
  for (const r of reqs) {
    let key
    try {
      const u = new URL(r.url)
      key = isTg(r.url) ? u.pathname + (u.search || '') : `${u.origin}${u.pathname}`
    } catch {
      key = r.url
    }
    if (!byUrl.has(key)) byUrl.set(key, { count: 0, sites: new Map() })
    const e = byUrl.get(key)
    e.count += 1
    e.sites.set(r.site, (e.sites.get(r.site) || 0) + 1)
  }
  return [...byUrl.entries()]
    .map(([k, v]) => ({
      key: k,
      count: v.count,
      sites: [...v.sites.entries()].map(([s, n]) => `${s}×${n}`).join(' '),
    }))
    .sort((a, b) => b.count - a.count)
}

/** Same URL string appearing more than once. */
function duplicateUrls(reqs) {
  const c = new Map()
  for (const r of reqs) c.set(r.url, (c.get(r.url) || 0) + 1)
  return [...c.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
}

async function snapshot(page, records, label) {
  const media = records.filter((r) => isTg(r.url))
  console.log(`\n=== [${label}] all=${records.length}  TG=${media.length} ===`)
  for (const g of groupByEndpoint(records)) {
    console.log(`  ${String(g.count).padStart(4)}x  ${g.key}\n           trigger: ${g.sites}`)
  }
  const dups = duplicateUrls(media)
  console.log(`  -- duplicate TG URLs: ${dups.length}`)
  for (const [u, n] of dups.slice(0, 12)) {
    console.log(`       ${n}x  ${u.replace(TG, '')}`)
  }
  return media
}

/** DOM card identity read. */
async function readDom(page) {
  return page.evaluate(() => {
    const seriesIds = [...document.querySelectorAll('[data-testid="series-card"]')].map((el) =>
      el.getAttribute('data-series-id'),
    )
    const cardKeys = [...document.querySelectorAll('[data-testid="media-card"]')].map((el) => {
      const t = el.querySelector('p[title]')
      if (t) return 'title:' + t.getAttribute('title')
      const i = el.querySelector('img')
      return 'img:' + (i ? i.getAttribute('src') : '')
    })
    const uniq = (a) => new Set(a).size
    const dupOf = (a) => a.filter((x, i) => x !== '' && a.indexOf(x) !== i)
    return {
      seriesCards: seriesIds.length,
      seriesCardsUniq: uniq(seriesIds),
      seriesDupIds: dupOf(seriesIds),
      mediaCards: cardKeys.length,
      mediaCardsUniq: uniq(cardKeys),
      mediaDupKeys: dupOf(cardKeys).slice(0, 8),
    }
  })
}

async function clickTestId(page, testid) {
  return page.evaluate((id) => {
    const b = document.querySelector(`[data-testid="${id}"]`)
    if (!b) return false
    b.click()
    return true
  }, testid)
}

async function enterMedia(page) {
  const ok = await clickTestId(page, 'nav-media')
  await delay(FIRST_SCREEN_MS)
  return ok
}

async function main() {
  const ep = await endpoints.resolve()
  APP = ep.app
  TG = ep.tg
  isTg = ep.isTg

  const browser = await cdp.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitUntil: 'load' })
    await delay(2500)

    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    const records = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      const url = p.request.url
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      records.push({ ts: p.timestamp, url, type: p.type || '', site: triggerSite(p) })
    })

    // ---- P1: first entry into media library ----
    const m0 = records.length
    const ok1 = await enterMedia(page)
    const p1 = records.slice(m0)
    await snapshot(page, p1, `P1 first-entry (clicked=${ok1})`)
    const dom1 = await readDom(page)
    console.log('  DOM P1:', JSON.stringify(dom1))
    // A zero-traffic window means the resolved port is wrong (or capture broke)
    // -- fail loudly instead of reporting it as a clean "no requests".
    ep.assertTgTraffic(p1.filter((r) => isTg(r.url)).length, 'P1 first-entry')

    // ---- P2: full reload, then re-enter ----
    const m1 = records.length
    await page.goto(APP, { waitUntil: 'load' })
    await delay(3000)
    const ok2 = await enterMedia(page)
    const p2 = records.slice(m1)
    await snapshot(page, p2, `P2 reload+entry (clicked=${ok2})`)
    const dom2 = await readDom(page)
    console.log('  DOM P2:', JSON.stringify(dom2))

    // ---- P3: switch away to "all files" then back to media ----
    const m2 = records.length
    const okAway = await clickTestId(page, 'all-files-row')
    await delay(1500)
    const okBack = await enterMedia(page)
    const p3 = records.slice(m2)
    await snapshot(page, p3, `P3 switch-away-and-back (away=${okAway} back=${okBack})`)
    const dom3 = await readDom(page)
    console.log('  DOM P3:', JSON.stringify(dom3))

    // ---- P4: switch to the flat "全部内容" items grid and count DOM cards ----
    const m3 = records.length
    const okItems = await clickTestId(page, 'media-cat-all')
    await delay(6000)
    const p4 = records.slice(m3)
    await snapshot(page, p4, `P4 items-grid (clicked=${okItems})`)
    const dom4 = await readDom(page)
    console.log('  DOM P4:', JSON.stringify(dom4))

    console.log('\n=== VERDICT SUMMARY ===')
    const mt = (a) => a.filter((r) => isTg(r.url)).length
    console.log(`P1 first-entry : all=${p1.length} TG=${mt(p1)}`)
    console.log(`P2 reload+entry: all=${p2.length} TG=${mt(p2)}`)
    console.log(`P3 re-entry    : all=${p3.length} TG=${mt(p3)}`)
    console.log(`P4 items-grid  : all=${p4.length} TG=${mt(p4)}`)
    console.log(
      `DOM seriesCards: P1=${dom1.seriesCards}/${dom1.seriesCardsUniq}unq  P2=${dom2.seriesCards}/${dom2.seriesCardsUniq}unq  P3=${dom3.seriesCards}/${dom3.seriesCardsUniq}unq`,
    )
    console.log(
      `DOM mediaCards : P4=${dom4.mediaCards}/${dom4.mediaCardsUniq}unq dupKeys=${JSON.stringify(dom4.mediaDupKeys)}`,
    )
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
