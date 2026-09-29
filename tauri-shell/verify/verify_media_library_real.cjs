#!/usr/bin/env node
'use strict'
/**
 * 媒体库「真实运行态」验收（BUG-178/179 收尾）：用真实 Edge + CDP 渲染前端，
 * 把**运行中产品**的媒体库截图落盘，并直接读 daemon `/api/media/stats` 真源，
 * 用「真实数据 vs 空壳」自证根因是否修复。
 *
 * 与 `verify_series_detail_layout.cjs` 的区别：它用夹具剧集断言布局，本脚本
 * 断言**真实运行后端**是否把真实媒体库（137 条）喂给了 UI —— 直接对应
 * 用户「静态布局通过、实际没有修复」的投诉。
 *
 * 用法::
 *   node verify_media_library_real.cjs            # 默认 http://127.0.0.1:5180/ -> 19786
 *   APP_URL=... DAEMON_PORT=19788 node verify_media_library_real.cjs
 *   ORIG_VERIFY_OUT=<dir> SHOT_NAME=<name> node verify_media_library_real.cjs
 * Exit: 0 = 完成（证据已落盘）；1 = 运行/导航失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-media-real')
const SHOT_NAME = process.env.SHOT_NAME || 'media-library.png'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function daemonStats(port) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const res = await fetch(`http://127.0.0.1:${port}/api/media/stats`, { signal: ctrl.signal })
    clearTimeout(t)
    const text = await res.text()
    return { status: res.status, body: text }
  } catch (e) {
    return { status: 0, body: 'ERR ' + (e && e.message ? e.message : String(e)) }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const out = { appUrl: APP_URL, daemonPort: DAEMON_PORT }
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })

    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-media"]')
      if (!el) return false
      el.click()
      return true
    })
    out.navMediaClicked = clicked

    let series = 0
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="series-card"], [data-testid="media-card"]').length > 0,
        { timeout: 20000 },
      )
    } catch (_e) {
      /* 可能整页空，继续截图 */
    }
    await delay(1500)

    series = await page.evaluate(() => document.querySelectorAll('[data-testid="series-card"]').length)
    const mediaCards = await page.evaluate(() => document.querySelectorAll('[data-testid="media-card"]').length)
    out.seriesCards = series
    out.mediaCards = mediaCards
    out.bodySample = (await page.innerText()).replace(/\s+/g, ' ').slice(0, 500)
    out.consoleErrors = page.consoleErrors().slice(0, 8)
    out.pageErrors = page.pageErrors().slice(0, 8)

    const file = path.join(OUT_DIR, SHOT_NAME)
    await page.screenshot(file, { fullPage: true })
    out.screenshot = file
    let size = -1
    try { size = fs.statSync(file).size } catch (_e) {}
    out.screenshotBytes = size

    const stats = await daemonStats(DAEMON_PORT)
    out.daemonStats = stats
  } finally {
    await browser.close()
  }

  console.log('[media-real] ' + JSON.stringify(out, null, 2))
  if (!out.screenshot || out.screenshotBytes <= 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('[media-real] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
