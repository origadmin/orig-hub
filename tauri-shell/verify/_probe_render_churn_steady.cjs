'use strict'

/**
 * BUG-217 steady-state probe, **app-vs-bare same-round** comparison.
 *
 * Load-independent verdict: instead of absolute thresholds (which were calibrated under a
 * lighter machine load and are not comparable across loads), this probe measures the app arm
 * and a bare <video> arm **in the same round, same process, same page**, then compares them.
 *
 *   arm = app  : the real player in the media viewer (opens the viewer, plays item 472)
 *   arm = bare : a bare <video> injected into the same page at 1440x807 (no player chrome)
 *
 * Both arms sample the **same window**: play start -> WARMUP_MS (default 4000) -> SAMPLE_MS
 * (default 10000). The app arm additionally asserts the control layer has auto-hidden before
 * sampling (`[role="toolbar"]` computed `display:none`, or `opacity:0` when EXPECT=opacity-0);
 * the bare arm asserts the player toolbar does not exist. **Any assertion failure exits 2**
 * (no silent degradation).
 *
 * Arms alternate app -> bare -> app -> bare -> ... within each rate, ROUNDS times each.
 * Metrics match `_probe_render_churn.cjs`: presented / gapP50 / gapP95 / gapMax / gt25 / mutations.
 *
 * Env: RATES=2,4  ROUNDS=3  SAMPLE_MS=10000  WARMUP_MS=4000  EXPECT=display-none|opacity-0
 */

const { execFileSync } = require('node:child_process')
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
const BARE_W = 1440
const BARE_H = 807

// Relative (load-independent) acceptance, Δ = app - bare.
const D_GAPP95 = 5 // ms  : app's tail must not exceed bare's by more than this
const D_GT25 = 8 // count: app's >25ms gaps must not exceed bare's by more than this
const D_PRESENTED = 1.5 // fps: app's presented must stay within this of bare's

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Count live processes by image name (Windows `tasklist`), spawned **without a shell** so it does
 *  not depend on cmd.exe. Returns null when the environment blocks spawning tasklist at all
 *  (some sandboxes do) -- the caller prints `n/a` instead of failing the run. */
function countProc(name) {
  try {
    const out = execFileSync('tasklist', [], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    const needle = name.toLowerCase()
    return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(needle)).length
  } catch (_e) {
    return null
  }
}
function fmtCount(v) {
  return v === null ? 'n/a' : String(v)
}
function procCounts() {
  return { msedge: countProc('msedge.exe'), webview2: countProc('msedgewebview2.exe'), node: countProc('node.exe') }
}

/**
 * In-page: warm up until the arm's hidden state is established, assert it, then measure.
 * @param {'app'|'bare'} arm
 */
const MEASURE = async (arm, vsel, rsel, rate, warmMs, sampleMs, expect) => {
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

  // Warm-up: for the app arm this lets the auto-hide timer + fade elapse; for the bare arm it
  // simply aligns both arms to the identical measurement window.
  await new Promise((r) => setTimeout(r, warmMs))

  // ---- pre-sample assertion (fail loud) ----
  let assertState
  if (arm === 'app') {
    const toolbars = Array.from(document.querySelectorAll('[data-testid="media-viewer"] [role="toolbar"]'))
    const tb = toolbars.find((el) => getComputedStyle(el).position === 'absolute') || toolbars[0] || null
    const cs = tb ? getComputedStyle(tb) : null
    assertState = {
      arm,
      expect,
      toolbarFound: !!tb,
      display: cs ? cs.display : null,
      opacity: cs ? cs.opacity : null,
      paused: v.paused,
    }
    if (!tb) return { ok: false, assertFailed: true, reason: 'no [role="toolbar"]', assertState }
    if (v.paused) return { ok: false, assertFailed: true, reason: 'video paused before sample', assertState }
    if (expect === 'display-none') {
      if (assertState.display !== 'none') return { ok: false, assertFailed: true, reason: 'toolbar not display:none', assertState }
    } else if (expect === 'opacity-0') {
      if (assertState.display === 'none') return { ok: false, assertFailed: true, reason: 'pre-fix toolbar unexpectedly display:none', assertState }
      if (assertState.opacity !== '0') return { ok: false, assertFailed: true, reason: 'toolbar opacity not 0', assertState }
    }
  } else {
    const tb = document.querySelector('[data-testid="media-viewer"] [role="toolbar"]')
    assertState = { arm, expect: 'no-toolbar', toolbarFound: !!tb, paused: v.paused }
    if (tb) return { ok: false, assertFailed: true, reason: 'bare arm still has [role="toolbar"]', assertState }
    if (v.paused) return { ok: false, assertFailed: true, reason: 'video paused before sample', assertState }
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
    mutKinds,
    longtasks: lt.length,
    assertState,
  }
}

