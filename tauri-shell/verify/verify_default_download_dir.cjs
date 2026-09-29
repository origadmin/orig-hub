#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance: 设置页「默认下载目录」必须显示**本机真实**目录。
 *
 * 历史回退（多次反馈「显示为 Linux 路径」）：占位符被写死成 i18n `~/Downloads`
 * （Unix 风格），在 Windows 上完全误导。修复后由 daemon 的 `default_download_dir`
 * （OS known-folder API）下发，前端只把它当占位/回退。
 *
 * 本脚本不接受「页面能打开」当证据：它拉取 daemon 的真实值，再断言 **UI 上渲染的
 * 占位符与该值逐字相等**，并反向断言任何占位符都不含 `~`。
 *
 * Usage:
 *   node verify/verify_default_download_dir.cjs
 *   APP_URL=http://127.0.0.1:5180/ DAEMON_PORT=18776 node verify/verify_default_download_dir.cjs
 *
 * Exit: 0 = all passed, 1 = assertion failed, 2 = environment problem.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 9876)
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-defaultdir')
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

/** i18n label of the control under test (zh-CN). */
const LABEL_TEXT = '默认下载目录'
/** Settings heading shown on the default (downloads) tab. */
const SETTINGS_HEADING = '下载设置'

const results = []

function check(name, fn, detail = '') {
  let ok = false
  let message = ''
  try {
    const value = fn()
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

function dumpResults() {
  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:defaultdir] ${results.length - failed}/${results.length} assertions passed`)
}

function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(`Refusing to write artifacts inside the repo (${resolved}).`)
  }
}

async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // 1. Ground truth from the daemon (single source of truth, OS-resolved).
  let expected = ''
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/config`)
    const cfg = await res.json()
    expected = String(cfg.default_download_dir || '')
  } catch (err) {
    console.error(`[verify:defaultdir] daemon unreachable on ${DAEMON_PORT}: ${err.message}`)
    console.error('[verify:defaultdir] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  console.log(`[verify:defaultdir] daemon default_download_dir = ${JSON.stringify(expected)}`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, {
      waitUntil: 'load',
      timeout: NAV_TIMEOUT_MS,
      settleMs: 1500,
      waitForRoot: false,
      rootSelector: '#root',
    })
    try {
      await page.waitForFunction(
        sel => {
          const r = document.querySelector(sel)
          return Boolean(r && r.children.length > 0)
        },
        { timeout: 10000, intervalMs: 200, args: ['#root'] },
      )
    } catch (_err) {
      /* reported by the assertion below */
    }

    console.log('')
    console.log('--- assertions ---')

    // root mounted: the white-screen assertion.
    const rootOk = await page.evaluate(() => {
      const r = document.querySelector('#root')
      return Boolean(r && r.children.length > 0)
    })
    check('#root mounted with children', () => rootOk, 'app did not mount (white screen)')

    // Navigate to Settings via its data-testid anchor.
    const navigated = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-settings"]')
      if (!el) return false
      el.click()
      return true
    })
    check('nav-settings anchor exists and is clickable', () => navigated, '[data-testid="nav-settings"] not found')

    try {
      await page.waitForFunction(
        needle => document.body.innerText.includes(needle),
        { timeout: 10000, intervalMs: 200, args: [SETTINGS_HEADING] },
      )
    } catch (_err) {
      /* reported below */
    }
    const headingShown = await page.evaluate(
      needle => document.body.innerText.includes(needle),
      SETTINGS_HEADING,
    )
    check(`settings downloads tab rendered ("${SETTINGS_HEADING}")`, () => headingShown)

    // `defaultDir` arrives from an async `getConfig()` fetch, so the control
    // legitimately renders the neutral i18n placeholder for a few ms first.
    // Poll (bounded) for the real value instead of sampling once -- otherwise
    // this test would merely be racing the network, not asserting behaviour.
    try {
      await page.waitForFunction(
        (label, want) => {
          const labels = Array.from(document.querySelectorAll('p,label,span,div'))
          const labelEl = labels.find(
            e => e.children.length === 0 && e.textContent.trim() === label,
          )
          if (!labelEl) return false
          let node = labelEl
          let input = null
          while (node && !input) {
            input = node.querySelector('input')
            if (!input) node = node.parentElement
          }
          return Boolean(input && (input.getAttribute('placeholder') || '') === want)
        },
        { timeout: 10000, intervalMs: 150, args: [LABEL_TEXT, expected] },
      )
    } catch (_err) {
      /* reported by the equality assertion below */
    }

    // Read the placeholder of the input belonging to the 默认下载目录 control.
    const ui = await page.evaluate(label => {
      const labels = Array.from(document.querySelectorAll('p,label,span,div'))
      const labelEl = labels.find(
        e => e.children.length === 0 && e.textContent.trim() === label,
      )
      if (!labelEl) return { found: false, reason: 'label not found' }
      let node = labelEl
      let input = null
      while (node && !input) {
        input = node.querySelector('input')
        if (!input) node = node.parentElement
      }
      if (!input) return { found: false, reason: 'input not found near label' }
      const all = Array.from(document.querySelectorAll('input[placeholder]')).map(
        i => i.getAttribute('placeholder') || '',
      )
      return {
        found: true,
        placeholder: input.getAttribute('placeholder') || '',
        allPlaceholders: all,
      }
    }, LABEL_TEXT)

    check(`control "${LABEL_TEXT}" located in DOM`, () => ui.found, ui.reason || '')

    const ph = ui.placeholder || ''
    console.log(`[verify:defaultdir] UI placeholder = ${JSON.stringify(ph)}`)

    check(
      'placeholder equals daemon default_download_dir (end-to-end)',
      () => ph === expected && expected.length > 0,
      `ui=${JSON.stringify(ph)} daemon=${JSON.stringify(expected)}`,
    )

    check(
      'placeholder is a Windows absolute path (drive + backslashes)',
      () => /^[A-Za-z]:\\/.test(ph),
      `got ${JSON.stringify(ph)}`,
    )

    check(
      'no placeholder anywhere contains a literal "~" (Unix-style regression)',
      () => !(ui.allPlaceholders || []).some(p => p.includes('~')),
      `placeholders=${JSON.stringify(ui.allPlaceholders)}`,
    )

    // TG module entry must be present in the sidebar.
    const tgNav = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (!el) return { found: false }
      const r = el.getBoundingClientRect()
      return { found: true, visible: r.width > 0 && r.height > 0, text: el.innerText.trim() }
    })
    check('TG module entry (nav-tg) is rendered and visible', () => tgNav.found && tgNav.visible, JSON.stringify(tgNav))

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shotPath = path.join(OUT_DIR, `default-dir-${stamp}.png`)
    await page.screenshot(shotPath)
    console.log(`[verify:defaultdir] screenshot: ${shotPath}`)
    const domPath = path.join(OUT_DIR, `default-dir-${stamp}.html`)
    fs.writeFileSync(domPath, await page.content(), 'utf8')
    console.log(`[verify:defaultdir] DOM snapshot: ${domPath}`)

    dumpResults()
    const failed = results.filter(r => !r.ok).length
    if (failed > 0) {
      console.error('[verify:defaultdir] RESULT: FAIL')
      return 1
    }
    console.log('[verify:defaultdir] RESULT: PASS')
    return 0
  } finally {
    await browser.close()
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:defaultdir] fatal: ${err && err.stack ? err.stack : err}`)
    dumpResults()
    process.exit(2)
  })
