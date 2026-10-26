#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance: **daemon 是 TG 服务的唯一所有者**（BUG-178）。
 *
 * 回退事实（2026-09-29）：TG 进程有**两个主人** —— daemon（`tg_start/tg_stop/tg_supervise`）
 * 与桌面壳（`spawn_tg/ensure_tg/kill_port_owner`），前端还挂着一个「重试连接」按钮手动 spawn。
 * 后果是三套互相打架的「可用性」：
 *   - 设置页「Telegram 插件：运行中」（说的是**进程**）
 *   - 面板/账号页到处「Telegram 不可用」（说的是 **Telegram 链路**，而它把「没配凭证」
 *     这种**待办**也算进去）
 * 用户在同一次会话里同时看到这两句，于是判定「逻辑狗屁不通」。
 *
 * 本脚本断言的不是「能不能打开页面」，而是四条结构性事实：
 *   1. **端口单一真源**：浏览器用的 daemon / TG 端口必须等于 daemon 下发的
 *      `port` / orig-tg 端口（BUG-358 起在 `plugins[]` id="tg".port，旧键
 *      `tg_port` 兜底；前端不再各自硬编码 9876 / 9877）；
 *   2. **门控只问服务层**：`nav-tg` 存在 ⇔ daemon 说的 `tg_enabled && tg_running`；
 *   3. **链路层不冒充故障**：未配置凭证时账号页横幅必须是「待办」文案，
 *      页面任何位置都不得出现「Telegram 不可用」；
 *   4. **没有手动运维入口**：不得出现「重试连接」这类让用户替系统重启服务的按钮。
 *
 * 真值全部来自服务端（daemon `/api/config` + orig-tg `/api/tg/session`），
 * 端口由 daemon 下发，脚本不猜。
 *
 * Usage:
 *   node verify/verify_tg_ownership.cjs
 *   APP_URL=http://127.0.0.1:5180/ DAEMON_PORT=19786 node verify/verify_tg_ownership.cjs
 *
 * Exit: 0 = all passed, 1 = assertion failed, 2 = environment problem.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-tgownership')
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

/** M0-T07 起 TG 开关与账号区同驻「Telegram 插件」区块（原 general + accounts 两个页签） */
const TG_SECTION = 'settings-tab-telegram'
/** BUG-178 前「待办被说成故障」的那句原话 —— 现在任何页面都不许再出现 */
const FORBIDDEN_PHRASE = 'Telegram 不可用'
/** 手动运维入口的文案 —— 重启/kill 归 daemon，不该留给用户点 */
const FORBIDDEN_ACTION = '重试连接'

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

