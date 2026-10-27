// BUG-422 探针：剧集墙真实滚动容器与靶子剧集卡的可见性
// 用法：node verify/_probe_wall_scroll.cjs
const path = require('path')
const sandbox = require('./lib/sandbox.cjs')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.DAEMON_URL || 'http://127.0.0.1:19786'

async function main() {
  const base = await sandbox.httpJson('GET', `${DAEMON}/api/config`)
  const tgPort = sandbox.tgPortOf(base) || 19787
  const series = await sandbox.httpJson('GET', `${DAEMON}/api/media/series?page=1&page_size=200`)
  const list = Array.isArray(series) ? series : (series.items || series.list || [])
  console.log('[probe] series total =', list.length)

  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    await page.goto(APP_URL, { waitUntil: 'load' })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-lib-series"]'), { timeout: 20000 })
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await page.waitForFunction(() => !!document.querySelector('[data-testid="series-card-root"]'), { timeout: 20000 })
    await new Promise((r) => setTimeout(r, 3000))

    const info = await page.evaluate(() => {
      const out = { containers: [], cards: 0, viewport: { w: window.innerWidth, h: window.innerHeight } }
      // 列出所有可能滚动的容器
      const all = [...document.querySelectorAll('*')]
      for (const el of all) {
        const cs = getComputedStyle(el)
        const oy = cs.overflowY
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
          const r = el.getBoundingClientRect()
          out.containers.push({
            testid: el.getAttribute('data-testid'),
            cls: (el.className || '').toString().slice(0, 80),
            tag: el.tagName,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          })
        }
      }
      out.cards = document.querySelectorAll('[data-testid="series-card-root"]').length
      out.docScroll = { top: window.scrollY, h: document.documentElement.scrollHeight, c: document.documentElement.clientHeight }
      out.bodyOverflow = getComputedStyle(document.body).overflow
      return out
    })
    console.log('[probe] viewport =', JSON.stringify(info.viewport))
    console.log('[probe] cards rendered =', info.cards)
    console.log('[probe] docScroll =', JSON.stringify(info.docScroll), 'bodyOverflow =', info.bodyOverflow)
    console.log('[probe] scrollable containers:')
    for (const c of info.containers) console.log('   ', JSON.stringify(c))

    // 逐卡记录位置（只记录前 110 张的 series-id 与 y）
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="series-card-root"]')].map((el) => {
        const r = el.getBoundingClientRect()
        return { id: el.getAttribute('data-series-id'), y: Math.round(r.y), bottom: Math.round(r.bottom) }
      }),
    )
    console.log('[probe] first 3 =', JSON.stringify(cards.slice(0, 3)))
    console.log('[probe] last 3 =', JSON.stringify(cards.slice(-3)))
    const off = cards.filter((c) => c.y >= info.viewport.h || c.bottom <= 0)
    console.log('[probe] offscreen cards =', off.length, JSON.stringify(off.slice(0, 5)))

    // 滚动是否能刷出更多卡（靶子 543 是否最终出现）
    const TARGET = process.env.PROBE_TARGET || '543'
    for (let i = 0; i < 12; i++) {
      const r = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="series-wall-scroll"]')
        const before = c.scrollTop
        c.scrollBy(0, Math.max(600, Math.floor(c.clientHeight * 0.9)))
        return { before, after: c.scrollTop, atBottom: c.scrollTop + c.clientHeight >= c.scrollHeight - 2 }
      })
      await new Promise((res) => setTimeout(res, 400))
      const n = await page.evaluate(
        (tid) => ({
          cards: document.querySelectorAll('[data-testid="series-card-root"]').length,
          hasTarget: !!document.querySelector(`[data-testid="series-card-root"][data-series-id="${tid}"]`),
        }),
        TARGET,
      )
      console.log(`[probe] scroll#${i + 1} ${r.before}->${r.after} atBottom=${r.atBottom} cards=${n.cards} hasTarget(${TARGET})=${n.hasTarget}`)
      if (n.hasTarget) break
      if (r.atBottom) { console.log('[probe] 已到底但靶子未出现'); break }
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[probe] FAIL', e); process.exit(1) })