/** In-page: inject a bare <video> at the given size (the app-like wrapper is intentionally absent). */
const INJECT_BARE = (src, w, h) => {
  document.querySelectorAll('[data-probe-bare]').forEach((e) => e.remove())
  const d = document.createElement('div')
  d.setAttribute('data-probe-bare', 'wrap')
  d.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px;z-index:2147483000;background:#000;`
  const v = document.createElement('video')
  v.setAttribute('data-probe-bare', 'video')
  v.src = src
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;'
  d.appendChild(v)
  document.body.appendChild(d)
}

/** In-page: remove any injected bare wrapper. */
const REMOVE_BARE = () => {
  document.querySelectorAll('[data-probe-bare]').forEach((e) => e.remove())
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
    `| tu/s=${r.timeupdatePerSec} mut/s=${r.mutationsPerSec} lt=${r.longtasks} ` +
    `| assert=${JSON.stringify(r.assertState)}`
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

async function installBare(page, url) {
  await page.evaluate(INJECT_BARE, url, BARE_W, BARE_H)
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video[data-probe-bare]')
      return !!v && v.videoWidth > 0 && v.readyState >= 2
    },
    { timeout: 25000, intervalMs: 250 },
  )
}

async function removeBare(page) {
  await page.evaluate(REMOVE_BARE)
  await delay(200)
}

