'use strict'
/**
 * BUG-361 取证/验收：`cn` 合并后，原本「尺寸类冲突由样式表源序定胜负」的按钮
 * 是否真的按调用方书写顺序渲染。
 *
 * 判据（运行时牙齿，不靠源码锚）：
 *   C1 TG 面板内 `<Button size="sm" className="h-6 …">` 实测高度 = 24px
 *      （修复前实测 32px：`h-8` 靠样式表源序赢了 `h-6`）。
 *   C2 `<Button size="xs" className="h-7 …">` 实测高度 = 28px（xs 给的是 h-7，无冲突）。
 *   C3 同一组按钮高度一致（ chaos 的直接观感）：气泡操作行按钮高度方差为 0。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(page, fn, timeoutMs = 45000, step = 400) {
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
    await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())
    await waitFor(page, () => document.querySelectorAll('[data-testid="tg-filter-row"]').length > 0)
    await waitFor(page, () => document.querySelectorAll('[data-message-key]').length > 0)
    await sleep(600)

    const m = await page.evaluate(() => {
      const rows = []
      for (const el of document.querySelectorAll('button')) {
        const r = el.getBoundingClientRect()
        if (r.width < 6 || r.height < 6) continue
        const cs = getComputedStyle(el)
        rows.push({
          txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14),
          h: Math.round(r.height),
          fs: cs.fontSize,
          cls: (el.getAttribute('class') || '').slice(0, 60),
        })
      }
      // 气泡操作行按钮（size="sm" + className="h-6 px-2 text-[10px]"）
      const action = rows.filter((x) => /^(缓存|播放|缓存中|排队中|重试缓存)$/.test(x.txt))
      const heights = action.map((x) => x.h)
      const uniq = [...new Set(heights)]
      // 全面板字号直方图（<12px 的可见文字节点数）
      let small = 0
      const hist = {}
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden') continue
        const own = Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0,
        )
        if (!own) continue
        const fs = cs.fontSize
        hist[fs] = (hist[fs] || 0) + 1
        if (parseFloat(fs) < 12) small++
      }
      return {
        actionHeights: heights,
        actionUniq: uniq,
        actionFontSizes: [...new Set(action.map((x) => x.fs))],
        smallTextNodes: small,
        fontHist: hist,
      }
    })
    console.log(JSON.stringify(m, null, 1))
  } finally {
    await browser.close().catch(() => {})
  }
}
main().catch((e) => {
  console.error('CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
