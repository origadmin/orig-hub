'use strict'
/**
 * 取证①：「NanaZip_7.0.1843.0_Binaries.zip 在第一行，TG弹窗标题在第二行」。
 *
 * 量媒体库网格前 N 张卡片的标题/来源/几何，把「第一行是谁、第二行是谁」变成数字。
 * 全部有界等待（stats 冷启动可达十几秒，固定 sleep 会把正常首屏读成空态）。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(page, fn, timeoutMs = 60000, step = 400) {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try {
      v = await page.evaluate(fn)
    } catch {
      v = false
    }
    if (v) return { ok: true, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 }
    await sleep(step)
  }
}

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.evaluate(() => document.querySelector('[data-testid="nav-files"]')?.click())
    const wAlive = await waitFor(page, () => !document.body.textContent.includes('媒体服务未运行'))
    console.log(`库探活：ok=${wAlive.ok} ${wAlive.ms}ms`)
    const wGrid = await waitFor(
      page,
      () => (document.querySelector('[data-testid="media-grid"]')?.children.length ?? 0) > 0,
    )
    console.log(`网格卡片：ok=${wGrid.ok} ${wGrid.ms}ms`)

    const cards = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="media-grid"]')
      if (!grid) return { grid: null, cards: [] }
      const out = []
      for (const el of Array.from(grid.children).slice(0, 10)) {
        const r = el.getBoundingClientRect()
        const lines = []
        for (const p of el.querySelectorAll('p, span, h3, h4, div')) {
          const rr = p.getBoundingClientRect()
          if (rr.width === 0 || rr.height === 0) continue
          const own = Array.from(p.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0,
          )
          if (!own) continue
          lines.push({
            txt: (p.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            y: Math.round(rr.y),
            h: Math.round(rr.height),
            fs: getComputedStyle(p).fontSize,
          })
        }
        out.push({
          testid: el.getAttribute('data-testid') || null,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          lines: lines.sort((a, b) => a.y - b.y),
        })
      }
      return { grid: { w: Math.round(grid.getBoundingClientRect().width) }, cards: out }
    })
    console.log('grid:', JSON.stringify(cards.grid))
    cards.cards.forEach((c, i) => {
      console.log(`\n#${i + 1} ${c.testid || '(无 testid)'} rect=${JSON.stringify(c.rect)}`)
      console.log(`  全文: "${c.txt}"`)
      for (const l of c.lines) console.log(`    y=${l.y} h=${l.h} fs=${l.fs} "${l.txt}"`)
    })
  } finally {
    await browser.close().catch(() => {})
  }
}
main().catch((e) => {
  console.error('CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
