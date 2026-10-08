'use strict'

/**
 * BUG-217 **steady-state** window probe (companion to `_probe_render_churn.cjs`).
 *
 * The original `_probe_render_churn.cjs` starts sampling the moment playback starts, so its
 * 10s window contains the ~3s during which the control layer is still visible. This probe
 * samples ONLY after the control layer has auto-hidden:
 *
 *     play start  --HIDE_MS(3000)-->  showControls=false  --fade(300)-->  chrome unmounted
 *     sample window starts at t = WARMUP_MS (default 4000) and lasts SAMPLE_MS (default 10000)
 *
 * Before sampling it asserts the control layer is genuinely in its hidden state and **fails
 * loud** (exit != 0) if not — no silent degradation.
 *
 * EXPECT (env):
 *   display-none (default) -> the FIXED code. `[role="toolbar"]` computed `display` must be 'none'
 *                             (the whole layer is out of layout/paint/compositing).
 *   opacity-0              -> the PRE-FIX code. Its hidden state is `opacity:0` but the layer is
 *                             still laid out/painted, so it never reaches `display:none` (that IS
 *                             the bug). Assert `display !== 'none'` AND `opacity === '0'`. This is
 *                             printed in every row, not applied silently.
 *
 * Metrics are identical to `_probe_render_churn.cjs`:
 *   presented (rVFC/s) / gapP50 / gapP95 / gapMax / gt25 / mutations/s (+ timeupdate/s, longtasks).
 *
 * ONE browser launch, headful, cache-busted (`?rep=<ts>`), anti-occlusion/anti-throttle flags,
 * `Page.bringToFront` every 2s.
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = Number(process.env.PROBE_ITEM || 472)
const RATES = (process.env.RATES || '2,4')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const ROUNDS = Number(process.env.ROUNDS || 3)
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 10000)
const WARMUP_MS = Number(process.env.WARMUP_MS || 4000)
const EXPECT = process.env.EXPECT || 'display-none'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** In-page: warm up until the controls auto-hide, assert the hidden state, then measure. */
const PROBE = async (vsel, rsel, rate, warmMs, sampleMs, expect) => {
  const v = document.querySelector(vsel)
  const root = document.querySelector(rsel)
  if (!v) return { ok: false, error: 'no video for ' + vsel }
  if (!root) return { ok: false, error: 'no root for ' + rsel }

  // The player chrome is the absolute-positioned [role="toolbar"] inside the media viewer.
  const toolbars = Array.from(
    document.querySelectorAll('[data-testid="media-viewer"] [role="toolbar"]'),
  )
  const tb =
    toolbars.find((el) => getComputedStyle(el).position === 'absolute') || toolbars[0] || null

  v.muted = true
  v.volume = 0
  v.playbackRate = rate
  try {
    await v.play()
  } catch (e) {
    return { ok: false, error: 'play: ' + String(e && e.message) }
  }

  // Warm-up: let the auto-hide timer (HIDE_MS) + fade (300ms) elapse.
  await new Promise((r) => setTimeout(r, warmMs))

  // ---- pre-sample assertion (fail loud) ----
  const cs = tb ? getComputedStyle(tb) : null
  const assertState = {
    expect,
    toolbarFound: !!tb,
    display: cs ? cs.display : null,
    opacity: cs ? cs.opacity : null,
    paused: v.paused,
  }
  if (!tb) return { ok: false, assertFailed: true, reason: 'no [role="toolbar"] found', assertState }
  if (v.paused) return { ok: false, assertFailed: true, reason: 'video paused before sample', assertState }
  if (expect === 'display-none') {
    if (assertState.display !== 'none') {
      return { ok: false, assertFailed: true, reason: 'toolbar not display:none', assertState }
    }
  } else if (expect === 'opacity-0') {
    if (assertState.display === 'none') {
      return {
        ok: false,
        assertFailed: true,
        reason: 'pre-fix toolbar unexpectedly display:none',
        assertState,
      }
    }
    if (assertState.opacity !== '0') {
      return { ok: false, assertFailed: true, reason: 'toolbar opacity not 0', assertState }
    }
  }

  // ---- measurement (same definitions as _probe_render_churn.cjs) ----
  let mut = 0
  const mutKinds = {}
  const mo = new MutationObserver((recs) => {
    for (const rec of recs) {
      mut++
      mutKinds[rec.type] = (mutKinds[rec.type] || 0) + 1
    }
  })
  mo.observe(root, { attributes: true, childList: true, subtree: true, characterData: true })

  let tu = 0
  const onTU = () => {
    tu++
  }
  v.addEventListener('timeupdate', onTU)

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
  await new Promise((r) => setTimeout(r, sampleMs))
  const wall = (performance.now() - t0) / 1000
  stopped = true
  v.removeEventListener('timeupdate', onTU)
  mo.disconnect()
  if (ltObs) ltObs.disconnect()

  const gaps = []
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
  const sorted = gaps.slice().sort((a, b) => a - b)
  const at = (p) =>
    sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null

  return {
    ok: true,
    wall: +wall.toFixed(1),
    presented: +(stamps.length / wall).toFixed(1),
    gapP50: at(0.5),
    gapP95: at(0.95),
    gapMax: sorted.length ? +Math.max(...sorted).toFixed(1) : null,
    gt25: gaps.filter((g) => g > 25).length,
    timeupdatePerSec: +(tu / wall).toFixed(1),
    mutationsPerSec: +(mut / wall).toFixed(1),
    mutKinds,
    longtasks: lt.length,
    assertState,
  }
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y)
  if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2] : +((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1)
}

