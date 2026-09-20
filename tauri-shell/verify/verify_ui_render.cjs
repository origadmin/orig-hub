#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance for the tauri-shell UI (BUG-086).
 *
 * This script proves the page ACTUALLY renders in a real browser: it drives a
 * local Edge/Chrome over CDP (zero third-party dependencies, see ./lib/cdp.cjs)
 * and asserts on the *post-JavaScript* DOM.
 *
 * It deliberately does NOT accept `curl <url> -> HTTP 200` as evidence: a dev
 * server can return 200 while the app white-screens (that is exactly what
 * `Failed to resolve import "@babel/core"` did). See docs/ACCEPTANCE.md.
 *
 * Usage:
 *   node verify/verify_ui_render.cjs                  # http://127.0.0.1:5180
 *   APP_URL=http://127.0.0.1:5173 node verify/verify_ui_render.cjs
 *   ORIG_VERIFY_OUT=<dir> node verify/verify_ui_render.cjs   # artifact dir
 *
 * Exit codes: 0 = all assertions passed, 1 = at least one assertion failed,
 *             2 = environment problem (no browser / dev server unreachable).
 */

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

/** Application url under test (override with APP_URL). */
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'

/** Where the DOM/screenshot artifacts go (never inside the repo tree). */
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT ||
  path.join(os.tmpdir(), 'orighub-verify-ui')

/** Navigation budget. */
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

/** `data-testid` anchors that must exist in the rendered sidebar/context bar. */
const REQUIRED_TESTIDS = [
  'context-bar',
  'context-bar-header',
  'context-bar-title',
  'nav-downloading',
  'nav-completed',
  'nav-paused',
  'nav-failed',
  'nav-media',
  'nav-settings',
  'all-files-row',
  'category-chevron',
]

/** Subset that is always present regardless of data volume (hard gate). */
const CRITICAL_TESTIDS = ['context-bar-header', 'nav-downloading', 'all-files-row']

/** Console errors matching these are environment noise, not app defects. */
const BENIGN_CONSOLE = [/favicon/i, /DevTools/i, /Download the React DevTools/i]

/**
 * CORS noise: the daemon whitelists origins, so serving the app from a
 * non-canonical origin (anything but 5180) makes every backend call log
 * `blocked by CORS ... Access-Control-Allow-Origin`. The UI itself renders fine
 * in that case, so these must not fail the render assertion -- but they ARE
 * a real misconfiguration, so they are downgraded to explicit warnings and
 * printed, never silently swallowed.
 */
const CORS_NOISE = /blocked by CORS|CORS policy|Access-Control-Allow-Origin/i

/**
 * Hosts whose requests were reported as CORS-blocked.
 *
 * A blocked request also emits a bare `net::ERR_FAILED` line carrying no CORS
 * wording. Exempting all `net::ERR_FAILED` would swallow genuine broken assets,
 * so only failures against a host that was itself CORS-blocked count as CORS
 * fallout -- a broken asset on the app's own origin (or a CDN) still fails.
 * @param {Array<string>} messages console error strings
 * @returns {Set<string>} `host:port` values that were CORS-blocked
 */
function corsBlockedHosts(messages) {
  const hosts = new Set()
  for (const msg of messages) {
    const hit = /Access to (?:fetch|resource) at '(https?:\/\/[^']+)'/.exec(msg)
    if (!hit) continue
    try {
      hosts.add(new URL(hit[1]).host)
    } catch (_err) {
      // Unparseable url -- simply does not widen the exemption.
    }
  }
  return hosts
}

/** Strings that must never appear in a healthy render. */
const FORBIDDEN_MARKERS = [
  { name: 'vite-error-overlay', kind: 'selector', value: 'vite-error-overlay' },
  { name: 'text:Failed to resolve', kind: 'text', value: 'Failed to resolve' },
  { name: 'text:Uncaught', kind: 'text', value: 'Uncaught' },
]

/**
 * Run one assertion, recording PASS/FAIL.
 * @param {Array<object>} results collector
 * @param {string} name assertion name
 * @param {Function} fn predicate returning boolean or throwing
 * @param {string} detail extra context printed on failure
 * @returns {Promise<boolean>}
 */
async function check(results, name, fn, detail = '') {
  let ok = false
  let message = ''
  try {
    const value = await fn()
    ok = Boolean(value)
    if (!ok && !detail) message = 'predicate returned falsy'
  } catch (err) {
    ok = false
    message = err && err.message ? err.message : String(err)
  }
  results.push({ name, ok, detail: message || detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${message || detail}`}`)
  return ok
}

/** Ensure the artifact directory is outside the repository. */
function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `Refusing to write artifacts inside the repo (${resolved}). ` +
        'Set ORIG_VERIFY_OUT to a temp directory (AGENTS.md §6).',
    )
  }
}

