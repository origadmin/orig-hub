'use strict'
/**
 * 诊断：上下文栏「搜索框 × 右槽按钮组」重叠的**候选布局**对比。
 *
 * 根因已知（用户 2026-10-27 20:00 截图）：files 视图用
 * `grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]`，右槽 4 个按钮的实际宽度
 * （≈358px）超过其 `1fr` 轨道 ⇒ 溢出**向左**压住中槽的 `w-80` 搜索框。
 *
 * 本脚本不猜，直接在真实 DOM 上把候选 class 换上去量：
 *   对每个视口宽度 × 每个候选 class ⇒ 量搜索框右边界 vs 首个按钮左边界。
 *   overlap = search.right - firstButton.left（>0 即重叠）。
 *
 * 只读诊断（不改源码）：候选 class 通过 JS 临时替换 className 试验，
 * 每个候选测完立即还原。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const WIDTHS = [1440, 1200, 1100, 1000, 900]

/** 候选：名称 → grid class 串（覆盖 ContextBar 现有 gridCls 的 grid-cols-* 部分） */
const CANDIDATES = [
  { name: 'current(1fr auto 1fr)', cols: 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]' },
  { name: 'tg-narrow(auto 1fr auto)', cols: 'grid-cols-[auto_minmax(0,1fr)_auto]' },
  { name: 'shrink-mid(1fr minmax(0,auto) 1fr)', cols: 'grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)]' },
  { name: 'auto-1fr-auto-minmid', cols: 'grid-cols-[auto_minmax(0,1fr)_auto]' },
  { name: '1fr-1fr-auto', cols: 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MEASURE = (cols) => {
  const bar = document.querySelector('[data-testid="context-bar"]')
  if (!bar) return { error: 'no context-bar' }
  const orig = bar.className
  // 只替换 grid-cols-* 部分，保留 min-w-0 / flex-1 / items-center / gap-3
  const stripped = orig
    .split(/\s+/)
    .filter((c) => !c.startsWith('grid-cols-') && !c.startsWith('max-['))
    .join(' ')
  bar.className = `${stripped} ${cols}`
  // 强制重排
  void bar.offsetWidth
  const search = document.querySelector('[data-testid="files-global-search"]')
  const first = document.querySelector('[data-testid="page-primary-action"]')
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width) }
  }
  const s = rect(search)
  const f = rect(first)
  const barRect = rect(bar)
  const last = document.querySelector('[data-testid="media-tag-manage"]')
  const l = rect(last)
  const res = {
    barW: barRect ? barRect.w : null,
    search: s,
    first: f,
    last: l,
    overlap: s && f ? Math.round(s.right - f.x) : null,
    // 最后一个按钮是否被挤出栏外
    spillRight: l && barRect ? Math.round(l.right - barRect.right) : null,
    searchClipped: s && f ? s.w < 200 : null,
  }
  bar.className = orig
  return res
}

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 900 })
      await page.goto(APP, { waitUntil: 'domcontentloaded' })
      await sleep(1200)
      await page.evaluate(() => document.querySelector('[data-testid="nav-files"]')?.click())
      await page
        .waitForFunction(() => Boolean(document.querySelector('[data-testid="files-global-search"]')), {
          timeout: 20000,
          intervalMs: 200,
        })
        .catch(() => {})
      await sleep(600)
      console.log(`\n===== viewport ${width}px =====`)
      for (const c of CANDIDATES) {
        const m = await page.evaluate(MEASURE, c.cols)
        const ok = m.overlap !== null && m.overlap <= 0
        console.log(
          `${ok ? 'OK  ' : 'BAD '} ${c.name.padEnd(34)} overlap=${String(m.overlap).padStart(5)}px  ` +
            `searchW=${m.search ? m.search.w : '?'}  barW=${m.barW}  spillRight=${m.spillRight}`,
        )
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('DIAG CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
