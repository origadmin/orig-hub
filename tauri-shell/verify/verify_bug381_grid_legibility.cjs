#!/usr/bin/env node
/**
 * BUG-381 验收探针：媒体库方格图偏小 + 无浏览入口。
 *
 * 用户 2026-10-22 原话：「方格图有点小了，而且没有浏览功能无法看清。」
 *
 * 修法（两件一起）：
 *   ① 剧集墙 / 条目墙网格 minmax(200px,1fr) → minmax(240px,1fr)；
 *   ② MediaCard 悬浮层加「点击查看」文字（浏览入口可见化）。
 *
 * 判据：
 *   G1 剧集墙卡片宽 ≥ 240（旧实现 1440 宽下 ≈228，必败于本判据）。
 *   G2 条目墙（media-grid）卡片宽 ≥ 240。
 *   G3 悬浮入口：真实鼠标悬停（CDP Input.dispatchMouseEvent，非 DOM 合成）
 *      后悬浮层 opacity=1 且出现「点击查看 / Click to view」文字。
 *
 * 截图与读数落 `evidence/BUG-381/`。
 * 只读：悬停与导航不写库、不发缓存任务。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-381')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 收集某容器直接子卡片的宽度（viewport 几何，px）。 */
function measureChildrenWidths(sel) {
  const el = document.querySelector(sel)
  if (!el) return null
  return Array.from(el.children).map((c) => Math.round(c.getBoundingClientRect().width))
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
  await sleep(3000)

  // 进文件管理 → 剧集墙
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-files"]')
    if (el) el.click()
  })
  await sleep(2500)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (el) el.click()
  })
  await sleep(2500)

  // G1：剧集墙卡片宽（找网格容器：类名含 minmax(240px 的 grid div）
  const seriesW = await page.evaluate(() => {
    const grid = Array.from(document.querySelectorAll('div')).find(
      (d) => typeof d.className === 'string' && d.className.includes('auto-fill') && d.className.includes('minmax'),
    )
    if (!grid) return null
    return Array.from(grid.children).map((c) => Math.round(c.getBoundingClientRect().width))
  })
  check(
    'G1 剧集墙卡片宽 ≥ 240（旧 200px 网格 1440 下 ≈228 必败）',
    Array.isArray(seriesW) && seriesW.length > 0 && seriesW.every((w) => w >= 240),
    seriesW ? `n=${seriesW.length} min=${Math.min(...seriesW)}` : 'series grid not found',
  )
  await page.screenshot(path.join(OUT, '01-series-wall.png'))

  // G2：条目墙（视频类目 → media-grid）
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-cat-video"]')
    if (el) el.click()
  })
  await sleep(3000)
  const itemW = await page.evaluate(measureChildrenWidths, '[data-testid="media-grid"]')
  check(
    'G2 条目墙卡片宽 ≥ 240',
    Array.isArray(itemW) && itemW.length > 0 && itemW.every((w) => w >= 240),
    itemW ? `n=${itemW.length} min=${Math.min(...itemW)}` : 'media-grid not found',
  )

  // G3：真实悬停 → 悬浮层可见 + 「点击查看」文字
  const hoverTarget = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="media-grid"]')
    if (!grid || !grid.children.length) return null
    const card = grid.children[0]
    const r = card.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  if (!hoverTarget) {
    check('G3 悬浮入口（无条目样本，如实记录）', true, 'no item cards')
  } else {
    await page.conn.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: hoverTarget.x, y: hoverTarget.y, button: 'none' },
      { sessionId: page.sessionId },
    )
    await sleep(600)
    const hover = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="media-grid"]').children[0]
      const overlay = card.querySelector('.group-hover\\:opacity-100')
      if (!overlay) return { found: false }
      const op = getComputedStyle(overlay).opacity
      const hint = Array.from(overlay.querySelectorAll('span')).find((s) =>
        /点击查看|Click to view/.test(s.textContent || ''),
      )
      return {
        found: true,
        opacity: op,
        hintVisible: !!hint && parseFloat(op) > 0.9,
        hintText: hint ? hint.textContent : null,
      }
    })
    check(
      'G3 悬浮入口：悬停后 opacity=1 且「点击查看」可见',
      hover && hover.found && hover.hintVisible,
      hover ? `opacity=${hover.opacity} hint=${hover.hintText}` : 'overlay not found',
    )
    await page.screenshot(path.join(OUT, '02-video-grid-hover.png'))
  }

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  )
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(`[bug381] fatal: ${e && e.message}`)
  process.exit(2)
})
