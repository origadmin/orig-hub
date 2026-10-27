// BUG-422 探针：series-bulk-tag 点击后弹窗是否打开
// 复刻 qa 脚本到判据 3 之前的状态，然后点打标、 dump DOM/报错
const path = require('path')
const sandbox = require('./lib/sandbox.cjs')
const cdp = require('./lib/cdp.cjs')

const APP_URL = 'http://127.0.0.1:5180/'
const DAEMON = 'http://127.0.0.1:19786'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const base = await sandbox.httpJson('GET', `${DAEMON}/api/config`)
  const TG = `http://127.0.0.1:${sandbox.tgPortOf(base.json) || 19787}`
  const before = await sandbox.httpJson('GET', `${TG}/api/media/series`)
  const items = (before.json && before.json.items) || []
  const wall = items.filter((s) => s.hasBytes !== false)
  const ids = wall.slice(0, 2).map((s) => s.id)
  console.log('[probe] targets =', JSON.stringify(ids))

  const browser = await cdp.launch()
  const page = await browser.newPage()
  const errs = []
  page.conn.on('Runtime.exceptionThrown', (p) => errs.push(JSON.stringify(p.exceptionDetails && p.exceptionDetails.text)))
  page.conn.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') errs.push('console.error: ' + (p.args || []).map((a) => a.value || a.description || '').join(' '))
  })
  try {
    await page.goto(APP_URL, { waitUntil: 'load' })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-lib-series"]'), { timeout: 20000 })
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await page.waitForFunction(() => !!document.querySelector('[data-testid="series-card-root"]'), { timeout: 20000 })
    await delay(3000)

    for (const id of ids) {
      await page.evaluate((sid) => {
        const root = document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`)
        const btn = root && root.querySelector('[data-testid="series-card-select"]')
        if (btn) btn.click()
      }, id)
      await delay(300)
    }
    const barInfo = await page.evaluate(() => ({
      bar: !!document.querySelector('[data-testid="series-selection-bar"]'),
      tagBtn: !!document.querySelector('[data-testid="series-bulk-tag"]'),
      tagBtnText: (document.querySelector('[data-testid="series-bulk-tag"]') || {}).textContent,
      tagBtnDisabled: (document.querySelector('[data-testid="series-bulk-tag"]') || {}).disabled,
    }))
    console.log('[probe] before click =', JSON.stringify(barInfo))

    const clicked = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-bulk-tag"]')
      if (!b) return 'no-button'
      const r = b.getBoundingClientRect()
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2
      const hit = document.elementFromPoint(cx, cy)
      b.click()
      return `clicked rect=${JSON.stringify([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])} hit=${hit && hit.tagName}.${hit && hit.getAttribute('data-testid')}`
    })
    console.log('[probe] click result =', clicked)
    await delay(1500)

    const after = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => String(h.textContent || '').trim().slice(0, 40))
      const overlays = [...document.querySelectorAll('.fixed.inset-0')].map((el) => ({
        cls: (el.className || '').toString().slice(0, 60),
        testid: el.getAttribute('data-testid'),
        childTestids: [...el.querySelectorAll('[data-testid]')].map((c) => c.getAttribute('data-testid')).slice(0, 8),
      }))
      return { headings, overlays, bodyLen: document.body.innerHTML.length }
    })
    console.log('[probe] headings =', JSON.stringify(after.headings))
    console.log('[probe] overlays =', JSON.stringify(after.overlays, null, 1))
    console.log('[probe] page/console errors =', JSON.stringify(errs.slice(0, 10), null, 1))
  } finally {
    await browser.close().catch(() => {})
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[probe] FAIL', e); process.exit(1) })
