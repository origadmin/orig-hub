#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance: TG 入口级门控 = **「服务可用？否 → 不显示 TG」**（BUG-177）。
 *
 * 回退事实（2026-09-29）：orig-tg 是 daemon 托管的子进程，但入口门控只看开关
 * `tgEnabled`，于是「已开启却连不上」被当成一种合法产品状态呈现给用户
 * （面板里写着「调试模式：TG 未连接」），用户据此怀疑「数据是不是丢了」。
 *
 * 本脚本**不接受**「页面能打开」或「字符串存在」当证据。真值来自两处且必须在浏览器内对齐：
 *   1. daemon `GET /api/config` 的 `tg_enabled` / `tg_running` / `tg_last_error`；
 *   2. 浏览器**自己**那个 TG base（动态 import `/src/api/tg.ts` 取 `TG_BASE`，
 *      与 App 同源，不硬编码端口）的 `/health` 可达性。
 * 断言：`nav-tg` 存在 ⇔ (开关开 ∧ 浏览器 TG base 可达)。
 *
 * 同一脚本在「后端活 / 后端死」两种状态下都要跑：两次都得 PASS，
 * 才能证明门控真的双向生效（只在一个方向绿 = 恒绿断言）。
 *
 * Usage:
 *   node verify/verify_tg_gating.cjs
 *   APP_URL=http://127.0.0.1:5180/ DAEMON_PORT=18776 node verify/verify_tg_gating.cjs
 *
 * Exit: 0 = all passed, 1 = assertion failed, 2 = environment problem.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 9876)
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-tggating')
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

const SETTINGS_HEADING = '下载设置'
/** 设置页 TG 开关所在页签（默认页签是 downloads，必须先切） */
const GENERAL_TAB_TESTID = 'settings-tab-general'

const results = []

