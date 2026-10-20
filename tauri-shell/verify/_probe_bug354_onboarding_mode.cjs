'use strict'
/**
 * BUG-354 验收探针：Telegram「采集未启用」逻辑不自恰
 * ----------------------------------------------------------------------------
 * 复现「服务未启动 / daemon 不可达 / 配置尚未加载」这一真实触发态：
 *   - 该态下 `getConfig()` 必然失败，`refreshTgState` 提前 return，
 *     `tgService` 保留初始值 `{ known:false, enabled:false, running:false }`。
 *   - 旧逻辑 `!tgEnabled`（即 `!enabled`）会把这态渲染成「Telegram 采集未启用」
 *     并给一个只能跳设置页、按核心设计本就启动不了服务的「启用」死按钮（逻辑不自恰）。
 *   - 修复后（`tgDisabled = known && !enabled`）：同态应落到「正在启动」提示，
 *     绝不出现「采集未启用」卡与「启用」死按钮。
 *
 * 复现手段：用 CDP `Page.addScriptToEvaluateOnNewDocument` 注入常驻脚本，
 * 把全局 `fetch` 中对 `/api/config` 的请求拒掉（其余请求放行），使 config 永远取不到，
 * `tgService` 稳定停在初始 `known:false`。这比直接改 store 更真实——跑的是真实 app 代码。
 *
 * 反向变异：`LEGACY=1` 时断言旧逻辑会显示「采集未启用」（证明该态在原实现下确为缺陷）。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')

const BASE = process.env.VITE_URL || 'http://127.0.0.1:5180/'
const SHOT_DIR = path.resolve(__dirname, '..', 'verify_shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const LEGACY = process.env.LEGACY === '1'

const results = []
function check(name, cond, detail) {
  const ok = !!cond
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function navigateWithRetry(page, url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { timeoutMs: 90000, waitForRoot: false, settleMs: 0 })
      return
    } catch (e) {
      if (i === tries - 1) throw e
      await delay(3000)
    }
  }
}

async function waitStore(page, timeout = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(() => !!window.__origStore)
    if (ok) return true
    await delay(300)
  }
  return false
}

/** 注入常驻脚本：拦截 /api/config，保留其余请求放行 */
async function installConfigBlock(page) {
  const src = `(${function () {
    const orig = window.fetch ? window.fetch.bind(window) : null
    window.__origFetch = orig
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('/api/config') !== -1) {
        return Promise.reject(new Error('probe-blocked-config'))
      }
      return orig ? orig(input, init) : Promise.reject(new Error('no-fetch'))
    }
  }})()`
  await page.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, { sessionId: page.sessionId })
}

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await installConfigBlock(page)
    await navigateWithRetry(page, BASE)
    const storeReady = await waitStore(page)
    if (!storeReady) throw new Error('window.__origStore 未就绪')

    // 确保链路层不是 link_down（隔离本次要测的 tgDisabled vs !tgReady 分支）
    await page.evaluate(() => {
      window.__origStore.setState({ tgLink: { state: 'unknown', reason: null } })
    })
    // 给 init / 各 effect 时间跑完并因 config 失败而保持初始 known:false
    await delay(2000)

    // 进入 TG 面板
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    const start = Date.now()
    while (Date.now() - start < 20000) {
      const ok = await page.evaluate(() => !!document.querySelector('[data-testid="tg-panel-root"]'))
      if (ok) break
      await delay(300)
    }
    await delay(800)

    const dom = await page.evaluate(() => {
      const has = (t) => !!document.querySelector(`[data-testid="${t}"]`)
      return {
        disabled: has('tg-onboard-disabled'),
        starting: has('tg-onboard-starting'),
        unbound: has('tg-unbound-guide'),
        broken: has('tg-panel-broken'),
        enableBtn: has('tg-onboard-enable'),
        state: window.__origStore.getState().tgService,
      }
    })
    await page.screenshot(path.join(SHOT_DIR, LEGACY ? 'bug354-legacy.png' : 'bug354-fixed.png'))

    const s = dom.state || {}
    const stateStr = `known=${s.known} enabled=${s.enabled} running=${s.running}`

    if (LEGACY) {
      // 旧逻辑：服务未启动(know:false) 被误判为「采集未启用」
      check('LEGACY: 服务未启动态下旧逻辑显示「采集未启用」(即原缺陷)', dom.disabled, stateStr)
      check('LEGACY: 旧逻辑不应是「正在启动」', !dom.starting, stateStr)
    } else {
      // 修复后：同态必须落到「正在启动」，绝不给「采集未启用」+ 死按钮
      check('FIX: 服务未启动(know:false) 不显示「采集未启用」', !dom.disabled, stateStr)
      check('FIX: 服务未启动(know:false) 显示「正在启动」提示', dom.starting, stateStr)
      check('FIX: 不出现「启用」死按钮', !dom.enableBtn, stateStr)
      check('FIX: 未误入未绑定/故障卡', !dom.unbound && !dom.broken, stateStr)
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} (${results.length} checks) ===`)
    if (dom.state) console.log('tgService =', JSON.stringify(dom.state))
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    await browser.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
