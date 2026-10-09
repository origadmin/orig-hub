'use strict'

/**
 * Request-storm probe (user report 2026-10-09):
 *   "2x 缓存了差不多整部 6 分钟片子, 且同时请求几十个 request, 前面的没回来后面的又卡住"
 *
 * Drives the REAL media-viewer component (openViewer + real speed menu) and,
 * via the CDP Network domain, records EVERY media request the browser makes:
 *   - URL (/raw direct-decode vs /stream transcode compat)
 *   - Range header (is the browser sequential head-first, or parallel-probing?)
 *   - concurrency peak (simultaneously in-flight media requests)
 *
 * Phases:
 *   A: 1x  for 20s  (decode-health verdict + /raw request pattern)
 *   B: 2x  for 30s  (compat/FRC path request pattern)
 *
 * Verdict rules (pre-declared):
 *   - "request storm"  == >12 media requests per phase OR concurrency peak > 4
 *   - "head-first"     == Range starts are monotonic non-decreasing per connection
 *                          generation (allowing the moov tail-probe at start)
 *   - the phase that storms tells us WHICH path must be fixed.
 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

// Resolved at runtime from daemon /api/config (tg_port drifts -- never hard-code).
let APP = ''
let TG = ''
let isTg = () => false
const ITEM = 673
const PHASE_A_MS = 20000
const PHASE_B_MS = 30000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openItem(page, itemId) {
  const src = `${TG}/api/media/items/${itemId}/raw`
  await page.evaluate(
    (url, it) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${it}`,
            chatId: 0,
            messageId: it,
            kind: 'video',
            caption: '',
            description: null,
            src: url,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: '',
      })
    },
    src,
    itemId,
  )
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        return !!v && v.videoWidth > 0 && v.readyState >= 2
      },
      { timeout: 25000, intervalMs: 250 },
    )
  } catch (_e) {
    const st = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      const viewer = window.__origStore && window.__origStore.getState().viewer
      return {
        viewer: !!document.querySelector('[data-testid="media-viewer"]'),
        storeViewer: viewer ? { idx: viewer.index, n: viewer.items.length, items: viewer.items.map((x) => ({ k: x.key, m: x.messageId })) } : null,
        v: !!v,
        readyState: v ? v.readyState : null,
        vw: v ? v.videoWidth : null,
        src: v ? String(v.currentSrc).slice(-70) : null,
        err: v && v.error ? v.error.code : null,
      }
    })
    throw new Error(`openItem settle failed: ${JSON.stringify(st)}`)
  }
}

async function setRate(page, target) {
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid="media-viewer"] button')].find((x) =>
      /^\d+(\.\d+)?x$/.test((x.textContent || '').trim()),
    )
    if (!b) return false
    b.click()
    return true
  })
  if (!opened) return false
  await delay(250)
  await page.evaluate((t) => {
    const items = [...document.querySelectorAll('[data-testid="media-viewer"] [role="menuitemradio"]')]
    const it = items.find((el) => (el.textContent || '').trim().startsWith(`${t}x`))
    if (it) it.click()
  }, target)
  await page
    .waitForFunction(
      (t) => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (!v) return false
        const cs = Number(v.dataset?.contentSpeed || '1')
        return v.videoWidth > 0 && v.readyState >= 2 && cs === t
      },
      { timeout: 25000, intervalMs: 250 },
      target,
    )
    .catch(() => {})
  await delay(800)
  return true
}

/** Summarise one phase's captured requests. */
function summarize(reqs, label) {
  const media = reqs.filter((r) => /\/api\/(media|tg)\//.test(r.url))
  const byUrl = {}
  for (const r of media) {
    const u = new URL(r.url)
    const key = u.pathname.replace(/^\/api\//, '') + (u.search || '')
    byUrl[key] = (byUrl[key] || 0) + 1
  }
  // concurrency over wall-clock buckets of 1s
  let peak = 0
  if (media.length) {
    const t0 = media[0].ts
    const buckets = new Map()
    for (const r of media) {
      const sec = Math.floor(r.ts - t0)
      buckets.set(sec, (buckets.get(sec) || 0) + 1)
    }
    peak = Math.max(...buckets.values())
  }
  const ranges = media.filter((r) => r.range).map((r) => {
    const m = /bytes=(\d+)/.exec(r.range)
    return m ? Number(m[1]) : null
  })
  let monotonic = true
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i] !== null && ranges[i - 1] !== null && ranges[i] < ranges[i - 1]) {
      monotonic = false
      break
    }
  }
  console.log(`\n=== PHASE ${label}: ${media.length} media requests, per-second peak=${peak}, range-start monotonic=${monotonic} ===`)
  for (const [k, n] of Object.entries(byUrl).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}x  ${k}`)
  }
  if (ranges.length) {
    const head = ranges.slice(0, 14).map((x) => (x === null ? 'none' : x)).join(', ')
    console.log(`  first range starts: [${head}${ranges.length > 14 ? ' ...' : ''}]`)
    console.log(`  last range start:   ${ranges[ranges.length - 1]}`)
  }
  const storm = media.length > 12 || peak > 4
  console.log(`  -> storm=${storm ? 'YES' : 'no'} (rule: >12 reqs or per-sec peak>4)`)
  return { count: media.length, peak, monotonic, storm }
}

async function main() {
  const ep = await endpoints.resolve()
  APP = ep.app
  TG = ep.tg
  isTg = ep.isTg

  const browser = await cdp.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitUntil: 'load' })
    await delay(1500)

    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    const records = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      records.push({
        ts: p.timestamp,
        url: p.request.url,
        range: p.request.headers.Range || p.request.headers.range || '',
        type: p.type || '',
        init: (p.initiator && p.initiator.type) || '',
      })
    })

    // ---- Phase A: 1x ----
    await openItem(page, ITEM)
    await delay(2000)
    const markA = records.length
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (v) { v.muted = true; v.play().catch(() => {}) }
    })
    await delay(PHASE_A_MS)
    const sumA = summarize(records.slice(markA), `A 1x (${PHASE_A_MS / 1000}s)`)
    // Wrong port => zero captured TG traffic; fail loudly instead of "no storm".
    ep.assertTgTraffic(records.slice(markA).filter((r) => isTg(r.url)).length, 'phase A 1x')

    // ---- Phase B: 2x ----
    const markB = records.length
    await setRate(page, 2)
    await delay(PHASE_B_MS)
    const vState = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return null
      return {
        src: v.currentSrc,
        contentSpeed: v.dataset?.contentSpeed || '1',
        rate: v.playbackRate,
        bufAhead: v.buffered.length ? +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1) : 0,
        dur: +Number(v.duration || 0).toFixed(1),
      }
    })
    const sumB = summarize(records.slice(markB), `B 2x (${PHASE_B_MS / 1000}s)`)

    console.log('\n=== video state after phase B ===')
    console.log(JSON.stringify(vState, null, 2))

    console.log('\n=== VERDICT ===')
    console.log(`A(1x): requests=${sumA.count} peak=${sumA.peak} monotonic=${sumA.monotonic} storm=${sumA.storm}`)
    console.log(`B(2x): requests=${sumB.count} peak=${sumB.peak} monotonic=${sumB.monotonic} storm=${sumB.storm}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e && e.message)
  process.exit(1)
})
