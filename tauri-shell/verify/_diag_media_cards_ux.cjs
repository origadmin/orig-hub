'use strict'
/**
 * 诊断：媒体库「剧集墙 / 视频网格」卡片尺寸与文字可读性实测
 * （用户 2026-10-20「剧集和视频一样的问题,卡片太小内容都看不清了」）。
 *
 * 只测不修：把「卡片太小 / 看不清」变成数字 —— 列数、卡宽、标题/副标题字号、
 * 标题被截掉多少像素，再决定改什么。
 *
 * 用法：node tauri-shell/verify/_diag_media_cards_ux.cjs
 * 产物：verify_shots/diag-media-cards-ux/（截图 + report.json）
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'diag-media-cards-ux')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

const MEASURE = () => {
  const grid = document.querySelector('[data-testid="media-grid"]')
  const seriesRoot = document.querySelectorAll('[data-testid="series-card-root"]')
  const cards = document.querySelectorAll('[data-testid="media-card"]')
  const gridEl = grid || (seriesRoot.length ? seriesRoot[0].parentElement : null)
  const cols = gridEl
    ? getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean).map(Number)
    : []
  const cardEl = seriesRoot[0] || cards[0] || null
  const cardRect = cardEl ? cardEl.getBoundingClientRect() : null
  /** 标题元素：剧集卡与媒体卡都是 `<p class="truncate text-...">`。 */
  const titleEl = cardEl
    ? Array.from(cardEl.querySelectorAll('p')).find((p) => p.className.includes('truncate'))
    : null
  const metaEl = titleEl && titleEl.nextElementSibling ? titleEl.nextElementSibling : null
  const fsOf = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null)
  /** 标题被截掉多少（scrollWidth − clientWidth）；>0 就是「内容看不清」的硬证据。 */
  const trunc = (el) => (el ? Math.max(0, el.scrollWidth - el.clientWidth) : null)
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    container: gridEl
      ? {
          clientWidth: gridEl.clientWidth,
          scrollWidth: gridEl.scrollWidth,
          cols: cols.length,
          trackWidths: cols.map((c) => Math.round(c)),
        }
      : null,
    cardCount: seriesRoot.length || cards.length,
    card: cardRect
      ? {
          w: Math.round(cardRect.width),
          h: Math.round(cardRect.height),
        }
      : null,
    title: {
      fontSize: fsOf(titleEl),
      truncatedPx: trunc(titleEl),
      text: titleEl ? titleEl.textContent.trim().slice(0, 40) : null,
      fullWidth: titleEl ? titleEl.scrollWidth : null,
      visibleWidth: titleEl ? titleEl.clientWidth : null,
    },
    meta: { fontSize: fsOf(metaEl), text: metaEl ? metaEl.textContent.trim().slice(0, 40) : null },
    /** 卡片内所有文字节点的字号直方图（找 <12px 的正文）。 */
    fontHistogram: (() => {
      const h = {}
      if (!cardEl) return h
      for (const el of cardEl.querySelectorAll('*')) {
        if (!(el.textContent || '').trim() || el.children.length > 0) continue
        const s = parseFloat(getComputedStyle(el).fontSize)
        h[s] = (h[s] || 0) + 1
      }
      return h
    })(),
  }
}

async function snap(page, label) {
  const m = await page.evaluate(MEASURE)
  await page.screenshot(path.join(OUT, `${label}.png`))
  return m
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)

  const out = {}

  // ── 剧集墙 ─────────────────────────────────────────────────────────
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card-root"]').length > 0,
    { timeout: 20000 },
  )
  out.series = await snap(page, '01-series-wall')

  // ── 视频网格 ───────────────────────────────────────────────────────
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-cat-video"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="media-card"]').length > 0,
    { timeout: 20000 },
  )
  out.videos = await snap(page, '02-video-grid')

  // ── 最矮受支持窗口下的同一组量 ────────────────────────────────────
  await page.setViewport({ width: 900, height: 600 })
  await new Promise((r) => setTimeout(r, 700))
  out.videosMin = await snap(page, '03-video-grid-900x600')

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card-root"]').length > 0,
    { timeout: 20000 },
  )
  out.seriesMin = await snap(page, '04-series-wall-900x600')

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log(JSON.stringify(out, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
