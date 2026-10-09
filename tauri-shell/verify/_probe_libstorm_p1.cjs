'use strict'
/** Focused re-check of P1 (first entry) DOM render + screenshot. */
const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const ep = await endpoints.resolve()
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto(ep.app, { waitUntil: 'load' })
  await delay(2500)
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-media"]')
    if (b) b.click()
  })
  for (const t of [2000, 4000, 8000, 12000]) {
    await delay(t === 2000 ? 2000 : 2000)
    const st = await page.evaluate(() => ({
      seriesCards: document.querySelectorAll('[data-testid="series-card"]').length,
      mediaCards: document.querySelectorAll('[data-testid="media-card"]').length,
      offline: !!document.querySelector('[data-testid="media-panel-title"]'),
      railAll: (document.querySelector('[data-testid="media-rail-series-all"]') || {}).textContent || null,
    }))
    console.log(`t~${t}ms`, JSON.stringify(st))
  }
  await page.screenshot('tauri-shell/verify/evidence/libstorm_p1.png').catch((e) => console.log('shot fail', e.message))
  await browser.close()
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
