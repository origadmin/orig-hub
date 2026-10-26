'use strict'

/**
 * BUG-133 end-to-end: prove the USER-VISIBLE number falls when bytes are cleared.
 *
 * Runs only against the **isolated** backend (`--isolated` spawns its own orig-tg on
 * its own port with its own DB + library + download dirs). The user's real library is
 * never written to — deleting real bytes would be irreversible user-data loss
 * (same reasoning as BUG-161 / verify/lib/sandbox.cjs).
 *
 * What it proves, in one pass, on screen:
 *   before: 占用 <disk>  · 登记 <registered>     <- registered >> disk
 *   clear one item's bytes (API)
 *   after:  占用 <smaller>  · 登记 <unchanged>   <- BUG-051 intact, disk fell
 *
 * Screenshots + JSON land in verify/evidence/BUG-133/e2e/.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const cdp = require('./lib/cdp.cjs')

const OUT = path.join(__dirname, 'evidence', 'BUG-133', 'e2e')
// __dirname = <repo>/tauri-shell/verify -> repo root is three levels up.
const REPO = path.resolve(__dirname, '..', '..')
const ISO_PORT = 19889
const VITE_PORT = 1677
const SHELL = `http://127.0.0.1:${VITE_PORT}/`
const TG = `http://127.0.0.1:${ISO_PORT}`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || '' })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  |  ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(p, init) {
  const r = await fetch(`${TG}${p}`, init)
  if (!r.ok) throw new Error(`${p} -> ${r.status}: ${await r.text()}`)
  return r.json()
}
function bytesOf(t) {
  if (!t) return null
  const m = String(t).match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i)
  if (!m) return null
  return Math.round(
    parseFloat(m[1]) * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()],
  )
}

const PIN_TG_PORT = (port) => {
  const daemonOrigin = 'http://127.0.0.1:19786'
  const stub = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }))
  const orig = window.fetch
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url
      if (url && url.indexOf(daemonOrigin) === 0) {
        if (/\/api\/config(\?|$)/.test(url)) {
          // BUG-423：前端自 BUG-358 起只读 plugins[]（useStore:
          // `tgServiceFromPlugins(cfg)` → `setTgPort(svc.port)`），只注入旧键
          // tg_port 等于没钉（app 回落 VITE_TG_PORT 初值 19787 ⇒ 打错端口）。
          // 钉 plugins[] 里 id="tg" 的 port，真配置其余字段保留；旧键一并写上。
          return orig.call(this, input, init).then(r => r.json()).catch(() => ({})).then(b => {
            const plugins = Array.isArray(b.plugins) ? b.plugins.slice() : []
            const i = plugins.findIndex((x) => x && x.id === 'tg')
            const pinned = { id: 'tg', label: 'Telegram', enabled: true, running: true, port: Number(port), lastError: null, health: null }
            if (i >= 0) plugins[i] = { ...plugins[i], ...pinned }
            else plugins.push(pinned)
            return stub({ ...b, plugins, tg_port: Number(port) })
          })
        }
        return stub({ ok: true, events: [], items: [] })
      }
    } catch { /* fall through */ }
    return orig.call(this, input, init)
  }
}

const READ_PANEL = () => {
  const disk = document.querySelector('[data-testid="media-disk-usage"]')
  const reg = document.querySelector('[data-testid="media-registered-size"]')
  return {
    diskText: disk ? disk.textContent.trim() : null,
    diskTitle: disk ? disk.getAttribute('title') : null,
    registeredText: reg ? reg.textContent.trim() : null,
    registeredTitle: reg ? reg.getAttribute('title') : null,
  }
}

