'use strict'

/**
 * BUG-217 **visible-window** localisation experiment (window 1: sample from play start,
 * includes the ~3s during which the control layer is still visible).
 *
 * Hypothesis under test: the control layer shares a compositing context with the <video>, so
 * painting the controls forces the video's layer to re-rasterise every frame. If so, giving the
 * control layer its **own** compositing layer (`transform: translateZ(0)`) should recover the
 * cadence during the visible period.
 *
 * Three arms, measured **in the same round, same process, same page**, alternated A -> B -> C:
 *   A = current code, controls visible for the normal ~3s (no injection)
 *   B = current code + injected `[role="toolbar"]{transform:translateZ(0)!important}`
 *   C = current code + injected `[role="toolbar"]{display:none!important}` (upper bound; B12)
 *
 * Verdict: does B's gapP95 converge to C's (within +-5ms)?
 *   converge    => hypothesis holds, the visible period is fixable
 *   not converge=> hypothesis wrong; do NOT change product code
 *
 * Each arm asserts its own precondition before sampling (fails loud with exit 2):
 *   A: toolbar present and NOT display:none at t=0    B: toolbar has a non-none transform
 *   C: toolbar display:none at t=0
 *
 * Metrics match `_probe_render_churn.cjs` (presented / gapP50 / gapP95 / gapMax / gt25 / mutations).
 * Env: RATES=2,4  ROUNDS=3  SAMPLE_MS=10000
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
const ARMS = ['A', 'B', 'C']
const CONVERGE_MS = 5

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** In-page: install the per-arm CSS override (removing any previous one). */
const SET_ARM = (arm) => {
  const old = document.getElementById('vw-arm')
  if (old) old.remove()
  if (arm === 'A') return
  const s = document.createElement('style')
  s.id = 'vw-arm'
  s.textContent =
    arm === 'B'
      ? '[data-testid="media-viewer"] [role="toolbar"]{transform:translateZ(0)!important}'
      : '[data-testid="media-viewer"] [role="toolbar"]{display:none!important}'
  document.head.appendChild(s)
}

/** In-page: remove the per-arm CSS override. */
const CLEAR_ARM = () => {
  const s = document.getElementById('vw-arm')
  if (s) s.remove()
}

/** In-page: assert the arm precondition, then measure window 1 (from play start). */
const MEASURE_WINDOW1 = async (arm, vsel, rsel, rate, ms) => {
  const v = document.querySelector(vsel)
  const root = document.querySelector(rsel)
  if (!v) return { ok: false, error: 'no video for ' + vsel }
  if (!root) return { ok: false, error: 'no root for ' + rsel }

  v.muted = true
  v.volume = 0
  v.playbackRate = rate
  try {
    await v.play()
  } catch (e) {
    return { ok: false, error: 'play: ' + String(e && e.message) }
  }

  // Capture the toolbar state at the start of the (normally visible) window.
  const tb = document.querySelector('[data-testid="media-viewer"] [role="toolbar"]')
  const cs = tb ? getComputedStyle(tb) : null
  const start = { found: !!tb, display: cs ? cs.display : null, transform: cs ? cs.transform : null, opacity: cs ? cs.opacity : null }

  let reason = null
  if (arm === 'A') {
    if (!tb || start.display === 'none') reason = 'A: toolbar not visible at start'
  } else if (arm === 'B') {
    if (!tb) reason = 'B: no toolbar'
    else if (!start.transform || start.transform === 'none') reason = 'B: toolbar has no transform at start'
  } else {
    if (!tb || start.display !== 'none') reason = 'C: toolbar not display:none at start'
  }
  if (reason) return { ok: false, assertFailed: true, reason, start }

  // ---- measure (same definitions as _probe_render_churn.cjs) ----
  let mut = 0
  const mo = new MutationObserver((recs) => {
    mut += recs.length
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

  const t0 = performance.now()
  await new Promise((r) => setTimeout(r, ms))
  const wall = (performance.now() - t0) / 1000
  stopped = true
  v.removeEventListener('timeupdate', onTU)
  mo.disconnect()

  const tbEnd = document.querySelector('[data-testid="media-viewer"] [role="toolbar"]')
  const csEnd = tbEnd ? getComputedStyle(tbEnd) : null
  const end = { found: !!tbEnd, display: csEnd ? csEnd.display : null }

  const gaps = []
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
  const sorted = gaps.slice().sort((a, b) => a - b)
  const at = (p) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null)

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
    start,
    end,
  }
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y)
  if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2] : +((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1)
}

