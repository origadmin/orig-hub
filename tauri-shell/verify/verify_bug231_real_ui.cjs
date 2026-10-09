'use strict'
/**
 * BUG-231 真实 UI 验收：驱动真实点击链，证明播放器标题 = 内容标题（caption），
 * 绝不是频道名（如「西瓜短剧(AI短剧)」「每日沙雕墙」）。
 * 两个修复点各用一条独立会话的真实路径覆盖：
 *   A. openPlayable（频道消息流 photo 预览 tg-photo-preview / 相册 tile）
 *   B. onGlobalHitPreview（全局搜索命中展开后的 tg-hit-play）
 * 断言：viewer 打开，标题非频道名且非空。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(__dirname, 'evidence', 'BUG-231')
fs.mkdirSync(OUT, { recursive: true })

async function judge(label, page, shot) {
  await delay(2200)
  const st = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="viewer-title"]')
    return { viewerOpen: !!t, viewerTitle: t ? t.textContent.trim().slice(0, 80) : '(no el)' }
  })
  await page.screenshot(path.join(OUT, shot))
  const problems = []
  if (!st.viewerOpen) problems.push('viewer 未打开')
  else {
    if (/^(西瓜短剧|每日沙雕墙)/.test(st.viewerTitle)) problems.push(`标题是频道名: ${st.viewerTitle}`)
    if (!st.viewerTitle || st.viewerTitle === '(no el)') problems.push('标题为空')
  }
  console.log(`[${label}]`, JSON.stringify(st), problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS')
  return problems.length === 0
}

async function withPage(browser, fn) {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5180/', { settleMs: 2500 })
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="nav-tg"]'); if (!b) return false; b.click(); return true }))
    throw new Error('nav-tg not found')
  await delay(2500)
  if (!await page.evaluate(() => !!document.querySelector('[data-testid="tg-panel-root"]')))
    throw new Error('tg-panel-root not found')
  try { return await fn(page) } finally { /* browser closed by caller */ }
}

async function main() {
  const browser = await cdp.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  const results = {}

  // ---- 路径 A：频道消息流 photo/相册 → openPlayable（监控频道 feed 默认直接可见） ----
  results.openPlayable = await withPage(browser, async (page) => {
    let target = null
    for (let i = 0; i < 10 && !target; i++) {
      await delay(1500)
      target = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="tg-photo-preview"]')
        if (t) return 'photo'
        const tile = document.querySelector('[data-testid^="tg-album-tile-"]')
        if (tile) return 'album'
        return null
      })
    }
    if (!target) throw new Error('feed 内无 tg-photo-preview / 相册 tile')
    await page.evaluate((t) => {
      const el = t === 'photo'
        ? document.querySelector('[data-testid="tg-photo-preview"]')
        : document.querySelector('[data-testid^="tg-album-tile-"]')
      el.click()
    }, target)
    return judge('A 频道消息流(openPlayable)', page, '4_viewer_channelfeed.png')
  })

  // ---- 路径 B：全局搜索命中 → onGlobalHitPreview ----
  results.globalHitPreview = await withPage(browser, async (page) => {
    if (!await page.evaluate(() => !!document.querySelector('[data-testid="tg-global-search-input"]')))
      throw new Error('tg-global-search-input not found')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tg-global-search-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, '石家庄')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    let hits = 0
    for (let i = 0; i < 12 && !hits; i++) {
      await delay(2000)
      hits = await page.evaluate(() => document.querySelectorAll('[data-testid="tg-hit-row"]').length)
    }
    console.log('search hits:', hits)
    if (!hits) throw new Error('全局搜索「石家庄」无命中')
    await page.screenshot(path.join(OUT, '1_search_hits.png'))
    await page.evaluate(() => document.querySelector('[data-testid="tg-hit-row"]').click())
    await delay(1500)
    const hasPlay = await page.evaluate(() => !!document.querySelector('[data-testid="tg-hit-play"]'))
    if (!hasPlay) throw new Error('tg-hit-play not found（命中不可播或未展开）')
    await page.evaluate(() => document.querySelector('[data-testid="tg-hit-play"]').click())
    return judge('B 全局搜索命中(onGlobalHitPreview)', page, '2_viewer_searchhit.png')
  })

  await browser.close()
  if (Object.values(results).some((v) => v === false)) process.exit(1)
  console.log('ALL PASS:', JSON.stringify(results))
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
