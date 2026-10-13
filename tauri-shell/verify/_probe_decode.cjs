'use strict'

/**
 * Decisive A/B probe: same item, raw HEVC vs H.264 compat stream, at 2x/4x.
 *
 * The hypothesis under test
 * -------------------------
 * The user reports "it used to be smooth, now it stutters". There is no code
 * regression (zero Rust changes since the 09-30 binary; VideoPlayer.tsx untouched since
 * 09-30 06:57). What *does* differ between playbacks is the delivery path:
 *
 *   /raw    -> the original file. For item 472 that is 1280x720 HEVC @60fps 11.8Mbps.
 *              At 2x the decoder must emit 120 fps, at 4x 240 fps -- on a 60 Hz
 *              compositor, so 50%/75% of frames *cannot* be presented. That is exactly
 *              the 75.3% drop previously measured for 472@4x.
 *   /stream -> the H.264 compatibility stream, whose proxy is already warm for 472
 *              (`proxies/472.mp4`, 228 MB) and was transcoded with `-fpsmax 30`, so it
 *              is 30 fps H.264: 2x = 60 fps demand (fits a 60 Hz panel exactly),
 *              4x = 120 fps (cheap to decode, half presented).
 *
 * If /stream is dramatically smoother at the same rate, then "the smooth period" was a
 * compat-stream playback and the fix is to make the BUG-208 switch rate-aware instead of
 * only firing when the track decodes zero frames.
 *
 * ONE browser launch. Measures presentation fps, drop%, effective rate and the
 * presentation-gap distribution (a tight p95 = uniform decimation = looks smooth;
 * a long tail = bursty starvation = looks like stutter).
 */

const cdp = require('./lib/cdp.cjs')

const BASE = 'http://127.0.0.1:19787'
const RATES = [1, 2, 4]
const SAMPLE_MS = 8000

const CASES = [
  { key: '472 /raw    720p60 HEVC', url: `${BASE}/api/media/items/472/raw` },
  { key: '472 /stream 30fps H.264 ', url: `${BASE}/api/media/items/472/stream` },
  { key: '673 /raw    1080p30 HEVC', url: `${BASE}/api/media/items/673/raw` },
  { key: '511 /raw    1080p30 H.264', url: `${BASE}/api/media/items/511/raw` },
]

async function probeHeaders(page, url) {
  return page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { headers: { Range: 'bytes=0-1' } })
      return {
        status: r.status,
        stream: r.headers.get('x-orig-stream'),
        contentType: r.headers.get('content-type'),
        contentRange: r.headers.get('content-range'),
      }
    } catch (e) {
      return { error: String(e && e.message) }
    }
  }, url)
}

async function measure(page, url, rate) {
  return page.evaluate(
    async (src, r, sampleMs) => {
      const v = document.createElement('video')
      v.src = src
      v.muted = true
      v.playsInline = true
      v.preload = 'auto'
      v.style.width = '640px'
      document.body.appendChild(v)

      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('metadata timeout')), 25000)
        v.addEventListener('loadedmetadata', () => {
          clearTimeout(t)
          res()
        })
        v.addEventListener('error', () => {
          clearTimeout(t)
          rej(new Error('media error: ' + (v.error && v.error.code)))
        })
      })

      v.playbackRate = r
      await v.play()

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

      await new Promise((res) => setTimeout(res, sampleMs))

      const t1 = performance.now()
      const ct1 = v.currentTime
      const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      stopped = true

      const wall = (t1 - t0) / 1000
      const advanced = ct1 - ct0
      const dropped = q1 ? q1.droppedVideoFrames - bDrop : 0
      const total = q1 ? q1.totalVideoFrames - bTotal : 0

      const gaps = []
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
      gaps.sort((a, b) => a - b)
      const at = (p) => (gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(1) : null)

      const out = {
        ok: true,
        w: v.videoWidth,
        h: v.videoHeight,
        presentedFps: +(stamps.length / wall).toFixed(1),
        decodedFps: +(total / wall).toFixed(1),
        dropPct: total > 0 ? +((dropped / total) * 100).toFixed(1) : 0,
        effRate: +(advanced / wall / r).toFixed(3),
        gapP50: at(0.5),
        gapP95: at(0.95),
        gapMax: gaps.length ? +gaps[gaps.length - 1].toFixed(1) : null,
      }

      v.pause()
      v.removeAttribute('src')
      v.load()
      v.remove()
      return out
    },
    url,
    rate,
    SAMPLE_MS,
  )
}

async function main() {
  const browser = await cdp.launch({
    headless: false,
    args: [
      // Without these the probe window is treated as occluded (the user's own Edge is
      // on top), and Chromium then throttles the renderer and finally suspends
      // video-only background media ("paused to save power"), which produced a bogus
      // effRate of 0.145 on the first run.
      '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  const rows = []
  let keepFrontTimer = null
  try {
    const page = await browser.newPage()
    // Must run from the app origin: `about:blank` is an opaque origin and blocks the
    // cross-origin media loads (MEDIA_ERR_SRC_NOT_SUPPORTED).
    await page.goto('http://127.0.0.1:5180/', { waitForRoot: true, settleMs: 1500 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    keepFrontTimer = setInterval(bring, 2000)
    await new Promise((r) => setTimeout(r, 400))

    console.log('=== delivery path (Range: bytes=0-1) ===')
    for (const c of CASES) {
      const h = await probeHeaders(page, c.url)
      console.log(`${c.key} -> status=${h.status} x-orig-stream=${h.stream} type=${h.contentType}`)
    }

    console.log('\n=== playback ===')
    for (const c of CASES) {
      for (const rate of RATES) {
        process.stdout.write(`[${c.key}] @${rate}x ... `)
        let res
        try {
          res = await measure(page, c.url, rate)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        if (!res.ok) {
          console.log(`FAILED: ${res.error}`)
        } else {
          console.log(
            `presented=${res.presentedFps} decoded=${res.decodedFps} drop=${res.dropPct}% ` +
              `effRate=${res.effRate} gap p50/p95/max=${res.gapP50}/${res.gapP95}/${res.gapMax}ms ${res.w}x${res.h}`,
          )
        }
        rows.push({ key: c.key, rate, ...res })
        await new Promise((r) => setTimeout(r, 800))
      }
    }
  } finally {
    if (keepFrontTimer) clearInterval(keepFrontTimer)
    await browser.close()
  }

  console.log('\n=== SUMMARY (csv) ===')
  console.log('case,rate,presentedFps,decodedFps,dropPct,effRate,gapP50,gapP95,gapMax')
  for (const r of rows) {
    if (!r.ok) {
      console.log(`${r.key},${r.rate},ERR,${r.error}`)
      continue
    }
    console.log(
      `${r.key},${r.rate},${r.presentedFps},${r.decodedFps},${r.dropPct},${r.effRate},${r.gapP50},${r.gapP95},${r.gapMax}`,
    )
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
