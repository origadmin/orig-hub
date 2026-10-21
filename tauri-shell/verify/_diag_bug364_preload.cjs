'use strict'

/** BUG-364 诊断：冷面板前置为什么等不到（监控行 / 消息流）。只打印事实。 */

const endpoints = require('./_lib_endpoints.cjs')
const cdp = require('./lib/cdp.cjs')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const ep = await endpoints.resolve()
  console.log(`[diag] app=${ep.app} tg=${ep.tg}`)
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    let loaded = false
    for (let i = 1; i <= 3 && !loaded; i += 1) {
      try {
        await page.goto(ep.app + '/', { settleMs: 1500, timeout: 90000 })
        await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-files"]'), {
          timeout: 45000,
        })
        loaded = true
      } catch (e) {
        console.log(`[diag] goto attempt ${i} failed: ${String((e && e.message) || e).slice(0, 140)}`)
        await delay(1500)
      }
    }
    if (!loaded) throw new Error('app 加载失败')

    for (const step of [0, 2000, 5000, 10000, 20000]) {
      if (step > 0) {
        await page.evaluate(() => {
          const nav = document.querySelector('[data-testid="nav-tg"]')
          if (nav) nav.click()
        })
        await delay(step === 2000 ? 2000 : step - 2000)
      } else {
        await page.evaluate(() => {
          const nav = document.querySelector('[data-testid="nav-tg"]')
          if (nav) nav.click()
        })
      }
      const st = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="tg-panel-root"]')
        const aside = panel && panel.querySelector('aside')
        const rows = [...document.querySelectorAll('[data-testid="tg-monitor-row"]')]
        const hdr = document.querySelector('[data-testid="tg-channel-header"]')
        const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ')
        return {
          hasPanel: !!panel,
          hasAside: !!aside,
          asideButtons: aside ? [...aside.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20)) : [],
          monitorRows: rows.map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)),
          headerChannel: hdr ? hdr.getAttribute('data-channel-id') : null,
          messageKeys: document.querySelectorAll('[data-message-key]').length,
          starting: bodyText.includes('正在启动'),
          offline: bodyText.includes('离线'),
          loadingMedia: bodyText.includes('加载媒体中'),
          selectChannel: bodyText.includes('选择频道'),
        }
      })
      console.log(`[diag] t=${step}ms`, JSON.stringify(st))
    }
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error('[diag] FATAL', e)
  process.exit(2)
})
