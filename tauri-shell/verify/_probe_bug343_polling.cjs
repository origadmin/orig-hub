'use strict'
/**
 * BUG-343 探针：`/api/activity` 轮询节奏（用户 2026-10-20 夜诉求⑥：
 * 「/api/activity 一直在请求、数据完全不更新，更不需要调用任何接口」）。
 *
 * 判据（真实运行栈 + 真实活库状态 + 页面内 fetch 包装记录真实 wire 请求）：
 *   D1（休眠）进入 TG 视图 ⇒ 首拉一次；此后 20s 内对 /api/activity 的请求数
 *      === 0。**活库此刻正躺着一条 interrupted 任务**（用户报障时的同款状态：
 *      旧实现把它当「有活」3s 死磕，20s ≈ 6 次请求、数据零变化）。
 *   D2（退避档位）模拟 orig-tg 不可用窗口（响应按 daemon 降级形状改写：
 *      cache 来源 available=false + error、cache 行不入列；前端行不清空语义
 *      照常生效）⇒ 重挂载后请求间隔必须走 3s → 15s → 30s 档（旧实现恒 3s）。
 *   D3（自动回血）不可用窗口结束后，**不靠用户动作**的下一次定时拉取即恢复
 *      成功，且恢复后再次休眠（一个请求都不发）。
 *
 * 为什么「不可用」用改写响应而非真杀 orig-tg：daemon 的自愈会 5s 内把
 * orig-tg 拉回，窗口太短，观测不到 15s/30s 档；且「绝不杀 dev 栈进程」。
 * 改写只动 `sources[cache].available/error` 与 cache 行，形状与 daemon 真实
 * 降级响应一致（activity.rs 的 merge 降级分支），前端代码路径 100% 真实。
 *
 * 用法：node tauri-shell/verify/_probe_bug343_polling.cjs
 * 前置：dev 5180 + daemon 19786（orig-tg 19787）。产物 verify_shots/bug343-polling/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug343-polling')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

/** 包装 window.fetch：记录 /api/activity 调用的时间戳，并按开关改写降级响应。 */
const INSTALL_HOOK = `(() => {
  if (window.__activityProbeInstalled) return
  window.__activityProbeInstalled = true
  const orig = window.fetch.bind(window)
  window.__activityLog = []
  window.__forceUnavailable = false
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = (init && init.method) || (input && input.method) || 'GET'
    if (url.includes('/api/activity')) {
      const forced = window.__forceUnavailable === true
      window.__activityLog.push({ t: Date.now(), forced })
      if (forced) {
        const res = await orig(input, init)
        let data = {}
        try { data = await res.clone().json() } catch (e) { /* 保持原样 */ }
        data.tasks = (data.tasks || []).filter((x) => x.kind !== 'cache')
        data.sources = (data.sources || []).map((s) =>
          s.kind === 'cache'
            ? { ...s, available: false, count: 0, error: 'probe: simulated orig-tg unavailable' }
            : s)
        return new Response(JSON.stringify(data), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
    }
    return orig(input, init)
  }
})()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickNav(page, testid) {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (el) el.click()
  }, testid)
  await sleep(400)
}

async function activityLog(page) {
  return page.evaluate(() => (window.__activityLog || []).map((e) => ({ t: e.t, forced: e.forced })))
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const results = []
  const problems = []
  const push = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) problems.push(name)
  }

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 600 })
    await page.conn.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: INSTALL_HOOK },
      { sessionId: page.sessionId },
    )
    await page.goto(APP, { timeout: 90000 })

    // ── D1：休眠（活库现有 interrupted 任务 = 用户报障同款状态）──
    await clickNav(page, 'nav-tg')
    await page.waitForFunction(
      () => (window.__activityLog || []).length >= 1,
      { timeout: 20000 },
    )
    const afterFirst = (await activityLog(page)).length
    await sleep(20000)
    const afterQuiet = (await activityLog(page)).length
    push(
      'D1 无在传任务（活库有 interrupted 躺着）⇒ 20s 内零请求（休眠）',
      afterFirst === 1 && afterQuiet === 1,
      `first=${afterFirst} after20s=${afterQuiet}`,
    )
    await page.screenshot(path.join(OUT, 'dormant.png'))

    // ── D2：不可用窗口的退避档位 3s → 15s → 30s ──
    const baseline = (await activityLog(page)).length
    await page.evaluate(() => {
      window.__forceUnavailable = true
    })
    // 切走再切回 = hook 重挂载（enabled false→true），首拉立即发生。
    await clickNav(page, 'nav-settings')
    await clickNav(page, 'nav-tg')
    await page.waitForFunction(
      (n) => (window.__activityLog || []).length > n,
      { timeout: 15000, args: [baseline] },
    )
    // 等第 4 次调用（t0..t3）落地：3s + 15s + 30s ≈ 48s。
    await page.waitForFunction(
      (n) => (window.__activityLog || []).length >= n + 4,
      { timeout: 70000, args: [baseline] },
    )
    const log = await activityLog(page)
    const ts = log.slice(baseline).map((e) => e.t)
    const g = []
    for (let i = 1; i < ts.length; i++) g.push(ts[i] - ts[i - 1])
    push(
      'D2a 退避第一档：首败后 3s 内回探',
      g[0] >= 2000 && g[0] <= 6000,
      `gap1=${g[0]}ms`,
    )
    push(
      'D2b 退避第二档：第二次失败后 15s 才再探',
      g[1] >= 12000 && g[1] <= 18000,
      `gap2=${g[1]}ms`,
    )
    push(
      'D2c 退避封顶档：之后 30s 才再探',
      g[2] >= 26000 && g[2] <= 34000,
      `gap3=${g[2]}ms`,
    )
    const allForced = log.slice(baseline).every((e) => e.forced)
    push('D2d 退避期间的每次拉取都带不可用语义（banner 数据源）', allForced, `n=${ts.length}`)

    // ── D3：自动回血（不靠用户动作的下一次定时拉取即恢复，随后再休眠）──
    const beforeRecover = (await activityLog(page)).length
    await page.evaluate(() => {
      window.__forceUnavailable = false
    })
    let recovered = false
    const recoverDeadline = Date.now() + 40000
    while (Date.now() < recoverDeadline) {
      await sleep(1000)
      const l = await activityLog(page)
      if (l.length > beforeRecover && l[l.length - 1].forced === false) {
        recovered = true
        break
      }
    }
    push('D3 恢复后不靠用户动作即回血（≤30s 的下一档定时拉取成功）', recovered)
    const afterRecover = (await activityLog(page)).length
    await sleep(12000)
    const afterRecoverQuiet = (await activityLog(page)).length
    push(
      'D3b 回血后再次休眠（12s 零请求）',
      afterRecoverQuiet === afterRecover,
      `atRecover=${afterRecover} after12s=${afterRecoverQuiet}`,
    )
    await page.screenshot(path.join(OUT, 'recovered.png'))

    fs.writeFileSync(path.join(OUT, 'result.txt'), results.join('\n') + '\n', 'utf8')
    console.log(results.join('\n'))
    if (problems.length > 0) {
      console.log(`\nFAIL: ${problems.join(', ')}`)
      process.exitCode = 1
    } else {
      console.log('\nALL PASS')
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe error:', e)
  process.exitCode = 1
})