function fmt(r) {
  if (!r || !r.ok) {
    const a = r && r.start ? ` start=${JSON.stringify(r.start)}` : ''
    return `FAILED: ${r && (r.reason || r.error)}${a}`
  }
  return (
    `presented=${r.presented} gapP50/p95/max=${r.gapP50}/${r.gapP95}/${r.gapMax}ms gt25=${r.gt25} ` +
    `| mut/s=${r.mutationsPerSec} | start(display=${r.start.display},transform=${r.start.transform}) end(display=${r.end.display})`
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
  await page.waitForFunction(() => !document.querySelector('[data-testid="media-viewer"]'), {
    timeout: 8000,
    intervalMs: 200,
  }).catch(() => {})
  await delay(300)
}

async function main() {
  console.log(`visible-window experiment: ROUNDS=${ROUNDS} RATES=${RATES.join(',')} SAMPLE_MS=${SAMPLE_MS} ARMS=${ARMS.join(',')}`)
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
  const rows = {} // rows[rate][arm] = [...]
  let assertFailures = 0
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    const keep = setInterval(bring, 2000)

    for (const rate of RATES) {
      rows[rate] = { A: [], B: [], C: [] }
      for (let round = 1; round <= ROUNDS; round++) {
        for (const arm of ARMS) {
          const tag = Date.now()
          process.stdout.write(`[${rate}x r${round}] ${arm} ... `)
          let r
          try {
            await page.evaluate(SET_ARM, arm)
            await openApp(page, `${TG}/api/media/items/${ITEM}/raw?rep=${tag}${arm}`)
            r = await page.evaluate(MEASURE_WINDOW1, arm, '[data-testid="media-viewer"] video', '[data-testid="media-viewer"]', rate, SAMPLE_MS)
          } catch (e) {
            r = { ok: false, error: String((e && e.message) || e) }
          }
          if (r && r.assertFailed) assertFailures++
          rows[rate][arm].push(r)
          console.log(fmt(r))
          await closeViewer(page)
          await page.evaluate(CLEAR_ARM).catch(() => {})
          await delay(400)
        }
      }
    }
    clearInterval(keep)
  } finally {
    await browser.close()
  }

  console.log('\n=== VISIBLE-WINDOW (window 1, from play start, 10s; 3-round median) ===')
  console.log('rate | arm | presented | gapP50 | gapP95 | gapMax | gt25 | mut/s | n')
  const table = {}
  for (const rate of RATES) {
    table[rate] = {}
    for (const arm of ARMS) {
      const ok = rows[rate][arm].filter((r) => r.ok)
      const m = {
        n: ok.length,
        presented: median(ok.map((r) => r.presented)),
        gapP50: median(ok.map((r) => r.gapP50)),
        gapP95: median(ok.map((r) => r.gapP95)),
        gapMax: median(ok.map((r) => r.gapMax)),
        gt25: median(ok.map((r) => r.gt25)),
        mut: median(ok.map((r) => r.mutationsPerSec)),
      }
      table[rate][arm] = m
      console.log(
        `${String(rate).padStart(4)} | ${arm.padEnd(3)} | ${String(m.presented).padStart(9)} | ${String(m.gapP50).padStart(6)} | ${String(m.gapP95).padStart(6)} | ${String(m.gapMax).padStart(6)} | ${String(m.gt25).padStart(4)} | ${String(m.mut).padStart(5)} | ${m.n}`,
      )
    }
  }

  console.log('\n=== verdict (does B converge to C? |B.gapP95 - C.gapP95| <= ' + CONVERGE_MS + 'ms) ===')
  let allConverge = true
  for (const rate of RATES) {
    const b = table[rate].B
    const c = table[rate].C
    const a = table[rate].A
    if (b.n === 0 || c.n === 0) {
      console.log(`${rate}x: INSUFFICIENT DATA (A.n=${a.n} B.n=${b.n} C.n=${c.n})`)
      allConverge = false
      continue
    }
    const dBC = +(b.gapP95 - c.gapP95).toFixed(1)
    const dAC = +(a.gapP95 - c.gapP95).toFixed(1)
    const converge = Math.abs(dBC) <= CONVERGE_MS
    if (!converge) allConverge = false
    console.log(
      `${rate}x: A.gapP95=${a.gapP95} B.gapP95=${b.gapP95} C.gapP95=${c.gapP95} | (A-C)=${dAC} (B-C)=${dBC} => ${converge ? 'CONVERGE' : 'NO-CONVERGE'}`,
    )
  }
  console.log(allConverge ? 'VERDICT: HYPOTHESIS HOLDS (B converges to C)' : 'VERDICT: HYPOTHESIS FAILS (B does not converge to C)')

  console.log('\nJSON ' + JSON.stringify({ table }))

  if (assertFailures > 0) {
    console.error(`\nVISIBLE_WINDOW_ASSERT_FAILED count=${assertFailures} — refusing to report silently`)
    process.exit(2)
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
