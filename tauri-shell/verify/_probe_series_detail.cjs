#!/usr/bin/env node
'use strict'

/** 探针（临时，提交前删）：复现 bug261 A 组「卡片点得动、详情不渲染」——页面内 fetch 补丁盯 detail 请求耗时/失败。 */

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')
const sandbox = require('./lib/sandbox.cjs')
const fs = require('node:fs')
const path = require('node:path')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const ep = await endpoints.resolve()
  const APP = ep.app.endsWith('/') ? ep.app : `${ep.app}/`
  const MEDIA_API = ep.tg
  console.log(`[probe] app=${APP} media-api=${MEDIA_API}`)

  // 建一个有字节的临时剧集
  const s = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/series`, { title: `ProbeDetail_${Date.now()}` })
  const sid = s.json.id
  const dir = path.resolve(__dirname, 'evidence', 'BUG-261', 'testmedia')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'probe-detail.mp4')
  fs.writeFileSync(file, Buffer.alloc(64, 1))
  const it = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/items`, { items: [{ path: file, title: 'PD-1', kind: 'video' }] })
  if (!it.json || !it.json.ids) throw new Error(`item create failed: ${it.status} ${JSON.stringify(it.json)}`)
  await sandbox.detachAutoSeries(MEDIA_API, it.json.ids[0])
  await sandbox.httpJson('POST', `${MEDIA_API}/api/media/series/${sid}/episodes`, { itemId: it.json.ids[0], episodeNo: 1 })
  console.log(`[probe] fixture series=${sid} item=${it.json.ids[0]}`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitUntil: 'load', settleMs: 2500 })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-lib-series"]'), { timeout: 30000 })

    // 页面内 fetch 补丁：记录 /api/media/series/<id> 详情请求的发起/返回/失败与耗时
    await page.evaluate(() => {
      window.__probeSeries = []
      const orig = window.fetch.bind(window)
      window.fetch = (...args) => {
        const url = String(args[0] instanceof Request ? args[0].url : args[0] || '')
        const m = String((args[1] && args[1].method) || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase()
        const isDetail = /\/api\/media\/series\/\d+$/.test(url)
        const rec = { url, method: m, t0: Date.now() }
        if (isDetail) window.__probeSeries.push(rec)
        return orig(...args).then(
          r => {
            if (isDetail) { rec.status = r.status; rec.ms = Date.now() - rec.t0 }
            return r
          },
          e => {
            if (isDetail) { rec.error = String(e && e.message || e); rec.ms = Date.now() - rec.t0 }
            throw e
          },
        )
      }
    })

    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card"]').length > 0, { timeout: 30000 })
    await sleep(800)
    const t0 = Date.now()
    const clicked = await page.evaluate(sid2 => {
      const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid2}"]`)
      if (!card) return 'missing'
      card.scrollIntoView({ block: 'center' })
      card.click()
      return 'clicked'
    }, sid)
    console.log(`[probe] card click -> ${clicked} (t+${Date.now() - t0}ms)`)
    const up = await page
      .waitForFunction(() => !!document.querySelector('[data-testid="episode-focus-title"]'), { timeout: 60000, intervalMs: 300 })
      .then(() => true)
      .catch(() => false)
    console.log(`[probe] detail up=${up} after ${Date.now() - t0}ms`)
    const snap = await page.evaluate(() => ({
      focus: !!document.querySelector('[data-testid="episode-focus-title"]'),
      wallCards: document.querySelectorAll('[data-testid="series-card"]').length,
      seriesReq: window.__probeSeries,
      bodyText: (document.body.innerText || '').slice(0, 160),
    }))
    console.log('[probe] snap:', JSON.stringify(snap))
    console.log('[probe] consoleErrors:', JSON.stringify(page.consoleErrors().slice(0, 5)))
    console.log('[probe] pageErrors:', JSON.stringify(page.pageErrors().slice(0, 5)))
  } finally {
    await browser.close()
    await sandbox.httpJson('DELETE', `${MEDIA_API}/api/media/series/${sid}`)
    console.log('[probe] cleaned')
  }
}

main().catch(e => {
  console.error('[probe] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
