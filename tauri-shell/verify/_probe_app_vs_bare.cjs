'use strict'

/**
 * The decisive A/B: app player vs bare <video>, same browser, same page, same file,
 * SAME RENDERED SIZE.
 *
 * Why this exact experiment
 * -------------------------
 * The user reported that the bare player (a probe window I opened, which injected a
 * plain <video> into the app page) played *smoothly*, while real playback in the app
 * stutters. If that is true with everything else held constant -- same origin, same
 * file, same decoder, same display, same element size -- then the cost lives in the
 * app's player path (MediaViewer / VideoPlayer), not in the machine.
 *
 * The earlier isolated probe used a 640px element, which is NOT a fair comparison: a
 * smaller surface is cheaper to composite. So this probe first reads the app player's
 * actual rendered size and then builds the bare <video> at exactly that size, in the
 * same place.
 *
 * Metrics: rVFC presentation-gap distribution (the only trustworthy smoothness signal
 * on this box -- droppedVideoFrames is garbage here), plus main-thread longtasks.
 *
 * Verdict rule (pre-declared):
 *   app gapP95 <= 25ms and gt100 == 0 and longtasks == 0  -> app player is as smooth
 *       as bare; the stutter is not reproducible here.
 *   otherwise -> the app player itself is dropping presentation slots; the delta
 *       between the two columns IS the app's overhead.
 *
 * ONE browser launch.
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = 472 // 720p60 HEVC 11.8Mbps -- the heaviest realistic case
const RATES = [2, 4]
const SAMPLE_MS = 10000

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

/** Shared in-page sampler: attaches to whatever <video> the selector resolves to. */
const SAMPLER = async (selector, r, ms) => {
  const v = document.querySelector(selector)
  if (!v) return { ok: false, error: 'no video for ' + selector }

  v.muted = true
  v.volume = 0
  v.playbackRate = r
  try {
    await v.play()
  } catch (e) {
    return { ok: false, error: 'play failed: ' + String(e && e.message) }
  }

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
}

/** Measure the real app player. */
async function measureApp(page, rate) {
  return page.evaluate(SAMPLER, '[data-testid="media-viewer"] video', rate, SAMPLE_MS)
}

/** Read the app player's rendered size so the bare element can match it exactly. */
async function appPlayerSize(page) {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return null
    const r = v.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
  })
}

/**
 * Build a bare <video> at the exact size/position of the app player, on the same page,
 * same file, same rate -- i.e. reproduce the "probe player" the user saw, but fairly.
 */
async function installBare(page, url, size) {
  await page.evaluate(
    (u, s) => {
      document.querySelectorAll('video[data-probe-bare]').forEach((e) => e.remove())
      const d = document.createElement('div')
      d.setAttribute('data-probe-bare', 'wrap')
      d.style.cssText = `position:fixed;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;z-index:2147483000;background:#000;`
      const v = document.createElement('video')
      v.setAttribute('data-probe-bare', 'video')
      v.src = u
      v.muted = true
      v.playsInline = true
      v.preload = 'auto'
      v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;'
      d.appendChild(v)
      document.body.appendChild(d)
    },
    url,
    size,
  )
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video[data-probe-bare]')
      return !!v && v.videoWidth > 0 && v.readyState >= 2
    },
    { timeout: 25000, intervalMs: 250 },
  )
}

async function measureBare(page, rate) {
  return page.evaluate(SAMPLER, 'video[data-probe-bare]', rate, SAMPLE_MS)
}

async function removeBare(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-probe-bare]').forEach((e) => e.remove())
  })
}

function fmt(tag, r) {
  if (!r || !r.ok) return `${tag} FAILED: ${r && r.error}`
  return (
    `${tag} presented=${r.presentedFps} decoded=${r.decodedFps} drop=${r.dropPct}% effRate=${r.effRate} ` +
    `el=${r.elW}x${r.elH} gap p50/p90/p95/p99/max=${r.gapP50}/${r.gapP90}/${r.gapP95}/${r.gapP99}/${r.gapMax}ms ` +
    `gt50=${r.gt50} gt100=${r.gt100} gt250=${r.gt250} longtasks=${r.longtasks}(${r.longtaskMax}ms)`
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

    const vp = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      sw: window.screen.width,
      sh: window.screen.height,
    }))
    console.log(`[env] viewport=${vp.w}x${vp.h} dpr=${vp.dpr} screen=${vp.sw}x${vp.sh}`)

    const rawUrl = `${TG}/api/media/items/${ITEM}/raw`

    // --- app player ---
    await openItem(page, ITEM)
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        return !!v && v.videoWidth > 0 && v.readyState >= 2
      },
      { timeout: 25000, intervalMs: 250 },
    )
    const size = await appPlayerSize(page)
    console.log(`[app] player video element = ${size.w}x${size.h} at (${size.x},${size.y})`)

    for (const rate of RATES) {
      process.stdout.write(`[app player] ${rate}x ... `)
      let r
      try {
        r = await measureApp(page, rate)
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) }
      }
      console.log(fmt('', r))
      rows.push({ mode: 'app', rate, ...r })
      await delay(700)
    }
    await closeViewer(page)

    // --- bare video, identical size/position ---
    for (const rate of RATES) {
      await installBare(page, rawUrl, size)
      process.stdout.write(`[bare <video> same size] ${rate}x ... `)
      let r
      try {
        r = await measureBare(page, rate)
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) }
      }
      console.log(fmt('', r))
      rows.push({ mode: 'bare', rate, ...r })
      await removeBare(page)
      await delay(700)
    }
  } finally {
    if (keep) clearInterval(keep)
    await browser.close()
  }

  console.log('\n=== SUMMARY (csv) ===')
  console.log('mode,rate,presentedFps,decodedFps,dropPct,effRate,elW,elH,gapP50,gapP90,gapP95,gapP99,gapMax,gt50,gt100,gt250,longtasks,longtaskMax')
  for (const r of rows) {
    if (!r.ok) {
      console.log(`${r.mode},${r.rate},ERR,${r.error}`)
      continue
    }
    console.log(
      [r.mode, r.rate, r.presentedFps, r.decodedFps, r.dropPct, r.effRate, r.elW, r.elH, r.gapP50, r.gapP90, r.gapP95, r.gapP99, r.gapMax, r.gt50, r.gt100, r.gt250, r.longtasks, r.longtaskMax].join(','),
    )
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
