'use strict'
/**
 * 验收脚本：BUG-451 文件域上下文栏「搜索框 × 库级动作组」重叠修复。
 *
 * 判据（用户诉求：不重叠）：在多个视口宽度下进入 files 视图（cat-all，挂搜索框），
 * 量搜索框右边界 vs 右槽首个按钮左边界：
 *   - overlap = search.right - firstButton.left 必须 ≤ 0（不相交）；
 *   - spillRight = lastButton.right - bar.right 必须 ≤ 0（按钮不被挤出栏外）。
 * 任一宽度不达标 ⇒ 退出码 1（反向证伪靠「修前 vs 修后」同一脚本对比）。
 *
 * 运行：dev 栈（5180）在线时 `node verify_bug451_ctxbar_no_overlap.cjs`。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const WIDTHS = [1440, 1366, 1300, 1200, 1100, 1000, 900]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MEASURE = () => {
  const bar = document.querySelector('[data-testid="context-bar"]')
  if (!bar) return { absent: true }
  const search = document.querySelector('[data-testid="files-global-search"]')
  const first = document.querySelector('[data-testid="page-primary-action"]')
  const last = document.querySelector('[data-testid="media-tag-manage"]')
  const r = (el) => (el ? (() => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width) } })() : null)
  const barR = r(bar)
  const s = r(search)
  const f = r(first)
  const l = r(last)
  return {
    barW: barR ? barR.w : null,
    searchW: s ? s.w : null,
    overlap: s && f ? Math.round(s.right - f.x) : null,
    spillRight: l && barR ? Math.round(l.right - barR.right) : null,
  }
}

async function main() {
  const browser = await cdp.launch()
  let failures = 0
  try {
    const page = await browser.newPage()
    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 900 })
      await page.goto(APP, { waitUntil: 'domcontentloaded' })
      await sleep(1000)
      await page.evaluate(() => document.querySelector('[data-testid="nav-files"]')?.click())
      await page
        .waitForFunction(() => Boolean(document.querySelector('[data-testid="files-global-search"]')), {
          timeout: 20000,
          intervalMs: 200,
        })
        .catch(() => {})
      await sleep(500)
      const m = await page.evaluate(MEASURE)
      if (m.absent) {
        console.log(`W${width}: SKIP (context-bar absent)`)
        continue
      }
      const okOverlap = m.overlap !== null && m.overlap <= 0
      const okSpill = m.spillRight !== null && m.spillRight <= 0
      const ok = okOverlap && okSpill
      if (!ok) failures++
      console.log(
        `${ok ? 'PASS' : 'FAIL'} W${String(width).padEnd(4)} ` +
          `overlap=${String(m.overlap).padStart(5)}px (≤0)  ` +
          `spillRight=${String(m.spillRight).padStart(5)}px (≤0)  ` +
          `searchW=${m.searchW} barW=${m.barW}`,
      )
    }
  } finally {
    await browser.close().catch(() => {})
  }
  if (failures > 0) {
    console.log(`\nverify_bug451: FAIL - ${failures} 宽度不达标 (退出码 1)`)
    process.exit(1)
  }
  console.log('\nverify_bug451: OK - 全宽度无重叠、无右溢出 (退出码 0)')
}

main().catch((e) => {
  console.error('VERIFY CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