function fmt(r) {
  if (!r || !r.ok) {
    const a = r && r.assertState ? ` assert=${JSON.stringify(r.assertState)}` : ''
    return `FAILED: ${r && (r.reason || r.error)}${a}`
  }
  return (
    `presented=${r.presented} gapP50/p95/max=${r.gapP50}/${r.gapP95}/${r.gapMax}ms gt25=${r.gt25} ` +
    `| timeupdate/s=${r.timeupdatePerSec} mutations/s=${r.mutationsPerSec} kinds=${JSON.stringify(r.mutKinds)} longtasks=${r.longtasks} ` +
    `| assert display=${r.assertState.display} opacity=${r.assertState.opacity}`
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

async function main() {
  console.log(`steady probe: EXPECT=${EXPECT} WARMUP_MS=${WARMUP_MS} SAMPLE_MS=${SAMPLE_MS} ROUNDS=${ROUNDS} RATES=${RATES.join(',')}`)
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
  const table = {}
  let assertFailures = 0
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    const keep = setInterval(bring, 2000)

    for (const rate of RATES) {
      const rows = []
      for (let round = 1; round <= ROUNDS; round++) {
        const tag = Date.now()
        process.stdout.write(`[app steady] ${rate}x r${round} ... `)
        let r
        try {
          await openApp(page, `${TG}/api/media/items/${ITEM}/raw?rep=${tag}s${rate}${round}`)
          r = await page.evaluate(
            PROBE,
            '[data-testid="media-viewer"] video',
            '[data-testid="media-viewer"]',
            rate,
            WARMUP_MS,
            SAMPLE_MS,
            EXPECT,
          )
        } catch (e) {
          r = { ok: false, error: String((e && e.message) || e) }
        }
        if (r && r.assertFailed) assertFailures++
        rows.push(r)
        console.log(fmt(r))
        await closeViewer(page)
        await delay(600)
      }
      table[rate] = rows
    }
    clearInterval(keep)
  } finally {
    await browser.close()
  }

  console.log('\n=== MEDIANS (steady-state, per rate) ===')
  console.log('rate | presented | gapP50 | gapP95 | gapMax | gt25 | mut/s | tu/s | longtasks | n')
  const summary = {}
  for (const rate of RATES) {
    const okRows = (table[rate] || []).filter((r) => r.ok)
    if (!okRows.length) {
      console.log(`${rate}x | ALL FAILED`)
      summary[rate] = { n: 0 }
      continue
    }
    const m = {
      n: okRows.length,
      presented: median(okRows.map((r) => r.presented)),
      gapP50: median(okRows.map((r) => r.gapP50)),
      gapP95: median(okRows.map((r) => r.gapP95)),
      gapMax: median(okRows.map((r) => r.gapMax)),
      gt25: median(okRows.map((r) => r.gt25)),
      mutationsPerSec: median(okRows.map((r) => r.mutationsPerSec)),
      timeupdatePerSec: median(okRows.map((r) => r.timeupdatePerSec)),
      longtasks: okRows.reduce((a, r) => a + r.longtasks, 0),
    }
    summary[rate] = m
    console.log(
      `${rate}x | ${String(m.presented).padStart(9)} | ${String(m.gapP50).padStart(6)} | ${String(m.gapP95).padStart(6)} | ${String(m.gapMax).padStart(6)} | ${String(m.gt25).padStart(4)} | ${String(m.mutationsPerSec).padStart(5)} | ${String(m.timeupdatePerSec).padStart(4)} | ${String(m.longtasks).padStart(9)} | ${m.n}`,
    )
  }
  console.log('\nJSON ' + JSON.stringify({ expect: EXPECT, summary }))

  if (assertFailures > 0) {
    console.error(`\nSTEADY_ASSERT_FAILED count=${assertFailures} (EXPECT=${EXPECT}) — refusing to report silently`)
    process.exit(2)
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
