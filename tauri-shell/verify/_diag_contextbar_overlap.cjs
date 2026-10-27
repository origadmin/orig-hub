'use strict'
/**
 * 诊断：文件域上下文栏「搜索框 × 库级动作组」是否重叠（用户 2026-10-27 20:00 截图）。
 *
 * 只读几何测量，不改任何东西：
 *   1) 在多个视口宽度下进入 files 视图（cat-all，挂搜索框的那个视图）；
 *   2) 量搜索框 (files-global-search) 与右槽四个按钮各自的 rect；
 *   3) 判重叠：搜索框右边界 > 第一个按钮左边界 ⇒ 相交；
 *   4) 同时量 grid 轨道实际宽度，看是谁把谁挤掉的。
 *
 * 输出 JSON，便于直接对比「修前/修后」。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const WIDTHS = [1440, 1200, 1100, 1000, 900]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MEASURE = () => {
  const bar = document.querySelector('[data-testid="context-bar"]')
  if (!bar) return { error: 'no context-bar' }
  const search = document.querySelector('[data-testid="files-global-search"]')
  const rightSlot = document.querySelector('[data-testid="page-primary-action"]')
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }
  }
  // 右槽四个按钮（primary + 3 个 secondary）
  const btns = Array.from(
    bar.querySelectorAll(
      '[data-testid="page-primary-action"], [data-testid="media-new-series"], [data-testid="media-export-preview"], [data-testid="media-tag-manage"]',
    ),
  ).map((el) => ({
    testid: el.getAttribute('data-testid'),
    txt: (el.textContent || '').replace(/\s+/g, ' ').trim(),
    ...rect(el),
  }))
  const barRect = rect(bar)
  const s = rect(search)
  const first = btns.length ? btns[0] : null
  return {
    bar: barRect,
    search: s,
    buttons: btns,
    rightSlotEdge: first ? first.x : null,
    overlapPx: s && first ? Math.max(0, s.right - first.x) : null,
    // 搜索框右边是否越过第一个按钮左边界
    overlap: s && first ? s.right > first.x : null,
  }
}

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 900 })
      await page.goto(APP, { waitUntil: 'domcontentloaded' })
      await sleep(1200)
      // 进入文件域 items 视图（cat-all）
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="nav-files"]')
        if (el) el.click()
      })
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="files-global-search"]')),
        { timeout: 20000, intervalMs: 200 },
      ).catch(() => {})
      await sleep(700)
      const m = await page.evaluate(MEASURE)
      console.log(`\n=== viewport ${width}px ===`)
      console.log(JSON.stringify(m, null, 2))
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('DIAG CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
