#!/usr/bin/env node
'use strict'

/**
 * 一次性探针：TG 相册折叠封面「点击是否展开」。
 *
 * 分三件事：
 *   ① dump `album-cover` 的元素结构（tag / role / 是否有 onclick / outerHTML 片段）；
 *   ② 用 **真实鼠标事件**（`Input.dispatchMouseEvent`）点它的中心点，再读
 *      `elementFromPoint` —— 判定是「被遮挡」还是「处理器没接上」；
 *   ③ 对比 `el.click()`（合成事件）与真实点击的结果。
 *
 * Usage: node verify/_probe_album_click.cjs
 * Env:   VERIFY_APP_URL(默认 http://127.0.0.1:5180/)
 */

const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const VIEWPORT = { width: 900, height: 600 }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    await page.setViewport(VIEWPORT)
    await page.goto(APP, { waitForRoot: true, settleMs: 1200 })
    await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="nav-tg"]')
      if (nav) nav.click()
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tg-monitor-row"]').length > 0, { timeout: 60000 })
    await page.evaluate(() => document.querySelector('[data-testid="tg-monitor-row"]').click())
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="album-cover"]').length > 0, { timeout: 60000 })
    await delay(1200)

    const before = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="album-cover"]')
      if (!el) return { error: 'no album-cover' }
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return {
        html: el.outerHTML.slice(0, 400),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        hasOnclickAttr: el.hasAttribute('onclick'),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        gridCount: document.querySelectorAll('[data-testid="album-grid"]').length,
      }
    })
    console.log('[probe] BEFORE =', JSON.stringify(before, null, 2))

    // 真实鼠标点击中心点
    const hit = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="album-cover"]')
      const r = el.getBoundingClientRect()
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      const top = document.elementFromPoint(cx, cy)
      return {
        cx: Math.round(cx),
        cy: Math.round(cy),
        topTag: top ? top.tagName.toLowerCase() : null,
        topTestid: top ? top.getAttribute('data-testid') : null,
        topIsCoverOrChild: top ? el.contains(top) : false,
      }
    })
    console.log('[probe] HIT TEST =', JSON.stringify(hit))

    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.conn.send(
        'Input.dispatchMouseEvent',
        { type, x: hit.cx, y: hit.cy, button: 'left', clickCount: 1 },
        { sessionId: page.sessionId },
      )
      await delay(120)
    }
    await delay(2000)

    const afterReal = await page.evaluate(() => ({
      grid: document.querySelectorAll('[data-testid="album-grid"]').length,
      cover: document.querySelectorAll('[data-testid="album-cover"]').length,
    }))
    console.log('[probe] AFTER REAL CLICK =', JSON.stringify(afterReal))

    if (afterReal.grid === 0) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="album-cover"]')
        if (el) el.click()
      })
      await delay(2000)
      const afterSynth = await page.evaluate(() => ({
        grid: document.querySelectorAll('[data-testid="album-grid"]').length,
        cover: document.querySelectorAll('[data-testid="album-cover"]').length,
      }))
      console.log('[probe] AFTER SYNTHETIC click() =', JSON.stringify(afterSynth))
    }

    console.log('[probe] PAGE_ERRORS =', JSON.stringify(page.pageErrors().slice(0, 5)))
    console.log('[probe] CONSOLE_ERRORS =', JSON.stringify(page.consoleErrors().slice(0, 8)))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[probe] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
