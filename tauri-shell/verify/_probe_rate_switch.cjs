'use strict'

/**
 * Rate-switch regression probe (user report 2026-10-09 19:21):
 *   "1x 都卡顿了 / 2x 明显过快 / 播放中切换好像没有效果"
 *
 * Three phases, ONE browser launch, real viewer + real speed menu:
 *   P1  direct-decode item 673, switch 1x→2x→4x→1x mid-play.
 *       Assert per rate: src stays /raw, v.playbackRate == rate, no reload,
 *       wall-clock effRate ≈ 1 (currentTime advances at rate × wall).
 *   P2  inject COMPAT_KEY (remembered compat) for 673 → reopen → 2x.
 *       Assert: src == /stream?speed=2 AND v.playbackRate == 1 (no N² stacking).
 *   P3  60fps HEVC item 472 at 1x — dropped-frame ratio (user "1x 卡顿" candidate).
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const COMPAT_KEY = 'orighub.compatSrcs'
const SAMPLE_MS = 8000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openItemRaw(page, itemId) {
  const src = `${TG}/api/media/items/${itemId}/raw`
  await page.evaluate(
    (url, it) => {
      window.__origStore.getState().openViewer({
        items: [{ key: `media-${it}`, chatId: 0, messageId: it, kind: 'video', caption: '', description: null, src: url, poster: null, episodeNo: null, seriesId: null }],
        index: 0,
        title: '',
      })
    },
    src,
    itemId,
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
  } catch (_e) { /* ignore */ }
  await delay(600)
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
  await delay(1200)
  return true
}

async function measureRate(page, ms) {
  return page.evaluate(
    async (sampleMs) => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return { ok: false }
      v.muted = true
      try { await v.play() } catch (_e) { /* ignore */ }
      const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      const d0 = q0 ? q0.droppedVideoFrames : 0
      const t0 = performance.now()
      const c0 = v.currentTime
      const r0 = v.playbackRate
      const s0 = v.currentSrc
      await new Promise((res) => setTimeout(res, sampleMs))
      const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      const wall = (performance.now() - t0) / 1000
      const drop = q1 && q0 ? (q1.droppedVideoFrames - d0) / Math.max(1, q1.totalVideoFrames - (q0 ? q0.totalVideoFrames : 0)) : 0
      const url = new URL(s0)
      return {
        ok: true,
        srcPath: url.pathname.replace('/api/', '') + (url.search || ''),
        elemRate: r0,
        effRate: +((v.currentTime - c0) / wall / (r0 || 1)).toFixed(3),
        dropPct: +(drop * 100).toFixed(1),
        bufAhead: v.buffered.length ? +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1) : 0,
        contentSpeed: v.dataset?.contentSpeed || document.querySelector('[data-testid="media-viewer"]')?.dataset?.contentSpeed || '?',
      }
    },
    ms,
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
  const page = await browser.newPage()
  await page.goto(APP, { waitUntil: 'load' })
  await delay(1500)
  await page.evaluate(() => localStorage.removeItem('orighub.compatSrcs'))

  console.log('=== P1: direct-decode 673, mid-play rate switching ===')
  await openItemRaw(page, 673)
  await delay(1500)
  for (const rate of [1, 2, 4, 2, 1]) {
    if (rate !== 1) await setRate(page, rate)
    const m = await measureRate(page, SAMPLE_MS)
    console.log(`  target=${rate}x ->`, JSON.stringify(m))
  }
  await closeViewer(page)

  console.log('=== P2: remembered-compat 673 forced onto FRC at 2x (stacking check) ===')
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify([`http://127.0.0.1:19787/api/media/items/673/raw`]))
  }, COMPAT_KEY)
  await openItemRaw(page, 673)
  await delay(1500)
  await setRate(page, 2)
  const m2 = await measureRate(page, SAMPLE_MS)
  console.log('  FRC 2x ->', JSON.stringify(m2))
  const stackOK = m2.ok && m2.srcPath.includes('/stream') && m2.srcPath.includes('speed=2') && m2.elemRate === 1
  console.log(`  -> stacking-fixed=${stackOK} (require: src=/stream?speed=2 AND elemRate==1)`)
  await closeViewer(page)
  await page.evaluate((key) => localStorage.removeItem(key), COMPAT_KEY)

  console.log('=== P3: 60fps HEVC 472 at 1x (drop = "1x 卡顿" candidate) ===')
  await openItemRaw(page, 472)
  await delay(1500)
  const m3 = await measureRate(page, SAMPLE_MS)
  console.log('  472 1x ->', JSON.stringify(m3))

  await browser.close()
}

main().catch((e) => {
  console.error('PROBE FAILED:', e && e.message)
  process.exit(1)
})
