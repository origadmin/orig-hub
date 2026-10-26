#!/usr/bin/env node
'use strict'
/**
 * 取证探针：TG 相册里的视频点开之后，播放器到底在拉哪个地址。
 *
 * 用户 2026-10-26 第 1 条：「TG中点击视频的严重问题，后台视频在加载，界面依然是展示界面。
 * 也就是说，没有播放行为，但是做了播放动作。」
 *
 * 可疑点：`MediaViewer` 对**所有**视频条目都写
 *   compatSrc = mediaItemStreamUrl(cur.messageId)
 * 而 TG 条目的 `messageId` 是 **Telegram 消息号**，不是媒体库条目号 ⇒ 会拼出
 * `/api/media/items/<tgMsgId>/stream`。这个地址属于库域，与 TG 消息毫无关系。
 *
 * 本探针只取证、不改代码：列出点击后 `<video>` 的实际 src、错误码、以及
 * performance 里 /stream /raw /api/tg/file /api/tg/local 各自的请求。
 *
 * 用法（先起 dev 栈）：
 *   node tauri-shell/verify/_probe_tg_album_play.cjs [CHANNEL_ID]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const TG_PORT = Number(process.env.TG_PORT || 19787)
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-tg-album'),
)
const NAV_TIMEOUT = 90000
const CHANNEL_ID = process.argv[2] || '-1004457697592'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(page, sel, tries = 60, step = 500) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate((q) => !!document.querySelector(q), sel)) return true
    await delay(step)
  }
  return false
}

function readNet() {
  const strip = (u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
  const list = performance.getEntriesByType('resource').map((e) => ({
    p: strip(e.name),
    t: e.initiatorType,
  }))
  const bucket = (re) => {
    const m = new Map()
    for (const e of list) {
      if (!re.test(e.p)) continue
      m.set(e.p, (m.get(e.p) || 0) + 1)
    }
    return [...m.entries()].map(([p, n]) => ({ p, n }))
  }
  return {
    stream: bucket(/\/stream$/),
    raw: bucket(/\/raw$/),
    tgfile: bucket(/\/api\/tg\/file\//),
    tglocal: bucket(/\/api\/tg\/local\//),
  }
}

function readVideo() {
  const v = document.querySelector('video')
  if (!v) return null
  return {
    src: (v.currentSrc || v.src || '').replace(/^https?:\/\/[^/]+/, ''),
    paused: v.paused,
    currentTime: Math.round(v.currentTime * 100) / 100,
    readyState: v.readyState,
    networkState: v.networkState,
    duration: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
    error: v.error ? `${v.error.code}:${v.error.message || ''}` : null,
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: NAV_TIMEOUT })
    await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())
    await waitFor(page, '[data-testid="tg-monitor-row"]')
    await delay(600)
    const order = await (async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${TG_PORT}/api/tg/monitor/channels`)
        const l = await r.json()
        return (Array.isArray(l) ? l : l.channels || []).map((c) => String(c.channelId))
      } catch {
        return []
      }
    })()
    const idx = Math.max(0, order.indexOf(String(CHANNEL_ID)))
    await page.evaluate((i) => {
      const rows = [...document.querySelectorAll('[data-testid="tg-monitor-row"]')]
      ;(rows[i] || rows[0])?.click()
    }, idx)
    await waitFor(page, '[data-testid="album-cover"]')
    await delay(800)

    // 找第一个**含视频**的相册：用缩略图旁的时长角标不可靠，直接按接口判断
    const picked = await page.evaluate(() => {
      const covers = [...document.querySelectorAll('[data-testid="album-cover"]')]
      if (!covers.length) return null
      covers[0].click()
      return { covers: covers.length, count: Number(covers[0].getAttribute('data-count') || 0) }
    })
    await delay(1500)
    const tiles = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="tg-album-tile-"]')].map((t) => ({
        id: t.getAttribute('data-testid'),
        msg: t.getAttribute('data-message-id'),
        dur: (t.innerText || '').replace(/\s+/g, ' ').trim(),
      })),
    )
    console.log('[album] ' + JSON.stringify({ ...picked, tiles }))

    const before = await page.evaluate(readNet)
    await page.evaluate(() => document.querySelector('[data-testid="tg-album-tile-0"]')?.click())
    await delay(3000)
    const v1 = await page.evaluate(readVideo)
    await delay(9000)
    const v2 = await page.evaluate(readVideo)
    const net = await page.evaluate(readNet)
    await page.screenshot(path.join(OUT, 'tg-album-play.png'))

    console.log('[video +3s ] ' + JSON.stringify(v1))
    console.log('[video +12s] ' + JSON.stringify(v2))
    console.log('[net before] ' + JSON.stringify(before))
    console.log('[net after ] ' + JSON.stringify(net, null, 1))

    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ at: new Date().toISOString(), picked, tiles, v1, v2, before, net }, null, 2),
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
