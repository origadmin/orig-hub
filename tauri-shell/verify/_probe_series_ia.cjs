'use strict'
/**
 * BUG-404 / 409 / 410 / 413 / 414 取证：把「剧集详情」这一屏的真实 DOM 与几何抓下来。
 *
 * 抓什么（都带被测前提）：
 *  - 顶栏标题与副标题（BUG-409：进详情后是否仍只写「文件管理」）；
 *  - 左栏剧集级动作条每个按钮的文案与 x/y（BUG-410 作用域、BUG-414 删除语义）；
 *  - 右栏单集动作条每个按钮的文案与 x/y（BUG-414 另一侧）；
 *  - 分集行 [▶][时长] 的几何（BUG-413 排版）；
 *  - 视口宽 1440。
 */
const path = require('path')
const cdp = require('./lib/cdp.cjs')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(__dirname, 'evidence')

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load', timeout: 90000 })
  await delay(2500)

  // 进「剧集」墙
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (b) b.click()
  })
  // 等剧集墙真的渲染出来（BUG-427 教训：固定 sleep 不能当「等它发生」）
  for (let i = 0; i < 60; i++) {
    const n = await page.evaluate(
      () => document.querySelectorAll('[data-testid="series-card"]').length,
    )
    if (n > 0) break
    await delay(500)
  }

  // 打开第一部剧集（`series-card` 本身就是那个 <button>）
  const opened = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="series-card"]')
    if (!card) return null
    const name = (card.textContent || '').trim().slice(0, 30)
    card.click()
    return name
  })
  console.log('opened series:', JSON.stringify(opened))
  await delay(2000)

  // 等剧集详情
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(
      () => document.querySelectorAll('[data-testid="episode-pick"]').length,
    )
    if (n > 0) break
    await delay(500)
  }

  const top = await page.evaluate(() => {
    const g = (s) => {
      const el = document.querySelector(`[data-testid="${s}"]`)
      return el ? el.textContent.trim() : null
    }
    return {
      pageTitle: g('page-title'),
      contextSub: g('context-bar-sub'),
      seriesTitle: g('series-title'),
      heroTitle: g('series-hero') ? 'present' : 'absent',
    }
  })
  console.log('topbar:', JSON.stringify(top))

  const btns = await page.evaluate(() => {
    const pick = (root, sel) =>
      Array.from(document.querySelectorAll(sel)).map((b) => {
        const r = b.getBoundingClientRect()
        return {
          tid: b.getAttribute('data-testid'),
          text: (b.textContent || '').trim().slice(0, 22),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          disabled: b.hasAttribute('disabled'),
          variantCls: (b.className || '').includes('bg-accent') ? 'accent' : 'plain',
        }
      })
    return {
      seriesLevel: pick(null, '[data-testid^="series-"]').filter((b) => b.tid !== 'series-cover'),
      episodeLevel: pick(null, '[data-testid^="episode-"]'),
    }
  })
  console.log('series-level actions:', JSON.stringify(btns.seriesLevel, null, 0))
  console.log('episode-level actions:', JSON.stringify(btns.episodeLevel.slice(0, 20), null, 0))

  // 分集行 [▶][时长] 几何
  const rows = await page.evaluate(() => {
    const out = []
    document.querySelectorAll('[data-testid="episode-pick"]').forEach((row, i) => {
      if (i > 5) return
      const play = row.querySelector('[data-testid="episode-row-play"]')
      const dur = row.querySelector('[data-testid="episode-duration"]')
      const rr = row.getBoundingClientRect()
      const pr = play ? play.getBoundingClientRect() : null
      const dr = dur ? dur.getBoundingClientRect() : null
      out.push({
        row: Math.round(rr.x) + '/' + Math.round(rr.width),
        playX: pr ? Math.round(pr.x) : null,
        durX: dr ? Math.round(dr.x) : null,
        durW: dr ? +dr.width.toFixed(1) : null,
        durText: dur ? dur.textContent.trim() : null,
      })
    })
    return out
  })
  console.log('rows:', JSON.stringify(rows))

  await page.screenshot(path.join(OUT, 'bug404-414-series-detail.png'))
  await browser.close()
}
main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
