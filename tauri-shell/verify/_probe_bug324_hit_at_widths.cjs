'use strict'
/**
 * 多档宽度下「去下载查看」的可命中性（BUG-324 复报排查）。
 *
 * 用户报「按钮有了但功能没实现」时，一个被忽略的可能性是**视口过窄**：
 * 按钮在 DOM 里存在、也能看见，但落在视口外/被裁掉 ⇒ 点不到。
 * 这里在每一档宽度上做 `elementFromPoint` 命中测试（不是只看 rect 非零）。
 *
 * 用法：node tauri-shell/verify/_probe_bug324_hit_at_widths.cjs [baseURL]
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.argv[2] || 'http://127.0.0.1:5180/'
const WIDTHS = [1600, 1440, 1280, 1100, 1024, 900, 820, 760, 700]

async function main() {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)
  await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]').click())
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-cache-manager-entry"]'), { timeout: 20000 })
  await page.evaluate(() => document.querySelector('[data-testid="tg-cache-manager-entry"]').click())
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="cache-manager"] [data-testid="cache-task-row"]').length > 0,
    { timeout: 20000 },
  )

  let bad = 0
  for (const w of WIDTHS) {
    await page.conn.send(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: 800, deviceScaleFactor: 1, mobile: false },
      { sessionId: page.sessionId },
    )
    await new Promise((r) => setTimeout(r, 450))
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cache-task-godownload"]')
      if (!el) return { exists: false }
      const b = el.getBoundingClientRect()
      const cx = b.left + b.width / 2
      const cy = b.top + b.height / 2
      const top = document.elementFromPoint(cx, cy)
      const panel = document.querySelector('[data-testid="cache-manager"]')
      return {
        exists: true,
        w: Math.round(b.width),
        h: Math.round(b.height),
        left: Math.round(b.left),
        right: Math.round(b.right),
        inViewport: b.left >= 0 && b.right <= window.innerWidth,
        hitSelf: Boolean(top && (top === el || el.contains(top))),
        topTag: top ? top.tagName + (top.getAttribute('data-testid') ? `[${top.getAttribute('data-testid')}]` : '') : null,
        panelOverflowX: panel ? panel.scrollWidth - panel.clientWidth : null,
      }
    })
    const ok = r.exists && r.hitSelf && r.inViewport && r.panelOverflowX <= 1
    if (!ok) bad += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} @${w}px  ${JSON.stringify(r)}`)
  }

  await browser.close()
  console.log(`\n${bad === 0 ? 'PASS' : 'FAIL'} - 命中测试：${WIDTHS.length - bad}/${WIDTHS.length}`)
  if (bad > 0) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
