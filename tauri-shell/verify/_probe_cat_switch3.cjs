#!/usr/bin/env node
'use strict'

/** 探针3（临时，提交前删）：等 boot 完成后用 el.click() 走分类序列，判定编程点击是否依赖「应用已完全起来」。 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const ep = await endpoints.resolve()
  console.log(`[probe3] app=${ep.app}`)
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(ep.app, { waitUntil: 'load', settleMs: 2000 })

    // 等 boot 真正完成：开机默认落点 cat-all ⇒ items 网格出卡（React 已渲染并挂载事件）。
    const booted = await page
      .waitForFunction(() => document.querySelectorAll('[data-testid="media-card"]').length > 0, { timeout: 60000, intervalMs: 300 })
      .then(() => true)
      .catch(() => false)
    console.log(`[probe3] boot grid ready: ${booted}`)

    const click = async tid => {
      const ok = await page.evaluate(t => {
        const el = document.querySelector(`[data-testid="${t}"]`)
        if (!el) return 'missing'
        el.click()
        return 'clicked'
      }, tid)
      console.log(`[probe3] el.click ${tid} -> ${ok}`)
      return ok
    }
    const snap = async label => {
      const s = await page.evaluate(() => ({
        wall: document.querySelectorAll('[data-testid="series-card-root"]').length,
        cards: document.querySelectorAll('[data-testid="media-card"]').length,
      }))
      console.log(`[probe3] ${label}: ${JSON.stringify(s)}`)
    }

    await click('nav-child-lib-series')
    await sleep(2500)
    await snap('after lib-series')
    await click('nav-child-image')
    await sleep(5000)
    await snap('after image')

    const sem = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      let play = 0, zoom = 0
      for (const c of cards) {
        if (c.querySelector('[class*="lucide-play"]')) play += 1
        if (c.querySelector('[class*="lucide-zoom-in"]')) zoom += 1
      }
      return { cards: cards.length, play, zoom }
    })
    console.log('[probe3] semantics after image:', JSON.stringify(sem))
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('[probe3] ERROR', e && e.message ? e.message : e); process.exit(1) })
