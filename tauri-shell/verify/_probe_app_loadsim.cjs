'use strict'

/**
 * Load-sensitivity probe (BUG-225/226 "test smooth / real stutters" follow-up).
 *
 * The earlier real-component probe muted audio and ran in an IDLE browser, so it
 * could not see app-context jank. Here we:
 *   - keep AUDIO ON (no mute) to surface audio-decode starvation,
 *   - inject a periodic main-thread busy-loop (emulating the app's 5s TgPanel poll
 *     + React re-renders) at light/heavy intensities,
 *   - force item 673 into the LIVE 2x transcode path (clear its cached proxy each
 *     round) so we measure the thin-buffer path the user actually hits on a fresh
 *     open,
 *   - record MIN buffered-ahead during the sample (buffer starvation == the stutter).
 *
 * Hypothesis under test: 2x live transcode has a ~2-3s buffer; any main-thread
 * hiccup drains it -> stutter. 1x has a ~15s buffer and absorbs the same load.
 */

const cdp = require('./lib/cdp.cjs')
const fs = require('fs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const SAMPLE_MS = 12000
const ITEM = { id: 673, label: '673 1080p30 HEVC' }
// 本机路径从环境变量推导，不写死盘符（污染门禁 §7：脚本内禁机器绝对路径）
const PROXY_DIR = require('path').join(
  process.env.APPDATA || '',
  'com.origadmin.orighub',
  'tg',
  'proxies',
)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function clearProxy(id, speedHundredths) {
  const variant = speedHundredths ? `${id}-speed-${speedHundredths}.mp4` : `${id}.mp4`
  for (const p of [variant, `${variant}.part`]) {
    try {
      fs.unlinkSync(`${PROXY_DIR}/${p}`)
    } catch (_e) {
      /* not present is fine */
    }
  }
}

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
  } catch (_e) {}
  await delay(500)
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

// Install a periodic main-thread busy-spin in page context. budgetMs every periodMs.
async function installLoad(page, budgetMs, periodMs) {
  await page.evaluate(
    (budget, period) => {
      if (window.__loadTimer) clearInterval(window.__loadTimer)
      if (budget <= 0) return
      window.__loadTimer = setInterval(() => {
        const t0 = performance.now()
        // emulate a chatty poll: hash-spin (keeps main thread busy, blocks rVFC + buffering)
        let x = 0
        while (performance.now() - t0 < budget) x = (x * 1103515245 + 12345) & 0x7fffffff
        window.__loadSpin += x
      }, period)
    },
    budgetMs,
    periodMs,
  )
}

async function clearLoad(page) {
  await page.evaluate(() => {
    if (window.__loadTimer) clearInterval(window.__loadTimer)
    window.__loadTimer = null
  })
}

