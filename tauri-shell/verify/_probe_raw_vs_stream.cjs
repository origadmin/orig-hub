#!/usr/bin/env node
'use strict'
/**
 * BUG-428 取证 2：`/raw` 与 `/stream` 两个源各自能否解码、duration 是否收敛、ended 是否可达。
 *
 * 背景：`_probe_media_stream_shape.cjs` 实测播放器 `currentSrc` 落在
 * `/api/media/items/1574/stream`，而响应头是
 *   `x-orig-stream: live` + `transfer-encoding: chunked`（无 content-length、无 accept-ranges）
 * 同条目的 `/raw` 却是 `content-length: 277059820` + `accept-ranges: bytes`。
 *
 * 主源本来是 `/raw`（`toViewerItem.src = mediaItemUrl(id)`），`/stream` 只在解码
 * 失败时作兼容流（BUG-208）。所以要分清：
 *   A. `/raw` 真的解不动（⇒ 回退是正确行为，问题在流端点形态）
 *   B. `/raw` 能解，回退是**误触发**（⇒ 前端 bug，连播被无谓地推进 live 流）
 *
 * 做法：在页面里挂两个**游离** video 元素（不插 DOM、不影响应用状态），
 * 各自加载一个源，采样 readyState / error / duration / ended 可达性。
 *
 * 用法：node tauri-shell/verify/_probe_raw_vs_stream.cjs <itemId>
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-raw-vs-stream'),
)
const ITEM_ID = Number(process.argv[2] || process.env.ITEM_ID || 1574)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const report = { itemId: ITEM_ID }
  try {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    const res = await page.evaluate(async (id) => {
      const base = `http://127.0.0.1:19787/api/media/items/${id}`
      const probe = (url) =>
        new Promise((resolve) => {
          const v = document.createElement('video')
          v.muted = true
          v.preload = 'auto'
          const trace = []
          const t0 = Date.now()
          let done = false
          const finish = (why) => {
            if (done) return
            done = true
            resolve({
              url,
              why,
              waitedMs: Date.now() - t0,
              readyState: v.readyState,
              networkState: v.networkState,
              duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),
              videoWidth: v.videoWidth,
              videoHeight: v.videoHeight,
              error: v.error ? { code: v.error.code, message: v.error.message } : null,
              trace,
            })
          }
          const tick = () => {
            trace.push({
              t: Date.now() - t0,
              rs: v.readyState,
              ns: v.networkState,
              d: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),
            })
          }
          const iv = setInterval(tick, 1000)
          v.addEventListener('loadedmetadata', () => tick())
          v.addEventListener('canplay', () => {
            tick()
            finish('canplay')
          })
          v.addEventListener('error', () => {
            tick()
            finish('error')
          })
          // 上限 20s
          setTimeout(() => {
            clearInterval(iv)
            tick()
            finish('timeout')
          }, 20000)
          v.src = url
          v.load()
        })
      const raw = await probe(`${base}/raw`)
      const stream = await probe(`${base}/stream`)
      return { raw, stream }
    }, ITEM_ID)
    report.raw = res.raw
    report.stream = res.stream
  } catch (e) {
    report.error = e.message
  } finally {
    await browser.close().catch(() => {})
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  for (const k of ['raw', 'stream']) {
    const r = report[k]
    if (!r) continue
    console.log(`\n=== ${k.toUpperCase()} (${r.url}) ===`)
    console.log(
      `why=${r.why} waited=${r.waitedMs}ms rs=${r.readyState} ns=${r.networkState} ` +
        `duration=${r.duration} ${r.videoWidth}x${r.videoHeight}`,
    )
    console.log(`error=${JSON.stringify(r.error)}`)
    console.log('trace=' + JSON.stringify(r.trace))
  }
  if (report.error) console.log('\nERROR: ' + report.error)
  console.log('\nreport: ' + path.join(OUT, 'report.json'))
})().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
