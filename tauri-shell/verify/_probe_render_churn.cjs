'use strict'

/**
 * H1 test: is the app player's cadence loss caused by React re-render churn driven by
 * `timeupdate`?
 *
 * VideoPlayer.tsx:416-421 does, on every `timeupdate`:
 *     setCurrentTime(v.currentTime); readBuffered()   // readBuffered -> setBuffered
 * and the component carries a large subtree (progress bar, control row, an 8-item rate
 * menu). `timeupdate` is tied to *media* time, so at 4x it fires ~4x as often as at 1x.
 * A re-render that costs a few ms is invisible on the main thread (longtask only counts
 * >=50ms) but at 4x the presentation budget per frame is ~4ms -- so churn can steal
 * vsync slots without ever registering as a long task.
 *
 * Measurement: count `timeupdate` events and DOM mutations in the player subtree, and
 * correlate with the rVFC gap tail. Compare app vs a bare <video> of identical size on
 * the same page, same file, same rate, both cache-busted.
 *
 * ONE browser launch.
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = 472
const SAMPLE_MS = 10000
const RATES = [2, 4]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const PROBE = async (selector, r, ms) => {
  const v = document.querySelector(selector)
  if (!v) return { ok: false, error: 'no video for ' + selector }

  // MutationObserver on the widest container that is still per-mode
  const root =
    selector.indexOf('media-viewer') >= 0
      ? document.querySelector('[data-testid="media-viewer"]')
      : document.querySelector('[data-probe-bare="wrap"]')

  let mut = 0
  const mutKinds = {}
  let mo = null
  if (root) {
    mo = new MutationObserver((recs) => {
      for (const rec of recs) {
        mut++
        mutKinds[rec.type] = (mutKinds[rec.type] || 0) + 1
      }
    })
    mo.observe(root, { attributes: true, childList: true, subtree: true, characterData: true })
  }

  let tu = 0
  const onTU = () => {
    tu++
  }
  v.addEventListener('timeupdate', onTU)

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

  const lt = []
  let ltObs = null
  try {
    ltObs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) lt.push(Math.round(e.duration))
    })
    ltObs.observe({ entryTypes: ['longtask'] })
  } catch (_e) {
    /* ignore */
  }

  const t0 = performance.now()
  await new Promise((res) => setTimeout(res, ms))
  const wall = (performance.now() - t0) / 1000
  stopped = true
  v.removeEventListener('timeupdate', onTU)
  if (mo) mo.disconnect()
  if (ltObs) ltObs.disconnect()

  const gaps = []
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
  gaps.sort((a, b) => a - b)
  const at = (p) => (gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(1) : null)
  const gt25 = gaps.filter((g) => g > 25).length

  return {
    ok: true,
    wall: +wall.toFixed(1),
    presentedFps: +(stamps.length / wall).toFixed(1),
    gapP50: at(0.5),
    gapP95: at(0.95),
    gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
    gt25,
    timeupdatePerSec: +(tu / wall).toFixed(1),
    mutationsPerSec: +(mut / wall).toFixed(1),
    mutKinds,
    longtasks: lt.length,
  }
}

function fmt(r) {
  if (!r || !r.ok) return `FAILED: ${r && r.error}`
  return (
    `presented=${r.presentedFps} gapP50/p95/max=${r.gapP50}/${r.gapP95}/${r.gapMax}ms gt25=${r.gt25} ` +
    `| timeupdate/s=${r.timeupdatePerSec} mutations/s=${r.mutationsPerSec} kinds=${JSON.stringify(r.mutKinds)} longtasks=${r.longtasks}`
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

    for (const rate of RATES) {
      const tag = Date.now()
      process.stdout.write(`[app ] ${rate}x ... `)
      let a
      try {
        await openApp(page, `${TG}/api/media/items/${ITEM}/raw?rc=${tag}a`)
        a = await page.evaluate(PROBE, '[data-testid="media-viewer"] video', rate, SAMPLE_MS)
      } catch (e) {
        a = { ok: false, error: String((e && e.message) || e) }
      }
      console.log(fmt(a))
      await closeViewer(page)

      process.stdout.write(`[bare] ${rate}x ... `)
      let b
      try {
        await installBare(page, `${TG}/api/media/items/${ITEM}/raw?rc=${tag}b`)
        b = await page.evaluate(PROBE, 'video[data-probe-bare]', rate, SAMPLE_MS)
      } catch (e) {
        b = { ok: false, error: String((e && e.message) || e) }
      }
      console.log(fmt(b))
      await removeBare(page)
      await delay(700)
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