async function waitFor(fn, ms = 40000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(400)
  }
  return false
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug133-e2e-'))
  const lib = path.join(root, 'library', 'chat')
  const dl = path.join(root, 'downloads')
  fs.mkdirSync(lib, { recursive: true })
  fs.mkdirSync(dl, { recursive: true })
  // Registered size deliberately >> on-disk size, so the two bases cannot coincide.
  fs.writeFileSync(path.join(dl, 'big.mp4'), Buffer.alloc(2 * 1024 * 1024, 7))

  const exe = path.join(REPO, '.cargo-target-bug133', 'debug', 'orig-tg.exe')
  const backend = spawn(exe, [], {
    env: {
      ...process.env,
      ORIG_TG_PORT: String(ISO_PORT),
      ORIG_TG_DB: path.join(root, 'store.db'),
      ORIG_TG_SESSION: path.join(root, 's.session'),
      ORIG_TG_LIBRARY_DIR: path.join(root, 'library'),
      ORIG_TG_DOWNLOAD_DIR: dl,
      ORIG_TG_EXTRA_ORIGINS: `http://127.0.0.1:${VITE_PORT}`,
      ORIG_TG_MOCK: '1',
    },
    stdio: 'ignore',
  })

  const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', 'false'], {
    cwd: path.join(REPO, 'tauri-shell'),
    env: { ...process.env, VITE_TG_PORT: String(ISO_PORT) },
    stdio: 'ignore',
    shell: true,
  })

  const browser = await cdp.launch()
  try {
    const up = await waitFor(async () => (await api('/api/media/stats')).items >= 0, 60000)
    if (!up) throw new Error('isolated backend never became ready')
    const viteUp = await waitFor(async () => (await fetch(SHELL)).ok, 60000)
    if (!viteUp) throw new Error('vite never became ready')

    // Register the fixture: 20 MiB declared, 2 MiB actually on disk.
    await api('/api/media/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ path: path.join(dl, 'big.mp4').replace(/\\/g, '/'), kind: 'video', size: 20 * 1024 * 1024, title: 'BUG-133 e2e' }],
      }),
    })

    const before = await api('/api/media/stats')
    console.log('\nBEFORE:', JSON.stringify(before))

    const page = await browser.newPage()
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', settleMs: 300, waitForRoot: false })
    await page.evaluate(PIN_TG_PORT, ISO_PORT)
    await page.goto(SHELL, { waitUntil: 'load', settleMs: 3000 })
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button,[role="tab"],a')).find(b =>
        /媒体库|资料库|media/i.test(b.textContent || ''))
      if (el) el.click()
    })
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="media-disk-usage"]')), { timeout: 20000 })

    const uiBefore = await page.evaluate(READ_PANEL)
    await page.screenshot(path.join(OUT, '01-before-clear.png'))
    fs.writeFileSync(path.join(OUT, '02-before.json'), JSON.stringify({ api: before, ui: uiBefore }, null, 2))

    check('panel shows the DISK basis as the leading figure', /磁盘/.test(uiBefore.diskTitle || ''), `text=${JSON.stringify(uiBefore.diskText)}`)
    check('registered basis shown separately and labelled', /登记/.test(uiBefore.registeredTitle || ''), `text=${JSON.stringify(uiBefore.registeredText)}`)
    check(
      'the two bases visibly differ on screen (registered >> disk)',
      bytesOf(uiBefore.diskText) < bytesOf(uiBefore.registeredText),
      `disk=${uiBefore.diskText} registered=${uiBefore.registeredText}`,
    )

    // ── clear the bytes (isolated data only) ────────────────────────────────
    const list = await api('/api/media/items?limit=10&offset=0')
    const item = (list.items || []).find(i => i.filePath)
    if (!item) throw new Error('no fixture item with bytes')
    await api(`/api/cache/items/${item.id}`, { method: 'DELETE' })

    const after = await api('/api/media/stats')
    console.log('AFTER: ', JSON.stringify(after))

    // Re-open the panel so the on-screen figure is re-read from the server.
    // (This CDP Page helper has no reload(); goto is the equivalent.)
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', settleMs: 300, waitForRoot: false })
    await page.evaluate(PIN_TG_PORT, ISO_PORT)
    await page.goto(SHELL, { waitUntil: 'load', settleMs: 3000 })
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button,[role="tab"],a')).find(b =>
        /媒体库|资料库|media/i.test(b.textContent || ''))
      if (el) el.click()
    })
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="media-disk-usage"]')), { timeout: 20000 })
    const uiAfter = await page.evaluate(READ_PANEL)
    await page.screenshot(path.join(OUT, '03-after-clear.png'))
    fs.writeFileSync(path.join(OUT, '04-after.json'), JSON.stringify({ api: after, ui: uiAfter }, null, 2))

    check(
      'JUDGEMENT 1 (API): diskBytes FELL after clearing bytes',
      after.diskBytes < before.diskBytes,
      `${before.diskBytes} -> ${after.diskBytes}`,
    )
    check(
      'BUG-051 unchanged: totalSize did NOT move and the item is still there',
      after.totalSize === before.totalSize && after.items === before.items,
      `totalSize ${before.totalSize} -> ${after.totalSize}; items ${before.items} -> ${after.items}`,
    )
    check(
      'JUDGEMENT 1 (ON SCREEN): the visible occupancy figure fell',
      bytesOf(uiAfter.diskText) < bytesOf(uiBefore.diskText),
      `${uiBefore.diskText} -> ${uiAfter.diskText}`,
    )
    check(
      'ON SCREEN: the registered figure stayed put (the two are visibly independent)',
      bytesOf(uiAfter.registeredText) === bytesOf(uiBefore.registeredText),
      `${uiBefore.registeredText} -> ${uiAfter.registeredText}`,
    )
  } catch (e) {
    check('harness completed without throwing', false, String((e && e.stack) || e))
  } finally {
    await browser.close()
    try { backend.kill() } catch { /* gone */ }
    try { vite.kill() } catch { /* gone */ }
  }

  const passed = results.filter(r => r.ok).length
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ bug: 'BUG-133', when: new Date().toISOString(), passed, total: results.length, results }, null, 2))
  console.log(`\n${passed}/${results.length} checks passed`)
  process.exit(passed === results.length ? 0 : 1)
}

main()