async function measure(page, target) {
  return page.evaluate(
    async (t, ms) => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return { ok: false, error: 'no video element' }

      // keep audio ON (do not mute) — surface audio-decode starvation
      v.muted = false
      try {
        await v.play()
      } catch (e) {}

      const p = (window.__probe = { loadstart: 0, loadedmetadata: 0 })
      const onLS = () => (p.loadstart += 1)
      const onLM = () => (p.loadedmetadata += 1)
      v.addEventListener('loadstart', onLS)
      v.addEventListener('loadedmetadata', onLM)

      const lt = []
      let ltObs = null
      try {
        ltObs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) lt.push(Math.round(e.duration))
        })
        ltObs.observe({ entryTypes: ['longtask'] })
      } catch (_e) {}

      const stamps = []
      let stopped = false
      const onFrame = () => {
        stamps.push(performance.now())
        if (!stopped) v.requestVideoFrameCallback(onFrame)
      }
      v.requestVideoFrameCallback(onFrame)

      // sample buffered-ahead every 200ms to catch starvation
      const bufSamples = []
      const bufTimer = setInterval(() => {
        try {
          if (v.buffered.length) bufSamples.push(v.buffered.end(v.buffered.length - 1) - v.currentTime)
        } catch (_e) {}
      }, 200)

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
      clearInterval(bufTimer)
      if (ltObs) ltObs.disconnect()
      v.removeEventListener('loadstart', onLS)
      v.removeEventListener('loadedmetadata', onLM)

      const wall = (t1 - t0) / 1000
      const advanced = ct1 - ct0
      const dropped = q1 ? q1.droppedVideoFrames - bDrop : 0
      const total = q1 ? q1.totalVideoFrames - bTotal : 0
      const elemRate = v.playbackRate || 1
      const contentSpeed = Number(v.dataset?.contentSpeed || String(elemRate))

      const gaps = []
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
      const raw = gaps.slice().sort((a, b) => a - b)
      const at = (pc) => (raw.length ? +raw[Math.min(raw.length - 1, Math.floor(raw.length * pc))].toFixed(1) : null)
      const over = (th) => gaps.filter((g) => g > th).length
      const minBuf = bufSamples.length ? +Math.min(...bufSamples).toFixed(1) : null
      const avgBuf = bufSamples.length ? +(bufSamples.reduce((a, b) => a + b, 0) / bufSamples.length).toFixed(1) : null

      return {
        ok: true,
        contentSpeed,
        elemRate,
        presentedFps: +(stamps.length / wall).toFixed(1),
        effRate: +(advanced / wall / (elemRate || 1)).toFixed(3),
        bufMinSec: minBuf,
        bufAvgSec: avgBuf,
        gapP50: at(0.5),
        gapP95: at(0.95),
        gapP99: at(0.99),
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
        gt100: over(100),
        gt250: over(250),
        loadstart: p.loadstart,
        longtasks: lt.length,
        longtaskMax: lt.length ? Math.max(...lt) : 0,
        audioTracks: v.audioTracks ? v.audioTracks.length : -1,
        muted: v.muted,
      }
    },
    target,
    SAMPLE_MS,
  )
}

async function runCondition(page, label, rate, loadBudget, loadPeriod) {
  process.stdout.write(`[loadsim] ${label} @${rate}x load=${loadBudget}ms/${loadPeriod}ms ... `)
  if (rate === 2) clearProxy(ITEM.id, 200) // force live transcode path
  if (rate === 1) clearProxy(ITEM.id, null)
  await openItem(page, ITEM)
  await setRate(page, rate)
  await installLoad(page, loadBudget, loadPeriod)
  let res
  try {
    res = await measure(page, rate)
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) }
  }
  await clearLoad(page)
  await closeViewer(page)
  if (!res.ok) {
    console.log(`FAILED: ${res.error}`)
  } else {
    console.log(
      `cs=${res.contentSpeed} presented=${res.presentedFps} effRate=${res.effRate} ` +
        `bufMin=${res.bufMinSec}s bufAvg=${res.bufAvgSec}s ` +
        `gap p95/p99/max=${res.gapP95}/${res.gapP99}/${res.gapMax}ms gt100=${res.gt100} gt250=${res.gt250} ` +
        `loadstart=${res.loadstart} longtasks=${res.longtasks}(max ${res.longtaskMax}ms) muted=${res.muted}`,
    )
  }
  return { label, rate, load: `${loadBudget}/${loadPeriod}`, ...res }
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

    // 2x live transcode under increasing load
    rows.push(await runCondition(page, '2x idle', 2, 0, 9999))
    rows.push(await runCondition(page, '2x light-load', 2, 150, 3000))
    rows.push(await runCondition(page, '2x heavy-load', 2, 350, 3000))
    // 1x under the same heavy load (contrast)
    rows.push(await runCondition(page, '1x heavy-load', 1, 350, 3000))
  } finally {
    if (keep) clearInterval(keep)
    await browser.close()
  }

  console.log('\n=== SUMMARY (csv) ===')
  console.log('label,rate,load,contentSpeed,presentedFps,effRate,bufMinSec,bufAvgSec,gapP95,gapP99,gapMax,gt100,gt250,loadstart,longtasks,longtaskMax,muted')
  for (const r of rows) {
    if (!r.ok) {
      console.log(`${r.label},${r.rate},${r.load},ERR,${r.error}`)
      continue
    }
    console.log(
      [
        r.label, r.rate, r.load, r.contentSpeed, r.presentedFps, r.effRate, r.bufMinSec, r.bufAvgSec,
        r.gapP95, r.gapP99, r.gapMax, r.gt100, r.gt250, r.loadstart, r.longtasks, r.longtaskMax, r.muted,
      ].join(','),
    )
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
