'use strict'

/**
 * BUG-316 段② 定位探针（CDP / Edge，零依赖）。
 *
 * 段①（请求重复·配置风暴）已修复（bug316_locate_lag.cjs，nav-settings /api/config 8×→0×）。
 * 段② = 渲染长任务：nav → 下载/文件时 longtask 271/183/159/122/113ms（2026-10-15 首跑）。
 *
 * 本探针做三件事：
 *   ① 复量四个 nav 切换的 longtask（新鲜基线，当前数据态）；
 *   ② 量各视图渲染行数（下载组行/引擎行/文件列表行/媒体卡）；
 *   ③ 用 CDP Profiler 抓 nav 点击期间的 CPU profile，按 self-time 归组热点函数，
 *      把「长任务」落到具体组件（不再只报毫秒数）。
 *
 * 用法：node tauri-shell/verify/bug316_segment2_probe.cjs
 * 前置：dev 栈（:5180 vite + :19786 daemon + :19787 orig-tg）；产物落 verify_shots/bug316-segment2/。
 */

const fs = require('node:fs')
const path = require('node:path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = process.env.ORIG_SHOT_OUT || path.join(ROOT, 'verify_shots', 'bug316-segment2')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

/* 页面侧探针：常量随注入脚本进页面（page.evaluate 序列化会丢 Node 作用域）。 */
const PAGE_JS = `
window.__b316 = {
  sel: ${JSON.stringify({
    navDownload: '[data-testid="nav-download"]',
    navFiles: '[data-testid="nav-files"]',
    navTg: '[data-testid="nav-tg"]',
    navSettings: '[data-testid="nav-settings"]',
    fileList: '[data-testid="file-list"]',
    fileRow: '[data-testid="file-list-row"]',
    mediaGrid: '[data-testid="media-grid"]',
    mediaCard: '[data-testid="media-card"]',
    ingestGroup: '[data-testid="ingest-group-row"]',
    dlItem: '[data-testid="download-item"]',
  })},
  installObserver() {
    window.__longtasks = []
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__longtasks.push({ d: Math.round(e.duration), s: Math.round(e.startTime) })
        }
      }).observe({ entryTypes: ['longtask'] })
      return true
    } catch (e) { return String(e) }
  },
  takeLongtasks() {
    const lt = (window.__longtasks || []).slice()
    window.__longtasks = []
    return lt
  },
  counts() {
    const q = (s) => document.querySelectorAll(s).length
    return {
      fileRows: q(this.sel.fileRow),
      fileLists: q(this.sel.fileList),
      mediaCards: q(this.sel.mediaCard),
      ingestGroups: q(this.sel.ingestGroup),
      dlItems: q(this.sel.dlItem),
      domNodes: document.querySelectorAll('*').length,
    }
  },
  click(sel) {
    const el = document.querySelector(sel)
    if (!el) return 'MISSING ' + sel
    el.click()
    return 'ok'
  },
  visibleText() {
    const root = document.querySelector('#root') || document.body
    return (root.innerText || '').slice(0, 120)
  },
}
`

/** CDP Profiler：抓一段区间的 CPU profile，返回按 self-time 聚合的热点函数。 */
async function profileRange(page, label, action) {
  await page.conn.send('Profiler.enable', {}, { sessionId: page.sessionId })
  await page.conn.send('Profiler.setSamplingInterval', { interval: 100 }, { sessionId: page.sessionId })
  await page.conn.send('Profiler.start', {}, { sessionId: page.sessionId })
  const t0 = Date.now()
  await action()
  await sleep(1500)
  const { profile } = await page.conn.send('Profiler.stop', {}, { sessionId: page.sessionId })
  await page.conn.send('Profiler.disable', {}, { sessionId: page.sessionId })
  const wall = Date.now() - t0

  // self-time 聚合：按 functionName 累加 hitCount（采样 profile 的 hitCount 即自时间片数）
  const byFn = new Map()
  let totalHits = 0
  for (const node of profile.nodes || []) {
    const f = node.callFrame || {}
    const name = f.functionName || '(anonymous)'
    const url = String(f.url || '').replace(/^https?:\/\/[^/]+/, '')
    const key = name === '(anonymous)' || name === '(program)'
      ? `${name} @${url}:${f.lineNumber + 1}`
      : name
    const hits = node.hitCount || 0
    totalHits += hits
    byFn.set(key, (byFn.get(key) || 0) + hits)
  }
  const top = [...byFn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, hits]) => ({ name, hits, pct: totalHits ? +((hits / totalHits) * 100).toFixed(1) : 0 }))
  console.log(`\n=== CPU profile [${label}] wall=${wall}ms samples=${totalHits} ===`)
  for (const t of top) console.log(`  ${t.pct}%  ${t.hits}  ${t.name}`)
  return { label, wall, totalHits, top }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await sleep(2000)

    // 应用真实渲染自证（白屏是最核失败：curl 200 不证明，须看载荷）
    await page.evaluate(PAGE_JS)
    const installed = await page.evaluate('window.__b316.installObserver()')
    const text = await page.evaluate('window.__b316.visibleText()')
    console.log('observer:', installed)
    console.log('root text head:', JSON.stringify(text))
    if (!text || text.length < 10) throw new Error('WHITE SCREEN: root has no visible text')

    const results = { longtasks: {}, counts: {}, profiles: [] }

    for (const nav of ['nav-download', 'nav-files', 'nav-tg', 'nav-settings']) {
      const ltBefore = await page.evaluate('window.__b316.takeLongtasks()')
      const t0 = Date.now()
      const clickRes = await page.evaluate(`window.__b316.click(window.__b316.sel.${nav === 'nav-download' ? 'navDownload' : nav === 'nav-files' ? 'navFiles' : nav === 'nav-tg' ? 'navTg' : 'navSettings'})`)
      await sleep(2500)
      const lt = await page.evaluate('window.__b316.takeLongtasks()')
      const counts = await page.evaluate('window.__b316.counts()')
      const wall = Date.now() - t0
      results.longtasks[nav] = { wall, tasks: lt }
      results.counts[nav] = counts
      console.log(`\n=== ${nav} (${clickRes}) wall=${wall}ms ===`)
      console.log(`longtasks(${lt.length}): ${lt.map((l) => l.d + 'ms').join(' ') || '(none)'}`)
      console.log('counts:', JSON.stringify(counts))
    }

    // 回切下载（复量缓存态）
    await page.evaluate('window.__b316.click(window.__b316.sel.navDownload)')
    await sleep(2500)
    const ltBack = await page.evaluate('window.__b316.takeLongtasks()')
    const countsBack = await page.evaluate('window.__b316.counts()')
    results.longtasks['nav-download-back'] = { wall: -1, tasks: ltBack }
    results.counts['nav-download-back'] = countsBack
    console.log(`\n=== nav-download (回切) ===`)
    console.log(`longtasks(${ltBack.length}): ${ltBack.map((l) => l.d + 'ms').join(' ') || '(none)'}`)
    console.log('counts:', JSON.stringify(countsBack))

    // CPU profile：下载 / 文件 各一次 nav 切换
    await page.evaluate('window.__b316.click(window.__b316.sel.navFiles)')
    await sleep(1500)
    results.profiles.push(await profileRange(page, 'nav-files', async () => {
      await page.evaluate('window.__b316.click(window.__b316.sel.navDownload)')
    }))
    results.profiles.push(await profileRange(page, 'nav-download', async () => {
      await page.evaluate('window.__b316.click(window.__b316.sel.navFiles)')
    }))

    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2))
    console.log(`\nartifacts -> ${OUT}`)
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
