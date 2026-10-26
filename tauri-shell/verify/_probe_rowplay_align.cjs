#!/usr/bin/env node
'use strict'
/**
 * BUG-427 取证：左栏分集行「▶ 播放入口」的横向位置是否稳定。
 *
 * 用户报障（2026-10-26，第六次）：「播放按钮位置拍板错乱！」
 * 附 87x268 窄条截图（左栏行尾 `▶ 时长`）。像素扫描显示：
 *   首行（选中）三角 x=17..27，其余 6 行 x=23..33 —— 整列左移 6px。
 * 假设：行尾是 `[▶][时长]` 且列宽 auto + 右对齐 ⇒ ▶ 的 x 由右侧文本宽度决定。
 *
 * 本脚本只取证不判定，输出：
 *   A. 每一行：行矩形、▶ 矩形、时长文本与矩形、TG 入口矩形、行尾列左边界；
 *   B. ▶ 的 x 集合（去重）与极差 —— 极差 > 0.5px 即「错乱」；
 *   C. 右侧还有哪些元素会影响 ▶ 的 x（时长 / 未缓存标记 / TG 入口）；
 *   D. 右栏是否还存在播放语义的可点击元素（BUG-369 回归位）。
 *
 * 用法：node tauri-shell/verify/_probe_rowplay_align.cjs [SERIES_INDEX]
 * 产物写 ORIG_VERIFY_OUT 或 %TEMP%，绝不写进仓库。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-rowplay-align')
const SERIES_INDEX = Number(process.argv[2] || process.env.SERIES_INDEX || 0)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openSeriesDetail(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
      break
    } catch (e) {
      console.log(`[rowplay] goto#${i + 1} failed: ${e.message}`)
      if (i === 2) throw e
      await delay(2000)
    }
  }
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-child-lib-series not found')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
    { timeout: 25000 },
  )
  await delay(1200)
  await page.evaluate((i) => {
    const cards = [...document.querySelectorAll('[data-testid="series-card"]')]
    cards[Math.min(i, cards.length - 1)].click()
  }, SERIES_INDEX)
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(
      () => !!document.querySelector('[data-testid="episode-focus-title"]'),
    )
    if (ready) break
    await delay(500)
  }
  await delay(900)
}

function readRows() {
  const picker = document.querySelector('[data-testid="episode-picker"]')
  if (!picker) return { error: 'episode-picker not found' }
  const rows = [...picker.querySelectorAll('[data-testid="episode-pick"]')]
  const pickerR = picker.getBoundingClientRect()
  return {
    picker: {
      x: pickerR.x,
      w: pickerR.width,
      scrollW: picker.scrollWidth,
      clientW: picker.clientWidth,
      overflowX: getComputedStyle(picker).overflowX,
    },
    rows: rows.map((row, i) => {
      const r = row.getBoundingClientRect()
      const play = row.querySelector('[data-testid="episode-row-play"]')
      const pr = play ? play.getBoundingClientRect() : null
      // 行尾列 = 行内第 3 个直接子 span（flex 容器）
      const kids = [...row.children]
      const tail = kids[kids.length - 1]
      const tailR = tail ? tail.getBoundingClientRect() : null
      const tailKids = tail
        ? [...tail.children].map((el) => {
            const b = el.getBoundingClientRect()
            return {
              testid: el.getAttribute('data-testid') || '',
              text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
              x: Math.round(b.x * 100) / 100,
              w: Math.round(b.width * 100) / 100,
              h: Math.round(b.height * 100) / 100,
            }
          })
        : []
      return {
        i,
        episodeId: row.getAttribute('data-episode-id'),
        selected: row.className.includes('bg-accent/10'),
        row: { x: Math.round(r.x * 100) / 100, w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 },
        play: pr
          ? {
              x: Math.round(pr.x * 100) / 100,
              w: Math.round(pr.width * 100) / 100,
              h: Math.round(pr.height * 100) / 100,
              kind: play.getAttribute('data-kind'),
              title: play.getAttribute('title'),
            }
          : null,
        tail: tailR ? { x: Math.round(tailR.x * 100) / 100, w: Math.round(tailR.width * 100) / 100 } : null,
        tailKids,
        slotLabel: (kids[0]?.textContent || '').trim(),
      }
    }),
  }
}

function readRightPane() {
  const title = document.querySelector('[data-testid="episode-focus-title"]')
  if (!title) return { error: 'episode-focus-title not found' }
  const section = title.closest('section')
  if (!section) return { error: 'section not found' }
  const clickables = [...section.querySelectorAll('button, [role="button"], a')].map((el) => {
    const b = el.getBoundingClientRect()
    return {
      testid: el.getAttribute('data-testid') || '',
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      title: el.getAttribute('title') || '',
      aria: el.getAttribute('aria-label') || '',
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.width),
      h: Math.round(b.height),
    }
  })
  const playish = clickables.filter((c) =>
    /播放|play/i.test(`${c.text} ${c.title} ${c.aria} ${c.testid}`),
  )
  return {
    paneW: Math.round(section.getBoundingClientRect().width),
    clickables,
    playish,
  }
}

;(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const report = { outDir: OUT_DIR, seriesIndex: SERIES_INDEX }
  try {
    await openSeriesDetail(page)
    report.rows = await page.evaluate(readRows)
    report.right = await page.evaluate(readRightPane)
    await page.screenshot(path.join(OUT_DIR, 'A-page.png'))
  } catch (e) {
    await browser.close().catch(() => {})
    throw e
  }
  await browser.close().catch(() => {})

  // ---- 汇总 ----
  const rows = report.rows.rows || []
  const xs = [...new Set(rows.filter((r) => r.play).map((r) => r.play.x))].sort((a, b) => a - b)
  const span = xs.length ? Math.round((xs[xs.length - 1] - xs[0]) * 100) / 100 : 0
  console.log('=== A. 每行几何 ===')
  for (const r of rows) {
    const tailDesc = r.tailKids.map((k) => `${k.testid || '·'}"${k.text}"@x${k.x}w${k.w}`).join(' | ')
    console.log(
      `row#${r.i} id=${r.episodeId} sel=${r.selected} rowX=${r.row.x} rowW=${r.row.w} ` +
        `playX=${r.play ? r.play.x : 'none'} tailX=${r.tail ? r.tail.x : '-'} :: ${tailDesc}`,
    )
  }
  console.log('\n=== B. ▶ 的 x 去重与极差 ===')
  console.log(`distinct playX = ${JSON.stringify(xs)}`)
  console.log(`span = ${span}px  ${span > 0.5 ? '<< 错乱：图标列不齐' : 'OK: 对齐'}`)
  console.log('\n=== C. 右栏播放语义元素 ===')
  console.log(`paneW=${report.right.paneW} playish=${JSON.stringify(report.right.playish)}`)
  console.log('\n=== D. 左栏滚动 ===')
  console.log(JSON.stringify(report.rows.picker))

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\nreport: ${path.join(OUT_DIR, 'report.json')}`)
})().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
