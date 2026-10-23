#!/usr/bin/env node
'use strict'
/**
 * BUG-399 验收：文件列表列头与行内容横向对齐。
 *
 * 判据（全部真实 DOM 几何，非字符串匹配）：
 *   A1. `file-list-header` 与首个 `file-list-row` 的 computed
 *       grid-template-columns **完全相等**（同一套列模板 FILE_ROW_GRID）；
 *   A2. 同序单元格 left 逐列差 ≤ 2px（BUG-321 几何口径）；
 *   A3. 反向变异（验牙）：在页面里把列头模板改回旧版
 *       `..._64px_auto]`（动作列 auto 且空 ⇒ 0px）——A1/A2 断言**必红**，
 *       证明断言不是恒绿；还原后复绿。
 *
 * 用法:: node verify/verify_bug399_column_alignment.cjs
 * Exit: 0 = 全部通过；1 = 任一判据失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-bug399')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页内量测：头/行的轨道模板与同序单元格 left。 */
const MEASURE_FN = () => {
  const header = document.querySelector('[data-testid="file-list-header"]')
  const row = document.querySelector('[data-testid="file-list-row"]')
  if (!header || !row) return { error: 'header/row not found' }
  const lefts = (el) => Array.from(el.children).map((c) => Math.round(c.getBoundingClientRect().left * 10) / 10)
  return {
    headerCols: getComputedStyle(header).gridTemplateColumns,
    rowCols: getComputedStyle(row).gridTemplateColumns,
    headerLefts: lefts(header),
    rowLefts: lefts(row),
  }
}

function judge(m) {
  const problems = []
  if (m.error) return [m.error]
  if (m.headerCols !== m.rowCols) {
    problems.push(`A1 轨道模板不等: header=[${m.headerCols}] row=[${m.rowCols}]`)
  }
  if (m.headerLefts.length !== m.rowLefts.length) {
    problems.push(`列数不等: header=${m.headerLefts.length} row=${m.rowLefts.length}`)
  } else {
    m.headerLefts.forEach((hl, i) => {
      const diff = Math.abs(hl - m.rowLefts[i])
      if (diff > 2) problems.push(`A2 第${i + 1}列 left 差 ${diff}px (header=${hl} row=${m.rowLefts[i]}) > 2px`)
    })
  }
  return problems
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const results = {}
  let failed = false
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-files"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="file-list-row"]').length > 0,
      { timeout: 30000 },
    )
    await delay(600)

    // ── 正测：修复后实现 ──
    results.fixed = judge(await page.evaluate(MEASURE_FN))

    // ── 反向变异（验牙）：列头改回旧模板（auto 动作列 + 空 span ⇒ 0px 轨道），
    //    断言必须转红；再还原。只动页面内 inline style，不碰源码。 ──
    await page.evaluate(() => {
      const header = document.querySelector('[data-testid="file-list-header"]')
      header.dataset.mutated = '1'
      header.style.gridTemplateColumns = '20px 24px minmax(0,1fr) 64px 88px 104px 64px auto'
    })
    await delay(100)
    results.mutated = judge(await page.evaluate(MEASURE_FN))
    await page.evaluate(() => {
      const header = document.querySelector('[data-testid="file-list-header"]')
      delete header.dataset.mutated
      header.style.gridTemplateColumns = ''
    })

    const file = path.join(OUT_DIR, 'bug399-fixed.png')
    await page.screenshot(file, { fullPage: false })
    results.screenshot = file
    results.consoleErrors = page.consoleErrors().slice(0, 5)
  } finally {
    await browser.close()
  }

  results.verdict =
    results.fixed.length === 0 && results.mutated.length > 0
      ? 'PASS (fixed aligned; mutated assertion trips — assertion has teeth)'
      : 'FAIL'
  if (results.verdict.startsWith('FAIL')) failed = true
  fs.writeFileSync(path.join(OUT_DIR, 'bug399-verify.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e && e.message ? e.message : e)
  process.exit(1)
})
