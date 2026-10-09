'use strict'

/**
 * Real-component playback probe (BUG-225/226 regression check).
 *
 * Reproduces the user's "normal playback stutters, cache nearly full but does it
 * even use the cache?" by driving the ACTUAL VideoPlayer through its own speed
 * menu (so the 225/226 rate-switch / FRC / contentSeek path is really exercised),
 * and measuring three things the bare-<video> probe could not see:
 *
 *   1. rVFC presentation-gap distribution  -> smoothness of the real component
 *   2. main-thread longtasks              -> app-context jank (React/TgPanel/etc.)
 *   3. loadstart/loadedmetadata counters  -> mid-play src swaps == the stutter +
 *      the proof that the cache is (not) being reused (a swap = reload = cache
 *      not used; reloads==0 with buffered ahead == cache IS used).
 *
 * Verdict rule (pre-declared):
 *   - gap p99 <= 50ms & gt100 == 0 & longtasks == 0 & reloads == 0
 *       -> real component is as smooth as bare; the reported stutter is NOT
 *          reproducible in-component and must come from outside (display, machine
 *          load, audio, a specific item/path).
 *   - otherwise -> localised to the component; the offending signal (gaps/longtasks/
 *       reloads) is reported per row.
 *
 * ONE browser launch.
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const SAMPLE_MS = 12000
const RATES = [1, 2, 4]
const ITEMS = [
  { id: 673, label: '673 1080p30 HEVC 10.2Mbps' },
  { id: 472, label: '472 720p60 HEVC 11.8Mbps' },
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openItem(page, item) {
  const src = `${TG}/api/media/items/${item.id}/raw`
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
    item.id,
  )
  await page.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return !!v && v.videoWidth > 0 && v.readyState >= 2
    },
    { timeout: 25000, intervalMs: 250 },
  )
}

async function closeViewer(page) {
  try {
    await page.evaluate(() => window.__origStore.getState().closeViewer())
  } catch (_e) {
    /* ignore */
  }
  await delay(500)
}

