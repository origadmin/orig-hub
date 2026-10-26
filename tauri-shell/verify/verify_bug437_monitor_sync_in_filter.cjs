/**
 * BUG-437 验收：停在**筛选规则视图**里，后台增量同步必须照跑。
 *
 * 判据（可跨机器核验、无需真实 TG 新消息）：面板-mounted 期间向
 * `/api/tg/monitor/sync` 发出的请求数。
 *   - 修复前：只有进入 TG 页时那一次 `syncTgMonitor()`（另一处调用点 TgPanel:1726）；
 *     守卫把规则视图排除在外 ⇒ **节拍不发** ⇒ 75s 窗口内实测恒为 1；
 *   - 修复后：进入规则视图立即跑一轮 + 每 60s 一轮 ⇒ 同一窗口实测 3。
 *
 * 阈值取 `>= 2`（不是 `>= 1`）——唯一的基线调用会让「有没有修」都绿灯，
 * 只有 60s 节拍真的在跑才 discriminates（反向变异实测：旧实现 1 ⇒ FAIL）。
 *
 * 为什么用 `performance.getEntriesByType('resource')` 而不是 Network 域：
 * 零依赖 MITM 的 CDP 封装没有事件订阅面；资源计时是浏览器自带的事实，
 * 且 `clearResourceTimings()` 可以精确标出「进入规则视图」这一刻。
 *
 * 用法： node tauri-shell/verify/verify_bug437_live.cjs
 */
const cdp = require('./lib/cdp.cjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE = process.env.ORIG_HUB_WEB || 'http://127.0.0.1:5180'
const SYNC_PATH = '/api/tg/monitor/sync'
/** 覆盖「进入后立刻一轮 + 60s 节拍再来一轮」 */
const OBSERVE_MS = Number(process.env.BUG437_WAIT_MS || 75_000)

const results = []
const note = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`)
}

async function main() {
  const browser = await cdp.launch({ headless: true })
  const page = await browser.newPage()
  const nav = (url) => page.goto(url, { waitUntil: 'load', timeoutMs: 60_000 })

  await nav(BASE)
  await sleep(3000)

  // 壳首屏不一定落在 TG 页面 ⇒ 走顶部导航进 TG（`data-testid` 是验收的唯一锚）。
  const naved = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (!el) return 'no-nav'
    el.click()
    return 'clicked'
  })
  await sleep(3000)
  const rowCount = await page.evaluate(
    () => document.querySelectorAll('[data-testid="tg-filter-row"]').length,
  )
  note('tg page reachable', rowCount > 0, `nav=${naved}, tg-filter-row count=${rowCount}`)
  if (rowCount === 0) {
    await finish(browser)
    return
  }

  // 标零点：此之前的资源计时全清 ⇒ 之后的 sync 请求就是「停在规则视图期间」发出的。
  await page.evaluate(() => performance.clearResourceTimings())
  const opened = await page.evaluate(() => {
    // 规则行内的第一个按钮 = 点开这条规则（`enterTransient('filter:<id>')`）。
    const btn = document.querySelector('[data-testid="tg-filter-row"] button')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!opened) {
    note('enter filter view', false, 'no button inside tg-filter-row')
    await finish(browser)
    return
  }
  await sleep(1500)
  const inPanel = await page.evaluate(() => Boolean(document.querySelector('[data-testid="tg-filter-panel"]')))
  note('enter filter view', inPanel, inPanel ? 'tg-filter-panel mounted' : 'panel not mounted')

  console.log(`  observing ${OBSERVE_MS / 1000}s in filter view...`)
  await sleep(OBSERVE_MS)

  const syncCount = await page.evaluate(
    (p) => performance.getEntriesByType('resource').filter((e) => e.name.includes(p)).length,
    SYNC_PATH,
  )
  note(
    'monitor sync runs while staying in a filter rule',
    syncCount >= 2,
    `${SYNC_PATH} requests in filter view = ${syncCount} (expect >= 2; old behaviour = 1)`,
  )

  await finish(browser)
}

async function finish(browser) {
  const failed = results.filter((r) => !r.ok).length
  console.log(`\nRESULT ${failed === 0 ? 'OK' : 'FAILED'} — ${results.length} checks, ${failed} failed`)
  await browser.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(`ERROR ${e && e.message ? e.message : String(e)}`)
  process.exit(2)
})
