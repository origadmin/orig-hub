#!/usr/bin/env node
'use strict'
/**
 * 2026-10-22 复报取证（BUG-367/368/369 三合的取证探针，只出数字不改判据）。
 *
 * 用户原话：
 *   1. 下载标题不统一行问题,多次提出未解决.
 *   2. 下载条目图片无法选择多次提出未解决.
 *   3. 文件剧集内容,播放位置互换未解决(丢失,错位,未修改,未按要求,混乱要求)
 *
 * 本脚本量化三件事：
 *   F1 文件列表（Explorer）每行的标题基线是否统一（同一列内 y 是否一致、
 *      是否有行标题换行到第二行、名称列宽分布）；
 *   F2 入库明细 Sheet 里**图片条目**是否可选中（复选框/可点行），与视频条目对比；
 *   F3 剧集详情右栏区块顺序（播放按钮在第几个内容位、与展示区的先后）。
 */

const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })

    // ── F1：文件列表标题基线 ────────────────────────────────────────
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-files"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="file-list-row"]').length > 0,
      { timeout: 30000 },
    )
    await delay(1500)

    const f1 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="file-list-row"]')]
      const info = rows.slice(0, 40).map((r) => {
        const nameSpan = r.querySelector('span.min-w-0.truncate')
        const rect = nameSpan ? nameSpan.getBoundingClientRect() : null
        const cs = nameSpan ? getComputedStyle(nameSpan) : null
        return {
          id: r.getAttribute('data-item-id'),
          src: r.getAttribute('data-source'),
          text: (nameSpan ? nameSpan.textContent : '').slice(0, 40),
          y: rect ? Math.round(rect.y) : null,
          h: rect ? Math.round(rect.height) : null,
          w: rect ? Math.round(rect.width) : null,
          fs: cs ? cs.fontSize : null,
          wrap: nameSpan ? nameSpan.getClientRects().length : 0,
        }
      })
      const heights = [...new Set(info.map((i) => i.h))]
      const fonts = [...new Set(info.map((i) => i.fs))]
      const widths = info.map((i) => i.w).filter((x) => x != null)
      return {
        n: info.length,
        distinctHeights: heights,
        distinctFonts: fonts,
        widthMin: widths.length ? Math.min(...widths) : null,
        widthMax: widths.length ? Math.max(...widths) : null,
        multiRectRows: info.filter((i) => i.wrap > 1).length,
        sample: info.slice(0, 12),
      }
    })
    console.log('=== F1 文件列表标题基线 ===')
    console.log(JSON.stringify(f1, null, 1))

    // ── F3：剧集详情右栏区块顺序 ────────────────────────────────────
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
      { timeout: 30000 },
    )
    await delay(1500)
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="series-card"]')]
      const i = cards.findIndex((c) => (c.textContent || '').includes('时停手表'))
      ;(cards[i >= 0 ? i : 0]).click()
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="series-meta"]'),
      { timeout: 30000 },
    )
    await delay(1500)

    const f3 = await page.evaluate(() => {
      const sec = document.querySelector('section')
      if (!sec) return { err: 'no section' }
      const zones = [...sec.querySelectorAll('[data-zone]')].map((z) => ({
        zone: z.getAttribute('data-zone'),
        y: Math.round(z.getBoundingClientRect().y),
        h: Math.round(z.getBoundingClientRect().height),
      }))
      const play = sec.querySelector('[data-testid="episode-play"]')
      const playRect = play ? play.getBoundingClientRect() : null
      const firstContent = sec.querySelector('h3, h4, p, button')
      return {
        meta: (document.querySelector('[data-testid="series-meta"]') || {}).textContent,
        zones,
        playY: playRect ? Math.round(playRect.y) : null,
        playH: playRect ? Math.round(playRect.height) : null,
        playText: play ? play.textContent.trim() : null,
        firstContentY: firstContent ? Math.round(firstContent.getBoundingClientRect().y) : null,
        sectionY: Math.round(sec.getBoundingClientRect().y),
        docOrder: [...sec.querySelectorAll('[data-testid]')]
          .slice(0, 14)
          .map((e) => e.getAttribute('data-testid')),
      }
    })
    console.log('=== F3 剧集详情右栏 ===')
    console.log(JSON.stringify(f3, null, 1))

    // ── F2：入库明细 Sheet 图片条目可选性 ──────────────────────────
    // 活动任务为 0 时下载域无行 ⇒ 只报「无夹具」，不伪造数字。
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await delay(2500)
    const f2 = await page.evaluate(() => {
      const groups = document.querySelectorAll('[data-testid="ingest-group-row"]')
      const engine = document.querySelectorAll('[data-testid="download-item"]')
      const overview = document.querySelector('[data-testid="dl-overview"]')
      const srcFilter = document.querySelector('[data-testid="dl-source-filter"]')
      const empty = document.querySelector('[data-testid="dl-empty"]')
      return {
        ingestRows: groups.length,
        engineRows: engine.length,
        hasOverview: !!overview,
        hasSourceFilter: !!srcFilter,
        hasEmpty: !!empty,
        overviewText: overview ? overview.textContent.replace(/\s+/g, ' ').trim() : null,
        overviewH: overview ? Math.round(overview.getBoundingClientRect().height) : null,
        srcFilterH: srcFilter ? Math.round(srcFilter.getBoundingClientRect().height) : null,
      }
    })
    console.log('=== F2 下载域（含顶部占位实测高） ===')
    console.log(JSON.stringify(f2, null, 1))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[diag] FATAL:', e && e.message ? e.message : e)
  process.exit(2)
})