/**
 * Collected assertion outcomes. Module scope on purpose: the failure paths
 * (unreachable server, launch error) must still be able to dump what ran.
 * @type {Array<{name: string, ok: boolean, detail: string}>}
 */
const results = []

/**
 * CORS-related console messages, surfaced as explicit warnings.
 * @type {Array<string>}
 */
const corsNoise = []

/** Print every assertion recorded so far, as a PASS/FAIL list. */
function dumpResults() {
  if (results.length === 0) {
    console.log('--- assertions --- (none recorded)')
    return
  }
  console.log('--- assertions ---')
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  -- ${item.detail || 'n/a'}`}`)
  }
  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:ui] ${results.length - failed}/${results.length} recorded assertions passed`)
}

/**
 * Fast TCP pre-flight so an unreachable server fails in ~2s instead of burning
 * the whole navigation budget.
 * @param {string} host hostname
 * @param {number} port port
 * @param {number} timeoutMs timeout
 * @returns {Promise<boolean>} true when something accepted the connection
 */
function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let done = false
    const finish = ok => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`[verify:ui] target: ${APP_URL}`)
  console.log(`[verify:ui] artifacts: ${OUT_DIR}`)

  const target = new URL(APP_URL)
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  if (!(await tcpProbe(target.hostname, targetPort))) {
    console.error(`[verify:ui] dev server unreachable: nothing is listening on ${target.host}`)
    console.error('[verify:ui] start it with `npm run dev` (vite.config.ts: port 5180, strictPort)')
    dumpResults()
    console.error('[verify:ui] RESULT: UNREACHABLE (exit 2)')
    return 2
  }

  const browser = await cdp.launch()
  console.log(`[verify:ui] browser: ${browser.executable} (devtools port ${browser.port})`)

  try {
    const page = await browser.newPage()
    // Navigation must NOT block on #root. A page that answers 200 but never
    // mounts React (the white screen) is the core failure mode of BUG-086; if we
    // waited for the root here, that case would surface as a navigation timeout
    // and get misclassified as an environment problem (exit 2). Mounting is
    // asserted separately, below, so it is reported as a real FAIL (exit 1).
    try {
      await page.goto(APP_URL, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS,
        settleMs: 1500,
        waitForRoot: false,
        rootSelector: '#root',
      })
    } catch (err) {
      const reason = err && err.message ? err.message : String(err)
      console.error(`[verify:ui] navigation failed: ${reason}`)
      console.error(`[verify:ui] dev server unreachable: ${APP_URL} did not load`)
      dumpResults()
      console.error('[verify:ui] RESULT: UNREACHABLE (exit 2)')
      return 2
    }

    // Give React a bounded chance to mount. A timeout here is NOT fatal --
    // the assertion below is what decides, so a white screen stays a FAIL
    // (exit 1) rather than becoming an environment error.
    try {
      await page.waitForFunction(
        selector => {
          const root = document.querySelector(selector)
          return Boolean(root && root.children.length > 0)
        },
        { timeout: 8000, intervalMs: 200, args: ['#root'] },
      )
    } catch (_err) {
      // Fall through: reported by the "#root mounted with children" assertion.
    }

    const html = await page.content()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const domPath = path.join(OUT_DIR, `ui-render-${stamp}.html`)
    fs.writeFileSync(domPath, html, 'utf8')
    console.log(`[verify:ui] rendered DOM snapshot: ${domPath} (${Buffer.byteLength(html, 'utf8')} bytes)`)

    console.log('')
    console.log('--- assertions ---')

    // 1. React root mounted with real children -- THE white-screen assertion.
    const rootMounted = await check(results, '#root mounted with children', async () => {
      const info = await page.evaluate(() => {
        const root = document.querySelector('#root')
        return root ? { found: true, children: root.children.length } : { found: false, children: 0 }
      })
      if (!info.found) throw new Error('#root not found in DOM (app did not mount / white screen)')
      if (info.children <= 0) {
        throw new Error('#root has 0 children (app did not mount / white screen)')
      }
      return true
    })

    // 2. Visible text is non-empty (a white screen has none).
    await check(results, 'body innerText is non-empty', async () => {
      const text = await page.innerText()
      if (text.trim().length <= 0) throw new Error('body.innerText is empty')
      return true
    })

    // 3. No Vite error overlay / resolve failures / uncaught markers.
    for (const marker of FORBIDDEN_MARKERS) {
      await check(results, `no ${marker.name}`, async () => {
        if (marker.kind === 'selector') {
          const count = await page.evaluate(sel => {
            const byTag = document.getElementsByTagName(sel).length
            const byQuery = document.querySelectorAll(`[id="${sel}"], .${sel}`).length
            return byTag + byQuery
          }, marker.value)
          if (count > 0) throw new Error(`found ${count} occurrence(s) of ${marker.value}`)
          return true
        }
        const hits = await page.evaluate(needle => {
          const text = document.body ? document.body.innerText : ''
          let n = 0
          let i = text.indexOf(needle)
          while (i >= 0) {
            n += 1
            i = text.indexOf(needle, i + needle.length)
          }
          return n
        }, marker.value)
        if (hits > 0) throw new Error(`found ${hits} occurrence(s) of "${marker.value}"`)
        return true
      })
    }

    // 4. No uncaught page exceptions.
    await check(results, 'no uncaught page errors', async () => {
      const errors = page.pageErrors()
      if (errors.length > 0) throw new Error(`pageErrors: ${JSON.stringify(errors.slice(0, 5))}`)
      return true
    })

    // 5. No console errors. CORS noise is separated out and only warned about:
    //    it means a wrong origin, not a broken render. Real load failures still fail.
    await check(results, 'no console errors', async () => {
      const all = page.consoleErrors()
      const blockedHosts = corsBlockedHosts(all)
      const isCorsFallout = msg => {
        if (CORS_NOISE.test(msg)) return true
        // The load failure a CORS block causes, but only for the blocked host.
        if (!/net::ERR_FAILED|net::ERR_ABORTED/.test(msg)) return false
        const urlHit = /(https?:\/\/[^\s\]'"]+)/.exec(msg)
        if (!urlHit) return false
        try {
          return blockedHosts.has(new URL(urlHit[1]).host)
        } catch (_err) {
          return false
        }
      }
      for (const msg of all) {
        if (isCorsFallout(msg)) corsNoise.push(msg)
      }
      const real = all.filter(msg => !isCorsFallout(msg) && !BENIGN_CONSOLE.some(re => re.test(msg)))
      if (real.length > 0) throw new Error(`consoleErrors: ${JSON.stringify(real.slice(0, 5))}`)
      return true
    })

    // 6. Required data-testid anchors.
    const foundTestIds = await page.evaluate(ids => {
      const present = []
      for (const id of ids) {
        if (document.querySelector(`[data-testid="${id}"]`)) present.push(id)
      }
      return present
    }, REQUIRED_TESTIDS)

    for (const id of REQUIRED_TESTIDS) {
      const ok = foundTestIds.includes(id)
      results.push({ name: `data-testid "${id}"`, ok, detail: ok ? '' : 'element not found in rendered DOM' })
      console.log(`${ok ? 'PASS' : 'FAIL'}  data-testid "${id}"`)
    }
    const missingCritical = CRITICAL_TESTIDS.filter(id => !foundTestIds.includes(id))
    if (missingCritical.length > 0) {
      results.push({
        name: 'critical data-testid subset',
        ok: false,
        detail: `missing: ${missingCritical.join(', ')}`,
      })
      console.log(`FAIL  critical data-testid subset  -- missing: ${missingCritical.join(', ')}`)
    } else {
      results.push({ name: 'critical data-testid subset', ok: true, detail: '' })
      console.log('PASS  critical data-testid subset')
    }

    console.log('')
    const total = results.length
    const failed = results.filter(r => !r.ok)
    const passed = total - failed.length
    console.log(`[verify:ui] ${passed}/${total} assertions passed`)

    // CORS noise is never silent: it is a real misconfiguration (wrong origin),
    // just not a render failure.
    if (corsNoise.length > 0) {
      console.log('')
      console.log(`--- WARNINGS (${corsNoise.length}) ---`)
      for (const msg of corsNoise.slice(0, 5)) console.log(`  ! CORS: ${msg}`)
      console.log('  ! CORS noise means the app is served from a non-canonical origin;')
      console.log('  ! the daemon whitelists origins, so verify against :5180 (see verify/README.md).')
    }

    if (failed.length > 0) {
      console.log('')
      console.log('--- FAILURES ---')
      for (const item of failed) console.log(`  - ${item.name}: ${item.detail || 'n/a'}`)
      if (!rootMounted) {
        console.error('[verify:ui] app did not mount (white screen) -- assertion failure, not an environment problem')
      }
      console.log(`[verify:ui] RESULT: FAIL (${failed.length} failed)`)
      return 1
    }
    console.log('[verify:ui] RESULT: PASS')
    return 0
  } finally {
    await browser.close()
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:ui] ERROR: ${err && err.stack ? err.stack : err}`)
    dumpResults()
    console.error('[verify:ui] RESULT: UNREACHABLE (exit 2)')
    process.exit(2)
  })
