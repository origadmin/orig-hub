'use strict'
// Probe: find the playback-rate limit. Plays item via /stream (or /raw) at 2x, 4x, 8x
// sequentially (10s each), sampling presented/dropped frame deltas, buffer-ahead drain,
// stalls (readyState<3), longtasks, and media requests per phase.
const fs = require('fs')
const path = require('path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const OUT = process.env.ORIG_VERIFY_OUT || path.join(__dirname, '..', '..', 'verify_shots', 'probe_playback_smooth')
const ITEM = Number(process.env.PROBE_ITEM || 472)
const KIND = process.env.PROBE_SRC || 'stream' // stream | raw
const RATES = [2, 4, 8]
const SECS = 10
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 15000 })

    await page.evaluate(() => {
      window.__probe = { longtasks: [], t0: performance.now() }
      try {
        const po = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__probe.longtasks.push(Math.round(e.duration))
        })
        po.observe({ type: 'longtask', buffered: true })
      } catch (_e) {}
    })

    const srcUrl = process.env.PROBE_URL || `${TG}/api/media/items/${ITEM}/${KIND}`
    await page.evaluate((tg, item, kind, url) => {
      window.__origStore.getState().openViewer({
        items: [{ key: item, chatId: -100, messageId: item, kind: 'video', caption: '', description: '', src: url, poster: null, episodeNo: null, seriesId: null }],
        index: 0,
        title: '',
      })
    }, TG, ITEM, KIND, srcUrl)

    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return !!v && v.readyState >= 2
    }, { timeout: 30000 })
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (v) { v.muted = true; v.volume = 0; v.play().catch(() => {}) }
    })
    await delay(1500) // let 1x settle

    const snap = () => page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return null
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      const b = v.buffered
      return {
        cur: v.currentTime,
        ready: v.readyState,
        presented: q ? q.totalVideoFrames : 0,
        dropped: q ? q.droppedVideoFrames : 0,
        ahead: b.length ? b.end(b.length - 1) - v.currentTime : 0,
        rate: v.playbackRate,
      }
    })

    const phases = []
    for (const rate of RATES) {
      await page.evaluate((r) => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (v) v.playbackRate = r
      }, rate)
      const samples = []
      for (let i = 0; i < SECS; i++) { await delay(1000); const s = await snap(); if (s) samples.push(s) }
      const first = samples[0]; const last = samples[samples.length - 1]
      const stalls = samples.filter((s) => s.ready < 3).length
      const aheadMin = Math.min(...samples.map((s) => s.ahead))
      phases.push({
        rate,
        wallSecs: SECS,
        contentPlayed: Number((last.cur - first.cur).toFixed(1)),
        presented: last.presented - first.presented,
        dropped: last.dropped - first.dropped,
        stalls,
        aheadMin: Number(aheadMin.toFixed(1)),
        effRate: Number(((last.cur - first.cur) / (SECS - stalls)).toFixed(2)),
      })
    }

    const reqs = await page.evaluate(() => {
      const rel = performance.getEntriesByType('resource').filter((r) => r.startTime >= window.__probe.t0)
      return {
        stream: rel.filter((r) => String(r.name).includes('/stream')).length,
        raw: rel.filter((r) => String(r.name).includes('/raw')).length,
        longtasks: window.__probe.longtasks.length,
      }
    })
    const report = { item: ITEM, src: KIND, phases, reqs }
    fs.writeFileSync(`${OUT}/rate_limit_report_${ITEM}_${KIND}.json`, JSON.stringify(report, null, 2))
    console.log(`item=${ITEM} src=${KIND}`)
    for (const p of phases) {
      console.log(
        `${p.rate}x: played ${p.contentPlayed}s content in ${p.wallSecs}s (eff ${p.effRate}x)` +
        ` | frames +${p.presented} dropped +${p.dropped} | stalls ${p.stalls}/10 | aheadMin ${p.aheadMin}s`)
    }
    console.log('reqs:', JSON.stringify(reqs))
  } finally { await browser.close().catch(() => {}) }
}
main().catch((e) => { console.error(e); process.exit(1) })
