'use strict'
/**
 * BUG-328 验收：媒体库「剧集墙 / 视频网格」卡片尺寸与文字可读性。
 *
 * 用户 2026-10-20 原话：「剧集和视频一样的问题,卡片太小内容都看不清了.」
 *
 * 改前实测（1440×900，内容区 1214px）：
 *   剧集 7 列、卡 163×193、标题 12px、副标题 10px、卡内 8 个文字节点是 10px；
 *   视频 7 列、卡 163×210、标题 12px、副标题 10px、卡内 9 个节点 10px；
 *   最矮窗口 900×600（内容区 674px）：视频 4 列、卡 160×157。
 *
 * 判据（每条都要具体数值）：
 *   S0 源码：两个网格的 `minmax()` 均为 200px（剧集 160、视频 150 是旧值）；
 *   S1 源码：两张卡的标题都是 `text-sm`（14px），不再有 `text-[12px]` 标题；
 *   S2 剧集墙：默认窗口下卡宽 ≥ 220px、列数 ≤ 5、标题 ≥ 14px、副标题 ≥ 12px；
 *   S3 视频网格：同上；
 *   S4 卡内最小可读字号 ≥ 11px（角标/标签允许 11，正文不得再是 10px）；
 *   S5 最矮窗口 900×600：卡宽 ≥ 200px 且列数 ≥ 2（放大后不能退化成单列）；
 *   S6 封面未被压扁：卡内封面高度 > 0 且 ≤ 卡高的 0.75（aspect-video 仍生效）。
 *
 * 验牙（反向证伪，必须能红）：
 *   `--expect-legacy` 把 S2/S3 反置成旧尺寸（卡宽 ≤ 170px）⇒ 必须报红。
 *   把 minmax 改回 150/160 ⇒ S2/S3/S5 红；标题改回 text-[12px] ⇒ S1/S2 红。
 *
 * 用法：node tauri-shell/verify/verify_bug328_media_card_size.cjs [--expect-legacy]
 * 产物：verify_shots/bug328-media-card-size/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug328-media-card-size')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const PANEL = path.resolve(__dirname, '..', 'src', 'components', 'MediaLibraryPanel.tsx')
const SERIES_CARD = path.resolve(__dirname, '..', 'src', 'components', 'media', 'SeriesCard.tsx')
const MEDIA_CARD = path.resolve(__dirname, '..', 'src', 'components', 'media', 'MediaCard.tsx')
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}

/** 卡片测量：卡宽/卡高/列数/标题与副标题字号/卡内最小字号/封面高度。 */
const MEASURE = (cardSel, gridSel) => {
  const card = document.querySelector(cardSel)
  const grid =
    document.querySelector(gridSel) || (card ? card.parentElement : null)
  if (!card || !grid) return null
  const r = card.getBoundingClientRect()
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean)
  const title = Array.from(card.querySelectorAll('p')).find((p) =>
    p.className.includes('truncate'),
  )
  const meta = title && title.nextElementSibling ? title.nextElementSibling : null
  const cover = card.querySelector('img, [class*="aspect-"]')
  const coverRect = cover ? cover.getBoundingClientRect() : null
  const fsOf = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null)
  let minFont = Infinity
  for (const el of card.querySelectorAll('*')) {
    if (!(el.textContent || '').trim() || el.children.length > 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    const s = parseFloat(cs.fontSize)
    if (s > 0 && s < minFont) minFont = s
  }
  return {
    cols: cols.length,
    cardW: Math.round(r.width),
    cardH: Math.round(r.height),
    titleFont: fsOf(title),
    metaFont: fsOf(meta),
    minFont: minFont === Infinity ? null : minFont,
    coverH: coverRect ? Math.round(coverRect.height) : null,
    containerW: grid.clientWidth,
    viewportW: window.innerWidth,
  }
}

async function gotoSeries(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card-root"]').length > 0,
    { timeout: 20000 },
  )
}

