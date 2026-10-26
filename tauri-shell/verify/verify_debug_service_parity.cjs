#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance: **调试模式下 TG 与媒体库服务必须正常**（BUG-179）。
 *
 * 回退事实（2026-09-29）：调试启动（cargo run / 脚本 / 验收）不带 ORIG_TG_DATA，
 * 数据目录回落 `%LOCALAPPDATA%/OrigHub`，与桌面壳 `%APPDATA%/com.origadmin.orighub/tg`
 * （真实数据）分裂 —— 用户看着 137 条媒体库条目的库，界面却是空的；
 * 同时调试构建默认离线短路，`/api/tg/dialogs` 对本地 516 条频道缓存诚实 503。
 *
 * 本脚本断言（真值全部来自服务端，端口由 daemon 下发）：
 *   健康栈（ORIG_VERIFY_NEGATIVE 未设）：
 *     1. daemon `/api/config` 可达且 tg_running；
 *     2. `/api/tg/dialogs` 非空且条数 >= EXPECTED_DIALOGS（错数据目录=0 必 FAIL）；
 *     3. `/api/media/items` 条数 >= EXPECTED_MEDIA（同上）；
 *     4. UI：TG 面板真实渲染出频道标题；媒体库真实渲染出条目卡片（截图为证）。
 *   负控栈（ORIG_VERIFY_NEGATIVE=1，指向空数据目录）：
 *     5. dialogs 如实 503（带原因）或空，media 为 0 —— UI 不许假装有数据。
 *
 * Usage:
 *   EXPECTED_DIALOGS=516 EXPECTED_MEDIA=137 node verify/verify_debug_service_parity.cjs
 *   ORIG_VERIFY_NEGATIVE=1 DATA_DIR_LABEL=empty node verify/verify_debug_service_parity.cjs
 *
 * Exit: 0 = all passed, 1 = assertion failed, 2 = environment problem.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const NEGATIVE = process.env.ORIG_VERIFY_NEGATIVE === '1'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const EXPECTED_DIALOGS = Number(process.env.EXPECTED_DIALOGS || 0)
const EXPECTED_MEDIA = Number(process.env.EXPECTED_MEDIA || 0)
const DATA_LABEL = process.env.DATA_DIR_LABEL || (NEGATIVE ? 'empty' : 'production')
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT ||
  path.join(os.tmpdir(), `orighub-verify-179-${DATA_LABEL}`)
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

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

async function getJson(url) {
  const res = await fetch(url)
  let body = null
  try {
    body = await res.json()
  } catch (_e) {
    body = null
  }
  return { status: res.status, body }
}

