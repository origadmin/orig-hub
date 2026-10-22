#!/usr/bin/env node
'use strict'

/**
 * 一次性探针：dump 剧集详情**右栏**（`episode-focus-title` 所在 section）里
 * 带 `data-zone` / `data-testid` 的块，按文档序输出 tag/testid/y/高/文案前 24 字。
 * 用于确认「移走满宽播放按钮」没有把右栏动作条一起带走。
 *
 * Usage: node verify/_probe_pane_order.cjs
 * Env:   APP_PORT(默认5180) PROBE_SERIES(默认3) PROBE_EPISODE(默认131)
 */

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const SERIES_ID = Number(process.env.PROBE_SERIES || 3)
const EPISODE_ID = Number(process.env.PROBE_EPISODE || 131)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    await page.conn.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, { sessionId: page.sessionId })
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card"]').length > 0, { timeout: 20000 })
    await delay(600)
    await page.evaluate((sid) => document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`).click(), SERIES_ID)
    await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-focus-title"]'), { timeout: 15000 })
    await delay(600)
    await page.evaluate((eid) => {
      const b = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${eid}"]`)
      if (b) b.click()
    }, EPISODE_ID)
    await delay(900)

    const rows = await page.evaluate(() => {
      const title = document.querySelector('[data-testid="episode-focus-title"]')
      const pane = title ? title.closest('section') : null
      if (!pane) return { error: 'no pane' }
      const out = []
      const walk = (el, depth) => {
        for (const c of Array.from(el.children)) {
          const tid = c.getAttribute('data-testid')
          const zone = c.getAttribute('data-zone')
          if (tid || zone) {
            const r = c.getBoundingClientRect()
            out.push({
              depth,
              tag: c.tagName.toLowerCase(),
              testid: tid,
              zone,
              y: Math.round(r.y),
              h: Math.round(r.height),
              w: Math.round(r.width),
              text: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            })
          }
          if (depth < 3) walk(c, depth + 1)
        }
      }
      walk(pane, 0)
      return { paneW: Math.round(pane.getBoundingClientRect().width), rows: out }
    })
    console.log(JSON.stringify(rows, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[probe] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
