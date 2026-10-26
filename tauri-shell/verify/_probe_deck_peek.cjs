#!/usr/bin/env node
'use strict'
/**
 * BUG-429 取证：本集图组（Deck 平铺）的可点击露边宽度，与编辑面板缩略图尺寸。
 *
 * 用户 2026-10-26 原话：
 *   「本集图组 平铺需要再展开一点,后面的图片不容易点击.
 *     编辑中的图片展示也需要稍微放大点,这是图片不是ICON.」
 *
 * 本脚本只取证，输出：
 *   A. Deck：总宽、相邻卡左边界间距（step）、每张卡**露出的宽度**、容器可用宽；
 *   B. 编辑面板：缩略图实际像素尺寸（getBoundingClientRect）；
 *   C. 命中测试：在后卡露边中点做 elementFromPoint，看命中的是不是后卡本身。
 *
 * 用法：node tauri-shell/verify/_probe_deck_peek.cjs [SERIES_ID]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-deck-peek'),
)
const SERIES_ID = Number(process.argv[2] || process.env.SERIES_ID || 217)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openSeries(page, sid) {
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
      console.log(`[deck-peek] attempt#${attempt + 1}: series ${sid} not in wall`)
      await delay(1500)
      continue
    }
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
      await delay(500)
    }
    // 只在**确认进了详情**时才返回；否则重试（否则后续断言会拿到空 DOM 假红）
    const inDetail = await page.evaluate(
      () => !!document.querySelector('[data-testid="episode-focus-title"]'),
    )
    if (!inDetail) {
      console.log(`[deck-peek] attempt#${attempt + 1}: detail pane not opened`)
      await delay(1500)
      continue
    }
    await delay(900)
    return
  }
  throw new Error('series detail not reachable')
}

/** 找一集「帧数 ≥ 3」的分集：逐行点过去，直到 Deck 的计数 ≥ 3 */
async function focusRichEpisode(page) {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="episode-pick"]')].length,
  )
  for (let i = 0; i < rows; i++) {
    await page.evaluate((k) => {
      const rowsEl = [...document.querySelectorAll('[data-testid="episode-pick"]')]
      if (rowsEl[k]) rowsEl[k].click()
    }, i)
    await delay(700)
    const n = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="episode-deck-count"]')
      if (!c) return 0
      const m = (c.textContent || '').match(/\/\s*(\d+)/)
      return m ? Number(m[1]) : 0
    })
    if (n >= 3) return { row: i, frames: n }
  }
  return { row: -1, frames: 0 }
}

function readDeck() {
  const deck = document.querySelector('[data-testid="episode-deck"]')
  if (!deck) return { exists: false }
  const dr = deck.getBoundingClientRect()
  const cards = [...deck.children].filter(
    // Tailwind 的 `absolute` 是 class 不是内联样式 ⇒ 必须读计算值
    (el) => el.tagName === 'DIV' && getComputedStyle(el).position === 'absolute',
  )
  const rects = cards.map((el) => {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.x * 100) / 100,
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      z: Number(getComputedStyle(el).zIndex) || 0,
    }
  })
  // 按 x 升序，露边 = 相邻间距（最后一张露全宽）
  const byX = [...rects].sort((a, b) => a.x - b.x)
  const steps = []
  for (let i = 1; i < byX.length; i++) steps.push(Math.round((byX[i].x - byX[i - 1].x) * 100) / 100)
  // 命中测试：取 z 最小（最靠后）的一张，在它的左缘 + 4px 处点一下
  let hit = null
  if (byX.length >= 2) {
    const back = byX[0]
    const px = back.x + 4
    const py = back.y !== undefined ? back.y : dr.y + back.h / 2
    const el = document.elementFromPoint(px, dr.y + back.h / 2)
    hit = {
      probeX: Math.round(px),
      probeY: Math.round(dr.y + back.h / 2),
      tag: el ? el.tagName : null,
      testid: el ? el.getAttribute('data-testid') || '' : '',
      isDeckOrChild: el ? deck.contains(el) : false,
      // 命中的是不是「那张后卡」本身（而不是更靠前的卡盖住了它）
      hitCardIndex: el ? cards.indexOf(el.closest('div')) : -1,
      py,
    }
  }
  const parent = deck.parentElement
  return {
    exists: true,
    count: deck.getAttribute('data-deck-count'),
    deckRect: { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.width), h: Math.round(dr.height) },
    parentW: parent ? Math.round(parent.getBoundingClientRect().width) : null,
    cardCount: rects.length,
    cardW: rects.length ? rects[0].w : null,
    steps,
    hit,
  }
}

function readEditThumbs() {
  const wrap = document.querySelector('[data-testid="episode-edit-images"]')
  if (!wrap) return { exists: false }
  const imgs = [...wrap.querySelectorAll('img')].map((im) => {
    const r = im.getBoundingClientRect()
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }
  })
  const detach = wrap.querySelector('[data-testid="episode-image-detach"]')
  const dr = detach ? detach.getBoundingClientRect() : null
  return {
    exists: true,
    count: imgs.length,
    first: imgs[0] ?? null,
    detach: dr ? { w: Math.round(dr.width), h: Math.round(dr.height) } : null,
  }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const report = { seriesId: SERIES_ID }
  try {
    await openSeries(page, SERIES_ID)
    report.focus = await focusRichEpisode(page)
    report.deck = await page.evaluate(readDeck)
    await page.screenshot(path.join(OUT, 'A-deck.png'))

    // 进编辑态量缩略图
    const opened = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="episode-edit"]')
      if (!b) return false
      b.click()
      return true
    })
    if (opened) {
      await delay(900)
      report.edit = await page.evaluate(readEditThumbs)
      await page.screenshot(path.join(OUT, 'B-edit.png'))
      // 关掉编辑态，避免影响后续
      await page.pressKey('Escape').catch(() => {})
    } else {
      report.edit = { exists: false, why: 'episode-edit button not found' }
    }
  } catch (e) {
    report.error = e.message
  } finally {
    await browser.close().catch(() => {})
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log('focus: ' + JSON.stringify(report.focus))
  console.log('deck:\n' + JSON.stringify(report.deck, null, 2))
  console.log('edit: ' + JSON.stringify(report.edit, null, 2))
  if (report.error) console.log('ERROR: ' + report.error)
  console.log('report: ' + path.join(OUT, 'report.json'))
})().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