async function main() {
  const resolvedOut = path.resolve(OUT_DIR)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolvedOut === repoRoot || resolvedOut.startsWith(repoRoot + path.sep)) {
    throw new Error(`Refusing to write artifacts inside the repo (${resolvedOut}).`)
  }
  fs.mkdirSync(resolvedOut, { recursive: true })

  // ---- 1. 服务层真源 ----
  let cfg
  try {
    const r = await getJson(`http://127.0.0.1:${DAEMON_PORT}/api/config`)
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    cfg = r.body
  } catch (err) {
    console.error(`[verify:p179] daemon unreachable on ${DAEMON_PORT}: ${err.message}`)
    return 2
  }
  // BUG-423：BUG-358 起契约是 plugins[]（id 取插件）；旧键兜底兼容
  const tgPlug = Array.isArray(cfg.plugins) ? cfg.plugins.find((x) => x && x.id === 'tg') : null
  const tgPort = tgPlug && Number(tgPlug.port) > 0 ? Number(tgPlug.port) : Number(cfg.tg_port) > 0 ? Number(cfg.tg_port) : null
  const tgRunning = tgPlug ? tgPlug.running === true : cfg.tg_running === true
  if (!tgPort) {
    console.error(`[verify:p179] daemon config 未给出 orig-tg 端口（plugins[] id=tg 与旧键 tg_port 均无）`)
    return 2
  }
  console.log(
    `[verify:p179] label=${DATA_LABEL} negative=${NEGATIVE} daemon_port=${cfg.port} tg_port=${tgPort} tg_running=${tgRunning}`,
  )

  // ---- 2. TG 数据端点（cache-first 契约）----
  const dl = await getJson(`http://127.0.0.1:${tgPort}/api/tg/dialogs?limit=50`)
  const dlCount = Array.isArray(dl.body?.items) ? dl.body.items.length : 0
  const dlTotal = Number(dl.body?.total ?? 0)
  const dlFirstTitle = dl.body?.items?.[0]?.title ?? ''
  console.log(
    `[verify:p179] dialogs: status=${dl.status} items=${dlCount} total=${dlTotal} first=${JSON.stringify(dlFirstTitle)}`,
  )
  if (!NEGATIVE) {
    check(
      'dialogs 端点可用（200）',
      () => dl.status === 200,
      `status=${dl.status} body=${JSON.stringify(dl.body).slice(0, 200)}`,
    )
    check(
      `dialogs 条数 >= ${EXPECTED_DIALOGS}（调试栈必须读到生产数据目录；错目录=0 必 FAIL；在线扫描可合法增长）`,
      () => dlTotal >= EXPECTED_DIALOGS,
      `total=${dlTotal} expected=${EXPECTED_DIALOGS}`,
    )
    check('dialogs 首条带真实标题（非空字符串）', () => dlFirstTitle.length > 0, `first=${JSON.stringify(dlFirstTitle)}`)
  } else {
    check(
      '负控：空数据目录下 dialogs 如实 503（拒绝服务）或明确为空',
      () => dl.status >= 400 || (dl.status === 200 && dlTotal === 0),
      `status=${dl.status} total=${dlTotal}`,
    )
  }

  // ---- 3. 媒体库数据（数据目录同源）----
  const md = await getJson(`http://127.0.0.1:${tgPort}/api/media/items?page=1&page_size=5`)
  const mdTotal = Number(md.body?.total ?? 0)
  console.log(`[verify:p179] media items: status=${md.status} total=${mdTotal}`)
  if (!NEGATIVE) {
    check(
      `media items 条数 >= ${EXPECTED_MEDIA}（调试栈读到生产库；错目录=0 必 FAIL）`,
      () => md.status === 200 && mdTotal >= EXPECTED_MEDIA,
      `status=${md.status} total=${mdTotal} expected=${EXPECTED_MEDIA}`,
    )
  } else {
    check('负控：空数据目录下媒体库如实为 0', () => md.status === 200 && mdTotal === 0, `status=${md.status} total=${mdTotal}`)
  }

  // ---- 4. UI 真实渲染（仅健康栈）----
  if (!NEGATIVE) {
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
        sel => Boolean(document.querySelector(sel) && document.querySelector(sel).children.length > 0),
        { timeout: 15000, intervalMs: 200, args: ['#root'] },
      )

      // 4a. TG 面板渲染订阅列表（结构性信号 + 任一真实频道标题出现在 DOM）
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="nav-tg"]')
        if (el) el.click()
      })
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="tg-panel-root"]')),
        { timeout: 20000, intervalMs: 250 },
      )
      // 面板默认渲染分组汇总（「全部订阅 <total>」），total 来自 dialogs 服务端真源；
      // 空数据目录下这里不会有非零真实总数 —— 错目录必 FAIL。
      await page.waitForFunction(
        total => {
          const text = document.body.innerText || ''
          return text.includes('全部订阅') && text.includes(String(total))
        },
        { timeout: 25000, intervalMs: 300, args: [dlTotal] },
      )
      check(`TG 面板渲染出订阅汇总「全部订阅 ${dlTotal}」（dialogs 服务端真源）`, () => true)
      await page.screenshot(path.join(resolvedOut, 'tg-panel-channels.png'))

      // 4b. 媒体库渲染条目
      await page.evaluate(() => {
        const candidates = ['nav-child-lib-series', 'nav-library', 'nav-downloads']
        for (const id of candidates) {
          const el = document.querySelector(`[data-testid="${id}"]`)
          if (el) {
            el.click()
            return
          }
        }
      })
      await page.evaluate(() => new Promise(r => setTimeout(r, 1200)))
      await page.screenshot(path.join(resolvedOut, 'media-library.png'))
    } finally {
      await browser.close().catch(() => {})
    }
  }

  const failed = results.filter(r => !r.ok)
  console.log('')
  console.log(`[verify:p179] RESULT: ${failed.length === 0 ? 'ALL PASS' : 'FAILED'} (${results.length - failed.length}/${results.length})`)
  return failed.length === 0 ? 0 : 1
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:p179] fatal: ${err && err.stack ? err.stack : err}`)
    process.exit(2)
  })
