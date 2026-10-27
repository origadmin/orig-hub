#!/usr/bin/env node
'use strict'

/** 探针2（临时，提交前删）：真实鼠标点击 + 每步 DOM 态，定位分类切换失效点。 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const ep = await endpoints.resolve()
  console.log(`[probe2] app=${ep.app}`)
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    const reqs = []
    page.conn.on('Network.requestWillBeSent', p => {
      const u = p && p.request && p.request.url
      if (u && /\/api\/media\/items/.test(u)) reqs.push(u)
    })
    await page.goto(ep.app, { waitUntil: 'load', settleMs: 2500 })

    const snap = async label => {
      const s = await page.evaluate(() => {
        const q = t => document.querySelectorAll(`[data-testid="${t}"]`).length
        const active = [...document.querySelectorAll('[data-testid^="nav-child-"]')]
          .filter(el => (el.className || '').includes('accent') || el.getAttribute('aria-current'))
          .map(el => el.getAttribute('data-testid'))
        return {
          seriesWall: q('series-card-root'),
          mediaCards: q('media-card'),
          activeNav: active,
          reqCount: window.__p2req ? window.__p2req.length : -1,
        }
      })
      console.log(`[probe2] ${label}: ${JSON.stringify(s)} reqs=${JSON.stringify(reqs)}`)
      return s
    }

    // 真实鼠标点击（elementFromPoint 找可见命中点，模拟用户）
    const mouseClick = async tid => {
      const box = await page.evaluate(t => {
        const el = document.querySelector(`[data-testid="${t}"]`)
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, tid)
      if (!box) { console.log(`[probe2] mouseClick ${tid}: MISSING`); return false }
      await page.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, { sessionId: page.sessionId })
      await page.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, { sessionId: page.sessionId })
      console.log(`[probe2] mouseClick ${tid} @ (${Math.round(box.x)},${Math.round(box.y)})`)
      return true
    }

    await snap('boot')
    await mouseClick('nav-child-lib-series')
    await sleep(2000)
    await snap('after lib-series')
    await mouseClick('nav-child-cat-video')
    await sleep(3000)
    await snap('after cat-video')
    await mouseClick('nav-child-image')
    await sleep(4000)
    await snap('after image')

    // 图片网格语义
    const sem = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      let play = 0, zoom = 0
      for (const c of cards) {
        if (c.querySelector('[class*="lucide-play"]')) play += 1
        if (c.querySelector('[class*="lucide-zoom-in"]')) zoom += 1
      }
      return { cards: cards.length, play, zoom }
    })
    console.log('[probe2] semantics after image:', JSON.stringify(sem))
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('[probe2] ERROR', e && e.message ? e.message : e); process.exit(1) })
