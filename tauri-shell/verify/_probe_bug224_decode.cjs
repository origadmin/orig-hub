'use strict'

/**
 * BUG-224 probe: is the HEVC library really undecodable, and does the H.264
 * compatibility stream (BUG-208) produce a first frame *after* the 3s
 * `NO_FRAME_MS` budget in `lib/decodeHealth.ts`?
 *
 * Facts established before this probe (all measured, not assumed):
 *   - All 24 `.mov` entries in the library are `hevc` / tag `hvc1`
 *     (ffprobe over `media_item.file_path`), so the local Chromium cannot
 *     decode the raw source at all.
 *   - `GET /api/media/items/415/stream` answers 200 `x-orig-stream: live`
 *     with first byte at 2.44s and 1.05 MB/s (143MB source => ~136s).
 *
 * So the question this probe answers is narrow and decisive: how long until
 * `videoWidth > 0` on the compatibility stream, versus the 3s budget the
 * decoder-health detector gives it. Headless is deliberately OFF: headless
 * reports `videoWidth === 0` even while frames decode (see `lib/cdp.cjs`).
 */

const cdp = require('./lib/cdp.cjs')

const TG = 'http://127.0.0.1:19787'
const ITEM = process.env.PROBE_ITEM || '415'
const WATCH_MS = Number(process.env.PROBE_WATCH_MS || 45000)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Mount one <video> and report when (if ever) it produces a real frame. */
async function probe(page, label, url) {
  await page.evaluate(
    (l, u) => {
      document.body.innerHTML = ''
      document.body.style.background = '#000'
      const v = document.createElement('video')
      v.id = 'probe'
      v.muted = true
      v.autoplay = true
      v.preload = 'auto'
      v.playsInline = true
      v.style.width = '640px'
      v.style.height = '360px'
      window.__probe = {
        label: l,
        url: u,
        t0: performance.now(),
        firstWidthAt: null,
        firstTimeAt: null,
        errorAt: null,
        errorText: null,
        readyStateSeen: 0,
        stalledAfter: null,
        lastTime: 0,
        advancedAfterWidth: null,
      }
      v.addEventListener('error', () => {
        const p = window.__probe
        const err = v.error
        p.errorAt = (performance.now() - p.t0) / 1000
        p.errorText = err ? `${err.code}:${err.message || ''}` : 'unknown'
      })
      v.addEventListener('loadeddata', () => {
        const p = window.__probe
        if (v.videoWidth > 0 && p.firstWidthAt === null) {
          p.firstWidthAt = (performance.now() - p.t0) / 1000
          p.readyStateSeen = v.readyState
          p.lastTime = v.currentTime
        }
      })
      v.src = u
      document.body.appendChild(v)
      void v.play().catch((e) => {
        window.__probe.errorText = `play():${e.message}`
      })
    },
    label,
    url,
  )

  const deadline = Date.now() + WATCH_MS
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const p = window.__probe
      const v = document.getElementById('probe')
      if (!p || !v) return null
      return {
        elapsed: (performance.now() - p.t0) / 1000,
        firstWidthAt: p.firstWidthAt,
        firstTimeAt: p.firstTimeAt,
        errorAt: p.errorAt,
        errorText: p.errorText,
        readyState: v.readyState,
        networkState: v.networkState,
        videoWidth: v.videoWidth,
        currentTime: v.currentTime,
        duration: v.duration,
        paused: v.paused,
        buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
        totalFrames: (() => {
          try {
            const q = v.getVideoPlaybackQuality()
            return q ? q.totalVideoFrames : -1
          } catch (_e) {
            return -1
          }
        })(),
      }
    })
    if (!s) break
    if (s.errorAt !== null || (s.firstWidthAt !== null && s.currentTime > s.firstWidthAt + 1.0)) {
      return { label, url, ...s }
    }
    await delay(500)
  }
  const final = await page.evaluate(() => {
    const p = window.__probe
    const v = document.getElementById('probe')
    return {
      elapsed: p ? (performance.now() - p.t0) / 1000 : -1,
      firstWidthAt: p ? p.firstWidthAt : null,
      errorAt: p ? p.errorAt : null,
      errorText: p ? p.errorText : null,
      readyState: v ? v.readyState : -1,
      videoWidth: v ? v.videoWidth : -1,
      currentTime: v ? v.currentTime : -1,
      buffered: v && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
      totalFrames: (() => {
        try {
          const q = v.getVideoPlaybackQuality()
          return q ? q.totalVideoFrames : -1
        } catch (_e) {
          return -1
        }
      })(),
    }
  })
  return { label, url, ...final }
}

async function main() {
  const browser = await cdp.launch({ headless: false })
  try {
    const page = await browser.newPage()
    // No navigation: the fresh page is already an `about:blank` document and we
    // only ever inject into it, so there is nothing to wait for.
    const out = { noFrameBudgetMs: 3000, results: [] }

    out.results.push(await probe(page, `raw(HEVC)`, `${TG}/api/media/items/${ITEM}/raw`))
    await delay(500)
    out.results.push(await probe(page, `compat(H.264)`, `${TG}/api/media/items/${ITEM}/stream`))

    // Pre-declared verdict: the compatibility stream must beat the 3s budget
    // the detector allows, otherwise the player halts a stream that was about
    // to work.
    const compat = out.results[1]
    out.verdict =
      compat.firstWidthAt === null
        ? 'compat never produced a frame'
        : compat.firstWidthAt <= out.noFrameBudgetMs / 1000
          ? 'compat beats the 3s budget'
          : `compat first frame at ${compat.firstWidthAt.toFixed(2)}s EXCEEDS the 3s budget`
    console.log(JSON.stringify(out, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})