/** Click the real speed menu to drive the component into the target rate (FRC path). */
async function setRate(page, target) {
  if (target === 1) {
    // ensure 1x: if already 1x leave; else click 1x
    const cur = await page.evaluate(
      () => document.querySelector('[data-testid="media-viewer"] video')?.dataset?.contentSpeed || '1',
    )
    if (cur === '1') return
  }
  // open the speed menu (button whose label is like "1x"/"2x")
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
  // settle: wait for the element to be playing at the new content speed
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

async function measure(page, target) {
  return page.evaluate(
    async (t, ms) => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return { ok: false, error: 'no video element' }

      v.muted = true
      v.volume = 0
      try {
        await v.play()
      } catch (e) {
        /* ignore */
      }

      // reset reload counters
      const p = (window.__probe = { loadstart: 0, loadedmetadata: 0, loadeddata: 0, src0: v.src })
      const onLS = () => (p.loadstart += 1)
      const onLM = () => (p.loadedmetadata += 1)
      const onLD = () => (p.loadeddata += 1)
      v.addEventListener('loadstart', onLS)
      v.addEventListener('loadedmetadata', onLM)
      v.addEventListener('loadeddata', onLD)

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
      const src0 = v.src

      await new Promise((res) => setTimeout(res, ms))

      const t1 = performance.now()
      const ct1 = v.currentTime
      const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      stopped = true
      if (ltObs) ltObs.disconnect()
      v.removeEventListener('loadstart', onLS)
      v.removeEventListener('loadedmetadata', onLM)
      v.removeEventListener('loadeddata', onLD)

      const wall = (t1 - t0) / 1000
      const advanced = ct1 - ct0
      const dropped = q1 ? q1.droppedVideoFrames - bDrop : 0
      const total = q1 ? q1.totalVideoFrames - bTotal : 0
      const elemRate = v.playbackRate || 1
      const contentSpeed = Number(v.dataset?.contentSpeed || String(elemRate))

      const gaps = []
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
      const raw = gaps.slice().sort((a, b) => a - b)
      const at = (pcent) =>
        raw.length ? +raw[Math.min(raw.length - 1, Math.floor(raw.length * pcent))].toFixed(1) : null
      const over = (th) => gaps.filter((g) => g > th).length

      // buffered ahead (content seconds) at sample end
      let bufAhead = 0
      try {
        if (v.buffered.length) bufAhead = v.buffered.end(v.buffered.length - 1) - v.currentTime
      } catch (_e) {}

      return {
        ok: true,
        elW: v.clientWidth,
        elH: v.clientHeight,
        vw: v.videoWidth,
        vh: v.videoHeight,
        contentSpeed,
        elemRate,
        presentedFps: +(stamps.length / wall).toFixed(1),
        decodedFps: +(total / wall).toFixed(1),
        dropPct: total > 0 ? +((dropped / total) * 100).toFixed(1) : 0,
        effRate: +(advanced / wall / (elemRate || 1)).toFixed(3),
        bufAheadSec: +bufAhead.toFixed(1),
        frames: stamps.length,
        gapP50: at(0.5),
        gapP90: at(0.9),
        gapP95: at(0.95),
        gapP99: at(0.99),
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
        gt50: over(50),
        gt100: over(100),
        gt250: over(250),
        loadstart: p.loadstart,
        loadedmetadata: p.loadedmetadata,
        srcChanged: v.src !== src0,
        longtasks: lt.length,
        longtaskMax: lt.length ? Math.max(...lt) : 0,
      }
    },
    target,
    SAMPLE_MS,
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
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    keep = setInterval(bring, 2000)

    for (const it of ITEMS) {
      await openItem(page, it)
      // ensure starting at 1x
      await setRate(page, 1)
      for (const rate of RATES) {
        process.stdout.write(`[app] ${it.label} @${rate}x ... `)
        await setRate(page, rate)
        let res
        try {
          res = await measure(page, rate)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        if (!res.ok) {
          console.log(`FAILED: ${res.error}`)
        } else {
          console.log(
            `cs=${res.contentSpeed} elemRate=${res.elemRate} presented=${res.presentedFps} decoded=${res.decodedFps} ` +
              `drop=${res.dropPct}% effRate=${res.effRate} bufAhead=${res.bufAheadSec}s ` +
              `el=${res.elW}x${res.elH} src=${res.vw}x${res.vh} ` +
              `gap p50/p90/p95/p99/max=${res.gapP50}/${res.gapP90}/${res.gapP95}/${res.gapP99}/${res.gapMax}ms ` +
              `gt50=${res.gt50} gt100=${res.gt100} gt250=${res.gt250} ` +
              `loadstart=${res.loadstart} loadedmetadata=${res.loadedmetadata} srcChanged=${res.srcChanged} ` +
              `longtasks=${res.longtasks}(max ${res.longtaskMax}ms)`,
          )
        }
        rows.push({ item: it.label, rate, ...res })
        await delay(500)
      }
      await closeViewer(page)
    }
  } finally {
    if (keep) clearInterval(keep)
    await browser.close()
  }

  console.log('\n=== SUMMARY (csv) ===')
  console.log(
    'item,rate,contentSpeed,elemRate,presentedFps,decodedFps,dropPct,effRate,bufAheadSec,gapP50,gapP90,gapP95,gapP99,gapMax,gt50,gt100,gt250,loadstart,loadedmetadata,srcChanged,longtasks,longtaskMax',
  )
  for (const r of rows) {
    if (!r.ok) {
      console.log(`${r.item},${r.rate},ERR,${r.error}`)
      continue
    }
    console.log(
      [
        r.item,
        r.rate,
        r.contentSpeed,
        r.elemRate,
        r.presentedFps,
        r.decodedFps,
        r.dropPct,
        r.effRate,
        r.bufAheadSec,
        r.gapP50,
        r.gapP90,
        r.gapP95,
        r.gapP99,
        r.gapMax,
        r.gt50,
        r.gt100,
        r.gt250,
        r.loadstart,
        r.loadedmetadata,
        r.srcChanged,
        r.longtasks,
        r.longtaskMax,
      ].join(','),
    )
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
