'use strict'
/** 定位「缓存」按钮被 <p> 盖住的具体元素与层序关系（BUG-359 根因取证）。 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())
    // 有界等待：默认频道由监控列表异步派生，固定 sleep 会把未加载态读成「没有按钮」
    let waited = 0
    while (waited < 40000) {
      const n = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('button')).filter(
            (b) => (b.textContent || '').trim() === '缓存',
          ).length,
      )
      if (n > 0) break
      await sleep(500)
      waited += 500
    }
    console.log(`缓存按钮到位：${waited}ms`)
    const out = await page.evaluate(() => {
      const res = []
      const btns = Array.from(document.querySelectorAll('button')).filter(
        (b) => (b.textContent || '').trim() === '缓存',
      )
      for (const b of btns) {
        const r = b.getBoundingClientRect()
        const cx = Math.round(r.x + r.width / 2)
        const cy = Math.round(r.y + r.height / 2)
        const hit = document.elementFromPoint(cx, cy)
        const chain = (el) => {
          const out = []
          let n = el
          while (n && n !== document.body) {
            const rr = n.getBoundingClientRect()
            out.push({
              tag: n.tagName.toLowerCase(),
              testid: n.getAttribute('data-testid') || null,
              cls: (n.getAttribute('class') || '').slice(0, 110),
              txt: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
              rect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
              pos: getComputedStyle(n).position,
              z: getComputedStyle(n).zIndex,
            })
            n = n.parentElement
          }
          return out
        }
        res.push({
          button: { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, cls: b.className.slice(0, 120) },
          hitIsButton: hit === b,
          hitChain: hit ? chain(hit) : null,
          buttonChain: chain(b),
        })
      }
      return res
    })
    console.log(JSON.stringify(out, null, 1))
  } finally {
    await browser.close().catch(() => {})
  }
}
main().catch((e) => {
  console.error('CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
