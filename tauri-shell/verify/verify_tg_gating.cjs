#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance: TG 入口**常驻** + 面板内引导空态（BUG-094 口径改变 /
 * 模块重整 M0-T05，规划包 2026-10-13 拍板）。
 *
 * 2026-09-29 的旧口径（BUG-177）是「服务可用？否 → 不显示 TG」。它换来一个更坏的结果：
 * 插件未启用/未登录时用户**既看不到入口、也看不到引导**，只会以为「功能没了」。
 * 2026-10-13 起口径改为：**入口在任何状态下都不消失**，可用性判据
 * （`resolveTgFeatureReady`，仍只有这一份）移入 TgPanel 自己算，未就绪时渲染引导空态。
 * 故本脚本的核心断言由「nav-tg 存在 ⇔ 服务可达」改为「nav-tg **恒存在**」。
 *
 * 本脚本**不接受**「页面能打开」或「字符串存在」当证据。真值来自两处且必须在浏览器内对齐：
 *   1. daemon `GET /api/config` 的 TG 插件态（BUG-358 起 `plugins[]` id="tg" 的
 *      `enabled` / `running` / `lastError`，旧键 `tg_*` 兜底 —— BUG-423）；
 *   2. 浏览器**自己**那个 TG base（动态 import `/src/api/tg.ts` 取 `tgBase()`，
 *      BUG-423 修正：旧读法 `TG_BASE` 常量已不存在，且 /health 须答 JSON ok ——
 *      vite SPA 兜底会把打错端口的相对 URL 也答成 200，不能当可达证据）；
 *      与 App 同源，不硬编码端口）的 `/health` 可达性。
 * 断言（新口径）：
 *   a. `nav-tg` 在「后端活 / 后端死」两种状态下**都存在**（入口常驻）；
 *   b. 点进 TG 面板必须落到五态之一（引导/启动/未绑定/故障/正常两栏）—— 不能是白板；
 *   c. 设置·Telegram 区块的启停状态文案与 daemon 服务层原值一致（诚实性，旧口径保留）。
 *
 * Usage:
 *   node verify/verify_tg_gating.cjs
 *   APP_URL=http://127.0.0.1:5180/ DAEMON_PORT=19786 node verify/verify_tg_gating.cjs
 *
 * Exit: 0 = all passed, 1 = assertion failed, 2 = environment problem.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
/* daemon 端口运行时解析，**不写死**：本机 9876 属 WinNAT 保留段（绑不上 ⇒
   `os error 10013`），旧默认值 9876 会让脚本在任何机器上都报「daemon unreachable」，
   与「服务没起」不可区分。真源仍是 `GET <daemon>/api/config`（与侧栏徽标同源），
   默认值取本仓 dev 栈的 19786（与 verify_tg_ownership.cjs 一致）。 */
const DAEMON_PORT = Number(
  process.env.DAEMON_PORT || process.env.ORIG_DAEMON_API?.replace(/^https?:\/\/[^:]+:(\d+).*$/, '$1') || 19786,
)
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-tggating')
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

