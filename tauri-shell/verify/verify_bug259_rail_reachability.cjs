'use strict'

/**
 * BUG-259 判据 3：左栏子列表「限高」不得以牺牲可达性为代价。
 *
 * 背景（2026-10-13 用户裁定）：左栏形态 = 直接限高，不分页、不「+N」折叠。
 * 该裁定的**前提**是「左栏那两个子列表只是快捷入口，完整列表另有入口」——
 * 本脚本把这个前提变成可执行断言，**修复前后都必须 PASS**：
 *
 *   前提 A：「全部剧集」(`media-rail-series-all`) 点开后，主区剧集墙
 *           (`series-wall-scroll`) 必须渲染**与按钮计数相同数量**的 `series-card`。
 *   前提 B：「标签管理」(`media-tag-manage`) 点开后，弹窗内 `tag-row-*` 数量
 *           必须**等于** API 报告的标签总数。
 *
 * 判据不是「有卡片」，而是「数量与权威计数一致」——
 * 否则「显示了一部分」也能骗过「有卡片」这种弱断言。
 *
 * 反向证伪：把任一入口的计数改成不可能的值（例如断言 = 999），本脚本必须 FAIL；
 * 数量取自**页面自身与 API 两处**并交叉比对，单点造假无法同时骗过两边。
 *
 * 用法：
 *   node tauri-shell/verify/verify_bug259_rail_reachability.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 */

const path = require('node:path')
const http = require('node:http')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const API_URL = process.env.VERIFY_API_URL || 'http://127.0.0.1:19787'

/** 从 orig-tg 取权威计数（不经过页面，避免用被测对象自己的数字自证）。 */
function apiStats(base) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/media/stats`, { timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(body) })
        } catch (_e) {
          resolve({ ok: false, data: null })
        }
      })
    })
    req.on('error', () => resolve({ ok: false, data: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, data: null })
    })
  })
}

async function main() {
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }

  const stats = await apiStats(API_URL)
  check('取到 orig-tg 权威计数（外部真值）', stats.ok && !!stats.data,
    stats.ok && stats.data ? `items=${stats.data.items} series=${stats.data.series} tags=${stats.data.tags}` : `无法访问 ${API_URL}/api/media/stats`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 2500))
    await page.evaluate(() => document.querySelector('[data-testid="nav-media"]').click())
    await new Promise((r) => setTimeout(r, 3500))

    // ── 前提 A：全部剧集 → 完整剧集列表 ──────────────────────────────────
    const label = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="media-rail-series-all"]')
      return b ? b.innerText.replace(/\s+/g, ' ').trim() : null
    })
    check('左栏存在「全部剧集」入口', label !== null, label || '未找到 media-rail-series-all')

    await page.evaluate(() => document.querySelector('[data-testid="media-rail-series-all"]').click())
    await new Promise((r) => setTimeout(r, 2500))
    const wall = await page.evaluate(() => {
      const w = document.querySelector('[data-testid="series-wall-scroll"]')
      return { exists: !!w, cards: document.querySelectorAll('[data-testid="series-card"]').length }
    })
    const apiSeries = stats.data ? stats.data.series : -1
    check('「全部剧集」到达完整剧集列表（卡片数 == API 剧集总数）',
      wall.exists && apiSeries > 0 && wall.cards === apiSeries,
      `主区 series-card=${wall.cards} / API series=${apiSeries}`)

    // ── 前提 B：标签管理 → 完整标签列表 ──────────────────────────────────
    await page.evaluate(() => document.querySelector('[data-testid="media-tag-manage"]').click())
    await new Promise((r) => setTimeout(r, 1800))
    const dlg = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid^="tag-row-"]').length,
    }))
    const apiTags = stats.data ? stats.data.tags : -1
    check('「标签管理」到达完整标签列表（行数 == API 标签总数）',
      apiTags > 0 && dlg.rows === apiTags,
      `弹窗 tag-row-*=${dlg.rows} / API tags=${apiTags}`)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} PASS`)
    return failed.length === 0 ? 0 : 2
  } finally {
    await browser.close()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('VERIFY FAILED:', e && e.message ? e.message : e)
    process.exit(1)
  })
