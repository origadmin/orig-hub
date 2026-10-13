'use strict'

/**
 * 3 reps x 2 modes, both cache-busted: does the 4x freeze reproduce, and is it the app's
 * fault or just a cold-cache artifact?
 *
 * What we already saw (single cold run, item 472 @4x, app player):
 *   2.74s  waiting  ct=10.86  readyState=2   -- with 37 s of data already buffered
 *   3.0-7.0s       ct frozen at 10.86
 *   5.61s  stalled  ct=10.86  readyState=2
 *   7.41s  playing  ct=11.08  readyState=4
 * i.e. ~4.4 s of frozen playback while `buffered` said 48.52 s. That is not a display
 * budget artefact and not a decode-throughput ceiling -- it is the data path stopping.
 *
 * But the media responses are `cache-control: public, max-age=31536000`, so whichever
 * playback runs SECOND in a session gets served from the browser disk cache. The earlier
 * app-vs-bare run had app first and bare second, which is exactly the wrong order to
 * conclude anything. So: bust the cache on every single playback, and alternate nothing
 * -- run both modes in the same rep, 3 reps, fresh URL each time.
 *
 * Per run we report: impliedRate, presented fps, max presentation gap, total frozen
 * milliseconds, and the interesting media events.
 *
 * ONE browser launch.
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = 472
const RATE = 4
const SAMPLE_MS = 12000
const REPS = 3

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** In-page: trace one playback for `ms`, return the summary. */
const TRACE = async (selector, r, ms) => {
  const v = document.querySelector(selector)
  if (!v) return { ok: false, error: 'no video for ' + selector }

  const ev = []
  const NAMES = ['ratechange', 'seeking', 'seeked', 'waiting', 'stalled', 'playing', 'emptied', 'error', 'ended']
  const handlers = {}
  const t0 = performance.now()
  const stamp = () => +((performance.now() - t0) / 1000).toFixed(2)
  for (const n of NAMES) {
    const h = () => ev.push({ n, t: stamp(), ct: +v.currentTime.toFixed(2), rs: v.readyState })
    handlers[n] = h
    v.addEventListener(n, h)
  }

  v.muted = true
  v.volume = 0
  v.playbackRate = r
  try {
    await v.play()
  } catch (e) {
    return { ok: false, error: 'play: ' + String(e && e.message) }
  }

  const stamps = []
  let stopped = false
  const onFrame = () => {
    stamps.push(performance.now())
    if (!stopped) v.requestVideoFrameCallback(onFrame)
  }
  v.requestVideoFrameCallback(onFrame)

  const samples = []
  const iv = setInterval(() => {
    const b = v.buffered
    samples.push({
      t: stamp(),
      ct: +v.currentTime.toFixed(2),
      rs: v.readyState,
      be: b.length ? +b.end(b.length - 1).toFixed(1) : 0,
    })
  }, 500)

  await new Promise((res) => setTimeout(res, ms))
  clearInterval(iv)
  stopped = true
  for (const n of NAMES) v.removeEventListener(n, handlers[n])

  const gaps = []
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
  gaps.sort((a, b) => a - b)

  // frozen time = wall time during which currentTime did not advance at all
  let frozenMs = 0
  let longestFreezeMs = 0
  let cur = 0
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) * 1000
    if (samples[i].ct === samples[i - 1].ct) {
      cur += dt
      if (cur > longestFreezeMs) longestFreezeMs = cur
    } else {
      cur = 0
    }
    frozenMs += samples[i].ct === samples[i - 1].ct ? dt : 0
  }

  const first = samples[0]
  const last = samples[samples.length - 1]
  const wall = last && first ? last.t - first.t : 0
  const adv = last && first ? last.ct - first.ct : 0

  return {
    ok: true,
    impliedRate: wall > 0 ? +(adv / wall).toFixed(3) : null,
    presentedFps: wall > 0 ? +(stamps.length / wall).toFixed(1) : null,
    gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
    gapP95: gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))].toFixed(1) : null,
    frozenMs: Math.round(frozenMs),
    longestFreezeMs: Math.round(longestFreezeMs),
    minReadyState: Math.min(...samples.map((s) => s.rs)),
    bufferedAtStart: first ? first.be : null,
    events: ev,
  }
}

function fmt(r) {
  if (!r || !r.ok) return `FAILED: ${r && r.error}`
  const evs = r.events.map((e) => `${e.t}s:${e.n}(ct=${e.ct},rs=${e.rs})`).join(' ')
  return (
    `impliedRate=${r.impliedRate} presented=${r.presentedFps} gapP95/max=${r.gapP95}/${r.gapMax}ms ` +
    `frozen=${r.frozenMs}ms(longest ${r.longestFreezeMs}ms) minRS=${r.minReadyState} buf@start=${r.bufferedAtStart} ` +
    `| events: ${evs || '(none)'}`
  )
}

async function openApp(page, url) {
  await page.evaluate(
    (u, it) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${it}`,
            chatId: 0,
            messageId: it,
            kind: 'video',
            caption: '',
            description: null,
            src: u,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: '',
      })
    },
    url,
    ITEM,
  )
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 15000,
    intervalMs: 200,
  })
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

async function installBare(page, url) {
  await page.evaluate(
    (u) => {
      document.querySelectorAll('[data-probe-bare]').forEach((e) => e.remove())
      const d = document.createElement('div')
      d.setAttribute('data-probe-bare', 'wrap')
      d.style.cssText = 'position:fixed;left:0;top:0;width:1440px;height:807px;z-index:2147483000;background:#000;'
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
  )
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video[data-probe-bare]')
      return !!v && v.videoWidth > 0 && v.readyState >= 2
    },
    { timeout: 25000, intervalMs: 250 },
  )
}

async function removeBare(page) {
  await page.evaluate(() => document.querySelectorAll('[data-probe-bare]').forEach((e) => e.remove()))
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
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    const keep = setInterval(bring, 2000)

    for (let rep = 1; rep <= REPS; rep++) {
      const tag = Date.now()
      console.log(`\n---------- rep ${rep}/${REPS} (cache-busted) ----------`)

      process.stdout.write(`[app ] 4x ... `)
      let a
      try {
        await openApp(page, `${TG}/api/media/items/${ITEM}/raw?rep=${tag}a`)
        a = await page.evaluate(TRACE, '[data-testid="media-viewer"] video', RATE, SAMPLE_MS)
      } catch (e) {
        a = { ok: false, error: String((e && e.message) || e) }
      }
      console.log(fmt(a))
      await closeViewer(page)

      process.stdout.write(`[bare] 4x ... `)
      let b
      try {
        await installBare(page, `${TG}/api/media/items/${ITEM}/raw?rep=${tag}b`)
        b = await page.evaluate(TRACE, 'video[data-probe-bare]', RATE, SAMPLE_MS)
      } catch (e) {
        b = { ok: false, error: String((e && e.message) || e) }
      }
      console.log(fmt(b))
      await removeBare(page)
      await delay(800)
    }

    clearInterval(keep)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
