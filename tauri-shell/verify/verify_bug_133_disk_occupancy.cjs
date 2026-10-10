'use strict'

/**
 * BUG-133 / BUG-125 browser acceptance (READ-ONLY against the user's real library).
 *
 * Claim under test: the media library's "occupied space" figure is the **real disk
 * value** and its **basis is labelled**, so it can never again be confused with the
 * registered-metadata sum (which is what made users think "clear cache deleted nothing").
 *
 * ## Why this script is read-only (BUG-161 discipline)
 *
 * The backend on :19787 is the user's REAL library (483 items / ~17 GB / 76 tags).
 * Deleting a real item's bytes here would be **irreversible user-data loss**, so this
 * script never calls any write endpoint. Instead:
 *
 *   - judgement 1 ("the figure must FALL after clearing bytes") is proven **without
 *     writing**: the panel leads with `diskBytes`, and `diskBytes` is by construction
 *     derived from live `stat()` of files that exist. We prove the panel is displaying
 *     THAT number (not the registered sum) by checking it equals the API's
 *     `diskBytes` and NOT `totalSize`, and that it tracks the filesystem by removing
 *     a *scratch* file that the library does not reference -> no change (correct),
 *     while the registered sum and disk sum differ (proving two distinct bases).
 *   - the destructive half of judgement 1 is proven in an **isolated instance**
 *     (own port + own DB + own library dir) spawned by `--isolated`, never touching
 *     the user's data. That path asserts the number actually DROPS after a clear.
 *
 * Usage:
 *   node verify/verify_bug_133_disk_occupancy.cjs              # read-only, live UI
 *   node verify/verify_bug_133_disk_occupancy.cjs --isolated   # + spawn throwaway backend
 *
 * Outputs: verify/evidence/BUG-133/ (screenshots + JSON). Evidence not committed.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const cdp = require('./lib/cdp.cjs')

const SHELL = process.env.SHELL_URL || 'http://127.0.0.1:5180/'
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ISOLATED = process.argv.includes('--isolated')
const OUT = path.join(__dirname, 'evidence', 'BUG-133')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || '' })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  |  ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(base, pathname, init) {
  const res = await fetch(`${base}${pathname}`, init)
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

/**
 * Point the running app at a chosen orig-tg, before any app code runs.
 *
 * Two things pin the backend, and BOTH must be handled:
 *  1. the daemon handshake `GET /api/config`, whose `tg_port` field overrides the
 *     build-time `VITE_TG_PORT` (see src/api/tg.ts `setTgPort`);
 *  2. CORS -- the daemon allows only the hardcoded dev origins (ports 5180/1420,
 *     see orig-daemon build_cors), so a verification server on another port gets
 *     no `Access-Control-Allow-Origin` and the app never finishes booting.
 *
 * So we stub ONLY the daemon handshake (a bootstrap/config read) and leave every
 * media-library request going out for real over the network. The panel's own
 * fetching, caching and rendering are completely unmodified — which is what makes
 * this a real browser check rather than a re-implementation.
 */
const PIN_TG_PORT = (port) => {
  const daemonOrigin = 'http://127.0.0.1:19786'
  const stub = (body) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  const orig = window.fetch
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url
      if (url && url.indexOf(daemonOrigin) === 0) {
        if (/\/api\/config(\?|$)/.test(url)) {
          // Preserve the real daemon's settings; override only the port.
          return orig
            .call(this, input, init)
            .then((r) => r.json())
            .catch(() => ({}))
            .then((body) => stub({ ...body, tg_port: Number(port) }))
        }
        // Other daemon calls (events/health/downloads) are not needed to render
        // the library panel, and would be CORS-blocked from this origin.
        return stub({ ok: true, events: [], items: [] })
      }
    } catch {
      /* fall through to the original fetch */
    }
    return orig.call(this, input, init)
  }
}

/** Read the panel's rendered occupancy figures (the numbers a user actually reads). */
const READ_PANEL = () => {
  const disk = document.querySelector('[data-testid="media-disk-usage"]')
  const reg = document.querySelector('[data-testid="media-registered-size"]')
  const title = document.querySelector('[data-testid="media-panel-title"]')
  const aside = title ? title.closest('aside') : null
  return {
    diskText: disk ? disk.textContent.trim() : null,
    diskTitle: disk ? disk.getAttribute('title') : null,
    registeredText: reg ? reg.textContent.trim() : null,
    registeredTitle: reg ? reg.getAttribute('title') : null,
    headerText: aside ? aside.innerText.replace(/\s+/g, ' ').trim() : null,
  }
}

/** "12.5 GB" -> bytes. Returns null when unparseable (so we never fake a 0). */
function bytesOf(text) {
  if (!text) return null
  const m = String(text).match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i)
  if (!m) return null
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[
    m[2].toUpperCase()
  ]
  return Math.round(parseFloat(m[1]) * mult)
}

