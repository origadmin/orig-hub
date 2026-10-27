#!/usr/bin/env node
'use strict'

/** 探针（临时，提交前删）：复现 card_kind 脚本的分类切换，抓真实请求与网格状态。 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const ep = await endpoints.resolve()
  console.log(`[probe] app=${ep.app}`)
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    const reqs = []
    page.conn.on('Network.requestWillBeSent', p => {
      const u = p && p.request && p.request.url
      if (u && /\/api\/media\/items/.test(u)) reqs.push(u)
    })
    await page.goto(ep.app, { waitUntil: 'load', settleMs: 2000 })

    const click = async (tid) => {
      const ok = await page.evaluate(t => {
        const el = document.querySelector(`[data-testid="${t}"]`)
        if (!el) return 'missing'
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        el.click()
        return hit && hit !== el && !el.contains(hit) ? `covered-by:${hit.getAttribute('data-testid') || hit.tagName}` : 'clicked'
      }, tid)
      console.log(`[probe] click ${tid} -> ${ok}`)
      return ok
    }

    await click('nav-child-lib-series')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-cat-video"]'), { timeout: 20000 }).catch(e => console.log('[probe] wait cat-video FAILED:', e.message))
    await sleep(1500)
    console.log('[probe] after lib-series: items reqs =', JSON.stringify(reqs))

    await click('nav-child-image')
    await sleep(6000)
    console.log('[probe] after image click: items reqs =', JSON.stringify(reqs))

    const grid = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      const badges = cards.slice(0, 8).map(c => {
        const b = c.querySelector('[data-testid="item-kind"]')
        return b ? (b.textContent || '').trim() : '(no badge)'
      })
      return { count: cards.length, badges }
    })
    console.log('[probe] grid:', JSON.stringify(grid))

    // 面板内部态：view/tab 的体现 —— 左栏高亮 + 搜索框占位等看不出来，直接看 DOM 里
    // 有没有 photo 语义（zoom-in 图标 / 图片徽标）
    const semantics = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      let play = 0, zoom = 0
      for (const c of cards) {
        const ic = c.querySelector('[class*="lucide-play"]')
        const iz = c.querySelector('[class*="lucide-zoom-in"]')
        if (ic) play += 1
        if (iz) zoom += 1
      }
      return { play, zoom }
    })
    console.log('[probe] card icon semantics:', JSON.stringify(semantics))
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('[probe] ERROR', e && e.message ? e.message : e); process.exit(1) })
