'use strict'

/**
 * App-level playback probe (real player, real UI, real size).
 *
 * Purpose: the isolated decode probe (`_probe_decode.cjs`) measured a 640px <video>
 * in a clean profile and found *uniform* 60Hz presentation at every rate (gap p95
 * 17ms, max 38ms) with the decoder never starving (effRate 0.993). If the user still
 * perceives stutter, the difference must live in the app context -- full-size player,
 * the always-mounted TgPanel polling every 5s, cover images, React re-renders.
 *
 * So this probe plays the *same items* through the *real* MediaViewer and looks for
 * what the isolated probe could not see: a long tail in the presentation-gap
 * distribution, and main-thread longtasks during playback.
 *
 * Verdict rule (pre-declared):
 *   - if gap p99 <= 50ms and gaps>100ms == 0  -> app presentation is uniform; the
 *     stutter is not reproducible here and must come from outside (display refresh,
 *     machine load, audio).
 *   - if a long tail appears (gaps > 100ms, or longtasks > 0) -> localised to the app.
 *
 * ONE browser launch.
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const SAMPLE_MS = 10000
const RATES = [1, 2, 4]
const ITEMS = [
  { id: 472, label: '472 720p60 HEVC 11.8Mbps' },
  { id: 673, label: '673 1080p30 HEVC 10.2Mbps' },
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openItem(page, item) {
  const src = `${TG}/api/media/items/${item}/raw`
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
    item,
  )
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 15000,
    intervalMs: 200,
  })
}

async function closeViewer(page) {
  try {
    await page.evaluate(() => window.__origStore.getState().closeViewer())
  } catch (_e) {
    /* ignore */
  }
  await delay(400)
}

async function measure(page, rate, sampleMs) {
  return page.evaluate(
    async (r, ms) => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return { ok: false, error: 'no video element' }

      v.muted = true
      v.volume = 0
      v.playbackRate = r
      try {
        await v.play()
      } catch (e) {
        return { ok: false, error: 'play failed: ' + String(e && e.message) }
      }

      // longtask observer (main-thread jank, >=50ms by spec)
      const lt = []
      let ltObs = null
      try {
        ltObs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) lt.push(Math.round(e.duration))
        })
        ltObs.observe({ entryTypes: ['longtask'] })
      } catch (_e) {
        /* unsupported */
      }

      const stamps = []
      let stopped = false
      const onFrame = () => {
        stamps.push(performance.now())
        if (!stopped) v.requestVideoFrameCallback(onFrame)
      }
      v.requestVideoFrameCallback(onFrame)

      const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      const bDrop = q0 ? q0.droppedVideoFrames : 0
      const bTotal = q0 ? q0.totalVideoFrames : 0
      const t0 = performance.now()
      const ct0 = v.currentTime

      await new Promise((res) => setTimeout(res, ms))

      const t1 = performance.now()
      const ct1 = v.currentTime
      const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      stopped = true
      if (ltObs) ltObs.disconnect()

      const wall = (t1 - t0) / 1000
      const advanced = ct1 - ct0
      const dropped = q1 ? q1.droppedVideoFrames - bDrop : 0
      const total = q1 ? q1.totalVideoFrames - bTotal : 0

      const gaps = []
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
      const raw = gaps.slice().sort((a, b) => a - b)
      const at = (p) => (raw.length ? +raw[Math.min(raw.length - 1, Math.floor(raw.length * p))].toFixed(1) : null)
      const over = (t) => gaps.filter((g) => g > t).length

      return {
        ok: true,
        elW: v.clientWidth,
        elH: v.clientHeight,
        vw: v.videoWidth,
        vh: v.videoHeight,
        presentedFps: +(stamps.length / wall).toFixed(1),
        decodedFps: +(total / wall).toFixed(1),
        dropPct: total > 0 ? +((dropped / total) * 100).toFixed(1) : 0,
        effRate: +(advanced / wall / r).toFixed(3),
        frames: stamps.length,
        gapP50: at(0.5),
        gapP90: at(0.9),
        gapP95: at(0.95),
        gapP99: at(0.99),
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
        gt50: over(50),
        gt100: over(100),
        gt250: over(250),
        longtasks: lt.length,
        longtaskMax: lt.length ? Math.max(...lt) : 0,
      }
    },
    rate,
    sampleMs,
  )
}

async function main() {
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
  const rows = []
  let keep = null
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    keep = setInterval(bring, 2000)
    console.log('[app] ready')

    for (const it of ITEMS) {
      await openItem(page, it.id)
      await page.waitForFunction(
        () => {
          const v = document.querySelector('[data-testid="media-viewer"] video')
          return !!v && v.videoWidth > 0 && v.readyState >= 2
        },
        { timeout: 20000, intervalMs: 250 },
      ).catch(() => {})
      for (const rate of RATES) {
        process.stdout.write(`[app] ${it.label} @${rate}x ... `)
        let res
        try {
          res = await measure(page, rate, SAMPLE_MS)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        if (!res.ok) {
          console.log(`FAILED: ${res.error}`)
        } else {
          console.log(
            `presented=${res.presentedFps} decoded=${res.decodedFps} drop=${res.dropPct}% effRate=${res.effRate} ` +
              `el=${res.elW}x${res.elH} src=${res.vw}x${res.vh} ` +
              `gap p50/p90/p95/p99/max=${res.gapP50}/${res.gapP90}/${res.gapP95}/${res.gapP99}/${res.gapMax}ms ` +
              `gt50=${res.gt50} gt100=${res.gt100} gt250=${res.gt250} longtasks=${res.longtasks}(max ${res.longtaskMax}ms)`,
          )
        }
        rows.push({ item: it.label, rate, ...res })
        await delay(600)
      }
      await closeViewer(page)
    }
  } finally {
    if (keep) clearInterval(keep)
    await browser.close()
  }

  console.log('\n=== SUMMARY (csv) ===')
  console.log('item,rate,presentedFps,decodedFps,dropPct,effRate,elW,elH,srcW,srcH,gapP50,gapP90,gapP95,gapP99,gapMax,gt50,gt100,gt250,longtasks,longtaskMax')
  for (const r of rows) {
    if (!r.ok) {
      console.log(`${r.item},${r.rate},ERR,${r.error}`)
      continue
    }
    console.log(
      [r.item, r.rate, r.presentedFps, r.decodedFps, r.dropPct, r.effRate, r.elW, r.elH, r.vw, r.vh, r.gapP50, r.gapP90, r.gapP95, r.gapP99, r.gapMax, r.gt50, r.gt100, r.gt250, r.longtasks, r.longtaskMax].join(','),
    )
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
