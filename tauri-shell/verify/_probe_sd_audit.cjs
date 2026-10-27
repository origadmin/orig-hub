#!/usr/bin/env node
'use strict'

/** 临时探针（提交前删）：渲染一部真实有字节剧集的详情页，逐项核验
 *  BUG-171（简介重复/海报比例）/ BUG-350（主从分区）/ BUG-365（集数口径）/
 *  BUG-369（右栏播放按钮移除+左栏行内播放）在当前 live 栈是否真的落地。 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const ep = await endpoints.resolve()
  const APP = ep.app.endsWith('/') ? ep.app : `${ep.app}/`
  const TARGET = Number(process.env.PROBE_SERIES || 540)
  console.log(`[sd-audit] app=${APP} targetSeries=${TARGET}`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    const errs = []
    page.on && page.on('console', m => { if (m.type && m.type() === 'error') errs.push(m.text()) })
    page.on && page.on('pageerror', e => errs.push('PAGEERR: ' + (e && e.message)))

    await page.goto(APP, { waitUntil: 'load', settleMs: 2500 })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-lib-series"]'), { timeout: 30000 })
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card"]').length > 0, { timeout: 30000 })
    await sleep(600)

    const clicked = await page.evaluate(sid => {
      const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
      if (!card) return 'missing'
      card.scrollIntoView({ block: 'center' })
      card.click()
      return 'clicked'
    }, TARGET)
    console.log(`[sd-audit] card click -> ${clicked}`)
    const up = await page
      .waitForFunction(() => !!document.querySelector('[data-testid="episode-focus-title"]'), { timeout: 60000, intervalMs: 300 })
      .then(() => true)
      .catch(() => false)
    console.log(`[sd-audit] detail rendered=${up}`)
    if (!up) {
      const tail = await page.evaluate(() => (document.body.innerText || '').slice(0, 200))
      console.log('[sd-audit] NO DETAIL; body tail=', JSON.stringify(tail))
      console.log('[sd-audit] errors=', JSON.stringify(errs.slice(0, 8)))
      return
    }
    await sleep(500)

    const shot = await page.evaluate(() => {
      const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      const cover = document.querySelector('[data-testid="series-cover"]')
      const coverRect = rect(cover)
      const meta = document.querySelector('[data-testid="series-meta"]')
      const legacyPlay = document.querySelectorAll('[data-testid="episode-play"]')
      const rowPlay = document.querySelectorAll('[data-testid="episode-row-play"]')
      const descEdit = document.querySelectorAll('[data-testid="series-desc-edit"]')
      const seriesEdit = document.querySelectorAll('[data-testid="series-edit"]')
      const focusDescNodes = document.querySelectorAll('[data-testid="episode-focus-desc"]')
      const primary = document.querySelector('[data-testid="episode-primary-zone"]')
      const secondary = document.querySelector('[data-testid="episode-secondary-zone"]')
      const focusDesc = document.querySelector('[data-testid="episode-focus-desc"]')
      const focusDescLabel = document.querySelector('[data-testid="episode-focus-desc-label"]')
      const seriesDesc = document.querySelector('[data-testid="series-description"]')
      // count occurrence of series description text in visible body
      const bodyText = (document.body.innerText || '')
      const sdText = seriesDesc ? (seriesDesc.innerText || '').trim() : ''
      let occur = 0
      if (sdText.length > 0) {
        let i = 0
        while ((i = bodyText.indexOf(sdText, i)) !== -1) { occur++; i += sdText.length }
      }
      return {
        coverRect,
        coverRatio: coverRect && coverRect.h ? +(coverRect.w / coverRect.h).toFixed(4) : null,
        metaText: meta ? (meta.innerText || '').replace(/\s+/g, ' ').trim() : null,
        legacyPlayCount: legacyPlay.length,
        rowPlayCount: rowPlay.length,
        descEditCount: descEdit.length,
        seriesEditCount: seriesEdit.length,
        focusDescCount: focusDescNodes.length,
        primaryRect: rect(primary),
        secondaryRect: rect(secondary),
        focusDescText: focusDesc ? (focusDesc.innerText || '').trim().slice(0, 60) : null,
        focusDescLabel: focusDescLabel ? (focusDescLabel.innerText || '').trim() : null,
        seriesDescText: sdText.slice(0, 60),
        seriesDescOccurInBody: occur,
        bodyTextSample: bodyText.replace(/\s+/g, ' ').slice(0, 400),
      }
    })
    console.log('[sd-audit] SNAPSHOT=' + JSON.stringify(shot, null, 2))
    console.log('[sd-audit] errors=', JSON.stringify(errs.slice(0, 8)))
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('[sd-audit] ERROR', e && e.message ? e.message : e); process.exit(1) })