function check(name, fn, detail = '') {
  let ok = false
  let message = ''
  try {
    ok = Boolean(fn())
  } catch (err) {
    ok = false
    message = err && err.message ? err.message : String(err)
  }
  results.push({ name, ok, detail: message || detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${message || detail}`}`)
  return ok
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

  // ---- 1. daemon 侧的开关与运行态（单一真源）----
  let daemon = null
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/config`)
    daemon = await res.json()
  } catch (err) {
    console.error(`[verify:tggating] daemon unreachable on ${DAEMON_PORT}: ${err.message}`)
    console.error('[verify:tggating] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  const tgEnabled = daemon.tg_enabled === true
  const tgRunning = daemon.tg_running === true
  const tgLastError = daemon.tg_last_error ?? null
  console.log(
    `[verify:tggating] daemon: tg_enabled=${tgEnabled} tg_running=${tgRunning} tg_port=${daemon.tg_port}`,
  )
  if (tgLastError) console.log(`[verify:tggating] daemon tg_last_error = ${JSON.stringify(tgLastError)}`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, {
      waitUntil: 'load',
      timeout: NAV_TIMEOUT_MS,
      settleMs: 2000,
      waitForRoot: false,
      rootSelector: '#root',
    })
    await page.waitForFunction(
      sel => {
        const r = document.querySelector(sel)
        return Boolean(r && r.children.length > 0)
      },
      { timeout: 15000, intervalMs: 200, args: ['#root'] },
    )

    // ---- 2. 浏览器**自己**的 TG base（与 App 同源，不猜端口）----
    const tgProbe = await page.evaluate(async () => {
      const mod = await import('/src/api/tg.ts')
      const base = mod.TG_BASE
      let reachable = false
      try {
        const r = await fetch(`${base}/health`)
        reachable = r.ok
      } catch (_e) {
        reachable = false
      }
      return { base, reachable }
    })
    console.log(
      `[verify:tggating] browser TG_BASE=${tgProbe.base} reachable=${tgProbe.reachable}`,
    )

    const expectedVisible = tgEnabled && tgProbe.reachable
    console.log(`[verify:tggating] expected nav-tg visible = ${expectedVisible}`)
    console.log('')
    console.log('--- assertions ---')

    // 门控是异步的（TG 探测要等），有界轮询而不是采样一次。
    await waitForNavTg(page, expectedVisible)

    const nav = await page.evaluate(() => ({
      present: Boolean(document.querySelector('[data-testid="nav-tg"]')),
      navIds: Array.from(document.querySelectorAll('[data-testid^="nav-"]'))
        .map(e => e.getAttribute('data-testid'))
        .filter(Boolean),
    }))
    console.log(`[verify:tggating] nav testids = ${JSON.stringify(nav.navIds)}`)

    check(
      expectedVisible
        ? 'TG 服务可达 → 侧栏必须有 nav-tg 入口'
        : 'TG 服务不可达 → 侧栏不得有 nav-tg 入口（核心设计）',
      () => nav.present === expectedVisible,
      `nav-tg present=${nav.present} expected=${expectedVisible}`,
    )

    // ---- 3. 设置页：开关状态与失败原因必须诚实 ----
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-settings"]')
      if (!el) return false
      el.click()
      return true
    })
    check('nav-settings anchor exists and is clickable', () => clicked)
    await page.waitForFunction(
      needle => document.body.innerText.includes(needle),
      { timeout: 15000, intervalMs: 200, args: [SETTINGS_HEADING] },
    )
    await page.evaluate(testid => {
      const el = document.querySelector(`[data-testid="${testid}"]`)
      if (el) el.click()
    }, GENERAL_TAB_TESTID)

    // 状态文案由异步 getConfig 填充 → 有界轮询到目标文案。
    const wantStatus = tgEnabled ? (tgRunning ? '运行中' : '启动失败') : '已停止'
    await page.waitForFunction(
      want =>
        (document.querySelector('[data-testid="tg-toggle-status"]')?.textContent || '').trim() ===
        want,
      { timeout: 8000, intervalMs: 150, args: [wantStatus] },
    ).catch(() => {})

    // 失败原因由**另一次**异步 getConfig 填充，比状态文案晚一步落 DOM；
    // 有界等它，而不是采样一次（采样一次等于在跟网络赛跑，不是断言行为）。
    if (tgEnabled && !tgRunning) {
      await page
        .waitForFunction(
          () =>
            (document.querySelector('[data-testid="tg-toggle-error"]')?.textContent || '').trim()
              .length > 0,
          { timeout: 8000, intervalMs: 150 },
        )
        .catch(() => {})
    }

    const tgUi = await page.evaluate(() => ({
      status: (document.querySelector('[data-testid="tg-toggle-status"]')?.textContent || '').trim(),
      error: (document.querySelector('[data-testid="tg-toggle-error"]')?.textContent || '').trim(),
      bodyHasDebugMode: document.body.innerText.includes('调试模式'),
    }))
    console.log(`[verify:tggating] settings TG status = ${JSON.stringify(tgUi.status)}`)
    if (tgUi.error) console.log(`[verify:tggating] settings TG error = ${JSON.stringify(tgUi.error)}`)

    check(
      `设置页 TG 状态文案如实（期望「${wantStatus}」）`,
      () => tgUi.status === wantStatus,
      `ui=${JSON.stringify(tgUi.status)} want=${JSON.stringify(wantStatus)}`,
    )

    if (tgEnabled && !tgRunning) {
      check(
        '开启但没在跑 → 必须给出可核的失败原因（不是「启动中」骗人等）',
        () => tgUi.error.length > 0,
        'tg-toggle-error 为空：用户会以为 TG 只是还没启动完',
      )
      check(
        '失败原因来自 daemon 的 tg_last_error（可核，非前端自造）',
        () => Boolean(tgLastError) && tgUi.error.includes(tgLastError),
        `daemon=${JSON.stringify(tgLastError)} ui=${JSON.stringify(tgUi.error)}`,
      )
    } else if (tgEnabled && tgRunning) {
      check('服务在跑 → 不得残留失败原因', () => tgUi.error.length === 0, tgUi.error)
    }

    check(
      '产品里不存在「调试模式：TG 未连接」这种把开发脚手架当产品态的文案',
      () => tgUi.bodyHasDebugMode === false,
      '页面上仍有「调试模式」字样',
    )

    const shot = path.join(OUT_DIR, `tg-gating-${expectedVisible ? 'visible' : 'hidden'}.png`)
    await page.screenshot(shot)
    console.log(`[verify:tggating] screenshot -> ${shot}`)
  } finally {
    await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:tggating] ${results.length - failed}/${results.length} assertions passed`)
  return failed === 0 ? 0 : 1
}

/** 门控依赖异步 TG 探测 → 有界等待到期望态（超时由断言本身报告，不在这里吞掉）。 */
async function waitForNavTg(page, expected) {
  try {
    await page.waitForFunction(
      want => Boolean(document.querySelector('[data-testid="nav-tg"]')) === want,
      { timeout: 15000, intervalMs: 200, args: [expected] },
    )
  } catch (_err) {
    /* 由下面的断言报告 */
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:tggating] fatal: ${err && err.stack ? err.stack : err}`)
    process.exit(2)
  })
