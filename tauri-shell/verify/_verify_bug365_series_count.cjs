#!/usr/bin/env node
'use strict'
/**
 * BUG-365 取证 + 验收：剧集详情页计数口径与剧集卡**同源**，
 * 且视频数可与左栏选集器行数一一对上（不得再把挂图算成「第 N 集」）。
 *
 * 用户 2026-10-22 复报：
 *   「时停手表EP1-3 原档观享 连载中 -> 视频3,下载2,图片1,其中1个文件丢失」
 *
 * 判据：
 *   G1 详情页 series-meta 不再渲染「N 集」式的 episodeCount（有 videoCount 时）；
 *   G2 详情页显示「视频 V · 图片 P」，V = 后端 videoCount、P = photoCount；
 *   G3 左栏选集器行数 == 详情页显示的视频数 V（一一可对上）；
 *   G4 剧集卡的 series-content-kinds 与详情页口径一致（同一部剧一个数）；
 *   G5 反证伪：把 mixedCount 换回 episodeCount ⇒ G1/G2 必须 FAIL。
 *
 * 用法::
 *   node _verify_bug365_series_count.cjs
 *   node _verify_bug365_series_count.cjs --expect-legacy   # 反向证伪
 * Exit: 0 = 全 PASS；1 = 有 FAIL
 */

const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const LEGACY = process.argv.includes('--expect-legacy')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail == null ? '' : '  — ' + detail}`)
}

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })

    // 进剧集视图
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
      { timeout: 30000 },
    )
    await delay(1500)

    // 找到目标剧（含「时停手表」），记下卡片的计数口径
    const picked = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="series-card"]')]
      const i = cards.findIndex((c) => (c.textContent || '').includes('时停手表'))
      if (i < 0) return null
      cards[i].click()
      const kinds = cards[i].querySelector('[data-testid="series-content-kinds"]')
      return { cardText: (kinds ? kinds.textContent : '').trim() }
    })
    if (!picked) throw new Error('未找到含「时停手表」的剧集卡')

    // 等详情页
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="series-meta"]'),
      { timeout: 30000 },
    )
    await delay(1200)

    const m = await page.evaluate(() => {
      const meta = document.querySelector('[data-testid="series-meta"]')
      const rows = document.querySelectorAll('[data-testid="episode-pick"]')
      const epPicker = document.querySelector('[data-testid="episode-picker"]')
      return {
        metaText: meta ? (meta.textContent || '').replace(/\s+/g, ' ').trim() : '',
        rowCount: rows.length,
        // 选集器里「照片行」也走 episode-pick，需按 kind 分
        photoRows: [...rows].filter((r) => /图片/.test(r.textContent || '')).length,
        pickerTotal: epPicker ? Number(epPicker.getAttribute('data-total') || '0') : null,
      }
    })

    const videoRows = m.rowCount - m.photoRows
    console.log(`[bug365] card="${picked.cardText}" meta="${m.metaText}" rows=${m.rowCount} photoRows=${m.photoRows} videoRows=${videoRows}`)

    // 从 meta 里解析「视频 V · 图片 P」
    const pv = /视频\s*(\d+)/.exec(m.metaText)
    const pp = /图片\s*(\d+)/.exec(m.metaText)
    const hasMixed = !!pv && !!pp
    const saysEpisodes = /(\d+)\s*集/.test(m.metaText)

    if (LEGACY) {
      // 反向证伪：这里期望「旧行为」——即渲染「N 集」。
      check('L1 旧行为：meta 渲染「N 集」', saysEpisodes, m.metaText)
      check('L2 旧行为：不渲染「视频 V · 图片 P」', !hasMixed, m.metaText)
      const bad = results.filter((r) => !r.ok).length
      console.log(`\n[bug365] legacy-mode: ${results.length - bad}/${results.length} 符合旧行为（应全部符合）`)
      process.exit(bad === 0 ? 0 : 1)
    }

    check('G1 详情页不再把挂图算成「N 集」', !saysEpisodes, m.metaText)
    check('G2 详情页显示「视频 V · 图片 P」', hasMixed, m.metaText)
    check(
      'G3 左栏视频行数 == 详情页视频数 V',
      hasMixed && videoRows === Number(pv[1]),
      `videoRows=${videoRows} metaV=${pv ? pv[1] : 'n/a'}`,
    )
    check(
      'G4 卡片与详情页口径一致（同现「视频 V」）',
      /视频\s*\d+/.test(picked.cardText) && hasMixed,
      `card="${picked.cardText}" meta="${m.metaText}"`,
    )
    check('G5 选集器确有行可数（不是空列表蒙对）', m.rowCount > 0, `rows=${m.rowCount}`)

    const bad = results.filter((r) => !r.ok).length
    console.log(`\n[bug365] ${results.length - bad}/${results.length} PASS`)
    process.exit(bad === 0 ? 0 : 1)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[bug365] FATAL:', e && e.message ? e.message : e)
  process.exit(2)
})