async function daemonConfig() {
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/config`)
  if (!res.ok) throw new Error(`GET /api/config -> ${res.status}`)
  return res.json()
}

async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ---- 1. 真源：daemon 自报的端口与服务层状态 ----
  let cfg
  try {
    cfg = await daemonConfig()
  } catch (err) {
    console.error(`[verify:tgowner] daemon unreachable on ${DAEMON_PORT}: ${err.message}`)
    console.error('[verify:tgowner] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  const daemonPort = cfg.port
  // BUG-423：BUG-358 起契约是 plugins[]（id 取插件）；旧键兜底兼容
  const tgPlug = Array.isArray(cfg.plugins) ? cfg.plugins.find((x) => x && x.id === 'tg') : null
  const tgPort = tgPlug && Number(tgPlug.port) > 0 ? Number(tgPlug.port) : Number(cfg.tg_port) > 0 ? Number(cfg.tg_port) : null
  const tgEnabled = tgPlug ? tgPlug.enabled === true : cfg.tg_enabled === true
  const tgRunning = tgPlug ? tgPlug.running === true : cfg.tg_running === true
  console.log(
    `[verify:tgowner] daemon: port=${daemonPort} tg_enabled=${tgEnabled} tg_running=${tgRunning} tg_port=${tgPort}`,
  )
  if (!daemonPort || !tgPort) {
    console.error('[verify:tgowner] daemon 未下发 port / orig-tg 端口（plugins[] id=tg 与旧键 tg_port 均无）—— 真源缺失（exit 2）')
    return 2
  }

  // ---- 2. 链路层真源：orig-tg 自己的 /api/tg/session（端口由 daemon 给）----
  let session = null
  try {
    const r = await fetch(`http://127.0.0.1:${tgPort}/api/tg/session`)
    session = await r.json()
  } catch (_e) {
    session = null
  }
  const apiConfigured = session?.api_configured === true
  const linkAvailable = session?.available === true
  console.log(
    `[verify:tgowner] orig-tg session: available=${linkAvailable} api_configured=${apiConfigured} phase=${session?.phase}`,
  )

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, {
      waitUntil: 'load',
      timeout: NAV_TIMEOUT_MS,
      settleMs: 2500,
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

    console.log('')
    console.log('--- assertions ---')

    // ---- A. 端口单一真源：浏览器用的端口必须来自 daemon ----
    const bases = await page.evaluate(async () => {
      const d = await import('/src/api/daemon.ts')
      const t = await import('/src/api/tg.ts')
      return { daemon: d.daemonBase(), tg: t.tgBase() }
    })
    console.log(`[verify:tgowner] browser bases: daemon=${bases.daemon} tg=${bases.tg}`)
    check(
      '浏览器 daemon 基址端口 == daemon 下发的 port（前端不再硬编码 9876）',
      () => bases.daemon === `http://127.0.0.1:${daemonPort}`,
      `browser=${bases.daemon} daemon=${daemonPort}`,
    )
    check(
      '浏览器 TG 基址端口 == daemon 下发的 orig-tg 端口（plugins[] id=tg.port，BUG-358 新契约；前端不再硬编码 9877）',
      () => bases.tg === `http://127.0.0.1:${tgPort}`,
      `browser=${bases.tg} daemon_tg_port=${tgPort}`,
    )

    // ---- B. 门控只问服务层 ----
    await page
      .waitForFunction(
        want => Boolean(document.querySelector('[data-testid="nav-tg"]')) === want,
        { timeout: 20000, intervalMs: 250, args: [tgEnabled && tgRunning] },
      )
      .catch(() => {})
    const nav = await page.evaluate(() => ({
      present: Boolean(document.querySelector('[data-testid="nav-tg"]')),
      ids: Array.from(document.querySelectorAll('[data-testid^="nav-"]'))
        .map(e => e.getAttribute('data-testid'))
        .filter(Boolean),
    }))
    console.log(`[verify:tgowner] nav testids = ${JSON.stringify(nav.ids)}`)
    check(
      tgEnabled && tgRunning
        ? '服务层在跑 → 侧栏必须有 nav-tg（未登录也照常显示）'
        : '服务层不在 → 侧栏不得有 nav-tg（核心设计）',
      () => nav.present === (tgEnabled && tgRunning),
      `present=${nav.present} expected=${tgEnabled && tgRunning}`,
    )

    // ---- 打开设置页 ----
    const opened = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-settings"]')
      if (!el) return false
      el.click()
      return true
    })
    check('nav-settings 可点开', () => opened)
    await page.waitForFunction(id => Boolean(document.querySelector(`[data-testid="${id}"]`)), {
      timeout: 15000,
      intervalMs: 200,
      args: [TG_SECTION],
    })

    // Telegram 插件区块：TG 开关状态
    await page.evaluate(id => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (el) el.click()
    }, TG_SECTION)
    const wantStatus = tgEnabled ? (tgRunning ? '运行中' : '启动失败') : '已停止'
    await page
      .waitForFunction(
        want =>
          (document.querySelector('[data-testid="tg-toggle-status"]')?.textContent || '').trim() ===
          want,
        { timeout: 10000, intervalMs: 150, args: [wantStatus] },
      )
      .catch(() => {})
    const status = await page.evaluate(() =>
      (document.querySelector('[data-testid="tg-toggle-status"]')?.textContent || '').trim(),
    )
    console.log(`[verify:tgowner] 设置页 TG 状态 = ${JSON.stringify(status)}`)
    check(
      `设置页 TG 状态 = daemon 服务层原值（期望「${wantStatus}」）`,
      () => status === wantStatus,
      `ui=${JSON.stringify(status)} want=${JSON.stringify(wantStatus)}`,
    )

    // 同一区块下滚即可看到账号区（M0-T07：账号区已并入 Telegram 插件区块）
    await page.evaluate(id => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (el) el.click()
    }, TG_SECTION)
    await page
      .waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="tg-accounts-banner"]')) ||
          document.body.innerText.includes('连接诊断'),
        { timeout: 15000, intervalMs: 200 },
      )
      .catch(() => {})
    const acct = await page.evaluate(() => ({
      title: (
        document.querySelector('[data-testid="tg-accounts-banner-title"]')?.textContent || ''
      ).trim(),
      hasBanner: Boolean(document.querySelector('[data-testid="tg-accounts-banner"]')),
      bodyText: document.body.innerText,
    }))
    console.log(`[verify:tgowner] 账号页横幅 = ${JSON.stringify(acct.title)}`)

    if (tgEnabled && tgRunning && !apiConfigured) {
      check(
        '未配置凭证 = 待办，横幅必须引导去配置（不是喊「Telegram 不可用」）',
        () => acct.hasBanner && acct.title === '尚未配置 Telegram API 凭证',
        `title=${JSON.stringify(acct.title)}`,
      )
    }

    check(
      `页面任何位置都不得再出现「${FORBIDDEN_PHRASE}」（待办不许说成故障）`,
      () => acct.bodyText.includes(FORBIDDEN_PHRASE) === false,
      `页面上仍出现「${FORBIDDEN_PHRASE}」`,
    )
    check(
      `不得保留「${FORBIDDEN_ACTION}」这类手动运维入口（重启/kill 归 daemon）`,
      () => acct.bodyText.includes(FORBIDDEN_ACTION) === false,
      `页面上仍有「${FORBIDDEN_ACTION}」按钮`,
    )

    const shot = path.join(OUT_DIR, `tg-ownership-${tgEnabled && tgRunning ? 'up' : 'down'}.png`)
    await page.screenshot(shot)
    console.log(`[verify:tgowner] screenshot -> ${shot}`)
  } finally {
    await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:tgowner] ${results.length - failed}/${results.length} assertions passed`)
  return failed === 0 ? 0 : 1
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:tgowner] fatal: ${err && err.stack ? err.stack : err}`)
    process.exit(2)
  })