async function gotoVideos(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-cat-video"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="media-card"]').length > 0,
    { timeout: 20000 },
  )
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ── S0/S1：源码锚 ──────────────────────────────────────────────────
  const panelSrc = fs.readFileSync(PANEL, 'utf8')
  const seriesSrc = fs.readFileSync(SERIES_CARD, 'utf8')
  const mediaSrc = fs.readFileSync(MEDIA_CARD, 'utf8')
  const minmax = Array.from(panelSrc.matchAll(/minmax\((\d+)px,1fr\)/g)).map((m) => Number(m[1]))
  check(
    `S0 两个网格的 minmax 都是 200px（实测源码里 ${JSON.stringify(minmax)}）`,
    minmax.length === 2 && minmax.every((v) => v === 200),
    `minmax=${JSON.stringify(minmax)}`,
  )
  check(
    'S1 两张卡标题都是 text-sm（14px），不再用 text-[12px] 当标题',
    /truncate text-sm font-medium text-fg-strong/.test(seriesSrc) &&
      /truncate text-sm font-medium text-fg-strong/.test(mediaSrc) &&
      !/truncate text-\[12px\] font-medium text-fg-strong/.test(seriesSrc) &&
      !/truncate text-\[12px\] font-medium text-fg-strong/.test(mediaSrc),
  )

  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)

  // ── S2 剧集墙 ─────────────────────────────────────────────────────
  await gotoSeries(page)
  const s = await page.evaluate(MEASURE, '[data-testid="series-card-root"]', null)
  await page.screenshot(path.join(OUT, '01-series-wall.png'))
  if (EXPECT_LEGACY) {
    check(
      `[反向证伪] 旧尺寸：剧集卡宽应 ≤ 170px（实测 ${s.cardW}px）`,
      s.cardW <= 170,
      '这行红说明 S2 的「卡宽 ≥220」不是恒绿',
    )
  } else {
    check(
      `S2 剧集卡：${s.cols} 列、卡 ${s.cardW}×${s.cardH}px（内容区 ${s.containerW}px，应 ≥220 宽、≤5 列）`,
      s.cardW >= 220 && s.cols <= 5,
      JSON.stringify(s),
    )
    check(
      `S2b 剧集卡字号：标题 ${s.titleFont}px（应 ≥14）、副标题 ${s.metaFont}px（应 ≥12）`,
      s.titleFont >= 14 && s.metaFont >= 12,
    )
    check(
      `S4 剧集卡内最小可读字号 ${s.minFont}px（应 ≥11）`,
      s.minFont >= 11,
      `minFont=${s.minFont}`,
    )
    check(
      `S6 封面未被压扁：封面高 ${s.coverH}px / 卡高 ${s.cardH}px（应 >0 且 ≤75%）`,
      s.coverH !== null && s.coverH > 0 && s.coverH <= s.cardH * 0.75,
    )
  }

  // ── S3 视频网格 ───────────────────────────────────────────────────
  await gotoVideos(page)
  const v = await page.evaluate(MEASURE, '[data-testid="media-card"]', '[data-testid="media-grid"]')
  await page.screenshot(path.join(OUT, '02-video-grid.png'))
  if (EXPECT_LEGACY) {
    check(
      `[反向证伪] 旧尺寸：视频卡宽应 ≤ 170px（实测 ${v.cardW}px）`,
      v.cardW <= 170,
      '这行红说明 S3 的「卡宽 ≥220」不是恒绿',
    )
  } else {
    check(
      `S3 视频卡：${v.cols} 列、卡 ${v.cardW}×${v.cardH}px（应 ≥220 宽、≤5 列）`,
      v.cardW >= 220 && v.cols <= 5,
      JSON.stringify(v),
    )
    check(
      `S3b 视频卡字号：标题 ${v.titleFont}px（应 ≥14）、副标题 ${v.metaFont}px（应 ≥12）`,
      v.titleFont >= 14 && v.metaFont >= 12,
    )
    check(`S4b 视频卡内最小可读字号 ${v.minFont}px（应 ≥11）`, v.minFont >= 11, `minFont=${v.minFont}`)
  }

  /*
   * S7 操作条不得压住文字（改前实测每张卡压住标签行 106×21px：操作条 112px 宽
   * 绝对定位在右下角，标签行 208px ⇒ 被「删除/编辑」盖掉半行，这也是「看不清」）。
   * 判据：删除按钮与标签行、与标题行的矩形**零交集**。
   */
  const overlap = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="media-card"]')
    if (!card) return null
    const del = card.querySelector('[data-testid="item-delete"]')
    const tags = card.querySelector('[data-testid="item-tags"]')
    const title = Array.from(card.querySelectorAll('p')).find((p) =>
      p.className.includes('truncate'),
    )
    if (!del || !title) return null
    const inter = (a, b) => {
      if (!b) return 0
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const ox = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left))
      const oy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top))
      return Math.round(ox * oy)
    }
    return { withTags: inter(del, tags), withTitle: inter(del, title) }
  })
  check(
    `S7 操作条不压文字（与标签行交集 ${overlap && overlap.withTags}px²、与标题行 ${overlap && overlap.withTitle}px²，均应为 0）`,
    !!overlap && overlap.withTags === 0 && overlap.withTitle === 0,
    JSON.stringify(overlap),
  )

  // ── S5 最矮受支持窗口 ─────────────────────────────────────────────
  await page.setViewport({ width: 900, height: 600 })
  await new Promise((r) => setTimeout(r, 700))
  const vMin = await page.evaluate(MEASURE, '[data-testid="media-card"]', '[data-testid="media-grid"]')
  await page.screenshot(path.join(OUT, '03-video-grid-900x600.png'))
  if (!EXPECT_LEGACY) {
    check(
      `S5 最矮窗口 900×600：视口 ${vMin.viewportW}px、${vMin.cols} 列、卡 ${vMin.cardW}px（应 =900 宽、≥200 宽、≥2 列）`,
      // 视口必须真的变成 900：否则这条判据会在 1440 下「通过」—— 那正是 2026-10-20
      // 踩过的假绿（setViewport 被注释吞掉，5 列/230px 在 1440 下也满足阈值）。
      vMin.viewportW === 900 && vMin.cardW >= 200 && vMin.cols >= 2,
      JSON.stringify(vMin),
    )
  }
  await gotoSeries(page)
  const sMin = await page.evaluate(MEASURE, '[data-testid="series-card-root"]', null)
  await page.screenshot(path.join(OUT, '04-series-wall-900x600.png'))
  if (!EXPECT_LEGACY) {
    check(
      `S5b 最矮窗口下剧集卡 ${sMin.cols} 列、卡 ${sMin.cardW}px（视口 ${sMin.viewportW}px）`,
      sMin.viewportW === 900 && sMin.cardW >= 200,
      JSON.stringify(sMin),
    )
  }

  const pageErrors = page.pageErrors()
  check(`运行期无未捕获页面异常（${pageErrors.length}）`, pageErrors.length === 0, pageErrors.join(' | '))

  fs.writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify({ series: s, videos: v, videosMin: vMin, seriesMin: sMin, minmax }, null, 2),
    'utf8',
  )
  await browser.close()
  console.log(
    `\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-328 媒体卡尺寸/可读性：${pass} pass / ${fail} fail — evidence: ${OUT}`,
  )
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