async function main() {
  console.log(`steady app-vs-bare: EXPECT=${EXPECT} WARMUP_MS=${WARMUP_MS} SAMPLE_MS=${SAMPLE_MS} ROUNDS=${ROUNDS} RATES=${RATES.join(',')}`)
  const before = procCounts()
  console.log(
    `procs BEFORE launch: msedge.exe=${fmtCount(before.msedge)} msedgewebview2.exe=${fmtCount(before.webview2)} node.exe=${fmtCount(before.node)}`,
  )

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
  console.log(`probe browser pid=${browser.proc ? browser.proc.pid : '?'} profile=${browser.userDataDir}`)

  const rows = {} // rows[rate] = { app: [...], bare: [...] }
  let assertFailures = 0
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    const keep = setInterval(bring, 2000)

    for (const rate of RATES) {
      rows[rate] = { app: [], bare: [] }
      for (let round = 1; round <= ROUNDS; round++) {
        // ---- app arm ----
        const tagA = Date.now()
        process.stdout.write(`[${rate}x r${round}] app  ... `)
        let a
        try {
          await openApp(page, `${TG}/api/media/items/${ITEM}/raw?rep=${tagA}a`)
          a = await page.evaluate(
            MEASURE,
            'app',
            '[data-testid="media-viewer"] video',
            '[data-testid="media-viewer"]',
            rate,
            WARMUP_MS,
            SAMPLE_MS,
            EXPECT,
          )
        } catch (e) {
          a = { ok: false, error: String((e && e.message) || e) }
        }
        if (a && a.assertFailed) assertFailures++
        rows[rate].app.push(a)
        console.log(fmt(a))
        await closeViewer(page)

        // ---- bare arm ----
        const tagB = Date.now()
        process.stdout.write(`[${rate}x r${round}] bare ... `)
        let b
        try {
          await installBare(page, `${TG}/api/media/items/${ITEM}/raw?rep=${tagB}b`)
          b = await page.evaluate(
            MEASURE,
            'bare',
            'video[data-probe-bare]',
            '[data-probe-bare="wrap"]',
            rate,
            WARMUP_MS,
            SAMPLE_MS,
            'no-toolbar',
          )
        } catch (e) {
          b = { ok: false, error: String((e && e.message) || e) }
        }
        if (b && b.assertFailed) assertFailures++
        rows[rate].bare.push(b)
        console.log(fmt(b))
        await removeBare(page)
        await delay(500)
      }
    }
    clearInterval(keep)
  } finally {
    await browser.close()
  }

  const after = procCounts()
  console.log(
    `procs AFTER close:   msedge.exe=${fmtCount(after.msedge)} msedgewebview2.exe=${fmtCount(after.webview2)} node.exe=${fmtCount(after.node)}`,
  )

  // ---- medians + Δ ----
  const M = (rowsArr, k) => median(rowsArr.filter((r) => r.ok).map((r) => r[k]))
  console.log('\n=== STEADY app-vs-bare (same round, 3-round median) ===')
  console.log('rate | arm  | presented | gapP50 | gapP95 | gapMax | gt25 | mut/s | n')
  const table = {}
  for (const rate of RATES) {
    const appOk = rows[rate].app.filter((r) => r.ok)
    const bareOk = rows[rate].bare.filter((r) => r.ok)
    const appM = {
      n: appOk.length,
      presented: M(appOk, 'presented'),
      gapP50: M(appOk, 'gapP50'),
      gapP95: M(appOk, 'gapP95'),
      gapMax: M(appOk, 'gapMax'),
      gt25: M(appOk, 'gt25'),
      mut: M(appOk, 'mutationsPerSec'),
    }
    const bareM = {
      n: bareOk.length,
      presented: M(bareOk, 'presented'),
      gapP50: M(bareOk, 'gapP50'),
      gapP95: M(bareOk, 'gapP95'),
      gapMax: M(bareOk, 'gapMax'),
      gt25: M(bareOk, 'gt25'),
      mut: M(bareOk, 'mutationsPerSec'),
    }
    const d = {
      presented: +(appM.presented - bareM.presented).toFixed(1),
      gapP95: +(appM.gapP95 - bareM.gapP95).toFixed(1),
      gt25: +(appM.gt25 - bareM.gt25).toFixed(1),
    }
    table[rate] = { app: appM, bare: bareM, d }
    const line = (arm, m) =>
      `${String(rate).padStart(4)} | ${arm.padEnd(4)} | ${String(m.presented).padStart(9)} | ${String(m.gapP50).padStart(6)} | ${String(m.gapP95).padStart(6)} | ${String(m.gapMax).padStart(6)} | ${String(m.gt25).padStart(4)} | ${String(m.mut).padStart(5)} | ${m.n}`
    console.log(line('app', appM))
    console.log(line('bare', bareM))
    console.log(
      `${String(rate).padStart(4)} | Δ    | ${String(d.presented).padStart(9)} |        | ${String(d.gapP95).padStart(6)} |        | ${String(d.gt25).padStart(4)} |       |`,
    )
  }

  // ---- relative verdict ----
  console.log('\n=== Δ criteria (Δ = app - bare) ===')
  let residual = false
  const exceeded = []
  for (const rate of RATES) {
    const d = table[rate].d
    const okP95 = d.gapP95 <= D_GAPP95
    const okGt25 = d.gt25 <= D_GT25
    const okPres = Math.abs(d.presented) <= D_PRESENTED
    if (!okP95) exceeded.push(`${rate}x ΔgapP95=${d.gapP95} (>${D_GAPP95})`)
    if (!okGt25) exceeded.push(`${rate}x Δgt25=${d.gt25} (>${D_GT25})`)
    if (!okPres) exceeded.push(`${rate}x |Δpresented|=${Math.abs(d.presented)} (>${D_PRESENTED})`)
    if (!okP95 || !okGt25 || !okPres) residual = true
    console.log(
      `${rate}x  ΔgapP95=${d.gapP95} (<=${D_GAPP95}? ${okP95})  Δgt25=${d.gt25} (<=${D_GT25}? ${okGt25})  |Δpresented|=${Math.abs(d.presented)} (<=${D_PRESENTED}? ${okPres})`,
    )
  }
  console.log(residual ? `VERDICT: RESIDUAL (${exceeded.join('; ')})` : 'VERDICT: NO-RESIDUAL (app equivalent to bare)')

  // ---- reference absolute thresholds (not the verdict) ----
  console.log('\n=== reference (absolute thresholds, NOT the verdict) ===')
  for (const rate of RATES) {
    const a = table[rate].app
    console.log(`${rate}x app: gt25=${a.gt25} (<=15? ${a.gt25 <= 15})  presented=${a.presented} (>=58? ${a.presented >= 58})  mut=${a.mut} (<=6? ${a.mut <= 6})`)
  }

  // ---- freeze question: bare gapMax > 50ms ? ----
  console.log('\n=== freeze signal (gapMax) per round ===')
  for (const rate of RATES) {
    const appMax = rows[rate].app.filter((r) => r.ok).map((r) => r.gapMax)
    const bareMax = rows[rate].bare.filter((r) => r.ok).map((r) => r.gapMax)
    const c = (arr, th) => arr.filter((x) => x > th).length
    console.log(
      `${rate}x app  gapMax rounds=${JSON.stringify(appMax)}  >50ms=${c(appMax, 50)}  >300ms=${c(appMax, 300)}`,
    )
    console.log(
      `${rate}x bare gapMax rounds=${JSON.stringify(bareMax)}  >50ms=${c(bareMax, 50)}  >300ms=${c(bareMax, 300)}`,
    )
  }

  console.log('\nJSON ' + JSON.stringify({ expect: EXPECT, table }))

  if (assertFailures > 0) {
    console.error(`\nSTEADY_ASSERT_FAILED count=${assertFailures} (EXPECT=${EXPECT}) — refusing to report silently`)
    process.exit(2)
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