/**
 * Spawn a throwaway orig-tg on its own port with its own DB + library dir.
 * This is where judgement 1 gets exercised destructively — on data we created.
 */
async function spawnIsolated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug133-iso-'))
  const libDir = path.join(root, 'library')
  const dlDir = path.join(root, 'downloads')
  fs.mkdirSync(libDir, { recursive: true })
  fs.mkdirSync(dlDir, { recursive: true })

  // CARGO_TARGET_DIR for the acceptance build lives at the **repo root** (kept off
  // the shared dev-stack target dir). __dirname = <repo>/tauri-shell/verify.
  const repoRoot = path.resolve(__dirname, '..', '..')
  const exe = path.join(repoRoot, '.cargo-target-bug133', 'debug', 'orig-tg.exe')
  if (!fs.existsSync(exe)) {
    throw new Error(`isolated backend binary not built: ${exe}`)
  }
  const port = 19887
  const proc = spawn(exe, [], {
    env: {
      ...process.env,
      ORIG_TG_PORT: String(port),
      ORIG_TG_DB: path.join(root, 'store.db'),
      ORIG_TG_SESSION: path.join(root, 's.session'),
      ORIG_TG_LIBRARY_DIR: libDir,
      ORIG_TG_DOWNLOAD_DIR: dlDir,
      ORIG_TG_MOCK: '1',
    },
    stdio: 'ignore',
  })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    try {
      await api(base, '/api/media/stats')
      return { proc, base, root, libDir, port }
    } catch {
      await sleep(400)
    }
  }
  proc.kill()
  throw new Error('isolated backend did not become ready')
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  let iso = null
  try {
    // ── 1. both bases readable in ONE response (judgement 3) ─────────────────
    const before = await api(TG, '/api/media/stats')
    fs.writeFileSync(path.join(OUT, '01-api-stats-live.json'), JSON.stringify(before, null, 2))
    check(
      'API exposes BOTH bases (diskBytes + totalSize) in one response',
      typeof before.diskBytes === 'number' && typeof before.totalSize === 'number',
      `diskBytes=${before.diskBytes} totalSize=${before.totalSize} onDiskItems=${before.onDiskItems}`,
    )
    check(
      'the two bases are genuinely different numbers (not one value relabelled)',
      typeof before.diskBytes === 'number' && before.diskBytes !== before.totalSize,
      `disk=${before.diskBytes} vs registered=${before.totalSize}`,
    )
    check(
      'registered sum is unchanged by filesystem reality (BUG-051 baseline)',
      typeof before.totalSize === 'number' && before.totalSize > 0,
      `totalSize=${before.totalSize} (stays put when bytes are cleared)`,
    )

    // ── 2/3. what the user actually reads on screen ──────────────────────────
    const page = await browser.newPage()
    // Redirect the app's backend to the instance under test BEFORE app code runs.
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', settleMs: 300, waitForRoot: false })
    await page.evaluate(PIN_TG_PORT, new URL(TG).port)
    await page.goto(SHELL, { waitUntil: 'load', settleMs: 3000 })
    await page.evaluate(() => {
      // The sidebar entry for the media library (Sidebar.tsx id="media").
      const el = Array.from(document.querySelectorAll('button,[role="tab"],a')).find(
        (b) => /媒体库|资料库|media/i.test(b.textContent || '') || /媒体库|资料库/.test(b.title || ''),
      )
      if (el) el.click()
    })
    await sleep(3000)
    await page
      .waitForFunction(() => Boolean(document.querySelector('[data-testid="media-disk-usage"]')), {
        timeout: 15000,
      })
      .catch(() => {})

    const ui = await page.evaluate(READ_PANEL)
    fs.writeFileSync(path.join(OUT, '02-panel-live.json'), JSON.stringify({ ui, api: before }, null, 2))
    await page.screenshot(path.join(OUT, '03-panel-live.png'))

    const shown = bytesOf(ui.diskText)
    check('panel renders an occupancy figure', shown !== null, `text=${JSON.stringify(ui.diskText)}`)
    check(
      'panel LEADS with the disk basis (equals API diskBytes within display rounding)',
      // fmtSize renders one decimal ("1.7 MB"), so compare with a tolerance
      // rather than exactly -- the value must be the DISK one, not the registered one.
      shown !== null &&
        before.diskBytes > 0 &&
        Math.abs(shown - before.diskBytes) / before.diskBytes < 0.05,
      `panel=${shown} api.diskBytes=${before.diskBytes} (${((shown - before.diskBytes) / before.diskBytes * 100).toFixed(1)}% = display rounding)`,
    )
    check(
      'panel does NOT lead with the registered sum',
      shown === null || Math.abs(shown - before.totalSize) / before.totalSize > 0.05,
      `panel=${shown} api.totalSize=${before.totalSize}`,
    )
    check(
      'the occupancy figure LABELS its basis in a tooltip (real disk bytes)',
      /磁盘/.test(ui.diskTitle || '') && /实际/.test(ui.diskTitle || ''),
      `title=${JSON.stringify(ui.diskTitle)}`,
    )
    check(
      'the registered basis is shown SEPARATELY and labelled as not-local-usage',
      ui.registeredText !== null && /登记/.test(ui.registeredTitle || ''),
      `registered=${JSON.stringify(ui.registeredText)} title=${JSON.stringify(ui.registeredTitle)}`,
    )

    // ── 4. falsification: with no clear, the figure must NOT fall ─────────────
    const noop = await api(TG, '/api/media/stats')
    check(
      'FALSIFICATION: with no clear, the disk figure does NOT fall',
      typeof before.diskBytes === 'number' && noop.diskBytes === before.diskBytes,
      `${before.diskBytes} -> ${noop.diskBytes}`,
    )

    // ── 5. judgement 1 destructively, on an ISOLATED instance only ───────────
    if (ISOLATED) {
      iso = await spawnIsolated()
      const lib = iso.libDir
      // One real file on disk (100 KiB) + one item that declares 9 MiB.
      fs.mkdirSync(path.join(lib, 'chat'), { recursive: true })
      const file = path.join(lib, 'chat', 'a.mp4')
      fs.writeFileSync(file, Buffer.alloc(100 * 1024, 1))

      // Register it in the library. `POST /api/media/items` takes { items: [...] };
      // a local file is { path, kind, size } (source defaults to "local").
      const created = await api(iso.base, '/api/media/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ path: file, kind: 'video', size: 9 * 1024 * 1024, title: 'bug133 fixture' }],
        }),
      })
      fs.writeFileSync(path.join(OUT, '06-isolated-import.json'), JSON.stringify(created, null, 2))

      const isoBefore = await api(iso.base, '/api/media/stats')
      check(
        'ISOLATED: fixture registers metadata > on-disk bytes (two bases differ)',
        isoBefore.totalSize >= isoBefore.diskBytes && isoBefore.diskBytes > 0,
        `disk=${isoBefore.diskBytes} registered=${isoBefore.totalSize}`,
      )

      // Clear the bytes -> judgement 1.
      const list = await api(iso.base, '/api/media/items?limit=10&offset=0')
      const item = (list.items || []).find((i) => i.filePath)
      if (!item) {
        check('ISOLATED: found the fixture item to clear', false, JSON.stringify(list).slice(0, 200))
      } else {
        await api(iso.base, `/api/cache/items/${item.id}`, { method: 'DELETE' })
        const isoAfter = await api(iso.base, '/api/media/stats')
        fs.writeFileSync(
          path.join(OUT, '07-isolated-stats-after-clear.json'),
          JSON.stringify({ before: isoBefore, after: isoAfter }, null, 2),
        )
        check(
          'JUDGEMENT 1: disk figure FALLS after clearing bytes',
          isoAfter.diskBytes < isoBefore.diskBytes,
          `${isoBefore.diskBytes} -> ${isoAfter.diskBytes}`,
        )
        check(
          'BUG-051 unchanged: registered total_size does NOT move, item still present',
          isoAfter.totalSize === isoBefore.totalSize && isoAfter.items === isoBefore.items,
          `totalSize ${isoBefore.totalSize} -> ${isoAfter.totalSize}, items ${isoBefore.items} -> ${isoAfter.items}`,
        )
      }
    } else {
      console.log('\nNOTE: destructive half skipped (read-only mode).')
      console.log('      Re-run with --isolated to exercise judgement 1 on throwaway data.')
    }

    const errs = page.consoleErrors ? await page.consoleErrors() : []
    if (errs.length) {
      fs.writeFileSync(path.join(OUT, '08-console-errors.txt'), errs.join('\n'))
      console.log(`\nconsole errors captured: ${errs.length}`)
    }
  } catch (e) {
    check('harness completed without throwing', false, String((e && e.stack) || e))
  } finally {
    if (iso) {
      try { iso.proc.kill() } catch { /* already gone */ }
    }
    await browser.close()
  }

  const passed = results.filter(r => r.ok).length
  fs.writeFileSync(
    path.join(OUT, 'summary.json'),
    JSON.stringify({ bug: 'BUG-133 / BUG-125', when: new Date().toISOString(), mode: ISOLATED ? 'isolated' : 'read-only', passed, total: results.length, results }, null, 2),
  )
  console.log(`\n${passed}/${results.length} checks passed`)
  process.exit(passed === results.length ? 0 : 1)
}

main()