/**
 * BUG-316 分段定位探针（CDP / Edge）。
 *
 * 量切到各页面时的请求数 + 按 URL 归组计数 + longtask，区分两类根因：
 *  - StrictMode 双挂载：同一 mount effect 在 dev 下跑两次 ⇒ 单 URL 出现偶数次（典型 =2×effect 数）。
 *  - 多组件各拉：不同组件各自 fetch 同一 URL ⇒ 同一 URL 跨不同 initiator 出现。
 *
 * 用法：node tauri-shell/verify/bug316_locate_lag.cjs [baseURL=http://127.0.0.1:5180]
 * 前置：dev 栈（:5180 vite + :19786 daemon + :19787 orig-tg）在跑；本机有 Microsoft Edge。
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

// Edge 路径从环境变量推导，不写死盘符（污染门禁 §7：脚本禁含机器绝对路径）；
// 可用 EDGE_PATH 覆盖。参照同目录 diag_loopback.cjs 的既有做法。
function edgePath() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH
  const cands = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ]
    .filter(Boolean)
    .map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  return cands.find((p) => fs.existsSync(p))
}

const BASE = process.argv[2] || 'http://127.0.0.1:5180'
const NAVS = ['nav-download', 'nav-tg', 'nav-settings', 'nav-files']

;(async () => {
  const browser = await chromium.launch({ executablePath: edgePath(), args: ['--lang=zh-CN'] })
  const page = await browser.newPage()
  const reqLog = []
  page.on('request', (r) => reqLog.push({ url: r.url() }))
  await page.addInitScript(() => {
    window.__longtasks = []
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__longtasks.push({ d: Math.round(e.duration), s: Math.round(e.startTime) })
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {}
  })

  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1500)

  const verdict = []
  const CONFIG_THRESHOLD = 2 // 允许 StrictMode 双挂导致的 2×；修复目标：从 8× 降到 ≤2×（理想 0-1×）。

  for (const nav of NAVS) {
    reqLog.length = 0
    const btn = await page.$(`[data-testid="${nav}"]`)
    if (!btn) {
      console.log(`\n=== ${nav} === MISSING NAV`)
      continue
    }
    await btn.click()
    await page.waitForTimeout(2000)
    const lt = await page.evaluate(() => (window.__longtasks || []).slice())
    const counts = {}
    for (const r of reqLog) {
      const u = r.url.replace(/\?.*$/, '')
      counts[u] = (counts[u] || 0) + 1
    }
    const cfg = counts['http://127.0.0.1:19786/api/config'] || counts['/api/config'] || 0
    const tgCfg =
      counts['http://127.0.0.1:19787/api/tg/config'] || counts['/api/tg/config'] || 0
    console.log(`\n=== ${nav} ===`)
    console.log(`total requests: ${reqLog.length}`)
    console.log(`/api/config: ${cfg}x   /api/tg/config: ${tgCfg}x`)
    console.log('api by url (count > 1 即重复):')
    for (const [u, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      if ((u.includes('/api') || u.endsWith('/health')) && c > 1) {
        console.log(`  ${c}x  ${u}`)
      }
    }
    console.log(`longtasks(${lt.length}): ` + lt.slice(0, 8).map((l) => `${l.d}ms`).join(' '))
    verdict.push({ nav, cfg, tgCfg })
  }

  // BUG-316 验收门禁：每个页面 /api/config 与 /api/tg/config 重复计数必须 ≤ 阈值。
  console.log('\n=== BUG-316 验收门禁 ===')
  let allPass = true
  for (const v of verdict) {
    const ok = v.cfg <= CONFIG_THRESHOLD && v.tgCfg <= CONFIG_THRESHOLD
    if (!ok) allPass = false
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${v.nav}  /api/config=${v.cfg}  /api/tg/config=${v.tgCfg}  (阈值 ≤${CONFIG_THRESHOLD})`,
    )
  }
  console.log(allPass ? 'RESULT: PASS' : 'RESULT: FAIL')
  await browser.close()
  process.exit(allPass ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
