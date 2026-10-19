'use strict'

/**
 * BUG-316 段② 聚焦探针：首次 nav-download 的 242ms 长任务归因。
 * 与 segment2_probe 的区别：observer 装好后**第一个动作**就是 nav-download，
 * 且用 CDP Profiler 全程盯住这一次点击（含挂载 + 数据到达两波渲染）。
 */

const fs = require('node:fs')
const path = require('node:path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = process.env.ORIG_SHOT_OUT || path.join(ROOT, 'verify_shots', 'bug316-segment2')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

const PAGE_JS = `
window.__b316f = {
  installObserver() {
    window.__longtasks = []
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const a = e.attribution || []
          window.__longtasks.push({
            d: Math.round(e.duration),
            s: Math.round(e.startTime),
            attr: a.map((x) => x.name + ':' + (x.containerType || '') + ':' + (x.containerName || '')).join(' | '),
          })
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
  click(sel) {
    const el = document.querySelector(sel)
    if (!el) return 'MISSING ' + sel
    el.click()
    return 'ok'
  },
}
`

async function profileRange(page, label, action) {
  await page.conn.send('Profiler.enable', {}, { sessionId: page.sessionId })
  await page.conn.send('Profiler.setSamplingInterval', { interval: 100 }, { sessionId: page.sessionId })
  await page.conn.send('Profiler.start', {}, { sessionId: page.sessionId })
  const t0 = Date.now()
  await action()
  await sleep(3000)
  const { profile } = await page.conn.send('Profiler.stop', {}, { sessionId: page.sessionId })
  await page.conn.send('Profiler.disable', {}, { sessionId: page.sessionId })
  const wall = Date.now() - t0
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
    .slice(0, 15)
    .map(([name, hits]) => ({ name, hits, pct: totalHits ? +((hits / totalHits) * 100).toFixed(1) : 0 }))
  console.log(`\n=== CPU profile [${label}] wall=${wall}ms samples=${totalHits} ===`)
  for (const t of top) console.log(`  ${t.pct}%  ${t.hits}  ${t.name}`)
  return { label, wall, totalHits, top }
}

;(async () => {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await sleep(2000)
    await page.evaluate(PAGE_JS)
    await page.evaluate('window.__b316f.installObserver()')

    // 第一个动作 = nav-download，全程 profile
    const prof = await profileRange(page, 'first-nav-download', async () => {
      await page.evaluate('window.__b316f.click(\'[data-testid="nav-download"]\')')
    })
    const lt = await page.evaluate('window.__b316f.takeLongtasks()')
    console.log(`longtasks(${lt.length}): ${lt.map((l) => l.d + 'ms@' + l.s + ' attr=' + (l.attr || '')).join(' ') || '(none)'}`)

    // 再切走再切回（热路径对照）
    await page.evaluate('window.__b316f.click(\'[data-testid="nav-files"]\')')
    await sleep(2000)
    await page.evaluate('window.__b316f.takeLongtasks()')
    await page.evaluate('window.__b316f.click(\'[data-testid="nav-download"]\')')
    await sleep(2500)
    const lt2 = await page.evaluate('window.__b316f.takeLongtasks()')
    console.log(`revisit longtasks(${lt2.length}): ${lt2.map((l) => l.d + 'ms').join(' ') || '(none)'}`)

    fs.writeFileSync(path.join(OUT, 'first-nav-download.json'), JSON.stringify({ prof, lt, lt2 }, null, 2))
    console.log(`\nartifacts -> ${OUT}`)
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