/** 设置页 TG 开关所在区块（M0-T07 起在「Telegram 插件」，默认区块是 general） */
const TG_SECTION_TESTID = 'settings-tab-telegram'

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
  // BUG-423：BUG-358 起契约是 plugins[]（id 取插件）；旧键兜底兼容
  const tgPlug = Array.isArray(daemon.plugins) ? daemon.plugins.find((x) => x && x.id === 'tg') : null
  const tgEnabled = tgPlug ? tgPlug.enabled === true : daemon.tg_enabled === true
  const tgRunning = tgPlug ? tgPlug.running === true : daemon.tg_running === true
  const tgLastError = tgPlug ? (tgPlug.lastError ?? null) : (daemon.tg_last_error ?? null)
  const tgPort = tgPlug && Number(tgPlug.port) > 0 ? Number(tgPlug.port) : daemon.tg_port
  console.log(
    `[verify:tggating] daemon: tg_enabled=${tgEnabled} tg_running=${tgRunning} tg_port=${tgPort}`,
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
      // BUG-423 同族腐烂：模块早把 `TG_BASE` 常量改成 `tgBase()` 函数（端口运行期
      // 可变），旧读法恒得 undefined；`fetch("undefined/health")` 是相对 URL，
      // 被 vite dev server 的 SPA 兜底答 200 ⇒ reachable=true 是**假绿**。
      // 故：取 `tgBase()`，且 /health 必须答 application/json {"status":"ok"}
      // （orig-tg 文档响应），SPA 兜底的 text/html 过不了这关。
      const mod = await import('/src/api/tg.ts')
      const base = typeof mod.tgBase === 'function' ? mod.tgBase() : mod.TG_BASE
      let reachable = false
      let why = 'not attempted'
      try {
        const r = await fetch(`${base}/health`)
        const ct = r.headers.get('content-type') || ''
        if (!r.ok) why = `HTTP ${r.status}`
        else if (!/application\/json/i.test(ct)) why = `content-type=${ct}`
        else {
          const j = await r.json()
          if (j && j.status === 'ok') reachable = true
          else why = `body=${JSON.stringify(j)}`
        }
      } catch (e) {
        why = String((e && e.message) || e)
      }
      return { base, reachable, why }
    })
    console.log(
      `[verify:tggating] browser tgBase()=${tgProbe.base} reachable=${tgProbe.reachable}${tgProbe.reachable ? '' : ` (${tgProbe.why})`}`,
    )

    // 新口径（2026-10-13）：入口常驻 —— 两种后端状态下 nav-tg 都必须存在。
    const expectedVisible = true
    console.log(`[verify:tggating] daemon tg_enabled=${tgEnabled} browser tgBase() reachable=${tgProbe.reachable}`)
    console.log('[verify:tggating] expected nav-tg visible = true（入口常驻，与就绪态无关）')
    console.log('')
    console.log('--- assertions ---')

    // 侧栏是异步渲染的，有界轮询而不是采样一次。
    await waitForNavTg(page, expectedVisible)

    const nav = await page.evaluate(() => ({
      present: Boolean(document.querySelector('[data-testid="nav-tg"]')),
      navIds: Array.from(document.querySelectorAll('[data-testid^="nav-"]'))
        .map(e => e.getAttribute('data-testid'))
        .filter(Boolean),
    }))
    console.log(`[verify:tggating] nav testids = ${JSON.stringify(nav.navIds)}`)

    check(
      '入口常驻：无论 TG 是否就绪，侧栏都必须有 nav-tg（BUG-094 新口径）',
      () => nav.present === expectedVisible,
      `nav-tg present=${nav.present} expected=${expectedVisible}`,
    )

    // ---- 2b. 点进 TG 面板必须落到一个可读状态（M0-T05）----
    await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())
    await page
      .waitForFunction(
        () =>
          [
            'tg-onboard-disabled',
            'tg-onboard-starting',
            'tg-onboard-daemon-down',
            'tg-onboard-plugin-down',
            'tg-unbound-guide',
            'tg-panel-broken',
            'tg-monitor-list',
          ].some(id => Boolean(document.querySelector(`[data-testid="${id}"]`))),
        { timeout: 10000, intervalMs: 200 },
      )
      .catch(() => {})
    const tgState = await page.evaluate(() =>
      [
        'tg-onboard-disabled',
        'tg-onboard-starting',
        'tg-onboard-daemon-down',
        'tg-onboard-plugin-down',
        'tg-unbound-guide',
        'tg-panel-broken',
        'tg-monitor-list',
      ].filter(id => Boolean(document.querySelector(`[data-testid="${id}"]`))),
    )
    check(
      'TG 面板落到可读状态之一（未启用/启动中/未绑定/链路故障/正常），不是白板',
      () => tgState.length > 0,
      `hit=${JSON.stringify(tgState)}`,
    )

    // ---- 3. 设置页：开关状态与失败原因必须诚实 ----
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-settings"]')
      if (!el) return false
      el.click()
      return true
    })
    check('nav-settings anchor exists and is clickable', () => clicked)
    // 等左锚点渲染出来即可（默认区块已是 general，不再依赖任何区块标题文案 ——
    // 旧判据等「下载设置」字样，而 M0-T07 后默认区块是通用，那个字符串不会出现）。
    await page.waitForFunction(
      id => Boolean(document.querySelector(`[data-testid="${id}"]`)),
      { timeout: 15000, intervalMs: 200, args: [TG_SECTION_TESTID] },
    )
    await page.evaluate(testid => {
      const el = document.querySelector(`[data-testid="${testid}"]`)
      if (el) el.click()
    }, TG_SECTION_TESTID)

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
