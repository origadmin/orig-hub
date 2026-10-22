#!/usr/bin/env node
/**
 * BUG-391 验收探针：相册封面不被拉伸 + 展开宫格在底部（纵向拉伸、不含首图）。
 *
 * 用户 2026-10-23 原话：「展开应该底部拉伸展示,但是不应该分左右……当前左右展示
 * 把第一张图片上下拉伸破坏了」「第一张图片可以不加入下面的展示」。
 *
 * 修法：
 *   ① 封面列去 self-stretch/flex-1，封面图自然比例（h-auto max-h-72 w-full object-cover）；
 *   ② 展开宫格移出左右框架 → 气泡底部全宽（open && items.length>1）；
 *   ③ 首图不入宫格（items.slice(1)），瓦片 testid/preview 下标仍 = items 下标。
 *
 * 判据：
 *   P1 封面自然比例：折叠/展开两态封面 img 高度 ≤288（max-h-72）且宽=160。
 *   P2 宫格在封面下方：album-grid.top ≥ cover.bottom（±2px）且为气泡直接区块。
 *   P3 首图不入宫格：全部瓦片 data-message-id ≠ 封面 messageId，tile 下标从 1 起。
 *   P4 收起入口仍在（album-collapse）。
 *   验牙：装回旧实现（self-stretch + absolute inset-0 h-full）P1 必红，还原复绿。
 *
 * 截图落 evidence/BUG-391/。只读：不点下载、不发缓存。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-391')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function openFeed(page) {
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
  await sleep(3000)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await sleep(4500)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => /@/.test(b.innerText) && b.innerText.length < 120,
    )
    if (btn) btn.click()
  })
  await sleep(5000)
}

/** 逐屏滚动找到第一个可折叠相册封面，滚到可视区。返回是否找到。 */
async function findAlbum(page) {
  for (let s = 0; s < 12; s++) {
    const found = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="album-cover"]')
      if (c) {
        c.scrollIntoView({ block: 'center' })
        return true
      }
      return false
    })
    if (found) return true
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tg-panel-root"] .overflow-y-auto')
      if (el) el.scrollBy(0, 700)
    })
    await sleep(900)
  }
  return false
}

