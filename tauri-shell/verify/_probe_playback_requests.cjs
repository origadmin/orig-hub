#!/usr/bin/env node
'use strict'
/**
 * 取证探针（不是验收脚本）：播放页到底请求了哪些端点。
 *
 * 用户 2026-10-26：「视频播放页面也出问题了。当前 stream 播放一直在读，然后请求 /raw
 * （这个我记得功能不再支持了）。问题原因不明。」
 *
 * 判据取 `performance.getEntriesByType('resource')` —— 不是 DOM 计数：
 * `<video preload>` 与 `<img>` 的请求不进 DOM 也照样发出去，只有资源条目是事实。
 *
 * 输出：/stream 与 /raw 的条目数、各自字节数、以及 /raw 的**发起者线索**
 * （initiatorType + 是否是图片类）。
 *
 * 用法（先起 dev 栈 5180）：
 *   node tauri-shell/verify/_probe_playback_requests.cjs [SERIES_ID] [SECONDS]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-playback-req'),
)
const NAV_TIMEOUT = 90000
const SERIES_ID = Number(process.argv[2] || process.env.SERIES_ID || 219)
const OBSERVE_SEC = Number(process.argv[3] || 12)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读全部资源条目，按 /stream 与 /raw 归类 */
function readResources() {
  const list = performance.getEntriesByType('resource').map((e) => ({
    name: e.name,
    type: e.initiatorType,
    transfer: Math.round(e.transferSize || 0),
    decoded: Math.round(e.decodedBodySize || 0),
    dur: Math.round(e.duration || 0),
  }))
  const pick = (re) => list.filter((e) => re.test(e.name))
  const strip = (u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
  const summarize = (arr) => {
    const byPath = new Map()
    for (const e of arr) {
      const k = strip(e.name)
      const cur = byPath.get(k) || { n: 0, transfer: 0, types: new Set() }
      cur.n += 1
      cur.transfer += e.transfer
      cur.types.add(e.type)
      byPath.set(k, cur)
    }
    return [...byPath.entries()].map(([k, v]) => ({
      path: k,
      n: v.n,
      transfer: v.transfer,
      types: [...v.types],
    }))
  }
  return {
    total: list.length,
    stream: summarize(pick(/\/stream(\?|$)/)),
    raw: summarize(pick(/\/raw(\?|$)/)),
    local: summarize(pick(/\/local\//)),
    tgfile: summarize(pick(/\/api\/tg\/file\//)),
    other: summarize(pick(/\/api\//).filter((e) => !/\/stream|\/raw|\/local\/|\/tg\/file\//.test(e.name))),
  }
}

async function openSeries(page, sid) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: NAV_TIMEOUT })
  await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]')?.click())
  for (let i = 0; i < 50; i++) {
    if (await page.evaluate(() => !!document.querySelector('[data-testid="series-card"]'))) break
    await delay(500)
  }
  await delay(800)
  const clicked = await page.evaluate((id) => {
    const c = document.querySelector(`[data-testid="series-card"][data-series-id="${id}"]`)
    if (!c) return false
    c.click()
    return true
  }, sid)
  if (!clicked) throw new Error(`series ${sid} not in wall`)
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
    await delay(500)
  }
  await delay(900)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await openSeries(page, SERIES_ID)
    const before = await page.evaluate(readResources)
    console.log('[before play] ' + JSON.stringify({ stream: before.stream, raw: before.raw }, null, 0))

    // 点左栏第一条可播行
    const started = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="episode-row-play"]')
      if (!btn) return false
      btn.click()
      return true
    })
    if (!started) throw new Error('episode-row-play not found')
    await delay(2000)

    const state = await page.evaluate(() => {
      const v = document.querySelector('video')
      return v
        ? {
            src: (v.currentSrc || v.src || '').replace(/^https?:\/\/[^/]+/, ''),
            paused: v.paused,
            currentTime: Math.round(v.currentTime * 100) / 100,
            readyState: v.readyState,
            duration: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
            error: v.error ? `${v.error.code}:${v.error.message}` : null,
          }
        : null
    })
    console.log('[video] ' + JSON.stringify(state))

    await delay(OBSERVE_SEC * 1000)
    const after = await page.evaluate(readResources)
    const state2 = await page.evaluate(() => {
      const v = document.querySelector('video')
      return v ? { currentTime: Math.round(v.currentTime * 100) / 100, paused: v.paused } : null
    })
    await page.screenshot(path.join(OUT, 'playback.png'))

    console.log('\n===== /stream =====')
    console.log(JSON.stringify(after.stream, null, 1))
    console.log('===== /raw =====')
    console.log(JSON.stringify(after.raw, null, 1))
    console.log('===== tg file/local =====')
    console.log(JSON.stringify({ tgfile: after.tgfile, local: after.local }, null, 1))
    console.log('\n[after play] ' + JSON.stringify({ video: state2, total: after.total }))

    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ at: new Date().toISOString(), seriesId: SERIES_ID, before, after, state, state2 }, null, 2),
    )
    console.log(`\n[out] ${OUT}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
