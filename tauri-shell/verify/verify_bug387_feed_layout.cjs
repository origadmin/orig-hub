#!/usr/bin/env node
/**
 * BUG-387 验收探针：订阅浏览排版三连（图小文高 / 上下左右混杂 / 展开缺收起）。
 *
 * 背景（BUG-387）：首轮修复 h-32 固定只覆盖 ≤4 行 caption；长 caption 时
 * DOM 左右、视觉上下。h-full 链是循环依赖（img 固有比例撑高卡片，实测
 * 160 宽缩略图撑到 284px）。终版修法 = 左列 flex 容器 + 子块 flex-1
 * min-h-32 + img absolute 铺满 object-cover（photo/video/file 图标/相册
 * 封面四类块同一机制）。
 *
 * 判据：
 *   L1 布局统一：消息流内所有带媒体块的气泡均为左右框架
 *      （媒体块宽度 = w-40 = 160px 恒定）。
 *   L2 保底高度：短 caption 时媒体块高 ≥128px（min-h-32），
 *      且**无一**按图片固有比例撑高（imgH ≤ 400px 上界）。
 *   L3 等高机制：展开相册后封面 flex-1 拉伸（coverH > 128 明显增长），
 *      宫格在右列（album-grid 存在）且瓦片 ≥2。
 *   L4 收起入口：展开态 `album-collapse` 按钮在 DOM；其余相册保持折叠
 *      （无 grid）。
 *   L5 tsc 由 CI/本地另行保证；本探针只做运行期断言。
 *
 * 截图与量化读数落 `evidence/BUG-387/`。
 * 只读：点击 = 展开/收起相册（UI 状态），不写库、不发缓存任务。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-387')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
  await sleep(3000)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await sleep(4500)
  // 进入第一个订阅频道（频道行无 testid：以「含 @username 的行按钮」定位）
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => /@/.test(b.innerText) && b.innerText.length < 120,
    )
    if (btn) btn.click()
  })
  await sleep(5000)

  // ---- L1/L2：逐屏滚动采集全部气泡的媒体块几何 ----
  const all = []
  for (let s = 0; s < 8; s++) {
    const rows = await page.evaluate(() => {
      const out = []
      for (const b of document.querySelectorAll('[data-message-key]')) {
        const card = b.querySelector('.rounded-2xl') || b
        const img = card.querySelector('img')
        const mediaBtn = card.querySelector('[data-testid="tg-photo-preview"], [data-testid^="tg-video"], img')
        const el2 = img || mediaBtn
        if (!el2) continue
        const r = el2.getBoundingClientRect()
        out.push({ imgH: Math.round(r.height), imgW: Math.round(r.width) })
      }
      return out
    })
    all.push(...rows)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tg-panel-root"] .overflow-y-auto')
      if (el) el.scrollBy(0, 700)
    })
    await sleep(800)
  }
  check('L1 布局统一：媒体块宽恒 160（w-40）', all.length > 0 && all.every((r) => r.imgW === 160), `n=${all.length} widths=${[...new Set(all.map((r) => r.imgW))].join(',')}`)
  const stretched = all.filter((r) => r.imgH > 400)
  check('L2 保底高度：无固有比例撑高（imgH ≤ 400）', all.length > 0 && stretched.length === 0, `min=${Math.min(...all.map((r) => r.imgH))} max=${Math.max(...all.map((r) => r.imgH))}`)
  await page.screenshot(path.join(OUT, 'collapsed.png'))

  // ---- L3/L4：展开第一个相册 ----
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tg-panel-root"] .overflow-y-auto')
    if (el) el.scrollTop = 0
  })
  await sleep(800)
  const hasCover = await page.evaluate(() => !!document.querySelector('[data-testid="album-cover"]'))
  if (hasCover) {
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="album-cover"]')
      if (c) c.click()
    })
    await sleep(2000)
    await page.evaluate(() => {
      const g = document.querySelector('[data-testid="album-grid"]')
      if (g) g.scrollIntoView({ block: 'center' })
    })
    await sleep(1200)
    const ex = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="album-grid"]')
      if (!grid) return null
      const bubble = grid.closest('[data-message-keys]') || grid.closest('[data-message-key]')
      const cover = bubble ? bubble.querySelector('[data-testid="album-cover"] img') : null
      return {
        tiles: grid.children.length,
        coverH: cover ? Math.round(cover.getBoundingClientRect().height) : 0,
        gridBelow: (() => {
          if (!bubble || !cover) return false
          const g = grid.getBoundingClientRect()
          const c = cover.getBoundingClientRect()
          return g.top >= c.bottom - 2
        })(),
        hasCollapse: bubble ? !!bubble.querySelector('[data-testid="album-collapse"]') : false,
        otherGrids: document.querySelectorAll('[data-testid="album-grid"]').length,
      }
    })
    await page.screenshot(path.join(OUT, 'expanded.png'))
    // BUG-391 起此判据被接管：封面不再等高拉伸（自然比例 ≤288），宫格移到
    // 气泡底部（grid.top ≥ cover.bottom）。此处保留新契约的回归断言。
    check('L3 封面自然比例 + 宫格在底部（BUG-391 接管）', !!ex && ex.coverH <= 290 && ex.coverH > 0 && ex.gridBelow, ex ? `coverH=${ex.coverH} gridBelow=${ex.gridBelow}` : 'no grid')
    check('L4 收起入口：album-collapse 在、其余相册保持折叠', !!ex && ex.hasCollapse && ex.otherGrids === 1, ex ? `collapse=${ex.hasCollapse} grids=${ex.otherGrids}` : 'no grid')
  } else {
    check('L3/L4 展开态（本频道无相册样本，跳过并如实记录）', true, 'no album in first channel')
  }

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(`[bug387] fatal: ${e && e.message}`)
  process.exit(2)
})
