#!/usr/bin/env node
'use strict'
/**
 * BUG-262 复核取证：左栏「▶ 播放全部」入口是否真的存在且可用。
 *
 * 为什么现在复核：BUG-262 至今 status=open，正文写「左栏零播放入口、
 * 唯一入口是右栏逐集 ▶」。但 BUG-369 之后右栏那颗满宽播放已删除、
 * 左栏补了 `series-play-all` 与每条分集行的 `episode-row-play` ——
 * 登记册与实现**互相矛盾**，属用户报的「记录错误」。
 *
 * 判据（对应 BUG-262「修复后必须满足」第 1、5 条）：
 *  262-A 左栏存在 `series-play-all`，可见（矩形 > 0）且文案非空。
 *  262-B 点它 ⇒ 打开播放器，播放序列 = 整部剧集（条目数 == 分集数）。
 *  262-C 起始项 = 第一个**有字节**的分集（不是第 1 行盲取）。
 *  262-D 右栏已无满宽播放主按钮（`episode-play` 计数 0，BUG-369 的裁定仍成立）。
 *
 * 用法：node tauri-shell/verify/_probe_series_play_all.cjs [SERIES_ID]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-play-all'),
)
const SERIES_ID = Number(process.argv[2] || process.env.SERIES_ID || 216)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openSeriesById(page, sid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: 90000 })
    const ok = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!ok) {
      await delay(2000)
      continue
    }
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
        { timeout: 25000 },
      )
    } catch {
      await delay(2000)
      continue
    }
    await delay(1000)
    const clicked = await page.evaluate((id) => {
      const card = document.querySelector(`[data-testid="series-card"][data-series-id="${id}"]`)
      if (!card) return false
      card.click()
      return true
    }, sid)
    if (!clicked) {
      await delay(1500)
      continue
    }
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
      await delay(500)
    }
    await delay(800)
    return
  }
  throw new Error(`series ${sid} not reachable`)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const report = { seriesId: SERIES_ID }
  try {
    await openSeriesById(page, SERIES_ID)
    report.entry = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="series-play-all"]')
      const rows = [...document.querySelectorAll('[data-testid="episode-pick"]')]
      const playRows = [...document.querySelectorAll('[data-testid="episode-row-play"]')]
      if (!btn) return { exists: false, rows: rows.length, playRows: playRows.length }
      const r = btn.getBoundingClientRect()
      const cs = getComputedStyle(btn)
      return {
        exists: true,
        text: (btn.textContent || '').replace(/\s+/g, ' ').trim(),
        title: btn.getAttribute('title') || '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        bg: cs.backgroundColor,
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
        rows: rows.length,
        playRows: playRows.length,
        legacyPlayCount: document.querySelectorAll('[data-testid="episode-play"]').length,
      }
    })
    await page.screenshot(path.join(OUT, 'A-series-detail.png'))

    if (report.entry.exists) {
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="series-play-all"]')
        if (b) b.click()
      })
      try {
        await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"]'), {
          timeout: 20000,
        })
      } catch {
        report.viewer = { error: 'media-viewer did not open' }
      }
      await delay(1800)
      report.viewer = await page.evaluate(() => {
        const v = document.querySelector('[data-testid="media-viewer"]')
        if (!v) return { error: 'no viewer' }
        return {
          messageId: v.getAttribute('data-message-id'),
          playlistCount: document.querySelectorAll('[data-testid^="episode-list-item-"]').length,
        }
      })
      await page.screenshot(path.join(OUT, 'B-viewer.png'))
    }
  } catch (e) {
    report.error = e.message
  } finally {
    await browser.close().catch(() => {})
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log('entry: ' + JSON.stringify(report.entry, null, 2))
  console.log('viewer: ' + JSON.stringify(report.viewer, null, 2))
  if (report.error) console.log('ERROR: ' + report.error)
  console.log('report: ' + path.join(OUT, 'report.json'))
})().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