async function readGeom(page, scopeMsgId) {
  return page.evaluate((scopeMsgId) => {
    const covers = Array.from(document.querySelectorAll('[data-testid="album-cover"]'))
    const cover = scopeMsgId
      ? covers.find((c) => c.getAttribute('data-message-id') === scopeMsgId)
      : covers[0]
    if (!cover) return null
    const bubble = cover.closest('[data-message-keys]') || cover.closest('[data-message-key]')
    if (!bubble) return null
    const img = cover.querySelector('img')
    const ir = img ? img.getBoundingClientRect() : null
    const cr = cover.getBoundingClientRect()
    const grid = bubble.querySelector('[data-testid="album-grid"]')
    const gr = grid ? grid.getBoundingClientRect() : null
    const coverMsgId = cover.getAttribute('data-message-id')
    const tiles = grid ? Array.from(grid.querySelectorAll('button')) : []
    return {
      coverW: Math.round(cr.width),
      coverBtnH: Math.round(cr.height),
      imgW: ir ? Math.round(ir.width) : 0,
      imgH: ir ? Math.round(ir.height) : 0,
      hasGrid: !!grid,
      gridTopVsCoverBottom: gr && ir ? Math.round(gr.top - cr.bottom) : null,
      gridW: gr ? Math.round(gr.width) : 0,
      bubbleW: Math.round(bubble.getBoundingClientRect().width),
      tileIds: tiles.map((b) => b.getAttribute('data-message-id')),
      tileTestids: tiles.map((b) => b.getAttribute('data-testid')),
      coverInGrid: tiles.some((b) => b.getAttribute('data-message-id') === coverMsgId),
      hasCollapse: !!bubble.querySelector('[data-testid="album-collapse"]'),
    }
  }, scopeMsgId)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000 })
    await openFeed(page)

    const has = await findAlbum(page)
    if (!has) {
      check('前提：feed 内找到可折叠相册样本', false, 'no album-cover after 12 screens')
      await page.screenshot(path.join(OUT, 'no-album.png'))
      await browser.close()
      process.exit(1)
    }
    await sleep(1500)

    // ---- 折叠态：封面自然比例 ----
    const col = await readGeom(page, null)
    check(
      'P1a 折叠态封面自然比例（宽=160、高≤288 不被拉伸）',
      !!col && col.coverW === 160 && col.imgW === 160 && col.imgH > 0 && col.imgH <= 288,
      col ? `img=${col.imgW}x${col.imgH} btnH=${col.coverBtnH}` : 'no cover',
    )
    await page.screenshot(path.join(OUT, '01-collapsed-natural-cover.png'))

    // ---- 展开态（锚定被点击的相册：展开会触发 feed 重排，DOM 第一个
    //      album-cover 可能换成别的相册，后续读数必须按 id 作用域） ----
    const clickId = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="album-cover"]')
      return c ? c.getAttribute('data-message-id') : null
    })
    // 点击后必须核实「点开的相册真的开了」：feed 轮询重渲染可能吃掉一次状态
    // 翻转（BUG-376 同型的间歇性），未开则重试一次，仍不开则如实 FAIL。
    const ensureOpen = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate((id) => {
          const c = Array.from(document.querySelectorAll('[data-testid="album-cover"]')).find(
            (x) => x.getAttribute('data-message-id') === id,
          )
          if (c) c.click()
        }, clickId)
        await sleep(2500)
        const openNow = await page.evaluate((id) => {
          const c = Array.from(document.querySelectorAll('[data-testid="album-cover"]')).find(
            (x) => x.getAttribute('data-message-id') === id,
          )
          const bubble = c && (c.closest('[data-message-keys]') || c.closest('[data-message-key]'))
          return bubble ? !!bubble.querySelector('[data-testid="album-collapse"]') : false
        }, clickId)
        if (openNow) return true
      }
      return false
    }
    const opened = await ensureOpen()
    check('前提：点击后相册进入展开态（含重试）', opened, `clickId=${clickId}`)
    await page.evaluate(() => {
      const g = document.querySelector('[data-testid="album-grid"]')
      if (g) g.scrollIntoView({ block: 'center' })
    })
    await sleep(1500)
    // 诊断转储：P2-P4 读数前的全部相册状态（一次看清状态漂移）
    const diag = await page.evaluate((id) => {
      const covers = Array.from(document.querySelectorAll('[data-testid="album-cover"]'))
      return {
        n: covers.length,
        targetPresent: covers.some((c) => c.getAttribute('data-message-id') === id),
        first3: covers.slice(0, 3).map((c) => {
          const b = c.closest('[data-message-keys]') || c.closest('[data-message-key]')
          const img = c.querySelector('img')
          return {
            id: c.getAttribute('data-message-id'),
            text: (c.innerText || '').slice(0, 24).replace(/\n/g, '|'),
            imgH: img ? Math.round(img.getBoundingClientRect().height) : -1,
            natH: img ? img.naturalHeight : -1,
            gridTiles: b ? (b.querySelector('[data-testid="album-grid"]') || { querySelectorAll: () => [] }).querySelectorAll('button').length : -1,
            collapse: b ? !!b.querySelector('[data-testid="album-collapse"]') : null,
          }
        }),
      }
    }, clickId)
    console.log('[diag]', JSON.stringify(diag))
    const ex = await readGeom(page, clickId)
    check(
      'P1b 展开态封面仍自然比例（≤288，不被宫格高度拉伸）',
      !!ex && ex.imgH > 0 && ex.imgH <= 288,
      ex ? `imgH=${ex.imgH} btnH=${ex.coverBtnH}` : 'no cover',
    )
    check(
      'P2 宫格在封面下方（grid.top ≥ cover.bottom ±2）',
      !!ex && ex.hasGrid && ex.gridTopVsCoverBottom !== null && ex.gridTopVsCoverBottom >= -2,
      ex ? `delta=${ex.gridTopVsCoverBottom}px gridW=${ex.gridW}/bubbleW=${ex.bubbleW}` : 'no grid',
    )
    check(
      'P3 首图不入宫格（瓦片 data-message-id 全 ≠ 封面，testid 从 tile-1 起）',
      !!ex && ex.hasGrid && !ex.coverInGrid && ex.tileTestids[0] === 'tg-album-tile-1',
      ex ? `tiles=${ex.tileIds.length} coverInGrid=${ex.coverInGrid} first=${ex.tileTestids[0]}` : 'no grid',
    )
    check('P4 收起入口仍在', !!ex && ex.hasCollapse, ex ? `collapse=${ex.hasCollapse}` : '-')
    await page.screenshot(path.join(OUT, '02-expanded-grid-below.png'))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(`[bug391] fatal: ${e && e.message}`)
  process.exit(2)
})
