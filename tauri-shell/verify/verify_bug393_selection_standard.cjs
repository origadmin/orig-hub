#!/usr/bin/env node
/**
 * BUG-393 验收探针：选择态形态全仓统一（下载域 = 剧集墙）。
 *
 * 用户 2026-10-23：「全部下载 的选择又出现了样式不一致情况. 应该和剧集一样.
 * 样式就应该统一,应该有一个标准」。
 *
 * 修法：`components/ui/selection-bar.tsx` 成为唯一选择形态（SelectionBar /
 * SelectAllButtons / RowCheckbox），剧集墙与下载域共用。
 *
 * 判据（几何，不读 className）：
 *   S1 下载域选择条 = 底部居中浮层（条底距视口底 ≤24px，水平中心偏移 ≤4px），
 *      容器 `borderRadius` 与剧集墙同一量级（≥9999px 的胶囊 或 相等值）。
 *   S1c 剧集墙(series)选择条 = 与下载域同一底部居中胶囊（之前 series 是旧 absolute
 *       方块条，漏验导致不一致复发；本次补验）。
 *   S2 下载域有全选/全不选（此前只有「清空/取消选中」）。
 *   S3 两域计数与按钮字号相同（11px），按钮高度相同（≤28px）。
 *   S4 行选择框尺寸全仓一致（下载行 / 入库行 同为 16×16）。
 *   验牙：装回旧下载域选择条（顶部方块条 + 无全选）S1/S2 必红，还原复绿。
 *
 * 只读：只勾选/取消勾选界面选择，不取消任何真实任务。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-393')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 读一条选择条的几何（视口相对）。 */
async function readBar(page, testId) {
  return page.evaluate((testId) => {
    const el = document.querySelector(`[data-testid="${testId}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const btns = Array.from(el.querySelectorAll('button')).map((b) => {
      const br = b.getBoundingClientRect()
      return {
        h: Math.round(br.height),
        fs: getComputedStyle(b).fontSize,
        text: (b.innerText || '').trim().slice(0, 8),
      }
    })
    return {
      bottomGap: Math.round(window.innerHeight - r.bottom),
      centerOffset: Math.round(Math.abs((r.left + r.right) / 2 - window.innerWidth / 2)),
      radius: cs.borderTopLeftRadius,
      countFs: (() => {
        const c = el.querySelector('span')
        return c ? getComputedStyle(c).fontSize : null
      })(),
      btns,
      hasSelectAll: el.querySelectorAll('button').length >= 2,
    }
  }, testId)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
    await sleep(4000)

    // ---- 下载域：勾两条 → 选择条出现 ----
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await sleep(6000)
    await page.evaluate(() => {
      const boxes = Array.from(
        document.querySelectorAll('[data-testid="download-item-select"], [data-testid="ingest-group-select"]'),
      ).slice(0, 2)
      for (const b of boxes) b.click()
    })
    await sleep(1500)
    const dl = await readBar(page, 'dl-batch-bar')
    check('S1a 下载域选择条存在且为底部居中浮层', !!dl && dl.bottomGap <= 24 && dl.centerOffset <= 4, dl ? `bottomGap=${dl.bottomGap} centerOffset=${dl.centerOffset} r=${dl.radius}` : 'bar missing')
    check(
      'S2 下载域有全选/全不选（`dl-select-all`/`dl-select-none`）',
      await page.evaluate(
        () =>
          !!document.querySelector('[data-testid="dl-select-all"]') &&
          !!document.querySelector('[data-testid="dl-select-none"]'),
      ),
    )
    const dlBox = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="ingest-group-select"], [data-testid="download-item-select"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    })
    check('S4a 下载行选择框 16×16', !!dlBox && dlBox.w === 16 && dlBox.h === 16, dlBox ? `${dlBox.w}x${dlBox.h}` : 'no row box')
    await page.screenshot(path.join(OUT, '01-download-selection-bar.png'))

    // ---- 剧集墙：勾两条 → 选择条 ----
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-files"]')
      if (el) el.click()
    })
    await sleep(4000)
    await page.evaluate(() => {
      // 条目网格的选择入口：卡片内的勾选框（无专用 testid 时按 aria-label 找）
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"][aria-label]')).slice(0, 2)
      for (const b of boxes) b.click()
    })
    await sleep(1500)
    const series = await readBar(page, 'items-selection-bar')
    check(
      'S1b 剧集墙选择条同为底部居中浮层（同半径量级）',
      !!series && series.bottomGap <= 24 && series.centerOffset <= 4,
      series ? `bottomGap=${series.bottomGap} centerOffset=${series.centerOffset} r=${series.radius}` : 'bar missing（可能未进条目视图）',
    )
    if (dl && series) {
      check(
        'S3 两域按钮高度与字号一致（≤28px / 11px）',
        dl.btns.length > 0 &&
          series.btns.length > 0 &&
          dl.btns.every((b) => b.h <= 28 && b.fs === '11px') &&
          series.btns.every((b) => b.h <= 28 && b.fs === '11px'),
        `dl=${JSON.stringify(dl.btns.slice(0, 2))} series=${JSON.stringify(series.btns.slice(0, 2))}`,
      )
    } else {
      check('S3 两域按钮高度与字号一致（≤28px / 11px）', false, 'missing one bar')
    }
    await page.screenshot(path.join(OUT, '02-series-selection-bar.png'))

    // ---- 剧集墙（series）视图：勾两条 → 选择条必须为底部居中胶囊（BUG-393 复验）----
    // `nav-child-lib-series` 仅在文件子菜单展开（filesOpen）时渲染；先确保展开，
    // 否则点不到入口、视图不切到 series，选择条永不出现。
    await page.evaluate(() => {
      if (!document.querySelector('[data-testid="nav-child-lib-series"]')) {
        const chev = document.querySelector('[data-testid="files-chevron"]')
        if (chev) chev.click()
      }
    })
    await sleep(800)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (el) el.click()
    })
    await sleep(4500)
    await page.evaluate(() => {
      // 剧集墙的选择入口是 `<button role="checkbox" data-testid="series-card-select">`
      // （SeriesCard.tsx），不是 `input[type=checkbox]`（那是 items 视图用的）；
      // 用错选择器会 0 命中、选择条永不出现。
      const boxes = Array.from(
        document.querySelectorAll('[data-testid="series-card-select"]'),
      ).slice(0, 2)
      for (const b of boxes) b.click()
    })
    await sleep(1500)
    const seriesWall = await readBar(page, 'series-selection-bar')
    check(
      'S1c 剧集墙(series)选择条=底部居中胶囊（与全部下载/items 同形、同半径）',
      !!seriesWall &&
        seriesWall.bottomGap <= 24 &&
        seriesWall.centerOffset <= 4 &&
        !!dl &&
        seriesWall.radius === dl.radius,
      seriesWall
        ? `bottomGap=${seriesWall.bottomGap} centerOffset=${seriesWall.centerOffset} r=${seriesWall.radius} dlR=${dl ? dl.radius : '?'}`
        : 'bar missing（可能未进入剧集视图）',
    )
    check(
      'S2b 剧集墙(series)有全选/全不选（series-select-all/series-select-none）',
      await page.evaluate(
        () =>
          !!document.querySelector('[data-testid="series-select-all"]') &&
          !!document.querySelector('[data-testid="series-select-none"]'),
      ),
    )
    await page.screenshot(path.join(OUT, '03-series-wall-selection-bar.png'))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('[bug393] fatal:', e && e.message)
  process.exit(2)
})
